import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@/test/query';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';

const fixtures = vi.hoisted(() => ({
  projects: [] as unknown[],
  loading: false,
  error: null as string | null,
  refresh: vi.fn(),
  preloadRoute: vi.fn(),
  prefetchHref: vi.fn(),
}));
vi.mock('@/lib/routePrefetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/routePrefetch')>()),
  prefetchHref: fixtures.prefetchHref,
  cancelHrefPrefetch: vi.fn(),
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
import MyWork from './MyWork';
import { APP_ROUTES } from '@/routes/registry';
import * as pages from '@/routes/pages';
import { queryClient } from '@/lib/queryClient';
import * as prefetchScheduler from '@/lib/prefetch';
import { qk } from '@/lib/queryKeys';
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

function CurrentPath() {
  const { pathname, search } = useLocation();
  return <span data-testid="current-path">{`${pathname}${search}`}</span>;
}

const renderDashboard = () =>
  render(
    <MemoryRouter>
      <MyWork />
    </MemoryRouter>,
  );

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

describe('My work — branding and states', () => {
  it('shows "My work" as the hero title and points a new user to their first space', () => {
    renderDashboard();
    expect(screen.getByRole('heading', { level: 1, name: 'My work' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'No spaces yet' })).toBeVisible();
    // The Spaces dashboard's shell opens the dialog on arrival.
    expect(screen.getByRole('link', { name: 'Create your first space' })).toHaveAttribute(
      'href',
      '/dashboard?reopenCreateSpace=1',
    );
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: /needs your attention/i })).not.toBeInTheDocument();
  });

  it('shows skeleton rows while loading instead of flashing an empty state', () => {
    fixtures.loading = true;
    renderDashboard();
    expect(screen.getByRole('status', { name: 'Loading your work' })).toBeInTheDocument();
    expect(screen.queryByText('No spaces yet')).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: /needs your attention/i })).not.toBeInTheDocument();
  });

  it('shows an error state with Retry when the portfolio cannot load', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    fixtures.error = 'Network down';
    renderDashboard();
    expect(
      screen.getByRole('heading', {
        level: 2,
        name: "Couldn't load your work",
      }),
    ).toBeVisible();
    expect(screen.getByText('Network down')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(fixtures.refresh).toHaveBeenCalledTimes(1);
  });

  it('says when nothing needs the reader, never a table of spaces; the Spaces dashboard has them', () => {
    fixtures.projects = [space('quiet', 'Quiet', [intent('s2', 'SUCCEEDED', hoursAgo(1))])];
    renderDashboard();
    expect(
      screen.getByRole('heading', {
        level: 2,
        name: 'Nothing needs you right now',
      }),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Browse spaces' })).toHaveAttribute(
      'href',
      '/dashboard',
    );
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /new space/i })).not.toBeInTheDocument();
  });

  describe('while a space has not been checked', () => {
    const quiet = () => space('quiet', 'Quiet', [intent('s2', 'SUCCEEDED', hoursAgo(1))]);
    const asking = () =>
      space('ask', 'Asking', [intent('q1', 'WAITING', hoursAgo(2), { pendingHumanTaskId: 't1' })]);

    it('does not give the all-clear while a space is still loading', () => {
      fixtures.projects = [quiet(), { ...space('slow', 'Slow', []), activityLoading: true }];
      renderDashboard();
      expect(screen.queryByText('Nothing needs you right now')).not.toBeInTheDocument();
      expect(screen.getByRole('status', { name: 'Loading your work' })).toBeInTheDocument();
    });

    it('says which space failed and offers Retry instead of the all-clear', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      fixtures.projects = [quiet(), { ...space('down', 'Down', []), activityError: true }];
      renderDashboard();
      expect(screen.queryByText('Nothing needs you right now')).not.toBeInTheDocument();
      expect(
        screen.getByRole('heading', { level: 2, name: "Couldn't check every space" }),
      ).toBeVisible();
      expect(screen.getByText(/Couldn't load the intents of Down/)).toBeVisible();
      await user.click(screen.getByRole('button', { name: 'Retry' }));
      expect(fixtures.refresh).toHaveBeenCalledTimes(1);
    });

    it('keeps the known work and says the list is incomplete when another space failed', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      fixtures.projects = [asking(), { ...space('down', 'Down', []), activityError: true }];
      renderDashboard();
      expect(screen.getByText('Intent q1')).toBeVisible();
      const notice = screen
        .getByText(/This list may be incomplete/)
        .closest<HTMLElement>('[data-tone="warning"]')!;
      expect(notice).toHaveTextContent(
        "This list may be incomplete. Couldn't load the intents of Down.",
      );
      await user.click(within(notice).getByRole('button', { name: 'Retry' }));
      expect(fixtures.refresh).toHaveBeenCalledTimes(1);
    });

    it('does not wait on or warn about a Viewer space, whose intents it never lists', () => {
      fixtures.projects = [
        quiet(),
        { ...space('ro', 'ReadOnly', [], { userRole: 'viewer' }), activityError: true },
        { ...space('ro2', 'ReadOnlySlow', [], { userRole: 'viewer' }), activityLoading: true },
      ];
      renderDashboard();
      expect(screen.getByText('Nothing needs you right now')).toBeVisible();
      expect(screen.queryByText(/This list may be incomplete/)).not.toBeInTheDocument();
    });

    it('keeps the known work and says which space is still loading', () => {
      fixtures.projects = [asking(), { ...space('slow', 'Slow', []), activityLoading: true }];
      renderDashboard();
      expect(screen.getByText('Intent q1')).toBeVisible();
      expect(
        screen.getByText('This list may be incomplete. Still loading the intents of Slow.'),
      ).toBeVisible();
    });
  });

  it('is its own page at /my-work, not the page after login, and stays put on a create-space link: the shell opens the dialog', () => {
    expect(APP_ROUTES[0]).toMatchObject({ path: '/dashboard' });
    expect(APP_ROUTES[0].page).not.toBe(pages.MyWork);
    expect(APP_ROUTES.find((route) => route.path === '/my-work')?.page).toBe(pages.MyWork);
    render(
      <MemoryRouter initialEntries={['/my-work?reopenCreateSpace=1&gitProvider=github']}>
        <CurrentPath />
        <Routes>
          <Route path="/my-work" element={<MyWork />} />
          <Route path="/dashboard" element={<p>Spaces page</p>} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'My work' })).toBeInTheDocument();
    expect(screen.queryByText('Spaces page')).not.toBeInTheDocument();
    expect(screen.getByTestId('current-path')).toHaveTextContent('/my-work');
  });

  describe('logo', () => {
    afterEach(() => vi.unstubAllEnvs());

    it('shows the stock logo by default', () => {
      renderDashboard();
      expect(screen.getByRole('img', { name: 'AI-DLC' })).toHaveAttribute('src', '/logo.svg');
    });

    it("shows the deployment's logo and name when branded", () => {
      vi.stubEnv('VITE_BRAND_LOGO', '/branding/logo.svg');
      vi.stubEnv('VITE_BRAND_NAME', 'Example Corp');
      renderDashboard();
      expect(screen.getByRole('img', { name: 'Example Corp' })).toHaveAttribute(
        'src',
        '/branding/logo.svg',
      );
    });
  });
});

