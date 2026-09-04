import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { withDurableExecution } from '@aws/durable-execution-sdk-js';
import {
  LocalDurableTestRunner,
  WaitingOperationStatus,
} from '@aws/durable-execution-sdk-js-testing';
import sensorContractPkg from '../../../shared/v2-sensor-contract.js';

const { parseBoltDag } = sensorContractPkg;

// ---------------------------------------------------------------------------
// WP0 PoC (a) — docs/v2-parallel.md Part C.
//
// Proves, on the local durable test runner (real replay/suspend semantics —
// NOT the fake ctx used by orchestrator.test.js), the two lane-scheduling
// shapes over the methodology's own unit-of-work-dependency DAG:
//
//   1. Batch barriers:  for (batch of dag.batches) await ctx.map(batch, lane)
//   2. True wavefront:  one ctx.runInChildContext per lane; dependent lanes
//      await their dependency lanes' DurablePromises directly.
//
// VERIFIED NEGATIVE FINDING (see the dedicated test below): branches of
// ctx.parallel / child contexts that COMPLETED before a suspend are NOT
// re-executed on replay — their DurablePromise resolves from checkpointed
// history. Therefore any wavefront built on plain in-handler deferreds that
// completed lanes must re-resolve on replay deadlocks after the first
// suspend/resume cycle (e.g. a human-gate callback). The replay-safe wavefront
// awaits the lanes' own DurablePromises, which the SDK resolves from history.
//
// Also proves the production-critical properties the plan relies on:
//   - stage step bodies execute exactly once across suspend/replay cycles;
//   - lane failure isolation: FAILED lane → dependents report BLOCKED without
//     running their stages, independent lanes finish (halt-and-ask shape);
//   - the real `parseBoltDag` output drives scheduling (no ad-hoc DAG model).
//
// Concurrency-cap note for WP5: the wavefront shape has no built-in
// maxConcurrency (that belongs to ctx.map/ctx.parallel configs). For
// `maxParallelUnits` either fall back to batch barriers via ctx.map or add an
// app-level semaphore — replayed (completed) lanes never execute their bodies,
// so they never re-acquire permits; only genuinely pending lanes contend.
//
// NOTE on the testing-SDK peer range: @aws/durable-execution-sdk-js-testing
// @1.1.1 declares peer @aws/durable-execution-sdk-js@^1.0.1 while production
// pins 2.0.0. This suite is the compatibility proof; if it passes, the
// override is safe. If a future SDK bump breaks it, this file fails first.
// ---------------------------------------------------------------------------

// The exact fenced-YAML artifact shape units-generation produces upstream.
const DAG_ARTIFACT = `# Unit of Work Dependency

\`\`\`yaml
units:
  - name: auth
    depends_on: []
  - name: catalog
    depends_on: []
  - name: checkout
    depends_on: [auth, catalog]
  - name: payments
    depends_on: []
\`\`\`
`;

const ALL_UNITS = ['auth', 'catalog', 'checkout', 'payments'];

// Execution log: entries are pushed from *inside step bodies*, which the SDK
// memoizes on replay — so the log records real executions, not replays.
let log;
beforeEach(() => {
  log = [];
});

const record = (entry) => log.push(entry);
const countOf = (entry) => log.filter((e) => e === entry).length;

