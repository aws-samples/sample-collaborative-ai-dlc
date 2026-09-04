import { describe, it, expect } from 'vitest';
import { collectDownstreamClosure, CLOSURE_MAX_NODES, EDIT_ORIGINS } from '../artifact-edit.js';

// The closure walk is the heart of the drift-marking decision (full
// transitive closure over CONSUMES/DERIVED_FROM/CITES in-edges). Pure BFS
// over an injected neighbor fetcher — these tests pin cycle safety, depth
// annotation, edge-evidence merging and the corruption backstops.

const graphFetcher = (edges) => async (id) =>
  (edges[id] ?? []).map((n) => (typeof n === 'string' ? { id: n, edges: ['CONSUMES'] } : n));

describe('collectDownstreamClosure', () => {
  it('walks the full transitive closure with depth annotation, root excluded', async () => {
    const closure = await collectDownstreamClosure({
      neighborsOf: graphFetcher({
        root: ['a', 'b'],
        a: ['c'],
        c: ['d'],
      }),
      rootId: 'root',
    });
    expect(closure.map((n) => [n.id, n.depth])).toEqual([
      ['a', 1],
      ['b', 1],
      ['c', 2],
      ['d', 3],
    ]);
  });

  it('is cycle-safe (a → b → a) and never revisits the root', async () => {
    const closure = await collectDownstreamClosure({
      neighborsOf: graphFetcher({
        root: ['a'],
        a: ['b'],
        b: ['a', 'root'],
      }),
      rootId: 'root',
    });
    expect(closure.map((n) => n.id)).toEqual(['a', 'b']);
  });

  it('keeps the shortest path depth and merges edge evidence from later paths', async () => {
    const closure = await collectDownstreamClosure({
      neighborsOf: async (id) => {
        if (id === 'root') {
          return [
            { id: 'a', edges: ['CONSUMES'] },
            { id: 'b', edges: ['DERIVED_FROM'] },
          ];
        }
        // b also reaches a (deeper path, different edge) — the entry must keep
        // depth 1 but gain the CITES evidence.
        if (id === 'b') return [{ id: 'a', edges: ['CITES'] }];
        return [];
      },
      rootId: 'root',
    });
    const a = closure.find((n) => n.id === 'a');
    expect(a.depth).toBe(1);
    expect(a.via.toSorted()).toEqual(['CITES', 'CONSUMES']);
  });

  it('applies maxDepth and maxNodes as corruption backstops', async () => {
    // An "infinite" chain: every node points at a fresh one.
    let i = 0;
    const chain = async () => [{ id: `n${++i}`, edges: ['CONSUMES'] }];
    const shallow = await collectDownstreamClosure({
      neighborsOf: chain,
      rootId: 'root',
      maxDepth: 3,
    });
    expect(shallow.length).toBe(3);

    i = 0;
    const wide = await collectDownstreamClosure({
      neighborsOf: async () =>
        Array.from({ length: 100 }, (_, k) => ({ id: `w${i}-${k}`, edges: ['CONSUMES'] })),
      rootId: 'root',
      maxNodes: 10,
    });
    expect(wide.length).toBe(10);
    expect(CLOSURE_MAX_NODES).toBeGreaterThan(0);
  });

  it('drops neighbor rows without an id', async () => {
    const closure = await collectDownstreamClosure({
      neighborsOf: async (id) => (id === 'root' ? [{ id: '' }, { title: 'x' }, { id: 'a' }] : []),
      rootId: 'root',
    });
    expect(closure.map((n) => n.id)).toEqual(['a']);
  });
});

describe('edit origins', () => {
  it('only human and quorum are valid post-hoc edit origins', () => {
    expect(EDIT_ORIGINS).toEqual(['human', 'quorum']);
  });
});
