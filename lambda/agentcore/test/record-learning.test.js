// record-learning — the container half of the learnings ritual.
//
// The one behaviour that matters beyond "it writes the row": this command must
// never turn a recording problem into a run problem. The stage is already approved
// by the time it is dispatched, so every failure is a value plus a loud timeline
// event, never a throw.

import { describe, expect, it, vi } from 'vitest';
import { recordLearning, __test } from '../commands/record-learning.js';

const { learningId, learningTitle } = __test;

const payload = (over = {}) => ({
  projectId: 'p1',
  intentId: 'i1',
  executionId: 'e1',
  stageInstanceId: 'si-1',
  stageId: 'requirements-analysis',
  learnings: 'NEVER store plaintext secrets. Use the credential broker instead.',
  recordedBy: 'u1',
  recordedByName: 'Ada',
  ...over,
});

const harness = ({ recordThrows = false } = {}) => {
  const events = [];
  const written = [];
  return {
    events,
    written,
    deps: {
      store: { appendEvent: vi.fn(async (args) => events.push(args)) },
      openGraph: async () => ({}),
      broadcast: vi.fn(async () => {}),
      createWriter: () => ({
        recordLearningRule: async (args) => {
          if (recordThrows) throw new Error('neptune unreachable');
          written.push(args);
          return { id: args.id, layer: args.layer, created_at: 'T' };
        },
      }),
    },
  };
};

describe('recordLearning', () => {
  it('writes the rule on the project-learnings layer with the human attributed', async () => {
    const h = harness();
    const res = await recordLearning(payload(), h.deps);
    expect(res.ok).toBe(true);
    expect(h.written[0]).toMatchObject({
      layer: 'project-learnings',
      title: 'NEVER store plaintext secrets.',
      content: 'NEVER store plaintext secrets. Use the credential broker instead.',
      props: expect.objectContaining({
        recorded_by: 'u1',
        recorded_by_name: 'Ada',
        recorded_at_stage: 'requirements-analysis',
        source: 'gate-learnings-ritual',
      }),
    });
    expect(h.events.map((e) => e.type)).toEqual(['v2.learning.recorded']);
  });

  it('refuses an empty or whitespace-only learning without touching the graph', async () => {
    const h = harness();
    expect(await recordLearning(payload({ learnings: '   ' }), h.deps)).toEqual({
      ok: false,
      reason: 'missing_input',
    });
    expect(await recordLearning(payload({ intentId: null }), h.deps)).toEqual({
      ok: false,
      reason: 'missing_input',
    });
    expect(h.written).toEqual([]);
    expect(h.events).toEqual([]);
  });

  // The ritual must never fail the run: the approval already happened.
  it('returns a value and records the failure when the graph write throws', async () => {
    const h = harness({ recordThrows: true });
    const res = await recordLearning(payload(), h.deps);
    expect(res).toMatchObject({ ok: false, reason: 'record_failed' });
    expect(h.events.map((e) => e.type)).toEqual(['v2.learning.record_failed']);
  });

  // A replayed durable step must upsert the same vertex, not accumulate one per
  // replay — so the id is content- and stage-addressed rather than random.
  it('derives a stable id from the stage instance and the content', () => {
    const args = { stageId: 'requirements-analysis', stageInstanceId: 'si-1', content: 'x' };
    expect(learningId(args)).toBe(learningId(args));
    expect(learningId({ ...args, content: 'y' })).not.toBe(learningId(args));
    expect(learningId({ ...args, stageInstanceId: 'si-2' })).not.toBe(learningId(args));
    expect(learningId(args)).toMatch(/^gate-learning-requirements-analysis-[0-9a-f]{12}$/);
  });

  it('titles a learning from its first sentence and clips a long one', () => {
    expect(learningTitle('Do X. Then Y.')).toBe('Do X.');
    expect(learningTitle('line one\nline two')).toBe('line one');
    expect(learningTitle('a'.repeat(200))).toHaveLength(80);
  });
});
