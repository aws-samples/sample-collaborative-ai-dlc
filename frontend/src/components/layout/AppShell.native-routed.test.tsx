import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Link, MemoryRouter, Route, Routes } from 'react-router';
import { AuthProvider } from '@/contexts/AuthContext';
import { ThemeProvider } from '@/components/theme/ThemeProvider';
import {
  clearNativeIntents,
  getNativeListing,
  refreshNativeIntents,
} from '@/hooks/useNativeIntents';
import { invalidateProjects } from '@/hooks/useProjectsCache';
import { notifySessionExpired, resetSessionExpiry } from '@/services/sessionExpiry';
import { ApiError } from '@/services/api';
import type { IntentOutput } from '@/services/intents';
import type { NativeIntent } from '@/services/nativeIntents';
import { AppShell } from './AppShell';
import IntentView from '@/pages/IntentView';
import NewIntentPage from '@/pages/NewIntentPage';
import { ProtectedRoute } from '@/components/ProtectedRoute';

// Only service boundaries are replaced. Shell, providers, route page, activity
// panel, transcript, markdown, and composer are the production components.
const service = vi.hoisted(() => ({
  get: vi.fn(),
  outputs: vi.fn(),
  list: vi.fn(),
  publication: vi.fn(),
  interaction: vi.fn(),
  historyList: vi.fn(),
  revision: vi.fn(),
  decision: vi.fn(),
  revisionFile: vi.fn(),
  savePrompt: vi.fn(),
  start: vi.fn(),
  recover: vi.fn(),
  create: vi.fn(),
  prepare: vi.fn(),
  capabilities: vi.fn(),
  projectList: vi.fn(),
  platformGet: vi.fn(),
  workflowList: vi.fn(),
  workflowPackage: vi.fn(),
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
vi.mock('@/services/nativeHistory', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/nativeHistory')>()),
  nativeHistoryService: {
    list: service.historyList,
    revision: service.revision,
    decision: service.decision,
    file: service.revisionFile,
  },
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
  projectsService: { list: service.projectList, listMembers: async () => [] },
}));
vi.mock('@/services/intents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/intents')>()),
  intentsService: { list: async () => [], get: service.platformGet },
}));
vi.mock('@/services/workflowSources', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/workflowSources')>()),
  workflowSourcesService: {
    list: service.workflowList,
    getPackageImport: service.workflowPackage,
  },
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
      disconnect: vi.fn(),
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
    recoveryMode: 'efs-workspace-v1',
    status: 'RUNNING',
    revision: 7,
    imageStatus: 'retained',
    attemptId: 'attempt',
    epoch: 1,
    startedAt: time,
    updatedAt: time,
    model: 'fixed-model',
    credentialSource: 'space',
    imageDigest: `sha256:${'e'.repeat(64)}`,
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
function workspace(search = '') {
  return render(
    <ThemeProvider>
      <AuthProvider>
        <MemoryRouter initialEntries={[`/space/project/native-intent/one${search}`]}>
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
  service.projectList.mockResolvedValue([]);
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

it.each(['project', '40000000-0000-4000-8000-000000000005'])(
  'creates from normal New intent in %s, reviews its application source, corrects and starts through the native shell adapter',
  async (projectId) => {
    const sourceId = 'a'.repeat(64);
    const packageJobId = '10000000-0000-4000-8000-000000000001';
    const bindingRevision = '20000000-0000-4000-8000-000000000002';
    const source = { provider: 'github', repository: 'owner/application' };
    const query = new URLSearchParams({
      backend: 'native',
      sourceId,
      packageJobId,
      bindingRevision,
    });
    service.projectList.mockResolvedValue([
      {
        id: projectId,
        name: 'Shared space',
        kind: 'v2',
        userRole: 'member',
        agentCli: 'codex',
        gitProvider: 'github',
        gitRepo: source.repository,
        trackers: [],
        repos: [{ provider: source.provider, url: source.repository, role: 'primary' }],
      },
    ]);
    invalidateProjects();
    service.capabilities.mockResolvedValue({
      preparationEnabled: true,
      executionEnabled: true,
      unavailableHarnesses: { kiro: 'NATIVE_EXECUTION_KIRO_UNAVAILABLE' },
    });
    service.workflowList.mockResolvedValue([
      {
        sourceId,
        revision: bindingRevision,
        status: 'active',
        repository: 'awslabs/aidlc-workflows',
      },
    ]);
    service.workflowPackage.mockResolvedValue({
      jobId: packageJobId,
      sourceId,
      requestedRelease: 'v2.11.1',
      state: 'SUCCEEDED',
      package: { version: '2.11.1', release: 'v2.11.1', commit: 'b'.repeat(40) },
    });
    let current: NativeIntent;
    service.create.mockImplementation(async (_project, request) => {
      current = {
        ...detail(request.intentId),
        projectId,
        title: request.title,
        prompt: request.prompt,
        promptRevision: 0,
        applicationSource: request.applicationSource,
        status: 'DRAFT',
        execution: null,
        package: {
          version: '2.11.1',
          source: { provider: 'github', repository: 'awslabs/aidlc-workflows', release: 'v2.11.1' },
        },
      };
      return current;
    });
    service.get.mockImplementation(async () => current);
    service.savePrompt.mockImplementation(async (_project, _intent, request) => {
      current = {
        ...current,
        prompt: request.prompt,
        promptRevision: request.expectedRevision + 1,
      };
      return current;
    });
    // The service port represents completed preparation; no provisioning occurs.
    service.prepare.mockImplementation(async () => {
      current = { ...current, status: 'READY' };
      return current;
    });
    service.start.mockImplementation(async () => {
      current = { ...current, execution: { ...detail().execution!, status: 'REQUESTED' } };
      return current;
    });
    const user = userEvent.setup();
    render(
      <ThemeProvider>
        <AuthProvider>
          <MemoryRouter initialEntries={[`/space/${projectId}/intent/new?${query}`]}>
            <Routes>
              <Route
                element={
                  <ProtectedRoute>
                    <AppShell />
                  </ProtectedRoute>
                }
              >
                <Route path="/space/:projectId/intent/new" element={<NewIntentPage />} />
                <Route path="/space/:projectId/native-intent/:intentId" element={<IntentView />} />
                <Route path="/space/:projectId/intent/:intentId" element={<IntentView />} />
              </Route>
            </Routes>
          </MemoryRouter>
        </AuthProvider>
      </ThemeProvider>,
    );
    await user.type(await screen.findByLabelText('Title'), 'Request from New intent');
    await user.click(screen.getByRole('button', { name: 'Create native draft' }));
    await screen.findByRole('button', { name: 'Add prompt' });
    expect(service.create).toHaveBeenCalledTimes(1);
    expect(service.platformGet).not.toHaveBeenCalled();
    expect(service.start).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Intent actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Intent configuration' }));
    const configuration = screen.getByRole('dialog', { name: 'Intent configuration' });
    expect(within(configuration).getByText(source.repository)).toBeVisible();
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Add prompt' }));
    fireEvent.change(screen.getByLabelText('What would you like to build?'), {
      target: { value: 'Corrected in the shared workspace' },
    });
    await user.click(screen.getByRole('button', { name: 'Save prompt' }));
    await user.click(screen.getByRole('button', { name: 'Prepare workspace' }));
    await user.click(await screen.findByRole('button', { name: 'Start agent' }));
    expect(service.prepare).toHaveBeenCalledWith(projectId, current!.id);
    expect(service.start).toHaveBeenCalledWith(projectId, current!.id, expect.any(String), 1, 0);
    expect(service.savePrompt.mock.calls[0][2]).toMatchObject({
      expectedRevision: 0,
      prompt: 'Corrected in the shared workspace',
    });
    expect(service.platformGet).not.toHaveBeenCalled();
  },
);

it('saves a missing task prompt and starts its saved revision in the shared Intent workspace', async () => {
  const draft = { ...detail(), prompt: '', promptRevision: 0, execution: null };
  service.get.mockResolvedValue(draft);
  service.savePrompt.mockImplementation(async (_project, _intent, request) => ({
    ...draft,
    prompt: request.prompt,
    promptRevision: request.expectedRevision + 1,
  }));
  service.start.mockResolvedValue({
    ...detail(),
    prompt: 'Task from the shared workspace',
    promptRevision: 1,
  });
  workspace();
  await screen.findByRole('button', { name: 'Add prompt' });
  expect(screen.getByRole('button', { name: 'Start agent' })).toBeDisabled();
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Add prompt' })));
  fireEvent.change(screen.getByLabelText('What would you like to build?'), {
    target: { value: 'Task from the shared workspace' },
  });
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save prompt' })));
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Start agent' })));
  expect(service.start).toHaveBeenCalledWith('project', 'one', expect.any(String), 1, 0);
  expect(screen.queryByRole('button', { name: 'Edit prompt' })).not.toBeInTheDocument();
  expect(screen.getByText('Task from the shared workspace')).toBeInTheDocument();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it('reopens a named historical proposal and file in the shared shell and isolates late history on project navigation', async () => {
  const publicationId = 'a'.repeat(64);
  const fileId = `nf-${'b'.repeat(64)}`;
  const sha256 = 'c'.repeat(64);
  const file = {
    id: fileId,
    path: 'docs/proposal.custom',
    bytes: 19,
    sha256,
    role: 'artifact',
    mediaType: 'application/octet-stream',
  };
  const revision = {
    id: publicationId,
    sequence: 1,
    createdAt: time,
    files: [file],
    question: null,
    projectionStatus: 'pending',
    interactionId: 'd'.repeat(64),
    outcome: 'STOPPED',
    context: {
      projectId: 'project',
      executionId: 'one',
      attemptId: 'attempt',
      epoch: 1,
      packageId: `sha256:${sha256}`,
    },
  };
  service.historyList.mockResolvedValue({ items: [], nextBefore: null, gaps: [] });
  service.revision.mockResolvedValue(revision);
  service.decision.mockResolvedValue({
    interaction: { harness: 'codex', messages: [{ type: 'text', text: 'Earlier exact proposal' }] },
    answer: null,
  });
  const pending = deferred<any>();
  service.revisionFile.mockReturnValue(pending.promise);
  workspace(`?nativeRevision=1.${publicationId}&nativeFile=${fileId}%3A${sha256}`);
  expect(await screen.findByText('Earlier exact proposal')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Send reply' })).not.toBeInTheDocument();
  expect(service.interaction).not.toHaveBeenCalled();
  await act(async () =>
    pending.resolve({
      ...file,
      publicationId,
      publicationSequence: 1,
      encoding: 'utf8',
      content: 'Earlier exact bytes',
      truncated: false,
    }),
  );
  await screen.findByText('Earlier exact bytes');
  expect(screen.getByRole('link', { name: 'Link to file revision' })).toHaveAttribute(
    'href',
    `/space/project/native-intent/one?nativeRevision=1.${publicationId}&nativeFile=${fileId}%3A${sha256}`,
  );
  fireEvent.click(screen.getByRole('link', { name: 'Switch project' }));
  await waitFor(() => expect(service.get).toHaveBeenCalledWith('other-project', 'one'));
  expect(screen.queryByText('Earlier exact bytes')).not.toBeInTheDocument();
  expect(screen.queryByText('Earlier exact proposal')).not.toBeInTheDocument();
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

it('puts the supported question before the request and keeps pinned configuration in the shared dialog', async () => {
  waitingDetail('AWAITING_USER');
  workspace();
  const response = await screen.findByRole('region', { name: 'Published AI-DLC response' });
  expect(
    response.compareDocumentPosition(screen.getByText('Request')) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(screen.queryByText('fixed-model')).not.toBeInTheDocument();
  expect(screen.queryByText(/pilot|unit pull requests|approvals are not enabled/i)).toBeNull();
  for (const name of ['Start agent', 'Edit artifacts', 'Create unit PR', 'Delete intent']) {
    expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
  }
  expect(screen.getByRole('button', { name: 'Cancel execution' })).toBeEnabled();
  const reply = screen.getByRole('textbox', { name: 'Reply to AI-DLC' });
  expect(
    reply.compareDocumentPosition(
      screen.getByRole('region', { name: 'Workflow completion evidence' }),
    ) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  await waitFor(() => expect(reply).not.toHaveAttribute('readonly'));
  fireEvent.change(reply, { target: { value: 'Keep this shared answer draft.' } });
  await userEvent.click(screen.getByRole('button', { name: 'Intent actions' }));
  await userEvent.click(screen.getByRole('menuitem', { name: 'Intent configuration' }));
  const configuration = screen.getByRole('dialog', { name: 'Intent configuration' });
  expect(within(configuration).getByText(/pinned at Start/)).toBeVisible();
  for (const value of ['Codex', 'fixed-model', 'example/app', 'main', 'v2.9.0']) {
    expect(within(configuration).getByText(value)).toBeVisible();
  }
  expect(within(configuration).getByText('Space key')).toBeVisible();
  expect(within(configuration).getByText(`sha256:${'e'.repeat(64)}`)).toBeVisible();
  expect(
    within(configuration).getByText(/Native graph enrichment and optional debug archives are off/),
  ).toBeVisible();
  await userEvent.click(within(configuration).getAllByRole('button', { name: 'Close' })[0]);
  expect(reply).toHaveValue('Keep this shared answer draft.');
  await userEvent.click(screen.getByRole('tab', { name: 'Files' }));
  expect(screen.getByText('Work products')).toBeVisible();
  await userEvent.click(screen.getByRole('tab', { name: 'Overview' }));
  expect(screen.getByRole('textbox', { name: 'Reply to AI-DLC' })).toHaveValue(
    'Keep this shared answer draft.',
  );
});

it.each([
  ['SESSION_LOST', true, 'The previous runtime is stopped. Confirm a fresh session'],
  ['DELIVERY_UNCERTAIN', false, 'this command cannot be replayed through recovery'],
] as const)(
  'puts %s recovery before the published response and preserves recovery authority',
  async (reason, canRecover, explanation) => {
    const waiting = waitingDetail('AWAITING_USER');
    const recovery = {
      ...waiting,
      execution: {
        ...waiting.execution!,
        status: 'RECOVERY_REQUIRED' as const,
        stopStatus: { state: 'confirmed' as const, confirmedAt: '2026-09-29T12:00:00Z' },
        recovery: { id: 'recovery', reason, canRecover, workflowResumeState: 'created' as const },
      },
    };
    service.get.mockResolvedValue(recovery);
    workspace();
    const response = await screen.findByRole('region', { name: 'Published AI-DLC response' });
    const status = screen.getByRole('region', { name: 'Native execution status' });
    expect(within(status).getByText(explanation, { exact: false })).toBeVisible();
    expect(
      status.compareDocumentPosition(response) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Send reply' })).toBeDisabled();
    expect(service.recover).not.toHaveBeenCalled();
    if (canRecover) {
      const pending = deferred<NativeIntent>();
      service.recover.mockReturnValue(pending.promise);
      await userEvent.click(screen.getByRole('button', { name: 'Resume in fresh session' }));
      await userEvent.click(screen.getByRole('button', { name: 'Confirm fresh session' }));
      expect(screen.getByRole('button', { name: 'Requesting recovery…' })).toBeDisabled();
      await act(async () =>
        pending.resolve({
          ...recovery,
          execution: { ...recovery.execution, status: 'RECOVERING', revision: 8 },
        }),
      );
      expect(screen.getByText('Resuming in a fresh session')).toBeVisible();
    } else {
      expect(
        screen.queryByRole('button', { name: 'Resume in fresh session' }),
      ).not.toBeInTheDocument();
    }
  },
);

it.each([
  ['DRAFT', 'Draft', 'Prepare workspace'],
  ['PREPARING', 'Preparing workspace', 'Retry preparation'],
  ['READY', 'Workspace ready', null],
  ['FAILED', 'Preparation failed', 'Retry preparation'],
] as const)(
  'distinguishes %s preparation from execution in the routed workspace',
  async (state, label, action) => {
    service.get.mockResolvedValue({
      ...detail(),
      status: state,
      promptRevision: 0,
      execution: null,
    });
    workspace();
    const status = await screen.findByRole('region', { name: 'Native execution status' });
    expect(within(status).getByRole('status')).toHaveTextContent(label);
    expect(screen.getByRole('button', { name: 'Start agent' })).toHaveProperty(
      'disabled',
      state !== 'READY',
    );
    if (action) expect(screen.getByRole('button', { name: action })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Cancel execution' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit prompt' })).toBeEnabled();
    expect(service.start).not.toHaveBeenCalled();
  },
);

it.each([
  ['RUNNING', 'Agent running', true],
  ['STOPPED', 'Agent stopped', true],
  ['FAILED', 'Execution failed', true],
  ['CANCEL_REQUESTED', 'Cancellation requested', true],
  ['CANCELLED', 'Execution cancelled', false],
] as const)(
  'distinguishes %s execution and supported actions in the routed workspace',
  async (state, label, cancellable) => {
    service.get.mockResolvedValue({
      ...detail(),
      execution: { ...detail().execution!, status: state },
    });
    workspace();
    const status = await screen.findByRole('region', { name: 'Native execution status' });
    expect(within(status).getByRole('status')).toHaveTextContent(label);
    expect(screen.queryByRole('button', { name: 'Start agent' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit prompt' })).not.toBeInTheDocument();
    if (cancellable) {
      expect(screen.getByRole('button', { name: 'Cancel execution' })).toHaveProperty(
        'disabled',
        state === 'CANCEL_REQUESTED',
      );
    } else {
      expect(screen.queryByRole('button', { name: 'Cancel execution' })).not.toBeInTheDocument();
    }
    if (state === 'STOPPED') {
      expect(
        within(status).getByText(/does not establish that the workflow is complete/),
      ).toBeVisible();
    }
    expect(screen.getByText('Task one')).toBeVisible();
  },
);

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

it('opens older shared waits from the selected sidebar and removes them when another member continues the runs', async () => {
  const latest = { ...detail(), updatedAt: '2026-10-02T00:00:00Z' };
  const ask = { ...waitingDetail('AWAITING_USER'), id: 'ask', title: 'Question' };
  const recovery = { ...ask, id: 'recover', title: 'Run recover' };
  recovery.execution = {
    ...ask.execution!,
    publicationSequence: 1,
    turnSequence: 2,
    status: 'RECOVERY_REQUIRED',
    responsePending: true,
    recovery: {
      id: 'a1227042-0661-4843-8138-9d08fdd0a891',
      reason: 'SESSION_LOST',
      canRecover: true,
      workflowResumeState: 'created',
    },
    stopStatus: { state: 'confirmed', confirmedAt: time },
  };
  const legacy = { ...waitingDetail('WAITING_FOR_INPUT'), id: 'legacy', title: 'Legacy input' };
  const runs = new Map([latest, ask, recovery, legacy].map((run) => [run.id, run]));
  service.get.mockImplementation(async (_project, id) => runs.get(id));
  service.list.mockResolvedValue({
    items: [...runs.values()].map(
      ({ prompt: _prompt, execution: _execution, executionAvailable: _available, ...summary }) =>
        summary,
    ),
    nextCursor: 'more',
  });
  service.projectList.mockResolvedValue([
    { id: 'project', name: 'Member space', kind: 'v2', userRole: 'member', createdAt: time },
  ]);
  await invalidateProjects();
  workspace();
  const sidebarRow = (label: string) =>
    screen.getByRole('button', { name: `Native ${label} (Member space)` });
  const latestRow = () => sidebarRow('Run one: Agent running');
  const recoveryRow = () => sidebarRow('Run recover: Awaiting fresh-session recovery');
  await waitFor(() => expect(latestRow()).toHaveAttribute('aria-current', 'page'));
  expect(recoveryRow()).toBeVisible();
  await userEvent.click(sidebarRow('Question: Awaiting member reply'));
  await screen.findByRole('textbox', { name: 'Reply to AI-DLC' });
  expect(sidebarRow('Question: Awaiting member reply')).toHaveAttribute('aria-current', 'page');
  expect(latestRow()).not.toHaveAttribute('aria-current');
  expect(screen.getByRole('link', { name: 'History' })).toHaveAttribute(
    'href',
    expect.stringContaining('/native-intent/ask?'),
  );
  runs.set(ask.id, {
    ...ask,
    execution: {
      ...ask.execution!,
      revision: 8,
      status: 'DISPATCHING',
      responsePending: true,
      turnSequence: 2,
    },
  });
  await userEvent.click(screen.getByRole('button', { name: 'Refresh status' }));
  await waitFor(() =>
    expect(sidebarRow('Question: Continuing agent')).toHaveAttribute('aria-current', 'page'),
  );
  await userEvent.click(recoveryRow());
  expect(await screen.findByRole('button', { name: 'Resume in fresh session' })).toBeEnabled();
  expect(recoveryRow()).toHaveAttribute('aria-current', 'page');
  expect(screen.queryByRole('button', { name: /Native Question/ })).toBeNull();
  runs.set(recovery.id, {
    ...recovery,
    execution: {
      ...recovery.execution!,
      revision: 8,
      status: 'RECOVERING',
      stopStatus: { state: 'unconfirmed', confirmedAt: null },
      recovery: { ...recovery.execution!.recovery!, canRecover: false },
    },
  });
  await userEvent.click(screen.getByRole('button', { name: 'Refresh status' }));
  await waitFor(() =>
    expect(sidebarRow('Run recover: Resuming in a fresh session')).toHaveAttribute(
      'aria-current',
      'page',
    ),
  );
  await userEvent.click(latestRow());
  expect(screen.queryByRole('button', { name: /Native Run recover/ })).toBeNull();
  await userEvent.click(sidebarRow('Legacy input: Waiting for input'));
  expect(screen.queryByRole('button', { name: 'Send reply' })).toBeNull();
  runs.set(legacy.id, {
    ...legacy,
    execution: {
      ...legacy.execution!,
      status: 'CANCELLED',
      revision: 8,
      stopStatus: { state: 'confirmed', confirmedAt: time },
    },
  });
  await userEvent.click(screen.getByRole('button', { name: 'Refresh status' }));
  await waitFor(() =>
    expect(sidebarRow('Legacy input: Execution cancelled')).toHaveAttribute('aria-current', 'page'),
  );
  expect(screen.getByRole('link', { name: 'History' })).toHaveAttribute(
    'href',
    expect.stringContaining('/native-intent/legacy?'),
  );
  await userEvent.click(latestRow());
  expect(screen.queryByRole('button', { name: /Native Legacy input/ })).toBeNull();
  expect(service.list).toHaveBeenCalledExactlyOnceWith('project', null);
  expect(service.recover).not.toHaveBeenCalled();
  expect(service.platformGet).not.toHaveBeenCalled();
});

it('updates cached navigation status from the routed workspace after another member cancels', async () => {
  const waiting = waitingDetail('WAITING_FOR_INPUT');
  const {
    prompt: _prompt,
    execution: _execution,
    executionAvailable: _available,
    ...summary
  } = waiting;
  service.list.mockResolvedValue({ items: [summary], nextCursor: null });
  await refreshNativeIntents('project');
  workspace();
  const breadcrumbs = await screen.findByRole('navigation', { name: 'Breadcrumb' });
  await waitFor(() => expect(within(breadcrumbs).getByText('Waiting for input')).toBeVisible());
  service.get.mockResolvedValue({
    ...waiting,
    execution: { ...waiting.execution!, status: 'CANCELLED', revision: 8 },
  });
  await userEvent.click(screen.getByRole('button', { name: 'Refresh status' }));
  await waitFor(() => expect(within(breadcrumbs).getByText('Execution cancelled')).toBeVisible());
  expect(
    within(screen.getByRole('region', { name: 'Native execution status' })).getByRole('status'),
  ).toHaveTextContent('Execution cancelled');
  expect(getNativeListing('project').items[0].execution?.status).toBe('CANCELLED');
  expect(getNativeListing('project').items[0]).not.toHaveProperty('prompt');
  expect(screen.queryByText('Workspace ready')).not.toBeInTheDocument();
});

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
      events: [
        {
          revision: 1,
          eventId: 'native-1',
          type: 'native.accepted',
          summary: 'Turn 1: Start accepted',
          timestamp: '2026-10-13T10:00:00Z',
        },
      ],
      nextEventAfter: null,
    })
    .mockResolvedValueOnce(page(row(65)));
  const view = workspace();
  expect(await screen.findByText('Visible activity 65.')).toBeVisible();
  expect(screen.getByText('Visible activity 1.')).toBeVisible();
  expect(document.querySelectorAll('[data-output-type="message"]')).toHaveLength(65);
  expect(screen.getByText('Agent running')).toBeVisible();
  expect(screen.getByRole('tab', { name: 'Agent' })).toHaveAttribute('data-state', 'active');
  expect(service.outputs).toHaveBeenCalledWith('project', 'one', 64, 1);
  await userEvent.setup().click(screen.getByRole('tab', { name: /Timeline/ }));
  expect(screen.getByText('Turn 1: Start accepted')).toBeVisible();
  await userEvent.setup().click(screen.getByRole('tab', { name: 'Agent' }));
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
  expect(service.outputs).toHaveBeenCalledWith('project', 'two', 0, 0);
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
