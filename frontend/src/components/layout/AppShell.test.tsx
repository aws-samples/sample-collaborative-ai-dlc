import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@/test/query';
import userEvent from '@testing-library/user-event';
import { Link, MemoryRouter, Routes, Route, useLocation, useNavigate } from 'react-router';

import {
  ACTIVITY_PANEL_OPEN_STORAGE_KEY,
  shouldActivityPanelDefaultOpen,
  shouldDefaultOpen,
} from './AppShell';

const shellTestState = vi.hoisted(() => ({
  panelsInline: true,
  onAgentFocus: null as null | (() => void),
  mediaListeners: [] as Array<(event: MediaQueryListEvent) => void>,
  sprintPipelineBarImported: vi.fn(),
  installNavIntent: vi.fn(),
  uninstallNavIntent: vi.fn(),
  notifyNavigation: vi.fn(),
  useIdleNext: vi.fn(),
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: 'test-user', isPlatformAdmin: true }),
}));
vi.mock('@/lib/navIntent', () => ({
  installNavIntent: (...args: unknown[]) => {
    shellTestState.installNavIntent(...args);
    return shellTestState.uninstallNavIntent;
  },
}));
vi.mock('@/lib/routePrefetch', () => ({
  notifyNavigation: (...args: unknown[]) => shellTestState.notifyNavigation(...args),
}));
vi.mock('@/hooks/useIdleNext', () => ({
  useIdleNext: (...args: unknown[]) => shellTestState.useIdleNext(...args),
}));

const DESKTOP_WIDTH = 1280;
const MOBILE_WIDTH = 390;

// ---------------------------------------------------------------------------
// Unit tests for shouldDefaultOpen (pure function — no mocking needed)
// ---------------------------------------------------------------------------

