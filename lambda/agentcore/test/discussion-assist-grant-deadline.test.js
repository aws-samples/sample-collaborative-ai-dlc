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

const slowOpenCode = () => {
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
  }, INFERENCE_MS);
  return child;
};

const harness = () => {
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
    createOps: () => ({
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
    }),
    audit: (entry) => audit.push(entry),
  });
  const start = createDiscussionAssistStart({
    openEngineGraph: createRemoteGraphAccess({
      invoke: async (event) => gateway(JSON.parse(JSON.stringify(event))),
      grant: currentGatewayGrant,
    }),
    store: null,
    availableClis: ['opencode'],
    materializeCliContextFn: async () => ({}),
    oneShot: (args) =>
      runOneShotPrompt({ ...args, spawnFn: slowOpenCode, makeDirectory: async () => {} }),
    // No durable store configured: the lock still serializes the thread's
    // assists, without filesystem work outside the fake clock.
    env: {},
    log: () => {},
  });
  return { audit, writes, handlers: { discussionAssistStart: start } };
};

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
});
