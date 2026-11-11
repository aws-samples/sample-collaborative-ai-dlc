// Agent gates publish gate.pending from inside the existing
// gate-answered-early step, on the real durable runner.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { withDurableExecution } from '@aws/durable-execution-sdk-js';
import {
  LocalDurableTestRunner,
  WaitingOperationStatus,
} from '@aws/durable-execution-sdk-js-testing';
import { __durableHandler } from './fixtures/completion-handler.js';

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

const published = () =>
  send.mock.calls.map(([command]) => {
    const [entry] = command.input.Entries;
    return [entry.DetailType, JSON.parse(entry.Detail)];
  });

beforeAll(async () => {
  await LocalDurableTestRunner.setupTestEnvironment();
});

afterAll(async () => {
  await LocalDurableTestRunner.teardownTestEnvironment();
});

const META = {
  executionId: 'i1',
  intentId: 'i1',
  projectId: 'p1',
  title: 'Customer portal',
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
  parkReleaseSeconds: null,
};

// One stage that parks on agent question h1.
const makeWorld = () => {
  const world = { pendingHumanTaskId: null, gateStatus: 'pending' };
  world.deps = {
    store: {
      getExecution: async () => ({
        ...META,
        pendingHumanTaskId: world.pendingHumanTaskId,
      }),
      updateExecution: async (input) => ({
        orchestratorRunId: input.orchestratorRunId ?? null,
      }),
      listUnits: async () => [],
      setGateCallbackId: async () => ({}),
      getHumanTask: async () => ({
        status: world.gateStatus,
        kind: 'question',
        questions: JSON.stringify([{ text: 'Which database?' }]),
      }),
      appendEvent: async () => ({}),
      failRunningStageAttempt: async () => null,
    },
    loadPlan: async () => ({
      valid: true,
      plan: { stages: [{ stageId: 'a' }] },
    }),
    invokeRuntime: async (payload) => {
      if (payload.command !== 'init-ws-start') return { ok: true, accepted: true };
      // Capability probe (no callbackId), then the accepted init job, which
      // completes the init callback out-of-band.
      if (!payload.callbackId) return { ok: false, reason: 'missing_callback_id' };
      (async () => {
        const op = await world.runner
          .getOperation('init-ws-cb')
          .waitForData(WaitingOperationStatus.STARTED);
        await op.sendCallbackSuccess(JSON.stringify({ ok: true }));
      })();
      return { ok: true, accepted: true, callbackId: payload.callbackId };
    },
    resolveToken: async () => 'tok',
    stopSession: async () => ({ stopped: true }),
    broadcast: async () => {},
    applicationUrl: 'https://aidlc.example.test/',
  };
  return world;
};

const completeCallback = async (runner, name, body) => {
  const op = await runner.getOperation(name).waitForData(WaitingOperationStatus.STARTED);
  await op.sendCallbackSuccess(JSON.stringify(body));
};

// Run the stage to its gate, then answer it. `atGate` runs once the run has
// suspended on the gate callback, before the answer.
const runThroughGate = async ({ atGate = () => {} } = {}) => {
  const world = makeWorld();
  // Invocations in flight. The workspace-init callback adds a suspension whose
  // timing is not fixed, so "suspended on the gate" is read from the gate
  // callback itself rather than from a count of suspensions.
  let invocations = 0;
  const handler = withDurableExecution((event, ctx) => __durableHandler(event, ctx, world.deps));
  const runner = new LocalDurableTestRunner({
    handlerFunction: async (...input) => {
      invocations += 1;
      try {
        return await handler(...input);
      } finally {
        invocations -= 1;
      }
    },
  });
  world.runner = runner;
  const completion = runner.run({
    payload: { action: 'start', intentId: 'i1', executionId: 'i1' },
  });
  world.pendingHumanTaskId = 'h1';
  await completeCallback(runner, 'stage-cb-a', {
    ok: true,
    state: 'WAITING_FOR_HUMAN',
    humanTaskId: 'h1',
  });
  // The gate callback is open and the invocation that opened it has returned.
  await runner.getOperation('await-h1').waitForData(WaitingOperationStatus.STARTED);
  await vi.waitFor(() => expect(invocations).toBe(0));
  atGate();
  world.gateStatus = 'answered';
  await completeCallback(runner, 'await-h1', { answer: 'Postgres' });
  await completeCallback(runner, 'stage-cb-a-resume-h1', {
    ok: true,
    state: 'SUCCEEDED',
  });
  const execution = await completion;
  expect(execution.getResult()).toMatchObject({ ok: true });
  return execution.getOperations().map((op) => op.getOperationData()?.Name);
};

describe('agent gate notification event', () => {
  beforeEach(() => send.mockClear());
  afterEach(() => vi.unstubAllEnvs());

  it('publishes gate.pending once, without adding a durable operation', async () => {
    vi.stubEnv('NOTIFICATION_EVENT_BUS', '');
    const withoutBus = await runThroughGate();
    expect(send).not.toHaveBeenCalled();

    vi.stubEnv('NOTIFICATION_EVENT_BUS', 'bus-1');
    const withBus = await runThroughGate();
    expect(withBus).toEqual(withoutBus);
    expect(published()).toEqual([
      [
        'gate.pending',
        {
          schemaVersion: 1,
          eventId: 'h1',
          projectId: 'p1',
          intentId: 'i1',
          executionId: 'i1',
          humanTaskId: 'h1',
          need: 'answer',
          kind: 'question',
          stage: 'a',
          intentTitle: 'Customer portal',
          startedBy: 'u1',
          prompt: 'Which database?',
        },
      ],
    ]);
  });

  it('resumes a history parked without a bus after the bus is enabled, publishing nothing', async () => {
    vi.stubEnv('NOTIFICATION_EVENT_BUS', '');
    const baseline = await runThroughGate();

    vi.stubEnv('NOTIFICATION_EVENT_BUS', '');
    const upgraded = await runThroughGate({
      atGate: () => vi.stubEnv('NOTIFICATION_EVENT_BUS', 'bus-1'),
    });
    expect(upgraded).toEqual(baseline);
    // The gate was already waiting, and is answered by the time the run replays.
    expect(send).not.toHaveBeenCalled();
  });
});
