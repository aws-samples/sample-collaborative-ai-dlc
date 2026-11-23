// The conversation language (#784) is pinned on META while the intent is a
// DRAFT. The orchestrator forwards it from its consistent `load-meta` read on
// every stage dispatch, like the model settings, so the container never has
// to re-read META for it and a failed read can never drop it silently.

import { describe, it, expect, vi } from 'vitest';
import { __durableHandler } from '../index.js';

const KOREAN = Object.freeze({ tag: 'ko', englishName: 'Korean', nativeName: '한국어' });

const META = {
  executionId: 'i1',
  intentId: 'i1',
  projectId: 'p1',
  status: 'CREATED',
  workflowId: 'aidlc-v2',
  workflowVersion: 1,
  scope: 'classic',
  startedAt: 'T',
  startedBy: 'u1',
  repos: ['owner/repo'],
  branch: 'aidlc/i1',
  baseBranch: 'main',
  gitProvider: 'github',
  agentCli: 'kiro',
  parkReleaseSeconds: null,
  conversationLanguage: KOREAN,
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
        const id = `cb-${name}`;
        stageCallbacks.set(id, resolve);
        return [promise, id];
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

const depsFor = (ctx, meta, invokes) => ({
  store: {
    getExecution: vi.fn(async () => meta),
    updateExecution: vi.fn(async () => ({})),
    createHumanTask: vi.fn(async (task) => ({ ...task, status: 'pending' })),
    setGateCallbackId: vi.fn(async () => ({})),
    supersedeHumanTask: vi.fn(async () => ({})),
    getHumanTask: vi.fn(async () => ({ status: 'answered' })),
    appendEvent: vi.fn(async () => ({})),
    putTrackerSync: vi.fn(async (sync) => sync),
    failRunningStageAttempt: vi.fn(async () => null),
    listUnits: vi.fn(async () => []),
    getUnit: vi.fn(async () => null),
  },
  loadPlan: vi.fn(async () => ({ valid: true, plan: { stages: [{ stageId: 'a' }] } })),
  invokeRuntime: vi.fn(async (payload) => {
    invokes.push(payload);
    if (payload.command === 'create-workflow-checkpoint') {
      return { ok: true, checkpointId: 'cp' };
    }
    if (payload.command === 'run-stage-start') {
      ctx.stageCallbackResolvers.get(payload.stageCallbackId)?.({ ok: true, state: 'SUCCEEDED' });
      return { ok: true, accepted: true, stageId: payload.stageId };
    }
    return { ok: true };
  }),
  issueAgentCredentialGrant: vi.fn(async () => 'grant'),
  stopSession: vi.fn(async () => ({ stopped: true })),
  broadcast: vi.fn(async () => {}),
  openPr: vi.fn(async () => ({ skipped: true, reason: 'no_changes' })),
  comparePrBranches: vi.fn(async () => ({ status: 'unknown' })),
  applicationUrl: 'https://example.test/',
});

const runStart = async (meta) => {
  const ctx = makeCtx();
  const invokes = [];
  const deps = depsFor(ctx, meta, invokes);
  await __durableHandler({ action: 'start', intentId: 'i1', executionId: 'i1' }, ctx, deps);
  return { deps, invokes };
};

describe('the pinned conversation language reaches every stage dispatch', () => {
  it('forwards it from the consistent META read', async () => {
    const { deps, invokes } = await runStart(META);

    expect(deps.store.getExecution).toHaveBeenCalledWith('i1', { consistentRead: true });
    const dispatches = invokes.filter((payload) => payload.command === 'run-stage-start');
    expect(dispatches.length).toBeGreaterThan(0);
    for (const payload of dispatches) {
      expect(payload.conversationLanguage).toEqual(KOREAN);
    }
  });

  it('adds no key for an intent without a language', async () => {
    const { invokes } = await runStart({ ...META, conversationLanguage: undefined });

    for (const payload of invokes.filter((item) => item.command === 'run-stage-start')) {
      expect(payload).not.toHaveProperty('conversationLanguage');
    }
  });
});
