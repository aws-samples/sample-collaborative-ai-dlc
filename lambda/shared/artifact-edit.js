// Artifact editing — the shared Neptune helpers behind post-hoc document
// edits (human "simple edit" and the Quorum-supported edit flow).
//
// V2 artifacts are stage outputs that downstream stages consume and derive
// from; editing one AFTER those stages ran introduces potential drift. This
// module owns the drift bookkeeping so the intents lambda (human edit path)
// and the AgentCore container (Quorum edit path) share ONE implementation:
//
//   - downstream closure   — every artifact transitively derived from /
//     consuming the edited document (in-edges over CONSUMES / DERIVED_FROM /
//     CITES, full transitive closure per the drift-marking decision);
//   - stale markers        — `stale_since` / `stale_reason` props stamped on
//     the closure at edit time. Cleared when the artifact is next updated
//     (human, Quorum, or an agent's create/update_artifact — the same
//     rehabilitation discipline as the rewind `superseded` marker) or when a
//     human/Quorum explicitly marks it verified;
//   - edit provenance      — `edited_by` / `edited_at` / `edit_origin` props,
//     stamped by TRUSTED server code only (they are reserved from agent tool
//     args in graph-writer.js, mirroring the created_* provenance stamp).
//
// Pure-ish + injectable like graph-writer.js: every helper takes the live
// gremlin traversal source `g`, and the closure walk is a pure BFS over an
// injected neighbor fetcher so the traversal logic is unit-testable without a
// graph.

import gremlin from 'gremlin';
import { flattenVertexMap, isCurrentRow } from './graph-rows.js';

const { cardinality } = gremlin.process;

// The edges that make an artifact "downstream" of another. All three are
// evidence of consumption/derivation the system already records: agents wire
// CONSUMES/DERIVED_FROM via link_artifacts; CITES is materialized by the
// derive step from actual wikilink citations in the prose.
export const DOWNSTREAM_EDGES = ['CONSUMES', 'DERIVED_FROM', 'CITES'];

// Guards for the closure walk — an intent's artifact graph is small (tens of
// vertices), so these are corruption backstops, never expected limits.
export const CLOSURE_MAX_DEPTH = 12;
export const CLOSURE_MAX_NODES = 250;

// Artifact edit origins (who changed the content post-hoc).
export const EDIT_ORIGINS = ['human', 'quorum'];

/**
 * Pure BFS over an injected async neighbor fetcher. Returns the downstream
 * closure of `rootId` (root excluded) in BFS order, each row annotated with
 * `depth` (1 = direct consumer/derivation) and `via` (the edge labels that
 * reached it, deduped). Cycle-safe: a visited id is never re-expanded.
 *
 * @param {{
 *   neighborsOf: (id: string) => Promise<{ id: string, edges?: string[] }[]>,
 *   rootId: string,
 *   maxDepth?: number,
 *   maxNodes?: number,
 * }} opts
 */
export const collectDownstreamClosure = async ({
  neighborsOf,
  rootId,
  maxDepth = CLOSURE_MAX_DEPTH,
  maxNodes = CLOSURE_MAX_NODES,
}) => {
  const seen = new Set([rootId]);
  const out = [];
  const byId = new Map();
  let frontier = [rootId];
  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth += 1) {
    const next = [];
    for (const id of frontier) {
      const neighbors = await neighborsOf(id);
      for (const n of neighbors ?? []) {
        if (!n?.id) continue;
        if (seen.has(n.id)) {
          // Already collected on a shorter/equal path — just merge the edge
          // evidence so `via` names every relation that reaches it.
          const existing = byId.get(n.id);
          if (existing) {
            existing.via = [...new Set([...existing.via, ...(n.edges ?? [])])];
          }
          continue;
        }
        seen.add(n.id);
        const row = { ...n, depth, via: [...new Set(n.edges ?? [])] };
        delete row.edges;
        byId.set(n.id, row);
        out.push(row);
        if (out.length >= maxNodes) return out;
        next.push(n.id);
      }
    }
    frontier = next;
  }
  return out;
};

// Gremlin-bound neighbor fetcher: CURRENT artifacts one in-edge hop downstream
// of `artifactId`, with the edge labels that connect them. Intent-scoped on
// both ends (artifact ids are only unique within an intent — see
// graph-writer.js INTENT_SCOPED_LABELS).
export const makeDownstreamNeighborsFetcher = (g, intentId) => async (artifactId) => {
  const byId = new Map();
  for (const edge of DOWNSTREAM_EDGES) {
    const rows = await g
      .V()
      .has('Artifact', 'id', artifactId)
      .has('intent_id', intentId)
      .in_(edge)
      .hasLabel('Artifact')
      .has('intent_id', intentId)
      .valueMap(true)
      .toList();
    for (const raw of rows) {
      const row = flattenVertexMap(raw);
      if (!row.id || !isCurrentRow(row)) continue;
      const existing = byId.get(row.id);
      if (existing) {
        existing.edges.push(edge);
      } else {
        byId.set(row.id, {
          id: row.id,
          title: row.title ?? null,
          artifactType: row.artifact_type ?? null,
          staleSince: row.stale_since ?? null,
          edges: [edge],
        });
      }
    }
  }
  return [...byId.values()];
};

