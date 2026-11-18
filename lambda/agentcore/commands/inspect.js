// inspect — verification command for PRIVATE Neptune from outside the VPC: invoke
// the VPC-attached runtime over /invocations and let it run the query. Read mode
// reuses the SAME graph-writer read path the agent's MCP tools use (getIntentGraph
// / getArtifact / lookupArtifacts), so a green inspect proves the real read works.
//
// With `drop:true` it instead performs a SCOPED delete of ONE intent's subgraph
// (the Intent vertex + everything it CONTAINS — artifacts/questions), bounded to
// the named intentId. It is NOT a full-graph wipe (cf. the purge-neptune lambda).
// Intended for test-data cleanup of a known intent id.

import gremlin from 'gremlin';
import { closeEngineGraph, engineGraphOpener } from '../engine-graph.js';
import {
  closeGraphSource,
  INTENT_LABEL,
  ANCHOR_EDGE,
  SECTION_LABEL,
  UNIT_OF_WORK_LABEL,
  DERIVED_ITEM_LABELS,
} from '../mcp/graph-writer.js';

const __ = gremlin.process.statics;

// Derived-layer orphan sweep (remediation for the pre-scoping incident): a
// Section / typed item / UnitOfWork whose parent artifact (or Intent, for
// units) was dropped by a delete cascade that predated the descendant sweep.
// Identified purely by a MISSING incoming structural edge — never by intent —
// so it is safe to run partition-wide. Dry-run (apply=false) counts; apply
// drops. Labels are the closed derived vocabulary, so business vertices
// (Artifact/Intent/Question/…) can never match.
const cleanupOrphans = async (g, { apply = false }) => {
  const ITEM_LABELS = [...DERIVED_ITEM_LABELS, 'ArtifactItem'];
  const orphanKinds = [
    { labels: [SECTION_LABEL], parentEdge: 'HAS_SECTION' },
    { labels: ITEM_LABELS, parentEdge: 'HAS_ITEM' },
    { labels: [UNIT_OF_WORK_LABEL], parentEdge: ANCHOR_EDGE },
  ];
  const counts = {};
  let total = 0;
  for (const { labels, parentEdge } of orphanKinds) {
    // An orphan has NO incoming parent edge of the expected type.
    const c = await g
      .V()
      .hasLabel(...labels)
      .where(__.in_(parentEdge).count().is(0))
      .count()
      .next();
    const n = Number(c.value ?? 0);
    counts[parentEdge] = n;
    total += n;
    if (apply && n > 0) {
      await g
        .V()
        .hasLabel(...labels)
        .where(__.in_(parentEdge).count().is(0))
        .drop()
        .next();
    }
  }
  return { ok: true, cleanup: true, applied: apply, orphans: counts, total };
};

// The engine-data read: the same compact summary through the engine's graph
// operations, so it works whether the graph is local or behind engine-data.
const inspectRead = async (
  { projectId, intentId, executionId, artifactType, artifactId },
  deps,
) => {
  let graph;
  try {
    graph = await engineGraphOpener(deps)({ projectId, intentId, executionId });
  } catch (e) {
    return { ok: false, reason: 'graph_open_failed', detail: e.message };
  }
  try {
    return await graph.inspect({ artifactType, artifactId });
  } catch (e) {
    return { ok: false, reason: 'graph_query_failed', detail: e.message };
  } finally {
    await closeEngineGraph(graph);
  }
};

export const inspect = async (
  {
    projectId = null,
    intentId,
    executionId = null,
    artifactType = null,
    artifactId = null,
    drop = false,
    cleanup = false,
    apply = false,
  },
  deps,
) => {
  // Cleanup and drop are partition-level maintenance with no grant that could
  // authorize them; with engine data on they are refused before any graph
  // access, dry runs included.
  if (deps.engineData && (cleanup || drop || apply)) {
    return { ok: false, reason: 'maintenance_not_supported' };
  }
  // Orphan cleanup is partition-wide remediation — it needs no intentId.
  if (!cleanup && !intentId) return { ok: false, reason: 'missing_intentId' };
  if (!cleanup && !drop) {
    return inspectRead({ projectId, intentId, executionId, artifactType, artifactId }, deps);
  }

  const { openGraph } = deps;
  let g;
  try {
    g = await openGraph();
  } catch (e) {
    return { ok: false, reason: 'graph_open_failed', detail: e.message };
  }

  try {
    if (cleanup) {
      try {
        return await cleanupOrphans(g, { apply });
      } catch (e) {
        return { ok: false, reason: 'graph_cleanup_failed', detail: e.message };
      }
    }
    // Scoped delete: drop the contained vertices, then the Intent anchor itself.
    // Bounded to this intentId — never a global drop.
    try {
      const before = await g.V().has(INTENT_LABEL, 'id', intentId).out(ANCHOR_EDGE).count().next();
      // Terminate with next() (not iterate(): its discard() step is unsupported
      // on some Gremlin server versions). TWO passes because drop() consumes
      // eagerly — a Section/item reached THROUGH an artifact the same drop
      // removes would become unreachable mid-drop and orphan-leak (the field
      // incident). Pass 1: the derived layer; pass 2: the anchor + children.
      // intent_id-guarded so a legacy shared vertex is never dropped for a
      // sibling intent that still owns it.
      await g
        .V()
        .has(INTENT_LABEL, 'id', intentId)
        .out(ANCHOR_EDGE)
        .has('intent_id', intentId)
        .hasLabel('Artifact')
        .out('HAS_SECTION', 'HAS_ITEM')
        .has('intent_id', intentId)
        .drop()
        .next();
      await g
        .V()
        .has(INTENT_LABEL, 'id', intentId)
        .out(ANCHOR_EDGE)
        .has('intent_id', intentId)
        .drop()
        .next();
      await g.V().has(INTENT_LABEL, 'id', intentId).drop().next();
      return { ok: true, intentId, dropped: true, containedDropped: before.value };
    } catch (e) {
      return { ok: false, reason: 'graph_drop_failed', detail: e.message };
    }
  } finally {
    await closeGraphSource(g);
  }
};
