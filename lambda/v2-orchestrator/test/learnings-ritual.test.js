// `SCOPE.learnings: on` — the ritual on the validation gate (§6.2), and the
// `RECEIPT#stage-approval` that change control later compares against (§6.3).
//
// Both ride the approval gate, so both are tested here against the same harness
// the findings channel uses. The two claims worth defending: the ritual is
// OPT-IN per scope (a run that does not author it opens the gate it always did),
// and a failure to record a learning never costs the run its approval.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __durableHandler } from '../index.js';
import { buildEventRow } from '../../shared/v2-process-keys.js';

// Timeline fixtures go through the SAME row builder the process store persists
// with, so `listEvents` returns the production shape (`type: 'Event'`, the name
// in `eventType`) and a reader keyed on the wrong field fails here.
let eventSeq = 0;
const persistedEvent = (fields) => {
  eventSeq += 1;
  return buildEventRow({
    executionId: 'exec-1',
    actor: 'agentcore',
    summary: '',
    now: new Date(Date.UTC(2026, 0, 1, 0, 0, eventSeq)).toISOString(),
    eventId: `ev-${eventSeq}`,
    ...fields,
  });
};

const makeCtx = () => {
  const stageCallbacks = new Map();
  const ctx = {
    logger: { info() {}, debug() {}, error() {} },
    step: async (_name, fn) => fn(),
    createCallback: async (name) => {
      if (String(name).startsWith('stage-cb-')) {
        let resolve;
        const promise = new Promise((r) => {
          resolve = r;
        });
        const callbackId = `cb-${name}`;
        stageCallbacks.set(callbackId, resolve);
        return [promise, callbackId];
      }
      return [Promise.resolve({ answer: null }), `cb-${name}`];
    },
    wait: async () => undefined,
    promise: {
      race: async (_name, promises) => Promise.race(promises),
      allSettled: async (_name, promises) => Promise.allSettled(promises),
    },
    runInChildContext: (_name, fn) => Promise.resolve().then(() => fn(ctx)),
    stageCallbackResolvers: stageCallbacks,
  };
  return ctx;
};

const META = {
  executionId: 'i1',
  intentId: 'i1',
  projectId: 'p1',
  status: 'CREATED',
  workflowId: 'aidlc-v2',
  workflowVersion: 1,
  scope: 'feature',
  startedAt: 'T',
  startedBy: 'u1',
  repos: ['owner/repo'],
  branch: 'aidlc/i1',
  baseBranch: 'main',
  gitProvider: 'github',
  agentCli: 'kiro',
  parkReleaseSeconds: 300,
  environment: { runtimeArn: 'arn:runtime', runtimeEndpoint: 'revision_r_1' },
};

const policyWith = (over) => ({
  sensorsEnabled: true,
  reviewClass: 'adversarial',
  reviewArtifact: null,
  summaryConfirmation: 'none',
  changeControl: null,
  learnings: 'off',
  skeleton: null,
  ...over,
});

const GATED_STAGE = {
  stageId: 'requirements-analysis',
  stageInstanceId: 'si-1',
  humanValidation: 'required',
  outputArtifacts: [{ artifact: 'requirements' }],
};

const PRODUCED_HEADS = [
  { artifactId: 'a1', artifactType: 'requirements', logicalKey: 'k1', snapshotHash: 'sha-1' },
];

let deps;
let ctx;
let invokes;
let stageVerdict;

const answeredGate = (answer) => {
  const gate = {
    humanTaskId: 'eg-validation-si-1-0-run1',
    status: 'answered',
    answer,
    answeredBy: 'u1',
    answeredByName: 'Ada',
    stageInstanceId: 'si-1',
  };
  let call = 0;
  return vi.fn(async () => {
    call += 1;
    return call === 1 ? null : gate;
  });
};

beforeEach(() => {
  invokes = [];
  ctx = makeCtx();
  stageVerdict = () => ({ ok: true, state: 'SUCCEEDED', producedHeads: PRODUCED_HEADS });
  deps = {
    store: {
      getExecution: vi.fn(async () => META),
      updateExecution: vi.fn(async () => ({})),
      createHumanTask: vi.fn(async (args) => ({ ...args, status: 'pending' })),
      setGateCallbackId: vi.fn(async () => ({})),
      supersedeHumanTask: vi.fn(async () => ({})),
      getHumanTask: answeredGate({ decision: 'approve' }),
      appendEvent: vi.fn(async () => ({})),
      putTrackerSync: vi.fn(async (args) => args),
      failRunningStageAttempt: vi.fn(async () => null),
      listUnits: vi.fn(async () => []),
      getUnit: vi.fn(async () => null),
      getStage: vi.fn(async () => ({ stageInstanceId: 'si-1', attempt: 0 })),
      listReceipts: vi.fn(async () => []),
      listEvents: vi.fn(async () => []),
      putReceipt: vi.fn(async (args) => args),
    },
    loadPlan: vi.fn(async () => ({
      valid: true,
      plan: { stages: [{ ...GATED_STAGE, policy: policyWith({ learnings: 'on' }) }] },
    })),
    invokeRuntime: vi.fn(async (payload) => {
      if (payload.command === 'create-workflow-checkpoint') return { ok: true, checkpointId: 'cp' };
      invokes.push(payload);
      if (payload.command === 'run-stage-start') {
        ctx.stageCallbackResolvers.get(payload.stageCallbackId)(stageVerdict());
        return { ok: true, accepted: true, stageId: payload.stageId };
      }
      return { ok: true };
    }),
    issueAgentCredentialGrant: vi.fn(async () => 'grant'),
    stopSession: vi.fn(async () => ({ stopped: true })),
    broadcast: vi.fn(async () => {}),
    openPr: vi.fn(async () => ({ skipped: true, reason: 'no_changes' })),
    comparePrBranches: vi.fn(async () => ({ status: 'unknown' })),
    applicationUrl: 'https://aidlc.example.test/',
  };
});

