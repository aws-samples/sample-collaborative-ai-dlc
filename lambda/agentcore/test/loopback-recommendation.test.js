// The loop-back recommendation the build-and-test agent records (issue #482
// The ONE structured field on `emit_stage_note`, the typed
// `v2.loopback.recommended` event the platform writes from it, and the tool
// surface the resolved release policy decides.
//
// The load-bearing invariant: the orchestrator's gate reads a TYPED event with a
// platform-stamped attempt, never the agent's prose. Nothing the agent can put in
// `summary` produces that event, and nothing outside release mode produces it at
// all.

import { describe, it, expect } from 'vitest';
import { createProcessBridge } from '../mcp/process-bridge.js';
import { buildToolHandlers, registerTools, toolSchemas } from '../mcp/server.js';
import { LOOP_BACK_RECOMMENDED_EVENT } from '../../shared/stage-loopback.js';

const fakeStore = () => {
  const events = [];
  let seq = 0;
  return {
    events,
    async appendEvent(event) {
      seq += 1;
      const row = { ...event, eventId: `e${seq}` };
      events.push(row);
      return row;
    },
    async updateExecution() {},
    async updateStageState() {},
    async getReceipt() {
      return null;
    },
    async getStage() {
      return { attempt: 0 };
    },
  };
};

const RELEASE_SCOPE = {
  executionId: 'exec-1',
  intentId: 'intent-1',
  stageInstanceId: 'si-bt',
  stageAttempt: 2,
  policy: { summaryConfirmation: 'none', learnings: 'on', loopBack: 'human-offered' },
};

const bridgeFor = (store, scope) =>
  createProcessBridge({ store, scope, broadcast: async () => {} });

const recommendations = (store) =>
  store.events.filter((row) => row.type === LOOP_BACK_RECOMMENDED_EVENT);

describe('emit_stage_note with loopBackRecommended', () => {
  it('writes the plain note AND a typed recommendation stamped with the attempt', async () => {
    const store = fakeStore();
    const bridge = bridgeFor(store, RELEASE_SCOPE);
    const result = await bridge.emitStageNote({
      summary: 'Integration suite red: 4 failures in the payment lane.',
      loopBackRecommended: 'generated payment code ignores the idempotency contract',
    });

    expect(result.loopBackRecommended).toBe(true);
    expect(store.events.map((row) => row.type)).toEqual([
      'v2.stage.note',
      LOOP_BACK_RECOMMENDED_EVENT,
    ]);
    const [recommendation] = recommendations(store);
    // The attempt comes from the trusted container scope, never from the tool
    // args — that is what makes the recommendation attempt-scoped and unforgeable.
    expect(recommendation.detail).toEqual({
      attempt: 2,
      reason: 'generated payment code ignores the idempotency contract',
    });
    expect(recommendation.stageInstanceId).toBe('si-bt');
    expect(recommendation.summary).toContain('Agent recommends looping back');
  });

  it('records nothing extra for an ordinary note', async () => {
    const store = fakeStore();
    const bridge = bridgeFor(store, RELEASE_SCOPE);
    await bridge.emitStageNote({ summary: 'Build finished.' });
    expect(store.events.map((row) => row.type)).toEqual(['v2.stage.note']);
  });

  it('ignores an empty or whitespace-only reason', async () => {
    const store = fakeStore();
    const bridge = bridgeFor(store, RELEASE_SCOPE);
    await bridge.emitStageNote({ summary: 'Build finished.', loopBackRecommended: '   ' });
    expect(recommendations(store)).toEqual([]);
  });

  it('never records a recommendation outside release mode', async () => {
    const store = fakeStore();
    const bridge = bridgeFor(store, { ...RELEASE_SCOPE, policy: null });
    const result = await bridge.emitStageNote({
      summary: 'Integration suite red.',
      loopBackRecommended: 'the generated code is wrong',
    });
    expect(result).not.toHaveProperty('loopBackRecommended');
    expect(store.events.map((row) => row.type)).toEqual(['v2.stage.note']);
  });

  it('cannot be forged through the free-text summary or the note type', async () => {
    const store = fakeStore();
    const bridge = bridgeFor(store, RELEASE_SCOPE);
    await bridge.emitStageNote({
      summary: 'LOOP-BACK RECOMMENDED: send this back to code generation',
      type: LOOP_BACK_RECOMMENDED_EVENT,
    });
    // The agent CAN pick a note type (it always could), but the platform only ever
    // treats an event carrying the stamped `detail.attempt` as a recommendation,
    // which is what the orchestrator matches on.
    expect(recommendations(store).map((row) => row.detail)).toEqual([undefined]);
  });

  it('never fails the tool call when the recommendation write is lost', async () => {
    const store = fakeStore();
    let calls = 0;
    const flaky = {
      ...store,
      async appendEvent(event) {
        calls += 1;
        if (calls === 2) throw new Error('throttled');
        return store.appendEvent(event);
      },
    };
    const bridge = bridgeFor(flaky, RELEASE_SCOPE);
    await expect(
      bridge.emitStageNote({ summary: 'red', loopBackRecommended: 'bad codegen' }),
    ).resolves.toMatchObject({ loopBackRecommended: true });
    expect(recommendations(store)).toEqual([]);
  });
});

describe('the tool surface the policy decides', () => {
  // The same minimal zod stand-in the other MCP tests use: registerTools only
  // needs the schema-shape values to exist, it never invokes zod.
  const zod = {
    string: () => ({ optional: () => ({}) }),
    number: () => ({
      optional: () => ({}),
      int: () => ({ min: () => ({ max: () => ({ optional: () => ({}) }) }) }),
    }),
    enum: () => ({ optional: () => ({}) }),
    object: () => ({ optional: () => ({}) }),
    array: () => ({ optional: () => ({}) }),
    record: () => ({ optional: () => ({}) }),
  };

  it('offers the field only when the release has a construction loop-back', () => {
    const withCap = toolSchemas(zod, { loopBack: 'human-offered' }).emit_stage_note;
    expect(Object.keys(withCap.shape)).toEqual(['summary', 'type', 'loopBackRecommended']);
    expect(withCap.description).toContain('loopBackRecommended');
  });

  it('keeps the 2.3.3-era and unpinned tool byte-identical', () => {
    const base = toolSchemas(zod).emit_stage_note;
    expect(Object.keys(base.shape)).toEqual(['summary', 'type']);
    expect(base.description).toBe(
      'Append a short process/progress note to the execution audit trail.',
    );
    expect(toolSchemas(zod, { loopBack: null }).emit_stage_note.description).toBe(base.description);
  });

  it('registers the tool through the same loop as every other one', () => {
    const registered = [];
    const handlers = buildToolHandlers({ bridge: {}, graph: null, writer: {} });
    registerTools({
      server: { tool: (name) => registered.push(name) },
      handlers,
      role: 'author',
      stageId: 'build-and-test',
      policy: { loopBack: 'human-offered' },
      z: zod,
      env: { V2_MCP_TRACE: 'off' },
    });
    expect(registered).toContain('emit_stage_note');
    expect(typeof handlers.emit_stage_note).toBe('function');
  });

  it('threads the field from the handler to the bridge', async () => {
    const seen = [];
    const handlers = buildToolHandlers({
      bridge: {
        emitStageNote: async (args) => {
          seen.push(args);
          return { eventId: 'e1' };
        },
      },
      graph: null,
      writer: {},
    });
    await handlers.emit_stage_note({ summary: 'red', loopBackRecommended: 'bad codegen' });
    expect(seen).toEqual([{ summary: 'red', type: undefined, loopBackRecommended: 'bad codegen' }]);
  });
});
