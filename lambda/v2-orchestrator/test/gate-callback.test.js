import { describe, it, expect, vi } from 'vitest';
import { awaitEngineGate } from '../section.js';
import { bindGateCallback } from '../gate-callback.js';

const input = {
  executionId: 'e1',
  humanTaskId: 'h1',
  callbackId: 'cb1',
  callbackOwner: 'stage:s1',
  stageInstanceId: 's1',
};

describe('bindGateCallback', () => {
  it.each(['answered', 'approved', 'rejected'])('accepts an unbound %s gate', async (status) => {
    const gate = { status, stageInstanceId: 's1' };
    const store = {
      setGateCallbackId: vi.fn(async () => null),
      getHumanTask: vi.fn(async () => gate),
    };
    expect(await bindGateCallback(store, input)).toBe(gate);
    expect(store.getHumanTask).toHaveBeenCalledWith('e1', 'h1', { consistentRead: true });
    expect(store.setGateCallbackId).toHaveBeenCalledTimes(1);
  });

  it.each([
    { status: 'pending', stageInstanceId: 's1' },
    { status: 'answered', stageInstanceId: 'sibling' },
    { status: 'answered', stageInstanceId: 's1', callbackId: 'other' },
    { status: 'answered', stageInstanceId: 's1', callbackOwner: 'stage:other' },
    null,
  ])('never steals a callback or consumes a different stage answer: %j', async (gate) => {
    const store = {
      setGateCallbackId: vi.fn(async () => null),
      getHumanTask: vi.fn(async () => gate),
    };
    expect(await bindGateCallback(store, input)).toBeNull();
    expect(store.setGateCallbackId).toHaveBeenCalledTimes(1);
  });
});

describe('engine gate answer/bind races', () => {
  const fixture = () => {
    let gate = null;
    const meta = { orchestratorRunId: 'run1', status: 'RUNNING' };
    const cas = () => Object.assign(new Error('CAS'), { name: 'ConditionalCheckFailedException' });
    const store = {
      getExecution: vi.fn(async () => ({ ...meta })),
      getHumanTask: vi.fn(async () => gate && { ...gate }),
      createHumanTask: vi.fn(async (row) => {
        gate = { ...row, status: 'pending' };
      }),
      supersedeHumanTask: vi.fn(async () => {
        if (gate?.status === 'pending') gate.status = 'superseded';
        return gate;
      }),
      updateExecution: vi.fn(async (row) => {
        if (row.ifOrchestratorRunId !== meta.orchestratorRunId) throw cas();
        Object.assign(meta, row);
      }),
      setGateCallbackId: vi.fn(async (row) => {
        if (gate.status !== 'pending') return null;
        Object.assign(gate, row);
        return { ...gate };
      }),
    };
    const ctx = {
      step: async (_name, fn) => fn(),
      // An unanswered callback must not be awaited when the saved answer won.
      createCallback: async () => [new Promise(() => {}), 'cb1'],
    };
    const toolkit = {
      store,
      runId: 'run1',
      ids: { executionId: 'e1', intentId: 'i1', projectId: 'p1' },
      broadcast: vi.fn(async () => {}),
    };
    return {
      store,
      meta,
      ctx,
      toolkit,
      answer: () => Object.assign(gate, { status: 'answered', answer: { decision: 'retry' } }),
      supersede: () => Object.assign(gate, { status: 'superseded' }),
    };
  };
  const args = { name: 'halt-s1-r1', prompt: 'Retry?', sectionIndex: 1 };

  it('consumes an answer that arrives during the question broadcast', async () => {
    const f = fixture();
    f.toolkit.broadcast.mockImplementation(async () => f.answer());
    expect(await awaitEngineGate(f.ctx, f.toolkit, args)).toMatchObject({
      gate: { status: 'answered', answer: { decision: 'retry' } },
    });
    expect(f.meta.status).toBe('RUNNING');
  });

  it('consumes an answer after the bind without awaiting an undelivered callback', async () => {
    const f = fixture();
    const bind = f.store.setGateCallbackId.getMockImplementation();
    f.store.setGateCallbackId.mockImplementation(async (row) => {
      const bound = await bind(row);
      f.answer();
      return bound;
    });
    expect(await awaitEngineGate(f.ctx, f.toolkit, args)).toMatchObject({
      gate: { status: 'answered' },
    });
  });

  it('retires when supersession races binding without unparking META', async () => {
    const f = fixture();
    f.toolkit.broadcast.mockImplementation(async () => f.supersede());
    expect(await awaitEngineGate(f.ctx, f.toolkit, args)).toEqual({ superseded: true });
    expect(f.store.updateExecution.mock.calls.some(([row]) => row.status === 'RUNNING')).toBe(
      false,
    );
  });

  it('does not open gates for a retired run', async () => {
    const f = fixture();
    f.meta.orchestratorRunId = 'replacement';
    expect(await awaitEngineGate(f.ctx, f.toolkit, args)).toEqual({ superseded: true });
    expect(f.store.createHumanTask).not.toHaveBeenCalled();
    expect(f.store.updateExecution).not.toHaveBeenCalled();
  });

  it('cannot unpark a replacement run after receiving an answer', async () => {
    const f = fixture();
    f.toolkit.broadcast.mockImplementation(async () => {
      f.answer();
      f.meta.orchestratorRunId = 'replacement';
      f.meta.status = 'CREATED';
    });
    expect(await awaitEngineGate(f.ctx, f.toolkit, args)).toEqual({ superseded: true });
    expect(f.meta).toMatchObject({ orchestratorRunId: 'replacement', status: 'CREATED' });
  });

  it('retires a legacy gate if ownership changes between creating it and parking META', async () => {
    const f = fixture();
    const create = f.store.createHumanTask.getMockImplementation();
    f.store.createHumanTask.mockImplementation(async (row) => {
      await create(row);
      f.meta.orchestratorRunId = 'replacement';
      f.meta.pendingHumanTaskId = 'replacement-gate';
    });
    expect(await awaitEngineGate(f.ctx, f.toolkit, args)).toEqual({ superseded: true });
    expect(await f.store.getHumanTask()).toMatchObject({ status: 'superseded' });
    expect(f.meta.pendingHumanTaskId).toBe('replacement-gate');
    expect(f.toolkit.broadcast).not.toHaveBeenCalled();
  });

  it('surfaces storage failures without manufacturing a gate conflict', async () => {
    const f = fixture();
    f.store.getHumanTask.mockRejectedValue(new Error('DynamoDB unavailable'));
    await expect(awaitEngineGate(f.ctx, f.toolkit, args)).rejects.toThrow('DynamoDB unavailable');
    expect(f.store.createHumanTask).not.toHaveBeenCalled();
  });
});