/**
 * The full downstream closure of one artifact in this intent (root excluded).
 */
export const fetchDownstreamClosure = async ({ g, intentId, artifactId, maxDepth, maxNodes }) =>
  collectDownstreamClosure({
    neighborsOf: makeDownstreamNeighborsFetcher(g, intentId),
    rootId: artifactId,
    ...(maxDepth ? { maxDepth } : {}),
    ...(maxNodes ? { maxNodes } : {}),
  });

// Position a traversal on the intent-scoped artifact vertex.
const artifactAt = (g, intentId, artifactId) =>
  g.V().has('Artifact', 'id', artifactId).has('intent_id', intentId);

/**
 * Stamp the stale drift marker on a set of artifacts. `reason` names the edit
 * that caused the drift (e.g. `edit:<sourceArtifactId>:<editId|human>`), so
 * the audit trail and the Quorum flow can trace a marker back to its cause.
 * Overwrites an existing marker — the LATEST upstream edit is the one the
 * badge should point at. Returns the ids actually marked.
 */
export const markArtifactsStale = async ({ g, intentId, artifactIds = [], reason, now }) => {
  const ts = now ?? new Date().toISOString();
  const marked = [];
  for (const id of artifactIds) {
    const exists = await artifactAt(g, intentId, id).hasNext();
    if (!exists) continue;
    await artifactAt(g, intentId, id)
      .property(cardinality.single, 'stale_since', ts)
      .property(cardinality.single, 'stale_reason', String(reason ?? ''))
      .next();
    marked.push(id);
  }
  return marked;
};

/**
 * Clear the stale marker (rehabilitation: the artifact was updated or
 * explicitly verified). Best-effort — a vertex without the marker is a no-op.
 */
export const clearArtifactStale = async ({ g, intentId, artifactId }) => {
  try {
    await artifactAt(g, intentId, artifactId)
      .has('stale_since')
      .properties('stale_since', 'stale_reason')
      .drop()
      .next();
  } catch {
    /* marker cleanup is best-effort */
  }
};

/**
 * Write new content on an artifact + the post-hoc edit provenance stamp, and
 * clear its own stale marker (an edited artifact is current again — same
 * rehabilitation as `superseded`). Provenance is server-stamped only; the
 * props are reserved from agent tool args (graph-writer.js RESERVED_PROPS).
 * Throws when the artifact does not exist in this intent's scope.
 */
export const applyArtifactEdit = async ({
  g,
  intentId,
  artifactId,
  content,
  editedBy,
  editedByName = '',
  origin,
  editRef = '',
  now,
}) => {
  if (!EDIT_ORIGINS.includes(origin)) throw new Error(`invalid edit origin: ${origin}`);
  const exists = await artifactAt(g, intentId, artifactId).hasNext();
  if (!exists) throw new Error(`Artifact "${artifactId}" not found`);
  const ts = now ?? new Date().toISOString();
  await artifactAt(g, intentId, artifactId)
    .property(cardinality.single, 'content', String(content ?? ''))
    .property(cardinality.single, 'updated_at', ts)
    .property(cardinality.single, 'edited_by', String(editedBy ?? ''))
    .property(cardinality.single, 'edited_by_name', String(editedByName ?? ''))
    .property(cardinality.single, 'edited_at', ts)
    .property(cardinality.single, 'edit_origin', origin)
    .property(cardinality.single, 'edit_ref', String(editRef ?? ''))
    .next();
  await clearArtifactStale({ g, intentId, artifactId });
  return { artifactId, editedAt: ts };
};

/**
 * Mark a (possibly stale) artifact as verified: a human or Quorum reviewed it
 * against the upstream edit and judged it still valid. Clears the stale
 * marker and records who/when/why. Throws when the artifact does not exist.
 */
export const verifyArtifact = async ({
  g,
  intentId,
  artifactId,
  verifiedBy,
  verifiedByName = '',
  note = '',
  now,
}) => {
  const exists = await artifactAt(g, intentId, artifactId).hasNext();
  if (!exists) throw new Error(`Artifact "${artifactId}" not found`);
  const ts = now ?? new Date().toISOString();
  await artifactAt(g, intentId, artifactId)
    .property(cardinality.single, 'verified_by', String(verifiedBy ?? ''))
    .property(cardinality.single, 'verified_by_name', String(verifiedByName ?? ''))
    .property(cardinality.single, 'verified_at', ts)
    .property(cardinality.single, 'verify_note', String(note ?? ''))
    .next();
  await clearArtifactStale({ g, intentId, artifactId });
  return { artifactId, verifiedAt: ts };
};

export default {
  DOWNSTREAM_EDGES,
  CLOSURE_MAX_DEPTH,
  CLOSURE_MAX_NODES,
  EDIT_ORIGINS,
  collectDownstreamClosure,
  makeDownstreamNeighborsFetcher,
  fetchDownstreamClosure,
  markArtifactsStale,
  clearArtifactStale,
  applyArtifactEdit,
  verifyArtifact,
};
