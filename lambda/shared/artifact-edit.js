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
import { randomUUID } from 'node:crypto';
import { flattenVertexMap } from './graph-rows.js';
import {
  artifactLogicalKeyFromRow,
  readArtifactHead,
  readIntentArtifactEntries,
  resolveArtifactGroup,
  selectCanonicalArtifact,
  selectCurrentArtifactHeads,
} from './artifact-versioning.js';

const { cardinality, t: T } = gremlin.process;
const __ = gremlin.process.statics;

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
// of the selected head, with the edge labels that connect them. Resolve each
// endpoint by logical identity and intent ownership; authored ids may repeat.
export const makeDownstreamNeighborsFetcher = (g, intentId) => {
  const entries = readIntentArtifactEntries(g, intentId, { withContent: false });
  return async (artifactId) => {
    const allRows = await entries;
    const root = selectCanonicalArtifact(resolveArtifactGroup(allRows, intentId, artifactId));
    if (!root) return [];
    const heads = selectCurrentArtifactHeads(allRows, intentId);
    const currentVertices = new Set(heads.map((row) => row.vertexId));
    const byId = new Map();
    for (const edge of DOWNSTREAM_EDGES) {
      const rows = await g
        .V(root.vertexId)
        .hasLabel('Artifact')
        .has('intent_id', intentId)
        .in_(edge)
        .hasLabel('Artifact')
        .has('intent_id', intentId)
        .hasNot('superseded_at')
        .project('vertexId', 'props')
        .by(T.id)
        .by(__.valueMap(true))
        .toList();
      for (const entry of rows) {
        if (!currentVertices.has(entry.get('vertexId'))) continue;
        const row = flattenVertexMap(entry.get('props'));
        if (!row.id) continue;
        const reference = artifactLogicalKeyFromRow(row, intentId);
        const existing = byId.get(reference);
        if (existing) {
          existing.edges.push(edge);
        } else {
          byId.set(reference, {
            id: reference,
            title: row.title || row.id,
            artifactType: row.artifact_type ?? null,
            staleSince: row.stale_since ?? null,
            edges: [edge],
          });
        }
      }
    }
    return [...byId.values()];
  };
};

/**
 * The full downstream closure of one artifact in this intent (root excluded).
 * Emit logical keys regardless of whether the caller used a key or a legacy id.
 */
export const fetchDownstreamClosure = async ({ g, intentId, artifactId, maxDepth, maxNodes }) => {
  const head = await readArtifactHead(g, intentId, artifactId, { withContent: false });
  if (!head) return [];
  return collectDownstreamClosure({
    neighborsOf: makeDownstreamNeighborsFetcher(g, intentId),
    rootId: artifactLogicalKeyFromRow(head, intentId),
    ...(maxDepth ? { maxDepth } : {}),
    ...(maxNodes ? { maxNodes } : {}),
  });
};

// Position a traversal on the intent-scoped artifact vertex.
const artifactAt = (g, intentId, vertexId) =>
  g.V(vertexId).hasLabel('Artifact').has('intent_id', intentId);

/**
 * Stamp the stale drift marker on a set of artifacts. `reason` names the edit
 * that caused the drift (e.g. `edit:<sourceArtifactId>:<editId|human>`), so
 * the audit trail and the Quorum flow can trace a marker back to its cause.
 * Overwrites an existing marker — the LATEST upstream edit is the one the
 * badge should point at. Returns the logical keys actually marked.
 */
export const markArtifactsStale = async ({ g, intentId, artifactIds = [], reason, now }) => {
  if (artifactIds.length === 0) return [];
  const ts = now ?? new Date().toISOString();
  const entries = await readIntentArtifactEntries(g, intentId, { withContent: false });
  const marked = [];
  for (const id of artifactIds) {
    const head = selectCanonicalArtifact(resolveArtifactGroup(entries, intentId, id));
    if (!head || head.superseded_at) continue;
    await artifactAt(g, intentId, head.vertexId)
      .hasNot('superseded_at')
      .property(cardinality.single, 'stale_since', ts)
      .property(cardinality.single, 'stale_reason', String(reason ?? ''))
      .next();
    marked.push(artifactLogicalKeyFromRow(head, intentId));
  }
  return marked;
};

