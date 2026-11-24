import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, within } from '@/test/query';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router';

const mockAuth = vi.hoisted(() => ({ isPlatformAdmin: false }));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => mockAuth,
}));

const mockIntentCtx = vi.hoisted(() => ({ value: null as unknown }));

vi.mock('@/contexts/IntentContext', () => ({
  useIntentOptional: () => mockIntentCtx.value,
}));

const mockProjects = vi.hoisted(() => ({
  projects: [] as unknown[],
  loading: false,
  refresh: vi.fn(),
}));

const mockCachedSummary = vi.hoisted(() => vi.fn((): unknown => undefined));

vi.mock('@/hooks/useProjectsCache', () => ({
  useProjectsCache: () => mockProjects,
  projectLastActivityAt: () => null,
  useProjectCache: () => ({ project: null }),
  getCachedIntentSummary: (...args: unknown[]) => mockCachedSummary(...(args as [])),
}));

vi.mock('@/components/CreateProjectModal', () => ({
  CreateProjectModal: () => null,
}));

const mockPrefetchHref = vi.hoisted(() => vi.fn());
vi.mock('@/lib/routePrefetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/routePrefetch')>()),
  prefetchHref: mockPrefetchHref,
  cancelHrefPrefetch: vi.fn(),
}));

const mockCache = vi.hoisted(() => ({
  prefetch: vi.fn(),
  peek: vi.fn((_key?: unknown): unknown => undefined),
}));
vi.mock('@/lib/prefetch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/prefetch')>();
  return { ...actual, prefetchQuery: mockCache.prefetch };
});
vi.mock('@/services/intents', () => ({ intentsService: { get: vi.fn() } }));

import { AppSidebar } from './AppSidebar';
import { installNavIntent } from '@/lib/navIntent';
import { queryClient } from '@/lib/queryClient';
let cacheSubscribe: ReturnType<typeof vi.spyOn>;
import { idleCandidates } from '@/lib/idleCandidates';

function CurrentPath() {
  const { pathname } = useLocation();
  return <span data-testid="current-path">{pathname}</span>;
}

