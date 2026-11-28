import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@/test/query';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route, useLocation, useNavigate } from 'react-router';

const useProjectCache = vi.fn();
const useProjectSprintsCache = vi.fn((): { sprints: unknown[] } => ({ sprints: [] }));
const spaceIntents = vi.hoisted(() => ({
  intents: undefined as unknown[] | undefined,
  loading: false,
  error: null as unknown,
  updatedAt: null as number | null,
  refresh: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/hooks/useProjectsCache', () => ({
  useProjectCache: (...a: unknown[]) => useProjectCache(...a),
  useProjectSprintsCache: () => useProjectSprintsCache(),
  useProjectsCache: () => ({ invalidate: () => {} }),
  useSpaceIntents: () => ({
    intents: spaceIntents.intents,
    loading: spaceIntents.loading,
    error: spaceIntents.error,
    updatedAt: spaceIntents.updatedAt,
    refresh: spaceIntents.refresh,
  }),
}));
const list = vi.fn().mockResolvedValue([]);
const deleteIntent = vi.fn().mockResolvedValue(undefined);
const cancelIntent = vi.fn().mockResolvedValue(undefined);
vi.mock('@/services/intents', () => ({
  intentsService: {
    list: (...a: unknown[]) => list(...a),
    delete: (...a: unknown[]) => deleteIntent(...a),
    cancel: (...a: unknown[]) => cancelIntent(...a),
  },
}));
vi.mock('@/services/projects', () => ({ projectsService: {} }));
vi.mock('@/services/api', () => ({ api: { get: vi.fn() } }));
vi.mock('@/App', () => ({ preloadRoute: vi.fn() }));
const permissions = vi.hoisted(() => ({ readOnly: false }));
vi.mock('@/contexts/SpacePermissionsContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/contexts/SpacePermissionsContext')>();
  return {
    ...actual,
    useSpacePermissions: () => ({ ...actual.useSpacePermissions(), ...permissions }),
  };
});

import Project from './Project';
import { queryClient } from '@/lib/queryClient';
import { qk } from '@/lib/queryKeys';

function NewIntentStub() {
  return <span data-testid="new-intent-page">NewIntentPage</span>;
}

function LocationProbe() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <span data-testid="location">{location.pathname + location.search}</span>
      <button type="button" onClick={() => navigate(-1)}>
        Back
      </button>
    </>
  );
}

const V2_PROJECT = {
  id: 'p1',
  name: 'V2 Project',
  kind: 'v2',
  workflowId: 'aidlc-v2',
  gitRepo: 'owner/repo',
  gitProvider: 'github',
  userRole: 'owner',
  trackers: [],
};

const NOW = Date.now();
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

function intent(
  id: string,
  status: string,
  updatedAt: string,
  extra: Record<string, unknown> = {},
) {
  return {
    id,
    title: `Intent ${id}`,
    status,
    createdAt: updatedAt,
    updatedAt,
    completedAt: null,
    currentStage: null,
    pendingHumanTaskId: null,
    ...extra,
  };
}

const renderProject = (initialEntry = '/space/p1') =>
  render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/space/:projectId" element={<Project />} />
        <Route path="/space/:projectId/intent/new" element={<NewIntentStub />} />
        <Route
          path="/space/:projectId/intent/:intentId"
          element={<span data-testid="intent-page">IntentPage</span>}
        />
        <Route
          path="/space/:projectId/intent/:intentId/observability"
          element={<span data-testid="overview-page">OverviewPage</span>}
        />
      </Routes>
      <LocationProbe />
    </MemoryRouter>,
  );

function setIntents(intents: unknown[] | undefined, extra: Partial<typeof spaceIntents> = {}) {
  spaceIntents.intents = intents;
  spaceIntents.loading = extra.loading ?? false;
  spaceIntents.error = extra.error ?? null;
  spaceIntents.updatedAt = extra.updatedAt ?? null;
}

