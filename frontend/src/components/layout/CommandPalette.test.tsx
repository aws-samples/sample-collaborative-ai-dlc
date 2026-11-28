import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, within } from '@/test/query';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router';

const mockAuth = vi.hoisted(() => ({ isPlatformAdmin: true }));
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => mockAuth,
}));

const mockProjects = vi.hoisted(() => ({
  projects: [] as unknown[],
  loading: false,
  refresh: vi.fn(),
}));
vi.mock('@/hooks/useProjectsCache', () => ({
  useProjectsCache: () => mockProjects,
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

import { CommandPalette } from './CommandPalette';
import { installNavIntent } from '@/lib/navIntent';
import { queryClient } from '@/lib/queryClient';

function CurrentPath() {
  const { pathname, search } = useLocation();
  return <span data-testid="current-path">{`${pathname}${search}`}</span>;
}

function renderPalette() {
  const onOpenChange = vi.fn();
  const onCreateSpace = vi.fn();
  render(
    <MemoryRouter initialEntries={['/dashboard']}>
      <CurrentPath />
      <Routes>
        <Route
          path="*"
          element={
            <CommandPalette open onOpenChange={onOpenChange} onCreateSpace={onCreateSpace} />
          }
        />
      </Routes>
    </MemoryRouter>,
  );
  return { onOpenChange, onCreateSpace };
}

function typeSearch(text: string) {
  fireEvent.change(screen.getByRole('combobox'), { target: { value: text } });
}

const FOUR_MONTHS_AGO = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000).toISOString();

beforeEach(() => {
  vi.spyOn(queryClient, 'getQueryData').mockImplementation(
    (key) => (mockCache.peek(key) as { data?: unknown } | undefined)?.data,
  );
  mockAuth.isPlatformAdmin = true;
  mockCache.prefetch.mockReset();
  mockPrefetchHref.mockReset();
  Element.prototype.scrollIntoView = vi.fn();
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  mockProjects.projects = [
    {
      project: {
        id: 'retail',
        name: 'retail-v2',
        kind: 'v2',
        createdAt: '2024-01-01',
      },
      latestSprint: null,
      latestIntent: null,
      intents: [
        {
          id: 'cart',
          title: 'Cart page: item quantity selector',
          status: 'WAITING',
          pendingHumanTaskId: 'task-1',
          updatedAt: '2026-11-20T00:00:00.000Z',
        },
        {
          id: 'lowstock',
          title: 'Add a low-stock warning badge',
          status: 'RUNNING',
          updatedAt: FOUR_MONTHS_AGO,
        },
      ],
      lastIntentActivityAt: null,
      activity: { inProgress: 2, attention: 1 },
    },
    {
      project: {
        id: 'c4a7r1t9-0000-4000-8000-000000000000',
        name: 'llm-router-hackathon',
        kind: 'v2',
        createdAt: '2024-01-01',
        gitRepo: 'hectorsy/llm-router-hackathon',
      },
      latestSprint: null,
      latestIntent: null,
      intents: [
        {
          id: 'router',
          title: 'Route requests across providers',
          status: 'SUCCEEDED',
          updatedAt: '2026-10-01T00:00:00.000Z',
        },
      ],
      lastIntentActivityAt: null,
      activity: { inProgress: 0, attention: 0 },
    },
    {
      project: {
        id: 'cartel',
        name: 'cart-analytics',
        kind: 'v2',
        createdAt: '2024-01-01',
      },
      latestSprint: null,
      latestIntent: null,
      intents: [],
      lastIntentActivityAt: null,
      activity: { inProgress: 0, attention: 0 },
    },
  ];
});

afterEach(() => {
  vi.useRealTimers();
});

describe('CommandPalette intents', () => {
  it('lists a matching intent with its space and status, and opens its entry page', () => {
    const { onOpenChange } = renderPalette();
    typeSearch('cart page');
    const option = screen.getByRole('option', {
      name: /cart page: item quantity selector/i,
    });
    expect(option).toHaveTextContent('retail-v2');
    expect(option).toHaveTextContent('Waiting for input');
    fireEvent.click(option);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.getByTestId('current-path')).toHaveTextContent('/space/retail/intent/cart');
  });

  it('opens Overview for an intent with no pending human action and never calls a stalled run Running', () => {
    renderPalette();
    typeSearch('low-stock');
    const option = screen.getByRole('option', {
      name: /low-stock warning badge/i,
    });
    expect(option).toHaveTextContent('Stalled · no activity for 4 months');
    expect(option).not.toHaveTextContent(/running/i);
    expect(option.querySelector('[data-pulse]')).toBeNull();
    fireEvent.click(option);
    expect(screen.getByTestId('current-path')).toHaveTextContent(
      '/space/retail/intent/lowstock/observability',
    );
  });

  const warmed = (trigger: string) =>
    mockPrefetchHref.mock.calls
      .filter(([, options]) => options?.trigger === trigger)
      .map(([href]) => href);

  it('warms a hovered result through the delegated listener after 200 ms', () => {
    vi.useFakeTimers();
    renderPalette();
    const uninstall = installNavIntent(() => ({
      user: { isPlatformAdmin: true },
      currentHref: '/dashboard',
    }));
    try {
      typeSearch('cart page');
      const option = screen.getByRole('option', {
        name: /cart page: item quantity selector/i,
      });
      expect(option).toHaveAttribute('data-prefetch-href', '/space/retail/intent/cart');
      fireEvent.pointerOver(option);
      act(() => {
        vi.advanceTimersByTime(199);
      });
      expect(warmed('hover')).toEqual([]);
      act(() => {
        vi.advanceTimersByTime(21);
      });
      expect(warmed('hover')).toEqual(['/space/retail/intent/cart']);
      // No per-item speculation besides the listener.
      expect(mockCache.prefetch).not.toHaveBeenCalled();
    } finally {
      uninstall();
    }
  });

  it('warms the result highlighted with the keyboard after a 100 ms rest', () => {
    vi.useFakeTimers();
    renderPalette();
    typeSearch('low-stock');
    act(() => {
      vi.advanceTimersByTime(120);
    });
    expect(warmed('focus')).toEqual(['/space/retail/intent/lowstock/observability']);
    mockPrefetchHref.mockReset();
    typeSearch('admin');
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowDown' });
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowDown' });
    act(() => {
      vi.advanceTimersByTime(50);
    });
    // Passing over a result without resting on it warms nothing.
    expect(warmed('focus')).toEqual([]);
    act(() => {
      vi.advanceTimersByTime(60);
    });
    const selected = screen
      .getAllByRole('option')
      .find((option) => option.getAttribute('aria-selected') === 'true');
    expect(warmed('focus')).toEqual([selected?.getAttribute('data-prefetch-href')]);
    expect(warmed('focus')[0]).toMatch(/^\/admin\?tab=/);
  });
});

describe('CommandPalette relevance', () => {
  it('matches words of names and repositories, not scattered letters', () => {
    renderPalette();
    typeSearch('cart');
    expect(screen.getByRole('option', { name: /cart-analytics/i })).toBeInTheDocument();
    expect(
      screen.getByRole('option', {
        name: /cart page: item quantity selector/i,
      }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /llm-router-hackathon/i })).toBeNull();
    expect(screen.queryByRole('option', { name: /route requests/i })).toBeNull();
  });

  it('matches a space by a word of its repository', () => {
    renderPalette();
    typeSearch('hectorsy');
    const spaces = screen.getByRole('group', { name: 'Spaces' });
    expect(
      within(spaces).getByRole('option', { name: /llm-router-hackathon/i }),
    ).toBeInTheDocument();
    expect(within(spaces).queryByRole('option', { name: /retail-v2/i })).toBeNull();
  });

  it('requires every typed word and accepts word prefixes', () => {
    renderPalette();
    typeSearch('qua sel');
    expect(
      screen.getByRole('option', {
        name: /cart page: item quantity selector/i,
      }),
    ).toBeInTheDocument();
    typeSearch('quantity hackathon');
    expect(screen.queryByRole('option', { name: /cart page/i })).toBeNull();
  });
});

