// init-ws — the workspace-setup bootstrap, run once per intent when the intent is
// created (the v2 "initialization" phase done under the hood). It:
//   1. checks out the intent's git repos into the session-persistent filesystem,
//   2. creates the Intent anchor vertex in Neptune (artifacts hang off it),
//   3. seeds the v2 execution state (CREATED) so later run-stage calls advance it.
//
// It does NOT run an agent — it is deterministic setup. Subsequent run-stage
// invocations reuse the SAME AgentCore session, so the checkout persists. Every
// effect is injected for testing.

import gremlin from 'gremlin';

const { cardinality } = gremlin.process;

// Create (idempotent) the Intent anchor vertex. Artifacts created by stages are
// CONTAINS-ed by this vertex; the page reads the intent subgraph from here.
export const ensureIntentVertex = async ({ g, projectId, intentId, title = '', now }) => {
  const __ = gremlin.process.statics;
  await g
    .V()
    .has('Intent', 'id', intentId)
    .fold()
    .coalesce(__.unfold(), __.addV('Intent').property(cardinality.single, 'id', intentId))
    .next();
  await g
    .V()
    .has('Intent', 'id', intentId)
    .property(cardinality.single, 'project_id', projectId)
    .property(cardinality.single, 'title', title)
    .property(cardinality.single, 'created_at', now)
    .next();
  return { intentId };
};

export const initWs = async (
  {
    projectId,
    intentId,
    executionId,
    repos = [],
    branch,
    baseBranch,
    gitToken,
    gitProvider,
    title,
    workflowId,
    workflowVersion,
    scope,
    startedBy,
  },
  deps,
) => {
  const {
    store,
    openGraph,
    checkoutRepos,
    workspaceDir,
    broadcast = async () => {},
    clock = () => new Date().toISOString(),
  } = deps;
  const now = clock();

  // 1. Checkout repos into the session workspace.
  let checkedOut = [];
  try {
    checkedOut = await checkoutRepos({
      repos,
      branch,
      baseBranch,
      gitToken,
      gitProvider,
      workspaceDir,
    });
  } catch (e) {
    return { ok: false, reason: 'checkout_failed', detail: e.message };
  }

  // 2. Create the Intent anchor in Neptune.
  const g = await openGraph();
  try {
    await ensureIntentVertex({ g, projectId, intentId, title: title ?? '', now });
  } catch (e) {
    return { ok: false, reason: 'intent_vertex_failed', detail: e.message };
  }

  // 3. Seed the execution state (idempotent — a re-init keeps the existing row).
  try {
    await store.createExecution({
      executionId,
      projectId,
      intentId,
      status: 'CREATED',
      workflowId,
      workflowVersion,
      scope,
      startedBy,
      startedAt: now,
    });
  } catch (e) {
    // A conditional-check failure means the execution already exists — fine for a
    // re-init within the same session. Anything else is a real error.
    if (e?.name !== 'ConditionalCheckFailedException') {
      return { ok: false, reason: 'state_seed_failed', detail: e.message };
    }
  }

  await store
    .appendEvent({
      executionId,
      type: 'v2.workspace.initialized',
      actor: 'agentcore',
      summary: `Workspace initialized (${checkedOut.length} repo(s))`,
    })
    .catch(() => {});

  // Broadcast the workspace init so the UI can show the intent has booted.
  // Best-effort: the DynamoDB event is the source of truth.
  await broadcast({
    action: 'agent.workspace',
    executionId,
    intentId,
    projectId,
    state: 'INITIALIZED',
    repos: checkedOut.map((r) => r.repo),
  }).catch(() => {});

  return { ok: true, intentId, executionId, repos: checkedOut.map((r) => r.repo) };
};
