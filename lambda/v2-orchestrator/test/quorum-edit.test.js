import { describe, it, expect, beforeEach, vi } from 'vitest';
import { runQuorumEdit, quorumEditSessionIdFor } from '../quorum-edit.js';
import { __durableHandler } from '../index.js';

// The Quorum edit flow is deterministic process control over injected deps and
// a fake DurableContext — no AWS/Neptune (the same isolation approach as
// orchestrator.test.js). Callbacks are deferreds the fake runtime / the test
// resolves, mirroring SendDurableExecutionCallbackSuccess.

const PLAN = {
  summary: 'Two artifacts drift.',
  items: [
    { artifactId: 'a2', action: 'update', rationale: 'r', proposedChange: 'p' },
    { artifactId: 'a3', action: 'verify-unaffected', rationale: 'ok', proposedChange: '' },
  ],
};

const META = {
  executionId: 'i1',
  intentId: 'i1',
  projectId: 'p1',
  status: 'SUCCEEDED',
  deriveEnrichment: 'llm',
  agentCli: 'kiro',
  cliModels: { claude: 'us.anthropic.claude-opus-4-8' },
};

const EDIT = {
  editId: 'qe-1',
  artifactId: 'a1',
  artifactTitle: 'Market research',
  changeDescription: 'Target the EU market',
  requestedByName: 'Uma',
  state: 'PLANNING',
};

const makeCtx = () => {
  const resolvers = new Map();
  const rejecters = new Map();
  const ctx = {
    logger: { info() {}, error() {} },
    step: async (_name, fn) => fn(),
    createCallback: async (name) => {
      let resolve;
      let reject;
      const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      });
      const callbackId = `cb-${name}`;
      resolvers.set(callbackId, resolve);
      rejecters.set(callbackId, reject);
      return [promise, callbackId];
    },
    resolvers,
    rejecters,
  };
  return ctx;
};

let ctx;
let deps;
let invokes;
beforeEach(() => {
  ctx = makeCtx();
  invokes = [];
  deps = {
    store: {
      getExecution: vi.fn(async () => META),
      getQuorumEdit: vi.fn(async () => EDIT),
      updateQuorumEdit: vi.fn(async (args) => ({ ...EDIT, ...args.fields, state: args.state })),
      appendEvent: vi.fn(async () => ({})),
      createSteering: vi.fn(async (args) => ({ steerId: 'st-1', ...args })),
    },
    invokeRuntime: vi.fn(async (payload) => {
      invokes.push(payload);
      const cb = ctx.resolvers.get(payload.callbackId);
      if (payload.command === 'quorum-edit-plan-start') {
        cb(JSON.stringify({ ok: true, plan: PLAN }));
        return { ok: true, accepted: true };
      }
      if (payload.command === 'quorum-edit-apply-start') {
        cb(
          JSON.stringify({
            ok: true,
            updatedArtifactIds: ['a2'],
            verifiedArtifactIds: ['a3'],
            failedArtifactIds: [],
          }),
        );
        return { ok: true, accepted: true };
      }
      return { ok: false, reason: 'unknown_command' };
    }),
    stopSession: vi.fn(async () => ({ stopped: true })),
    broadcast: vi.fn(async () => {}),
  };
});

const EVENT = { action: 'quorum-edit', intentId: 'i1', executionId: 'i1', editId: 'qe-1' };

// Resolve the decision callback like lambda/intents does (resumeDurableCallback
// wraps the decision as { answer }).
const approve = (approvedArtifactIds = ['a2', 'a3']) => {
  const resolve = ctx.resolvers.get('cb-qe-decision-cb-qe-1');
  resolve(
    JSON.stringify({
      answer: { decision: 'approve', approvedArtifactIds, decidedBy: 'u1', decidedByName: 'Uma' },
    }),
  );
};