const run = () =>
  __durableHandler({ action: 'start', intentId: 'i1', executionId: 'i1' }, ctx, deps);
const openedGate = () => deps.store.createHumanTask.mock.calls.at(-1)[0];
const receiptsOfKind = (kind) =>
  deps.store.putReceipt.mock.calls.map(([args]) => args).filter((args) => args.kind === kind);
const learningInvokes = () => invokes.filter((p) => p.command === 'record-learning');

describe('learnings ritual — opt-in', () => {
  it('asks the question and flags the gate when the scope authors learnings: on', async () => {
    await run();
    const gate = openedGate();
    expect(gate.learningsRitual).toBe(true);
    expect(gate.prompt).toContain('## Anything to add for next time?');
    // Upstream asks even with zero candidates.
    expect(gate.prompt).toContain('This stage surfaced no candidates.');
    expect(gate.prompt).toContain('{ "learnings": "<text>" }');
    // The option list is untouched: the ritual is not a decision.
    expect(gate.options).toEqual(['approve', 'request-changes']);
  });

  it('is silent for learnings: off — no flag, no prompt section', async () => {
    deps.loadPlan = vi.fn(async () => ({
      valid: true,
      plan: { stages: [{ ...GATED_STAGE, policy: policyWith({ learnings: 'off' }) }] },
    }));
    await run();
    expect(openedGate()).not.toHaveProperty('learningsRitual');
    expect(openedGate().prompt).not.toContain('Anything to add');
  });

  it('is silent without a resolved release policy', async () => {
    deps.loadPlan = vi.fn(async () => ({ valid: true, plan: { stages: [GATED_STAGE] } }));
    await run();
    expect(openedGate()).not.toHaveProperty('learningsRitual');
    expect(openedGate().prompt).not.toContain('Anything to add');
  });

  it('lists the candidates the stage surfaced', async () => {
    deps.store.listEvents = vi.fn(async () => [
      persistedEvent({
        type: 'v2.learning.candidate',
        stageInstanceId: 'si-1',
        summary: 'always pin the release',
      }),
      persistedEvent({
        type: 'v2.learning.candidate',
        stageInstanceId: 'other',
        summary: 'not this stage',
      }),
    ]);
    await run();
    expect(openedGate().prompt).toContain('  - always pin the release');
    expect(openedGate().prompt).not.toContain('not this stage');
  });
});

describe('learnings ritual — recording the answer', () => {
  it('dispatches record-learning for a non-empty answer', async () => {
    deps.store.getHumanTask = answeredGate({
      decision: 'approve',
      learnings: '  NEVER store plaintext secrets  ',
    });
    const res = await run();
    expect(res.ok).toBe(true);
    expect(learningInvokes()).toEqual([
      expect.objectContaining({
        command: 'record-learning',
        projectId: 'p1',
        intentId: 'i1',
        stageInstanceId: 'si-1',
        stageId: 'requirements-analysis',
        learnings: 'NEVER store plaintext secrets',
        recordedByName: 'Ada',
      }),
    ]);
    expect(receiptsOfKind('stage-approval')[0].detail.learnings).toBe('offered');
  });

  // Empty is a DECISION, not an absence: it is recorded on the approval receipt
  // and costs no dispatch.
  it('records "none" and dispatches nothing for an empty answer', async () => {
    deps.store.getHumanTask = answeredGate({ decision: 'approve', learnings: '   ' });
    await run();
    expect(learningInvokes()).toEqual([]);
    expect(receiptsOfKind('stage-approval')[0].detail.learnings).toBe('none');
  });

  // The stage is already approved when the ritual runs, so a container-side
  // failure must not un-approve it.
  it('does not fail the run when the container cannot record the learning', async () => {
    deps.store.getHumanTask = answeredGate({ decision: 'approve', learnings: 'something' });
    const inner = deps.invokeRuntime;
    deps.invokeRuntime = vi.fn(async (payload) => {
      if (payload.command === 'record-learning') throw new Error('neptune unreachable');
      return inner(payload);
    });
    const res = await run();
    expect(res.ok).toBe(true);
  });
});

describe('stage-approval receipt — the change-control record', () => {
  it('freezes the produced fingerprints on approval', async () => {
    await run();
    expect(receiptsOfKind('stage-approval')[0]).toMatchObject({
      executionId: 'i1',
      stageInstanceId: 'si-1',
      attempt: 0,
      choice: 'approve',
      decidedBy: 'u1',
      decidedByName: 'Ada',
      detail: expect.objectContaining({
        approvedInputs: [{ logicalKey: 'k1', snapshotHash: 'sha-1' }],
      }),
    });
  });

  it('records an empty input set rather than nothing when the graph was unreadable', async () => {
    stageVerdict = () => ({ ok: true, state: 'SUCCEEDED' });
    await run();
    expect(receiptsOfKind('stage-approval')[0].detail.approvedInputs).toEqual([]);
  });

  // Without a resolved policy there is no change control to feed, so the write is
  // not performed at all — the byte-identity rule for an unpinned run.
  it('writes no approval receipt without a resolved release policy', async () => {
    deps.loadPlan = vi.fn(async () => ({ valid: true, plan: { stages: [GATED_STAGE] } }));
    await run();
    expect(receiptsOfKind('stage-approval')).toEqual([]);
  });
});
