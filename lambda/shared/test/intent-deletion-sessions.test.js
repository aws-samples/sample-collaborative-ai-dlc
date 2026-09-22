import { describe, expect, it, vi } from 'vitest';
import {
  collectIntentSessionIds,
  deleteIntentCascade,
  deleteRuntimeSessions,
  laneSessionIdFor,
  runtimeSessionIdFor,
} from '../intent-deletion.js';
import { buildStageRow, buildUnitRow } from '../v2-process-keys.js';

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
const NOW = '2026-01-01T00:00:00.000Z';

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

// REAL persisted shapes — the fixtures go through the same row builders the
// store uses, so a field rename there breaks this test instead of silently
// missing sessions (the original regression: cleanup read `parallelSection`
// while buildStageRow persists `sectionIndex`).
const unitRow = (intentId, sectionIndex, slug, { started = true } = {}) => {
  const row = buildUnitRow({ executionId: intentId, sectionIndex, slug, now: NOW });
  // The orchestrator stamps the lane's sessionId on the row when the lane
  // starts (updateUnitState fields) — mirror that for started lanes.
  return started
    ? { ...row, state: 'MERGED', sessionId: laneSessionIdFor(intentId, sectionIndex, slug) }
    : row;
};

const laneStageRow = (intentId, sectionIndex, unitSlug) =>
  buildStageRow({
    executionId: intentId,
    stageInstanceId: `code-generation--s${sectionIndex}-unit-${unitSlug}`,
    stageId: 'code-generation',
    sectionIndex,
    unitSlug,
    now: NOW,
  });

const records = {
  humanTasks: [],
  stages: [
    laneStageRow('int-1', 1, 'alpha'),
    laneStageRow('int-1', 1, 'beta'),
    // A once-per-workflow stage has no lane identity.
    buildStageRow({ executionId: 'int-1', stageInstanceId: 'inception', now: NOW }),
  ],
  units: [
    unitRow('int-1', 1, 'alpha'),
    unitRow('int-1', 1, 'beta'),
    // A historical lane that is NO LONGER in the current unit plan — its UNIT#
    // row (and stamped session) survives the plan rewind and must be deleted.
    unitRow('int-1', 0, 'legacy-lane'),
  ],
  // The CURRENT plan only knows alpha/beta — the orphaned lane must not
  // depend on it.
  unitPlan: { units: [{ slug: 'alpha' }, { slug: 'beta' }] },
};

const sentCommands = (agentcore, name) =>
  agentcore.send.mock.calls
    .map((call) => call[0])
    .filter((command) => command.constructor.name === name);

describe('collectIntentSessionIds', () => {
  it('collects the main session plus every persisted lane session, deduplicated', () => {
    expect(collectIntentSessionIds('int-1', records).toSorted()).toEqual(
      [
        runtimeSessionIdFor('int-1'),
        laneSessionIdFor('int-1', 1, 'alpha'),
        laneSessionIdFor('int-1', 1, 'beta'),
        laneSessionIdFor('int-1', 0, 'legacy-lane'),
      ].toSorted(),
    );
  });

  it('falls back to sectionIndex/unitSlug when a lane never stamped a sessionId', () => {
    const ids = collectIntentSessionIds('int-1', {
      // A lane that never started: buildUnitRow initializes sessionId: null.
      units: [unitRow('int-1', 2, 'never-started', { started: false })],
      // A lane visible only through its stage row.
      stages: [laneStageRow('int-1', 3, 'stage-only')],
    });
    expect(ids.toSorted()).toEqual(
      [
        runtimeSessionIdFor('int-1'),
        laneSessionIdFor('int-1', 2, 'never-started'),
        laneSessionIdFor('int-1', 3, 'stage-only'),
      ].toSorted(),
    );
  });

  it('skips legacy unit rows without a section or session (pre-Instances lanes)', () => {
    const ids = collectIntentSessionIds('int-1', {
      units: [buildUnitRow({ executionId: 'int-1', sectionIndex: null, slug: 'old', now: NOW })],
      stages: [],
    });
    expect(ids).toEqual([runtimeSessionIdFor('int-1')]);
  });
});

describe('deleteRuntimeSessions', () => {
  it('deletes the main and every provided session against the capacity provider', async () => {
    const agentcore = { send: vi.fn().mockResolvedValue({}) };
    await deleteRuntimeSessions(agentcore, CP_ARN, 'int-1', {
      sessionIds: [
        laneSessionIdFor('int-1', 1, 'alpha'),
        laneSessionIdFor('int-1', 1, 'beta'),
        runtimeSessionIdFor('int-1'), // duplicate of the implicit main — deduped
      ],
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
        sessionIds: [laneSessionIdFor('int-1', 1, 'alpha')],
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
  it('deletes every persisted lane session, including one no longer in the plan', async () => {
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
    // Stop main + lanes (best-effort), then delete main + every persisted lane.
    expect(sentCommands(agentcore, 'StopRuntimeSessionCommand')).toHaveLength(4);
    const deletes = sentCommands(agentcore, 'DeleteCapacityProviderSessionCommand');
    expect(deletes.map((command) => command.input.sessionId).toSorted()).toEqual(
      [
        'aidlc-intent-int-1'.padEnd(33, '0'),
        'aidlc-intent-int-1-s1-alpha'.padEnd(33, '0'),
        'aidlc-intent-int-1-s1-beta'.padEnd(33, '0'),
        'aidlc-intent-int-1-s0-legacy-lane'.padEnd(33, '0'),
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

  it('keeps the intent records when a lane session delete fails — cascade retryable', async () => {
    const store = storeStub(records);
    const laneSession = laneSessionIdFor('int-1', 1, 'beta');
    const agentcore = {
      send: vi.fn().mockImplementation(async (command) => {
        if (
          command.constructor.name === 'DeleteCapacityProviderSessionCommand' &&
          command.input.sessionId === laneSession
        ) {
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
        intentId: 'int-1',
        meta: instancesMeta,
        agentcoreRuntimeTarget: { agentRuntimeArn: instancesMeta.environment.runtimeArn },
      }),
    ).rejects.toThrow('denied');
    // META survives, the intent still lists, and a re-run re-reads the SAME
    // records and retries the lane delete.
    expect(store.deleteExecution).not.toHaveBeenCalled();
  });
});