function renderSidebar(path = '/dashboard') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <CurrentPath />
      <Routes>
        <Route path="/dashboard" element={<AppSidebar />} />
        <Route path="/space/:projectId" element={<AppSidebar />} />
        <Route path="/space/:projectId/intent/:intentId" element={<AppSidebar />} />
        <Route path="/space/:projectId/intent/:intentId/observability" element={<AppSidebar />} />
        <Route path="/space/:projectId/intent/:intentId/graph" element={<AppSidebar />} />
        <Route path="*" element={<AppSidebar />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.spyOn(queryClient, 'getQueryData').mockImplementation(
    (key) => (mockCache.peek(key) as { data?: unknown } | undefined)?.data,
  );
  cacheSubscribe = vi.spyOn(queryClient.getQueryCache(), 'subscribe');
  mockProjects.projects = [];
  mockIntentCtx.value = null;
  mockCachedSummary.mockReset().mockReturnValue(undefined);
  mockAuth.isPlatformAdmin = false;
  mockCache.prefetch.mockReset();
  mockPrefetchHref.mockReset();
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('AppSidebar active-work section', () => {
  it('defaults to "Needs your attention" and says what the list is showing', () => {
    renderSidebar();
    const label = screen.getByLabelText(/intent activity filter/i);
    expect(label).toBeInTheDocument();
    expect(label.tagName).toBe('DIV'); // non-navigating element
    expect(label).toHaveTextContent(/showing/i);
    expect(label).toHaveTextContent('Needs your attention');
  });

  it('reflects the stored filter label', () => {
    localStorage.setItem('aidlc-sidebar-iterations-filter', 'active');
    renderSidebar();
    const label = screen.getByLabelText(/intent activity filter/i);
    expect(label).toHaveTextContent('Active intents');
  });

  it('counts the matching intents in the visible filter label', () => {
    const intents = [
      { id: 'int-1', title: 'Waiting One', status: 'WAITING', pendingHumanTaskId: 'task-1' },
      { id: 'int-2', title: 'Waiting Two', status: 'WAITING', pendingHumanTaskId: 'task-2' },
      { id: 'int-3', title: 'Failed One', status: 'FAILED' },
    ];
    mockProjects.projects = [
      {
        project: { id: 'p1', name: 'Space', kind: 'v2', createdAt: '2024-01-01' },
        latestSprint: null,
        latestIntent: intents[0],
        intents,
        lastIntentActivityAt: null,
        activity: { inProgress: 3, attention: 3 },
      },
    ];
    renderSidebar();
    expect(screen.getByLabelText(/intent activity filter/i)).toHaveTextContent(
      'Showing: Needs your attention · 3',
    );
  });

  it('uses latestIntent status for v2 projects', () => {
    mockProjects.projects = [
      {
        project: { id: 'p1', name: 'V2 Space', kind: 'v2', createdAt: '2024-01-01' },
        latestSprint: null,
        latestIntent: { id: 'int-1', title: 'Build feature', status: 'RUNNING' },
        lastIntentActivityAt: null,
        activity: { inProgress: 1, attention: 0 },
      },
    ];
    renderSidebar();
    const projectBtn = screen.getByTitle('V2 Space — Agent running');
    expect(projectBtn).toBeInTheDocument();
  });

  it('no longer shows waiting title on v1 Space row (attention surfaced at Intent level)', () => {
    mockProjects.projects = [
      {
        project: { id: 'p2', name: 'V1 Project', kind: 'v1', createdAt: '2024-01-01' },
        latestSprint: {
          id: 's1',
          name: 'Sprint 1',
          phase: 'INCEPTION',
          currentAgentStatus: 'waiting',
        },
        latestIntent: null,
        lastIntentActivityAt: null,
        activity: { inProgress: 0, attention: 0 },
      },
    ];
    renderSidebar();
    const projectBtn = screen.getByTitle('V1 Project');
    expect(projectBtn).toBeInTheDocument();
  });

  it('counts and displays every matching Intent in one v2 Space', () => {
    localStorage.setItem('aidlc-sidebar-iterations-filter', 'attention');
    const intents = [
      {
        id: 'int-1',
        title: 'Waiting Intent One',
        status: 'WAITING',
        pendingHumanTaskId: 'task-1',
      },
      {
        id: 'int-2',
        title: 'Waiting Intent Two',
        status: 'WAITING',
        pendingHumanTaskId: 'task-2',
      },
      {
        id: 'int-3',
        title: 'Waiting Intent Three',
        status: 'WAITING',
        pendingHumanTaskId: 'task-3',
      },
    ];
    mockProjects.projects = [
      {
        project: { id: 'p1', name: 'Busy Space', kind: 'v2', createdAt: '2024-01-01' },
        latestSprint: null,
        latestIntent: intents[0],
        intents,
        lastIntentActivityAt: null,
        activity: { inProgress: 3, attention: 3 },
      },
    ];

    renderSidebar();

    expect(screen.getByLabelText(/intent activity filter/i)).toHaveTextContent(
      'Needs your attention · 3',
    );
    expect(screen.getByText('Waiting Intent One')).toBeInTheDocument();
    expect(screen.getByText('Waiting Intent Two')).toBeInTheDocument();
    expect(screen.getByText('Waiting Intent Three')).toBeInTheDocument();
  });

  it('counts only Intents matching the selected filter', () => {
    localStorage.setItem('aidlc-sidebar-iterations-filter', 'attention');
    const intents = [
      {
        id: 'int-1',
        title: 'Waiting Intent',
        status: 'WAITING',
        pendingHumanTaskId: 'task-1',
      },
      { id: 'int-2', title: 'Failed Intent One', status: 'FAILED' },
      { id: 'int-3', title: 'Failed Intent Two', status: 'FAILED' },
      { id: 'int-4', title: 'Running Intent', status: 'RUNNING' },
    ];
    mockProjects.projects = [
      {
        project: { id: 'p1', name: 'Mixed Space', kind: 'v2', createdAt: '2024-01-01' },
        latestSprint: null,
        latestIntent: intents[3],
        intents,
        lastIntentActivityAt: null,
        activity: { inProgress: 4, attention: 3 },
      },
    ];

    renderSidebar();

    expect(screen.getByLabelText(/intent activity filter/i)).toHaveTextContent(
      'Needs your attention · 3',
    );
    expect(screen.getByText('Waiting Intent')).toBeInTheDocument();
    expect(screen.getByText('Failed Intent One')).toBeInTheDocument();
    expect(screen.getByText('Failed Intent Two')).toBeInTheDocument();
    expect(screen.queryByText('Running Intent')).not.toBeInTheDocument();
  });

  it('keeps the sidebar compact and links to the space when more Intents are hidden', () => {
    localStorage.setItem('aidlc-sidebar-iterations-filter', 'attention');
    const intents = Array.from({ length: 6 }, (_, index) => ({
      id: `int-${index + 1}`,
      title: `Waiting Intent ${index + 1}`,
      status: 'WAITING',
      pendingHumanTaskId: `task-${index + 1}`,
    }));
    mockProjects.projects = [
      {
        project: { id: 'p1', name: 'Overflow Space', kind: 'v2', createdAt: '2024-01-01' },
        latestSprint: null,
        latestIntent: intents[0],
        intents,
        lastIntentActivityAt: null,
        activity: { inProgress: 6, attention: 6 },
      },
    ];

    renderSidebar();

    for (let index = 1; index <= 5; index++) {
      expect(screen.getByText(`Waiting Intent ${index}`)).toBeInTheDocument();
    }
    expect(screen.queryByText('Waiting Intent 6')).not.toBeInTheDocument();
    const showMore = screen.getByRole('link', {
      name: 'Show 1 more intent in Overflow Space',
    });
    expect(showMore).toBeInTheDocument();
    fireEvent.click(showMore);
    expect(screen.getByTestId('current-path')).toHaveTextContent('/space/p1');
  });

  it('does not count an automatic wait as needing user attention', () => {
    localStorage.setItem('aidlc-sidebar-iterations-filter', 'attention');
    mockProjects.projects = [
      {
        project: { id: 'p1', name: 'Automated Space', kind: 'v2', createdAt: '2024-01-01' },
        latestSprint: null,
        latestIntent: { id: 'int-1', title: 'Automated wait', status: 'WAITING' },
        intents: [{ id: 'int-1', title: 'Automated wait', status: 'WAITING' }],
        lastIntentActivityAt: null,
        activity: { inProgress: 1, attention: 1 },
      },
    ];

    renderSidebar();

    expect(screen.getByLabelText(/intent activity filter/i)).toHaveTextContent(
      'Needs your attention',
    );
    expect(screen.queryByText('Automated wait')).not.toBeInTheDocument();
    expect(screen.getByText('No intents need attention')).toBeInTheDocument();
  });

  it('says the feed could not load instead of claiming nothing needs attention', async () => {
    mockProjects.projects = [
      {
        project: { id: 'p1', name: 'Space', kind: 'v2', createdAt: '2024-01-01' },
        activityError: true,
        lastIntentActivityAt: null,
        activity: { inProgress: 0, attention: 0 },
      },
    ];
    renderSidebar();
    expect(screen.getByText(/Couldn.t load intents/)).toBeInTheDocument();
    expect(screen.queryByText('No intents need attention')).not.toBeInTheDocument();
    screen.getByRole('button', { name: 'Retry' }).click();
    expect(mockProjects.refresh).toHaveBeenCalled();
  });

  it('sorts matching Intents by recent activity before applying the five-row cap', () => {
    localStorage.setItem('aidlc-sidebar-iterations-filter', 'active');
    const intents = [
      {
        id: 'waiting-1',
        title: 'Oldest waiting Intent',
        status: 'WAITING',
        pendingHumanTaskId: 'task-1',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'waiting-2',
        title: 'Waiting Intent Two',
        status: 'WAITING',
        pendingHumanTaskId: 'task-2',
        updatedAt: '2026-01-02T00:00:00.000Z',
      },
      {
        id: 'waiting-3',
        title: 'Waiting Intent Three',
        status: 'WAITING',
        pendingHumanTaskId: 'task-3',
        updatedAt: '2026-01-03T00:00:00.000Z',
      },
      {
        id: 'waiting-4',
        title: 'Waiting Intent Four',
        status: 'WAITING',
        pendingHumanTaskId: 'task-4',
        updatedAt: '2026-01-04T00:00:00.000Z',
      },
      {
        id: 'waiting-5',
        title: 'Waiting Intent Five',
        status: 'WAITING',
        pendingHumanTaskId: 'task-5',
        updatedAt: '2026-01-05T00:00:00.000Z',
      },
      {
        id: 'running-new',
        title: 'Newest running Intent',
        status: 'RUNNING',
        updatedAt: '2026-02-01T00:00:00.000Z',
      },
    ];
    mockProjects.projects = [
      {
        project: { id: 'p1', name: 'Status-grouped Space', kind: 'v2', createdAt: '2024-01-01' },
        latestSprint: null,
        latestIntent: intents[5],
        intents,
        lastIntentActivityAt: null,
        activity: { inProgress: 6, attention: 5 },
      },
    ];

    renderSidebar();

    expect(screen.getByText('Newest running Intent')).toBeInTheDocument();
    expect(screen.queryByText('Oldest waiting Intent')).not.toBeInTheDocument();
  });

  it('keeps a selected matching Intent visible when it falls beyond the five-row cap', () => {
    localStorage.setItem('aidlc-sidebar-iterations-filter', 'attention');
    const intents = Array.from({ length: 6 }, (_, index) => ({
      id: `int-${index + 1}`,
      title: `Waiting Intent ${index + 1}`,
      status: 'WAITING',
      pendingHumanTaskId: `task-${index + 1}`,
    }));
    mockProjects.projects = [
      {
        project: { id: 'p1', name: 'Overflow Space', kind: 'v2', createdAt: '2024-01-01' },
        latestSprint: null,
        latestIntent: intents[0],
        intents,
        lastIntentActivityAt: null,
        activity: { inProgress: 6, attention: 6 },
      },
    ];
    mockIntentCtx.value = {
      detail: {
        intent: intents[5],
      },
    };

    renderSidebar('/space/p1/intent/int-6/observability');

    expect(screen.getByText('Waiting Intent 6')).toBeInTheDocument();
    expect(screen.queryByText('Waiting Intent 5')).not.toBeInTheDocument();
    expect(screen.queryByTestId('current-intent-outside-filter')).not.toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: /intent sections/i })).toBeInTheDocument();
  });
});

