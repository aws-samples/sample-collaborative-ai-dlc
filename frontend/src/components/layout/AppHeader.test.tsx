import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { TooltipProvider } from '@/components/ui/tooltip';
const state = vi.hoisted(() => ({
  intent: null as unknown,
  native: [] as unknown[],
  toggle: vi.fn(),
}));
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { username: 'test' }, logout: vi.fn(), isPlatformAdmin: false }),
}));
vi.mock('@/contexts/IntentContext', () => ({
  useIntentOptional: () => (state.intent ? { detail: { intent: state.intent } } : undefined),
}));
vi.mock('@/hooks/useProjectsCache', () => ({
  useProjectCache: () => ({ project: { id: 'p1', name: 'Space' } }),
  useProjectSprintsCache: () => ({ sprints: [] }),
}));
vi.mock('@/hooks/useNativeIntents', () => ({
  getNativeListing: () => ({ items: state.native }),
  useNativeListingVersion: () => {},
}));
vi.mock('@/components/theme/ThemeToggle', () => ({ ThemeToggle: () => null }));
import { AppHeader } from './AppHeader';
const native = {
  id: 'same',
  projectId: 'p1',
  executionBackend: 'native',
  title: 'Protected native',
  status: 'READY',
};
function Header() {
  const location = useLocation();
  return (
    <TooltipProvider>
      <AppHeader
        onToggleSidebar={vi.fn()}
        onToggleActivity={state.toggle}
        onOpenCommand={vi.fn()}
        sidebarCollapsed={false}
        activityPanelOpen={false}
      />
      <output data-testid="path">{location.pathname}</output>
    </TooltipProvider>
  );
}
const renderHeader = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/space/:projectId/native-intent/new" element={<Header />} />
        <Route path="/space/:projectId/native-intent/:intentId" element={<Header />} />
        <Route path="/space/:projectId/intent/:intentId" element={<Header />} />
        <Route path="/space/:projectId/intent/:intentId/graph" element={<Header />} />
        <Route path="*" element={<Header />} />
      </Routes>
    </MemoryRouter>,
  );
beforeEach(() => {
  state.intent = null;
  state.native = [];
  vi.clearAllMocks();
});
it('renders top-level navigation without an active platform intent', () => {
  renderHeader('/dashboard');
  expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toHaveTextContent('Spaces');
  expect(screen.queryByRole('button', { name: 'Toggle activity panel' })).not.toBeInTheDocument();
});
it('native breadcrumb stays on native status even if platform context has the same UUID', () => {
  state.native = [native];
  state.intent = { id: 'same', projectId: 'p1', title: 'Platform title' };
  renderHeader('/space/p1/native-intent/same');
  const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' });
  expect(within(crumbs).getByText('Workspace ready')).toBeInTheDocument();
  expect(within(crumbs).queryByText('Work')).not.toBeInTheDocument();
  expect(within(crumbs).queryByText('Platform title')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Toggle activity panel' })).toBeInTheDocument();
  fireEvent.click(within(crumbs).getByRole('button', { name: 'Protected native' }));
  expect(screen.getByTestId('path')).toHaveTextContent('/space/p1/native-intent/same');
});
it('uses a native status breadcrumb without requiring any platform provider or cached summary', () => {
  renderHeader('/space/p1/native-intent/same');
  fireEvent.click(screen.getByRole('button', { name: 'Native intent' }));
  expect(screen.getByTestId('path')).toHaveTextContent('/space/p1/native-intent/same');
  expect(screen.getByText('Status')).toBeInTheDocument();
});
it.each([false, true])(
  'keeps breadcrumb navigation truthful when status is unavailable (previous execution: %s)',
  (previous) => {
    state.native = [
      {
        ...native,
        executionStatusUnavailable: true,
        ...(previous
          ? { execution: { status: 'CANCELLED', revision: 1, updatedAt: '2026-09-29T08:00:00Z' } }
          : {}),
      },
    ];
    renderHeader('/space/p1/native-intent/same');
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(
      within(crumbs).getByText(
        previous ? 'Execution cancelled (status outdated)' : 'Execution status unavailable',
      ),
    ).toBeInTheDocument();
    expect(within(crumbs).queryByText('Workspace ready')).not.toBeInTheDocument();
    fireEvent.click(within(crumbs).getByRole('button', { name: 'Protected native' }));
    expect(screen.getByTestId('path')).toHaveTextContent('/space/p1/native-intent/same');
  },
);
it('labels native creation without platform activity controls', () => {
  renderHeader('/space/p1/native-intent/new');
  expect(screen.getByText('New native intent')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Toggle activity panel' })).not.toBeInTheDocument();
});
it('preserves platform graph breadcrumbs and activity control', () => {
  state.intent = { id: 'same', projectId: 'p1', title: 'Platform title' };
  renderHeader('/space/p1/intent/same/graph');
  expect(screen.getByText('Graph')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Toggle activity panel' }));
  expect(state.toggle).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Platform title' }));
  expect(screen.getByTestId('path')).toHaveTextContent('/space/p1/intent/same');
});
it('does not reuse a platform context title from another project', () => {
  state.intent = { id: 'same', projectId: 'p2', title: 'Other project title' };
  renderHeader('/space/p1/intent/same/graph');
  expect(screen.queryByText('Other project title')).not.toBeInTheDocument();
});