describe('CommandPalette status', () => {
  it('shows the age the intent page shows once its detail is cached', () => {
    const snapshot = {
      data: {
        intent: {
          id: 'cart',
          status: 'WAITING',
          updatedAt: '2026-11-20T00:00:00.000Z',
        },
        gates: [
          {
            humanTaskId: 'old',
            status: 'pending',
            createdAt: '2026-07-08T00:00:00.000Z',
          },
          {
            humanTaskId: 'task-1',
            status: 'pending',
            createdAt: '2026-11-20T00:00:00.000Z',
          },
        ],
        stages: [],
        events: [],
      },
    };
    mockCache.peek.mockImplementation(() => snapshot);
    renderPalette();
    typeSearch('cart page');
    const option = screen.getByRole('option', {
      name: /cart page: item quantity selector/i,
    });
    const days = Math.floor((Date.now() - Date.parse('2026-07-08T00:00:00.000Z')) / 86_400_000);
    expect(option).toHaveTextContent(`Waiting for input · ${days} days`);
    mockCache.peek.mockImplementation(() => undefined);
  });
});

describe('CommandPalette pages', () => {
  it('finds the Source control admin tab by name and by code-host keyword', () => {
    renderPalette();
    typeSearch('source control');
    fireEvent.click(screen.getByRole('option', { name: /source control/i }));
    expect(screen.getByTestId('current-path')).toHaveTextContent('/admin?tab=source-control');
  });

  it('matches admin tabs on keywords such as "github"', () => {
    renderPalette();
    typeSearch('github');
    expect(screen.getByRole('option', { name: /source control/i })).toBeInTheDocument();
  });

  it('lists Spaces, My work, authoring, every admin tab and account settings', () => {
    renderPalette();
    const pages = screen.getByRole('group', { name: 'Pages' });
    for (const name of [
      'Spaces',
      'My work',
      'Workflows',
      'Block library',
      'Admin › Users',
      'Admin › Agents',
      'Admin › Environments',
      'Admin › Tools',
      'Admin › AI-DLC versions',
      'Admin › Source control',
      'Admin › Trackers',
      'Account settings',
    ]) {
      expect(within(pages).getByRole('option', { name })).toBeInTheDocument();
    }
  });

  it('hides admin-only pages from members', () => {
    mockAuth.isPlatformAdmin = false;
    renderPalette();
    expect(screen.queryByRole('option', { name: /source control/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Workflows' })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Account settings' })).toBeInTheDocument();
  });

  it('has no v1 "Sprint Phases" group or "Sprint Overview" entry', () => {
    renderPalette();
    expect(screen.queryByText(/sprint phases/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/sprint overview/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /go to inception/i })).not.toBeInTheDocument();
  });
});

describe('CommandPalette actions', () => {
  it('"Create new space" opens the shell\'s dialog where the reader is', () => {
    const { onCreateSpace, onOpenChange } = renderPalette();
    fireEvent.click(screen.getByRole('option', { name: /create new space/i }));
    expect(onCreateSpace).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.getByTestId('current-path')).toHaveTextContent('/dashboard');
  });

  it.each([
    ['Spaces', '/dashboard'],
    ['My work', '/my-work'],
  ])('opens %s at %s', (name, path) => {
    renderPalette();
    const pages = screen.getByRole('group', { name: 'Pages' });
    fireEvent.click(within(pages).getByRole('option', { name }));
    expect(screen.getByTestId('current-path')).toHaveTextContent(path);
  });
});