describe('shouldDefaultOpen', () => {
  it('returns true for intent work root', () => {
    expect(shouldDefaultOpen('/space/p1/intent/i1')).toBe(true);
  });

  it('returns true for intent review sub-route', () => {
    expect(shouldDefaultOpen('/space/p1/intent/i1/review/ht-1')).toBe(true);
  });

  it('returns false for new intent creation', () => {
    expect(shouldDefaultOpen('/space/p1/intent/new')).toBe(false);
  });

  it('returns false for intent graph', () => {
    expect(shouldDefaultOpen('/space/p1/intent/i1/graph')).toBe(false);
  });

  it('returns false for intent audit', () => {
    expect(shouldDefaultOpen('/space/p1/intent/i1/audit')).toBe(false);
  });

  it('returns false for intent compose', () => {
    expect(shouldDefaultOpen('/space/p1/intent/i1/compose')).toBe(false);
  });

  it('returns false for intent observability', () => {
    expect(shouldDefaultOpen('/space/p1/intent/i1/observability')).toBe(false);
  });

  it('returns true for sprint routes', () => {
    expect(shouldDefaultOpen('/space/p1/sprint/s1')).toBe(true);
    expect(shouldDefaultOpen('/space/p1/sprint/s1/graph')).toBe(true);
  });

  it('returns false for top-level routes', () => {
    expect(shouldDefaultOpen('/dashboard')).toBe(false);
    expect(shouldDefaultOpen('/observability')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Unit tests for shouldActivityPanelDefaultOpen (pure — viewport + persisted
// desktop preference + route)
// ---------------------------------------------------------------------------

describe('shouldActivityPanelDefaultOpen', () => {
  const route = '/space/p1/intent/i1';

  it('is closed below 1024px whatever the route or persisted preference says', () => {
    expect(shouldActivityPanelDefaultOpen({ width: 390, persisted: true, route })).toBe(false);
    expect(shouldActivityPanelDefaultOpen({ width: 1023, persisted: null, route })).toBe(false);
    expect(
      shouldActivityPanelDefaultOpen({
        width: 768,
        persisted: true,
        route: '/space/p1/sprint/s1',
      }),
    ).toBe(false);
  });

  it('follows the route default at 1024px and above when nothing is persisted', () => {
    expect(shouldActivityPanelDefaultOpen({ width: 1024, persisted: null, route })).toBe(true);
    expect(
      shouldActivityPanelDefaultOpen({
        width: 1440,
        persisted: undefined,
        route,
      }),
    ).toBe(true);
    expect(
      shouldActivityPanelDefaultOpen({
        width: 1440,
        persisted: null,
        route: `${route}/graph`,
      }),
    ).toBe(false);
  });

  it('lets the persisted desktop preference override the route default', () => {
    expect(shouldActivityPanelDefaultOpen({ width: 1440, persisted: false, route })).toBe(false);
    expect(
      shouldActivityPanelDefaultOpen({
        width: 1440,
        persisted: true,
        route: `${route}/graph`,
      }),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Integration: AppShell route-aware panel defaults
// ---------------------------------------------------------------------------

vi.mock('@/components/layout/AppSidebar', async () => {
  const router = await import('react-router');
  return {
    AppSidebar: ({
      onCreateSpace,
      variant = 'inline',
    }: {
      onCreateSpace?: () => void;
      variant?: 'inline' | 'drawer';
    }) => (
      <nav data-testid="sidebar" data-variant={variant}>
        <button type="button" onClick={onCreateSpace}>
          New space
        </button>
        <router.Link data-testid="sidebar-dashboard-link" to="/dashboard">
          Spaces
        </router.Link>
      </nav>
    ),
  };
});
vi.mock('@/components/CreateProjectModal', () => ({
  CreateProjectModal: ({
    onClose,
    initialProvider = '',
    initialInstance,
  }: {
    onClose: () => void;
    initialProvider?: string;
    initialInstance?: string;
  }) => (
    <div
      role="dialog"
      aria-label="Create space"
      data-provider={initialProvider}
      data-instance={initialInstance}
    >
      <button type="button" onClick={onClose}>
        Cancel
      </button>
    </div>
  ),
}));
vi.mock('@/components/layout/AppHeader', () => ({
  AppHeader: ({
    onToggleSidebar,
    onToggleActivity,
    sidebarCollapsed,
    activityPanelOpen,
  }: {
    onToggleSidebar: () => void;
    onToggleActivity: () => void;
    onOpenCommand: () => void;
    sidebarCollapsed: boolean;
    activityPanelOpen: boolean;
  }) => (
    <header>
      <button
        id="sidebar-toggle"
        data-testid="toggle-sidebar"
        aria-label="Toggle sidebar"
        aria-expanded={!sidebarCollapsed}
        onClick={onToggleSidebar}
      >
        toggle sidebar
      </button>
      <button data-testid="toggle-activity" onClick={onToggleActivity}>
        toggle
      </button>
      <span data-testid="panel-state">{activityPanelOpen ? 'open' : 'closed'}</span>
    </header>
  ),
}));
vi.mock('@/components/layout/SprintPipelineBar', () => {
  shellTestState.sprintPipelineBarImported();
  return { SprintPipelineBar: () => <div data-testid="sprint-pipeline-bar" /> };
});
vi.mock('@/components/layout/ActivityPanel', () => ({
  ActivityPanel: () => <div data-testid="activity-panel" />,
}));
vi.mock('@/components/layout/IntentActivityPanel', () => ({
  IntentActivityPanel: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="intent-activity-panel">
      <button data-testid="close-panel" aria-label="Close activity panel" onClick={onClose}>
        close
      </button>
    </div>
  ),
}));
vi.mock('@/components/layout/StatusBar', () => ({ StatusBar: () => null }));
vi.mock('@/components/layout/CommandPalette', () => ({
  CommandPalette: () => null,
}));
vi.mock('@/components/discussion/DiscussionProvider', () => ({
  DiscussionProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/contexts/IntentContext', () => ({
  IntentProvider: ({
    children,
    onAgentFocus,
  }: {
    children: React.ReactNode;
    onAgentFocus?: () => void;
  }) => {
    shellTestState.onAgentFocus = onAgentFocus ?? null;
    return <>{children}</>;
  },
}));
vi.mock('@/hooks/useProjectsCache', () => ({
  useProjectSprintsCache: () => ({ sprints: [] }),
  useProjectsCache: () => ({ projects: [], loading: false, refresh: vi.fn() }),
}));
vi.mock('@/hooks/useResizablePanel', () => ({
  useResizablePanel: () => ({
    width: 380,
    effectiveMaxWidth: 540,
    handleResizeStart: () => {},
    handleResizeKey: () => {},
    resetWidth: () => {},
  }),
}));

import { AppShell } from './AppShell';
import { useOpenCreateSpace } from './createSpaceDialog';

function CurrentLocation() {
  const { pathname, search } = useLocation();
  return <span data-testid="current-location">{pathname + search}</span>;
}

function HistoryBackButton() {
  const navigate = useNavigate();
  return (
    <button data-testid="go-back" onClick={() => navigate(-1)}>
      Back
    </button>
  );
}

function CreateSpaceOpener() {
  const openCreateSpace = useOpenCreateSpace();
  return (
    <button type="button" onClick={openCreateSpace}>
      Start a space
    </button>
  );
}

function renderAtRoute(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<AppShell />}>
          <Route
            path="/space/:projectId/intent/:intentId"
            element={
              <>
                <button data-testid="open-preview" onClick={() => shellTestState.onAgentFocus?.()}>
                  preview
                </button>
                <Link data-testid="navigate-dashboard" to="/dashboard">
                  Dashboard
                </Link>
              </>
            }
          />
          <Route
            path="/space/:projectId/intent/:intentId/review/:humanTaskId"
            element={<div>review</div>}
          />
          <Route path="/space/:projectId/intent/:intentId/graph" element={<div>graph</div>} />
          <Route path="/space/:projectId/intent/:intentId/audit" element={<div>audit</div>} />
          <Route path="/space/:projectId/intent/:intentId/compose" element={<div>compose</div>} />
          <Route
            path="/space/:projectId/intent/:intentId/observability"
            element={<div>observability</div>}
          />
          <Route path="/space/:projectId/sprint/:sprintId" element={<div>sprint</div>} />
          <Route
            path="/dashboard"
            element={
              <>
                <div>dashboard</div>
                <HistoryBackButton />
                <CurrentLocation />
              </>
            }
          />
          <Route path="/spaces" element={<CurrentLocation />} />
          <Route path="/opener" element={<CreateSpaceOpener />} />
          <Route path="*" element={<div>page</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

function setViewport(panelsInline: boolean) {
  shellTestState.panelsInline = panelsInline;
  window.innerWidth = panelsInline ? DESKTOP_WIDTH : MOBILE_WIDTH;
}

it('installs the delegated listener once, updates its location, and uninstalls on unmount', async () => {
  shellTestState.installNavIntent.mockClear();
  shellTestState.uninstallNavIntent.mockClear();
  const view = renderAtRoute('/space/p1/intent/i1');
  expect(shellTestState.installNavIntent).toHaveBeenCalledTimes(1);
  const getContext = shellTestState.installNavIntent.mock.calls[0][0] as () => {
    currentHref: string;
  };
  expect(getContext().currentHref).toBe('/space/p1/intent/i1');
  await userEvent.click(screen.getByTestId('navigate-dashboard'));
  expect(getContext().currentHref).toBe('/dashboard');
  expect(shellTestState.notifyNavigation).toHaveBeenLastCalledWith('/dashboard', {
    isPlatformAdmin: true,
  });
  expect(shellTestState.installNavIntent).toHaveBeenCalledTimes(1);
  view.unmount();
  expect(shellTestState.uninstallNavIntent).toHaveBeenCalledTimes(1);
});

it('runs the idle next-page pass for the signed-in user', () => {
  shellTestState.useIdleNext.mockClear();
  renderAtRoute('/space/p1/intent/i1');
  expect(shellTestState.useIdleNext).toHaveBeenCalledWith(true, true);
});

function setPanelsInline(panelsInline: boolean) {
  setViewport(panelsInline);
  act(() => {
    for (const listener of shellTestState.mediaListeners) {
      listener({ matches: panelsInline } as MediaQueryListEvent);
    }
  });
}

beforeEach(() => {
  setViewport(true);
  shellTestState.onAgentFocus = null;
  shellTestState.mediaListeners = [];
  shellTestState.sprintPipelineBarImported.mockClear();
  window.localStorage.clear();
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      get matches() {
        return query === '(min-width: 1024px)' && shellTestState.panelsInline;
      },
      media: query,
      addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
        shellTestState.mediaListeners.push(listener);
      },
      removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
        shellTestState.mediaListeners = shellTestState.mediaListeners.filter(
          (registered) => registered !== listener,
        );
      },
    })),
  });
});

describe('AppShell Create space dialog (R3-8)', () => {
  it('closes the narrow drawer when New space opens the dialog, so the dialog can be reached', async () => {
    const user = userEvent.setup();
    setViewport(false);
    renderAtRoute('/dashboard');
    await user.click(screen.getByTestId('toggle-sidebar'));
    expect(screen.getByLabelText('Main navigation')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'New space' }));

    await waitFor(() => expect(screen.queryByTestId('sidebar')).not.toBeInTheDocument());
    const dialog = screen.getByRole('dialog', { name: 'Create space' });
    // Nothing modal is left to hide the dialog or block pointer and focus.
    expect(dialog.closest('[aria-hidden="true"]')).toBeNull();
    expect(document.body).not.toHaveStyle('pointer-events: none');
    dialog.querySelector('button')!.focus();
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
  });

  it('keeps the dialog opened from the sidebar mounted when the viewport narrows and the sidebar unmounts', async () => {
    renderAtRoute('/space/p1/intent/i1');
    await userEvent.click(screen.getByRole('button', { name: 'New space' }));
    expect(screen.getByRole('dialog', { name: 'Create space' })).toBeInTheDocument();

    setPanelsInline(false);
    expect(screen.queryByTestId('sidebar')).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Create space' })).toBeInTheDocument();

    setPanelsInline(true);
    expect(screen.getByRole('dialog', { name: 'Create space' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: 'Create space' })).toBeNull();
  });

  it('opens its dialog for a page that asks through useOpenCreateSpace, across layout changes', async () => {
    renderAtRoute('/opener');
    await userEvent.click(screen.getByRole('button', { name: 'Start a space' }));
    const dialog = screen.getByRole('dialog', { name: 'Create space' });
    setPanelsInline(false);
    setPanelsInline(true);
    expect(screen.getByRole('dialog', { name: 'Create space' })).toBe(dialog);
  });

  it('opens the dialog from ?reopenCreateSpace=1 on the page the reader lands on and clears the flag', async () => {
    renderAtRoute('/dashboard?reopenCreateSpace=1&gitProvider=gitlab&tab=x');
    const dialog = await screen.findByRole('dialog', { name: 'Create space' });
    expect(dialog).toHaveAttribute('data-provider', 'gitlab');
    await waitFor(() =>
      expect(screen.getByTestId('current-location')).toHaveTextContent('/dashboard?tab=x'),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: 'Create space' })).toBeNull();
  });

  it('reopens on the self-managed GitLab instance the connection returned from', async () => {
    renderAtRoute(
      '/dashboard?reopenCreateSpace=1&gitProvider=gitlab&gitlabInstance=git.example.org',
    );
    const dialog = await screen.findByRole('dialog', { name: 'Create space' });
    expect(dialog).toHaveAttribute('data-instance', 'git.example.org');
    await waitFor(() =>
      expect(screen.getByTestId('current-location')).toHaveTextContent(/^\/dashboard$/),
    );
  });

  it('leaves the flag alone on /spaces on large screens: the route carries it to My work', () => {
    renderAtRoute('/spaces?reopenCreateSpace=1');
    expect(screen.queryByRole('dialog', { name: 'Create space' })).toBeNull();
    expect(screen.getByTestId('current-location')).toHaveTextContent('/spaces?reopenCreateSpace=1');
  });

  it('opens the dialog on /spaces on narrow screens, where the page renders', async () => {
    setViewport(false);
    renderAtRoute('/spaces?reopenCreateSpace=1');
    expect(await screen.findByRole('dialog', { name: 'Create space' })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId('current-location')).toHaveTextContent(/^\/spaces$/),
    );
  });
});