describe('Needs your attention', () => {
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

  it("does not list a Viewer's questions or failures as theirs to act on, but lists a member's", () => {
    fixtures.projects = [
      space(
        'audit',
        'Audit',
        [
          intent('vq', 'WAITING', daysAgo(20), { pendingHumanTaskId: 'task-v' }),
          intent('vf', 'FAILED', daysAgo(15)),
        ],
        { userRole: 'viewer' },
      ),
      space(
        'team',
        'Team',
        [intent('mq', 'WAITING', daysAgo(2), { pendingHumanTaskId: 'task-m' })],
        {
          userRole: 'member',
        },
      ),
    ];
    renderDashboard();

    const inbox = screen.getByRole('region', { name: /needs your attention/i });
    const rows = within(inbox).getAllByRole('listitem');
    expect(rows).toHaveLength(1);
    expect(within(rows[0]).getByRole('link', { name: 'Intent mq' })).toBeVisible();
    expect(within(inbox).queryByRole('link', { name: 'Intent vq' })).toBeNull();
    expect(within(inbox).queryByRole('link', { name: 'Intent vf' })).toBeNull();
  });

  it('lists every intent that needs a human — answerable items first, then failures, then stalled runs', () => {
    fixtures.projects = [quiet(), platform(), retail()];
    renderDashboard();

    const inbox = screen.getByRole('region', { name: /needs your attention/i });
    expect(within(inbox).getByRole('heading', { level: 2 })).toHaveTextContent(
      'Needs your attention',
    );
    const rows = within(inbox).getAllByRole('listitem');
    expect(rows).toHaveLength(4);

    // A question comes first even though the failure is not the oldest item:
    // the pill says the status; the line under the title says what waits,
    // where and for how long (the stage alone until the detail is cached).
    expect(within(rows[0]).getByRole('link', { name: 'Intent q1' })).toHaveAttribute(
      'href',
      '/space/retail/intent/q1',
    );
    // Until the detail is cached nothing is guessed: no "1 decision", no age
    // from updatedAt (the header would read the oldest gate instead, R3-5).
    expect(within(rows[0]).getByTestId('inbox-row-meta')).toHaveTextContent(/^Retail$/);
    expect(rows[0]).toHaveTextContent('Waiting for input');
    expect(rows[0]).not.toHaveTextContent(/days/);
    expect(rows[0]).not.toHaveTextContent(/decision/);

    // A saved answer that needs a resume is answerable too: it stays ahead of
    // every failure.
    expect(within(rows[1]).getByRole('link', { name: 'Intent q2' })).toHaveAttribute(
      'href',
      '/space/platform/intent/q2',
    );
    expect(within(rows[1]).getByTestId('inbox-row-meta')).toHaveTextContent(
      /^Resume needed · waiting 10 days · Platform$/,
    );
    expect(within(rows[1]).getByText('Needs resume')).toBeVisible();

    // A failure is terminal: time since, never a duration ("Failed · 56 days").
    expect(within(rows[2]).getByRole('link', { name: 'Intent f1' })).toHaveAttribute(
      'href',
      '/space/retail/intent/f1/observability',
    );
    expect(within(rows[2]).getByTestId('inbox-row-meta')).toHaveTextContent(
      /^Failed 56 days ago · Retail$/,
    );
    expect(rows[2]).not.toHaveTextContent(/Failed · 56 days/);
    expect(within(rows[2]).getByText('Failed')).toBeVisible();

    // A stalled run needs a human too: it is listed last with a warning pill
    // and a "View activity" action that opens the run's work page.
    expect(within(rows[3]).getByRole('link', { name: 'Intent r2' })).toHaveAttribute(
      'href',
      '/space/retail/intent/r2/observability',
    );
    expect(within(rows[3]).getByTestId('inbox-row-meta')).toHaveTextContent(
      /^Stalled · Last activity 2 h ago · Retail$/,
    );
    expect(rows[3].querySelector('[data-stalled]')).toHaveTextContent(/^Stalled/);
    expect(within(rows[3]).getByRole('link', { name: 'View activity' })).toHaveAttribute(
      'href',
      '/space/retail/intent/r2',
    );
    expect(within(rows[0]).queryByRole('link', { name: 'View activity' })).not.toBeInTheDocument();

    // A WAITING run with no pending question and a live agent are not inbox items.
    expect(within(inbox).queryByText('Intent w1')).not.toBeInTheDocument();
    expect(within(inbox).queryByText('Intent r1')).not.toBeInTheDocument();
  });

  it('orders by kind before age: questions oldest first, then failures oldest first, then stalled', () => {
    fixtures.projects = [
      space('mixed', 'Mixed', [
        intent('f-old', 'FAILED', daysAgo(138)),
        intent('f-new', 'FAILED', daysAgo(20)),
        intent('s1', 'RUNNING', hoursAgo(3)),
        intent('q-new', 'WAITING', daysAgo(2), { pendingHumanTaskId: 't2' }),
        intent('q-old', 'WAITING', daysAgo(110), { pendingHumanTaskId: 't1' }),
      ]),
    ];
    renderDashboard();
    const inbox = screen.getByRole('region', { name: /needs your attention/i });
    const titles = within(inbox)
      .getAllByRole('listitem')
      .map((row) => within(row).getAllByRole('link')[0].textContent);
    expect(titles).toEqual([
      'Intent q-old',
      'Intent q-new',
      'Intent f-old',
      'Intent f-new',
      'Intent s1',
    ]);
  });

  it('never hides an answerable item behind "Show all", on desktop or on narrow screens', () => {
    fixtures.projects = [
      space('busy', 'Busy', [
        ...Array.from({ length: 4 }, (_, i) =>
          intent(`q${i}`, 'WAITING', daysAgo(i + 1), {
            pendingHumanTaskId: `t${i}`,
          }),
        ),
        ...Array.from({ length: 4 }, (_, i) => intent(`f${i}`, 'FAILED', daysAgo(50 + i))),
      ]),
    ];
    renderDashboard();
    const inbox = screen.getByRole('region', { name: /needs your attention/i });
    const rows = within(inbox).getAllByRole('listitem');
    // Four questions + one failure fill the desktop cap of five…
    expect(rows).toHaveLength(5);
    expect(rows.map((row) => within(row).getAllByRole('link')[0].textContent)).toEqual([
      'Intent q3',
      'Intent q2',
      'Intent q1',
      'Intent q0',
      'Intent f3',
    ]);
    // …and the narrow cap of three yields to the questions: only the failure
    // waits behind "Show all" on a phone.
    for (const row of rows.slice(0, 4)) expect(row).not.toHaveClass('hidden');
    expect(rows[4]).toHaveClass('hidden', 'sm:flex');
    expect(within(inbox).getByRole('button', { name: 'Show all (8)' })).toBeInTheDocument();
  });

  it('leaves out a run whose list row is old when its cached activity is recent', () => {
    // r2's list row is 2 h old (stalled by itself); the cached detail saw a stage start now.
    queryClient.setQueryData(qk.intentDetail('retail', 'r2'), () => ({
      intent: { id: 'r2', status: 'RUNNING', updatedAt: hoursAgo(2), createdAt: hoursAgo(2) },
      gates: [],
      stages: [{ stageId: 'build', state: 'RUNNING', startedAt: hoursAgo(0.05) }],
      events: [],
    }));
    fixtures.projects = [retail()];
    renderDashboard();
    const inbox = screen.getByRole('region', { name: /needs your attention/i });
    expect(within(inbox).queryByText('Intent r2')).not.toBeInTheDocument();
    expect(within(inbox).getAllByRole('listitem')).toHaveLength(2);
  });

  it('names the pending gates and the stage next to the title once the detail is cached', () => {
    queryClient.setQueryData(qk.intentDetail('retail', 'q1'), () => ({
      intent: { currentStage: 'feasibility-assessment' },
      gates: [
        { humanTaskId: 'task-1', status: 'pending', kind: 'question' },
        { humanTaskId: 'task-2', status: 'pending', kind: 'question' },
        { humanTaskId: 'task-0', status: 'answered', kind: 'approval' },
      ],
    }));
    queryClient.setQueryData(qk.intentDetail('retail', 'f1'), () => ({
      intent: { currentStage: 'deployment-pipeline', failureReason: null },
      gates: [],
    }));
    queryClient.setQueryData(qk.intentDetail('retail', 'r2'), () => ({
      intent: { currentStage: 'intent-capture' },
      gates: [],
    }));
    fixtures.projects = [retail()];
    renderDashboard();
    const inbox = screen.getByRole('region', { name: /needs your attention/i });
    const rows = within(inbox).getAllByRole('listitem');
    // One builder with the Space rows: "<what> · <stage>", "Failed at <stage> ·
    // <age> ago", "Stalled at <stage> · Last activity <age> ago", then the space.
    expect(within(rows[0]).getByTestId('inbox-row-meta')).toHaveTextContent(
      /^2 questions · Feasibility Assessment · Retail$/,
    );
    expect(within(rows[1]).getByTestId('inbox-row-meta')).toHaveTextContent(
      /^Failed at Deployment Pipeline · 56 days ago · Retail$/,
    );
    expect(within(rows[2]).getByTestId('inbox-row-meta')).toHaveTextContent(
      /^Stalled at Intent Capture · Last activity 2 h ago · Retail$/,
    );
  });

  it('names the stage from the space list the shell already loaded, before any detail is cached', () => {
    queryClient.setQueryData(qk.projectIntents('retail'), () => [
      {
        ...intent('q1', 'WAITING', daysAgo(108)),
        currentStage: 'feasibility-assessment',
      },
      {
        ...intent('f1', 'FAILED', daysAgo(56)),
        currentStage: 'state-init',
        failureReason: 'stage_failed: deployment-pipeline: cli_nonzero_exit: exit 1',
      },
      {
        ...intent('r2', 'RUNNING', hoursAgo(2)),
        currentStage: 'intent-capture',
      },
    ]);
    fixtures.projects = [retail()];
    renderDashboard();
    const inbox = screen.getByRole('region', { name: /needs your attention/i });
    const rows = within(inbox).getAllByRole('listitem');
    expect(within(rows[0]).getByTestId('inbox-row-meta')).toHaveTextContent(
      /^Feasibility Assessment · Retail$/,
    );
    expect(within(rows[1]).getByTestId('inbox-row-meta')).toHaveTextContent(
      /^Failed at Deployment Pipeline · 56 days ago · Retail$/,
    );
    expect(within(rows[2]).getByTestId('inbox-row-meta')).toHaveTextContent(
      /^Stalled at Intent Capture · Last activity 2 h ago · Retail$/,
    );
  });

  it('caps the non-answerable rows, reveals the rest on demand, offers Show less and remembers the choice', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    fixtures.projects = [
      space(
        'busy',
        'Busy',
        Array.from({ length: 7 }, (_, i) => intent(`f${i}`, 'FAILED', daysAgo(i + 1))),
      ),
    ];
    const { unmount } = renderDashboard();
    const inbox = screen.getByRole('region', { name: /needs your attention/i });
    expect(within(inbox).getAllByRole('listitem')).toHaveLength(5);
    await user.click(within(inbox).getByRole('button', { name: 'Show all (7)' }));
    expect(within(inbox).getAllByRole('listitem')).toHaveLength(7);
    expect(within(inbox).queryByRole('button', { name: /show all/i })).not.toBeInTheDocument();

    // The choice survives a revisit…
    unmount();
    renderDashboard();
    const again = screen.getByRole('region', { name: /needs your attention/i });
    expect(within(again).getAllByRole('listitem')).toHaveLength(7);
    // …and can be undone.
    await user.click(within(again).getByRole('button', { name: 'Show less' }));
    expect(within(again).getAllByRole('listitem')).toHaveLength(5);
    expect(within(again).getByRole('button', { name: 'Show all (7)' })).toBeInTheDocument();
  });

  it('keeps only the first three non-answerable rows on narrow screens until Show all', () => {
    fixtures.projects = [
      space(
        'busy',
        'Busy',
        Array.from({ length: 4 }, (_, i) => intent(`f${i}`, 'FAILED', daysAgo(i + 1))),
      ),
    ];
    renderDashboard();
    const inbox = screen.getByRole('region', { name: /needs your attention/i });
    const rows = within(inbox).getAllByRole('listitem');
    expect(rows).toHaveLength(4);
    expect(rows[2]).not.toHaveClass('hidden');
    expect(rows[3]).toHaveClass('hidden', 'sm:flex');
    // Four rows fit on a desktop, so the control is for narrow screens only.
    expect(within(inbox).getByRole('button', { name: 'Show all (4)' })).toHaveClass('sm:hidden');
  });

  it('warms the intent page through the delegated listener after hovering a row', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const prefetch = vi.spyOn(prefetchScheduler, 'prefetchQuery').mockImplementation(() => {});
    const { installNavIntent } = await import('@/lib/navIntent');
    const uninstall = installNavIntent(() => ({
      user: { isPlatformAdmin: false },
      currentHref: '/dashboard',
    }));
    try {
      fixtures.projects = [retail()];
      renderDashboard();
      const inbox = screen.getByRole('region', {
        name: /needs your attention/i,
      });
      await user.hover(within(inbox).getByRole('link', { name: 'Intent q1' }));
      await vi.advanceTimersByTimeAsync(250);
      expect(fixtures.prefetchHref).toHaveBeenCalledWith(
        '/space/retail/intent/q1',
        expect.objectContaining({ trigger: 'hover' }),
      );
      // The row has no per-row speculation of its own.
      expect(prefetch).not.toHaveBeenCalled();
    } finally {
      uninstall();
    }
  });
});
