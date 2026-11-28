import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@/test/query';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';

const fixtures = vi.hoisted(() => ({
  projects: [] as unknown[],
  loading: false,
  error: null as string | null,
  deleteSpace: vi.fn(),
  refresh: vi.fn(),
  preloadRoute: vi.fn(),
  prefetchHref: vi.fn(),
}));
vi.mock('@/lib/routePrefetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/routePrefetch')>()),
  prefetchHref: fixtures.prefetchHref,
  cancelHrefPrefetch: vi.fn(),
}));
vi.mock('@/services/projects', () => ({
  projectsService: {
    delete: fixtures.deleteSpace,
    list: vi.fn().mockResolvedValue([]),
  },
}));
vi.mock('@/hooks/useProjectsCache', () => ({
  useProjectsCache: () => ({
    projects: fixtures.projects,
    loading: fixtures.loading,
    error: fixtures.error,
    refresh: fixtures.refresh,
    invalidate: () => {},
  }),
  projectLastActivityAt: (p: { project: { lastActivityAt?: string | null } }) =>
    p.project.lastActivityAt ?? null,
}));
vi.mock('@/App', () => ({ preloadRoute: fixtures.preloadRoute }));
// A stand-in that keeps its own wizard state, so the test can tell a re-render
// (state kept) from a remount (state lost).
vi.mock('@/components/CreateProjectModal', async () => {
  const React = await import('react');
  return {
    CreateProjectModal: ({ onClose }: { onClose: () => void }) => {
      const [step, setStep] = React.useState(1);
      return (
        <div role="dialog" aria-label="Create space">
          <span data-testid="create-space-step">Step {step}</span>
          <input aria-label="Space name" />
          <button type="button" onClick={() => setStep((s) => s + 1)}>
            Next
          </button>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
        </div>
      );
    },
  };
});

import { useState, type ReactNode } from 'react';
import Spaces from './Spaces';
import { CreateProjectModal } from '@/components/CreateProjectModal';
import { CreateSpaceContext } from '@/components/layout/createSpaceDialog';
import { queryClient } from '@/lib/queryClient';
import { setProjectSort } from '@/hooks/useProjectSort';

const NOW = new Date('2026-11-21T12:00:00Z');
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();

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
    scope: 'feature',
    pendingHumanTaskId: null,
    resumeRequired: false,
    ...extra,
  };
}

function space(
  id: string,
  name: string,
  intents: ReturnType<typeof intent>[],
  project: Record<string, unknown> = {},
) {
  return {
    project: {
      id,
      kind: 'v2',
      name,
      userRole: 'owner',
      createdAt: daysAgo(200),
      lastActivityAt:
        intents.map((i) => i.updatedAt).toSorted((a, b) => b.localeCompare(a))[0] ?? daysAgo(200),
      gitRepo: `example/${id}`,
      gitProvider: 'github',
      ...project,
    },
    latestIntent: intents[0] ?? null,
    intents,
    activity: { inProgress: 0, attention: 0 },
  };
}

function CurrentLocation() {
  const { pathname, search } = useLocation();
  return <span data-testid="current-location">{pathname + search}</span>;
}

// Stands in for AppShell, which owns the Create space dialog above the routes.
function Shell({ children }: { children: ReactNode }) {
  const [creating, setCreating] = useState(false);
  return (
    <CreateSpaceContext.Provider value={() => setCreating(true)}>
      {children}
      {creating && <CreateProjectModal onClose={() => setCreating(false)} onCreated={() => {}} />}
    </CreateSpaceContext.Provider>
  );
}

const spacesTree = (entries: string[]) => (
  <MemoryRouter initialEntries={entries}>
    <Shell>
      <CurrentLocation />
      <Routes>
        <Route path="/spaces" element={<Spaces />} />
        <Route path="/dashboard" element={<Spaces />} />
      </Routes>
    </Shell>
  </MemoryRouter>
);

const renderSpaces = (entries: string[] = ['/dashboard']) => render(spacesTree(entries));
// The table is the remembered alternative to the cards.
const rememberListView = () => localStorage.setItem('aidlc-spaces-view', 'list');

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
  localStorage.clear();
  queryClient.clear();
  setProjectSort('attention');
});