// Poll the execution log until an entry appears. Used to gate one lane's step
// on another lane's *completion having been observed by the test* — this makes
// ordering proofs deterministic instead of timing-based: if the scheduler did
// not allow the observed lane to finish first, the test hangs and times out
// rather than passing flakily.
const waitForLogEntry = async (entry, { timeoutMs = 10_000 } = {}) => {
  const deadline = Date.now() + timeoutMs;
  while (!log.includes(entry)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for log entry ${entry}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};

const NO_RETRY = { retryStrategy: () => ({ shouldRetry: false }) };

beforeAll(async () => {
  await LocalDurableTestRunner.setupTestEnvironment();
});

afterAll(async () => {
  await LocalDurableTestRunner.teardownTestEnvironment();
});

describe('smoke: testing SDK drives the production durable SDK', () => {
  it('runs a trivial durable handler to completion with step memoization', async () => {
    const handler = withDurableExecution(async (input, ctx) => {
      const a = await ctx.step('one', async () => {
        record('run:one');
        return 1;
      });
      const b = await ctx.step('two', async () => {
        record('run:two');
        return a + 1;
      });
      return { sum: b };
    });

    const runner = new LocalDurableTestRunner({ handlerFunction: handler });
    const execution = await runner.run({ payload: {} });
    expect(execution.getResult()).toEqual({ sum: 2 });
    expect(countOf('run:one')).toBe(1);
    expect(countOf('run:two')).toBe(1);
  });
});

describe('the real parseBoltDag output is the scheduling source', () => {
  it('parses the fenced YAML artifact into units + batches', () => {
    const dag = parseBoltDag(DAG_ARTIFACT);
    expect(dag.ok).toBe(true);
    expect(dag.units.map((u) => u.name)).toEqual(ALL_UNITS);
    expect(dag.batches).toEqual([['auth', 'catalog', 'payments'], ['checkout']]);
  });
});

describe('replay semantics that dictate the wavefront design', () => {
  it('completed parallel branches are NOT re-executed on replay (root cause for the DurablePromise wavefront)', async () => {
    // lane-a completes before the suspend; lane-b suspends on a callback.
    // After resume, lane-a's branch body must not run again — its result
    // comes from checkpointed history. `enters` is recorded in the branch
    // body itself (outside any step), so it counts branch-body executions.
    let enters = 0;
    const handler = withDurableExecution(async (input, ctx) => {
      const wave = await ctx.parallel('waves', [
        {
          name: 'lane-a',
          func: async (laneCtx) => {
            enters += 1;
            return laneCtx.step('stage-a', async () => 'a-done');
          },
        },
        {
          name: 'lane-b',
          func: async (laneCtx) => {
            const [p] = await laneCtx.createCallback('replay-gate');
            return await p;
          },
        },
      ]);
      return wave.getResults();
    });

    const runner = new LocalDurableTestRunner({ handlerFunction: handler });
    const executionPromise = runner.run({ payload: {} });
    const gate = await runner
      .getOperation('replay-gate')
      .waitForData(WaitingOperationStatus.STARTED);
    await gate.sendCallbackSuccess('approved');
    const execution = await executionPromise;

    expect(execution.getResult()).toEqual(expect.arrayContaining(['a-done', 'approved']));
    // The design-critical assertion: completed branch body ran exactly once
    // even though the execution replayed after the callback. In-handler
    // deferred maps therefore never re-resolve on replay — cross-lane
    // coordination must go through DurablePromises instead.
    expect(enters).toBe(1);
  });
});

describe('shape 1 — batch barriers over ctx.map', () => {
  it('runs each DAG batch as one ctx.map wave; wave N+1 starts only after wave N', async () => {
    const dag = parseBoltDag(DAG_ARTIFACT);
    expect(dag.ok).toBe(true);

    const handler = withDurableExecution(async (input, ctx) => {
      const merged = [];
      for (let i = 0; i < dag.batches.length; i++) {
        const batch = dag.batches[i];
        const wave = await ctx.map(
          `wave-${i}`,
          batch,
          async (laneCtx, unit) => {
            const out = await laneCtx.step(`stage-${unit}`, async () => {
              record(`start:${unit}`);
              record(`end:${unit}`);
              return { unit, state: 'MERGED' };
            });
            return out;
          },
          { itemNamer: (unit) => `lane-${unit}` },
        );
        wave.throwIfError();
        merged.push(...wave.getResults());
      }
      return merged.map((r) => r.unit);
    });

    const runner = new LocalDurableTestRunner({ handlerFunction: handler });
    const execution = await runner.run({ payload: {} });

    // All units ran exactly once.
    for (const unit of ALL_UNITS) {
      expect(countOf(`start:${unit}`)).toBe(1);
      expect(countOf(`end:${unit}`)).toBe(1);
    }
    // Barrier property: every wave-1 end precedes the wave-2 start.
    const checkoutStart = log.indexOf('start:checkout');
    for (const unit of ['auth', 'catalog', 'payments']) {
      expect(log.indexOf(`end:${unit}`)).toBeLessThan(checkoutStart);
    }
    expect(execution.getResult()).toEqual(expect.arrayContaining(ALL_UNITS));
  });
});

// Builds the replay-safe wavefront handler used by the remaining tests:
// one ctx.runInChildContext per lane (lazy DurablePromise), registered up
// front, then awaited together. Dependent lanes await their dependency lanes'
// DurablePromises *inside* their own child context — on replay, completed
// lanes resolve from checkpointed history without executing their bodies, and
// pending lanes resume exactly where they suspended.
//
// Lane funcs never throw (failure is a state, not an exception): a failed
// stage becomes { state: 'FAILED' } and dependents turn a non-MERGED
// dependency into { state: 'BLOCKED' } without running any stage.
const buildWavefrontHandler = ({ dag, laneBody }) =>
  withDurableExecution(async (input, ctx) => {
    const lanes = new Map();
    for (const unit of dag.units) {
      lanes.set(
        unit.name,
        ctx.runInChildContext(`lane-${unit.name}`, async (laneCtx) => {
          // Lane blocking: settle every depends_on lane first. Lookup happens
          // at await time, so registration order does not matter.
          const deps = await Promise.all(unit.depends_on.map((d) => lanes.get(d)));
          const badDep = deps.find((d) => d.state !== 'MERGED');
          if (badDep) {
            record(`blocked:${unit.name}`);
            return { unit: unit.name, state: 'BLOCKED', blockedOn: badDep.unit };
          }
          try {
            return await laneBody(laneCtx, unit);
          } catch (err) {
            return { unit: unit.name, state: 'FAILED', error: String(err?.message ?? err) };
          }
        }),
      );
    }
    const settled = await ctx.promise.allSettled('all-lanes', [...lanes.values()]);
    return Object.fromEntries(
      settled.map((s, i) => [
        dag.units[i].name,
        s.status === 'fulfilled'
          ? s.value
          : { unit: dag.units[i].name, state: 'FAILED', error: String(s.reason) },
      ]),
    );
  });

describe('shape 2 — true wavefront over per-lane child contexts', () => {
  it('a dependent lane finishes while a slow independent lane is still running (no barrier)', async () => {
    const dag = parseBoltDag(DAG_ARTIFACT);

    const handler = buildWavefrontHandler({
      dag,
      laneBody: async (laneCtx, unit) =>
        laneCtx.step(
          `stage-${unit.name}`,
          async () => {
            record(`start:${unit.name}`);
            if (unit.name === 'payments') {
              // payments (independent) cannot finish until the test has
              // observed checkout (dependent on auth+catalog) finishing.
              // Under batch barriers this would deadlock; under the wavefront
              // it must pass.
              await waitForLogEntry('end:checkout');
            }
            record(`end:${unit.name}`);
            return { unit: unit.name, state: 'MERGED' };
          },
          NO_RETRY,
        ),
    });

    const runner = new LocalDurableTestRunner({ handlerFunction: handler });
    const execution = await runner.run({ payload: {} });
    const results = execution.getResult();

    for (const unit of ALL_UNITS) {
      expect(results[unit]).toMatchObject({ state: 'MERGED' });
      expect(countOf(`start:${unit}`)).toBe(1);
      expect(countOf(`end:${unit}`)).toBe(1);
    }
    // Wavefront property: checkout ended before payments ended.
    expect(log.indexOf('end:checkout')).toBeLessThan(log.indexOf('end:payments'));
    // Lane blocking property: checkout started after its deps ended.
    const checkoutStart = log.indexOf('start:checkout');
    expect(log.indexOf('end:auth')).toBeLessThan(checkoutStart);
    expect(log.indexOf('end:catalog')).toBeLessThan(checkoutStart);
  });

  it('survives a suspend/replay cycle (human-gate callback inside a lane) with exactly-once steps', async () => {
    const dag = parseBoltDag(DAG_ARTIFACT);

    const handler = buildWavefrontHandler({
      dag,
      laneBody: async (laneCtx, unit) => {
        const result = await laneCtx.step(
          `stage-${unit.name}`,
          async () => {
            record(`start:${unit.name}`);
            record(`end:${unit.name}`);
            return { unit: unit.name, state: 'MERGED' };
          },
          NO_RETRY,
        );
        if (unit.name === 'checkout') {
          // Bolt-level human gate: park the lane on a durable callback. The
          // whole execution suspends (other lanes already checkpointed) and
          // replays when the callback completes.
          const [gatePromise] = await laneCtx.createCallback('gate-checkout');
          const answer = await gatePromise;
          record(`gate-answered:${unit.name}:${answer}`);
        }
        return result;
      },
    });

    const runner = new LocalDurableTestRunner({ handlerFunction: handler });
    const executionPromise = runner.run({ payload: {} });

    // Complete the gate from "outside" (the human), mid-flight.
    const gate = await runner
      .getOperation('gate-checkout')
      .waitForData(WaitingOperationStatus.STARTED);
    await gate.sendCallbackSuccess('approved');

    const execution = await executionPromise;
    const results = execution.getResult();

    for (const unit of ALL_UNITS) {
      expect(results[unit]).toMatchObject({ state: 'MERGED' });
      // Exactly-once across the suspend/replay boundary — the property that
      // makes the DurablePromise wavefront replay-safe.
      expect(countOf(`start:${unit}`)).toBe(1);
      expect(countOf(`end:${unit}`)).toBe(1);
    }
    expect(countOf('gate-answered:checkout:approved')).toBe(1);
  });

  it('lane failure → dependents BLOCKED without running, independents still finish', async () => {
    const dag = parseBoltDag(DAG_ARTIFACT);

    const handler = buildWavefrontHandler({
      dag,
      laneBody: async (laneCtx, unit) =>
        laneCtx.step(
          `stage-${unit.name}`,
          async () => {
            record(`start:${unit.name}`);
            if (unit.name === 'auth') {
              record(`fail:${unit.name}`);
              throw new Error('sensor gate failed');
            }
            record(`end:${unit.name}`);
            return { unit: unit.name, state: 'MERGED' };
          },
          NO_RETRY,
        ),
    });

    const runner = new LocalDurableTestRunner({ handlerFunction: handler });
    const execution = await runner.run({ payload: {} });
    const results = execution.getResult();

    expect(results.auth.state).toBe('FAILED');
    expect(results.checkout).toMatchObject({ state: 'BLOCKED', blockedOn: 'auth' });
    expect(results.catalog.state).toBe('MERGED');
    expect(results.payments.state).toBe('MERGED');
    // The blocked lane's stage never ran.
    expect(countOf('start:checkout')).toBe(0);
    // Independent lanes were not disturbed by the failure.
    expect(countOf('end:catalog')).toBe(1);
    expect(countOf('end:payments')).toBe(1);
  });
});
