import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { withDurableExecution, StepSemantics } from '@aws/durable-execution-sdk-js';
import {
  LocalDurableTestRunner,
  WaitingOperationStatus,
} from '@aws/durable-execution-sdk-js-testing';

// ---------------------------------------------------------------------------
// WP0 PoC (c) — docs/v2-parallel.md Part C.
//
// Documents WHY the synchronous run-stage step must be replaced (WP1) before
// any parallelization: a durable step's body is not exactly-once. The
// orchestrator Lambda times out at 900s and AgentCore's synchronous
// request timeout is a hard 15 minutes, while a stage regularly exceeds both;
// an interrupted step is re-executed on re-drive
// (RETRY_INTERRUPTED_STEP), i.e. the whole agent stage would run twice.
//
// What is provable on the local runner (in-process, so a genuinely "killed"
// invocation cannot be simulated — itself evidence: the runner must keep the
// invocation hot for the entire step duration, exactly like the production
// Lambda would):
//
//   1. At-least-once semantics (default): a step body that fails after doing
//      real work is re-executed from scratch by the retry strategy — the side
//      effect (the agent stage) runs twice. This is the same re-execution
//      path RETRY_INTERRUPTED_STEP takes after an invocation death.
//   2. AtMostOncePerRetry semantics is not a rescue: it converts the
//      interruption into a StepInterruptedError for the *attempt*, so without
//      retries the stage FAILS, and with retries it re-executes — either way
//      a >15-min synchronous stage cannot be made safe as a step body.
//   3. The suspended-execution alternative costs nothing while parked: a
//      createCallback suspends the invocation immediately (measured wall time
//      of the invocation loop), which is the WP1 shape — start the stage,
//      suspend, let the container call back (PoC d proves the full lifecycle).
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await LocalDurableTestRunner.setupTestEnvironment();
});

afterAll(async () => {
  await LocalDurableTestRunner.teardownTestEnvironment();
});

describe('WP0c — why the synchronous run-stage step must go', () => {
  it('default step semantics re-execute the whole body on retry: the agent stage runs twice', async () => {
    // Models today's runStage: one step whose body is the entire synchronous
    // AgentCore round-trip. The first execution "dies" mid-flight (here: an
    // error standing in for the invocation being cut off); the durable engine
    // re-runs the WHOLE body.
    const stageRuns = [];
    let attempt = 0;
    const handler = withDurableExecution(async (input, ctx) => {
      const result = await ctx.step(
        'run-stage-sync',
        async () => {
          attempt += 1;
          stageRuns.push(`agent-stage-started-attempt-${attempt}`);
          if (attempt === 1) {
            // The invocation dies at minute 15; from the engine's point of
            // view the attempt failed and must be retried from scratch.
            throw new Error('invocation timed out mid-stage');
          }
          stageRuns.push(`agent-stage-completed-attempt-${attempt}`);
          return 'SUCCEEDED';
        },
        { retryStrategy: (_err, n) => ({ shouldRetry: n < 2, delay: { seconds: 0 } }) },
      );
      return { result };
    });

    const runner = new LocalDurableTestRunner({ handlerFunction: handler });
    const execution = await runner.run({ payload: {} });
    expect(execution.getResult()).toEqual({ result: 'SUCCEEDED' });

    // The damning property: the agent stage STARTED twice. In production that
    // is a second full CLI run against the same workspace — duplicated agent
    // work, duplicated cost, and non-deterministic workspace state.
    expect(stageRuns).toEqual([
      'agent-stage-started-attempt-1',
      'agent-stage-started-attempt-2',
      'agent-stage-completed-attempt-2',
    ]);
  });

  it('AtMostOncePerRetry without retries turns an interruption into a failed stage — not a rescue either', async () => {
    // The only way to guarantee a step body runs at most once is to disable
    // retries; then any interruption permanently fails the stage. For a
    // 30-minute code-generation stage neither "run twice" nor "fail on
    // interruption" is acceptable → the stage must not live in a step body.
    let attempts = 0;
    const handler = withDurableExecution(async (input, ctx) => {
      const result = await ctx.step(
        'run-stage-at-most-once',
        async () => {
          attempts += 1;
          throw new Error('invocation timed out mid-stage');
        },
        {
          semantics: StepSemantics.AtMostOncePerRetry,
          retryStrategy: () => ({ shouldRetry: false }),
        },
      );
      return { result };
    });

    const runner = new LocalDurableTestRunner({ handlerFunction: handler });
    const execution = await runner.run({ payload: {} });
    let failure;
    try {
      execution.getResult();
    } catch (err) {
      failure = err;
    }
    expect(attempts).toBe(1);
    expect(failure).toBeTruthy();
  });

  it('the WP1 alternative: a short start-step + callback suspends at zero compute until the container calls back', async () => {
    // The fix shape (proved end-to-end in PoC d): run-stage-start returns
    // fast, the execution suspends on a durable callback, and the container
    // completes it when the background job finishes. Here we prove the
    // suspension property: after the start step, NO handler invocation is
    // running while the "stage" (the test) holds the callback — the
    // orchestrator consumes no compute for the whole stage duration.
    const invocationWindows = [];
    const handler = withDurableExecution(async (input, ctx) => {
      const invocationStart = Date.now();
      const [stageDone, callbackId] = await ctx.createCallback('stage-callback');
      await ctx.step('run-stage-start', async () => {
        // Production: InvokeAgentRuntime { command: 'run-stage-start',
        // callbackId } — returns in milliseconds.
        return { dispatched: true, callbackId };
      });
      const stageResult = await stageDone;
      invocationWindows.push(Date.now() - invocationStart);
      return { stageResult };
    });

    const runner = new LocalDurableTestRunner({ handlerFunction: handler });
    const executionPromise = runner.run({ payload: {} });

    const gate = await runner
      .getOperation('stage-callback')
      .waitForData(WaitingOperationStatus.STARTED);
    // The "stage" takes a while; the orchestrator is suspended meanwhile.
    await new Promise((r) => setTimeout(r, 300));
    await gate.sendCallbackSuccess('SUCCEEDED');

    const execution = await executionPromise;
    expect(execution.getResult()).toEqual({ stageResult: 'SUCCEEDED' });

    // More than one handler invocation happened (suspend → resume), i.e. the
    // execution did NOT sit inside a single hot invocation for the stage
    // duration. The resumed invocation replays fast — its wall time bears no
    // relation to the 300ms the stage took.
    expect(execution.getInvocations().length).toBeGreaterThanOrEqual(2);
    const resumedInvocationTime = invocationWindows[invocationWindows.length - 1];
    expect(resumedInvocationTime).toBeLessThan(300);
  });
});
