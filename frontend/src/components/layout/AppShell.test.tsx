import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

import { shouldDefaultOpen } from './AppShell';

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
vi.mock('@/components/layout/IntentPipelineBar', () => ({ IntentPipelineBar: () => null }));
vi.mock('@/components/layout/ActivityPanel', () => ({
  ActivityPanel: () => <div data-testid="activity-panel" />,
}));
vi.mock('@/components/layout/IntentActivityPanel', () => ({
  IntentActivityPanel: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="intent-activity-panel">
      <button data-testid="close-panel" onClick={onClose}>
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
  IntentProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/hooks/useProjectsCache', () => ({
  useProjectSprintsCache: () => ({ sprints: [] }),
}));
vi.mock('@/hooks/useMediaQuery', () => ({
  useMediaQuery: () => true,
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
          <Route path="/space/:projectId/intent/:intentId" element={<div>work</div>} />
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

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query === '(min-width: 1024px)',
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
});
