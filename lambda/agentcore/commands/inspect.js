// inspect — verification command for PRIVATE Neptune from outside the VPC: invoke
// the VPC-attached runtime over /invocations and let it run the query. Read mode
// reuses the SAME graph-writer read path the agent's MCP tools use (getIntentGraph
// / getArtifact / lookupArtifacts), so a green inspect proves the real read works.
//
// With `drop:true` it instead performs a SCOPED delete of ONE intent's subgraph
// (the Intent vertex + everything it CONTAINS — artifacts/questions), bounded to
// the named intentId. It is NOT a full-graph wipe (cf. the purge-neptune lambda).
// Intended for test-data cleanup of a known intent id.

import {
  createGraphWriter,
  closeGraphSource,
  INTENT_LABEL,
  ANCHOR_EDGE,
} from '../mcp/graph-writer.js';

export const inspect = async (
  { intentId, artifactType = null, artifactId = null, drop = false },
  deps,
) => {
  const { openGraph } = deps;
  if (!intentId) return { ok: false, reason: 'missing_intentId' };

  let g;
  try {
    g = await openGraph();
  } catch (e) {
    return { ok: false, reason: 'graph_open_failed', detail: e.message };
  }

  // Close the graph connection on every exit (release its fd — see
  // closeGraphSource). The long-lived session process reuses this command; a
  // leaked connection per call marches toward EMFILE.
  try {
    // Scoped delete: drop the contained vertices, then the Intent anchor itself.
    // Bounded to this intentId — never a global drop.
    if (drop) {
      try {
        const before = await g
          .V()
          .has(INTENT_LABEL, 'id', intentId)
          .out(ANCHOR_EDGE)
          .count()
          .next();
        // Terminate with next() (not iterate(): its discard() step is unsupported
        // on some Gremlin server versions).
        await g.V().has(INTENT_LABEL, 'id', intentId).out(ANCHOR_EDGE).drop().next();
        await g.V().has(INTENT_LABEL, 'id', intentId).drop().next();
        return { ok: true, intentId, dropped: true, containedDropped: before.value };
      } catch (e) {
        return { ok: false, reason: 'graph_drop_failed', detail: e.message };
      }
    }

    try {
      const reader = createGraphWriter({ g, scope: { intentId } });
      const artifacts = await reader.getIntentGraph({ includeContent: true });
      const result = {
        ok: true,
        intentId,
        artifactCount: artifacts.length,
        // Compact list so the response stays small; full content via artifactId.
        artifacts: artifacts.map((a) => ({
          id: a.id,
          artifact_type: a.artifact_type,
          title: a.title ?? null,
          created_by_execution_id: a.created_by_execution_id ?? null,
          created_by_stage_instance_id: a.created_by_stage_instance_id ?? null,
          created_at: a.created_at ?? null,
          contentBytes: typeof a.content === 'string' ? a.content.length : 0,
        })),
      };
      if (artifactType)
        result.ofType = await reader.lookupArtifacts({ artifactType, includeContent: true });
      if (artifactId) result.artifact = await reader.getArtifact({ id: artifactId });
      return result;
    } catch (e) {
      return { ok: false, reason: 'graph_query_failed', detail: e.message };
    }
  } finally {
    await closeGraphSource(g);
  }
};
