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
    invokeRuntime: async (payload) =>
      payload.command === 'init-ws' ? { ok: true } : { ok: true, accepted: true },
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
  let suspended;
  const nextSuspension = () =>
    new Promise((resolve) => {
      suspended = resolve;
    });
  let suspension = nextSuspension();
  const handler = withDurableExecution((event, ctx) => __durableHandler(event, ctx, world.deps));
  const runner = new LocalDurableTestRunner({
    handlerFunction: async (...input) => {
      const result = await handler(...input);
      if (result.Status === 'PENDING') suspended();
      return result;
    },
  });
  const completion = runner.run({
    payload: { action: 'start', intentId: 'i1', executionId: 'i1' },
  });
  await suspension;
  suspension = nextSuspension();
  world.pendingHumanTaskId = 'h1';
  await completeCallback(runner, 'stage-cb-a', {
    ok: true,
    state: 'WAITING_FOR_HUMAN',
    humanTaskId: 'h1',
  });
  await suspension;
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