describe('AppSidebar IntentSectionTabs density', () => {
  it('renders dense section tabs when intent is selected', () => {
    localStorage.setItem('aidlc-sidebar-iterations-filter', 'active');
    mockProjects.projects = [
      {
        project: { id: 'p1', name: 'Space', kind: 'v2', createdAt: '2024-01-01' },
        latestSprint: null,
        latestIntent: { id: 'int-1', title: 'Intent A', status: 'RUNNING' },
        lastIntentActivityAt: null,
        activity: { inProgress: 1, attention: 0 },
      },
    ];
    renderSidebar('/space/p1/intent/int-1/observability');
    const nav = screen.getByRole('navigation', { name: /intent sections/i });
    expect(nav).toBeInTheDocument();
    expect(nav.className).toContain('py-1');
    expect(nav.className).toContain('gap-px');
    const overviewBtn = within(nav).getByRole('link', { name: /overview/i });
    // Dense, but never under the 24 px target floor (P1-7).
    expect(overviewBtn.className).toContain('py-1');
    expect(overviewBtn.className).toContain('min-h-6');
  });
});

describe('AppSidebar current Intent outside the filter', () => {
  const setupHistorical = () => {
    localStorage.setItem('aidlc-sidebar-iterations-filter', 'active');
    mockProjects.projects = [
      {
        project: { id: 'p1', name: 'Space One', kind: 'v2', createdAt: '2024-01-01' },
        latestSprint: null,
        latestIntent: { id: 'int-latest', title: 'Latest Intent', status: 'RUNNING' },
        lastIntentActivityAt: null,
        activity: { inProgress: 1, attention: 0 },
      },
    ];
    mockIntentCtx.value = {
      detail: {
        intent: { id: 'int-old', title: 'Historical Intent', status: 'FAILED' },
      },
    };
  };

  it('lists the URL-selected intent with its section tabs when the filter excludes it', () => {
    setupHistorical();
    renderSidebar('/space/p1/intent/int-old/observability');
    const current = screen.getByTestId('current-intent-outside-filter');
    expect(current).toHaveTextContent('Historical Intent');
    const nav = within(current).getByRole('navigation', { name: /intent sections/i });
    expect(nav).toBeInTheDocument();
  });

  it('never labels the open intent "Historical"', () => {
    setupHistorical();
    renderSidebar('/space/p1/intent/int-old/observability');
    const current = screen.getByTestId('current-intent-outside-filter');
    expect(current).not.toHaveTextContent(/historical$/i);
    expect(within(current).queryByText(/^historical$/i)).toBeNull();
    expect(screen.queryByTitle(/historical/i)).toBeNull();
  });

  it('is not boxed in a dashed card', () => {
    setupHistorical();
    renderSidebar('/space/p1/intent/int-old/observability');
    const current = screen.getByTestId('current-intent-outside-filter');
    expect(current.className).not.toMatch(/dashed|border/);
    expect(screen.queryByTestId('pinned-selected-intent')).toBeNull();
  });

  it('shows the same status pill as any other row', () => {
    setupHistorical();
    renderSidebar('/space/p1/intent/int-old/observability');
    const current = screen.getByTestId('current-intent-outside-filter');
    expect(within(current).getByText('Failed').closest('[data-tone]')).toHaveAttribute(
      'data-tone',
      'danger',
    );
  });

  it('does not show a History icon', () => {
    setupHistorical();
    renderSidebar('/space/p1/intent/int-old/observability');
    const current = screen.getByTestId('current-intent-outside-filter');
    expect(current.querySelector('.lucide-history')).toBeNull();
  });

  it('marks the row as the current intent', () => {
    setupHistorical();
    renderSidebar('/space/p1/intent/int-old/observability');
    const current = screen.getByTestId('current-intent-outside-filter');
    const btn = within(current).getByRole('link', { name: /historical intent/i });
    expect(btn).toHaveAttribute('aria-current', 'true');
  });

  it('does NOT duplicate when the selected intent is already in the filtered list', () => {
    localStorage.setItem('aidlc-sidebar-iterations-filter', 'active');
    mockProjects.projects = [
      {
        project: { id: 'p1', name: 'Space One', kind: 'v2', createdAt: '2024-01-01' },
        latestSprint: null,
        latestIntent: { id: 'int-1', title: 'Active Intent', status: 'RUNNING' },
        lastIntentActivityAt: null,
        activity: { inProgress: 1, attention: 0 },
      },
    ];
    mockIntentCtx.value = {
      detail: {
        intent: { id: 'int-1', title: 'Active Intent', status: 'RUNNING' },
      },
    };
    renderSidebar('/space/p1/intent/int-1/observability');
    expect(screen.queryByTestId('current-intent-outside-filter')).not.toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: /intent sections/i });
    expect(nav).toBeInTheDocument();
  });
});

