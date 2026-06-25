import { describe, it, expect } from 'vitest';
import { createProcessBridge } from '../mcp/process-bridge.js';

// In-memory fake of the process store — only the methods the bridge calls.
const fakeStore = () => {
  const humanTasks = new Map();
  const events = [];
  const outputs = [];
  const metrics = [];
  const execPatches = [];
  let seq = 0;
  return {
    humanTasks,
    events,
    outputs,
    metrics,
    execPatches,
    async createHumanTask({ humanTaskId, kind, questions }) {
      humanTasks.set(humanTaskId, {
        humanTaskId,
        kind,
        questions,
        status: 'pending',
        answer: null,
      });
      return humanTasks.get(humanTaskId);
    },
    async getHumanTask(_executionId, humanTaskId) {
      return humanTasks.get(humanTaskId) ?? null;
    },
    async updateExecution(patch) {
      execPatches.push(patch);
    },
    async appendEvent(e) {
      const row = { ...e, eventId: `e${events.length + 1}` };
      events.push(row);
      return row;
    },
    async appendOutput({ kind, content }) {
      seq += 1;
      const row = { seq, kind, content };
      outputs.push(row);
      return row;
    },
    async recordMetric({ metrics: m }) {
      metrics.push(m);
      return { metricId: `m${metrics.length}` };
    },
  };
};

const SCOPE = { executionId: 'exec-1', intentId: 'intent-1', stageInstanceId: 'si-1' };

describe('createProcessBridge — guards', () => {
  it('requires a store and an executionId scope', () => {
    expect(() => createProcessBridge({ scope: SCOPE })).toThrow(/process store/);
    expect(() => createProcessBridge({ store: fakeStore(), scope: {} })).toThrow(/executionId/);
  });
});

describe('sendOutput', () => {
  it('persists a chunk and broadcasts it live', async () => {
    const store = fakeStore();
    const sent = [];
    const bridge = createProcessBridge({ store, scope: SCOPE, broadcast: (p) => sent.push(p) });
    const res = await bridge.sendOutput({ content: 'hello' });
    expect(res).toEqual({ seq: 1, kind: 'text' });
    expect(store.outputs).toEqual([{ seq: 1, kind: 'text', content: 'hello' }]);
    expect(sent[0]).toMatchObject({
      action: 'agent.output',
      executionId: 'exec-1',
      seq: 1,
      content: 'hello',
    });
  });
});

describe('collectMetric + emitStageNote', () => {
  it('records a metric bag', async () => {
    const store = fakeStore();
    const bridge = createProcessBridge({ store, scope: SCOPE });
    const res = await bridge.collectMetric({ metrics: { tokensInput: 5, contextWindowPct: 12 } });
    expect(res).toEqual({ metricId: 'm1' });
    expect(store.metrics[0]).toEqual({ tokensInput: 5, contextWindowPct: 12 });
  });

  it('appends an audit note event', async () => {
    const store = fakeStore();
    const bridge = createProcessBridge({ store, scope: SCOPE });
    await bridge.emitStageNote({ summary: 'started' });
    expect(store.events[0]).toMatchObject({
      type: 'v2.stage.note',
      summary: 'started',
      actor: 'si-1',
    });
  });
});

describe('askQuestion — blocking until answered', () => {
  it('opens a gate, mirrors a Question vertex, broadcasts, parks/clears, returns the answer', async () => {
    const store = fakeStore();
    const recorded = [];
    const sent = [];
    const graphWriter = { recordQuestion: (q) => recorded.push(q) };

    // sleep that, on its first tick, flips the gate to answered (simulates the
    // resume lambda answering between polls) — no real timers.
    let tick = 0;
    const sleep = async () => {
      tick += 1;
      if (tick === 2) {
        const t = [...store.humanTasks.values()][0];
        t.status = 'answered';
        t.answer = { answers: [{ freeText: 'yes' }] };
      }
    };

    const bridge = createProcessBridge({
      store,
      graphWriter,
      scope: SCOPE,
      broadcast: (p) => sent.push(p),
      sleep,
    });

    const res = await bridge.askQuestion({
      questions: [{ text: 'Proceed?', type: 'single', options: [] }],
    });

    expect(res.status).toBe('answered');
    expect(res.answer).toEqual({ answers: [{ freeText: 'yes' }] });
    // Question mirrored to the graph.
    expect(recorded).toHaveLength(1);
    // Broadcast carried the questions.
    expect(sent[0]).toMatchObject({ action: 'agent.question', executionId: 'exec-1' });
    // Execution was parked (pending set) then cleared (pending null).
    expect(store.execPatches[0]).toMatchObject({
      pendingHumanTaskId: expect.stringMatching(/^q-/),
    });
    expect(store.execPatches.at(-1)).toMatchObject({ pendingHumanTaskId: null });
    // An audit event was written.
    expect(store.events.some((e) => e.type === 'v2.question.asked')).toBe(true);
  });
});
