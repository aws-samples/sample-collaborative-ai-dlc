import { describe, it, expect } from 'vitest';
import { normalizeComposedGrid, diffComposedGrids, pruneSkipsForGrid } from '../composed-grid.js';

describe('normalizeComposedGrid', () => {
  it('passes null/undefined through as "no grid"', () => {
    expect(normalizeComposedGrid(null)).toEqual({ value: null });
    expect(normalizeComposedGrid(undefined)).toEqual({ value: null });
  });

  it('treats an empty object as "no grid"', () => {
    expect(normalizeComposedGrid({})).toEqual({ value: null });
  });

  it('rejects non-object shapes', () => {
    expect(normalizeComposedGrid([]).error).toMatch(/must be an object/);
    expect(normalizeComposedGrid('EXECUTE').error).toMatch(/must be an object/);
    expect(normalizeComposedGrid(42).error).toMatch(/must be an object/);
  });

  it('normalizes values to upper case and trims keys', () => {
    expect(normalizeComposedGrid({ ' a ': 'execute', b: 'Skip' })).toEqual({
      value: { a: 'EXECUTE', b: 'SKIP' },
    });
  });

  it('rejects values outside EXECUTE|SKIP', () => {
    expect(normalizeComposedGrid({ a: 'MAYBE' }).error).toMatch(/EXECUTE.*SKIP/);
    expect(normalizeComposedGrid({ a: true }).error).toMatch(/EXECUTE.*SKIP/);
    expect(normalizeComposedGrid({ a: null }).error).toMatch(/EXECUTE.*SKIP/);
  });

  it('rejects blank keys', () => {
    expect(normalizeComposedGrid({ '  ': 'EXECUTE' }).error).toMatch(/non-empty stage ids/);
  });
});

describe('diffComposedGrids', () => {
  it('classifies EXECUTE→SKIP as skip and SKIP→EXECUTE as unskip', () => {
    expect(
      diffComposedGrids(
        { a: 'EXECUTE', b: 'SKIP', c: 'EXECUTE' },
        { a: 'SKIP', b: 'EXECUTE', c: 'EXECUTE' },
      ),
    ).toEqual({ skip: ['a'], unskip: ['b'] });
  });

  it('treats a missing entry as SKIP on either side', () => {
    expect(diffComposedGrids({ a: 'EXECUTE' }, {})).toEqual({ skip: ['a'], unskip: [] });
    expect(diffComposedGrids({}, { a: 'EXECUTE' })).toEqual({ skip: [], unskip: ['a'] });
  });

  it('reports no flips for identical grids', () => {
    const grid = { a: 'EXECUTE', b: 'SKIP' };
    expect(diffComposedGrids(grid, { ...grid })).toEqual({ skip: [], unskip: [] });
  });

  it('sorts the flip lists deterministically', () => {
    expect(
      diffComposedGrids({ z: 'EXECUTE', a: 'EXECUTE' }, { z: 'SKIP', a: 'SKIP' }).skip,
    ).toEqual(['a', 'z']);
  });
});

describe('pruneSkipsForGrid', () => {
  it('drops overlay entries the grid already excludes (SKIP or unlisted)', () => {
    expect(pruneSkipsForGrid(['a', 'b', 'c'], { a: 'EXECUTE', b: 'SKIP' })).toEqual(['a']); // b grid-SKIPped, c unlisted (= SKIP) — both absorbed
  });

  it('returns null when nothing survives (sparse META)', () => {
    expect(pruneSkipsForGrid(['b'], { a: 'EXECUTE', b: 'SKIP' })).toBeNull();
  });

  it('passes the overlay through untouched when there is no grid', () => {
    expect(pruneSkipsForGrid(['a', 'b'], null)).toEqual(['a', 'b']);
    expect(pruneSkipsForGrid(['a', 'b'], undefined)).toEqual(['a', 'b']);
  });

  it('tolerates empty/absent overlays', () => {
    expect(pruneSkipsForGrid(null, { a: 'EXECUTE' })).toBeNull();
    expect(pruneSkipsForGrid([], { a: 'EXECUTE' })).toBeNull();
    expect(pruneSkipsForGrid(undefined, { a: 'EXECUTE' })).toBeNull();
  });

  it('keeps overlay skips of grid-EXECUTE stages (the two mechanisms compose)', () => {
    expect(pruneSkipsForGrid(['a'], { a: 'EXECUTE', b: 'EXECUTE' })).toEqual(['a']);
  });
});