describe('AppSidebar open intent before its detail is known (R3-1, R3-2)', () => {
  const spaceOnly = () => {
    localStorage.setItem('aidlc-sidebar-iterations-filter', 'active');
    mockProjects.projects = [
      {
        project: { id: 'p1', name: 'Space One', kind: 'v2', createdAt: '2024-01-01' },
        latestSprint: null,
        latestIntent: { id: 'int-other', title: 'Another intent', status: 'RUNNING' },
        lastIntentActivityAt: null,
        activity: { inProgress: 1, attention: 0 },
      },
    ];
  };

  it('shows a loading placeholder — no title guess, no "Draft" pill — while the detail loads', () => {
    spaceOnly();
    mockIntentCtx.value = { detail: null, loading: true, notFound: false };
    renderSidebar('/space/p1/intent/int-new/observability');
    const current = screen.getByTestId('current-intent-outside-filter');
    expect(within(current).getByRole('status', { name: 'Loading intent' })).toBeInTheDocument();
    expect(current).not.toHaveTextContent(/Draft/);
    expect(current.querySelector('[data-tone]')).toBeNull();
    expect(within(current).getByRole('navigation', { name: /intent sections/i })).toBeVisible();
  });

  it('reads the title and status from the cached list summary while the detail loads', () => {
    spaceOnly();
    mockIntentCtx.value = { detail: null, loading: true, notFound: false };
    mockCachedSummary.mockReturnValue({
      id: 'int-new',
      title: 'Cached title',
      status: 'FAILED',
      updatedAt: '2026-01-01T00:00:00Z',
      createdAt: '2026-01-01T00:00:00Z',
    });
    renderSidebar('/space/p1/intent/int-new/observability');
    const current = screen.getByTestId('current-intent-outside-filter');
    expect(current).toHaveTextContent('Cached title');
    expect(within(current).getByText('Failed')).toBeInTheDocument();
    expect(within(current).queryByRole('status')).toBeNull();
  });

  it('renders no row and no section tabs for an intent the detail request rejected as gone', () => {
    spaceOnly();
    mockIntentCtx.value = { detail: null, loading: false, notFound: true, errorStatus: 404 };
    renderSidebar('/space/p1/intent/int-gone/observability');
    expect(screen.queryByTestId('current-intent-outside-filter')).toBeNull();
    expect(screen.queryByRole('navigation', { name: /intent sections/i })).toBeNull();
    expect(screen.queryByText(/Draft/)).toBeNull();
  });

  it('drops a stale list row for an intent the detail request rejected as gone', () => {
    localStorage.setItem('aidlc-sidebar-iterations-filter', 'active');
    mockProjects.projects = [
      {
        project: { id: 'p1', name: 'Space One', kind: 'v2', createdAt: '2024-01-01' },
        latestSprint: null,
        latestIntent: { id: 'int-gone', title: 'Deleted meanwhile', status: 'RUNNING' },
        lastIntentActivityAt: null,
        activity: { inProgress: 1, attention: 0 },
      },
    ];
    mockIntentCtx.value = { detail: null, loading: false, notFound: true, errorStatus: 404 };
    renderSidebar('/space/p1/intent/int-gone/observability');
    expect(screen.queryByText('Deleted meanwhile')).toBeNull();
    expect(screen.queryByRole('navigation', { name: /intent sections/i })).toBeNull();
  });
});

