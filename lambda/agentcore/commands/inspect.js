// inspect — READ-ONLY verification command. Given an intentId, open the business
// graph and return its artifact snapshot (+ optionally one artifact's full props).
//
// This is the only way to read PRIVATE Neptune from outside the VPC: invoke the
// VPC-attached runtime over /invocations and let it run the query. It reuses the
// SAME graph-writer read path the agent's MCP tools use (getIntentGraph /
// getArtifact / lookupArtifacts), so a green inspect proves the real read works —
// not a side channel. No writes, no process-state mutation.

import { createGraphWriter } from '../mcp/graph-writer.js';

export const inspect = async ({ intentId, artifactType = null, artifactId = null }, deps) => {
  const { openGraph } = deps;
  if (!intentId) return { ok: false, reason: 'missing_intentId' };

  let g;
  try {
    g = await openGraph();
  } catch (e) {
    return { ok: false, reason: 'graph_open_failed', detail: e.message };
  }

  try {
    const reader = createGraphWriter({ g, scope: { intentId } });
    const artifacts = await reader.getIntentGraph();
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
    if (artifactType) result.ofType = await reader.lookupArtifacts({ artifactType });
    if (artifactId) result.artifact = await reader.getArtifact({ id: artifactId });
    return result;
  } catch (e) {
    return { ok: false, reason: 'graph_query_failed', detail: e.message };
  }
};