beforeEach(() => {
  permissions.readOnly = false;
  useProjectCache.mockReset();
  list.mockReset().mockResolvedValue([]);
  deleteIntent.mockReset().mockResolvedValue(undefined);
  cancelIntent.mockReset().mockResolvedValue(undefined);
  spaceIntents.refresh.mockReset().mockResolvedValue(undefined);
  setIntents([]);
  localStorage.clear();
  queryClient.clear();
});

describe('Project page — v2 routing', () => {
  it('opens a historical iteration without advertising stale running state as live', () => {
    useProjectCache.mockReturnValue({ project: { ...V2_PROJECT, kind: 'v1' }, loading: false });
    useProjectSprintsCache.mockReturnValueOnce({
      sprints: [
        {
          id: 'historical',
          name: 'Historical iteration',
          phase: 'REVIEW',
          currentAgentStatus: 'running',
        },
      ],
    });
    renderProject();
    const history = screen.getByRole('link', {
      name: /Historical iteration.*Last status:\s?Running/,
    });
    expect(history).toHaveAttribute('href', '/space/p1/sprint/historical/review');
    expect(screen.queryByText('Live')).not.toBeInTheDocument();
  });

  it('renders the intents view (not the sprint UI) for a v2 project from the shared list', () => {
    useProjectCache.mockReturnValue({ project: V2_PROJECT, loading: false });
    renderProject();
    expect(screen.getByRole('heading', { level: 1, name: 'V2 Project' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New intent' })).toBeInTheDocument();
    expect(screen.getByText('No intents yet')).toBeInTheDocument();
    expect(screen.queryByText('New Sprint')).not.toBeInTheDocument();
    expect(list).not.toHaveBeenCalled();
  });

  it('distinguishes a failed space load from a missing space and retries', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    useProjectCache.mockReturnValue({
      project: null,
      loading: false,
      error: 'Network unavailable',
      refresh,
    });
    renderProject();

    expect(await screen.findByRole('heading', { name: "Couldn't load this space" })).toBeVisible();
    expect(screen.queryByText('Space not found')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refresh).toHaveBeenCalledOnce();
    expect(screen.getByRole('link', { name: 'Back to spaces' })).toHaveAttribute(
      'href',
      '/dashboard',
    );
  });

  it('does not describe a failed intents request as an empty space and retries it', async () => {
    useProjectCache.mockReturnValue({ project: V2_PROJECT, loading: false });
    setIntents(undefined, { error: new Error('Temporary network failure') });
    renderProject();

    expect(screen.getByText("Couldn't load intents")).toBeVisible();
    expect(screen.queryByText('No intents yet')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(spaceIntents.refresh).toHaveBeenCalledOnce();
  });

  it('keeps the last list visible with an inline retry when a refresh fails', () => {
    useProjectCache.mockReturnValue({ project: V2_PROJECT, loading: false });
    setIntents([intent('one', 'RUNNING', hoursAgo(1))], { error: new Error('Offline') });
    renderProject();
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't refresh intents");
    expect(screen.getByRole('link', { name: 'Intent one' })).toBeInTheDocument();
  });

  it('shows a loading state, never an empty list, while the shared list is unknown', () => {
    useProjectCache.mockReturnValue({ project: V2_PROJECT, loading: false });
    setIntents(undefined, { loading: true });
    renderProject();
    expect(screen.getByRole('status', { name: 'Loading intents' })).toBeInTheDocument();
    expect(screen.queryByText('No intents yet')).not.toBeInTheDocument();
  });

  it('navigates to /space/:projectId/intent/new when New intent is clicked', async () => {
    useProjectCache.mockReturnValue({ project: V2_PROJECT, loading: false });
    renderProject();
    await userEvent.click(screen.getByRole('button', { name: 'New intent' }));
    expect(await screen.findByTestId('new-intent-page')).toBeInTheDocument();
  });

  it('keeps repository context discreet and offers members read-only settings one click away', () => {
    useProjectCache.mockReturnValue({
      project: {
        ...V2_PROJECT,
        userRole: 'member',
        workflowId: 'team-workflow',
        workflowVersion: 3,
      },
      loading: false,
    });
    renderProject();
    expect(screen.getByRole('link', { name: /GitHub.*owner\/repo/ })).toBeInTheDocument();
    expect(screen.getByTestId('space-workflow')).toHaveTextContent('Workflow · Team Workflow v3');
    expect(screen.getByRole('link', { name: 'View settings' })).toHaveAttribute(
      'href',
      '/space/p1/settings',
    );
    expect(screen.queryByRole('button', { name: 'More actions' })).not.toBeInTheDocument();
  });

  it('keeps Settings in the header, New intent by the intents list, and names the default workflow', () => {
    useProjectCache.mockReturnValue({ project: V2_PROJECT, loading: false });
    setIntents([intent('one', 'RUNNING', hoursAgo(1))]);
    renderProject();
    const settings = screen.getByRole('link', { name: 'Settings' });
    expect(settings).toHaveAttribute('href', '/space/p1/settings');
    expect(screen.getByRole('banner').contains(settings)).toBe(true);
    const newIntent = screen.getByRole('button', { name: 'New intent' });
    expect(screen.getByRole('banner').contains(newIntent)).toBe(false);
    const filters = screen.getByRole('group', { name: 'Show intents' });
    expect(
      filters.compareDocumentPosition(newIntent) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByTestId('space-workflow')).toHaveTextContent('Workflow · AI-DLC v2');
  });

  it('lists finished intents in the same list, with New intent still by the list', () => {
    useProjectCache.mockReturnValue({ project: V2_PROJECT, loading: false });
    setIntents([intent('done', 'SUCCEEDED', hoursAgo(24 * 3), { title: 'Done one' })]);
    renderProject();
    expect(screen.getAllByRole('button', { name: 'New intent' })).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'Done one' })).toBeInTheDocument();
    expect(screen.queryByText(/Nothing is running/)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Settings' })).toBeInTheDocument();
  });

  it('makes every pending decision a distinct row link that opens Work', async () => {
    useProjectCache.mockReturnValue({ project: V2_PROJECT, loading: false });
    setIntents([
      intent('one', 'WAITING', hoursAgo(2), {
        title: 'Add authentication',
        pendingHumanTaskId: 'task-1',
      }),
      intent('two', 'WAITING', hoursAgo(3), {
        title: 'Review migration',
        pendingHumanTaskId: 'task-2',
      }),
    ]);
    renderProject();
    // No detail cached: the status without an age (the wait's age is the
    // oldest open gate, which the list does not know — R3-5).
    const pending = screen.getAllByText(/^Waiting for input$/);
    expect(pending).toHaveLength(2);
    const links = screen.getAllByRole('link', { name: /Add authentication|Review migration/ });
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      '/space/p1/intent/one',
      '/space/p1/intent/two',
    ]);
    await userEvent.click(links[1]);
    expect(await screen.findByTestId('intent-page')).toBeInTheDocument();
  });

  it('does not ask a member to respond to a WAITING intent without a pending human task', () => {
    useProjectCache.mockReturnValue({ project: V2_PROJECT, loading: false });
    setIntents([
      intent('waiting-automatic', 'WAITING', hoursAgo(1), {
        title: 'Automatic wait',
        pendingHumanTaskId: null,
      }),
    ]);
    renderProject();
    expect(screen.getByRole('link', { name: 'Automatic wait' })).toHaveAttribute(
      'href',
      '/space/p1/intent/waiting-automatic/observability',
    );
    expect(
      screen.queryByRole('radio', { name: /Needs your attention [1-9]/ }),
    ).not.toBeInTheDocument();
  });

  it('prioritizes a run that needs resuming over other waiting intents', () => {
    useProjectCache.mockReturnValue({ project: V2_PROJECT, loading: false });
    setIntents([
      intent('waiting-1', 'WAITING', hoursAgo(1), { title: 'Waiting intent' }),
      intent('resume-1', 'WAITING', hoursAgo(5), {
        title: 'Resume intent',
        resumeRequired: { humanTaskId: 'task-1', callbackId: 'cb-1', answeredAt: null },
      }),
    ]);
    renderProject();
    const links = screen.getAllByRole('link', { name: /Resume intent|Waiting intent/ });
    expect(links[0]).toHaveTextContent('Resume intent');
    expect(links[0]).toHaveAttribute('href', '/space/p1/intent/resume-1');
    expect(screen.getByText('Needs resume')).toBeInTheDocument();
    expect(screen.getByText(/waiting 5 h/)).toBeInTheDocument();
  });

  it('offers a clear next step for a saved draft', () => {
    useProjectCache.mockReturnValue({ project: V2_PROJECT, loading: false });
    setIntents([intent('draft-1', 'DRAFT', hoursAgo(1), { title: 'Draft authentication' })]);
    renderProject();
    expect(screen.getByRole('link', { name: 'Draft authentication' })).toHaveAttribute(
      'href',
      '/space/p1/intent/draft-1/observability',
    );
    expect(screen.getByText('Draft')).toBeInTheDocument();
  });
});

