// Composed EXECUTE/SKIP grid — request-shape normalization shared by every
// endpoint that accepts a grid (intent create/start, workflow validate-grid,
// in-flight recompose). This is only the WIRE-shape check: the semantic
// validation (unknown stages, initialization floor, starvation) is owned by
// buildExecutionPlan's validateComposedGrid so there is exactly one authority.
//
// Returns { value } with a clean { stageId: 'EXECUTE'|'SKIP' } object (or
// null for "no grid"), or { error } with a human-readable reason.

const GRID_VALUES = new Set(['EXECUTE', 'SKIP']);

const normalizeComposedGrid = (input) => {
  if (input == null) return { value: null };
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { error: 'composedGrid must be an object of {stageId: "EXECUTE"|"SKIP"}' };
  }
  const entries = Object.entries(input);
  if (entries.length === 0) return { value: null };
  const value = {};
  for (const [stageId, raw] of entries) {
    if (typeof stageId !== 'string' || !stageId.trim()) {
      return { error: 'composedGrid keys must be non-empty stage ids' };
    }
    const v = typeof raw === 'string' ? raw.toUpperCase() : raw;
    if (!GRID_VALUES.has(v)) {
      return { error: `composedGrid["${stageId}"] must be "EXECUTE" or "SKIP"` };
    }
    value[stageId.trim()] = v;
  }
  return { value };
};

// Diff two grids into { skip, unskip } stage-id lists (entries flipping
// EXECUTE→SKIP and SKIP→EXECUTE respectively). Used by the recompose path to
// classify a proposed grid change; unlisted-in-both stages never appear.
const diffComposedGrids = (before = {}, after = {}) => {
  const skip = [];
  const unskip = [];
  const ids = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  for (const id of ids) {
    const from = before?.[id] ?? 'SKIP';
    const to = after?.[id] ?? 'SKIP';
    if (from === 'EXECUTE' && to === 'SKIP') skip.push(id);
    else if (from === 'SKIP' && to === 'EXECUTE') unskip.push(id);
  }
  return { skip: skip.toSorted(), unskip: unskip.toSorted() };
};

export { normalizeComposedGrid, diffComposedGrids };
export default { normalizeComposedGrid, diffComposedGrids };
