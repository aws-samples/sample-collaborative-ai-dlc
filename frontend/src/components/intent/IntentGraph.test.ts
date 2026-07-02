import { describe, it, expect } from 'vitest';
import { layerStages } from './IntentGraph';
import type { IntentStageRow, StageEdge } from '@/contexts/IntentContext';

const row = (stageId: string, order: number): IntentStageRow => ({
  stageId,
  phase: null,
  state: 'PENDING',
  stageInstanceId: null,
  runtimeError: null,
  startedAt: null,
  completedAt: null,
  attempt: 0,
  cli: null,
  order,
  planned: true,
});

const ids = (columns: IntentStageRow[][]) => columns.map((c) => c.map((r) => r.stageId));

describe('layerStages (topological pipeline layout)', () => {
  it('lays a chain out one column per dependency depth', () => {
    const edges: StageEdge[] = [
      { from: 'a', to: 'b', artifact: 'x', kind: 'data' },
      { from: 'b', to: 'c', kind: 'requires' },
    ];
    expect(ids(layerStages([row('a', 0), row('b', 1), row('c', 2)], edges))).toEqual([
      ['a'],
      ['b'],
      ['c'],
    ]);
  });

  it('places diamond branches in one column, sorted by plan order', () => {
    const edges: StageEdge[] = [
      { from: 'a', to: 'c', kind: 'data', artifact: 'x' },
      { from: 'a', to: 'b', kind: 'data', artifact: 'y' },
      { from: 'b', to: 'd', kind: 'requires' },
      { from: 'c', to: 'd', kind: 'requires' },
    ];
    expect(ids(layerStages([row('a', 0), row('b', 1), row('c', 2), row('d', 3)], edges))).toEqual([
      ['a'],
      ['b', 'c'],
      ['d'],
    ]);
  });

  it('a node depends on the DEEPEST of its dependencies (longest path)', () => {
    // a → b → c, and a → c directly: c must sit after b, not beside it.
    const edges: StageEdge[] = [
      { from: 'a', to: 'b', kind: 'requires' },
      { from: 'b', to: 'c', kind: 'requires' },
      { from: 'a', to: 'c', kind: 'requires' },
    ];
    expect(ids(layerStages([row('a', 0), row('b', 1), row('c', 2)], edges))).toEqual([
      ['a'],
      ['b'],
      ['c'],
    ]);
  });

  it('keeps every node when the graph has a cycle (leftovers appended)', () => {
    const edges: StageEdge[] = [
      { from: 'a', to: 'b', kind: 'requires' },
      { from: 'b', to: 'a', kind: 'requires' },
    ];
    const columns = layerStages([row('a', 0), row('b', 1)], edges);
    expect(
      columns
        .flat()
        .map((r) => r.stageId)
        .toSorted(),
    ).toEqual(['a', 'b']);
  });

  it('ignores edges to stages outside the rendered set and self-loops', () => {
    const edges: StageEdge[] = [
      { from: 'ghost', to: 'a', kind: 'requires' },
      { from: 'a', to: 'a', kind: 'requires' },
    ];
    expect(ids(layerStages([row('a', 0)], edges))).toEqual([['a']]);
  });
});

// ── WP7: fan-out instance aggregation (one graph node per plan stage) ────────

import { aggregateStageRows } from './IntentGraph';

const inst = (stageId: string, unitSlug: string | null, state: string, order = 0) => ({
  stageId,
  phase: null,
  state: state as never,
  stageInstanceId: unitSlug ? `si-${stageId}-${unitSlug}` : `si-${stageId}`,
  unitSlug,
  runtimeError: null,
  startedAt: null,
  completedAt: null,
  attempt: 0,
  cli: null,
  order,
  planned: true,
});

describe('aggregateStageRows', () => {
  it('passes single-instance stages through with instances=1', () => {
    const out = aggregateStageRows([inst('a', null, 'SUCCEEDED')]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ stageId: 'a', state: 'SUCCEEDED', instances: 1 });
  });

  it('collapses fan-out instances into one node with the most attention-worthy state', () => {
    // FAILED wins over everything.
    expect(
      aggregateStageRows([
        inst('cg', 'a', 'SUCCEEDED'),
        inst('cg', 'b', 'FAILED'),
        inst('cg', 'c', 'RUNNING'),
      ])[0],
    ).toMatchObject({ stageId: 'cg', state: 'FAILED', instances: 3, unitSlug: null });
    // WAITING beats RUNNING.
    expect(
      aggregateStageRows([inst('cg', 'a', 'RUNNING'), inst('cg', 'b', 'WAITING_FOR_HUMAN')])[0]
        .state,
    ).toBe('WAITING_FOR_HUMAN');
  });

  it('mixed done/pending with nothing running reads as an in-flight fan-out (RUNNING)', () => {
    const out = aggregateStageRows([inst('cg', 'a', 'SUCCEEDED'), inst('cg', 'b', 'PENDING')]);
    expect(out[0].state).toBe('RUNNING');
  });

  it('all-terminal instances (SUCCEEDED/SKIPPED) read as done; all-pending as pending', () => {
    expect(
      aggregateStageRows([inst('cg', 'a', 'SUCCEEDED'), inst('cg', 'b', 'SKIPPED')])[0].state,
    ).toBe('SUCCEEDED');
    expect(
      aggregateStageRows([inst('cg', 'a', 'PENDING'), inst('cg', 'b', 'PENDING')])[0].state,
    ).toBe('PENDING');
  });
});
