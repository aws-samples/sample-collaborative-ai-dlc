import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Link, MemoryRouter, Routes, Route } from 'react-router';

import { shouldDefaultOpen } from './AppShell';

const shellTestState = vi.hoisted(() => ({
  panelsInline: true,
  onAgentFocus: null as null | (() => void),
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
// Integration: AppShell route-aware panel defaults
// ---------------------------------------------------------------------------

vi.mock('@/components/layout/AppSidebar', () => ({
  AppSidebar: () => <nav data-testid="sidebar" />,
}));
vi.mock('@/components/layout/AppHeader', () => ({
  AppHeader: ({
    onToggleActivity,
    activityPanelOpen,
  }: {
    onToggleSidebar: () => void;
    onToggleActivity: () => void;
    onOpenCommand: () => void;
    sidebarCollapsed: boolean;
    activityPanelOpen: boolean;
  }) => (
    <header>
      <button data-testid="toggle-activity" onClick={onToggleActivity}>
        toggle
      </button>
      <span data-testid="panel-state">{activityPanelOpen ? 'open' : 'closed'}</span>
    </header>
  ),
}));
vi.mock('@/components/layout/SprintPipelineBar', () => ({ SprintPipelineBar: () => null }));
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
vi.mock('@/components/discussion', () => ({
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
}));
vi.mock('@/hooks/useMediaQuery', () => ({
  useMediaQuery: () => shellTestState.panelsInline,
}));
vi.mock('@/hooks/useResizablePanel', () => ({
  useResizablePanel: () => ({
    width: 380,
    handleResizeStart: () => {},
    handleResizeKey: () => {},
    resetWidth: () => {},
  }),
}));

import { AppShell } from './AppShell';

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
          <Route path="/dashboard" element={<div>dashboard</div>} />
          <Route path="*" element={<div>page</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
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

beforeEach(() => {
  shellTestState.panelsInline = true;
  shellTestState.onAgentFocus = null;
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query === '(min-width: 1024px)' && shellTestState.panelsInline,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
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
    shellTestState.panelsInline = false;
    const user = userEvent.setup();
    renderAtRoute('/space/p1/intent/i1');

    expect(await screen.findByTestId('intent-activity-panel')).toBeInTheDocument();
    await user.click(screen.getByTestId('toggle-activity'));
    expect(screen.queryByTestId('intent-activity-panel')).not.toBeInTheDocument();

    const preview = screen.getByTestId('open-preview');
    await user.click(preview);

    const close = await screen.findByRole('button', { name: 'Close activity panel' });
    await waitFor(() => expect(close).toHaveFocus());

    await user.click(close);
    expect(screen.queryByTestId('intent-activity-panel')).not.toBeInTheDocument();
    await waitFor(() => expect(preview).toHaveFocus());
  });
});
