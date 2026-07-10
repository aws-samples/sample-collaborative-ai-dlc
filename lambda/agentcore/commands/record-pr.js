// record-pr — write the fan-in PR(s) into the intent knowledge graph.
//
// Invoked by the orchestrator (durable step) right after openIntentPrs opens
// the PR(s) at terminal SUCCEEDED. The orchestrator has no Neptune access; the
// container is the only VPC-attached component on this path, so the structured
// PR data (url/number/branch) is forwarded here and written as a PullRequest
// vertex anchored Intent --HAS_PR--> PullRequest (one per repo).
//
// Best-effort: a graph write failure is recorded and returned, never thrown —
// the run already SUCCEEDED and the PR already exists on the remote.
//
// Returns values, never throws for expected conditions:
//   { ok: true, recorded }                     — vertices written
//   { ok: false, reason: 'missing_input' }     — no identity / no prs
//   { ok: false, reason: 'record_failed', detail } — infra error

import { createGraphWriter, closeGraphSource } from '../mcp/graph-writer.js';

export const recordPr = async (payload, deps) => {
  const { projectId, intentId, executionId, prs = [] } = payload ?? {};
  const {
    store,
    openGraph,
    broadcast = async () => {},
    clock,
    createWriter = createGraphWriter,
  } = deps;
  if (!intentId || !executionId || !Array.isArray(prs) || prs.length === 0) {
    return { ok: false, reason: 'missing_input' };
  }

  const publish = (p) => broadcast({ executionId, intentId, projectId, ...p }).catch(() => {});
  const event = (type, summary) =>
    store?.appendEvent?.({ executionId, type, actor: 'agentcore', summary }).catch(() => {});

  let g;
  try {
    g = await openGraph();
    const graph = createWriter({
      g,
      scope: { projectId, intentId, executionId },
      ...(clock ? { clock } : {}),
    });

    const recorded = [];
    for (const pr of prs) {
      const res = await graph.recordPullRequest(pr);
      recorded.push(res);
    }

    await event('v2.pr.recorded', `Recorded ${recorded.length} pull request(s) in the graph`);
    await publish({ action: 'agent.pr', prs: recorded });
    return { ok: true, recorded };
  } catch (e) {
    await event('v2.pr.record_failed', e.message);
    return { ok: false, reason: 'record_failed', detail: e.message };
  } finally {
    await closeGraphSource(g);
  }
};