describe('Project page — ordering, filters and scale (S1)', () => {
  function makeIntents(count: number, status = 'SUCCEEDED') {
    return Array.from({ length: count }, (_, i) =>
      intent(`i-${i}`, status, new Date(2026, 0, count - i).toISOString()),
    );
  }

  it('orders failed → needs input → active (running included) → drafts → finished in one list', () => {
    useProjectCache.mockReturnValue({ project: V2_PROJECT, loading: false });
    setIntents([
      intent('cancelled', 'CANCELLED', hoursAgo(1)),
      intent('running', 'RUNNING', hoursAgo(2)),
      intent('done', 'SUCCEEDED', hoursAgo(3)),
      intent('draft', 'DRAFT', hoursAgo(4)),
      intent('failed', 'FAILED', hoursAgo(5)),
      intent('question', 'WAITING', hoursAgo(6), { pendingHumanTaskId: 'gate' }),
    ]);
    renderProject();
    const rows = within(screen.getByRole('list', { name: 'Intents' })).getAllByRole('link');
    expect(rows.map((a) => a.textContent)).toEqual([
      'Intent failed',
      'Intent question',
      'Intent running',
      'Intent draft',
      'Intent cancelled',
      'Intent done',
    ]);
    expect(screen.queryByRole('button', { name: /finished/ })).not.toBeInTheDocument();
  });

  it('does not show a "loaded" count badge next to the Intents heading', () => {
    useProjectCache.mockReturnValue({ project: V2_PROJECT, loading: false });
    setIntents(Array.from({ length: 15 }, (_, i) => intent(`n${i}`, 'RUNNING', hoursAgo(i + 1))));
    renderProject();
    expect(within(screen.getByRole('list', { name: 'Intents' })).getAllByRole('link')).toHaveLength(
      15,
    );
    expect(screen.queryByText(/^\d+ loaded$/)).not.toBeInTheDocument();
  });

  it('reads the filter from the URL (Spaces deep link) and writes it back on change', async () => {
    useProjectCache.mockReturnValue({ project: V2_PROJECT, loading: false });
    setIntents([
      intent('running', 'RUNNING', hoursAgo(0.1)),
      intent('failed', 'FAILED', hoursAgo(5)),
      intent('question', 'WAITING', hoursAgo(6), { pendingHumanTaskId: 'gate' }),
    ]);
    renderProject('/space/p1?filter=failed');
    // The running row is fresh (not stalled), so only the question and the failure need attention.
    expect(
      within(screen.getByRole('list', { name: 'Intents' }))
        .getAllByRole('link')
        .map((a) => a.textContent),
    ).toEqual(['Intent failed']);
    expect(screen.getByRole('radio', { name: 'Failed 1' })).toHaveAttribute('aria-checked', 'true');
    await userEvent.click(screen.getByRole('radio', { name: 'Needs your attention 2' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/space/p1?filter=needs-attention');
    await userEvent.click(screen.getByRole('radio', { name: 'All' }));
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/space\/p1$/);
  });

  it('returns to the previous filter on Back', async () => {
    useProjectCache.mockReturnValue({ project: V2_PROJECT, loading: false });
    setIntents([
      intent('running', 'RUNNING', hoursAgo(0.1)),
      intent('question', 'WAITING', hoursAgo(6), { pendingHumanTaskId: 'gate' }),
    ]);
    renderProject('/space/p1?filter=active');
    await userEvent.click(screen.getByRole('radio', { name: /Needs your attention/ }));
    expect(screen.getByTestId('location')).toHaveTextContent('/space/p1?filter=needs-attention');
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/space/p1?filter=active');
  });

  it('keeps the page and the search in the address, so Back from an intent returns to them', async () => {
    useProjectCache.mockReturnValue({ project: V2_PROJECT, loading: false });
    setIntents(makeIntents(26));
    renderProject();
    await userEvent.type(screen.getByRole('searchbox', { name: 'Filter intents' }), 'Intent i-');
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/space/p1?q=Intent+i-&page=2');
    const pager = screen.getByRole('navigation', { name: 'Intent pages' });
    expect(pager).toHaveTextContent('21–26 of 26');

    await userEvent.click(screen.getByRole('link', { name: 'Intent i-25' }));
    expect(screen.queryByRole('list', { name: 'Intents' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/space/p1?q=Intent+i-&page=2');
    expect(screen.getByRole('searchbox', { name: 'Filter intents' })).toHaveValue('Intent i-');
    expect(screen.getByRole('navigation', { name: 'Intent pages' })).toHaveTextContent(
      '21–26 of 26',
    );

    // A filter chip starts again at the first page.
    await userEvent.click(screen.getByRole('radio', { name: 'Finished' }));
    expect(screen.getByTestId('location')).toHaveTextContent(
      '/space/p1?q=Intent+i-&filter=finished',
    );
    expect(screen.getByRole('navigation', { name: 'Intent pages' })).toHaveTextContent(
      '1–20 of 26',
    );
  });

  it('does not request the WAITING supplement below the API cap', () => {
    useProjectCache.mockReturnValue({ project: V2_PROJECT, loading: false });
    setIntents(makeIntents(50));
    renderProject();
    expect(list).not.toHaveBeenCalled();
    expect(screen.queryByTestId('intent-api-cap-notice')).not.toBeInTheDocument();
  });

  it('finds a pending decision even when the capped default list omits the waiting intent', async () => {
    useProjectCache.mockReturnValue({ project: V2_PROJECT, loading: false });
    list.mockResolvedValue([
      intent('older', 'WAITING', hoursAgo(24 * 100), {
        title: 'Older decision',
        pendingHumanTaskId: 'gate',
      }),
    ]);
    setIntents(makeIntents(100));
    renderProject();
    expect(await screen.findByRole('link', { name: 'Older decision' })).toBeVisible();
    expect(list).toHaveBeenCalledWith('p1', 'WAITING', expect.anything());
    expect(screen.getByTestId('intent-api-cap-notice')).toHaveTextContent(
      'Showing the first 100 intents returned by the space',
    );
  });
  it('re-reads the WAITING supplement whenever the capped main list refreshes, and on Retry', async () => {
    useProjectCache.mockReturnValue({ project: V2_PROJECT, loading: false });
    const waitingIntent = (title: string) =>
      intent('older', 'WAITING', hoursAgo(24 * 100), { title, pendingHumanTaskId: 'gate' });
    list.mockResolvedValue([waitingIntent('Older decision')]);
    setIntents(makeIntents(100), { updatedAt: Date.now() });
    const view = renderProject();
    expect(await screen.findByRole('link', { name: 'Older decision' })).toBeVisible();
    const before = list.mock.calls.length;

    // The portfolio poll re-reads the main list: the supplement follows.
    list.mockResolvedValue([waitingIntent('Renamed decision')]);
    setIntents(makeIntents(100), { updatedAt: Date.now() + 60_000 });
    view.rerender(
      <MemoryRouter initialEntries={['/space/p1']}>
        <Routes>
          <Route path="/space/:projectId" element={<Project />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByRole('link', { name: 'Renamed decision' })).toBeVisible();
    expect(list.mock.calls.length).toBeGreaterThan(before);

    // Retry after a failed main refresh re-reads the supplement as well.
    const afterPoll = list.mock.calls.length;
    setIntents(makeIntents(100), {
      updatedAt: Date.now() + 60_000,
      error: new Error('Network down'),
    });
    view.rerender(
      <MemoryRouter initialEntries={['/space/p1']}>
        <Routes>
          <Route path="/space/:projectId" element={<Project />} />
        </Routes>
      </MemoryRouter>,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    expect(spaceIntents.refresh).toHaveBeenCalled();
    await waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(afterPoll));
  });
});

describe('Project page — Intent row actions', () => {
  it('uses a native intent link, one status pill, and a separate delete action that refreshes the shared list', async () => {
    useProjectCache.mockReturnValue({ project: V2_PROJECT, loading: false });
    setIntents([
      intent('intent-row', 'SUCCEEDED', hoursAgo(1), { title: 'Keyboard accessible intent' }),
    ]);
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    renderProject();

    const intentLink = screen.getByRole('link', { name: 'Keyboard accessible intent' });
    expect(intentLink).toHaveAttribute('href', '/space/p1/intent/intent-row/observability');
    expect(intentLink.className).toContain('focus-visible:after:ring-2');
    const row = intentLink.closest('li')!;
    expect(row.querySelectorAll('[data-tone]')).toHaveLength(1);
    // One date grammar with the Spaces inbox ("Completed 1 h ago", R3-6).
    expect(within(row).getByTestId('intent-row-meta')).toHaveTextContent(/^Completed 1 h ago$/);
    expect(row.querySelectorAll('time')).toHaveLength(1);
    expect(row.querySelector('time')).toHaveAttribute('dateTime', hoursAgo(1));

    await userEvent.click(
      screen.getByRole('button', { name: 'Actions for intent Keyboard accessible intent' }),
    );
    await userEvent.click(screen.getByRole('menuitem', { name: 'Delete intent' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByRole('heading', { name: 'Delete intent' })).toBeInTheDocument();
    expect(dialog).toHaveTextContent('“Keyboard accessible intent”');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete intent' }));
    await waitFor(() => expect(deleteIntent).toHaveBeenCalledWith('p1', 'intent-row'));
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.projectIntents('p1') }),
    );
    invalidate.mockRestore();
  });

  it('gives members the same row menu without the destructive delete', async () => {
    useProjectCache.mockReturnValue({
      project: { ...V2_PROJECT, userRole: 'member' },
      loading: false,
    });
    setIntents([intent('one', 'WAITING', hoursAgo(1), { pendingHumanTaskId: 'g1' })]);
    renderProject();
    await userEvent.click(screen.getByRole('button', { name: 'Actions for intent Intent one' }));
    expect(screen.getByRole('menuitem', { name: 'View overview' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Cancel run' })).toBeEnabled();
    expect(screen.queryByRole('menuitem', { name: 'Delete intent' })).not.toBeInTheDocument();
  });

  it('gives a Viewer no Cancel run or Close failed run, while a member keeps them', async () => {
    useProjectCache.mockReturnValue({
      project: { ...V2_PROJECT, userRole: 'viewer' },
      loading: false,
    });
    permissions.readOnly = true;
    setIntents([
      intent('f1', 'FAILED', hoursAgo(5), { title: 'Broken build', currentStage: 'build' }),
      intent('r1', 'RUNNING', hoursAgo(0.1), { title: 'Live run' }),
    ]);
    const { unmount } = renderProject();
    expect(screen.getByRole('button', { name: 'New intent' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Actions for intent Broken build' }));
    expect(screen.getByRole('menuitem', { name: 'View overview' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /Close failed run/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /Delete intent/ })).not.toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    await userEvent.click(screen.getByRole('button', { name: 'Actions for intent Live run' }));
    expect(screen.queryByRole('menuitem', { name: /Cancel run/ })).not.toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    unmount();

    useProjectCache.mockReturnValue({
      project: { ...V2_PROJECT, userRole: 'member' },
      loading: false,
    });
    permissions.readOnly = false;
    renderProject();
    await userEvent.click(screen.getByRole('button', { name: 'Actions for intent Broken build' }));
    expect(screen.getByRole('menuitem', { name: 'Close failed run' })).toBeEnabled();
    await userEvent.keyboard('{Escape}');
    await userEvent.click(screen.getByRole('button', { name: 'Actions for intent Live run' }));
    expect(screen.getByRole('menuitem', { name: /Cancel run/ })).toBeInTheDocument();
  });

  it('renders the menu on every row; Cancel is disabled with the reason where the backend refuses it', async () => {
    useProjectCache.mockReturnValue({ project: V2_PROJECT, loading: false });
    setIntents([
      intent('stalled', 'RUNNING', hoursAgo(24 * 120), {
        title: 'Stalled run',
        currentStage: 'intent-capture',
      }),
      intent('live', 'RUNNING', hoursAgo(0.1), { title: 'Live run' }),
      intent('draft', 'DRAFT', hoursAgo(1), { title: 'Draft one' }),
      intent('done', 'SUCCEEDED', hoursAgo(2), { title: 'Done one' }),
    ]);
    renderProject();
    expect(screen.getAllByRole('button', { name: /Actions for intent/ })).toHaveLength(4);

    await userEvent.click(screen.getByRole('button', { name: 'Actions for intent Stalled run' }));
    const cancel = screen.getByRole('menuitem', { name: /Cancel run/ });
    expect(cancel).toHaveAttribute('aria-disabled', 'true');
    expect(cancel).toHaveTextContent('The engine still reports this run as running.');
    expect(screen.getByRole('menuitem', { name: 'View overview' })).toHaveAttribute(
      'href',
      '/space/p1/intent/stalled/observability',
    );
    // The API refuses a delete while the orchestrator owns the run (409).
    const remove = screen.getByRole('menuitem', { name: /Delete intent/ });
    expect(remove).toHaveAttribute('aria-disabled', 'true');
    expect(remove).toHaveTextContent('The engine still reports this run as running.');
    await userEvent.keyboard('{Escape}');

    await userEvent.click(screen.getByRole('button', { name: 'Actions for intent Done one' }));
    expect(screen.getByRole('menuitem', { name: /Cancel run/ })).toHaveTextContent(
      'This run has already finished.',
    );
    await userEvent.keyboard('{Escape}');

    await userEvent.click(screen.getByRole('button', { name: 'Actions for intent Draft one' }));
    expect(screen.queryByRole('menuitem', { name: 'View overview' })).not.toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Cancel run/ })).toHaveTextContent(
      'Nothing has started yet.',
    );
  });

  it('R3-3: a FAILED row offers "Close failed run" (the intent menu label), never an enabled "Cancel run"', async () => {
    useProjectCache.mockReturnValue({ project: V2_PROJECT, loading: false });
    setIntents([
      intent('f1', 'FAILED', hoursAgo(5), { title: 'Broken build', currentStage: 'build' }),
    ]);
    renderProject();
    await userEvent.click(screen.getByRole('button', { name: 'Actions for intent Broken build' }));
    expect(screen.queryByRole('menuitem', { name: /Cancel run/ })).not.toBeInTheDocument();
    const close = screen.getByRole('menuitem', { name: 'Close failed run' });
    expect(close).toBeEnabled();
    expect(screen.getByRole('menuitem', { name: 'Delete intent' })).toBeEnabled();

    await userEvent.click(close);
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByRole('heading', { name: 'Close this failed run?' })).toBeVisible();
    expect(dialog).toHaveTextContent('The failed run "Broken build" will be closed');
    expect(within(dialog).getByRole('button', { name: 'Close failed run' })).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Keep run' }));
    expect(cancelIntent).not.toHaveBeenCalled();
  });

  it('R3-3: members get the same row menu as the intent page — cancel where the API allows it, never Delete', async () => {
    useProjectCache.mockReturnValue({
      project: { ...V2_PROJECT, userRole: 'member' },
      loading: false,
    });
    setIntents([
      intent('f1', 'FAILED', hoursAgo(5), { title: 'Broken build', currentStage: 'build' }),
      intent('r1', 'RUNNING', hoursAgo(0.1), { title: 'Live run' }),
    ]);
    renderProject();
    await userEvent.click(screen.getByRole('button', { name: 'Actions for intent Broken build' }));
    expect(screen.getByRole('menuitem', { name: 'Close failed run' })).toBeEnabled();
    expect(screen.queryByRole('menuitem', { name: /Delete intent/ })).not.toBeInTheDocument();
    await userEvent.keyboard('{Escape}');

    await userEvent.click(screen.getByRole('button', { name: 'Actions for intent Live run' }));
    expect(screen.getByRole('menuitem', { name: /Cancel run/ })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(screen.queryByRole('menuitem', { name: /Delete intent/ })).not.toBeInTheDocument();
  });

  it('cancels a waiting run only after confirmation and refreshes the shared list', async () => {
    useProjectCache.mockReturnValue({ project: V2_PROJECT, loading: false });
    setIntents([
      intent('q1', 'WAITING', hoursAgo(1), { title: 'Open question', pendingHumanTaskId: 'g1' }),
    ]);
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    renderProject();
    await userEvent.click(screen.getByRole('button', { name: 'Actions for intent Open question' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Cancel run' }));
    expect(cancelIntent).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByRole('heading', { name: 'Cancel this run?' })).toBeInTheDocument();
    expect(dialog).toHaveTextContent(
      '"Open question" will stop and its pending questions will be retired',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Keep run' }));
    expect(cancelIntent).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Actions for intent Open question' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Cancel run' }));
    await userEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel run' }),
    );
    await waitFor(() => expect(cancelIntent).toHaveBeenCalledWith('p1', 'q1'));
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.projectIntents('p1') }),
    );
    invalidate.mockRestore();
  });

  it('shows the activity from the loaded list, keeps the slow usage read behind one explained button, and drops the section when the space is empty', () => {
    useProjectCache.mockReturnValue({ project: V2_PROJECT, loading: false });
    setIntents([intent('one', 'RUNNING', hoursAgo(1))]);
    const { unmount } = renderProject();
    const activity = screen.getByRole('region', { name: 'Activity & cost' });
    expect(within(activity).getByTestId('space-activity-count')).toHaveTextContent('1');
    expect(
      within(activity).getByRole('button', { name: 'Compute tokens and cost' }),
    ).toBeInTheDocument();
    expect(activity).toHaveTextContent('Reads the usage of every run; can take up to a minute.');
    expect(
      within(activity).queryByRole('status', { name: /Loading usage/ }),
    ).not.toBeInTheDocument();
    unmount();
    setIntents([]);
    renderProject();
    expect(screen.queryByRole('region', { name: /Activity/ })).not.toBeInTheDocument();
  });
});