afterEach(() => {
  fixtures.projects = [];
  fixtures.loading = false;
  fixtures.error = null;
  fixtures.refresh.mockReset();
  fixtures.preloadRoute.mockReset();
  fixtures.prefetchHref.mockReset();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Spaces — states', () => {
  it('shows "Spaces" as the page title and an empty state with one primary action', () => {
    renderSpaces();
    expect(screen.getByRole('heading', { level: 1, name: 'Spaces' })).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Search spaces' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'No spaces yet' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Create your first space' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'New space' })).not.toBeInTheDocument();
  });

  it('shows skeleton rows while loading instead of flashing the empty state', () => {
    fixtures.loading = true;
    renderSpaces();
    expect(screen.getByRole('status', { name: 'Loading spaces' })).toBeInTheDocument();
    expect(screen.queryByText('No spaces yet')).not.toBeInTheDocument();
  });

  it('shows an error state with Retry when the portfolio cannot load', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    fixtures.error = 'Network down';
    renderSpaces();
    expect(screen.getByRole('heading', { level: 2, name: "Couldn't load spaces" })).toBeVisible();
    expect(screen.getByText('Network down')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(fixtures.refresh).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('No spaces yet')).not.toBeInTheDocument();
  });

  it('lists spaces only: the inbox lives on My work', () => {
    rememberListView();
    fixtures.projects = [
      space('retail', 'Retail', [
        intent('q1', 'WAITING', daysAgo(108), { pendingHumanTaskId: 'task-1' }),
        intent('f1', 'FAILED', daysAgo(56)),
      ]),
    ];
    renderSpaces();
    expect(screen.getByRole('table', { name: 'Spaces' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: /needs your attention/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Intent q1' })).not.toBeInTheDocument();
  });

  it('leaves a reopenCreateSpace link to the shell, which owns the Create space dialog', () => {
    fixtures.projects = [space('retail', 'Retail', [])];
    renderSpaces(['/dashboard?reopenCreateSpace=1&gitProvider=github']);
    expect(screen.getByRole('heading', { level: 1, name: 'Spaces' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Create space' })).not.toBeInTheDocument();
  });

  it.each(['/dashboard', '/spaces'])('is the same page at %s, never a redirect', (path) => {
    fixtures.projects = [space('retail', 'Retail', [])];
    renderSpaces([`${path}?reopenCreateSpace=1`]);
    expect(screen.getByRole('heading', { level: 1, name: 'Spaces' })).toBeInTheDocument();
    expect(screen.getByTestId('current-location')).toHaveTextContent(`${path}?reopenCreateSpace=1`);
  });
});

describe('Work status', () => {
  const retail = () =>
    space('retail', 'Retail', [
      intent('q1', 'WAITING', daysAgo(108), { pendingHumanTaskId: 'task-1' }),
      intent('f1', 'FAILED', daysAgo(56)),
      intent('r1', 'RUNNING', hoursAgo(0.1)),
      intent('r2', 'RUNNING', hoursAgo(2)),
      intent('w1', 'WAITING', daysAgo(3)),
    ]);
  const platform = () =>
    space('platform', 'Platform', [
      intent('q2', 'WAITING', daysAgo(10), { resumeRequired: true }),
      intent('s1', 'SUCCEEDED', daysAgo(1)),
    ]);
  const quiet = () => space('quiet', 'Quiet', [intent('s2', 'SUCCEEDED', hoursAgo(1))]);

  it('splits each space signal into clickable pills and never counts a stalled run as live', () => {
    rememberListView();
    fixtures.projects = [quiet(), platform(), retail()];
    renderSpaces();
    const table = screen.getByRole('table', { name: 'Spaces' });
    const rows = within(table).getAllByRole('row');
    // Default order: spaces waiting on a human first, then the rest by activity.
    expect(rows.slice(1).map((r) => within(r).getByRole('rowheader').textContent)).toEqual([
      'Retail',
      'Platform',
      'Quiet',
    ]);
    const retailRow = rows[1];
    expect(within(retailRow).getByRole('link', { name: '1 question' })).toHaveAttribute(
      'href',
      '/space/retail?filter=needs-attention',
    );
    expect(within(retailRow).getByRole('link', { name: '1 failed' })).toHaveAttribute(
      'href',
      '/space/retail?filter=failed',
    );
    expect(within(retailRow).getByText('1 running')).toBeVisible();
    // Stalled runs are attention too: the pill opens the same filter as questions.
    expect(within(retailRow).getByRole('link', { name: '1 stalled' })).toHaveAttribute(
      'href',
      '/space/retail?filter=needs-attention',
    );
    expect(within(retailRow).queryByText(/need attention/)).not.toBeInTheDocument();
    expect(within(rows[2]).getByRole('link', { name: '1 question' })).toHaveAttribute(
      'href',
      '/space/platform?filter=needs-attention',
    );
    expect(within(rows[3]).getByLabelText('No open work')).toBeInTheDocument();
  });
});

describe('Create space dialog', () => {
  it.each(['New space', 'Create your first space'])(
    'opens the shell\'s dialog from "%s", which keeps its step and values across a re-render',
    async (button) => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      fixtures.projects = button === 'New space' ? [space('retail', 'Retail', [])] : [];
      const { rerender } = renderSpaces();
      await user.click(screen.getByRole('button', { name: button }));
      const dialog = screen.getByRole('dialog', { name: 'Create space' });
      await user.click(within(dialog).getByRole('button', { name: 'Next' }));
      await user.click(within(dialog).getByRole('button', { name: 'Next' }));
      await user.type(within(dialog).getByRole('textbox', { name: 'Space name' }), 'Payments');

      rerender(spacesTree(['/dashboard']));
      const same = screen.getByRole('dialog', { name: 'Create space' });
      expect(same).toBe(dialog);
      expect(within(same).getByTestId('create-space-step')).toHaveTextContent('Step 3');
      expect(within(same).getByRole('textbox', { name: 'Space name' })).toHaveValue('Payments');

      await user.click(within(same).getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByRole('dialog', { name: 'Create space' })).not.toBeInTheDocument();
    },
  );
});

describe('Spaces cards', () => {
  it("are the default view and fold each space's open intents behind one line, what needs someone first", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    fixtures.projects = [
      space('retail', 'Retail', [
        intent('r1', 'RUNNING', hoursAgo(0.1)),
        intent('q1', 'WAITING', daysAgo(108), { pendingHumanTaskId: 'task-1' }),
        intent('s1', 'SUCCEEDED', daysAgo(1)),
        intent('r2', 'RUNNING', hoursAgo(0.2)),
        intent('r3', 'RUNNING', hoursAgo(0.3)),
        intent('r4', 'RUNNING', hoursAgo(0.4)),
        intent('r5', 'RUNNING', hoursAgo(0.5)),
        intent('r6', 'RUNNING', hoursAgo(1)),
      ]),
      space('quiet', 'Quiet', [intent('s2', 'SUCCEEDED', hoursAgo(1))]),
    ];
    renderSpaces();
    expect(screen.queryByRole('table', { name: 'Spaces' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Retail' })).toHaveAttribute('href', '/space/retail');
    // Owners keep Delete on the card, whatever the screen size.
    await user.click(screen.getByRole('button', { name: 'Actions for space Retail' }));
    expect(screen.getByRole('menuitem', { name: 'Delete space' })).toBeInTheDocument();
    await user.keyboard('{Escape}');

    // Folded by default: no intent rows until asked; a quiet space has no line.
    const toggle = screen.getByRole('button', { name: '7 active intents' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('link', { name: /Intent q1/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /active intent/ })).toBe(toggle);

    await user.click(toggle);
    const rows = screen.getAllByRole('link', { name: /^Intent / });
    // The question first, then the newest runs; five at most, each with its pill.
    expect(rows.map((row) => row.getAttribute('href'))).toEqual([
      '/space/retail/intent/q1',
      '/space/retail/intent/r1/observability',
      '/space/retail/intent/r2/observability',
      '/space/retail/intent/r3/observability',
      '/space/retail/intent/r4/observability',
    ]);
    expect(rows[0]).toHaveTextContent('Waiting for input');
    expect(rows[1]).toHaveTextContent('Running');
    expect(screen.getByRole('link', { name: '2 more in the space' })).toHaveAttribute(
      'href',
      '/space/retail',
    );
  });
  it('shows a resume-needed intent as "Needs resume", the same pill as My work and the space row', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    fixtures.projects = [
      space('platform', 'Platform', [
        intent('q2', 'WAITING', daysAgo(10), { resumeRequired: true }),
      ]),
    ];
    renderSpaces();
    await user.click(screen.getByRole('button', { name: '1 active intent' }));
    const row = screen.getByRole('link', { name: /Intent q2/ });
    expect(row).toHaveTextContent('Needs resume');
    expect(row).not.toHaveTextContent('Waiting for input');
  });
});

describe('Spaces table', () => {
  it('is the remembered alternative, shows the role only when not Owner and uses relative times', () => {
    rememberListView();
    fixtures.projects = [
      space('retail', 'Retail', [intent('s1', 'SUCCEEDED', daysAgo(1))]),
      space('platform', 'Platform', [intent('s2', 'SUCCEEDED', daysAgo(40))], {
        userRole: 'member',
        gitRepo: undefined,
        kind: 'v1',
      }),
    ];
    renderSpaces();

    const table = screen.getByRole('table', { name: 'Spaces' });
    const rows = within(table).getAllByRole('row');
    const headers = within(rows[0])
      .getAllByRole('columnheader')
      .map((h) => h.textContent);
    expect(headers).toEqual(['Space', 'Work status', 'Repository', 'Last activity', 'Actions']);
    expect(headers).not.toContain('Role');

    expect(within(rows[1]).getByRole('link', { name: 'Retail' })).toHaveAttribute(
      'href',
      '/space/retail',
    );
    expect(within(rows[1]).queryByText(/owner/i)).not.toBeInTheDocument();
    expect(within(rows[2]).getByText('Member')).toBeVisible();
    expect(within(rows[2]).getByText('Legacy · read-only')).toBeVisible();

    expect(within(rows[1]).getAllByRole('cell')[1]).toHaveTextContent('example/retail');
    expect(within(rows[2]).getAllByRole('cell')[1]).toHaveTextContent('—');

    const retailTime = within(rows[1]).getAllByRole('cell')[2].querySelector('time');
    const platformTime = within(rows[2]).getAllByRole('cell')[2].querySelector('time');
    expect(retailTime).toHaveAttribute('dateTime', daysAgo(1));
    expect(retailTime).toHaveTextContent('1d ago');
    expect(platformTime).toHaveAttribute('dateTime', daysAgo(40));

    // Members get no destructive row menu; owners do.
    expect(screen.getByRole('button', { name: 'Actions for space Retail' })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Actions for space Platform' }),
    ).not.toBeInTheDocument();
  });

  it('is chosen from the cards and remembered', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    fixtures.projects = [space('retail', 'Retail', [intent('s1', 'SUCCEEDED', daysAgo(1))])];
    renderSpaces();
    expect(screen.queryByRole('table', { name: 'Spaces' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'List view' }));
    expect(screen.getByRole('table', { name: 'Spaces' })).toBeInTheDocument();
    expect(localStorage.getItem('aidlc-spaces-view')).toBe('list');
    await user.click(screen.getByRole('button', { name: 'Grid view' }));
    expect(screen.queryByRole('table', { name: 'Spaces' })).not.toBeInTheDocument();
    expect(localStorage.getItem('aidlc-spaces-view')).toBe('grid');
  });

  it('retains a failed delete confirmation with its error', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    fixtures.projects = [space('retail', 'Retail', [intent('r1', 'RUNNING', hoursAgo(0.1))])];
    fixtures.deleteSpace.mockRejectedValueOnce(new Error('Space still in use'));
    renderSpaces();
    await user.click(screen.getByRole('button', { name: 'Actions for space Retail' }));
    await user.click(screen.getByRole('menuitem', { name: 'Delete space' }));
    const dialog = screen.getByRole('alertdialog');
    // Names the space, so a delete from the wrong card is caught here.
    expect(within(dialog).getByRole('heading', { name: 'Delete Retail?' })).toBeInTheDocument();
    expect(dialog).toHaveTextContent(/running or waiting work/);
    await user.click(within(dialog).getByRole('button', { name: 'Delete space' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Space still in use');
    expect(dialog).toBeVisible();
  });
});