describe('AppSidebar Space-level attention removal', () => {
  it('does not show stale legacy agent activity as active in the sidebar', () => {
    mockProjects.projects = [
      {
        project: { id: 'legacy', name: 'Legacy Space', kind: 'v1', createdAt: '2024-01-01' },
        latestSprint: {
          id: 's1',
          name: 'Old iteration',
          phase: 'INCEPTION',
          currentAgentStatus: 'running',
        },
        latestIntent: null,
        lastIntentActivityAt: null,
        activity: { inProgress: 0, attention: 0 },
      },
    ];

    renderSidebar();

    expect(screen.getByRole('link', { name: /legacy space/i })).toBeInTheDocument();
    expect(screen.queryByTitle('Legacy Space — Agent running')).not.toBeInTheDocument();
    expect(screen.queryByText('Old iteration')).not.toBeInTheDocument();
  });

  it('does not show MessageCircleQuestion icon on Space row for waiting v2 project', () => {
    mockProjects.projects = [
      {
        project: { id: 'p1', name: 'Waiting Space', kind: 'v2', createdAt: '2024-01-01' },
        latestSprint: null,
        latestIntent: { id: 'int-1', title: 'Waiting Intent', status: 'WAITING' },
        lastIntentActivityAt: null,
        activity: { inProgress: 1, attention: 1 },
      },
    ];
    renderSidebar();
    const spaceBtn = screen.getByTitle('Waiting Space');
    expect(spaceBtn).toBeInTheDocument();
    expect(spaceBtn.querySelector('.lucide-message-circle-question-mark')).toBeNull();
  });

  it('still shows the waiting status on Intent rows', () => {
    localStorage.setItem('aidlc-sidebar-iterations-filter', 'active');
    mockProjects.projects = [
      {
        project: { id: 'p1', name: 'Waiting Space', kind: 'v2', createdAt: '2024-01-01' },
        latestSprint: null,
        latestIntent: { id: 'int-1', title: 'Waiting Intent', status: 'WAITING' },
        lastIntentActivityAt: null,
        activity: { inProgress: 1, attention: 1 },
      },
    ];
    renderSidebar();
    const spaceBtn = screen.getByTitle('Waiting Space');
    expect(spaceBtn.querySelector('.lucide-message-circle-question-mark')).toBeNull();
    const row = screen.getByRole('link', { name: /waiting intent/i });
    expect(within(row).getByText(/waiting for input/i)).toBeInTheDocument();
  });
});

describe('AppSidebar status truth', () => {
  const FOUR_MONTHS_AGO = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000).toISOString();

  function setupStalled() {
    localStorage.setItem('aidlc-sidebar-iterations-filter', 'active');
    const intent = {
      id: 'int-stalled',
      title: 'Add a low-stock warning badge',
      status: 'RUNNING',
      updatedAt: FOUR_MONTHS_AGO,
    };
    mockProjects.projects = [
      {
        project: { id: 'p1', name: 'retail-v2', kind: 'v2', createdAt: '2024-01-01' },
        latestSprint: null,
        latestIntent: intent,
        intents: [intent],
        lastIntentActivityAt: FOUR_MONTHS_AGO,
        activity: { inProgress: 1, attention: 0 },
      },
    ];
  }

  it('shows a stalled pill instead of a spinner for a RUNNING intent with no activity for months', () => {
    setupStalled();
    renderSidebar();
    const row = screen.getByRole('link', { name: /low-stock warning/i });
    const pill = within(row)
      .getByText(/no activity for 4 months/i)
      .closest('[data-tone]');
    expect(pill).toHaveAttribute('data-tone', 'warning');
    expect(pill).toHaveAttribute('data-stalled', 'true');
    expect(row.querySelector('.animate-spin')).toBeNull();
    expect(row.querySelector('[data-pulse]')).toBeNull();
    expect(within(row).queryByText(/^running$/i)).not.toBeInTheDocument();
  });

  it('does not mark the space row as running when its only run is stalled', () => {
    setupStalled();
    renderSidebar();
    expect(screen.queryByTitle('retail-v2 — Agent running')).not.toBeInTheDocument();
    expect(screen.getByTitle('retail-v2')).toBeInTheDocument();
    expect(document.querySelector('.animate-spin')).toBeNull();
  });

  it('keeps a genuinely live run as Running with its pulse', () => {
    localStorage.setItem('aidlc-sidebar-iterations-filter', 'active');
    const intent = {
      id: 'int-live',
      title: 'Live run',
      status: 'RUNNING',
      updatedAt: new Date().toISOString(),
    };
    mockProjects.projects = [
      {
        project: { id: 'p1', name: 'Live Space', kind: 'v2', createdAt: '2024-01-01' },
        latestSprint: null,
        latestIntent: intent,
        intents: [intent],
        lastIntentActivityAt: intent.updatedAt,
        activity: { inProgress: 1, attention: 0 },
      },
    ];
    renderSidebar();
    const row = screen.getByRole('link', { name: /live run/i });
    expect(within(row).getByText('Running')).toBeInTheDocument();
    expect(row.querySelector('[data-pulse]')).not.toBeNull();
    expect(screen.getByTitle('Live Space — Agent running')).toBeInTheDocument();
  });
});

