import { beforeAll, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@/test/query';
import type { ReactNode } from 'react';
import { Outlet } from 'react-router';

const loaded = vi.hoisted(() => new Set<string>());

vi.mock('./contexts/AuthContext', () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('./components/theme/ThemeProvider', () => ({
  ThemeProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('./components/ProtectedRoute', () => ({
  ProtectedRoute: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('./components/layout/AppShell', () => ({ AppShell: () => <Outlet /> }));
vi.mock('./pages/Login', () => ({ default: () => null }));
vi.mock('./pages/AuthCallback', () => ({ default: () => null }));
vi.mock('./pages/Dashboard', () => {
  loaded.add('Dashboard');
  return { default: () => <p>Dashboard page</p> };
});
vi.mock('./pages/Project', () => {
  loaded.add('Project');
  return { default: () => <p>Project page</p> };
});
vi.mock('./pages/IntentView', () => {
  loaded.add('IntentView');
  return { default: () => <p>Intent view page</p> };
});
vi.mock('./pages/IntentGraphPage', () => {
  loaded.add('IntentGraphPage');
  return { default: () => null };
});
vi.mock('./pages/IntentObservabilityPage', () => {
  loaded.add('IntentObservabilityPage');
  return { default: () => null };
});
vi.mock('./pages/IntentAuditPage', () => {
  loaded.add('IntentAuditPage');
  return { default: () => null };
});
vi.mock('./pages/WorkflowList', () => {
  loaded.add('WorkflowList');
  return { default: () => <p>Workflow list page</p> };
});
vi.mock('./pages/BlockLibrary', () => {
  loaded.add('BlockLibrary');
  return { default: () => null };
});
vi.mock('./pages/PlatformAdmin', () => {
  loaded.add('PlatformAdmin');
  return { default: () => <p>Platform admin page</p> };
});
vi.mock('./pages/AccountSettings', () => {
  loaded.add('AccountSettings');
  return { default: () => null };
});

vi.mock('./pages/NewIntentPage', () => ({ default: () => <p>New intent page</p> }));
vi.mock('./pages/BlockEditor', () => ({ default: () => <p>Block editor page</p> }));
vi.mock('./pages/NotFound', () => ({ default: () => <p>Not found page</p> }));
vi.mock('./components/layout/SprintLayout', () => ({
  SprintLayout: () => (
    <section aria-label="Sprint layout">
      <Outlet />
    </section>
  ),
}));
vi.mock('./pages/InceptionPage', () => ({ default: () => <p>Inception page</p> }));
vi.mock('./pages/ConstructionPage', () => ({ default: () => <p>Construction page</p> }));

let App: typeof import('./App').default;
let preloadRoute: typeof import('./App').preloadRoute;

beforeAll(async () => {
  // The browser router reads the location when App.tsx is first imported.
  window.history.replaceState({}, '', '/dashboard');
  ({ default: App, preloadRoute } = await import('./App'));
});

describe('App', () => {
  it('shows the layout-shaped route fallback while a page chunk loads', async () => {
    render(<App />);
    expect(screen.getByRole('status', { name: 'Loading page' })).toBeInTheDocument();
    expect(await screen.findByText('Dashboard page')).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: 'Loading page' })).not.toBeInTheDocument();
  });

  it.each([
    ['/space/p1', 'Project'],
    ['/space/p1/intent/i1', 'IntentView'],
    ['/space/p1/intent/i1/review/h1', 'IntentView'],
    ['/space/p1/intent/i1/graph', 'IntentGraphPage'],
    ['/space/p1/intent/i1/observability?tab=x', 'IntentObservabilityPage'],
    ['/space/p1/intent/i1/audit', 'IntentAuditPage'],
    ['/workflows', 'WorkflowList'],
    ['/blocks', 'BlockLibrary'],
    ['/admin', 'PlatformAdmin'],
    ['/account/settings', 'AccountSettings'],
  ])('preloadRoute(%s) warms %s', async (path, page) => {
    await preloadRoute(path);
    expect(loaded.has(page)).toBe(true);
  });

  it.each([
    ['/space/p1', 'Project page'],
    ['/space/p1/intent/new', 'New intent page'],
    ['/space/p1/intent/i1', 'Intent view page'],
    ['/space/p1/intent/i1/review/h1', 'Intent view page'],
    ['/workflows', 'Workflow list page'],
    ['/admin', 'Platform admin page'],
    ['/blocks/stage/new', 'Block editor page'],
    ['/blocks/stage/s1', 'Block editor page'],
    ['/space/p1/sprint/s1', 'Inception page'],
    ['/space/p1/sprint/s1/construction', 'Construction page'],
    ['/somewhere/else', 'Not found page'],
  ])('renders %s from the route table', async (path, text) => {
    act(() => {
      window.history.pushState({}, '', path);
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    render(<App />);
    expect(await screen.findByText(text)).toBeInTheDocument();
  });

  it('renders v1 sprint pages inside the sprint layout outlet', async () => {
    act(() => {
      window.history.pushState({}, '', '/space/p1/sprint/s1/construction');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    render(<App />);
    const layout = await screen.findByRole('region', { name: 'Sprint layout' });
    expect(layout).toHaveTextContent('Construction page');
  });

  it('preloadRoute ignores unmapped paths', () => {
    expect(preloadRoute('/nowhere')).toBeUndefined();
  });
});