/**
 * Clear the stale marker (rehabilitation: the artifact was updated or
 * explicitly verified). Best-effort — a vertex without the marker is a no-op.
 */
export const clearArtifactStale = async ({ g, intentId, artifactId, vertexId }) => {
  const targetId =
    vertexId ?? (await readArtifactHead(g, intentId, artifactId, { withContent: false }))?.vertexId;
  if (targetId === undefined) return;
  try {
    await artifactAt(g, intentId, targetId)
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
  ifEditRevision,
  ifCollaborationEpoch,
  now,
}) => {
  if (!EDIT_ORIGINS.includes(origin)) throw new Error(`invalid edit origin: ${origin}`);
  const head = await readArtifactHead(g, intentId, artifactId, { withContent: false });
  if (!head || head.superseded_at) throw new Error(`Artifact "${artifactId}" not found`);
  const ts = now ?? new Date().toISOString();
  const editRevision = randomUUID();
  let target = artifactAt(g, intentId, head.vertexId).hasNot('superseded_at');
  // Test the revision and epoch in the SAME graph mutation as the content write.
  // A preflight read alone permits a delayed autosave to overwrite another editor.
  if (ifEditRevision !== undefined)
    target =
      ifEditRevision === null
        ? target.hasNot('edit_revision')
        : target.has('edit_revision', ifEditRevision);
  if (ifCollaborationEpoch !== undefined)
    target =
      ifCollaborationEpoch === null
        ? target.hasNot('collaboration_epoch')
        : target.has('collaboration_epoch', ifCollaborationEpoch);
  let write = target
    .property(cardinality.single, 'edit_revision', editRevision)
    .property(cardinality.single, 'content', String(content ?? ''))
    .property(cardinality.single, 'updated_at', ts)
    .property(cardinality.single, 'edited_by', String(editedBy ?? ''))
    .property(cardinality.single, 'edited_by_name', String(editedByName ?? ''))
    .property(cardinality.single, 'edited_at', ts)
    .property(cardinality.single, 'edit_origin', origin)
    .property(cardinality.single, 'edit_ref', String(editRef ?? ''));
  // Human autosaves share their current CRDT. A Quorum replacement starts a
  // fresh editor document so a recovered old snapshot cannot overwrite it.
  if (origin === 'quorum')
    write = write.property(cardinality.single, 'collaboration_epoch', randomUUID());
  const result = await write.id().next();
  if (result.done) {
    const error = new Error('Artifact changed while saving — retry from the current document');
    error.code = 'edit_conflict';
    throw error;
  }
  await clearArtifactStale({ g, intentId, vertexId: head.vertexId });
  return { artifactId: artifactLogicalKeyFromRow(head, intentId), editedAt: ts, editRevision };
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
  const head = await readArtifactHead(g, intentId, artifactId, { withContent: false });
  if (!head || head.superseded_at) throw new Error(`Artifact "${artifactId}" not found`);
  const ts = now ?? new Date().toISOString();
  await artifactAt(g, intentId, head.vertexId)
    .hasNot('superseded_at')
    .property(cardinality.single, 'verified_by', String(verifiedBy ?? ''))
    .property(cardinality.single, 'verified_by_name', String(verifiedByName ?? ''))
    .property(cardinality.single, 'verified_at', ts)
    .property(cardinality.single, 'verify_note', String(note ?? ''))
    .next();
  await clearArtifactStale({ g, intentId, vertexId: head.vertexId });
  return { artifactId: artifactLogicalKeyFromRow(head, intentId), verifiedAt: ts };
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
