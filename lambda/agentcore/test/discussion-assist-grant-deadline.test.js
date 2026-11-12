// Discussion assists for one thread share a runtime session and its OpenCode
// store lock, so they run one after another while each holds its own
// short-lived discussion grant. Every accepted assist must still reach a
// terminal message, written while its grant is valid: an assist that cannot
// start its inference in time gives up and records the failure instead.
//
// Production pieces end to end: the dispatcher, the detached assist command,
// the real one-shot runner and store lock, the remote graph facade and the
// engine-data graph gateway with the real signed-grant verifier, all on one
// injected clock.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import {
  DISCUSSION_GRANT_TTL_SECONDS,
  issueGatewayGrant,
  verifyGatewayGrant,
} from '../../shared/gateway-grant.js';
import { createGraphGateway } from '../../engine-data/graph-gateway.js';
import { createRemoteGraphAccess } from '../engine-data-client.js';
import { currentGatewayGrant } from '../mcp/gateway-context.js';
import { dispatchInvocation } from '../http-server.js';
import { createDiscussionAssistStart } from '../commands/discussion-assist-start.js';
import { runOneShotPrompt } from '../cli/one-shot.js';
import { __test as storeLocks, withOpenCodeStore } from '../cli/opencode-store.js';

const T0 = Date.parse('2026-11-11T09:00:00.000Z');
const KID = 'kid-discussion';
const P = 'p-1';
const I = 'i-1';
const D = 'd-1';
const INFERENCE_MS = 110_000;
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });

const discussionGrant = () =>
  issueGatewayGrant(
    { mode: 'discussion', projectId: P, intentId: I, executionId: I },
    {
      keyId: KID,
      sign: async (m) => cryptoSign('sha256', m, privateKey),
      ttlSeconds: DISCUSSION_GRANT_TTL_SECONDS,
    },
  );

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const slowOpenCode = (inferenceMs = INFERENCE_MS) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { end: () => {} };
  setTimeout(() => {
    child.stdout.emit(
      'data',
      Buffer.from(`${JSON.stringify({ type: 'text', part: { type: 'text', text: 'answer' } })}\n`),
    );
    child.emit('close', 0);
  }, inferenceMs);
  return child;
};

const harness = ({
  inferenceMs = INFERENCE_MS,
  restoreMs = 0,
  persistMs = 0,
  restore = () => sleep(restoreMs),
  engineData = true,
} = {}) => {
  const audit = [];
  const writes = [];
  const fakeG = {
    V: () => ({
      has: () => ({
        values: () => ({ toList: async () => [P] }),
        hasNext: async () => true,
      }),
    }),
  };
  const gateway = createGraphGateway({
    verifyGrant: (token) =>
      verifyGatewayGrant(token, { publicKeyFor: async (kid) => (kid === KID ? publicKey : null) }),
    createStore: () => ({ getExecution: async () => ({ projectId: P, intentId: I }) }),
    withGraph: (fn) => fn(fakeG),
    createOps: () => ops,
    audit: (entry) => audit.push(entry),
  });
  const ops = {
    readProjectCliConfig: async () => ({
      agentCli: 'opencode',
      cliModels: null,
      tierModels: null,
    }),
    readDiscussionContext: async () => ({
      discussion: { entity_type: 'artifact', entity_id: 'a-1', status: 'open' },
      selected: [],
      recent: [],
      anchor: null,
      intentMap: {},
    }),
    completeDiscussionAssist: async (input) => {
      writes.push({ ...input, at: Date.now() - T0 });
      return { id: input.messageId, assistStatus: input.status, content: input.content };
    },
  };
  const spawned = [];
  const start = createDiscussionAssistStart({
    // Engine data off: the runtime's own graph, which needs no grant.
    openEngineGraph: engineData
      ? createRemoteGraphAccess({
          invoke: async (event) => gateway(JSON.parse(JSON.stringify(event))),
          grant: currentGatewayGrant,
        })
      : async () => ({ ...ops, close: async () => {} }),
    engineData,
    store: null,
    availableClis: ['opencode'],
    materializeCliContextFn: async () => ({}),
    oneShot: (args) =>
      runOneShotPrompt({
        ...args,
        spawnFn: () => {
          spawned.push(Date.now() - T0);
          return slowOpenCode(inferenceMs);
        },
        makeDirectory: async () => {},
        withOpenCodeStore: (options) =>
          withOpenCodeStore({
            ...options,
            restore,
            persist: () => sleep(persistMs),
          }),
      }),
    // No durable store configured: the lock still serializes the thread's
    // assists, without filesystem work outside the fake clock.
    env: {},
    log: () => {},
  });
  return { audit, writes, spawned, start, handlers: { discussionAssistStart: start } };
};

const requestAssist = async (handlers, n) =>
  dispatchInvocation({
    payload: {
      command: 'discussion-assist-start',
      projectId: P,
      intentId: I,
      discussionId: D,
      messageId: `dm-${n}`,
      requestId: `assist-${n}`,
      assistCommand: 'summarize',
      gatewayGrant: await discussionGrant(),
    },
    handlers,
  });

const GRANT_MS = DISCUSSION_GRANT_TTL_SECONDS * 1000;

