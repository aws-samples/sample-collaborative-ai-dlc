import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, within } from '@/test/query';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router';

const mockAuth = vi.hoisted(() => ({
  isPlatformAdmin: false,
  user: null as { userId: string } | null,
}));

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
  projectLastActivityAt: (entry: { lastIntentActivityAt?: string | null }) =>
    entry.lastIntentActivityAt ?? null,
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

import { AppSidebar, INTENTS_PAGE_SIZE, type AppSidebarProps } from './AppSidebar';
import { resetSidebarSpacesCache } from '@/hooks/useSidebarSpaces';
import { installNavIntent } from '@/lib/navIntent';
import { queryClient } from '@/lib/queryClient';
let cacheSubscribe: ReturnType<typeof vi.spyOn>;
import { idleCandidates } from '@/lib/idleCandidates';

function CurrentPath() {
  const { pathname } = useLocation();
  return <span data-testid="current-path">{pathname}</span>;
}

function renderSidebar(path = '/dashboard', props: Partial<AppSidebarProps> = {}) {
  const sidebar = <AppSidebar {...props} />;
  return render(
    <MemoryRouter initialEntries={[path]}>
      <CurrentPath />
      <Routes>
        <Route path="/dashboard" element={sidebar} />
        <Route path="/spaces" element={sidebar} />
        <Route path="/space/:projectId" element={sidebar} />
        <Route path="/space/:projectId/intent/:intentId" element={sidebar} />
        <Route path="/space/:projectId/intent/:intentId/observability" element={sidebar} />
        <Route path="/space/:projectId/intent/:intentId/graph" element={sidebar} />
        <Route path="*" element={sidebar} />
      </Routes>
    </MemoryRouter>,
  );
}

const expandSpace = (name: string) =>
  fireEvent.click(screen.getByRole('button', { name: `Expand ${name}` }));

interface IntentFixture {
  id: string;
  title: string;
  status: string;
  pendingHumanTaskId?: string;
  updatedAt?: string;
}

function v2Space(id: string, name: string, intents: IntentFixture[], extra: object = {}) {
  return {
    project: { id, name, kind: 'v2', createdAt: '2024-01-01' },
    latestSprint: null,
    latestIntent: intents[0] ?? null,
    intents,
    lastIntentActivityAt: null,
    activity: { inProgress: intents.length, attention: 0 },
    ...extra,
  };
}

const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();

