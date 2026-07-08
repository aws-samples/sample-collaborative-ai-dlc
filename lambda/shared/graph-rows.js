'use strict';

// Shared helpers for reading Neptune/gremlin rows — used by BOTH graph stacks:
// the agentcore graph-writer (MCP tools + derive) and the intents lambda's
// knowledge-graph read. These lived as per-bundle copies until the Neptune
// valueMap-order bug had to be fixed twice — one implementation, one fix.

const { REGISTRY } = require('./artifact-extractors.js');

// Typed item vertex labels the derive step mirrors out of artifact structured
// blocks. Derived from the extraction REGISTRY (the single source of truth for
// item types) so a new registered artifact type automatically extends every
// label allowlist.
const DERIVED_ITEM_LABELS = Object.freeze([
  ...new Set(Object.values(REGISTRY).map((spec) => spec.label)),
]);

// Normalize a valueMap(true) row into a flat object. valueMap returns each
// property as a single-element array; T.id/T.label arrive as token keys we
// surface as id/label — but ONLY when no real property claims the name.
// Neptune's entry order differs from gremlin-server: on gremlin-server the
// T.id token comes first (so the business `id` property overwrote it and all
// tests passed); on Neptune it can come last, silently clobbering the business
// id with the internal vertex UUID — which broke every id-keyed read in the
// field (derive "artifact not found", UI edges dropped). Properties always
// win; tokens only fill gaps.
const flattenVertexMap = (vm) => {
  if (!vm) return null;
  const out = {};
  const tokens = {};
  const entries =
    typeof vm.forEach === 'function' && !Array.isArray(vm) ? [...vm.entries()] : Object.entries(vm);
  for (const [k, v] of entries) {
    const value = Array.isArray(v) ? v[0] : v;
    if (typeof k === 'string') out[k] = value;
    else tokens[k?.elementName ?? String(k)] = value;
  }
  for (const [k, v] of Object.entries(tokens)) {
    if (!(k in out)) out[k] = v;
  }
  return out;
};

// Current-row filter for reads. Rewind (artifacts) and re-derive (sections/
// items/units) mark stale rows with a non-empty `superseded_at`; current rows
// carry '' (or no prop at all). Client-side on purpose: gremlin's hasNot()
// cannot distinguish '' from absent, and the row sets per intent are small.
const isCurrentRow = (row) => !row?.superseded_at;

// Tolerant JSON-array prop reader — typed item props store lists as JSON
// strings (arrays pass through, garbage degrades to []).
const jsonListProp = (value) => {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== 'string' || !value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
};

module.exports = {
  DERIVED_ITEM_LABELS,
  flattenVertexMap,
  isCurrentRow,
  jsonListProp,
};