describe('AppSidebar intent entry and prefetch', () => {
  function setupRows() {
    localStorage.setItem('aidlc-sidebar-iterations-filter', 'active');
    const intents = [
      {
        id: 'int-q',
        title: 'Question pending',
        status: 'WAITING',
        pendingHumanTaskId: 'task-1',
        updatedAt: '2026-11-20T00:00:00.000Z',
      },
      {
        id: 'int-r',
        title: 'Running fine',
        status: 'RUNNING',
        updatedAt: new Date().toISOString(),
      },
    ];
    mockProjects.projects = [
      {
        project: { id: 'p1', name: 'Space', kind: 'v2', createdAt: '2024-01-01' },
        latestSprint: null,
        latestIntent: intents[1],
        intents,
        lastIntentActivityAt: null,
        activity: { inProgress: 2, attention: 1 },
      },
    ];
  }

  it('opens Work when a human action waits and Overview otherwise', () => {
    setupRows();
    renderSidebar();
    fireEvent.click(screen.getByRole('link', { name: /question pending/i }));
    expect(screen.getByTestId('current-path')).toHaveTextContent('/space/p1/intent/int-q');
    fireEvent.click(screen.getByRole('link', { name: /running fine/i }));
    expect(screen.getByTestId('current-path')).toHaveTextContent(
      '/space/p1/intent/int-r/observability',
    );
  });

  // P1-7 (a11y audit): the Overview / Work / Graph targets were 22.5 px tall
  // with a 1 px gap, failing WCAG 2.5.8 without the spacing exemption.
  it('gives every intent section target at least 24 px of height', () => {
    setupRows();
    renderSidebar('/space/p1/intent/int-r');
    const nav = screen.getByRole('navigation', { name: 'Intent sections' });
    const targets = within(nav).getAllByRole('link');
    expect(targets.map((b) => b.textContent)).toEqual(['Overview', 'Work', 'Graph']);
    for (const target of targets) {
      expect(target).toHaveClass('min-h-6', 'py-1', 'text-2xs');
      expect(target.className).not.toMatch(/py-\[3px\]|text-\[11px\]/);
    }
    expect(within(nav).getByRole('link', { name: 'Work' })).toHaveAttribute('aria-current', 'page');
  });

  it('warms the intent page through the delegated listener after a 200 ms hover', () => {
    vi.useFakeTimers();
    setupRows();
    renderSidebar();
    const uninstall = installNavIntent(() => ({
      user: { isPlatformAdmin: false },
      currentHref: '/dashboard',
    }));
    try {
      const row = screen.getByRole('link', { name: /question pending/i });
      expect(row).toHaveAttribute('href', '/space/p1/intent/int-q');
      fireEvent.pointerOver(row);
      expect(mockPrefetchHref).not.toHaveBeenCalled();
      act(() => {
        vi.advanceTimersByTime(220);
      });
      expect(mockPrefetchHref).toHaveBeenCalledExactlyOnceWith(
        '/space/p1/intent/int-q',
        expect.objectContaining({ trigger: 'hover' }),
      );
      act(() => {
        vi.advanceTimersByTime(500);
      });
      expect(mockPrefetchHref).toHaveBeenCalledTimes(1);
      // Rows carry no per-row speculation of their own.
      expect(
        mockCache.prefetch.mock.calls.filter(([, opts]) => opts?.priority === 'intent'),
      ).toHaveLength(0);
    } finally {
      uninstall();
    }
  });

  it('does not warm anything when the pointer leaves before the dwell', () => {
    vi.useFakeTimers();
    setupRows();
    renderSidebar();
    const uninstall = installNavIntent(() => ({
      user: { isPlatformAdmin: false },
      currentHref: '/dashboard',
    }));
    try {
      const row = screen.getByRole('link', { name: /running fine/i });
      fireEvent.pointerOver(row);
      act(() => {
        vi.advanceTimersByTime(50);
      });
      fireEvent.pointerOut(row, { relatedTarget: document.body });
      act(() => {
        vi.advanceTimersByTime(200);
      });
      expect(mockPrefetchHref).not.toHaveBeenCalled();
      expect(mockCache.prefetch).not.toHaveBeenCalled();
    } finally {
      uninstall();
    }
  });

  it('offers at most three visible waiting rows to the idle pass, never the open intent', () => {
    localStorage.setItem('aidlc-sidebar-iterations-filter', 'attention');
    const waiting = (id: string, daysAgo: number) => ({
      id,
      title: `Waiting ${id}`,
      status: 'WAITING',
      pendingHumanTaskId: `t-${id}`,
      updatedAt: new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString(),
    });
    const intents = [waiting('a', 1), waiting('b', 2), waiting('c', 3), waiting('d', 4)];
    mockProjects.projects = [
      {
        project: { id: 'p1', name: 'Space', kind: 'v2', createdAt: '2024-01-01' },
        latestSprint: null,
        latestIntent: intents[0],
        intents,
        lastIntentActivityAt: null,
        activity: { inProgress: 4, attention: 4 },
      },
    ];
    const view = renderSidebar('/space/p1/intent/a');
    expect(idleCandidates('shell')).toEqual([
      '/space/p1/intent/b',
      '/space/p1/intent/c',
      '/space/p1/intent/d',
    ]);
    // The idle pass (useIdleNext) owns dispatch; the sidebar never fetches itself.
    expect(mockCache.prefetch).not.toHaveBeenCalled();
    view.unmount();
    expect(idleCandidates('shell')).toEqual([]);
  });

  it('does not offer failed or running rows (their summary status is the truth)', () => {
    localStorage.setItem('aidlc-sidebar-iterations-filter', 'attention');
    const intents = [
      { id: 'f', title: 'Broken', status: 'FAILED', updatedAt: '2026-01-01T00:00:00.000Z' },
      { id: 's', title: 'Stuck', status: 'RUNNING', updatedAt: '2026-01-01T00:00:00.000Z' },
    ];
    mockProjects.projects = [
      {
        project: { id: 'p1', name: 'Space', kind: 'v2', createdAt: '2024-01-01' },
        latestSprint: null,
        latestIntent: intents[0],
        intents,
        lastIntentActivityAt: null,
        activity: { inProgress: 2, attention: 2 },
      },
    ];
    renderSidebar();
    expect(idleCandidates('shell')).toEqual([]);
    expect(mockCache.prefetch).not.toHaveBeenCalled();
  });
});

