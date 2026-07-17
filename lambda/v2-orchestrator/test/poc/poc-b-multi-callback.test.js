import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { withDurableExecution } from '@aws/durable-execution-sdk-js';
import {
  LocalDurableTestRunner,
  WaitingOperationStatus,
} from '@aws/durable-execution-sdk-js-testing';

// ---------------------------------------------------------------------------
// WP0 PoC (b) — docs/v2-parallel.md Part C.
//
// Proves that multiple lanes can hold their own pending human-gate callbacks
// CONCURRENTLY and be resumed OUT OF ORDER, with every answer routed to the
// lane that asked (traceability: who asked what, who answered what).
//
// Properties verified:
//   1. N parallel lanes each park on their own durable callback; the
//      execution suspends with N callbacks pending at once.
//   2. Completing the callbacks in reverse/arbitrary order resumes exactly
//      the lane that owns the callback; other lanes stay parked.
//   3. Each lane observes precisely its own answer (no cross-lane bleed).
//   4. Work performed before parking is not repeated across the multiple
//      suspend/replay cycles caused by out-of-order completion.
//   5. A callback failure (gate cancelled / superseded) surfaces as an error
//      in the owning lane only, and the lane can convert it into a
//      deterministic outcome while other lanes proceed normally.
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await LocalDurableTestRunner.setupTestEnvironment();
});

afterAll(async () => {
  await LocalDurableTestRunner.teardownTestEnvironment();
});

const UNITS = ['auth', 'catalog', 'payments'];

// Build a handler where every unit's lane does pre-work (a step), parks on
// its own gate callback, then does post-work (another step) that records the
// answer it saw. `log` records real step executions (memoized on replay).
const buildMultiGateHandler = (log) =>
  withDurableExecution(async (input, ctx) => {
    const wave = await ctx.parallel(
      'gated-lanes',
      UNITS.map((unit) => ({
        name: `lane-${unit}`,
        func: async (laneCtx) => {
          await laneCtx.step(`pre-${unit}`, async () => {
            log.push(`pre:${unit}`);
            return true;
          });
          const [gatePromise] = await laneCtx.createCallback(`gate-${unit}`);
          let answer;
          try {
            answer = await gatePromise;
          } catch (err) {
            // Gate cancelled/superseded — deterministic lane outcome, not a
            // crash (halt-and-ask semantics preserve other lanes).
            log.push(`cancelled:${unit}`);
            return { unit, state: 'CANCELLED', reason: String(err?.message ?? err) };
          }
          await laneCtx.step(`post-${unit}`, async () => {
            log.push(`post:${unit}:${answer}`);
            return true;
          });
          return { unit, state: 'MERGED', answer };
        },
      })),
    );
    return Object.fromEntries(wave.getResults().map((r) => [r.unit, r]));
  });