describe('AppShell panel default behavior', () => {
  it('opens panel on intent work root', async () => {
    renderAtRoute('/space/p1/intent/i1');
    expect(screen.getByTestId('panel-state').textContent).toBe('open');
    // The panel is lazy-loaded — wait for the chunk to resolve.
    expect(await screen.findByTestId('intent-activity-panel')).toBeInTheDocument();
  });

  it('lets the activity column grow until only the sidebar and the main column minimum are left', async () => {
    renderAtRoute('/space/p1/intent/i1');
    expect(await screen.findByTestId('intent-activity-panel')).toBeInTheDocument();
    const grid = screen
      .getByRole('separator', { name: 'Resize activity panel' })
      .closest('[style]') as HTMLElement;
    const columns = grid.style.gridTemplateColumns;
    expect(columns).toContain('calc(100vw - min(380px, 30vw) - 360px)');
    expect(columns).not.toContain('45vw');
  });

  it('names the inline activity panel landmark at 1024px and above', async () => {
    renderAtRoute('/space/p1/intent/i1');
    await screen.findByTestId('intent-activity-panel');
    const panel = screen.getByRole('complementary', { name: 'Activity panel' });
    expect(panel).toHaveAttribute('id', 'activity-panel');
    expect(panel).toContainElement(screen.getByTestId('intent-activity-panel'));
  });

  it('closes panel on intent graph', () => {
    renderAtRoute('/space/p1/intent/i1/graph');
    expect(screen.getByTestId('panel-state').textContent).toBe('closed');
    expect(screen.queryByTestId('intent-activity-panel')).not.toBeInTheDocument();
  });

  it('closes panel on intent audit', () => {
    renderAtRoute('/space/p1/intent/i1/audit');
    expect(screen.getByTestId('panel-state').textContent).toBe('closed');
  });

  it('closes panel on intent compose', () => {
    renderAtRoute('/space/p1/intent/i1/compose');
    expect(screen.getByTestId('panel-state').textContent).toBe('closed');
  });

  it('allows manual toggle on a closed-by-default route', async () => {
    const user = userEvent.setup();
    renderAtRoute('/space/p1/intent/i1/graph');
    expect(screen.getByTestId('panel-state').textContent).toBe('closed');

    await user.click(screen.getByTestId('toggle-activity'));
    expect(screen.getByTestId('panel-state').textContent).toBe('open');
  });

  it('allows manual close on a work route', async () => {
    const user = userEvent.setup();
    renderAtRoute('/space/p1/intent/i1');
    expect(screen.getByTestId('panel-state').textContent).toBe('open');

    await user.click(screen.getByTestId('toggle-activity'));
    expect(screen.getByTestId('panel-state').textContent).toBe('closed');
  });

  it('moves focus into a narrow activity overlay and restores its invoking control', async () => {
    setViewport(false);
    const user = userEvent.setup();
    renderAtRoute('/space/p1/intent/i1');

    expect(screen.getByTestId('panel-state').textContent).toBe('closed');
    expect(screen.queryByTestId('intent-activity-panel')).not.toBeInTheDocument();

    const preview = screen.getByTestId('open-preview');
    await user.click(preview);

    const close = await screen.findByRole('button', {
      name: 'Close activity panel',
    });
    await waitFor(() => expect(close).toHaveFocus());

    await user.click(close);
    expect(screen.queryByTestId('intent-activity-panel')).not.toBeInTheDocument();
    await waitFor(() => expect(preview).toHaveFocus());
  });

  it('closes a narrow activity overlay with Escape and restores its invoking control', async () => {
    setViewport(false);
    const user = userEvent.setup();
    renderAtRoute('/space/p1/intent/i1');

    const preview = screen.getByTestId('open-preview');
    await user.click(preview);
    const close = await screen.findByRole('button', { name: 'Close activity panel' });
    await waitFor(() => expect(close).toHaveFocus());

    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('intent-activity-panel')).not.toBeInTheDocument();
    await waitFor(() => expect(preview).toHaveFocus());
  });

  it('keeps the activity overlay closed on first render below 1024px even when a desktop preference says open', () => {
    setViewport(false);
    window.localStorage.setItem(ACTIVITY_PANEL_OPEN_STORAGE_KEY, 'true');
    renderAtRoute('/space/p1/intent/i1');

    expect(screen.getByTestId('panel-state').textContent).toBe('closed');
    expect(screen.queryByLabelText('Activity panel')).not.toBeInTheDocument();
  });

  it('closes the docked activity panel when the window narrows below 1024px instead of overlaying the page', async () => {
    renderAtRoute('/space/p1/intent/i1');
    expect(await screen.findByTestId('intent-activity-panel')).toBeInTheDocument();
    expect(screen.getByTestId('panel-state').textContent).toBe('open');

    setPanelsInline(false);

    expect(screen.getByTestId('panel-state').textContent).toBe('closed');
    expect(screen.queryByLabelText('Activity panel')).not.toBeInTheDocument();
  });

  it('closes a narrow activity overlay when the route category changes', async () => {
    setViewport(false);
    const user = userEvent.setup();
    renderAtRoute('/space/p1/intent/i1');

    await user.click(screen.getByTestId('toggle-activity'));
    expect(await screen.findByLabelText('Activity panel')).toBeInTheDocument();

    await user.click(screen.getByTestId('navigate-dashboard'));
    await waitFor(() => expect(screen.getByTestId('panel-state').textContent).toBe('closed'));
  });

  it('respects a persisted closed preference at 1024px and above', () => {
    window.localStorage.setItem(ACTIVITY_PANEL_OPEN_STORAGE_KEY, 'false');
    renderAtRoute('/space/p1/intent/i1');

    expect(screen.getByTestId('panel-state').textContent).toBe('closed');
    expect(screen.queryByTestId('intent-activity-panel')).not.toBeInTheDocument();
  });

  it('respects a persisted open preference at 1024px and above on a closed-by-default route', async () => {
    window.localStorage.setItem(ACTIVITY_PANEL_OPEN_STORAGE_KEY, 'true');
    renderAtRoute('/space/p1/intent/i1/graph');

    expect(screen.getByTestId('panel-state').textContent).toBe('open');
    expect(await screen.findByTestId('intent-activity-panel')).toBeInTheDocument();
  });

  it('persists a manual desktop toggle but not a narrow-screen one', async () => {
    const user = userEvent.setup();
    renderAtRoute('/space/p1/intent/i1');

    await user.click(screen.getByTestId('toggle-activity'));
    expect(window.localStorage.getItem(ACTIVITY_PANEL_OPEN_STORAGE_KEY)).toBe('false');

    setPanelsInline(false);
    await user.click(screen.getByTestId('toggle-activity'));
    expect(screen.getByTestId('panel-state').textContent).toBe('open');
    expect(window.localStorage.getItem(ACTIVITY_PANEL_OPEN_STORAGE_KEY)).toBe('false');
  });

  it('does not import the v1 sprint pipeline bar on a v2 route', async () => {
    renderAtRoute('/dashboard');

    expect(screen.getByText('dashboard')).toBeInTheDocument();
    await act(async () => {
      await Promise.resolve();
    });
    expect(shellTestState.sprintPipelineBarImported).not.toHaveBeenCalled();
  });

  it('loads the v1 sprint pipeline bar on a sprint route', async () => {
    renderAtRoute('/space/p1/sprint/s1');

    expect(await screen.findByTestId('sprint-pipeline-bar')).toBeInTheDocument();
    expect(shellTestState.sprintPipelineBarImported).toHaveBeenCalled();
  });

  it('keeps desktop preference separate from the mobile drawer across breakpoint and route changes', async () => {
    const user = userEvent.setup();
    renderAtRoute('/space/p1/intent/i1');

    // Inline column: the full sidebar with the space list.
    expect(screen.getByTestId('sidebar')).toHaveAttribute('data-variant', 'inline');
    setPanelsInline(false);
    await waitFor(() => expect(screen.queryByTestId('sidebar')).not.toBeInTheDocument());
    expect(screen.getByTestId('toggle-sidebar')).toHaveAttribute('aria-expanded', 'false');

    await user.click(screen.getByTestId('toggle-sidebar'));
    // Narrow drawer: My work, Spaces and intents only (no space list).
    expect(screen.getByTestId('sidebar')).toHaveAttribute('data-variant', 'drawer');
    expect(screen.getByLabelText('Main navigation')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByTestId('sidebar')).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId('toggle-sidebar')).toHaveFocus());

    setPanelsInline(true);
    await waitFor(() => expect(screen.getByTestId('sidebar')).toBeInTheDocument());
    await user.click(screen.getByTestId('toggle-sidebar'));
    expect(screen.queryByTestId('sidebar')).not.toBeInTheDocument();

    setPanelsInline(false);
    await user.click(screen.getByTestId('toggle-sidebar'));
    expect(screen.getByTestId('sidebar')).toBeInTheDocument();
    // The drawer is modal (scrim + focus trap): the page behind it is inert,
    // so navigation comes from the drawer itself and closes it.
    expect(screen.getByTestId('navigate-dashboard')).toHaveStyle('pointer-events: none');
    await user.click(screen.getByTestId('sidebar-dashboard-link'));
    await waitFor(() => expect(screen.queryByTestId('sidebar')).not.toBeInTheDocument());

    await user.click(screen.getByTestId('toggle-sidebar'));
    expect(screen.getByTestId('sidebar')).toBeInTheDocument();
    // Browser back (history) while the drawer is open: the route change closes it.
    fireEvent.click(screen.getByTestId('go-back'));
    await waitFor(() => expect(screen.queryByTestId('sidebar')).not.toBeInTheDocument());

    setPanelsInline(true);
    await waitFor(() => expect(screen.queryByTestId('sidebar')).not.toBeInTheDocument());
  });
});

