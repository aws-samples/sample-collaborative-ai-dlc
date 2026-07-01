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
