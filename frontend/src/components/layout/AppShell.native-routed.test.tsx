import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Link, MemoryRouter, Route, Routes } from 'react-router';
import { AuthProvider } from '@/contexts/AuthContext';
import { ThemeProvider } from '@/components/theme/ThemeProvider';
import { clearNativeIntents } from '@/hooks/useNativeIntents';
import { invalidateProjects } from '@/hooks/useProjectsCache';
import { notifySessionExpired, resetSessionExpiry } from '@/services/sessionExpiry';
import { ApiError } from '@/services/api';
import type { IntentOutput } from '@/services/intents';
import type { NativeIntent } from '@/services/nativeIntents';
import { AppShell } from './AppShell';
import IntentView from '@/pages/IntentView';

// Only service boundaries are replaced. Shell, providers, route page, activity
// panel, transcript, markdown, and composer are the deployed components.
const service = vi.hoisted(() => ({
  get: vi.fn(),
  outputs: vi.fn(),
  list: vi.fn(),
  publication: vi.fn(),
  interaction: vi.fn(),
  handlers: new Map<string, Set<(value: any) => void>>(),
  connect: vi.fn(async () => {}),
}));
// Shared drafts: in-memory Yjs relay + textarea stand-in (see test/collaborationFakes).
vi.mock('@/hooks/useYjsDocument', async () => await import('@/test/collaborationFakes'));
vi.mock(
  '@/components/CollaborativeTextarea',
  async () => await import('@/test/collaborationFakes'),
);
vi.mock('@/services/nativeIntents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/nativeIntents')>()),
  nativeIntentsService: service,
}));
vi.mock('@/services/auth', () => ({
  authService: {
    isAuthenticated: async () => true,
    logout: async () => {},
    getCurrentUser: async () => ({
      id: 'owner',
      username: 'owner',
      displayName: 'Owner',
      groups: [],
    }),
  },
}));
vi.mock('@/services/projects', () => ({
  projectsService: { list: async () => [], listMembers: async () => [] },
}));
vi.mock('@/services/realtime', () => {
  const subscribe = (name: string, fn: (value: any) => void) => {
    const set = service.handlers.get(name) ?? new Set();
    set.add(fn);
    service.handlers.set(name, set);
    return () => {
      set.delete(fn);
    };
  };
  return {
    realtimeService: {
      connect: service.connect,
      getStatus: () => 'connected',
      on: subscribe,
      onStatusChange: (fn: (value: any) => void) => subscribe('status', fn),
    },
  };
});
const time = '2026-10-01T00:00:00Z';
const detail = (id = 'one'): NativeIntent => ({
  id,
  projectId: 'project',
  executionBackend: 'native',
  title: `Run ${id}`,
  prompt: `Task ${id}`,
  harness: 'codex',
  status: 'READY',
  executionAvailable: true,
  package: {
    version: '2.9.0',
    source: { provider: 'github', repository: 'awslabs/aidlc-workflows', release: 'v2.9.0' },
  },
  createdAt: time,
  updatedAt: time,
  execution: {
    status: 'RUNNING',
    revision: 7,
    imageStatus: 'retained',
    attemptId: 'attempt',
    epoch: 1,
    startedAt: time,
    updatedAt: time,
    model: 'fixed-model',
    repository: { provider: 'github', repository: 'example/app', branch: 'main', commit: null },
    publicationId: null,
    projectionStatus: null,
  },
});
const row = (seq: number, content = `Visible activity ${seq}.`): IntentOutput => ({
  seq,
  kind: 'stdout',
  stageInstanceId: null,
  content,
  timestamp: time,
  display: { type: 'message', level: 'info', title: content, hiddenByDefault: false },
});
const page = (...outputs: IntentOutput[]) => ({ outputs, nextAfter: null });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((r, fail) => {
    resolve = r;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function emit(name: string, value: unknown) {
  act(() => {
    service.handlers.get(name)?.forEach((fn) => fn(value));
  });
}
const hint = (id = 'one') =>
  emit('agent.output', { executionBackend: 'native', projectId: 'project', intentId: id });
function workspace() {
  return render(
    <ThemeProvider>
      <AuthProvider>
        <MemoryRouter initialEntries={['/space/project/native-intent/one']}>
          <Link to="/space/project/native-intent/two">Switch run</Link>
          <Link to="/space/other-project/native-intent/one">Switch project</Link>
          <Routes>
            <Route element={<AppShell />}>
              <Route path="/space/:projectId/native-intent/:intentId" element={<IntentView />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    </ThemeProvider>,
  );
}
beforeEach(() => {
  vi.stubGlobal('localStorage', window.localStorage);
  vi.resetAllMocks();
  service.connect.mockResolvedValue(undefined);
  service.handlers.clear();
  localStorage.clear();
  resetSessionExpiry();
  clearNativeIntents();
  invalidateProjects();
  service.get.mockImplementation(async (_project, id) => detail(id));
  service.outputs.mockResolvedValue(page());
  service.list.mockResolvedValue({ items: [], enabled: true });
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({
      matches: true,
      addEventListener() {},
      removeEventListener() {},
    }),
  });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function waitingDetail(status: 'WAITING_FOR_INPUT' | 'AWAITING_USER' | 'RECOVERY_REQUIRED') {
  const waiting = detail();
  waiting.execution = {
    ...waiting.execution!,
    status,
    publicationId: 'publication',
    projectionStatus: 'complete',
    ...(status === 'AWAITING_USER' ? { interactionId: INTERACTION_ID, turnSequence: 1 } : {}),
  };
  service.get.mockResolvedValue(waiting);
  service.publication.mockResolvedValue({
    id: 'publication',
    sequence: 1,
    createdAt: time,
    files: [],
    question: null,
    projectionStatus: 'complete',
  });
  service.interaction.mockResolvedValue({
    id: INTERACTION_ID,
    sequence: 1,
    kind: 'assistant_turn',
    harness: 'codex',
    publicationId: 'publication',
    messages: [{ type: 'text', text: 'Committed workflow question.' }],
    contentSha256: 'a'.repeat(64),
    createdAt: time,
    response: null,
  });
  return waiting;
}

it.each(['WAITING_FOR_INPUT', 'AWAITING_USER', 'RECOVERY_REQUIRED'] as const)(
  'refreshes a projected %s wait in the shared workspace without an activity notification',
  async (status) => {
    vi.useFakeTimers();
    const waiting = waitingDetail(status);
    await act(async () => workspace());
    expect(service.get).toHaveBeenCalledTimes(1);
    service.get.mockResolvedValueOnce({
      ...waiting,
      execution: { ...waiting.execution!, status: 'CANCELLED', revision: 8 },
    });
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(screen.getByText('Execution cancelled')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Cancel execution' })).not.toBeInTheDocument();
    expect(service.get).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTimeAsync(15000));
    expect(service.get).toHaveBeenCalledTimes(2);
  },
);

const waitingCleanupCases = (['run', 'project', 'expiry', 'unmount'] as const).flatMap((boundary) =>
  (['success', 'denial'] as const).map((outcome) => ({ boundary, outcome })),
);
it.each(waitingCleanupCases)(
  'discards a waiting poll $outcome across a $boundary boundary and cleans up its subscription',
  async ({ boundary, outcome }) => {
    vi.useFakeTimers();
    const waiting = waitingDetail('WAITING_FOR_INPUT');
    let view!: ReturnType<typeof workspace>;
    await act(async () => {
      view = workspace();
    });
    expect(service.handlers.get('agent.output')?.size).toBe(1);
    const oldPoll = deferred<NativeIntent>();
    service.get.mockReturnValueOnce(oldPoll.promise);
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(service.get).toHaveBeenCalledTimes(2);
    const replaced = boundary === 'run' || boundary === 'project';
    const next = {
      ...detail(boundary === 'run' ? 'two' : 'one'),
      projectId: boundary === 'project' ? 'other-project' : 'project',
      title: 'Newly authorized run',
      prompt: 'Newly authorized task',
      execution: { ...detail().execution!, status: 'STOPPED' as const },
    };
    service.get.mockResolvedValueOnce(next);
    await act(async () => {
      if (boundary === 'run' || boundary === 'project') {
        fireEvent.click(
          screen.getByRole('link', { name: boundary === 'run' ? 'Switch run' : 'Switch project' }),
        );
      } else if (boundary === 'expiry') notifySessionExpired();
      else view.unmount();
    });
    expect(screen.queryByText(waiting.prompt)).not.toBeInTheDocument();
    if (replaced) {
      expect(screen.getByText(next.prompt)).toBeVisible();
      expect(service.get).toHaveBeenLastCalledWith(next.projectId, next.id);
    }
    await act(async () => {
      if (outcome === 'success') oldPoll.resolve(waiting);
      else oldPoll.reject(new ApiError(403, 'Old identity denied'));
    });
    const reads = service.get.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(15000));
    expect(service.get).toHaveBeenCalledTimes(reads);
    expect(screen.queryByText(waiting.prompt)).not.toBeInTheDocument();
    expect(service.handlers.get('agent.output')?.size).toBe(replaced ? 1 : 0);
    if (replaced) expect(screen.getByText(next.prompt)).toBeVisible();
    view.unmount();
    expect(service.handlers.get('agent.output')?.size).toBe(0);
  },
);

it('renders paginated history in the real Agent transcript while running, and replays reconnect and reload', async () => {
  service.outputs
    .mockResolvedValueOnce({
      outputs: Array.from({ length: 64 }, (_, index) => row(index + 1)),
      nextAfter: 64,
    })
    .mockResolvedValueOnce(page(row(65)));
  const view = workspace();
  expect(await screen.findByText('Visible activity 65.')).toBeVisible();
  expect(screen.getByText('Visible activity 1.')).toBeVisible();
  expect(document.querySelectorAll('[data-output-type="message"]')).toHaveLength(65);
  expect(screen.getByText('Agent running')).toBeVisible();
  expect(screen.getByRole('tab', { name: 'Agent' })).toHaveAttribute('data-state', 'active');
  expect(service.outputs).toHaveBeenCalledWith('project', 'one', 64);
  service.outputs.mockResolvedValueOnce(page(row(66)));
  emit('status', 'disconnected');
  emit('status', 'connected');
  expect(await screen.findByText('Visible activity 66.')).toBeVisible();
  expect(screen.getAllByText('Visible activity 65.')).toHaveLength(1);
  expect(document.querySelectorAll('[data-output-type="message"]')).toHaveLength(66);
  view.unmount();
  service.outputs.mockResolvedValueOnce(page(row(1), row(65), row(66)));
  workspace();
  expect(await screen.findByText('Visible activity 66.')).toBeVisible();
  expect(service.outputs.mock.calls.filter((call) => call[2] === 0)).toHaveLength(2);
});
it('drains an invalidation received during a history read without waiting for periodic polling', async () => {
  workspace();
  await screen.findByText('Agent running');
  await waitFor(() => expect(service.handlers.get('agent.output')?.size).toBe(1));
  const pending = deferred<ReturnType<typeof page>>();
  service.outputs
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValueOnce(page(row(2, 'Arrived during read.')));
  hint();
  hint();
  await act(async () => pending.resolve(page(row(1, 'Earlier durable text.'))));
  expect(await screen.findByText('Arrived during read.', {}, { timeout: 1000 })).toBeVisible();
  expect(screen.getByText('Earlier durable text.')).toBeVisible();
});
it('removes protected history on revocation and ignores a late successful read on the connected identity', async () => {
  service.outputs.mockResolvedValueOnce(page(row(1, 'Protected old text.')));
  workspace();
  await screen.findByText('Protected old text.');
  const pending = deferred<ReturnType<typeof page>>();
  service.outputs.mockReturnValueOnce(pending.promise);
  hint();
  service.get.mockRejectedValueOnce(new ApiError(403, 'Forbidden', { error: 'Forbidden' }));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh status' }));
  await screen.findByText(/Native intent access is no longer available/);
  expect(screen.queryByText('Protected old text.')).not.toBeInTheDocument();
  await act(async () => pending.resolve(page(row(2, 'Late protected text.'))));
  expect(screen.queryByText('Late protected text.')).not.toBeInTheDocument();
  expect(screen.queryByText('Task one')).not.toBeInTheDocument();
});
it('resets history and its cursor on a run switch and rejects old-run responses and hints', async () => {
  service.outputs.mockResolvedValueOnce(page(row(17, 'First run text.')));
  workspace();
  await screen.findByText('First run text.');
  const pending = deferred<ReturnType<typeof page>>();
  service.outputs.mockReturnValueOnce(pending.promise);
  hint();
  service.outputs.mockResolvedValueOnce(page(row(1, 'Second run text.')));
  fireEvent.click(screen.getByRole('link', { name: 'Switch run' }));
  expect(await screen.findByText('Second run text.')).toBeVisible();
  expect(service.outputs).toHaveBeenCalledWith('project', 'two', 0);
  await act(async () => pending.resolve(page(row(18, 'First run late text.'))));
  hint();
  expect(screen.queryByText('First run text.')).not.toBeInTheDocument();
  expect(screen.queryByText('First run late text.')).not.toBeInTheDocument();
});
// Protected interaction IDs are content-addressed SHA-256 values.
const INTERACTION_ID = 'c'.repeat(64);
it('applies image policy changes at the same execution revision while preserving committed content and reply draft', async () => {
  const waiting = detail();
  waiting.execution = {
    ...waiting.execution!,
    status: 'AWAITING_USER',
    publicationId: 'publication',
    interactionId: INTERACTION_ID,
    turnSequence: 1,
  };
  service.get.mockResolvedValue(waiting);
  service.publication.mockResolvedValue({
    id: 'publication',
    sequence: 1,
    createdAt: time,
    files: [],
    question: null,
    projectionStatus: 'complete',
  });
  service.interaction.mockResolvedValue({
    id: INTERACTION_ID,
    sequence: 1,
    kind: 'assistant_turn',
    harness: 'codex',
    publicationId: 'publication',
    messages: [{ type: 'text', text: 'Committed workflow question.' }],
    contentSha256: 'a'.repeat(64),
    createdAt: time,
    response: null,
  });
  workspace();
  await screen.findByText('Committed workflow question.');
  const reply = await screen.findByRole('textbox', { name: 'Reply to AI-DLC' });
  expect(screen.getAllByRole('textbox', { name: 'Reply to AI-DLC' })).toHaveLength(1);
  expect(document.querySelectorAll('#native-reply')).toHaveLength(1);
  // Read-only until the revision-specific shared draft is open.
  await waitFor(() => expect(reply).not.toHaveAttribute('readonly'));
  fireEvent.change(reply, { target: { value: 'Keep my composer draft.' } });
  expect(screen.getByRole('button', { name: 'Send reply' })).toBeEnabled();
  service.get.mockResolvedValue({
    ...waiting,
    execution: { ...waiting.execution!, imageStatus: 'revoked' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh status' }));
  await screen.findByText(/Execution is unavailable for this runtime image/);
  expect(screen.getByText('Committed workflow question.')).toBeVisible();
  expect(reply).toHaveValue('Keep my composer draft.');
  expect(screen.getByRole('button', { name: 'Send reply' })).toBeDisabled();
  service.get.mockResolvedValue(waiting);
  fireEvent.click(screen.getByRole('button', { name: 'Refresh status' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Send reply' })).toBeEnabled());
  expect(reply).toHaveValue('Keep my composer draft.');
});