describe('AppSidebar section tabs on Audit', () => {
  it('highlights no section tab on the Audit page', () => {
    localStorage.setItem('aidlc-sidebar-iterations-filter', 'attention');
    const intent = {
      id: 'i1',
      title: 'Audited',
      status: 'WAITING',
      pendingHumanTaskId: 't',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    mockProjects.projects = [
      {
        project: { id: 'p1', name: 'Space', kind: 'v2', createdAt: '2024-01-01' },
        latestSprint: null,
        latestIntent: intent,
        intents: [intent],
        lastIntentActivityAt: null,
        activity: { inProgress: 1, attention: 1 },
      },
    ];
    render(
      <MemoryRouter initialEntries={['/space/p1/intent/i1/audit']}>
        <Routes>
          <Route path="/space/:projectId/intent/:intentId/audit" element={<AppSidebar />} />
        </Routes>
      </MemoryRouter>,
    );
    const nav = screen.getByRole('navigation', { name: 'Intent sections' });
    for (const name of ['Overview', 'Work', 'Graph']) {
      expect(within(nav).getByRole('link', { name })).not.toHaveAttribute('aria-current');
    }
    expect(screen.getByRole('link', { name: /audited/i })).toHaveAttribute('aria-current', 'true');
  });
});

describe('AppSidebar one status truth', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();

  it('counts stalled runs in "Needs your attention", like the Spaces inbox', () => {
    localStorage.setItem('aidlc-sidebar-iterations-filter', 'attention');
    const intents = [
      { id: 'w', title: 'Waiting', status: 'WAITING', pendingHumanTaskId: 't', updatedAt: ago(2) },
      { id: 'f', title: 'Broken', status: 'FAILED', updatedAt: ago(3) },
      { id: 's', title: 'Stuck', status: 'RUNNING', updatedAt: ago(120) },
      { id: 'r', title: 'Healthy', status: 'RUNNING', updatedAt: new Date().toISOString() },
    ];
    mockProjects.projects = [
      {
        project: { id: 'p1', name: 'Space', kind: 'v2', createdAt: '2024-01-01' },
        latestSprint: null,
        latestIntent: intents[0],
        intents,
        lastIntentActivityAt: null,
        activity: { inProgress: 4, attention: 2 },
      },
    ];
    renderSidebar();
    expect(screen.getByLabelText(/intent activity filter/i)).toHaveTextContent(
      'Showing: Needs your attention · 3',
    );
    expect(screen.getByRole('link', { name: /stuck/i })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /healthy/i })).toBeNull();
    // The space badge uses the same rule.
    expect(screen.getByLabelText('Space, 3 need attention')).toBeInTheDocument();
  });

  it('uses the compact, untruncated pill: "Waiting · 108 d" and "Stalled · 4 mo"', () => {
    localStorage.setItem('aidlc-sidebar-iterations-filter', 'attention');
    const intents = [
      {
        id: 'w',
        title: 'Waiting',
        status: 'WAITING',
        pendingHumanTaskId: 't',
        updatedAt: ago(108),
      },
      { id: 's', title: 'Stuck', status: 'RUNNING', updatedAt: ago(123) },
    ];
    // The waiting age is the oldest open gate, which only the cached detail knows.
    const waitingSnapshot = {
      data: {
        intent: intents[0],
        gates: [{ humanTaskId: 't', status: 'pending', createdAt: ago(108) }],
        stages: [],
        events: [],
      },
    };
    mockCache.peek.mockImplementation(((key: unknown) =>
      Array.isArray(key) && key[2] === 'w' ? waitingSnapshot : undefined) as () => unknown);
    mockProjects.projects = [
      {
        project: { id: 'p1', name: 'Space', kind: 'v2', createdAt: '2024-01-01' },
        latestSprint: null,
        latestIntent: intents[0],
        intents,
        lastIntentActivityAt: null,
        activity: { inProgress: 2, attention: 2 },
      },
    ];
    renderSidebar();
    const waiting = screen.getByText('Waiting · 108 d');
    mockCache.peek.mockImplementation(() => undefined);
    expect(waiting.className).not.toContain('truncate');
    expect(waiting.closest('[data-tone]')?.className).not.toMatch(/max-w-\[/);
    expect(screen.getByText('Stalled · 4 mo')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /stuck.*stalled · no activity for 4 months/i }),
    ).toBeInTheDocument();
  });

  it('R3-5: shows no age for a waiting intent until its detail is cached (never a guess from updatedAt)', () => {
    localStorage.setItem('aidlc-sidebar-iterations-filter', 'attention');
    const intent = {
      id: 'i3',
      title: 'Router',
      status: 'WAITING',
      pendingHumanTaskId: 'feas',
      updatedAt: ago(109),
    };
    mockProjects.projects = [
      {
        project: { id: 'p1', name: 'Space', kind: 'v2', createdAt: '2024-01-01' },
        latestSprint: null,
        latestIntent: intent,
        intents: [intent],
        lastIntentActivityAt: null,
        activity: { inProgress: 1, attention: 1 },
      },
    ];
    renderSidebar();
    expect(screen.getByText('Waiting')).toBeInTheDocument();
    expect(screen.queryByText(/Waiting · \d+ d/)).toBeNull();
  });

  it('shows the oldest open gate once the intent detail is cached (same age as the header)', () => {
    localStorage.setItem('aidlc-sidebar-iterations-filter', 'attention');
    const intent = {
      id: 'i3',
      title: 'Router',
      status: 'WAITING',
      pendingHumanTaskId: 'feas',
      updatedAt: ago(109),
    };
    const snapshot = {
      data: {
        intent,
        gates: [
          { humanTaskId: 'scope', status: 'pending', createdAt: ago(137) },
          { humanTaskId: 'feas', status: 'pending', createdAt: ago(109) },
        ],
        stages: [],
        events: [],
      },
    };
    mockCache.peek.mockImplementation(() => snapshot);
    mockProjects.projects = [
      {
        project: { id: 'p1', name: 'Space', kind: 'v2', createdAt: '2024-01-01' },
        latestSprint: null,
        latestIntent: intent,
        intents: [intent],
        lastIntentActivityAt: null,
        activity: { inProgress: 1, attention: 1 },
      },
    ];
    renderSidebar();
    expect(screen.getByText('Waiting · 137 d')).toBeInTheDocument();
    // Peeked through a non-retaining watch: the sidebar must not keep the detail alive.
    expect(cacheSubscribe).toHaveBeenCalledWith(expect.any(Function));
    expect(
      queryClient
        .getQueryCache()
        .find({ queryKey: ['intent', 'p1', 'i3', 'detail'] })
        ?.getObserversCount() ?? 0,
    ).toBe(0);
    mockCache.peek.mockImplementation(() => undefined);
  });
});

