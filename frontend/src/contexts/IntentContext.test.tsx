import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor } from '@/test/query';
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router';
import { ArtifactEditControls } from '@/components/intent/ArtifactEditControls';
import { queryClient } from '@/lib/queryClient';
import { renderHook } from '@/test/query';

// Capture the realtime callback so tests can push events into the provider.
let capturedOnEvent: ((e: Record<string, unknown>) => void) | null = null;
let capturedStatus: ((status: string) => void) | null = null;
vi.mock('@/hooks/useIntentEvents', () => ({
  useIntentEvents: (_p: string, _i: string, cb: (e: Record<string, unknown>) => void) => {
    capturedOnEvent = cb;
  },
}));
vi.mock('@/services/realtime', () => ({
  realtimeService: {
    onStatusChange: (handler: (status: string) => void) => {
      capturedStatus = handler;
      handler('disconnected');
      return () => {
        if (capturedStatus === handler) capturedStatus = null;
      };
    },
  },
}));

const get = vi.fn();
const answerGate = vi.fn();
const compiled = vi.fn();
const workflowGet = vi.fn();
const outputs = vi.fn();
const artifactContents = vi.fn();
const getResponsibilities = vi.fn();
vi.mock('@/services/stageResponsibilities', () => ({
  stageResponsibilitiesService: { get: (...args: unknown[]) => getResponsibilities(...args) },
}));
vi.mock('@/services/intents', () => ({
  intentsService: {
    get: (...a: unknown[]) => get(...a),
    answerGate: (...a: unknown[]) => answerGate(...a),
    outputs: (...a: unknown[]) => outputs(...a),
    artifactContents: (...a: unknown[]) => artifactContents(...a),
  },
}));
const apiPut = vi.fn();
vi.mock('@/services/api', () => ({
  api: { put: (...a: unknown[]) => apiPut(...a) },
}));
// The real workflow writes (and their cache invalidation); only reads are stubbed.
vi.mock('@/services/workflows', async (importActual) => {
  const actual = await importActual<typeof import('@/services/workflows')>();
  return {
    workflowsService: {
      ...actual.workflowsService,
      compiled: (...a: unknown[]) => compiled(...a),
      get: (...a: unknown[]) => workflowGet(...a),
    },
  };
});

import { IntentProvider, useIntent, clearIntentCache } from './IntentContext';
import { workflowsService } from '@/services/workflows';
import { intentCompiledQuery } from '@/lib/intentEntry';
import { qk } from '@/lib/queryKeys';
import type { IntentDetail } from '@/services/intents';

const flush = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });

// One debounced lifecycle reload (fake timers).
const lifecycleEvent = () =>
  act(async () => {
    capturedOnEvent?.({ action: 'agent.note' });
    await vi.advanceTimersByTimeAsync(300);
  });

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => (hidden ? 'hidden' : 'visible'),
  });
  document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
}

function Probe() {
  const {
    stageRows,
    pendingGates,
    outputBuffers,
    outputRows,
    outputVersion,
    ensureOutputs,
    currentPhasePath,
  } = useIntent();
  return (
    <div>
      <div data-testid="rows">{stageRows.map((r) => `${r.stageId}:${r.state}`).join(',')}</div>
      <div data-testid="pending">{pendingGates.length}</div>
      <div data-testid="ritual">
        {pendingGates.map((gate) => String(gate.learningsRitual ?? '')).join(',')}
      </div>
      <div data-testid="loop-back">
        {pendingGates.map((gate) => String(gate.loopBackTarget ?? '')).join(',')}
      </div>
      <div data-testid="out" data-version={outputVersion}>
        {[...outputBuffers.entries()].map(([k, v]) => `${k}=${v}`).join('|')}
      </div>
      <div data-testid="out-rows">
        {[...outputRows.entries()]
          .map(([k, rows]) => `${k}=${rows.map((r) => r.display?.title ?? r.content).join(',')}`)
          .join('|')}
      </div>
      <div data-testid="phase-path">{currentPhasePath ?? 'null'}</div>
      <button data-testid="seed" onClick={() => ensureOutputs('si-1')} />
    </div>
  );
}

const renderProvider = (child = <Probe />) =>
  render(
    <MemoryRouter initialEntries={['/space/p1/intent/i1']}>
      <Routes>
        <Route
          path="/space/:projectId/intent/:intentId"
          element={<IntentProvider>{child}</IntentProvider>}
        />
      </Routes>
    </MemoryRouter>,
  );

function ArtifactProbe() {
  const { detail: current } = useIntent();
  return (
    <>
      <div data-testid="bodies">
        {(current?.artifacts ?? [])
          .map((a) => `${a.id}=${a.content === undefined ? '(loading)' : String(a.content)}`)
          .join('|')}
      </div>
      <div data-testid="unavailable">
        {(current?.artifacts ?? []).map((a) => `${a.id}=${a.contentUnavailable ?? '-'}`).join('|')}
      </div>
    </>
  );
}

const renderArtifactProbe = () =>
  render(
    <MemoryRouter initialEntries={['/space/p1/intent/i1']}>
      <Routes>
        <Route
          path="/space/:projectId/intent/:intentId"
          element={
            <IntentProvider>
              <ArtifactProbe />
            </IntentProvider>
          }
        />
      </Routes>
    </MemoryRouter>,
  );

const artifact = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  artifactType: 'doc',
  title: id,
  createdByExecutionId: 'i1',
  createdByStageInstanceId: 'si-1',
  createdAt: '2026-01-01T00:00:00Z',
  generation: 1,
  ...over,
});

function CompiledProbe() {
  const { compiled: current } = useIntent();
  const id = (current as { id?: string } | null)?.id;
  return <div data-testid="compiled">{current ? (id ?? 'set') : 'null'}</div>;
}

const renderCompiledProbe = () =>
  render(
    <MemoryRouter initialEntries={['/space/p1/intent/i1']}>
      <Routes>
        <Route
          path="/space/:projectId/intent/:intentId"
          element={
            <IntentProvider>
              <CompiledProbe />
            </IntentProvider>
          }
        />
      </Routes>
    </MemoryRouter>,
  );