describe('runQuorumEdit', () => {
  it('drives plan → approval → apply → SUCCEEDED with the dedicated session', async () => {
    const run = runQuorumEdit(EVENT, ctx, deps);
    // Give the plan leg a tick, then approve.
    await vi.waitFor(() => {
      if (!ctx.resolvers.has('cb-qe-decision-cb-qe-1')) throw new Error('not parked yet');
    });
    approve();
    const res = await run;
    expect(res).toMatchObject({ ok: true, editId: 'qe-1' });

    expect(invokes.map((p) => p.command)).toEqual([
      'quorum-edit-plan-start',
      'quorum-edit-apply-start',
    ]);
    // The plan dispatch carries the change description + model selection.
    expect(invokes[0]).toMatchObject({
      artifactId: 'a1',
      changeDescription: 'Target the EU market',
      requestedCli: 'kiro',
    });
    // The apply dispatch carries the APPROVED ids + snapshotted enrichment.
    expect(invokes[1]).toMatchObject({
      approvedArtifactIds: ['a2', 'a3'],
      enrichment: 'llm',
      decidedBy: 'u1',
    });

    // AWAITING_APPROVAL parked with the plan + the decision callback stamped.
    const parkCall = deps.store.updateQuorumEdit.mock.calls.find(
      ([a]) => a.state === 'AWAITING_APPROVAL',
    )[0];
    expect(parkCall.fromStates).toEqual(['PLANNING']);
    expect(parkCall.fields.plan).toEqual(PLAN);
    expect(parkCall.fields.callbackId).toBe('cb-qe-decision-cb-qe-1');

    // Terminal SUCCEEDED with the apply outcome.
    const finalCall = deps.store.updateQuorumEdit.mock.calls.find(
      ([a]) => a.state === 'SUCCEEDED',
    )[0];
    expect(finalCall.fields.updatedArtifactIds).toEqual(['a2']);
    expect(finalCall.fields.verifiedArtifactIds).toEqual(['a3']);

    // The dedicated session (never the stage session) was used and freed.
    expect(deps.stopSession).toHaveBeenCalledWith(quorumEditSessionIdFor('i1'));
    // The run is terminal (SUCCEEDED meta) — no parked conversation to warn.
    expect(deps.store.createSteering).not.toHaveBeenCalled();
  });

  it('a successful apply on a PARKED run records an artifact-edit steering row', async () => {
    deps.store.getExecution = vi.fn(async () => ({ ...META, status: 'WAITING' }));
    const run = runQuorumEdit(EVENT, ctx, deps);
    await vi.waitFor(() => {
      if (!ctx.resolvers.has('cb-qe-decision-cb-qe-1')) throw new Error('not parked yet');
    });
    approve();
    const res = await run;
    expect(res).toMatchObject({ ok: true, editId: 'qe-1' });
    // The next deterministic injection point (gate resume / fresh stage start)
    // tells the resumed agent to re-read the changed documents.
    expect(deps.store.createSteering).toHaveBeenCalledWith(
      expect.objectContaining({ executionId: 'i1', kind: 'artifact-edit' }),
    );
    const message = deps.store.createSteering.mock.calls[0][0].message;
    expect(message).toContain('a1'); // the target
    expect(message).toContain('a2'); // the approved downstream update
  });

  it('a rejected plan ends the flow without an apply dispatch', async () => {
    const run = runQuorumEdit(EVENT, ctx, deps);
    await vi.waitFor(() => {
      if (!ctx.resolvers.has('cb-qe-decision-cb-qe-1')) throw new Error('not parked yet');
    });
    ctx.resolvers.get('cb-qe-decision-cb-qe-1')(
      JSON.stringify({ answer: { decision: 'reject', decidedBy: 'u1' } }),
    );
    const res = await run;
    expect(res).toMatchObject({ ok: true, rejected: true });
    expect(invokes.map((p) => p.command)).toEqual(['quorum-edit-plan-start']);
  });

  it('a failed plan job marks the session FAILED', async () => {
    deps.invokeRuntime = vi.fn(async (payload) => {
      ctx.resolvers.get(payload.callbackId)(
        JSON.stringify({ ok: false, reason: 'plan_unparseable' }),
      );
      return { ok: true, accepted: true };
    });
    const res = await runQuorumEdit(EVENT, ctx, deps);
    expect(res).toMatchObject({ ok: false, reason: 'plan_unparseable' });
    const failCall = deps.store.updateQuorumEdit.mock.calls.find(([a]) => a.state === 'FAILED')[0];
    expect(failCall.fields.failureReason).toContain('plan_unparseable');
  });

  it('a refused plan dispatch fails the session (no deadlock on the callback)', async () => {
    deps.invokeRuntime = vi.fn(async () => ({ ok: false, reason: 'job_already_running' }));
    const res = await runQuorumEdit(EVENT, ctx, deps);
    expect(res).toMatchObject({ ok: false, reason: 'job_already_running' });
  });

  it('a decision-callback timeout retires the session as CANCELLED', async () => {
    const run = runQuorumEdit(EVENT, ctx, deps);
    await vi.waitFor(() => {
      if (!ctx.rejecters.has('cb-qe-decision-cb-qe-1')) throw new Error('not parked yet');
    });
    ctx.rejecters.get('cb-qe-decision-cb-qe-1')(new Error('callback timed out'));
    const res = await run;
    expect(res).toMatchObject({ ok: false, reason: 'decision_timeout' });
    const cancelCall = deps.store.updateQuorumEdit.mock.calls.find(
      ([a]) => a.state === 'CANCELLED',
    )[0];
    expect(cancelCall.fields.failureReason).toContain('decision_timeout');
  });

  it('an apply failure lands FAILED with the reported artifact outcome', async () => {
    deps.invokeRuntime = vi.fn(async (payload) => {
      if (payload.command === 'quorum-edit-plan-start') {
        ctx.resolvers.get(payload.callbackId)(JSON.stringify({ ok: true, plan: PLAN }));
      } else {
        ctx.resolvers.get(payload.callbackId)(
          JSON.stringify({ ok: false, reason: 'target_rewrite_failed' }),
        );
      }
      return { ok: true, accepted: true };
    });
    const run = runQuorumEdit(EVENT, ctx, deps);
    await vi.waitFor(() => {
      if (!ctx.resolvers.has('cb-qe-decision-cb-qe-1')) throw new Error('not parked yet');
    });
    approve();
    const res = await run;
    expect(res).toMatchObject({ ok: false, editId: 'qe-1' });
    const finalCall = deps.store.updateQuorumEdit.mock.calls.find(([a]) => a.state === 'FAILED')[0];
    expect(finalCall.fields.failureReason).toBe('target_rewrite_failed');
  });

  it('is routed by the durable handler through action=quorum-edit', async () => {
    const run = __durableHandler(EVENT, ctx, deps);
    await vi.waitFor(() => {
      if (!ctx.resolvers.has('cb-qe-decision-cb-qe-1')) throw new Error('not parked yet');
    });
    approve();
    const res = await run;
    expect(res).toMatchObject({ ok: true, editId: 'qe-1' });
  });
});
