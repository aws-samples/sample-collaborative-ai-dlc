import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router';
import type { NativeListing } from '@/hooks/useNativeIntents';
import type { NativeDiscoveredIntent } from '@/lib/intentDiscovery';
const state = vi.hoisted(() => ({
  projects: [] as unknown[],
  deleteProject: vi.fn(),
  refreshNative: vi.fn(),
  listing: {} as unknown,
}));
vi.mock('@/hooks/useProjectsCache', () => ({
  useProjectsCache: () => ({
    projects: state.projects,
    loading: false,
    error: null,
    refresh: vi.fn(),
    invalidate: vi.fn(),
  }),
  projectLastActivityAt: () => null,
}));
vi.mock('@/hooks/useNativeIntents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useNativeIntents')>()),
  refreshNativeIntents: state.refreshNative,
  getNativeListing: () => state.listing,
}));
vi.mock('@/services/projects', () => ({ projectsService: { delete: state.deleteProject } }));
vi.mock('@/components/CreateProjectModal', () => ({ CreateProjectModal: () => null }));
import Dashboard from './Dashboard';

const empty: NativeListing = {
  items: [],
  nextCursor: null,
  loaded: true,
  loading: false,
  error: null,
  denied: false,
  disabled: false,
  pages: 1,
};
const native = {
  ...empty,
  items: [
    {
      id: 'same',
      projectId: 'p1',
      executionBackend: 'native' as const,
      title: 'Native workspace',
      harness: 'kiro' as const,
      status: 'READY' as const,
      package: {
        version: '2.9.0',
        source: { provider: 'github', repository: 'owner/repo', release: 'v2.9.0' },
      },
      createdAt: '2026-09-29T07:00:00Z',
      updatedAt: '2026-09-29T07:00:00Z',
    },
  ],
};
const project = (listing: NativeListing = native) => ({
  project: {
    id: 'p1',
    name: 'Space One',
    kind: 'v2',
    userRole: 'owner',
    createdAt: '2026-09-29T07:00:00Z',
  },
  latestIntent: null,
  latestSprint: null,
  activity: { inProgress: 0, attention: 0 },
  nativeIntents: listing,
});
const renderPage = () =>
  render(
    <MemoryRouter>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/space/:projectId" element={<p>Space route</p>} />
        <Route
          path="/space/:projectId/native-intent/:intentId"
          element={<p>Native status route</p>}
        />
      </Routes>
    </MemoryRouter>,
  );
beforeEach(() => {
  vi.clearAllMocks();
  state.projects = [project()];
  state.listing = native;
  state.refreshNative.mockResolvedValue(undefined);
});

it.each(['Grid view', 'List view'])(
  'discovers native status and disables native space deletion in %s',
  async (view) => {
    renderPage();
    await userEvent.click(screen.getByRole('button', { name: view }));
    expect(screen.getByText('Native')).toBeInTheDocument();
    expect(screen.getByText('Workspace ready')).toBeInTheDocument();
    const remove = screen.getByRole('button', { name: 'Delete Space One' });
    expect(remove).toBeDisabled();
    fireEvent.click(remove);
    expect(state.deleteProject).not.toHaveBeenCalled();
    await userEvent.click(
      screen.getByRole('button', { name: 'Native Native workspace: Workspace ready' }),
    );
    expect(screen.getByText('Native status route')).toBeInTheDocument();
    expect(screen.queryByText('Space route')).not.toBeInTheDocument();
  },
);
it.each([
  ['DISPATCHING', 'Continuing agent'],
  ['RUNNING', 'Agent running'],
  ['WAITING_FOR_INPUT', 'Waiting for input'],
  ['AWAITING_USER', 'Awaiting your reply'],
  ['RECOVERY_REQUIRED', 'Session recovery required'],
  ['RECOVERING', 'Restoring session'],
  ['STOPPED', 'Agent stopped'],
  ['FAILED', 'Execution failed'],
  ['CANCELLED', 'Execution cancelled'],
] as const)(
  'keeps execution %s distinct in dashboard previews and navigation',
  async (status, label) => {
    const execution: NativeDiscoveredIntent['execution'] = {
      status,
      responsePending: status === 'DISPATCHING',
      revision: 1,
      updatedAt: '2026-09-29T08:01:00Z',
    };
    state.projects = [project({ ...native, items: [{ ...native.items[0], execution }] })];
    renderPage();
    for (const view of ['Grid view', 'List view']) {
      await userEvent.click(screen.getByRole('button', { name: view }));
      expect(
        screen.getByRole('button', { name: `Native Native workspace: ${label}` }),
      ).toBeInTheDocument();
      expect(screen.queryByText('Workspace ready')).not.toBeInTheDocument();
    }
    await userEvent.click(
      screen.getByRole('button', { name: `Native Native workspace: ${label}` }),
    );
    expect(screen.getByText('Native status route')).toBeInTheDocument();
  },
);
it.each([
  ['DRAFT', 'Draft'],
  ['PREPARING', 'Preparing workspace'],
  ['FAILED', 'Preparation failed'],
] as const)('keeps preparation %s distinct in dashboard previews', (status, label) => {
  state.projects = [project({ ...native, items: [{ ...native.items[0], status }] })];
  renderPage();
  expect(
    screen.getByRole('button', { name: `Native Native workspace: ${label}` }),
  ).toBeInTheDocument();
});
it('shows a visible partial error with a native retry', async () => {
  state.projects = [project({ ...native, error: 'Native listing unavailable' })];
  renderPage();
  expect(screen.getByRole('alert')).toHaveTextContent('Native listing unavailable');
  await userEvent.click(screen.getByRole('button', { name: 'Retry native intents' }));
  expect(state.refreshNative).toHaveBeenCalledWith('p1', 'refresh', true);
});
it('guards deletion when a native intent appears after the confirmation dialog opens', async () => {
  state.projects = [project({ ...native, items: [] })];
  renderPage();
  await userEvent.click(screen.getByRole('button', { name: 'Delete Space One' }));
  await userEvent.click(screen.getByRole('button', { name: 'Delete Space' }));
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/native intents/));
  expect(state.refreshNative).toHaveBeenCalledWith('p1', 'refresh', true);
  expect(state.deleteProject).not.toHaveBeenCalled();
});
it('retains platform space deletion when a fresh, complete native list is empty', async () => {
  state.projects = [project({ ...native, items: [] })];
  state.listing = empty;
  renderPage();
  await userEvent.click(screen.getByRole('button', { name: 'Delete Space One' }));
  await userEvent.click(screen.getByRole('button', { name: 'Delete Space' }));
  await waitFor(() => expect(state.deleteProject).toHaveBeenCalledWith('p1'));
});
it.each([
  { loaded: false },
  { loading: true },
  { nextCursor: 'more' },
  { denied: true },
  { error: 'unavailable' },
])('guards space deletion while the native inventory is uncertain: %j', (patch) => {
  state.projects = [project({ ...native, items: [], ...patch })];
  renderPage();
  expect(screen.getByRole('button', { name: 'Delete Space One' })).toBeDisabled();
});
it('preserves ordinary deletion in a non-opt-in space with an exact disabled response', async () => {
  const disabled = { ...native, items: [], disabled: true };
  state.projects = [project(disabled)];
  state.listing = disabled;
  renderPage();
  await userEvent.click(screen.getByRole('button', { name: 'Delete Space One' }));
  await userEvent.click(screen.getByRole('button', { name: 'Delete Space' }));
  await waitFor(() => expect(state.deleteProject).toHaveBeenCalledWith('p1'));
});