describe('WP0b — multi-callback park + out-of-order resume', () => {
  it('three lanes park on three concurrent gates; answers arrive in reverse order and route to their owners', async () => {
    const log = [];
    const runner = new LocalDurableTestRunner({ handlerFunction: buildMultiGateHandler(log) });
    const executionPromise = runner.run({ payload: {} });

    // All three gates become pending concurrently (multi-CALLBACK_PENDING).
    const gates = {};
    for (const unit of UNITS) {
      gates[unit] = await runner
        .getOperation(`gate-${unit}`)
        .waitForData(WaitingOperationStatus.STARTED);
    }
    // Every gate has a distinct callbackId — the attribution key the engine
    // will persist on the HUMAN# row per unit.
    const ids = UNITS.map((u) => gates[u].getCallbackDetails().callbackId);
    expect(new Set(ids).size).toBe(UNITS.length);

    // Answer out of order: payments → catalog → auth, distinct answers.
    await gates.payments.sendCallbackSuccess('answer-for-payments');
    await gates.catalog.sendCallbackSuccess('answer-for-catalog');
    await gates.auth.sendCallbackSuccess('answer-for-auth');

    const execution = await executionPromise;
    const results = execution.getResult();

    // Attribution: each lane saw exactly its own answer.
    for (const unit of UNITS) {
      expect(results[unit]).toEqual({
        unit,
        state: 'MERGED',
        answer: `answer-for-${unit}`,
      });
    }
    // Pre-work ran exactly once per lane despite multiple suspend/replay
    // cycles (one per out-of-order completion).
    for (const unit of UNITS) {
      expect(log.filter((e) => e === `pre:${unit}`)).toHaveLength(1);
      expect(log.filter((e) => e === `post:${unit}:answer-for-${unit}`)).toHaveLength(1);
    }
    // No cross-lane bleed: no post entry carries another unit's answer.
    expect(log.some((e) => /^post:auth:(?!answer-for-auth)/.test(e))).toBe(false);
    expect(log.some((e) => /^post:catalog:(?!answer-for-catalog)/.test(e))).toBe(false);
    expect(log.some((e) => /^post:payments:(?!answer-for-payments)/.test(e))).toBe(false);
  });

  it('a partial resume leaves the other gates parked (state preserved across the intermediate suspend)', async () => {
    const log = [];
    const runner = new LocalDurableTestRunner({ handlerFunction: buildMultiGateHandler(log) });
    const executionPromise = runner.run({ payload: {} });

    const gates = {};
    for (const unit of UNITS) {
      gates[unit] = await runner
        .getOperation(`gate-${unit}`)
        .waitForData(WaitingOperationStatus.STARTED);
    }

    // Resume ONLY catalog and let its post-work land.
    await gates.catalog.sendCallbackSuccess('answer-for-catalog');
    const deadline = Date.now() + 10_000;
    while (!log.includes('post:catalog:answer-for-catalog')) {
      if (Date.now() > deadline) throw new Error('catalog lane did not resume');
      await new Promise((r) => setTimeout(r, 10));
    }
    // The other lanes must not have progressed past their gates.
    expect(log.filter((e) => e.startsWith('post:auth'))).toHaveLength(0);
    expect(log.filter((e) => e.startsWith('post:payments'))).toHaveLength(0);

    await gates.auth.sendCallbackSuccess('answer-for-auth');
    await gates.payments.sendCallbackSuccess('answer-for-payments');

    const execution = await executionPromise;
    const results = execution.getResult();
    for (const unit of UNITS) {
      expect(results[unit].state).toBe('MERGED');
      expect(results[unit].answer).toBe(`answer-for-${unit}`);
    }
  });

  it('a cancelled gate fails only its own lane; the others resume and finish', async () => {
    const log = [];
    const runner = new LocalDurableTestRunner({ handlerFunction: buildMultiGateHandler(log) });
    const executionPromise = runner.run({ payload: {} });

    const gates = {};
    for (const unit of UNITS) {
      gates[unit] = await runner
        .getOperation(`gate-${unit}`)
        .waitForData(WaitingOperationStatus.STARTED);
    }

    // Cancel catalog's gate (superseded / intent rewound), approve the rest.
    await gates.catalog.sendCallbackFailure({
      errorMessage: 'gate superseded',
      errorType: 'GateSuperseded',
    });
    await gates.auth.sendCallbackSuccess('answer-for-auth');
    await gates.payments.sendCallbackSuccess('answer-for-payments');

    const execution = await executionPromise;
    const results = execution.getResult();

    expect(results.catalog.state).toBe('CANCELLED');
    expect(log).toContain('cancelled:catalog');
    expect(log.filter((e) => e.startsWith('post:catalog'))).toHaveLength(0);
    expect(results.auth).toMatchObject({ state: 'MERGED', answer: 'answer-for-auth' });
    expect(results.payments).toMatchObject({ state: 'MERGED', answer: 'answer-for-payments' });
  });
});
