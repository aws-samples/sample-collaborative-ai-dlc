import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { withDurableExecution } from '@aws/durable-execution-sdk-js';
import {
  LocalDurableTestRunner,
  WaitingOperationStatus,
} from '@aws/durable-execution-sdk-js-testing';

// ---------------------------------------------------------------------------
// WP0 PoC (d) — docs/v2-parallel.md Part C.
//
// The WP1 async-stage lifecycle, end to end, across replays:
//
//   createCallback (stage callback) → run-stage-start step (dispatches the
//   job + callbackId to the container; returns in ms) → suspend at zero
//   compute → container finishes the background job and completes the
//   callback → resume → merge/finalize step.
//
// Verified properties:
//   1. The dispatch step runs EXACTLY ONCE per stage across all
//      suspend/replay cycles — the container never sees a duplicate job for
//      the same stage attempt (traceability: one job per callbackId).
//   2. Sequential multi-stage flow: each stage's finalize step lands before
//      the next stage's dispatch; ordering is stable across replays.
//   3. Per-lane lifecycles run concurrently under ctx.parallel; jobs
//      completing out of order resume only their own lane's stage.
//   4. Failure path: the container reports a failed job via callback FAILURE;
//      the owning stage converts it into a deterministic retry — a NEW
//      callback + a NEW dispatch (fresh attempt id, same lane/branch
//      semantics as upstream's "retry inside the existing worktree") — while
//      other lanes are untouched.
//   5. Callback heartbeats are accepted while the job runs (the container's
//      HealthyBusy analogue on the durable side).
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await LocalDurableTestRunner.setupTestEnvironment();
});

afterAll(async () => {
  await LocalDurableTestRunner.teardownTestEnvironment();
});

// A stand-in for the AgentCore container: records dispatched jobs; the test
// completes them through the runner's callback API (the local analogue of
// SendDurableExecutionCallbackSuccess from the container task role).
const makeContainer = () => {
  const jobs = [];
  return {
    jobs,
    dispatch(job) {
      jobs.push(job);
      return { accepted: true };
    },
    jobsFor(stage) {
      return jobs.filter((j) => j.stage === stage);
    },
  };
};

// One stage's async lifecycle inside a durable (lane) context.
// `attempt` keys the callback + dispatch step names so a retry is a fresh
// durable identity — exactly how run-stage resume gates are keyed today
// (`run-<stageId>-resume-<gateId>` in lambda/v2-orchestrator/index.js).
//
// WP1 note (verified here): heartbeats are only accepted when the callback is
// created with a `heartbeatTimeout`; production should pair
// timeout ≈ AgentCore's 8h async-job ceiling with a heartbeatTimeout that
// detects a dead container long before that.
const runStageAsync = async (laneCtx, { unit, stage, attempt, container }) => {
  const suffix = attempt > 1 ? `-retry-${attempt}` : '';
  const [stageDone, callbackId] = await laneCtx.createCallback(`cb-${unit}-${stage}${suffix}`, {
    timeout: { hours: 8 },
    heartbeatTimeout: { minutes: 15 },
  });
  await laneCtx.step(`dispatch-${unit}-${stage}${suffix}`, async () =>
    container.dispatch({ unit, stage, attempt, callbackId }),
  );
  let outcome;
  try {
    outcome = { ok: true, result: await stageDone };
  } catch (err) {
    outcome = { ok: false, error: String(err?.errorMessage ?? err?.message ?? err) };
  }
  return { outcome, callbackId };
};

