// Engine gates publish gate.pending from inside the existing gate-open step.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { awaitEngineGate, engineGateLabel } from '../section.js';

const send = vi.hoisted(() => vi.fn(async () => ({ FailedEntryCount: 0 })));
vi.mock('@aws-sdk/client-eventbridge', () => ({
  EventBridgeClient: class {
    send = send;
  },
  PutEventsCommand: class {
    constructor(input) {
      this.input = input;
    }
  },
}));

// The published [detailType, detail] pairs.
const published = () =>
  send.mock.calls.map(([command]) => {
    const [entry] = command.input.Entries;
    return [entry.DetailType, JSON.parse(entry.Detail)];
  });

const fixture = () => {
  let gate = null;
  const meta = { orchestratorRunId: 'run1', status: 'RUNNING' };
  const store = {
    getExecution: vi.fn(async () => ({ ...meta })),
    getHumanTask: vi.fn(async () => gate && { ...gate }),
    createHumanTask: vi.fn(async (row) => {
      gate = { ...row, status: 'pending' };
      Object.assign(meta, { status: 'WAITING', pendingHumanTaskId: row.humanTaskId });
    }),
    updateExecution: vi.fn(async (row) => Object.assign(meta, row)),
    supersedeHumanTask: vi.fn(async () => gate),
    setGateCallbackId: vi.fn(async (row) => {
      Object.assign(gate, row);
      return { ...gate };
    }),
  };
  // Durable replay: a step that already ran returns its checkpointed value.
  const checkpoints = new Map();
  const steps = [];
  const ctx = {
    step: async (name, fn) => {
      steps.push(name);
      if (!checkpoints.has(name)) checkpoints.set(name, await fn());
      return checkpoints.get(name);
    },
    createCallback: async () => {
      // Answer as soon as the run suspends.
      Object.assign(gate, { status: 'approved', answer: { decision: 'approve' } });
      return [Promise.resolve({}), 'cb1'];
    },
  };
  const toolkit = {
    store,
    runId: 'run1',
    ids: { executionId: 'i1', intentId: 'i1', projectId: 'p1' },
    broadcast: vi.fn(async () => {}),
  };
  return { ctx, toolkit, store, steps };
};

describe('engine gate notification event', () => {
  beforeEach(() => {
    send.mockClear();
    vi.stubEnv('NOTIFICATION_EVENT_BUS', 'bus-1');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('publishes gate.pending once, with the kind, prompt and a readable stage', async () => {
    const f = fixture();
    await awaitEngineGate(f.ctx, f.toolkit, {
      name: 'skeleton-s1',
      prompt: 'Review the walking skeleton',
      sectionIndex: 1,
    });
    expect(published()).toHaveLength(1);
    const [type, detail] = published()[0];
    expect(type).toBe('gate.pending');
    expect(detail).toEqual({
      schemaVersion: 1,
      eventId: 'eg-skeleton-s1-run1',
      projectId: 'p1',
      intentId: 'i1',
      executionId: 'i1',
      humanTaskId: 'eg-skeleton-s1-run1',
      need: 'approval',
      kind: 'approval',
      stage: 'Walking skeleton review',
      intentTitle: null,
      startedBy: null,
      prompt: 'Review the walking skeleton',
    });
  });

  it('uses the stage label it is given', async () => {
    const f = fixture();
    await awaitEngineGate(f.ctx, f.toolkit, {
      name: 'validation-si-1-0',
      kind: 'validation',
      stageLabel: 'requirements-analysis',
      prompt: 'Approve requirements',
    });
    expect(published()[0][1]).toMatchObject({
      stage: 'requirements-analysis',
      kind: 'validation',
      need: 'approval',
    });
  });

  it('does not publish when the run was replaced', async () => {
    const f = fixture();
    f.store.createHumanTask.mockRejectedValueOnce(
      Object.assign(new Error('exists'), { name: 'ConditionalCheckFailedException' }),
    );
    f.store.updateExecution.mockRejectedValueOnce(
      Object.assign(new Error('owner'), { name: 'ConditionalCheckFailedException' }),
    );
    await expect(
      awaitEngineGate(f.ctx, f.toolkit, { name: 'ladder-s1', prompt: 'Choose' }),
    ).resolves.toEqual({ superseded: true });
    expect(send).not.toHaveBeenCalled();
  });

  it('keeps the step sequence, and publishes nothing, without a bus', async () => {
    const withBus = fixture();
    await awaitEngineGate(withBus.ctx, withBus.toolkit, { name: 'batch-s1-w0', prompt: 'P' });
    send.mockClear();
    vi.stubEnv('NOTIFICATION_EVENT_BUS', '');
    const noBus = fixture();
    await awaitEngineGate(noBus.ctx, noBus.toolkit, { name: 'batch-s1-w0', prompt: 'P' });
    expect(send).not.toHaveBeenCalled();
    expect(noBus.steps).toEqual(withBus.steps);
    expect(noBus.steps[1]).toBe('gate-open-batch-s1-w0');
  });

  it.each([
    ['halt-s1-r0', 'Lane failure'],
    ['skeleton-s1-v2', 'Walking skeleton review'],
    ['ladder-s1', 'Autonomy choice'],
    ['batch-s1-w0', 'Batch review'],
    ['validation-si-1-0', 'Stage review'],
    ['other', 'Review'],
    [undefined, 'Review'],
  ])('labels %s as %s', (name, label) => {
    expect(engineGateLabel(name)).toBe(label);
  });
});