describe('AppShell keyboard access', () => {
  it('offers "Skip to content" as the first Tab stop and moves focus to the main landmark', async () => {
    const user = userEvent.setup();
    renderAtRoute('/space/p1/intent/i1');

    await user.tab();
    const skip = screen.getByRole('link', { name: 'Skip to content' });
    expect(skip).toHaveFocus();
    expect(skip).toHaveAttribute('href', '#main-content');

    await user.keyboard('{Enter}');
    const main = screen.getByRole('main');
    expect(main).toHaveAttribute('id', 'main-content');
    expect(main).toHaveAttribute('tabindex', '-1');
    expect(main).toHaveFocus();
  });

  it('exposes the resize handles as valued separators that control their panel', async () => {
    renderAtRoute('/space/p1/intent/i1');
    await screen.findByTestId('intent-activity-panel');

    const sidebarHandle = screen.getByRole('separator', {
      name: 'Resize sidebar',
    });
    expect(sidebarHandle).toHaveAttribute('aria-orientation', 'vertical');
    expect(sidebarHandle).toHaveAttribute('aria-controls', 'app-sidebar');
    expect(sidebarHandle).toHaveAttribute('aria-valuenow', '380');
    expect(sidebarHandle).toHaveAttribute('aria-valuemin', '200');
    // The reachable maximum (420 px capped to 30 vw), not the configured one.
    expect(sidebarHandle).toHaveAttribute('aria-valuemax', '540');
    expect(sidebarHandle).toHaveAttribute('aria-valuetext', '380 pixels');
    expect(sidebarHandle.className).toMatch(/focus-visible:ring-2/);

    const activityHandle = screen.getByRole('separator', {
      name: 'Resize activity panel',
    });
    expect(activityHandle).toHaveAttribute('aria-controls', 'activity-panel');
    expect(activityHandle).toHaveAttribute('aria-valuenow', '380');
    expect(activityHandle).toHaveAttribute('aria-valuemin', '300');
    expect(activityHandle).toHaveAttribute('aria-valuemax', '540');
    expect(activityHandle.className).toMatch(/focus-visible:ring-2/);
  });
});