describe('AppSidebar authoring group', () => {
  it('labels the admin group in sentence case without uppercase tracking', () => {
    mockAuth.isPlatformAdmin = true;
    renderSidebar();
    const label = screen.getByText('Authoring');
    expect(label.className).toContain('text-2xs');
    expect(label.className).toContain('font-medium');
    expect(label.className).not.toMatch(/uppercase|tracking-/);
  });

  it('renders every navigation item as a real link (middle-click, open in new tab)', () => {
    mockAuth.isPlatformAdmin = true;
    mockProjects.projects = [
      {
        project: { id: 'p1', name: 'Retail', kind: 'v2', createdAt: '2024-01-01' },
        latestSprint: null,
        latestIntent: null,
        intents: [],
        lastIntentActivityAt: null,
        activity: { inProgress: 0, attention: 0 },
      },
    ];
    renderSidebar('/space/p1');
    expect(screen.getByRole('link', { name: 'Spaces' })).toHaveAttribute('href', '/dashboard');
    expect(screen.getByRole('link', { name: 'Retail' })).toHaveAttribute('href', '/space/p1');
    expect(screen.getByRole('link', { name: 'Workflows' })).toHaveAttribute('href', '/workflows');
    expect(screen.getByRole('link', { name: 'Block Library' })).toHaveAttribute(
      'href',
      '/blocks/stage',
    );
    expect(screen.getByRole('link', { name: 'Admin & Settings' })).toHaveAttribute(
      'href',
      '/admin',
    );
    // Menus and dialogs stay buttons.
    expect(screen.getByRole('button', { name: 'Sort spaces' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New space' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Filter intents' })).toBeInTheDocument();
  });

  it('navigates from a sidebar link and records the chosen intent section', () => {
    localStorage.setItem('aidlc-sidebar-iterations-filter', 'active');
    const intent = {
      id: 'i1',
      title: 'Cart',
      status: 'RUNNING',
      updatedAt: new Date().toISOString(),
    };
    mockProjects.projects = [
      {
        project: { id: 'p1', name: 'Retail', kind: 'v2', createdAt: '2024-01-01' },
        latestSprint: null,
        latestIntent: intent,
        intents: [intent],
        lastIntentActivityAt: null,
        activity: { inProgress: 1, attention: 0 },
      },
    ];
    renderSidebar('/space/p1/intent/i1');
    const nav = screen.getByRole('navigation', { name: 'Intent sections' });
    const graph = within(nav).getByRole('link', { name: 'Graph' });
    expect(graph).toHaveAttribute('href', '/space/p1/intent/i1/graph');
    fireEvent.click(graph);
    expect(screen.getByTestId('current-path')).toHaveTextContent('/space/p1/intent/i1/graph');
    fireEvent.click(screen.getByRole('link', { name: 'Spaces' }));
    expect(screen.getByTestId('current-path')).toHaveTextContent('/dashboard');
  });
});