describe('WP0d — async-stage lifecycle (start → background → callback → finalize)', () => {
  it('sequential stages: exactly-once dispatch and ordered finalize steps across replays', async () => {
    const container = makeContainer();
    const finalized = [];
    const STAGES = ['functional-design', 'code-generation'];

    const handler = withDurableExecution(async (input, ctx) => {
      const results = [];
      for (const stage of STAGES) {
        const { outcome } = await runStageAsync(ctx, {
          unit: 'auth',
          stage,
          attempt: 1,
          container,
        });
        if (!outcome.ok) throw new Error(`stage ${stage} failed: ${outcome.error}`);
        await ctx.step(`finalize-${stage}`, async () => {
          // Production: engine commit+push, STAGE row → SUCCEEDED.
          finalized.push(stage);
          return true;
        });
        results.push({ stage, result: outcome.result });
      }
      return results;
    });

    const runner = new LocalDurableTestRunner({ handlerFunction: handler });
    const executionPromise = runner.run({ payload: {} });

    // Container completes stage 1, then stage 2 — each completion triggers a
    // full suspend/replay cycle.
    const cb1 = await runner
      .getOperation('cb-auth-functional-design')
      .waitForData(WaitingOperationStatus.STARTED);
    // Heartbeat while the job "runs" (long-running background job liveness).
    await cb1.sendCallbackHeartbeat();
    await cb1.sendCallbackSuccess('design-ok');

    const cb2 = await runner
      .getOperation('cb-auth-code-generation')
      .waitForData(WaitingOperationStatus.STARTED);
    await cb2.sendCallbackSuccess('code-ok');

    const execution = await executionPromise;
    expect(execution.getResult()).toEqual([
      { stage: 'functional-design', result: 'design-ok' },
      { stage: 'code-generation', result: 'code-ok' },
    ]);

    // Exactly one dispatched job per stage, despite ≥2 replays.
    expect(container.jobsFor('functional-design')).toHaveLength(1);
    expect(container.jobsFor('code-generation')).toHaveLength(1);
    // Stage 2 was dispatched only after stage 1 finalized.
    expect(finalized).toEqual(STAGES);
    const dispatchOrder = container.jobs.map((j) => j.stage);
    expect(dispatchOrder).toEqual(STAGES);
    // Distinct callback ids — the per-job attribution key.
    expect(new Set(container.jobs.map((j) => j.callbackId)).size).toBe(2);
  });

  it('per-lane lifecycles in parallel: out-of-order job completion resumes only the owning lane', async () => {
    const container = makeContainer();
    const UNITS = ['auth', 'catalog', 'payments'];

    const handler = withDurableExecution(async (input, ctx) => {
      const wave = await ctx.parallel(
        'lanes',
        UNITS.map((unit) => ({
          name: `lane-${unit}`,
          func: async (laneCtx) => {
            const { outcome } = await runStageAsync(laneCtx, {
              unit,
              stage: 'code-generation',
              attempt: 1,
              container,
            });
            return { unit, result: outcome.ok ? outcome.result : `failed:${outcome.error}` };
          },
        })),
      );
      return Object.fromEntries(wave.getResults().map((r) => [r.unit, r.result]));
    });

    const runner = new LocalDurableTestRunner({ handlerFunction: handler });
    const executionPromise = runner.run({ payload: {} });

    const gates = {};
    for (const unit of UNITS) {
      gates[unit] = await runner
        .getOperation(`cb-${unit}-code-generation`)
        .waitForData(WaitingOperationStatus.STARTED);
    }
    // All three jobs were dispatched before any completion.
    expect(container.jobs).toHaveLength(3);

    // Complete out of order.
    await gates.payments.sendCallbackSuccess('payments-code');
    await gates.auth.sendCallbackSuccess('auth-code');
    await gates.catalog.sendCallbackSuccess('catalog-code');

    const execution = await executionPromise;
    expect(execution.getResult()).toEqual({
      auth: 'auth-code',
      catalog: 'catalog-code',
      payments: 'payments-code',
    });
    // Still exactly one job per unit after three suspend/replay cycles.
    for (const unit of UNITS) {
      expect(container.jobs.filter((j) => j.unit === unit)).toHaveLength(1);
    }
  });

  it('failure path: container-reported job failure triggers a fresh dispatch (retry) without disturbing other lanes', async () => {
    const container = makeContainer();
    const UNITS = ['auth', 'catalog'];

    const handler = withDurableExecution(async (input, ctx) => {
      const wave = await ctx.parallel(
        'lanes',
        UNITS.map((unit) => ({
          name: `lane-${unit}`,
          func: async (laneCtx) => {
            for (let attempt = 1; attempt <= 2; attempt++) {
              const { outcome } = await runStageAsync(laneCtx, {
                unit,
                stage: 'code-generation',
                attempt,
                container,
              });
              if (outcome.ok) return { unit, state: 'MERGED', result: outcome.result };
              await laneCtx.step(`record-failure-${unit}-${attempt}`, async () => true);
            }
            return { unit, state: 'FAILED' };
          },
        })),
      );
      return Object.fromEntries(wave.getResults().map((r) => [r.unit, r]));
    });

    const runner = new LocalDurableTestRunner({ handlerFunction: handler });
    const executionPromise = runner.run({ payload: {} });

    const authGate1 = await runner
      .getOperation('cb-auth-code-generation')
      .waitForData(WaitingOperationStatus.STARTED);
    const catalogGate = await runner
      .getOperation('cb-catalog-code-generation')
      .waitForData(WaitingOperationStatus.STARTED);

    // auth's first job fails (e.g. CLI crash surfaced by the container).
    await authGate1.sendCallbackFailure({
      errorMessage: 'cli exited 1',
      errorType: 'StageJobFailed',
    });
    // auth retries with a NEW callback + dispatch.
    const authGate2 = await runner
      .getOperation('cb-auth-code-generation-retry-2')
      .waitForData(WaitingOperationStatus.STARTED);
    await authGate2.sendCallbackSuccess('auth-code-attempt-2');
    // catalog was never disturbed.
    await catalogGate.sendCallbackSuccess('catalog-code');

    const execution = await executionPromise;
    expect(execution.getResult()).toEqual({
      auth: { unit: 'auth', state: 'MERGED', result: 'auth-code-attempt-2' },
      catalog: { unit: 'catalog', state: 'MERGED', result: 'catalog-code' },
    });

    const authJobs = container.jobs.filter((j) => j.unit === 'auth');
    expect(authJobs).toHaveLength(2);
    expect(authJobs.map((j) => j.attempt)).toEqual([1, 2]);
    // Fresh attempt = fresh callbackId (no stale-callback reuse).
    expect(authJobs[0].callbackId).not.toBe(authJobs[1].callbackId);
    expect(container.jobs.filter((j) => j.unit === 'catalog')).toHaveLength(1);
  });
});