describe('queued discussion assists under short-lived grants', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: T0, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('brings every accepted assist to a terminal message before its grant expires', async () => {
    const { audit, writes, handlers } = harness();
    const requests = [1, 2, 3, 4].map((n) => ({
      messageId: `dm-${n}`,
      requestId: `assist-${n}`,
    }));
    for (const { messageId, requestId } of requests) {
      const out = await dispatchInvocation({
        payload: {
          command: 'discussion-assist-start',
          projectId: P,
          intentId: I,
          discussionId: D,
          messageId,
          requestId,
          assistCommand: 'summarize',
          gatewayGrant: await discussionGrant(),
        },
        handlers,
      });
      expect(out).toMatchObject({ statusCode: 200, body: { ok: true, accepted: true } });
    }

    await vi.advanceTimersByTimeAsync(5 * INFERENCE_MS);

    expect(audit.filter((entry) => entry.decision === 'deny')).toEqual([]);
    const terminal = Object.fromEntries(writes.map((w) => [w.messageId, w]));
    expect(Object.keys(terminal).toSorted()).toEqual(['dm-1', 'dm-2', 'dm-3', 'dm-4']);
    for (const write of writes) {
      expect(write.at).toBeLessThan(DISCUSSION_GRANT_TTL_SECONDS * 1000);
    }
    // The first two fit in their grants; the rest could not start in time and
    // say so instead of staying pending.
    expect(terminal['dm-1']).toMatchObject({ status: 'completed', content: 'answer' });
    expect(terminal['dm-2']).toMatchObject({ status: 'completed', content: 'answer' });
    for (const id of ['dm-3', 'dm-4']) {
      expect(terminal[id].status).toBe('failed');
      expect(terminal[id].content).toMatch(/busy/i);
    }
  });

  it('re-checks the start deadline after a slow restore instead of running past the grant', async () => {
    const { audit, writes, spawned, handlers } = harness({
      inferenceMs: 119_000,
      restoreMs: 33_000,
    });
    // Another turn on the same store holds it until just before this assist's
    // start deadline (exp 300 s - 30 s margin - 120 s timeout = 150 s).
    const holder = withOpenCodeStore({
      env: {},
      restore: async () => {},
      persist: async () => {},
      operation: () => sleep(149_000),
    });
    expect(await requestAssist(handlers, 1)).toMatchObject({ statusCode: 200 });

    await vi.advanceTimersByTimeAsync(GRANT_MS + 60_000);
    await holder;

    expect(audit.filter((entry) => entry.decision === 'deny')).toEqual([]);
    expect(spawned).toEqual([]);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ messageId: 'dm-1', status: 'failed' });
    expect(writes[0].content).toMatch(/busy/i);
    expect(writes[0].at).toBeLessThan(GRANT_MS);
  });

  it('answers before the grant expires while a slow restore keeps the store', async () => {
    let restoreSettled = false;
    const { audit, writes, spawned, start, handlers } = harness({
      // Acquired at 149 s, the restore runs past exp (300 s) and then fails.
      restore: () =>
        sleep(152_000).then(() => {
          restoreSettled = true;
          throw new Error('restore failed');
        }),
    });
    const holder = withOpenCodeStore({
      env: {},
      restore: async () => {},
      persist: async () => {},
      operation: () => sleep(149_000),
    });
    expect(await requestAssist(handlers, 1)).toMatchObject({ statusCode: 200 });

    await vi.advanceTimersByTimeAsync(GRANT_MS - 1_000);
    await holder;
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ messageId: 'dm-1', status: 'failed' });
    expect(writes[0].content).toMatch(/busy/i);
    expect(writes[0].at).toBeLessThan(GRANT_MS);
    // The restore is still running: the store stays locked and the job active.
    expect(restoreSettled).toBe(false);
    expect(storeLocks.locks.has('__unconfigured__')).toBe(true);
    expect(start.activeJobs.size).toBe(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(restoreSettled).toBe(true);
    expect(storeLocks.locks.has('__unconfigured__')).toBe(false);
    expect(start.activeJobs.size).toBe(0);
    expect(spawned).toEqual([]);
    expect(writes).toHaveLength(1);
    expect(audit.filter((entry) => entry.decision === 'deny')).toEqual([]);
  });

  it('writes the answer before the grant expires while a slow persist keeps the store', async () => {
    const { audit, writes, start, handlers } = harness({ persistMs: 200_000 });
    expect(await requestAssist(handlers, 1)).toMatchObject({ statusCode: 200 });

    await vi.advanceTimersByTimeAsync(GRANT_MS - 1_000);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ messageId: 'dm-1', status: 'completed', content: 'answer' });
    expect(writes[0].at).toBeLessThan(GRANT_MS);
    // The persist is still running: the store stays locked and the job stays
    // active, so neither the next waiter nor a runtime reap overlaps it.
    expect(storeLocks.locks.has('__unconfigured__')).toBe(true);
    expect(start.activeJobs.size).toBe(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(storeLocks.locks.has('__unconfigured__')).toBe(false);
    expect(start.activeJobs.size).toBe(0);
    expect(audit.filter((entry) => entry.decision === 'deny')).toEqual([]);
  });
});

describe('queued discussion assists with engine data off', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: T0, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs the CLI once the store frees up, even past the grant start deadline', async () => {
    const { writes, spawned, handlers } = harness({ engineData: false });
    // The store is held past the 150 s start deadline the grant would impose.
    const holder = withOpenCodeStore({
      env: {},
      restore: async () => {},
      persist: async () => {},
      operation: () => sleep(151_000),
    });
    expect(await requestAssist(handlers, 1)).toMatchObject({ statusCode: 200 });

    await vi.advanceTimersByTimeAsync(GRANT_MS + 60_000);
    await holder;

    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toBeGreaterThanOrEqual(151_000);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ messageId: 'dm-1', status: 'completed', content: 'answer' });
  });
});