function LiveProbe() {
  const {
    detail: current,
    reload,
    ensureOutputs,
    setPaneVisible,
    hasEarlierOutput,
    loadEarlierOutput,
    outputPaneStatus,
    outputBuffers,
    outputRows,
    outputVersion,
    lastActivityAt,
    openGates,
  } = useIntent();
  const navigate = useNavigate();
  const paneRows = outputRows.get('si-1') ?? [];
  return (
    <div>
      <div data-testid="title">{current?.intent.title ?? 'none'}</div>
      <div data-testid="activity">{lastActivityAt ?? 'null'}</div>
      <div data-testid="open-gates">{openGates.map((g) => g.humanTaskId).join(',')}</div>
      <div data-testid="buf-len" data-version={outputVersion}>
        {(outputBuffers.get('si-1') ?? '').length}
      </div>
      <div data-testid="buf-head">{(outputBuffers.get('si-1') ?? '').slice(0, 1)}</div>
      <div data-testid="status-si-1">{outputPaneStatus('si-1')}</div>
      <div data-testid="earlier">{String(hasEarlierOutput('si-1'))}</div>
      <div data-testid="row-heads">
        {paneRows.map((r) => (r.kind === 'system' ? '…' : r.content.slice(0, 1))).join('')}
      </div>
      <div data-testid="pane-status">
        {['si-a', 'si-b', 'si-c', 'si-d', 'si-e'].map((k) => outputPaneStatus(k)).join(',')}
      </div>
      <button data-testid="reload" onClick={() => void reload()} />
      <button data-testid="go-i2" onClick={() => navigate('/space/p1/intent/i2')} />
      <button data-testid="earlier-btn" onClick={() => loadEarlierOutput('si-1')} />
      {['si-1', 'si-2', 'si-a', 'si-b', 'si-c', 'si-d', 'si-e'].map((k) => (
        <span key={k}>
          <button data-testid={`ensure-${k}`} onClick={() => ensureOutputs(k)} />
          <button data-testid={`hide-${k}`} onClick={() => setPaneVisible(k, false)} />
        </span>
      ))}
    </div>
  );
}

const renderLiveProbe = () =>
  render(
    <MemoryRouter initialEntries={['/space/p1/intent/i1']}>
      <Routes>
        <Route
          path="/space/:projectId/intent/:intentId"
          element={
            <IntentProvider>
              <LiveProbe />
            </IntentProvider>
          }
        />
      </Routes>
    </MemoryRouter>,
  );

const click = (testId: string) =>
  act(async () => {
    screen.getByTestId(testId).click();
    await vi.advanceTimersByTimeAsync(0);
  });