beforeEach(() => {
  vi.spyOn(queryClient, 'getQueryData').mockImplementation(
    (key) => (mockCache.peek(key) as { data?: unknown } | undefined)?.data,
  );
  cacheSubscribe = vi.spyOn(queryClient.getQueryCache(), 'subscribe');
  mockProjects.projects = [];
  mockIntentCtx.value = null;
  mockCachedSummary.mockReset().mockReturnValue(undefined);
  mockAuth.isPlatformAdmin = false;
  mockAuth.user = null;
  resetSidebarSpacesCache();
  mockCache.prefetch.mockReset();
  mockPrefetchHref.mockReset();
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('AppSidebar primary navigation', () => {
  it('starts with "My work" as a real link marked current; the sidebar itself is the list of spaces', () => {
    mockProjects.projects = [v2Space('p1', 'Alpha', [])];
    renderSidebar('/dashboard');
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    const myWork = within(nav).getByRole('link', { name: 'My work' });
    expect(myWork).toHaveAttribute('href', '/dashboard');
    expect(myWork).toHaveAttribute('aria-current', 'page');
    // No link to a Spaces page and no "All spaces" header on large screens.
    expect(screen.queryByRole('link', { name: 'Spaces' })).toBeNull();
    expect(screen.queryByText('All spaces')).toBeNull();
    expect(screen.getAllByText('Spaces')).toHaveLength(1);
  });

  it('gives My work, Pinned and Spaces one row style: icon, label, same size and padding', () => {
    mockAuth.user = { userId: 'user-a' };
    mockProjects.projects = [v2Space('p1', 'Alpha', []), v2Space('p2', 'Beta', [])];
    renderSidebar('/space/p1');
    fireEvent.click(screen.getByRole('button', { name: 'Pin Beta' }));
    const myWork = screen.getByRole('link', { name: 'My work' });
    const spaces = screen.getByRole('button', { name: /^Spaces/ });
    const pinned = screen.getByRole('button', { name: /^Pinned/ });
    for (const row of [myWork, spaces, pinned]) {
      expect(row.querySelector('svg')).not.toBeNull();
      for (const cls of ['text-[13px]', 'font-medium', 'px-3', 'py-2', 'gap-2.5'])
        expect(row.className).toContain(cls);
    }
  });

  it('toggles the list of spaces from the Spaces row without navigating', () => {
    mockProjects.projects = [v2Space('p1', 'Alpha', [])];
    renderSidebar('/space/p1');
    const toggle = screen.getByRole('button', { name: /^Spaces/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('link', { name: 'Alpha' })).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('link', { name: 'Alpha' })).toBeNull();
    expect(screen.getByTestId('current-path')).toHaveTextContent('/space/p1');
    fireEvent.click(toggle);
    expect(screen.getByRole('link', { name: 'Alpha' })).toBeInTheDocument();
  });

  it('shows no count on the Spaces row, open or collapsed', () => {
    mockProjects.projects = [v2Space('p1', 'Alpha', []), v2Space('p2', 'Beta', [])];
    renderSidebar();
    const toggle = screen.getByRole('button', { name: /^Spaces/ });
    expect(toggle).toHaveTextContent(/^Spaces$/);
    fireEvent.click(toggle);
    expect(toggle).toHaveTextContent(/^Spaces$/);
  });

  it('uses the compact pill size for intent rows', () => {
    mockProjects.projects = [
      v2Space('p1', 'Alpha', [{ id: 'i1', title: 'Ship it', status: 'RUNNING' }]),
    ];
    renderSidebar('/space/p1');
    const pill = screen.getByRole('link', { name: /^Ship it/ }).querySelector('[data-tone]');
    expect(pill).toHaveClass('px-1.5', 'py-0', 'text-2xs');
  });

  it("folds the current space from its title instead of reloading its page; another space's title still navigates", () => {
    mockProjects.projects = [
      v2Space('p1', 'Alpha', [{ id: 'i1', title: 'Ship it', status: 'RUNNING' }]),
      v2Space('p2', 'Beta', []),
    ];
    renderSidebar('/space/p1');
    expect(screen.getByRole('button', { name: 'Collapse Alpha' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^Ship it/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('link', { name: /^Alpha/ }));
    expect(screen.getByTestId('current-path')).toHaveTextContent('/space/p1');
    expect(screen.getByRole('button', { name: 'Expand Alpha' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^Ship it/ })).toBeNull();

    fireEvent.click(screen.getByRole('link', { name: /^Alpha/ }));
    expect(screen.getByRole('button', { name: 'Collapse Alpha' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^Ship it/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('link', { name: 'Beta' }));
    expect(screen.getByTestId('current-path')).toHaveTextContent('/space/p2');
  });

  it('navigates from the title of the space whose intent is open: only the space page itself folds', () => {
    mockProjects.projects = [
      v2Space('p1', 'Alpha', [{ id: 'i1', title: 'Ship it', status: 'RUNNING' }]),
    ];
    renderSidebar('/space/p1/intent/i1');
    fireEvent.click(screen.getByRole('link', { name: /^Alpha/ }));
    expect(screen.getByTestId('current-path')).toHaveTextContent(/^\/space\/p1$/);
  });

  it('keeps the sort control and a larger, bolder New space button at the end of the Spaces row, both focusable', () => {
    renderSidebar();
    const toggle = screen.getByRole('button', { name: /^Spaces/ });
    const row = toggle.parentElement!;
    const sort = within(row).getByRole('button', { name: 'Sort spaces' });
    const create = within(row).getByRole('button', { name: 'New space' });
    expect(sort.className).toContain('h-6');
    expect(create.className).toContain('h-7');
    expect(create.className).toContain('w-7');
    expect(create.querySelector('svg')).toHaveAttribute('stroke-width', '2.5');
    expect(create.compareDocumentPosition(sort) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    // The chevron follows the word, inside the toggle, not at the row's end.
    const label = within(toggle).getByText('Spaces');
    expect(label.nextElementSibling?.tagName.toLowerCase()).toBe('svg');
    // Hover-revealed on fine pointers, but part of the tab order regardless.
    for (const action of [sort, create]) {
      action.focus();
      expect(action).toHaveFocus();
    }
  });

  it('has no attention filter or count any more: that is My work', () => {
    mockProjects.projects = [
      v2Space('p1', 'Space', [
        {
          id: 'w',
          title: 'Waiting',
          status: 'WAITING',
          pendingHumanTaskId: 't',
        },
        { id: 'f', title: 'Broken', status: 'FAILED' },
      ]),
    ];
    renderSidebar();
    expect(screen.queryByLabelText(/intent activity filter/i)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Filter intents' })).toBeNull();
    expect(screen.queryByText(/needs your attention/i)).toBeNull();
    expect(screen.queryByText(/need attention/)).toBeNull();
  });
});

describe('AppSidebar pinned and all spaces', () => {
  const three = () => [
    v2Space('p1', 'Alpha', []),
    v2Space('p2', 'Beta', []),
    v2Space('p3', 'Gamma', []),
  ];

  it('lists every space under "Spaces" with no Pinned row until one is pinned', () => {
    mockProjects.projects = three();
    renderSidebar();
    expect(screen.queryByRole('region', { name: 'Pinned' })).toBeNull();
    expect(screen.queryByText('Pinned')).toBeNull();
    const spaces = screen.getByRole('region', { name: 'Spaces' });
    expect(
      within(spaces)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(['Alpha', 'Beta', 'Gamma']);
  });

  it('pins and unpins from the space row and persists the choice per user', () => {
    mockAuth.user = { userId: 'user-a' };
    mockProjects.projects = three();
    const first = renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: 'Pin Beta' }));

    const pinned = screen.getByRole('region', { name: 'Pinned' });
    expect(within(pinned).getByRole('link', { name: 'Beta' })).toBeInTheDocument();
    expect(within(pinned).getByRole('button', { name: 'Unpin Beta' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    const rest = screen.getByRole('region', { name: 'Spaces' });
    expect(screen.queryByText('All spaces')).toBeNull();
    expect(within(rest).queryByRole('link', { name: 'Beta' })).toBeNull();
    expect(
      within(rest)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(['Alpha', 'Gamma']);

    // The same user sees the pin again on a fresh mount…
    first.unmount();
    resetSidebarSpacesCache();
    const second = renderSidebar();
    expect(
      within(screen.getByRole('region', { name: 'Pinned' })).getByRole('link', {
        name: 'Beta',
      }),
    ).toBeInTheDocument();

    // …another user on the same browser does not.
    second.unmount();
    mockAuth.user = { userId: 'user-b' };
    renderSidebar();
    expect(screen.queryByRole('region', { name: 'Pinned' })).toBeNull();

    // Unpinning puts the space back with the others.
    fireEvent.click(screen.getByRole('button', { name: 'Pin Alpha' }));
    expect(
      within(screen.getByRole('region', { name: 'Pinned' }))
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(['Alpha']);
    fireEvent.click(screen.getByRole('button', { name: 'Unpin Alpha' }));
    expect(screen.queryByRole('region', { name: 'Pinned' })).toBeNull();
    expect(screen.queryByText('Pinned')).toBeNull();
    expect(screen.getByRole('button', { name: 'Pin Alpha' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('puts the chevron after the pin button on a space row: name, pin, then expand', () => {
    mockProjects.projects = [v2Space('p1', 'Alpha', [])];
    renderSidebar();
    const name = screen.getByRole('link', { name: 'Alpha' });
    const pin = screen.getByRole('button', { name: 'Pin Alpha' });
    const chevron = screen.getByRole('button', { name: 'Expand Alpha' });
    expect(name.compareDocumentPosition(pin) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(pin.compareDocumentPosition(chevron) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('collapses the "Pinned" section from its row and remembers it per user', () => {
    mockAuth.user = { userId: 'user-a' };
    mockProjects.projects = three();
    const view = renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: 'Pin Beta' }));
    const toggle = screen.getByRole('button', { name: /^Pinned/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const pinned = screen.getByRole('region', { name: /^Pinned/ });
    expect(within(pinned).getByRole('link', { name: 'Beta' })).toBeInTheDocument();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveTextContent(/^Pinned$/);
    expect(within(pinned).queryByRole('link', { name: 'Beta' })).toBeNull();
    // The other section is untouched.
    expect(screen.getByRole('button', { name: /^Spaces/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(screen.getByRole('link', { name: 'Alpha' })).toBeInTheDocument();

    view.unmount();
    resetSidebarSpacesCache();
    const again = renderSidebar();
    expect(screen.getByRole('button', { name: /^Pinned/ })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(screen.queryByRole('link', { name: 'Beta' })).toBeNull();

    again.unmount();
    mockAuth.user = { userId: 'user-b' };
    renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: 'Pin Beta' }));
    expect(screen.getByRole('button', { name: /^Pinned/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(screen.getByRole('link', { name: 'Beta' })).toBeInTheDocument();
  });

  it('collapses the "Spaces" section, remembers it, and keeps the pinned ones in view', () => {
    mockAuth.user = { userId: 'user-a' };
    mockProjects.projects = three();
    const view = renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: 'Pin Gamma' }));
    const toggle = screen.getByRole('button', { name: /^Spaces/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveTextContent(/^Spaces$/);
    expect(screen.queryByRole('link', { name: 'Alpha' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Beta' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Gamma' })).toBeInTheDocument();

    view.unmount();
    resetSidebarSpacesCache();
    renderSidebar();
    expect(screen.getByRole('button', { name: /^Spaces/ })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(screen.queryByRole('link', { name: 'Alpha' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Gamma' })).toBeInTheDocument();
  });

  it('shows the relative last activity under a space with work, and the counts in a tooltip', async () => {
    mockProjects.projects = [
      v2Space(
        'p1',
        'Retail',
        [
          {
            id: 'w',
            title: 'Waiting',
            status: 'WAITING',
            pendingHumanTaskId: 't',
          },
          {
            id: 'r',
            title: 'Running',
            status: 'RUNNING',
            updatedAt: new Date().toISOString(),
          },
          { id: 's', title: 'Stuck', status: 'RUNNING', updatedAt: ago(120) },
          { id: 'f', title: 'Broken', status: 'FAILED' },
        ],
        { lastIntentActivityAt: ago(3) },
      ),
      v2Space('p2', 'Empty', []),
    ];
    renderSidebar();
    const retail = screen.getByRole('link', { name: /^Retail/ });
    expect(retail).toHaveTextContent('3d ago');
    expect(screen.getByRole('link', { name: 'Empty' })).not.toHaveTextContent(/ago/);
    fireEvent.pointerMove(retail);
    fireEvent.focus(retail);
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip).toHaveTextContent('1 question · 1 failed · 1 stalled · 1 running');
    expect(tooltip).toHaveTextContent('Last activity 3d ago');
  });

  it('opens the space page from the name and the sort menu stays a button', () => {
    mockProjects.projects = three();
    renderSidebar();
    fireEvent.click(screen.getByRole('link', { name: 'Beta' }));
    expect(screen.getByTestId('current-path')).toHaveTextContent('/space/p2');
    expect(screen.getByRole('button', { name: 'Sort spaces' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New space' })).toBeInTheDocument();
  });
});

describe('AppSidebar expanded space', () => {
  const intents = (n: number, status = 'RUNNING') =>
    Array.from({ length: n }, (_, index) => ({
      id: `int-${index + 1}`,
      title: `Intent ${index + 1}`,
      status,
      updatedAt: ago(index + 1),
    }));

  it('lists only active intents, by last activity, and leaves finished ones to the space page', () => {
    mockProjects.projects = [
      v2Space('p1', 'Space', [
        {
          id: 'done',
          title: 'Shipped',
          status: 'SUCCEEDED',
          updatedAt: ago(0.1),
        },
        {
          id: 'old',
          title: 'Oldest waiting',
          status: 'WAITING',
          updatedAt: ago(10),
        },
        {
          id: 'broken',
          title: 'Broken',
          status: 'FAILED',
          updatedAt: ago(0.2),
        },
        {
          id: 'cancel',
          title: 'Dropped',
          status: 'CANCELLED',
          updatedAt: ago(0.3),
        },
        {
          id: 'new',
          title: 'Newest running',
          status: 'RUNNING',
          updatedAt: ago(1),
        },
        {
          id: 'draft',
          title: 'Just created',
          status: 'CREATED',
          updatedAt: ago(4),
        },
      ]),
    ];
    renderSidebar();
    expect(screen.queryByText('Newest running')).toBeNull();
    expandSpace('Space');
    const links = screen
      .getAllByRole('link')
      .filter((link) => link.getAttribute('href')?.includes('/intent/'))
      .map((link) => link.getAttribute('href'));
    expect(links).toEqual([
      '/space/p1/intent/new/observability',
      '/space/p1/intent/draft/observability',
      '/space/p1/intent/old/observability',
    ]);
    expect(screen.queryByText('Shipped')).toBeNull();
    expect(screen.queryByText('Broken')).toBeNull();
    expect(screen.queryByText('Dropped')).toBeNull();
  });

  it('shows five intents, "Show more" adds five each time, and collapsing resets to five', () => {
    mockProjects.projects = [v2Space('p1', 'Big', intents(12))];
    renderSidebar();
    expandSpace('Big');
    for (let index = 1; index <= INTENTS_PAGE_SIZE; index++)
      expect(screen.getByText(`Intent ${index}`)).toBeInTheDocument();
    expect(screen.queryByText('Intent 6')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Show more (5)' }));
    expect(screen.getByText('Intent 10')).toBeInTheDocument();
    expect(screen.queryByText('Intent 11')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show more (2)' }));
    expect(screen.getByText('Intent 12')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /show more/i })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Collapse Big' }));
    expect(screen.queryByText('Intent 1')).toBeNull();
    expandSpace('Big');
    expect(screen.getByText('Intent 5')).toBeInTheDocument();
    expect(screen.queryByText('Intent 6')).toBeNull();
    expect(screen.getByRole('button', { name: 'Show more (5)' })).toBeInTheDocument();
  });

  it('expands the space of the current route by itself', () => {
    mockProjects.projects = [
      v2Space('p1', 'Space', intents(2)),
      v2Space('p2', 'Other', intents(1)),
    ];
    renderSidebar('/space/p1');
    expect(screen.getByRole('button', { name: 'Collapse Space' })).toBeInTheDocument();
    expect(screen.getByText('Intent 1')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Expand Other' })).toBeInTheDocument();
  });

  it('says so when a space has no active intents', () => {
    mockProjects.projects = [
      v2Space('p1', 'Quiet', [{ id: 'done', title: 'Shipped', status: 'SUCCEEDED' }]),
    ];
    renderSidebar();
    expandSpace('Quiet');
    expect(screen.getByText('No active intents')).toBeInTheDocument();
  });

  it('shows a live dot on the space when an agent is running, not for a stalled or waiting run', () => {
    mockProjects.projects = [
      v2Space('p1', 'Live Space', [
        {
          id: 'int-live',
          title: 'Live run',
          status: 'RUNNING',
          updatedAt: new Date().toISOString(),
        },
      ]),
      v2Space('p2', 'Stalled Space', [
        {
          id: 'int-stalled',
          title: 'Stuck',
          status: 'RUNNING',
          updatedAt: ago(120),
        },
      ]),
      v2Space('p3', 'Waiting Space', [{ id: 'int-w', title: 'Waiting Intent', status: 'WAITING' }]),
    ];
    renderSidebar();
    expect(screen.getByRole('link', { name: /^Live Space.*Agent running$/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Stalled Space' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Waiting Space' })).toBeInTheDocument();
    expect(screen.getAllByRole('img', { name: 'Agent running' })).toHaveLength(1);
    expect(document.querySelector('.animate-spin')).toBeNull();
  });

  it('does not show stale legacy agent activity as active in the sidebar', () => {
    mockProjects.projects = [
      {
        project: {
          id: 'legacy',
          name: 'Legacy Space',
          kind: 'v1',
          createdAt: '2024-01-01',
        },
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
    expect(screen.getByRole('link', { name: 'Legacy Space' })).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'Agent running' })).toBeNull();
    expect(screen.queryByText('Old iteration')).toBeNull();
  });

  it('counts a run as running, not stalled, when its cached activity is recent', async () => {
    const minutesAgo = (n: number) => new Date(Date.now() - n * 60 * 1000).toISOString();
    // The list row is 45 min old, but the cached detail saw a stage start 2 min ago.
    const busy = { id: 'busy', title: 'Busy run', status: 'RUNNING', updatedAt: minutesAgo(45) };
    const snapshot = {
      data: {
        intent: busy,
        gates: [],
        stages: [{ stageId: 's1', state: 'RUNNING', startedAt: minutesAgo(2) }],
        events: [{ timestamp: minutesAgo(2) }],
      },
    };
    mockCache.peek.mockImplementation((key?: unknown) =>
      (key as readonly unknown[])[2] === 'busy' ? snapshot : undefined,
    );
    mockProjects.projects = [v2Space('p1', 'Busy Space', [busy])];
    renderSidebar();
    const row = screen.getByRole('link', { name: /^Busy Space.*Agent running$/ });
    fireEvent.pointerMove(row);
    fireEvent.focus(row);
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip).toHaveTextContent('1 running');
    expect(tooltip).not.toHaveTextContent('stalled');
    mockCache.peek.mockImplementation(() => undefined);
  });

  it('says the feed could not load instead of claiming there are no spaces', () => {
    mockProjects.projects = [
      {
        project: {
          id: 'p1',
          name: 'Space',
          kind: 'v2',
          createdAt: '2024-01-01',
        },
        activityError: true,
        lastIntentActivityAt: null,
        activity: { inProgress: 0, attention: 0 },
      },
    ];
    renderSidebar();
    expect(screen.getByText(/Couldn.t load intents/)).toBeInTheDocument();
    expect(screen.queryByText('No spaces yet')).toBeNull();
    screen.getByRole('button', { name: 'Retry' }).click();
    expect(mockProjects.refresh).toHaveBeenCalled();
  });
});

describe('AppSidebar drawer (narrow screens)', () => {
  it('shows My work, Spaces and the intents that need the reader or are active, but no space list', () => {
    mockProjects.projects = [
      v2Space('p1', 'Retail', [
        {
          id: 'r',
          title: 'Running fine',
          status: 'RUNNING',
          updatedAt: new Date().toISOString(),
        },
        {
          id: 'done',
          title: 'Shipped',
          status: 'SUCCEEDED',
          updatedAt: new Date().toISOString(),
        },
      ]),
      v2Space('p2', 'Platform', [
        {
          id: 'q',
          title: 'Question pending',
          status: 'WAITING',
          pendingHumanTaskId: 't',
          updatedAt: ago(5),
        },
      ]),
    ];
    renderSidebar('/dashboard', { variant: 'drawer' });
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    expect(within(nav).getByRole('link', { name: 'My work' })).toHaveAttribute(
      'href',
      '/dashboard',
    );
    expect(within(nav).getByRole('link', { name: 'Spaces' })).toHaveAttribute('href', '/spaces');
    expect(screen.queryByRole('link', { name: 'Retail' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Platform' })).toBeNull();
    expect(screen.queryByRole('region', { name: /spaces/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /expand/i })).toBeNull();
    // Needs-you first, then the rest by activity; finished work is not listed.
    const rows = screen
      .getAllByRole('link')
      .filter((link) => link.getAttribute('href')?.includes('/intent/'));
    expect(rows.map((row) => row.getAttribute('href'))).toEqual([
      '/space/p2/intent/q',
      '/space/p1/intent/r/observability',
    ]);
    expect(rows[0]).toHaveTextContent('Platform');
    expect(screen.queryByText('Shipped')).toBeNull();
  });

  it("ranks a member's question first but not a Viewer's", () => {
    const question = (id: string) => ({
      id,
      title: `Question ${id}`,
      status: 'WAITING',
      pendingHumanTaskId: 't',
      updatedAt: ago(5),
    });
    const running = { id: 'r', title: 'Running fine', status: 'RUNNING', updatedAt: ago(0) };
    const viewerSpace = (role: string) =>
      v2Space('pv', 'Audit', [question('vq')], {
        project: { id: 'pv', name: 'Audit', kind: 'v2', createdAt: '2024-01-01', userRole: role },
      });
    const intentHrefs = () =>
      screen
        .getAllByRole('link')
        .filter((link) => link.getAttribute('href')?.includes('/intent/'))
        .map((link) => link.getAttribute('href'));

    mockProjects.projects = [v2Space('p1', 'Retail', [running]), viewerSpace('viewer')];
    const { unmount } = renderSidebar('/dashboard', { variant: 'drawer' });
    // Still listed (it is active), by activity like any other row.
    expect(intentHrefs()).toEqual(['/space/p1/intent/r/observability', '/space/pv/intent/vq']);
    unmount();

    mockProjects.projects = [v2Space('p1', 'Retail', [running]), viewerSpace('member')];
    renderSidebar('/dashboard', { variant: 'drawer' });
    expect(intentHrefs()).toEqual(['/space/pv/intent/vq', '/space/p1/intent/r/observability']);
  });

  it('keeps the open intent highlighted with its section tabs in the drawer', () => {
    mockProjects.projects = [v2Space('p1', 'Retail', [])];
    mockIntentCtx.value = {
      detail: {
        intent: { id: 'int-old', title: 'Historical Intent', status: 'FAILED' },
      },
    };
    renderSidebar('/space/p1/intent/int-old/observability', {
      variant: 'drawer',
    });
    const current = screen.getByTestId('current-intent-outside-filter');
    expect(within(current).getByRole('link', { name: /historical intent/i })).toHaveAttribute(
      'aria-current',
      'true',
    );
    expect(within(current).getByRole('navigation', { name: /intent sections/i })).toBeVisible();
  });
});

describe('AppSidebar IntentSectionTabs density', () => {
  it('renders dense section tabs when intent is selected', () => {
    mockProjects.projects = [
      {
        project: {
          id: 'p1',
          name: 'Space',
          kind: 'v2',
          createdAt: '2024-01-01',
        },
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

  it('keeps a selected intent visible when it falls beyond the five visible rows', () => {
    const list = Array.from({ length: 6 }, (_, index) => ({
      id: `int-${index + 1}`,
      title: `Waiting Intent ${index + 1}`,
      status: 'WAITING',
      pendingHumanTaskId: `task-${index + 1}`,
      updatedAt: ago(index + 1),
    }));
    mockProjects.projects = [v2Space('p1', 'Overflow Space', list)];
    mockIntentCtx.value = { detail: { intent: list[5] } };
    renderSidebar('/space/p1/intent/int-6/observability');
    expect(screen.getByText('Waiting Intent 6')).toBeInTheDocument();
    expect(screen.getByText('Waiting Intent 5')).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: /intent sections/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show more (1)' })).toBeInTheDocument();
  });
});

describe('AppSidebar current intent outside the active list', () => {
  const setupHistorical = () => {
    mockProjects.projects = [
      {
        project: {
          id: 'p1',
          name: 'Space One',
          kind: 'v2',
          createdAt: '2024-01-01',
        },
        latestSprint: null,
        latestIntent: {
          id: 'int-latest',
          title: 'Latest Intent',
          status: 'RUNNING',
        },
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

  it('lists the URL-selected finished intent with its section tabs under its space', () => {
    setupHistorical();
    renderSidebar('/space/p1/intent/int-old/observability');
    const current = screen.getByTestId('current-intent-outside-filter');
    expect(current).toHaveTextContent('Historical Intent');
    const nav = within(current).getByRole('navigation', {
      name: /intent sections/i,
    });
    expect(nav).toBeInTheDocument();
    expect(screen.getByText('Latest Intent')).toBeInTheDocument();
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
    const btn = within(current).getByRole('link', {
      name: /historical intent/i,
    });
    expect(btn).toHaveAttribute('aria-current', 'true');
  });

  it('does NOT duplicate when the selected intent is already in the active list', () => {
    mockProjects.projects = [
      {
        project: {
          id: 'p1',
          name: 'Space One',
          kind: 'v2',
          createdAt: '2024-01-01',
        },
        latestSprint: null,
        latestIntent: {
          id: 'int-1',
          title: 'Active Intent',
          status: 'RUNNING',
        },
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
    expect(screen.getAllByText('Active Intent')).toHaveLength(1);
    const nav = screen.getByRole('navigation', { name: /intent sections/i });
    expect(nav).toBeInTheDocument();
  });
});

describe('AppSidebar open intent before its detail is known (R3-1, R3-2)', () => {
  const spaceOnly = () => {
    mockProjects.projects = [
      {
        project: {
          id: 'p1',
          name: 'Space One',
          kind: 'v2',
          createdAt: '2024-01-01',
        },
        latestSprint: null,
        latestIntent: {
          id: 'int-other',
          title: 'Another intent',
          status: 'RUNNING',
        },
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
    mockIntentCtx.value = {
      detail: null,
      loading: false,
      notFound: true,
      errorStatus: 404,
    };
    renderSidebar('/space/p1/intent/int-gone/observability');
    expect(screen.queryByTestId('current-intent-outside-filter')).toBeNull();
    expect(screen.queryByRole('navigation', { name: /intent sections/i })).toBeNull();
    expect(screen.queryByText(/Draft/)).toBeNull();
  });

  it('drops a stale list row for an intent the detail request rejected as gone', () => {
    mockProjects.projects = [
      {
        project: {
          id: 'p1',
          name: 'Space One',
          kind: 'v2',
          createdAt: '2024-01-01',
        },
        latestSprint: null,
        latestIntent: {
          id: 'int-gone',
          title: 'Deleted meanwhile',
          status: 'RUNNING',
        },
        lastIntentActivityAt: null,
        activity: { inProgress: 1, attention: 0 },
      },
    ];
    mockIntentCtx.value = {
      detail: null,
      loading: false,
      notFound: true,
      errorStatus: 404,
    };
    renderSidebar('/space/p1/intent/int-gone/observability');
    expect(screen.queryByText('Deleted meanwhile')).toBeNull();
    expect(screen.queryByRole('navigation', { name: /intent sections/i })).toBeNull();
  });
});

describe('AppSidebar status truth', () => {
  const FOUR_MONTHS_AGO = ago(120);

  function setupStalled() {
    const intent = {
      id: 'int-stalled',
      title: 'Add a low-stock warning badge',
      status: 'RUNNING',
      updatedAt: FOUR_MONTHS_AGO,
    };
    mockProjects.projects = [
      v2Space('p1', 'retail-v2', [intent], {
        lastIntentActivityAt: FOUR_MONTHS_AGO,
      }),
    ];
  }

  it('shows a stalled pill instead of a spinner for a RUNNING intent with no activity for months', () => {
    setupStalled();
    renderSidebar('/space/p1');
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

  it('keeps a genuinely live run as Running with its pulse', () => {
    const intent = {
      id: 'int-live',
      title: 'Live run',
      status: 'RUNNING',
      updatedAt: new Date().toISOString(),
    };
    mockProjects.projects = [
      v2Space('p1', 'Live Space', [intent], {
        lastIntentActivityAt: intent.updatedAt,
      }),
    ];
    renderSidebar('/space/p1');
    const row = screen.getByRole('link', { name: /live run/i });
    expect(within(row).getByText('Running')).toBeInTheDocument();
    expect(row.querySelector('[data-pulse]')).not.toBeNull();
    expect(screen.getByRole('img', { name: 'Agent running' })).toBeInTheDocument();
  });

  it('still shows the waiting status on Intent rows', () => {
    mockProjects.projects = [
      {
        project: {
          id: 'p1',
          name: 'Waiting Space',
          kind: 'v2',
          createdAt: '2024-01-01',
        },
        latestSprint: null,
        latestIntent: {
          id: 'int-1',
          title: 'Waiting Intent',
          status: 'WAITING',
        },
        lastIntentActivityAt: null,
        activity: { inProgress: 1, attention: 1 },
      },
    ];
    renderSidebar('/space/p1');
    const row = screen.getByRole('link', { name: /waiting intent/i });
    expect(within(row).getByText(/waiting for input/i)).toBeInTheDocument();
  });
});

describe('AppSidebar intent entry and prefetch', () => {
  function setupRows() {
    const list = [
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
    mockProjects.projects = [v2Space('p1', 'Space', list)];
  }

  it('opens Work when a human action waits and Overview otherwise', () => {
    setupRows();
    renderSidebar('/space/p1');
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
    renderSidebar('/space/p1');
    const uninstall = installNavIntent(() => ({
      user: { isPlatformAdmin: false },
      currentHref: '/space/p1',
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

  it('warms a space page the same way from its row', () => {
    vi.useFakeTimers();
    setupRows();
    renderSidebar();
    const uninstall = installNavIntent(() => ({
      user: { isPlatformAdmin: false },
      currentHref: '/dashboard',
    }));
    try {
      fireEvent.pointerOver(screen.getByRole('link', { name: /^Space(?!s)/ }));
      act(() => {
        vi.advanceTimersByTime(220);
      });
      expect(mockPrefetchHref).toHaveBeenCalledExactlyOnceWith(
        '/space/p1',
        expect.objectContaining({ trigger: 'hover' }),
      );
    } finally {
      uninstall();
    }
  });

  it('does not warm anything when the pointer leaves before the dwell', () => {
    vi.useFakeTimers();
    setupRows();
    renderSidebar('/space/p1');
    const uninstall = installNavIntent(() => ({
      user: { isPlatformAdmin: false },
      currentHref: '/space/p1',
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
    const waiting = (id: string, daysAgo: number) => ({
      id,
      title: `Waiting ${id}`,
      status: 'WAITING',
      pendingHumanTaskId: `t-${id}`,
      updatedAt: ago(daysAgo),
    });
    const list = [waiting('a', 1), waiting('b', 2), waiting('c', 3), waiting('d', 4)];
    mockProjects.projects = [v2Space('p1', 'Space', list)];
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

  it('offers nothing from a collapsed space, and never failed or running rows', () => {
    const list = [
      {
        id: 'w',
        title: 'Waiting',
        status: 'WAITING',
        pendingHumanTaskId: 't',
        updatedAt: ago(1),
      },
      { id: 'f', title: 'Broken', status: 'FAILED', updatedAt: ago(2) },
      { id: 's', title: 'Stuck', status: 'RUNNING', updatedAt: ago(3) },
    ];
    mockProjects.projects = [v2Space('p1', 'Space', list)];
    renderSidebar();
    expect(idleCandidates('shell')).toEqual([]);
    expandSpace('Space');
    expect(idleCandidates('shell')).toEqual(['/space/p1/intent/w']);
    expect(mockCache.prefetch).not.toHaveBeenCalled();
  });
});

describe('AppSidebar section tabs on Audit', () => {
  it('highlights no section tab on the Audit page', () => {
    const intent = {
      id: 'i1',
      title: 'Audited',
      status: 'WAITING',
      pendingHumanTaskId: 't',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    mockProjects.projects = [v2Space('p1', 'Space', [intent])];
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
  it('uses the compact, untruncated pill: "Waiting · 108 d" and "Stalled · 4 mo"', () => {
    const list = [
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
        intent: list[0],
        gates: [{ humanTaskId: 't', status: 'pending', createdAt: ago(108) }],
        stages: [],
        events: [],
      },
    };
    mockCache.peek.mockImplementation(((key: unknown) =>
      Array.isArray(key) && key[2] === 'w' ? waitingSnapshot : undefined) as () => unknown);
    mockProjects.projects = [v2Space('p1', 'Space', list)];
    renderSidebar('/space/p1');
    const waiting = screen.getByText('Waiting · 108 d');
    mockCache.peek.mockImplementation(() => undefined);
    expect(waiting.className).not.toContain('truncate');
    expect(waiting.closest('[data-tone]')?.className).not.toMatch(/max-w-\[/);
    expect(screen.getByText('Stalled · 4 mo')).toBeInTheDocument();
    expect(
      screen.getByRole('link', {
        name: /stuck.*stalled · no activity for 4 months/i,
      }),
    ).toBeInTheDocument();
  });

  it('R3-5: shows no age for a waiting intent until its detail is cached (never a guess from updatedAt)', () => {
    const intent = {
      id: 'i3',
      title: 'Router',
      status: 'WAITING',
      pendingHumanTaskId: 'feas',
      updatedAt: ago(109),
    };
    mockProjects.projects = [v2Space('p1', 'Space', [intent])];
    renderSidebar('/space/p1');
    expect(screen.getByText('Waiting')).toBeInTheDocument();
    expect(screen.queryByText(/Waiting · \d+ d/)).toBeNull();
  });

  it('shows the oldest open gate once the intent detail is cached (same age as the header)', () => {
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
    mockProjects.projects = [v2Space('p1', 'Space', [intent])];
    renderSidebar('/space/p1');
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
    mockProjects.projects = [v2Space('p1', 'Retail', [])];
    renderSidebar('/space/p1');
    expect(screen.getByRole('link', { name: 'My work' })).toHaveAttribute('href', '/dashboard');
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
    // Menus, dialogs and toggles stay buttons.
    expect(screen.getByRole('button', { name: /^Spaces/ })).toHaveAttribute('aria-expanded');
    expect(screen.getByRole('button', { name: 'Sort spaces' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New space' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Collapse Retail' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pin Retail' })).toBeInTheDocument();
  });

  it('navigates from a sidebar link and records the chosen intent section', () => {
    const intent = {
      id: 'i1',
      title: 'Cart',
      status: 'RUNNING',
      updatedAt: new Date().toISOString(),
    };
    mockProjects.projects = [v2Space('p1', 'Retail', [intent])];
    renderSidebar('/space/p1/intent/i1');
    const nav = screen.getByRole('navigation', { name: 'Intent sections' });
    const graph = within(nav).getByRole('link', { name: 'Graph' });
    expect(graph).toHaveAttribute('href', '/space/p1/intent/i1/graph');
    fireEvent.click(graph);
    expect(screen.getByTestId('current-path')).toHaveTextContent('/space/p1/intent/i1/graph');
    fireEvent.click(screen.getByRole('link', { name: 'My work' }));
    expect(screen.getByTestId('current-path')).toHaveTextContent('/dashboard');
  });
});
