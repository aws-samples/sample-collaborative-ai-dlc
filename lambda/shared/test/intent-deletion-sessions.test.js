import { describe, expect, it, vi } from 'vitest';
import { deleteIntentCascade, deleteRuntimeSessions } from '../intent-deletion.js';

// Chainable gremlin stub — every step returns the chain; terminal steps
// resolve empty so the cascade runs without a graph.
const gStub = () => {
  const chain = new Proxy(function noop() {}, {
    get(_target, prop) {
      if (prop === 'toList') return async () => [];
      if (prop === 'next') return async () => ({});
      if (prop === 'then') return undefined;
      return () => chain;
    },
    apply: () => chain,
  });
  return chain;
};

const CP_ARN = 'arn:aws:bedrock-agentcore:us-east-1:111111111111:capacity-provider/cp-123';

const storeStub = (records) => ({
  getExecutionRecords: vi.fn().mockResolvedValue(records),
  deleteExecution: vi.fn().mockResolvedValue({}),
});

const instancesMeta = {
  status: 'SUCCEEDED',
  environment: {
    environmentId: 'x86-instances',
    runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:111111111111:runtime/managed',
    runtimeEndpoint: 'revision_r_1',
    capacityProviderArn: CP_ARN,
  },
};

const records = {
  humanTasks: [],
  stages: [{ parallelSection: 1 }, { parallelSection: 1 }, {}],
  unitPlan: { units: [{ slug: 'alpha' }, { slug: 'beta' }] },
};

const sentCommands = (agentcore, name) =>
  agentcore.send.mock.calls
    .map((call) => call[0])
    .filter((command) => command.constructor.name === name);

describe('deleteRuntimeSessions', () => {
  it('deletes the main and lane sessions against the capacity provider', async () => {
    const agentcore = { send: vi.fn().mockResolvedValue({}) };
    await deleteRuntimeSessions(agentcore, CP_ARN, 'int-1', {
      sectionIndexes: [1],
      unitSlugs: ['alpha', 'beta'],
    });
    const deletes = sentCommands(agentcore, 'DeleteCapacityProviderSessionCommand');
    expect(deletes.map((command) => command.input.sessionId)).toEqual([
      'aidlc-intent-int-1'.padEnd(33, '0'),
      'aidlc-intent-int-1-s1-alpha'.padEnd(33, '0'),
      'aidlc-intent-int-1-s1-beta'.padEnd(33, '0'),
    ]);
    expect(deletes[0].input.capacityProviderId).toBe('cp-123');
  });

  it('tolerates sessions that never existed', async () => {
    const agentcore = {
      send: vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('no such session'), { name: 'ResourceNotFoundException' }),
        ),
    };
    await expect(
      deleteRuntimeSessions(agentcore, CP_ARN, 'int-1', {
        sectionIndexes: [1],
        unitSlugs: ['alpha'],
      }),
    ).resolves.toBeUndefined();
  });

  it('throws on an unexpected error so the caller can retry the delete', async () => {
    const agentcore = {
      send: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('denied'), { name: 'AccessDeniedException' })),
    };
    await expect(deleteRuntimeSessions(agentcore, CP_ARN, 'int-1')).rejects.toThrow('denied');
  });
});

describe('deleteIntentCascade on the Instances compute type', () => {
  it('deletes the intent sessions (and their volumes) with the cascade', async () => {
    const store = storeStub(records);
    const agentcore = { send: vi.fn().mockResolvedValue({}) };
    await deleteIntentCascade({
      g: gStub(),
      store,
      ddb: null,
      agentcore,
      intentId: 'int-1',
      meta: instancesMeta,
      agentcoreRuntimeTarget: {
        agentRuntimeArn: instancesMeta.environment.runtimeArn,
        qualifier: instancesMeta.environment.runtimeEndpoint,
      },
    });
    // Stop (existing behavior) then delete, main + the section×unit lanes.
    expect(sentCommands(agentcore, 'StopRuntimeSessionCommand')).toHaveLength(1);
    const deletes = sentCommands(agentcore, 'DeleteCapacityProviderSessionCommand');
    expect(deletes.map((command) => command.input.sessionId).toSorted()).toEqual(
      [
        'aidlc-intent-int-1'.padEnd(33, '0'),
        'aidlc-intent-int-1-s1-alpha'.padEnd(33, '0'),
        'aidlc-intent-int-1-s1-beta'.padEnd(33, '0'),
      ].toSorted(),
    );
    expect(store.deleteExecution).toHaveBeenCalledWith('int-1');
  });

  it('keeps microVM deletion unchanged — no capacity provider, no session delete', async () => {
    const store = storeStub({ ...records, unitPlan: null });
    const agentcore = { send: vi.fn().mockResolvedValue({}) };
    await deleteIntentCascade({
      g: gStub(),
      store,
      ddb: null,
      agentcore,
      intentId: 'int-2',
      meta: { status: 'SUCCEEDED', environment: { runtimeArn: 'arn:rt' } },
      agentcoreRuntimeTarget: { agentRuntimeArn: 'arn:rt' },
    });
    expect(sentCommands(agentcore, 'DeleteCapacityProviderSessionCommand')).toHaveLength(0);
    expect(store.deleteExecution).toHaveBeenCalled();
  });

  it('aborts before the DynamoDB delete when session deletion fails unexpectedly', async () => {
    const store = storeStub(records);
    const agentcore = {
      send: vi.fn().mockImplementation(async (command) => {
        if (command.constructor.name === 'DeleteCapacityProviderSessionCommand') {
          throw Object.assign(new Error('denied'), { name: 'AccessDeniedException' });
        }
        return {};
      }),
    };
    await expect(
      deleteIntentCascade({
        g: gStub(),
        store,
        ddb: null,
        agentcore,
        intentId: 'int-3',
        meta: instancesMeta,
        agentcoreRuntimeTarget: { agentRuntimeArn: instancesMeta.environment.runtimeArn },
      }),
    ).rejects.toThrow('denied');
    // META survives, the intent still lists, and the delete can be re-run.
    expect(store.deleteExecution).not.toHaveBeenCalled();
  });
});
