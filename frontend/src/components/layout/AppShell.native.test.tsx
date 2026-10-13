import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { Link, MemoryRouter, Route, Routes } from 'react-router';
import { clearIntentCache, useIntentOptional } from '@/contexts/IntentContext';
import { clearNativeIntents } from '@/hooks/useNativeIntents';
const state = vi.hoisted(() => ({
  get: vi.fn(),
  nativeGet: vi.fn(),
  compiled: vi.fn(),
  discussions: vi.fn(),
  subscriptions: new Set<string>(),
}));
// Shared drafts: in-memory Yjs relay + textarea stand-in (see test/collaborationFakes).
vi.mock('@/hooks/useYjsDocument', async () => await import('@/test/collaborationFakes'));
vi.mock(
  '@/components/CollaborativeTextarea',
  async () => await import('@/test/collaborationFakes'),
);
vi.mock('@/services/intents', () => ({ intentsService: { get: state.get } }));
vi.mock('@/services/nativeIntents', () => ({
  nativeIntentsService: {
    get: state.nativeGet,
    outputs: async () => ({ outputs: [], nextAfter: null }),
  },
}));
vi.mock('@/services/workflows', () => ({
  workflowsService: { compiled: state.compiled, get: async () => ({ phases: [] }) },
}));
vi.mock('@/services/realtime', () => ({
  realtimeService: {
    onStatusChange: () => () => {},
    connect: async () => {},
    disconnect: vi.fn(),
    on: () => () => {},
  },
}));
vi.mock('@/hooks/useIntentEvents', () => ({
  useIntentEvents: (projectId: string, intentId: string) => {
    useEffect(() => {
      if (!projectId || !intentId) return;
      const key = `${projectId}:${intentId}`;
      state.subscriptions.add(key);
      return () => {
        state.subscriptions.delete(key);
      };
    }, [projectId, intentId]);
  },
}));
vi.mock('@/components/discussion', () => ({
  DiscussionProvider: ({ children, backend }: { children: ReactNode; backend?: string }) => {
    state.discussions(backend ?? 'platform');
    return <>{children}</>;
  },
}));
vi.mock('@/components/layout/AppHeader', () => ({
  AppHeader: () => {
    const context = useIntentOptional();
    return (
      <header>
        {context?.executionBackend === 'native'
          ? 'Native context'
          : context
            ? context.detail?.intent.title || 'Loading platform'
            : 'No platform context'}
      </header>
    );
  },
}));
vi.mock('@/components/layout/AppSidebar', () => ({ AppSidebar: () => null }));
vi.mock('@/components/layout/StatusBar', () => ({ StatusBar: () => null }));
vi.mock('@/components/layout/CommandPalette', () => ({ CommandPalette: () => null }));
vi.mock('@/components/layout/SprintPipelineBar', () => ({ SprintPipelineBar: () => null }));
vi.mock('@/components/layout/ActivityPanel', () => ({
  ActivityPanel: () => <p>Legacy activity</p>,
}));
vi.mock('@/components/layout/IntentActivityPanel', () => ({
  IntentActivityPanel: () => (
    <p>
      {useIntentOptional()?.executionBackend === 'native' ? 'Native activity' : 'Platform activity'}
    </p>
  ),
}));
vi.mock('@/hooks/useProjectsCache', () => ({ useProjectSprintsCache: () => ({ sprints: [] }) }));
vi.mock('@/hooks/useMediaQuery', () => ({ useMediaQuery: () => true }));
vi.mock('@/hooks/useResizablePanel', () => ({
  useResizablePanel: () => ({
    width: 380,
    handleResizeStart: vi.fn(),
    handleResizeKey: vi.fn(),
    resetWidth: vi.fn(),
  }),
}));
import { AppShell } from './AppShell';
import NativeIntentPage from '@/pages/NativeIntentPage';
const dto = {
  intent: {
    id: 'same',
    executionId: 'same',
    projectId: 'p1',
    title: 'Platform cached title',
    prompt: 'Platform prompt',
    status: 'DRAFT',
    workflowId: 'wf',
    workflowVersion: 1,
  },
  stages: [],
  events: [],
  gates: [],
  metrics: [],
  outputs: [],
  sensorRuns: [],
  artifacts: [],
};
const renderShell = (native = false) =>
  render(
    <MemoryRouter initialEntries={[`/space/p1/${native ? 'native-intent' : 'intent'}/same`]}>
      <Link to="/space/p1/native-intent/same">Open native</Link>
      <Link to="/space/p1/intent/same">Open platform</Link>
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/space/:projectId/intent/:intentId" element={<p>Platform body</p>} />
          <Route path="/space/:projectId/native-intent/:intentId" element={<NativeIntentPage />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
beforeEach(() => {
  clearIntentCache();
  clearNativeIntents();
  vi.clearAllMocks();
  state.subscriptions.clear();
  state.get.mockResolvedValue(dto);
  state.compiled.mockResolvedValue({ graph: { nodes: [], edges: [] } });
  state.nativeGet.mockResolvedValue({
    id: 'same',
    projectId: 'p1',
    executionBackend: 'native',
    title: 'Protected native title',
    prompt: 'Protected native prompt',
    status: 'READY',
    harness: 'kiro',
    package: {
      version: '2.9.0',
      source: { provider: 'github', repository: 'owner/fork', release: 'v2.9.0' },
    },
    createdAt: '2026-09-29T07:00:00Z',
    updatedAt: '2026-09-29T07:00:00Z',
  });
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({ matches: true })),
  });
});
it('native routes mount the shared context with the native adapter and fetch only the protected native detail', async () => {
  renderShell(true);
  expect(await screen.findByText('Protected native prompt')).toBeInTheDocument();
  expect(screen.getByText('Native context')).toBeInTheDocument();
  expect(state.nativeGet).toHaveBeenCalledWith('p1', 'same');
  expect(state.get).not.toHaveBeenCalled();
  expect(state.compiled).not.toHaveBeenCalled();
  // Only the native-scoped discussion provider may mount on a native route.
  expect(state.discussions).toHaveBeenCalledWith('native');
  expect(state.discussions).not.toHaveBeenCalledWith('platform');
  expect(state.subscriptions.size).toBe(0);
});
it('drops loaded platform state and subscriptions on navigation to native with the same UUID', async () => {
  renderShell();
  await screen.findByText('Platform cached title');
  expect(state.subscriptions.has('p1:same')).toBe(true);
  fireEvent.click(screen.getByRole('link', { name: 'Open native' }));
  expect(await screen.findByText('Protected native title')).toBeInTheDocument();
  expect(screen.queryByText('Platform cached title')).not.toBeInTheDocument();
  expect(screen.queryByText('Platform activity')).not.toBeInTheDocument();
  expect(state.subscriptions.size).toBe(0);
  expect(state.get).toHaveBeenCalledTimes(1);
});
it('ignores a late platform response after same-UUID native navigation, including cache and compiler writes', async () => {
  let resolve!: (value: typeof dto) => void;
  state.get
    .mockReturnValueOnce(
      new Promise<typeof dto>((res) => {
        resolve = res;
      }),
    )
    .mockReturnValueOnce(new Promise(() => {}));
  renderShell();
  await waitFor(() => expect(state.get).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole('link', { name: 'Open native' }));
  await screen.findByText('Protected native title');
  await act(async () => {
    resolve(dto);
  });
  expect(state.compiled).not.toHaveBeenCalled();
  expect(state.subscriptions.size).toBe(0);
  expect(screen.queryByText('Platform cached title')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('link', { name: 'Open platform' }));
  await waitFor(() => expect(state.get).toHaveBeenCalledTimes(2));
  expect(screen.getByText('Loading platform')).toBeInTheDocument();
  expect(screen.queryByText('Platform cached title')).not.toBeInTheDocument();
});
