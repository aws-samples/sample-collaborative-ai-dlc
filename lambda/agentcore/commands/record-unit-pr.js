// Project unit review PRs into Neptune. DDB remains orchestration truth; this
// command only supplies distinct, inspectable graph nodes for the v2 UI.

import { createGraphWriter, closeGraphSource } from '../mcp/graph-writer.js';

export const recordUnitPr = async (payload, deps) => {
  const { projectId, intentId, executionId, unitPrs = [] } = payload ?? {};
  const {
    store,
    openGraph,
    broadcast = async () => {},
    clock,
    createWriter = createGraphWriter,
  } = deps;
  if (!intentId || !executionId || !Array.isArray(unitPrs) || unitPrs.length === 0) {
    return { ok: false, reason: 'missing_input' };
  }

  let g;
  try {
    g = await openGraph();
    const graph = createWriter({
      g,
      scope: { projectId, intentId, executionId },
      ...(clock ? { clock } : {}),
    });
    const recorded = [];
    for (const pr of unitPrs) recorded.push(await graph.recordUnitPullRequest(pr));
    await broadcast({
      executionId,
      intentId,
      projectId,
      action: 'agent.unit-pr',
      unitPrs: recorded,
    }).catch(() => {});
    return { ok: true, recorded };
  } catch (error) {
    await store
      ?.appendEvent?.({
        executionId,
        type: 'v2.unit_pr.record_failed',
        actor: 'agentcore',
        summary: error.message,
      })
      .catch(() => {});
    return { ok: false, reason: 'record_failed', detail: error.message };
  } finally {
    await closeGraphSource(g);
  }
};
