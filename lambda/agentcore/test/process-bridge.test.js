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
    async createHumanTask(args) {
      humanTasks.set(args.humanTaskId, {
        ...args,
        status: 'pending',
        answer: null,
      });
      return humanTasks.get(args.humanTaskId);
    },
    async getHumanTask(_executionId, humanTaskId) {
      return humanTasks.get(humanTaskId) ?? null;
    },
    stagePatches: [],
    async updateExecution(patch) {
      execPatches.push(patch);
    },
    async updateStageState(patch) {
      this.stagePatches.push(patch);
    },
    async resumeStageRow(patch) {
      this.stagePatches.push({ ...patch, state: 'RUNNING', resumed: true });
    },
    async appendEvent(e) {
      const row = { ...e, eventId: `e${events.length + 1}` };
      events.push(row);
      return row;
    },
    async appendOutput({ kind, content }) {
      seq += 1;
      const row = { seq, kind, content, timestamp: '2026-07-16T12:34:56.000Z' };
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
    expect(store.outputs).toEqual([
      {
        seq: 1,
        kind: 'text',
        content: 'hello',
        timestamp: '2026-07-16T12:34:56.000Z',
      },
    ]);
    expect(sent[0]).toMatchObject({
      action: 'agent.output',
      executionId: 'exec-1',
      seq: 1,
      content: 'hello',
      timestamp: '2026-07-16T12:34:56.000Z',
    });
  });
});

describe('collectMetric + emitStageNote', () => {
  it('records a metric bag and broadcasts it live', async () => {
    const store = fakeStore();
    const sent = [];
    const bridge = createProcessBridge({ store, scope: SCOPE, broadcast: (p) => sent.push(p) });
    const res = await bridge.collectMetric({ metrics: { tokensInput: 5, contextWindowPct: 12 } });
    expect(res).toEqual({ metricId: 'm1' });
    expect(store.metrics[0]).toEqual({ tokensInput: 5, contextWindowPct: 12 });
    expect(sent[0]).toMatchObject({
      action: 'agent.metric',
      executionId: 'exec-1',
      intentId: 'intent-1',
      stageInstanceId: 'si-1',
      metricId: 'm1',
      metrics: { tokensInput: 5, contextWindowPct: 12 },
    });
  });

  it('appends an audit note event and broadcasts it live', async () => {
    const store = fakeStore();
    const sent = [];
    const bridge = createProcessBridge({ store, scope: SCOPE, broadcast: (p) => sent.push(p) });
    await bridge.emitStageNote({ summary: 'started' });
    expect(store.events[0]).toMatchObject({
      type: 'v2.stage.note',
      summary: 'started',
      actor: 'si-1',
    });
    expect(sent[0]).toMatchObject({
      action: 'agent.note',
      executionId: 'exec-1',
      intentId: 'intent-1',
      noteType: 'v2.stage.note',
      summary: 'started',
    });
  });
});

