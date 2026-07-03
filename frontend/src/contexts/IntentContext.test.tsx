import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

// Capture the realtime callback so tests can push events into the provider.
let capturedOnEvent: ((e: Record<string, unknown>) => void) | null = null;
vi.mock('@/hooks/useIntentEvents', () => ({
  useIntentEvents: (_p: string, _i: string, cb: (e: Record<string, unknown>) => void) => {
    capturedOnEvent = cb;
  },
}));

const get = vi.fn();
const answerGate = vi.fn();
const compiled = vi.fn();
const outputs = vi.fn();
vi.mock('@/services/intents', () => ({
  intentsService: {
    get: (...a: unknown[]) => get(...a),
    answerGate: (...a: unknown[]) => answerGate(...a),
    outputs: (...a: unknown[]) => outputs(...a),
  },
}));
vi.mock('@/services/workflows', () => ({
  workflowsService: { compiled: (...a: unknown[]) => compiled(...a) },
}));

import { IntentProvider, useIntent } from './IntentContext';

function Probe() {
  const { stageRows, pendingGates, outputBuffers, outputVersion, ensureOutputs } = useIntent();
  return (
    <div>
      <div data-testid="rows">{stageRows.map((r) => `${r.stageId}:${r.state}`).join(',')}</div>
      <div data-testid="pending">{pendingGates.length}</div>
      <div data-testid="out" data-version={outputVersion}>
        {[...outputBuffers.entries()].map(([k, v]) => `${k}=${v}`).join('|')}
      </div>
      <button data-testid="seed" onClick={() => ensureOutputs('si-1')} />
    </div>
  );
}

const renderProvider = () =>
  render(
    <MemoryRouter initialEntries={['/project/p1/intent/i1']}>
      <Routes>
        <Route
          path="/project/:projectId/intent/:intentId"
          element={
            <IntentProvider>
              <Probe />
            </IntentProvider>
          }
        />
      </Routes>
    </MemoryRouter>,
  );

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

describe('IntentContext', () => {
  beforeEach(() => {
    capturedOnEvent = null;
    get.mockReset();
    answerGate.mockReset();
    outputs.mockReset().mockResolvedValue({ outputs: [] });
    compiled.mockReset().mockResolvedValue({ graph: { nodes: [], edges: [] } });
  });

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
    expect(await screen.findByTestId('rows')).toHaveTextContent('stage-a:PENDING,stage-c:RUNNING');
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
      });
      capturedOnEvent?.({ action: 'agent.output', seq: 2, content: 'init-ws log' });
    });
    expect(screen.getByTestId('out')).toHaveTextContent('si-1=more');
    expect(screen.getByTestId('out')).toHaveTextContent('intent=init-ws log');
  });

  it('ensureOutputs lazily seeds a pane and dedupes live chunks by seq', async () => {
    // The detail DTO carries no outputs; a pane's durable history arrives via
    // the outputs endpoint when the pane is first displayed. Live chunks that
    // raced the seed (seq ≤ the seed's max) must not duplicate.
    get.mockResolvedValue(detail());
    outputs.mockResolvedValue({
      outputs: [
        { seq: 1, stageInstanceId: 'si-1', kind: 'text', content: 'seed ' },
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
    expect(await screen.findByTestId('rows')).toHaveTextContent('cg:SUCCEEDED,cg:RUNNING');
  });
});