const deferred = <T,>() => {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

const catchUpKeys = () =>
  outputs.mock.calls
    .filter(([, , params]) => (params as { afterSeq?: number }).afterSeq !== undefined)
    .map(([, , params]) => (params as { stageInstanceId: string }).stageInstanceId);

const detail = (over: Record<string, unknown> = {}) => ({
  intent: {
    id: 'i1',
    executionId: 'i1',
    projectId: 'p1',
    title: 'T',
    prompt: 'P',
    status: 'RUNNING',
    workflowId: 'wf',
    workflowVersion: 1,
    scope: 'feature',
    currentStage: null,
    pendingHumanTaskId: null,
    createdAt: null,
    updatedAt: null,
    completedAt: null,
    ...over,
  },
  stages: [],
  events: [],
  gates: [],
  metrics: [],
  outputs: [],
  sensorRuns: [],
  artifacts: [],
});

// The compiled read is cancellable: the cache's signal reaches the service.
const compileRequest = { signal: expect.any(AbortSignal) };

const pinnedDetail = (
  releaseId = 'aidlc:release-a',
  importerRevision = 3,
  intentOver: Record<string, unknown> = {},
) =>
  detail({
    ...intentOver,
    methodologyRelease: {
      releaseId,
      sourceSha: 'a'.repeat(40),
      closureDigest: 'd'.repeat(64),
      importerRevision,
    },
  });

describe('IntentContext', () => {
  beforeEach(() => {
    capturedOnEvent = null;
    capturedStatus = null;
    queryClient.clear();
    clearIntentCache();
    get.mockReset();
    answerGate.mockReset();
    outputs.mockReset().mockResolvedValue({ outputs: [] });
    artifactContents.mockReset().mockResolvedValue({ artifacts: [], nextCursor: null });
    getResponsibilities.mockReset().mockResolvedValue({ stages: [] });
    compiled.mockReset().mockResolvedValue({ graph: { nodes: [], edges: [] } });
    workflowGet.mockReset().mockResolvedValue({ phases: [] });
  });
  afterEach(() => {
    vi.useRealTimers();
    Reflect.deleteProperty(document, 'visibilityState');
  });

  it.each(['role granted', 'enforcement disabled'])(
    'enables an open document after %s without edits or focus changes',
    async (change) => {
      vi.useFakeTimers();
      get.mockResolvedValue({
        ...detail({ status: 'WAITING' }),
        artifacts: [artifact('doc', { content: 'draft' })],
      });
      const responsibilities = (allowed: boolean) => ({
        enforceStageRoles: !(allowed && change === 'enforcement disabled'),
        stages: [
          { stageId: 'code', stageInstanceId: 'si-1', access: { edit: allowed, decide: allowed } },
        ],
      });
      getResponsibilities.mockResolvedValue(responsibilities(false));
      function EditorProbe() {
        const { detail: current } = useIntent();
        return (
          current?.artifacts[0] && (
            <ArtifactEditControls artifact={current.artifacts[0]} onStartEdit={() => {}} />
          )
        );
      }
      const { unmount } = renderProvider(<EditorProbe />);
      try {
        await act(async () => vi.advanceTimersByTimeAsync(0));
        expect(screen.getByRole('button', { name: 'Edit document' })).toBeDisabled();
        const before = getResponsibilities.mock.calls.length;
        getResponsibilities.mockResolvedValue(responsibilities(true));
        await act(async () => vi.advanceTimersByTimeAsync(30_000));
        expect(getResponsibilities.mock.calls.length).toBeGreaterThan(before);
        expect(screen.getByRole('button', { name: 'Edit document' })).toBeEnabled();
        unmount();
        const after = getResponsibilities.mock.calls.length;
        await act(async () => vi.advanceTimersByTimeAsync(30_000));
        expect(getResponsibilities).toHaveBeenCalledTimes(after);
      } finally {
        unmount();
        vi.useRealTimers();
      }
    },
  );

  it.each([false, true])(
    'uses only the legacy grant for an unattributed document (legacy=%s)',
    async (legacy) => {
      get.mockResolvedValue({
        ...detail({ status: 'WAITING' }),
        artifacts: [artifact('unattributed', { createdByStageInstanceId: null, content: 'draft' })],
      });
      const granted = { decide: true, edit: true };
      getResponsibilities.mockResolvedValue({
        stages: [
          { stageInstanceId: null, access: granted },
          { stageInstanceId: 'si-1', access: granted },
        ],
        sectionGates: { section: { reason: 'section', access: { edit: false, decide: false } } },
        ...(legacy && { unattributedAccess: granted }),
      });
      function AccessProbe() {
        const { detail: current, gateAccess } = useIntent();
        const doc = current?.artifacts[0];
        const section = gateAccess({ humanTaskId: 'section', stageInstanceId: null });
        const question = gateAccess({ humanTaskId: 'question', stageInstanceId: 'si-1' });
        return (
          <>
            {doc && <ArtifactEditControls artifact={doc} onStartEdit={() => {}} />}
            <output>{question.access?.decide && 'Can answer question'}</output>
            <output>
              {section.stage?.reason === 'section' &&
                !section.access?.decide &&
                'Section read-only'}
            </output>
          </>
        );
      }
      renderProvider(<AccessProbe />);
      await screen.findByText('Can answer question');
      expect(screen.getByText('Section read-only')).toBeInTheDocument();
      const edit = await screen.findByRole('button', { name: 'Edit document' });
      if (legacy) expect(edit).toBeEnabled();
      else expect(edit).toBeDisabled();
    },
  );

  it('stageRows: scope-filters the plan and appends live rows outside it', async () => {
    get.mockResolvedValue({
      ...detail(),
      // stage-c ran even though the plan (as compiled now) doesn't list it.
      stages: [{ stageInstanceId: 'si-c', stageId: 'stage-c', state: 'RUNNING', phase: null }],
    });
    compiled.mockResolvedValue({
      scopeGrid: { feature: { 'stage-a': 'EXECUTE', 'stage-b': 'SKIP' } },
      graph: {
        nodes: [
          { stageId: 'stage-a', phasePath: 'p', order: 0 },
          { stageId: 'stage-b', phasePath: 'p', order: 1 },
        ],
        edges: [],
      },
    });
    renderProvider();
    await waitFor(() =>
      expect(screen.getByTestId('rows')).toHaveTextContent('stage-a:PENDING,stage-c:RUNNING'),
    );
  });

  it('stageRows: a composed grid overrides the scope baseline grid', async () => {
    get.mockResolvedValue(detail({ composedGrid: { 'stage-a': 'EXECUTE', 'stage-b': 'SKIP' } }));
    compiled.mockResolvedValue({
      // The named scope would execute both stages; the composed grid deselects stage-b.
      scopeGrid: { feature: { 'stage-a': 'EXECUTE', 'stage-b': 'EXECUTE' } },
      graph: {
        nodes: [
          { stageId: 'stage-a', phasePath: 'p', order: 0 },
          { stageId: 'stage-b', phasePath: 'p', order: 1 },
        ],
        edges: [],
      },
    });
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('rows')).toHaveTextContent('stage-a:PENDING'));
    expect(screen.getByTestId('rows')).not.toHaveTextContent('stage-b');
  });

  it('compiles the workflow with the intent release pin', async () => {
    get.mockResolvedValue(
      detail({
        workflowVersion: 7,
        currentPhase: 'ideation',
        methodologyRelease: {
          releaseId: 'aidlc:release-a',
          sourceSha: 'a'.repeat(40),
          closureDigest: 'd'.repeat(64),
          importerRevision: 3,
        },
      }),
    );
    compiled.mockResolvedValue({
      phases: [
        {
          phaseId: 'ideation',
          name: 'Pinned Ideation',
          kind: 'phase',
          path: 'release-02',
          parentPath: null,
          order: 1,
        },
      ],
      graph: { nodes: [], edges: [] },
    });

    renderProvider();

    await waitFor(() =>
      expect(compiled).toHaveBeenCalledWith(
        'wf',
        7,
        'aidlc:release-a',
        3,
        { projectId: 'p1', intentId: 'i1' },
        null,
        compileRequest,
      ),
    );
    await waitFor(() => expect(screen.getByTestId('phase-path')).toHaveTextContent('release-02'));
    expect(workflowGet).not.toHaveBeenCalled();
  });

  it('dedupes pinned compilation when a realtime reload returns a new intent object', async () => {
    get
      .mockResolvedValueOnce(pinnedDetail())
      .mockResolvedValueOnce(pinnedDetail('aidlc:release-a', 3, { updatedAt: 'later' }));
    renderProvider();

    await waitFor(() => expect(compiled).toHaveBeenCalledTimes(1));
    act(() => {
      capturedOnEvent?.({ action: 'agent.note', noteType: 'v2.artifact.created' });
    });
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));

    expect(compiled).toHaveBeenCalledTimes(1);
  });

  it('recompiles a pinned intent when its release identity changes', async () => {
    get
      .mockResolvedValueOnce(pinnedDetail())
      .mockResolvedValueOnce(pinnedDetail('aidlc:release-b', 4));
    renderProvider();

    await waitFor(() => expect(compiled).toHaveBeenCalledTimes(1));
    act(() => {
      capturedOnEvent?.({ action: 'agent.note' });
    });
    await waitFor(() => expect(compiled).toHaveBeenCalledTimes(2));

    expect(compiled).toHaveBeenLastCalledWith(
      'wf',
      1,
      'aidlc:release-b',
      4,
      { projectId: 'p1', intentId: 'i1' },
      null,
      compileRequest,
    );
  });

  it('recompiles a pinned intent when only its releaseId changes', async () => {
    get
      .mockResolvedValueOnce(pinnedDetail('aidlc:release-a', 3))
      .mockResolvedValueOnce(pinnedDetail('aidlc:release-b', 3));
    renderProvider();

    await waitFor(() => expect(compiled).toHaveBeenCalledTimes(1));
    act(() => {
      capturedOnEvent?.({ action: 'agent.note' });
    });
    await waitFor(() => expect(compiled).toHaveBeenCalledTimes(2));

    expect(compiled).toHaveBeenLastCalledWith(
      'wf',
      1,
      'aidlc:release-b',
      3,
      { projectId: 'p1', intentId: 'i1' },
      null,
      compileRequest,
    );
  });

  it('discards a late compiled response after the release identity changed', async () => {
    get
      .mockResolvedValueOnce(pinnedDetail('aidlc:release-a', 3))
      .mockResolvedValueOnce(pinnedDetail('aidlc:release-b', 3));
    let resolveFirst: (value: unknown) => void = () => {};
    compiled
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce({ id: 'release-b', graph: { nodes: [], edges: [] } });
    renderCompiledProbe();

    await waitFor(() => expect(compiled).toHaveBeenCalledTimes(1));
    act(() => {
      capturedOnEvent?.({ action: 'agent.note' });
    });
    await waitFor(() => expect(screen.getByTestId('compiled')).toHaveTextContent('release-b'));

    await act(async () => {
      resolveFirst({ id: 'release-a', graph: { nodes: [], edges: [] } });
    });
    expect(screen.getByTestId('compiled')).toHaveTextContent('release-b');
  });

  it('reuses a prefetched pinned compile: mounting issues no compiled request', async () => {
    const pinned = pinnedDetail('aidlc:release-a', 3, { currentPhase: 'ideation' });
    get.mockResolvedValue(pinned);
    compiled.mockResolvedValue({
      phases: [
        {
          phaseId: 'ideation',
          name: 'Warm',
          kind: 'phase',
          path: 'warm',
          parentPath: null,
          order: 1,
        },
      ],
      graph: { nodes: [], edges: [] },
    });
    const query = intentCompiledQuery(pinned as unknown as IntentDetail);
    void queryClient.prefetchQuery(query);
    await waitFor(() => expect(queryClient.getQueryState(query.queryKey)?.data).toBeDefined());
    expect(compiled).toHaveBeenCalledTimes(1);

    renderProvider();
    await waitFor(() => expect(screen.getByTestId('phase-path')).toHaveTextContent('warm'));
    expect(compiled).toHaveBeenCalledTimes(1);
  });

  it('reads compiled views under the shared intentCompiledQuery keys', async () => {
    const pinned = pinnedDetail();
    get.mockResolvedValue(pinned);
    const value = { id: 'pinned', graph: { nodes: [], edges: [] } };
    compiled.mockResolvedValue(value);
    renderCompiledProbe();
    await waitFor(() => expect(screen.getByTestId('compiled')).toHaveTextContent('pinned'));
    const key = intentCompiledQuery(pinned as unknown as IntentDetail).queryKey;
    expect(key).toEqual(
      qk.compiled('wf', {
        version: 1,
        releaseId: 'aidlc:release-a',
        importerRevision: 3,
        intent: { projectId: 'p1', intentId: 'i1' },
      }),
    );
    expect(queryClient.getQueryState(key)?.data).toBe(value);
  });

  it('reuses a prefetched unpinned compile under the provider key', async () => {
    const unpinned = detail();
    get.mockResolvedValue(unpinned);
    const query = intentCompiledQuery(unpinned as unknown as IntentDetail);
    expect(query.queryKey).toEqual(qk.compiled('wf', { version: 1 }));
    void queryClient.prefetchQuery(query);
    await waitFor(() => expect(queryClient.getQueryState(query.queryKey)?.data).toBeDefined());
    renderProvider();
    await waitFor(() => expect(get).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId('rows')).toBeInTheDocument());
    expect(compiled).toHaveBeenCalledTimes(1);
  });

  it('evicts a failed pinned compilation so a realtime reload can retry', async () => {
    get.mockResolvedValue(pinnedDetail());
    compiled
      .mockRejectedValueOnce(new Error('temporary compile failure'))
      .mockResolvedValueOnce({ graph: { nodes: [], edges: [] } });
    renderProvider();

    await waitFor(() => expect(compiled).toHaveBeenCalledTimes(1));
    act(() => {
      capturedOnEvent?.({ action: 'agent.note' });
    });
    await waitFor(() => expect(compiled).toHaveBeenCalledTimes(2));
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('serves unpinned compilation from cache within its stale time, then refreshes it', async () => {
    vi.useFakeTimers();
    try {
      get.mockImplementation(async () => detail({ updatedAt: `t${get.mock.calls.length}` }));
      renderProvider();
      await flush();
      expect(compiled).toHaveBeenCalledTimes(1);

      // Three more loads inside the 60 s window share the cached compile.
      for (let i = 0; i < 3; i++) await lifecycleEvent();
      expect(get.mock.calls.length).toBeGreaterThanOrEqual(4);
      expect(compiled).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(61_000);
      });
      await lifecycleEvent();
      expect(compiled).toHaveBeenCalledTimes(2);
      expect(compiled).toHaveBeenLastCalledWith(
        'wf',
        1,
        undefined,
        undefined,
        undefined,
        null,
        compileRequest,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the previous compiled workflow while an unpinned reload recompiles', async () => {
    vi.useFakeTimers();
    try {
      get.mockImplementation(async () => detail({ updatedAt: `t${get.mock.calls.length}` }));
      let resolveSecond: (value: unknown) => void = () => {};
      compiled
        .mockResolvedValueOnce({ id: 'first', graph: { nodes: [], edges: [] } })
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveSecond = resolve;
            }),
        );
      renderCompiledProbe();
      await flush();
      expect(screen.getByTestId('compiled')).toHaveTextContent('first');

      await act(async () => {
        await vi.advanceTimersByTimeAsync(61_000);
      });
      await lifecycleEvent();
      expect(compiled).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId('compiled')).toHaveTextContent('first');

      await act(async () => {
        resolveSecond({ id: 'second', graph: { nodes: [], edges: [] } });
      });
      expect(screen.getByTestId('compiled')).toHaveTextContent('second');
    } finally {
      vi.useRealTimers();
    }
  });

  it('accumulates agent.question events by humanTaskId (upsert, never replace)', async () => {
    get.mockResolvedValue(detail());
    renderProvider();
    await screen.findByTestId('pending');

    act(() => {
      capturedOnEvent?.({ action: 'agent.question', humanTaskId: 'h1', questions: '[]' });
      capturedOnEvent?.({ action: 'agent.question', humanTaskId: 'h1', questions: '[]' });
    });
    expect(screen.getByTestId('pending')).toHaveTextContent('1');

    act(() => {
      capturedOnEvent?.({ action: 'agent.question', humanTaskId: 'h2', questions: '[]' });
    });
    expect(screen.getByTestId('pending')).toHaveTextContent('2');
  });

  it('keeps the learnings ritual flag of a live validation gate', async () => {
    get.mockResolvedValue(detail());
    renderProvider();
    await screen.findByTestId('pending');

    act(() => {
      capturedOnEvent?.({
        action: 'agent.question',
        humanTaskId: 'eg-validation-si-1-0',
        kind: 'validation',
        learningsRitual: true,
      });
    });

    expect(screen.getByTestId('ritual')).toHaveTextContent('true');
  });

  it('keeps the loop-back target of a live validation gate', async () => {
    get.mockResolvedValue(detail());
    renderProvider();
    await screen.findByTestId('pending');

    act(() => {
      capturedOnEvent?.({
        action: 'agent.question',
        humanTaskId: 'eg-validation-si-1-0',
        kind: 'validation',
        options: ['approve', 'request-changes', 'loop-back'],
        loopBackTarget: 'code-generation',
      });
    });

    expect(screen.getByTestId('loop-back')).toHaveTextContent('code-generation');
  });

  it('appends agent.output to per-stage buffers (null stage → intent bucket)', async () => {
    get.mockResolvedValue(detail());
    renderProvider();
    await screen.findByTestId('out');

    act(() => {
      capturedOnEvent?.({
        action: 'agent.output',
        stageInstanceId: 'si-1',
        seq: 1,
        content: 'more',
        timestamp: '2026-07-16T12:34:56.000Z',
        display: { type: 'message', title: 'More readable' },
      });
      capturedOnEvent?.({ action: 'agent.output', seq: 2, content: 'init-ws log' });
    });
    expect(screen.getByTestId('out')).toHaveTextContent('si-1=more');
    expect(screen.getByTestId('out')).toHaveTextContent('intent=init-ws log');
    expect(screen.getByTestId('out-rows')).toHaveTextContent('si-1=More readable');
  });

  it('ensureOutputs lazily seeds a pane and dedupes live chunks by seq', async () => {
    // The detail DTO carries no outputs; a pane's durable history arrives via
    // the outputs endpoint when the pane is first displayed. Live chunks that
    // raced the seed (seq ≤ the seed's max) must not duplicate.
    get.mockResolvedValue(detail());
    outputs.mockResolvedValue({
      outputs: [
        {
          seq: 1,
          stageInstanceId: 'si-1',
          kind: 'text',
          content: 'seed ',
          display: { type: 'message', title: 'Seeded' },
        },
        { seq: 2, stageInstanceId: 'si-1', kind: 'text', content: 'two ' },
      ],
    });
    renderProvider();
    await screen.findByTestId('out');

    // seq 2 is a broadcast duplicate of a durable chunk; seq 3 is genuinely new.
    act(() => {
      capturedOnEvent?.({
        action: 'agent.output',
        stageInstanceId: 'si-1',
        seq: 2,
        content: 'two ',
      });
      capturedOnEvent?.({
        action: 'agent.output',
        stageInstanceId: 'si-1',
        seq: 3,
        content: 'tail',
      });
    });
    expect(screen.getByTestId('out')).toHaveTextContent('si-1=two tail');

    await act(async () => {
      screen.getByTestId('seed').click();
    });
    expect(outputs).toHaveBeenCalledWith('p1', 'i1', { stageInstanceId: 'si-1' });
    expect(screen.getByTestId('out')).toHaveTextContent('si-1=seed two tail');
    expect(screen.getByTestId('out-rows')).toHaveTextContent('si-1=Seeded,two ,tail');

    // Re-selecting the pane never refetches.
    await act(async () => {
      screen.getByTestId('seed').click();
    });
    expect(outputs).toHaveBeenCalledTimes(1);

    // A post-seed live chunk at/below the seeded max is dropped as a dupe.
    act(() => {
      capturedOnEvent?.({
        action: 'agent.output',
        stageInstanceId: 'si-1',
        seq: 1,
        content: 'DUP',
      });
      capturedOnEvent?.({ action: 'agent.output', stageInstanceId: 'si-1', seq: 4, content: '!' });
    });
    expect(screen.getByTestId('out')).toHaveTextContent('si-1=seed two tail!');
  });

  it('catches up durable output missed while the realtime channel was disconnected', async () => {
    get.mockResolvedValue(detail());
    outputs
      .mockResolvedValueOnce({
        outputs: [{ seq: 1, stageInstanceId: 'si-1', kind: 'text', content: 'before ' }],
      })
      .mockResolvedValueOnce({
        outputs: [{ seq: 2, stageInstanceId: 'si-1', kind: 'text', content: 'missed' }],
        // Other stages wrote up to seq 9; the next catch-up resumes after them.
        cursor: 9,
      })
      .mockResolvedValueOnce({ outputs: [], cursor: 9 });
    renderProvider();
    await screen.findByTestId('out');

    await act(async () => {
      screen.getByTestId('seed').click();
    });
    expect(screen.getByTestId('out')).toHaveTextContent('si-1=before');

    await act(async () => {
      capturedStatus?.('connected');
    });

    expect(outputs).toHaveBeenLastCalledWith('p1', 'i1', {
      stageInstanceId: 'si-1',
      afterSeq: 1,
    });
    expect(screen.getByTestId('out')).toHaveTextContent('si-1=before missed');

    await act(async () => {
      capturedStatus?.('connected');
    });
    expect(outputs).toHaveBeenLastCalledWith('p1', 'i1', {
      stageInstanceId: 'si-1',
      afterSeq: 9,
    });
    expect(screen.getByTestId('out')).toHaveTextContent('si-1=before missed');
  });

  it('keeps the catch-up cursor when an older overlapping response arrives last', async () => {
    get.mockResolvedValue(detail());
    let resolveOlder: (value: unknown) => void = () => {};
    outputs
      .mockResolvedValueOnce({
        outputs: [{ seq: 1, stageInstanceId: 'si-1', kind: 'text', content: 'before ' }],
      })
      // The first catch-up is slow and only covers seq 2.
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOlder = resolve;
          }),
      )
      // The second overlaps it and advances the cursor past other stages' chunks.
      .mockResolvedValueOnce({
        outputs: [{ seq: 2, stageInstanceId: 'si-1', kind: 'text', content: 'missed' }],
        cursor: 2000,
      })
      .mockResolvedValueOnce({ outputs: [], cursor: 2000 });
    renderProvider();
    await screen.findByTestId('out');

    await act(async () => {
      screen.getByTestId('seed').click();
    });
    await act(async () => {
      capturedStatus?.('connected');
    });
    await act(async () => {
      capturedStatus?.('connected');
    });
    await act(async () => {
      resolveOlder({
        outputs: [{ seq: 2, stageInstanceId: 'si-1', kind: 'text', content: 'missed' }],
        cursor: 2,
      });
    });

    await act(async () => {
      capturedStatus?.('connected');
    });
    expect(outputs).toHaveBeenLastCalledWith('p1', 'i1', {
      stageInstanceId: 'si-1',
      afterSeq: 2000,
    });
    expect(screen.getByTestId('out')).toHaveTextContent('si-1=before missed');
  });

  it('pages in a transcript too long for one response', async () => {
    get.mockResolvedValue(detail());
    const row = (seq: number, content: string) => ({
      seq,
      stageInstanceId: 'si-1',
      kind: 'text',
      content,
    });
    outputs
      .mockResolvedValueOnce({ outputs: [row(1, 'a'), row(2, 'b')], cursor: 2, more: true })
      .mockResolvedValueOnce({ outputs: [row(4, 'c')], cursor: 5, more: true })
      // A cursor held at a gap ends the loop until the next poll.
      .mockResolvedValueOnce({ outputs: [row(6, 'd')], cursor: 5, more: true });
    renderProvider();
    await screen.findByTestId('out');

    await act(async () => {
      screen.getByTestId('seed').click();
    });

    expect(outputs).toHaveBeenCalledTimes(3);
    expect(outputs).toHaveBeenNthCalledWith(1, 'p1', 'i1', { stageInstanceId: 'si-1' });
    expect(outputs).toHaveBeenNthCalledWith(2, 'p1', 'i1', {
      stageInstanceId: 'si-1',
      afterSeq: 2,
    });
    expect(outputs).toHaveBeenNthCalledWith(3, 'p1', 'i1', {
      stageInstanceId: 'si-1',
      afterSeq: 5,
    });
    expect(screen.getByTestId('out')).toHaveTextContent('si-1=abcd');
  });

  it('refetches the detail on agent.note — debounced (the realtime path for artifact creation)', async () => {
    // create_artifact broadcasts a v2.artifact.created note (agent.note); the
    // provider must refetch so the new artifact renders without waiting for
    // the 8s poll backstop. WP7: the refetch is DEBOUNCED (250ms trailing) so
    // lane event bursts coalesce.
    vi.useFakeTimers();
    try {
      get.mockResolvedValue(detail());
      renderProvider();
      await act(async () => {
        await vi.runOnlyPendingTimersAsync();
      });
      const callsAfterMount = get.mock.calls.length;

      await act(async () => {
        capturedOnEvent?.({
          action: 'agent.note',
          noteType: 'v2.artifact.created',
          summary: 'Artifact created: Auth design',
        });
        await vi.advanceTimersByTimeAsync(300);
      });
      expect(get.mock.calls.length).toBe(callsAfterMount + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refetches the detail on agent.pr (the fan-in PR was recorded)', async () => {
    vi.useFakeTimers();
    try {
      get.mockResolvedValue(detail());
      renderProvider();
      await act(async () => {
        await vi.runOnlyPendingTimersAsync();
      });
      const callsAfterMount = get.mock.calls.length;

      await act(async () => {
        capturedOnEvent?.({
          action: 'agent.pr',
          prs: [{ id: 'pr:i1:owner/repo', repoId: 'owner/repo' }],
        });
        await vi.advanceTimersByTimeAsync(300);
      });
      expect(get.mock.calls.length).toBe(callsAfterMount + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('coalesces a burst of lane events into ONE refetch (WP7 debounce)', async () => {
    vi.useFakeTimers();
    try {
      get.mockResolvedValue(detail());
      renderProvider();
      await act(async () => {
        await vi.runOnlyPendingTimersAsync();
      });
      const callsAfterMount = get.mock.calls.length;

      await act(async () => {
        // N parallel lanes each emitting stage/unit/metric transitions.
        for (let i = 0; i < 12; i++) {
          capturedOnEvent?.({ action: 'agent.stage', stageId: 'cg', unitSlug: `u${i}` });
          capturedOnEvent?.({ action: 'agent.unit', unitSlug: `u${i}`, state: 'RUNNING' });
        }
        await vi.advanceTimersByTimeAsync(300);
      });
      expect(get.mock.calls.length).toBe(callsAfterMount + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders ONE row PER UNIT INSTANCE of a fan-out stage (WP7 re-key)', async () => {
    get.mockResolvedValue({
      ...detail(),
      stages: [
        // Two unit instances of the same plan stage — the old stageId-keyed
        // Map silently dropped one of these.
        { stageInstanceId: 'si-cg-auth', stageId: 'cg', state: 'SUCCEEDED', unitSlug: 'auth' },
        { stageInstanceId: 'si-cg-billing', stageId: 'cg', state: 'RUNNING', unitSlug: 'billing' },
      ],
    });
    compiled.mockResolvedValue({
      scopeGrid: { feature: { cg: 'EXECUTE' } },
      graph: { nodes: [{ stageId: 'cg', phasePath: 'construction', order: 0 }], edges: [] },
    });
    renderProvider();
    await waitFor(() =>
      expect(screen.getByTestId('rows')).toHaveTextContent('cg:SUCCEEDED,cg:RUNNING'),
    );
  });

  it('currentPhasePath maps a phaseId to its workflow path', async () => {
    get.mockResolvedValue(detail({ currentPhase: 'ideation' }));
    workflowGet.mockResolvedValue({
      phases: [
        { phaseId: 'initialization', path: '00', name: 'Initialization' },
        { phaseId: 'ideation', path: '01', name: 'Ideation' },
      ],
    });
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('phase-path')).toHaveTextContent('01'));
  });

  it('re-reads unpinned workflow phases after a workflow write', async () => {
    get.mockResolvedValue(detail({ currentPhase: 'ideation' }));
    workflowGet.mockResolvedValue({
      phases: [{ phaseId: 'ideation', path: '01', name: 'Ideation' }],
    });
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('phase-path')).toHaveTextContent('01'));

    workflowGet.mockResolvedValue({
      phases: [{ phaseId: 'ideation', path: '07', name: 'Ideation' }],
    });
    apiPut.mockResolvedValue({ phases: [] });
    await act(async () => {
      await workflowsService.putPhases('wf', []);
    });

    await waitFor(() => expect(screen.getByTestId('phase-path')).toHaveTextContent('07'));
  });

  it('currentPhasePath falls back to raw value when workflowPhases lacks the id', async () => {
    get.mockResolvedValue(detail({ currentPhase: 'unknown-phase' }));
    workflowGet.mockResolvedValue({ phases: [] });
    renderProvider();
    await waitFor(() =>
      expect(screen.getByTestId('phase-path')).toHaveTextContent('unknown-phase'),
    );
  });
  it('pages artifact bodies in after the detail loads', async () => {
    get.mockResolvedValue({ ...detail(), artifacts: [artifact('a'), artifact('b')] });
    artifactContents
      .mockResolvedValueOnce({ artifacts: [{ id: 'a', content: '# A' }], nextCursor: 'c1' })
      .mockResolvedValueOnce({ artifacts: [{ id: 'b', content: null }], nextCursor: null });
    renderArtifactProbe();
    await waitFor(() => expect(screen.getByTestId('bodies')).toHaveTextContent('a=# A|b=null'));
    expect(artifactContents.mock.calls).toEqual([
      ['p1', 'i1', null],
      ['p1', 'i1', 'c1'],
    ]);
  });

  it('retries a failed body page, then marks the bodies failed', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      get.mockResolvedValue({ ...detail(), artifacts: [artifact('a')] });
      artifactContents.mockRejectedValue(new Error('403'));
      renderArtifactProbe();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      expect(artifactContents).toHaveBeenCalledTimes(3);
      expect(screen.getByTestId('unavailable')).toHaveTextContent('a=error');
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it('recovers when a retried body page succeeds', async () => {
    vi.useFakeTimers();
    try {
      get.mockResolvedValue({ ...detail(), artifacts: [artifact('a')] });
      artifactContents
        .mockRejectedValueOnce(new Error('timeout'))
        .mockResolvedValueOnce({ artifacts: [{ id: 'a', content: '# A' }], nextCursor: null });
      renderArtifactProbe();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(screen.getByTestId('bodies')).toHaveTextContent('a=# A');
      expect(screen.getByTestId('unavailable')).toHaveTextContent('a=-');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not refetch bodies on a reload when every body is still current', async () => {
    vi.useFakeTimers();
    try {
      get.mockResolvedValue({ ...detail(), artifacts: [artifact('a')] });
      artifactContents.mockResolvedValue({
        artifacts: [{ id: 'a', content: '# A' }],
        nextCursor: null,
      });
      renderArtifactProbe();
      await act(async () => {
        await vi.runOnlyPendingTimersAsync();
      });
      expect(artifactContents).toHaveBeenCalledTimes(1);
      await act(async () => {
        capturedOnEvent?.({ action: 'agent.note', noteType: 'v2.stage.running' });
        await vi.advanceTimersByTimeAsync(300);
      });
      expect(get.mock.calls.length).toBeGreaterThan(1);
      expect(artifactContents).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('bodies')).toHaveTextContent('a=# A');
    } finally {
      vi.useRealTimers();
    }
  });

  it('marks a body the pages never returned as failed', async () => {
    get.mockResolvedValue({ ...detail(), artifacts: [artifact('a'), artifact('gone')] });
    artifactContents.mockResolvedValue({
      artifacts: [{ id: 'a', content: '# A' }],
      nextCursor: null,
    });
    renderArtifactProbe();
    await waitFor(() =>
      expect(screen.getByTestId('unavailable')).toHaveTextContent('a=-|gone=error'),
    );
  });

  it('skips the body fetch for an intent with no artifacts', async () => {
    get.mockResolvedValue(detail());
    renderArtifactProbe();
    await waitFor(() => expect(get).toHaveBeenCalled());
    await act(async () => {});
    expect(artifactContents).not.toHaveBeenCalled();
  });

  it('keeps a loaded body across a reload until the artifact revision changes', async () => {
    vi.useFakeTimers();
    try {
      get.mockResolvedValue({ ...detail(), artifacts: [artifact('a')] });
      artifactContents.mockResolvedValue({
        artifacts: [{ id: 'a', content: '# A' }],
        nextCursor: null,
      });
      renderArtifactProbe();
      await act(async () => {
        await vi.runOnlyPendingTimersAsync();
      });
      expect(screen.getByTestId('bodies')).toHaveTextContent('a=# A');

      // Same revision: the body is kept and not refetched.
      await act(async () => {
        capturedOnEvent?.({ action: 'agent.note', noteType: 'v2.artifact.updated' });
        await vi.advanceTimersByTimeAsync(300);
      });
      expect(screen.getByTestId('bodies')).toHaveTextContent('a=# A');
      expect(artifactContents).toHaveBeenCalledTimes(1);

      // New revision: the stale body is not shown.
      get.mockResolvedValue({ ...detail(), artifacts: [artifact('a', { generation: 2 })] });
      artifactContents.mockReturnValueOnce(new Promise(() => {}));
      await act(async () => {
        capturedOnEvent?.({ action: 'agent.note', noteType: 'v2.artifact.created' });
        await vi.advanceTimersByTimeAsync(300);
      });
      expect(screen.getByTestId('bodies')).toHaveTextContent('a=(loading)');
    } finally {
      vi.useRealTimers();
    }
  });
  describe('request discipline', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    it('joins a burst of lifecycle events into one load in flight plus one trailing load', async () => {
      get.mockResolvedValue(detail());
      renderLiveProbe();
      await flush();
      const base = get.mock.calls.length;
      const first = deferred<unknown>();
      const second = deferred<unknown>();
      get.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

      await lifecycleEvent();
      expect(get.mock.calls.length).toBe(base + 1);
      // Ten more events (and an explicit reload) while that load is in flight.
      await act(async () => {
        for (let i = 0; i < 10; i++) {
          capturedOnEvent?.({ action: 'agent.stage', stageId: `s${i}` });
          await vi.advanceTimersByTimeAsync(20);
        }
        await vi.advanceTimersByTimeAsync(300);
      });
      await click('reload');
      expect(get.mock.calls.length).toBe(base + 1);

      await act(async () => {
        first.resolve(detail());
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(get.mock.calls.length).toBe(base + 2);
      await act(async () => {
        second.resolve(detail());
        await vi.advanceTimersByTimeAsync(1_000);
      });
      expect(get.mock.calls.length).toBe(base + 2);
    });

    it('polls a RUNNING intent every 8 s', async () => {
      get.mockResolvedValue(detail());
      renderLiveProbe();
      await flush();
      const base = get.mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(8_100);
      });
      expect(get.mock.calls.length).toBe(base + 1);
    });

    it.each([403, 404, 410, 500])(
      'publishes automatic poll errors (%i) and clears only denied detail',
      async (status) => {
        get.mockResolvedValue(detail());
        const { result } = renderHook(() => useIntent(), {
          wrapper: ({ children }) => (
            <MemoryRouter initialEntries={['/space/p1/intent/i1']}>
              <Routes>
                <Route
                  path="/space/:projectId/intent/:intentId"
                  element={<IntentProvider>{children}</IntentProvider>}
                />
              </Routes>
            </MemoryRouter>
          ),
        });
        await flush();
        expect(result.current.detail).not.toBeNull();
        get.mockRejectedValueOnce(Object.assign(new Error('poll failed'), { status }));
        await act(async () => {
          await vi.advanceTimersByTimeAsync(8_100);
        });
        expect(result.current.error).toBe('poll failed');
        expect(result.current.errorStatus).toBe(status);
        if (status === 500) expect(result.current.detail).not.toBeNull();
        else {
          expect(result.current.detail).toBeNull();
          expect(result.current.compiled).toBeNull();
          expect(result.current.pendingGates).toHaveLength(0);
          expect(result.current.outputBuffers.size).toBe(0);
        }
      },
    );

    it('polls a WAITING intent at 30 s, not 8 s', async () => {
      get.mockResolvedValue(detail({ status: 'WAITING' }));
      renderLiveProbe();
      await flush();
      const base = get.mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(16_500);
      });
      expect(get.mock.calls.length).toBe(base);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(14_000);
      });
      expect(get.mock.calls.length).toBe(base + 1);
    });

    it('does not poll a terminal intent', async () => {
      get.mockResolvedValue(detail({ status: 'FAILED' }));
      renderLiveProbe();
      await flush();
      const base = get.mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(120_000);
      });
      expect(get.mock.calls.length).toBe(base);
    });

    it('pauses polling while hidden and loads once when visible again', async () => {
      get.mockResolvedValue(detail());
      renderLiveProbe();
      await flush();
      const base = get.mock.calls.length;
      act(() => setHidden(true));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(get.mock.calls.length).toBe(base);
      await act(async () => {
        setHidden(false);
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(get.mock.calls.length).toBe(base + 1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });
      expect(get.mock.calls.length).toBe(base + 1);
    });

    it('reuses a fresh detail already in the shared cache instead of refetching on mount', async () => {
      get.mockResolvedValue(detail({ title: 'Warm' }));
      const { intentDetailQuery } = await import('@/lib/intentEntry');
      await act(async () => {
        await queryClient.fetchQuery(intentDetailQuery('p1', 'i1'));
      });
      expect(get).toHaveBeenCalledTimes(1);
      renderLiveProbe();
      await flush();
      expect(screen.getByTestId('title')).toHaveTextContent('Warm');
      expect(get).toHaveBeenCalledTimes(1);
    });

    it('discards the old intent response after a route switch', async () => {
      const slow = deferred<unknown>();
      get.mockImplementation((_p: string, iid: string) =>
        iid === 'i1' ? slow.promise : Promise.resolve(detail({ id: 'i2', title: 'Two' })),
      );
      renderLiveProbe();
      await flush();
      await click('go-i2');
      expect(screen.getByTestId('title')).toHaveTextContent('Two');
      await act(async () => {
        slow.resolve(detail({ title: 'One' }));
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByTestId('title')).toHaveTextContent('Two');
    });

    it('catches up output only for visible panes, and only while RUNNING', async () => {
      get.mockResolvedValue(detail());
      outputs.mockResolvedValue({ outputs: [], cursor: 0 });
      renderLiveProbe();
      await flush();
      await click('ensure-si-1');
      await click('ensure-si-2');
      await click('hide-si-2');
      outputs.mockClear();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(8_100);
      });
      expect(catchUpKeys()).toEqual(['si-1']);

      // Without an explicit visibility signal a pane counts as visible for 60 s
      // after its last ensureOutputs.
      outputs.mockClear();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(70_000);
      });
      const late = outputs.mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(16_000);
      });
      expect(outputs.mock.calls.length).toBe(late);
    });

    it('does not run output catch-up for a WAITING intent', async () => {
      get.mockResolvedValue(detail({ status: 'WAITING' }));
      outputs.mockResolvedValue({ outputs: [], cursor: 0 });
      renderLiveProbe();
      await flush();
      await click('ensure-si-1');
      outputs.mockClear();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(16_500);
      });
      expect(outputs).not.toHaveBeenCalled();
    });

    it('caps a pane at 512 KiB by dropping the oldest output and offers earlier output', async () => {
      get.mockResolvedValue(detail());
      const big = (seq: number) => ({
        seq,
        stageInstanceId: 'si-1',
        kind: 'text',
        content: String(seq).repeat(200 * 1024),
      });
      outputs.mockResolvedValue({ outputs: [big(1), big(2), big(3)], cursor: 3 });
      renderLiveProbe();
      await flush();
      expect(screen.getByTestId('earlier')).toHaveTextContent('false');
      await click('ensure-si-1');
      expect(Number(screen.getByTestId('buf-len').textContent)).toBeLessThanOrEqual(512 * 1024);
      expect(Number(screen.getByTestId('buf-len').textContent)).toBe(400 * 1024);
      expect(screen.getByTestId('earlier')).toHaveTextContent('true');

      outputs.mockClear();
      await click('earlier-btn');
      expect(outputs).toHaveBeenCalledWith('p1', 'i1', { stageInstanceId: 'si-1' });
    });

    it('recovers the beginning of a transcript larger than the 2 MiB pane cap on demand', async () => {
      get.mockResolvedValue(detail());
      // 12 rows of 200 KiB (2.4 MiB): row n is the letter A+n-1 repeated.
      const row = (seq: number) => ({
        seq,
        stageInstanceId: 'si-1',
        kind: 'text',
        content: String.fromCharCode(64 + seq).repeat(200 * 1024),
      });
      const range = (from: number, to: number) =>
        Array.from({ length: to - from + 1 }, (_, i) => row(from + i));
      outputs.mockImplementation(async (_p: string, _i: string, params: { afterSeq?: number }) => {
        // Pages of up to 6 rows after the requested seq.
        const from = (params.afterSeq ?? 0) + 1;
        if (from > 12) return { outputs: [], cursor: 12 };
        const to = Math.min(from + 5, 12);
        return { outputs: range(from, to), cursor: to, more: to < 12 };
      });
      renderLiveProbe();
      await flush();
      await click('ensure-si-1');
      expect(screen.getByTestId('earlier')).toHaveTextContent('true');
      // Raising the cap (512 KiB → 1 MiB → 2 MiB) still cannot reach row 1.
      await click('earlier-btn');
      await click('earlier-btn');
      expect(screen.getByTestId('earlier')).toHaveTextContent('true');
      expect(screen.getByTestId('buf-head')).not.toHaveTextContent('A');

      // At the max cap, the next request fetches the beginning into an
      // on-demand view in front of the retained tail.
      await click('earlier-btn');
      expect(screen.getByTestId('buf-head')).toHaveTextContent('A');
      // The beginning (A, B) fills one request's budget; C and D are still a
      // gap in front of the retained tail, so the control stays.
      expect(screen.getByTestId('row-heads')).toHaveTextContent(/^AB…EFGHIJKL$/);
      expect(screen.getByTestId('earlier')).toHaveTextContent('true');

      // Loading more continues from where the beginning stopped.
      outputs.mockClear();
      await click('earlier-btn');
      expect(outputs).toHaveBeenCalledWith('p1', 'i1', { stageInstanceId: 'si-1', afterSeq: 2 });
      expect(screen.getByTestId('row-heads')).toHaveTextContent(/^ABCDEFGHIJKL$/);
      expect(screen.getByTestId('earlier')).toHaveTextContent('false');

      // The view is dropped when the pane closes.
      await click('hide-si-1');
      expect(screen.getByTestId('buf-head')).not.toHaveTextContent('A');
      expect(screen.getByTestId('earlier')).toHaveTextContent('true');
    });

    it('marks a pane whose first transcript fetch failed as error and retries it on reconnect', async () => {
      get.mockResolvedValue(detail({ status: 'WAITING' }));
      outputs.mockRejectedValueOnce(new Error('boom')).mockResolvedValue({
        outputs: [{ seq: 1, stageInstanceId: 'si-1', kind: 'text', content: 'back' }],
        cursor: 1,
      });
      renderLiveProbe();
      await flush();
      await click('ensure-si-1');
      expect(screen.getByTestId('status-si-1')).toHaveTextContent('error');

      await act(async () => {
        capturedStatus?.('connected');
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByTestId('status-si-1')).toHaveTextContent('seeded');
      expect(screen.getByTestId('buf-len')).toHaveTextContent('4');
    });

    it('retries a visible pane whose first fetch failed on the periodic catch-up', async () => {
      get.mockResolvedValue(detail());
      outputs.mockRejectedValueOnce(new Error('boom')).mockResolvedValue({
        outputs: [{ seq: 1, stageInstanceId: 'si-1', kind: 'text', content: 'back' }],
        cursor: 1,
      });
      renderLiveProbe();
      await flush();
      await click('ensure-si-1');
      expect(screen.getByTestId('status-si-1')).toHaveTextContent('error');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(8_100);
      });
      expect(screen.getByTestId('status-si-1')).toHaveTextContent('seeded');
    });

    it('retains at most 3 hidden transcript panes', async () => {
      get.mockResolvedValue(detail());
      outputs.mockImplementation(
        async (_p: string, _i: string, params: { stageInstanceId: string }) => ({
          outputs: [
            { seq: 1, stageInstanceId: params.stageInstanceId, kind: 'text', content: 'x' },
          ],
          cursor: 1,
        }),
      );
      renderLiveProbe();
      await flush();
      for (const key of ['si-a', 'si-b', 'si-c', 'si-d', 'si-e']) {
        await click(`ensure-${key}`);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(10);
        });
        await click(`hide-${key}`);
      }
      expect(screen.getByTestId('pane-status')).toHaveTextContent(
        'unseeded,unseeded,seeded,seeded,seeded',
      );
    });

    it('exposes lastActivityAt and openGates', async () => {
      get.mockResolvedValue({
        ...detail({ updatedAt: '2026-07-01T10:00:00Z' }),
        events: [
          {
            eventId: 'e1',
            type: 'x',
            stageInstanceId: null,
            actor: null,
            summary: null,
            timestamp: '2026-07-01T12:00:00Z',
          },
        ],
        stages: [
          {
            stageInstanceId: 'si-1',
            stageId: 's',
            state: 'SUCCEEDED',
            startedAt: '2026-07-01T09:00:00Z',
            completedAt: '2026-07-01T11:00:00Z',
          },
        ],
        gates: [
          { humanTaskId: 'h-open', status: 'pending' },
          { humanTaskId: 'h-done', status: 'answered' },
        ],
      });
      renderLiveProbe();
      await flush();
      expect(screen.getByTestId('activity')).toHaveTextContent('2026-07-01T12:00:00Z');
      expect(screen.getByTestId('open-gates')).toHaveTextContent('h-open');
      expect(screen.getByTestId('open-gates')).not.toHaveTextContent('h-done');

      await act(async () => {
        capturedOnEvent?.({
          action: 'agent.output',
          stageInstanceId: 'si-1',
          seq: 9,
          content: 'later',
          timestamp: '2026-07-01T13:00:00Z',
        });
      });
      expect(screen.getByTestId('activity')).toHaveTextContent('2026-07-01T13:00:00Z');
    });

    it('clearIntentCache resets the shared detail', async () => {
      get.mockResolvedValue(detail());
      const { intentDetailQuery } = await import('@/lib/intentEntry');
      await act(async () => {
        await queryClient.fetchQuery(intentDetailQuery('p1', 'i1'));
      });
      clearIntentCache();
      expect(
        queryClient.getQueryState(intentDetailQuery('p1', 'i1').queryKey)?.data,
      ).toBeUndefined();
    });
  });
});
