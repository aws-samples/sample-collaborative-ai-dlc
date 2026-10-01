// The loop-back recommendation the build-and-test agent records (issue #482):
// the ONE structured field on `emit_stage_note`, which the platform writes onto
// the stage's own row for the validation gate to read, and the tool surface the
// resolved release policy decides.
//
// The load-bearing invariant: the gate reads a field only the platform writes,
// never the agent's prose, and nothing outside release mode writes it at all.

import { describe, it, expect } from 'vitest';
import { createProcessBridge } from '../mcp/process-bridge.js';
import { buildToolHandlers, registerTools, toolSchemas } from '../mcp/server.js';

const fakeStore = () => {
  const events = [];
  const recommendations = [];
  let seq = 0;
  return {
    events,
    recommendations,
    async appendEvent(event) {
      seq += 1;
      const row = { ...event, eventId: `e${seq}` };
      events.push(row);
      return row;
    },
    async setLoopBackRecommendation(input) {
      recommendations.push(input);
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

describe('emit_stage_note with loopBackRecommended', () => {
  it('writes the plain note AND the recommendation on the stage row', async () => {
    const store = fakeStore();
    const bridge = bridgeFor(store, RELEASE_SCOPE);
    const result = await bridge.emitStageNote({
      summary: 'Integration suite red: 4 failures in the payment lane.',
      loopBackRecommended: '  generated payment code ignores the idempotency contract ',
    });

    expect(result.loopBackRecommended).toBe(true);
    expect(store.events.map((row) => row.type)).toEqual(['v2.stage.note']);
    // The stage comes from the trusted container scope, never from the tool args.
    expect(store.recommendations).toEqual([
      {
        executionId: 'exec-1',
        stageInstanceId: 'si-bt',
        reason: 'generated payment code ignores the idempotency contract',
      },
    ]);
  });

  it('records nothing extra for an ordinary note', async () => {
    const store = fakeStore();
    const bridge = bridgeFor(store, RELEASE_SCOPE);
    await bridge.emitStageNote({ summary: 'Build finished.' });
    expect(store.events.map((row) => row.type)).toEqual(['v2.stage.note']);
    expect(store.recommendations).toEqual([]);
  });

  it('ignores an empty or whitespace-only reason', async () => {
    const store = fakeStore();
    const bridge = bridgeFor(store, RELEASE_SCOPE);
    await bridge.emitStageNote({ summary: 'Build finished.', loopBackRecommended: '   ' });
    expect(store.recommendations).toEqual([]);
  });

  it.each([
    ['outside release mode', null],
    ['for a release without a construction loop-back', { loopBack: null }],
  ])('never records a recommendation %s', async (_label, policy) => {
    const store = fakeStore();
    const bridge = bridgeFor(store, { ...RELEASE_SCOPE, policy });
    const result = await bridge.emitStageNote({
      summary: 'Integration suite red.',
      loopBackRecommended: 'the generated code is wrong',
    });
    expect(result).not.toHaveProperty('loopBackRecommended');
    expect(store.recommendations).toEqual([]);
  });

  it('fails the tool call when the recommendation cannot be recorded', async () => {
    const store = fakeStore();
    store.setLoopBackRecommendation = async () => {
      throw new Error('throttled');
    };
    const bridge = bridgeFor(store, RELEASE_SCOPE);
    const note = { summary: 'red', loopBackRecommended: 'bad codegen' };
    await expect(bridge.emitStageNote(note)).rejects.toThrow('throttled');
    expect(store.events).toEqual([]);
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