describe('askQuestion — answered within the grace window (inline fast path)', () => {
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

describe('askQuestion — parks when unanswered within the grace window', () => {
  it('returns a parked sentinel, sets WAITING_FOR_HUMAN, leaves the gate pending', async () => {
    const store = fakeStore();
    const sent = [];
    let polls = 0;
    // Never answers; just counts the bounded polls so we can assert they stop.
    const sleep = async () => {
      polls += 1;
    };
    const bridge = createProcessBridge({
      store,
      scope: SCOPE,
      broadcast: (p) => sent.push(p),
      sleep,
      pollIntervalMs: 1000,
      parkGraceMs: 3000, // → 3 bounded polls, then park
    });

    const res = await bridge.askQuestion({
      questions: [{ text: 'Proceed?', type: 'single', options: [] }],
    });

    expect(res).toMatchObject({ parked: true, humanTaskId: expect.stringMatching(/^q-/) });
    expect(res.message).toMatch(/STOP NOW/);
    // Bounded — did not loop forever.
    expect(polls).toBe(3);
    // Execution parked WAITING with the pending gate still set (never cleared).
    expect(store.execPatches[0]).toMatchObject({
      status: 'WAITING',
      pendingHumanTaskId: expect.stringMatching(/^q-/),
    });
    expect(store.execPatches.every((p) => p.pendingHumanTaskId !== null)).toBe(true);
    // Stage parked WAITING_FOR_HUMAN; never flipped back to RUNNING.
    expect(store.stagePatches.at(-1)).toMatchObject({ state: 'WAITING_FOR_HUMAN' });
    // The gate is still pending (resume answers it later).
    expect([...store.humanTasks.values()][0].status).toBe('pending');
  });
});

// ── WP4: unit-lane attribution (docs/v2-parallel.md) ─────────────────────────
// With N parallel lanes parked on gates at once, every gate/output/metric/event
// the bridge writes must name its lane — otherwise answers are unattributable.

describe('unit-lane scope (V2_UNIT_SLUG)', () => {
  const LANE_SCOPE = { ...SCOPE, unitSlug: 'billing' };

  it('askQuestion stamps unitSlug on the gate row, the event, and the broadcast', async () => {
    const store = fakeStore();
    const sent = [];
    const bridge = createProcessBridge({
      store,
      scope: LANE_SCOPE,
      broadcast: (p) => sent.push(p),
      sleep: async () => {},
      pollIntervalMs: 1000,
      parkGraceMs: 0, // park immediately — the attribution is what's under test
    });
    const res = await bridge.askQuestion({ questions: [{ text: '?', type: 'text' }] });
    expect(res.parked).toBe(true);
    expect([...store.humanTasks.values()][0]).toMatchObject({
      unitSlug: 'billing',
      stageInstanceId: 'si-1',
    });
    expect(store.events.find((e) => e.type === 'v2.question.asked')).toMatchObject({
      unitSlug: 'billing',
    });
    expect(sent.find((p) => p.action === 'agent.question')).toMatchObject({
      unitSlug: 'billing',
      stageInstanceId: 'si-1',
    });
    expect(store.execPatches).toHaveLength(0);
    expect(store.stagePatches.at(-1)).toMatchObject({
      state: 'WAITING_FOR_HUMAN',
      pendingHumanTaskId: res.humanTaskId,
    });
  });

  it('sendOutput / collectMetric / emitStageNote broadcasts carry the lane', async () => {
    const store = fakeStore();
    const sent = [];
    const bridge = createProcessBridge({
      store,
      scope: LANE_SCOPE,
      broadcast: (p) => sent.push(p),
    });
    await bridge.sendOutput({ content: 'hi' });
    await bridge.collectMetric({ metrics: { tokensInput: 1 } });
    await bridge.emitStageNote({ summary: 'note' });
    for (const action of ['agent.output', 'agent.metric', 'agent.note']) {
      expect(sent.find((p) => p.action === action)).toMatchObject({ unitSlug: 'billing' });
    }
    expect(store.events.find((e) => e.type === 'v2.stage.note')).toMatchObject({
      unitSlug: 'billing',
    });
  });

  it('outside a lane the attribution stays null (existing behavior untouched)', async () => {
    const store = fakeStore();
    const sent = [];
    const bridge = createProcessBridge({ store, scope: SCOPE, broadcast: (p) => sent.push(p) });
    await bridge.sendOutput({ content: 'hi' });
    expect(sent[0].unitSlug).toBeNull();
  });
});

// The reviewer identity marker (upstream stage-protocol §12a, enforced
// server-side): the TRUSTED scope identity stamps the verdict row, never the
// agent's self-report — latestReviewerVerdict matches on sensorId
// `reviewer:<agent>`, so a hallucinated name must not detach the verdict.
describe('submitReview', () => {
  const storeWithSensorRuns = () => {
    const store = fakeStore();
    store.sensorRuns = [];
    store.recordSensorRun = async (row) => {
      const withId = { ...row, sensorRunId: `sr${store.sensorRuns.length + 1}` };
      store.sensorRuns.push(withId);
      return withId;
    };
    return store;
  };

  it('stamps the trusted scope identity over the agent self-report and flags the mismatch', async () => {
    const store = storeWithSensorRuns();
    const sent = [];
    const bridge = createProcessBridge({
      store,
      scope: { ...SCOPE, role: 'reviewer', reviewerAgent: 'aidlc-architecture-reviewer-agent' },
      broadcast: (p) => sent.push(p),
    });
    const res = await bridge.submitReview({
      reviewer: 'some-hallucinated-agent',
      verdict: 'READY',
      findings: '**Reviewer:** some-hallucinated-agent\nAll good.',
      round: 1,
    });
    expect(res).toEqual({ sensorRunId: 'sr1', verdict: 'READY' });
    expect(store.sensorRuns[0]).toMatchObject({
      sensorId: 'reviewer:aidlc-architecture-reviewer-agent',
      kind: 'reviewer',
      result: 'PASS',
      detail: {
        verdict: 'READY',
        reviewer: 'aidlc-architecture-reviewer-agent',
        reportedReviewer: 'some-hallucinated-agent',
        identityMismatch: true,
      },
    });
    expect(store.events.find((e) => e.type === 'v2.review.ready')).toMatchObject({
      actor: 'aidlc-architecture-reviewer-agent',
    });
    expect(sent[0]).toMatchObject({ noteType: 'v2.review.ready' });
  });

  it('keeps the trusted identity when the agent omits its name entirely', async () => {
    const store = storeWithSensorRuns();
    const bridge = createProcessBridge({
      store,
      scope: { ...SCOPE, role: 'reviewer', reviewerAgent: 'aidlc-product-lead-agent' },
    });
    await bridge.submitReview({ verdict: 'NOT-READY', findings: 'missing sections' });
    expect(store.sensorRuns[0]).toMatchObject({
      sensorId: 'reviewer:aidlc-product-lead-agent',
      result: 'FAIL',
      detail: { verdict: 'NOT-READY', reviewer: 'aidlc-product-lead-agent' },
    });
    // No mismatch recorded when there is nothing to mismatch against.
    expect(store.sensorRuns[0].detail.identityMismatch).toBeUndefined();
  });

  it('falls back to the self-report on a legacy scope with no trusted identity', async () => {
    const store = storeWithSensorRuns();
    const bridge = createProcessBridge({ store, scope: SCOPE });
    await bridge.submitReview({ reviewer: 'aidlc-reviewer-agent', verdict: 'READY' });
    expect(store.sensorRuns[0]).toMatchObject({
      sensorId: 'reviewer:aidlc-reviewer-agent',
      detail: { reviewer: 'aidlc-reviewer-agent' },
    });
  });

  it('rejects a verdict outside READY/NOT-READY', async () => {
    const store = storeWithSensorRuns();
    const bridge = createProcessBridge({ store, scope: SCOPE });
    await expect(bridge.submitReview({ verdict: 'MAYBE' })).rejects.toThrow(/READY or NOT-READY/);
    expect(store.sensorRuns).toEqual([]);
  });
});
