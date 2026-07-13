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
import { closeGraphSource } from '../mcp/graph-writer.js';
import {
  pushBranch as defaultPushBranch,
  remoteBranchExists as defaultRemoteBranchExists,
  seedInitialCommit as defaultSeedInitialCommit,
} from '../git-engine.js';
import { getProvider } from '../../shared/git-providers.js';

const { cardinality } = gremlin.process;

// The repo's provider default branch (populated even for an empty repo). Used
// to root an empty repo on the right base. null on any provider error.
const providerDefaultBranch = async ({ repo, gitProvider, gitToken }) => {
  try {
    const provider = getProvider(gitProvider);
    return (await provider.getDefaultBranch({ token: gitToken }, repo)) ?? null;
  } catch {
    return null;
  }
};

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
    baseBranches,
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
    pushBranch = defaultPushBranch,
    remoteBranchExists = defaultRemoteBranchExists,
    seedInitialCommit = defaultSeedInitialCommit,
    resolveDefaultBranch = providerDefaultBranch,
  } = deps;
  const now = clock();

  // 1. Checkout repos into the session workspace.
  let checkedOut = [];
  try {
    checkedOut = await checkoutRepos({
      repos,
      branch,
      baseBranch,
      baseBranches,
      gitToken,
      gitProvider,
      workspaceDir,
    });
  } catch (e) {
    console.error('[init-ws] checkout_failed:', e?.message, e?.stack);
    return { ok: false, reason: 'checkout_failed', detail: e.message };
  }
  // checkoutRepo degrades a FAILED clone to `git init` (cloned:false). That
  // fallback can only ever mask real breakage — `git clone` of a genuinely
  // empty repo exits 0 — so a repo that "checked out" without cloning means
  // the remote was unreachable or unauthorized. Fail the init loudly instead.
  const notCloned = checkedOut.filter((r) => r.cloned === false).map((r) => r.repo);
  if (notCloned.length > 0) {
    return {
      ok: false,
      reason: 'checkout_failed',
      detail: `clone failed for ${notCloned.join(', ')} — repository unreachable or credentials missing/insufficient (check the git connection for the starting user)`,
    };
  }
  // The clone came down but the intent branch could not be set up (all three
  // rungs failed: checkout / -b off base / --orphan). Proceeding would let
  // every stage commit to whatever branch HEAD happens to be on — fail loudly
  // instead so the operator sees WHICH repo, not a downstream push surprise.
  const badBranch = checkedOut.filter((r) => r.branchOk === false).map((r) => r.repo);
  if (badBranch.length > 0) {
    return {
      ok: false,
      reason: 'branch_setup_failed',
      detail: `could not create/checkout the intent branch${branch ? ` '${branch}'` : ''} in ${badBranch.join(', ')} — the base branch may not exist and orphan creation failed`,
    };
  }

  // 1b. Publish the intent branch to the remote NOW. init-ws creates it locally
  // (off the base HEAD, no commits yet), but parallel construction lanes fork
  // their unit branch from origin/<intentBranch> and merge back into it — both
  // require the branch to exist remotely. Nothing else pushes it before then
  // (pre-construction stages are artifact-only: clean tree, no commit, no push),
  // so without this a lane merge fails with `intent_branch_missing`. Fatal on
  // failure: a missing remote branch strands the whole construction phase.
  //
  // A genuinely EMPTY repo (freshly created, cloned with zero commits) has an
  // unborn HEAD and no branches at all. It needs a proper shape before the
  // intent branch can be published: seedInitialCommit roots an --allow-empty
  // commit on the BASE branch (resolved: selected base → provider default →
  // 'main') and forks the intent branch off it. We then push the BASE branch
  // FIRST — the first branch pushed to an empty remote becomes its default, so
  // this makes BASE (not the intent branch) the default, mirroring a normal
  // repo. Field incident (jeromevdl/chess-analyzer): seeding on the intent
  // branch made IT the default branch. No-op for a repo that already has history.
  //
  // Skip when the branch ALREADY exists remotely: a rewind/retry re-init may run
  // after lanes advanced the branch, and re-pushing the base-HEAD local ref over
  // it would be a non-fast-forward failure. "Establish if missing", never force.
  if (branch && checkedOut.length > 0) {
    const pushFailures = [];
    for (const r of checkedOut) {
      const existing = await remoteBranchExists({
        dir: r.targetDir,
        repo: r.repo,
        branch,
        gitToken,
        gitProvider,
      }).catch(() => ({ exists: null }));
      // Already on the remote → nothing to establish.
      if (existing.exists === true) continue;

      // Empty repo → root history on the base branch and fork the intent branch
      // off it. Resolve the base name from the provider so the seeded default
      // matches what the repo was created with (e.g. main vs master).
      const base =
        baseBranches?.[r.repo] ??
        baseBranch ??
        (await resolveDefaultBranch({ repo: r.repo, gitProvider, gitToken })) ??
        'main';
      const seed = await seedInitialCommit({
        dir: r.targetDir,
        branch,
        baseBranch: base,
      }).catch((e) => ({ seeded: false, reason: 'seed_crashed', detail: e?.message }));
      if (seed.seeded === false && seed.reason !== 'not_empty') {
        pushFailures.push(
          `${r.repo} (seed ${seed.reason}${seed.detail ? `: ${seed.detail}` : ''})`,
        );
        continue;
      }

      // Freshly-seeded empty repo: push the BASE branch first so it becomes the
      // remote default, THEN the intent branch (forked off it). A repo with
      // history (`not_empty`) skips straight to the intent-branch push.
      if (seed.seeded === true) {
        const basePush = await pushBranch({
          dir: r.targetDir,
          repo: r.repo,
          branch: seed.baseBranch,
          gitToken,
          gitProvider,
        }).catch((e) => ({ pushed: false, reason: 'push_crashed', detail: e?.message }));
        if (basePush.pushed !== true) {
          pushFailures.push(
            `${r.repo} (base ${seed.baseBranch}: ${basePush.reason ?? 'unknown'}${basePush.detail ? `: ${basePush.detail}` : ''})`,
          );
          continue;
        }
      }

      const res = await pushBranch({
        dir: r.targetDir,
        repo: r.repo,
        branch,
        gitToken,
        gitProvider,
      }).catch((e) => ({ pushed: false, reason: 'push_crashed', detail: e?.message }));
      // After seeding, `empty` can only mean the repo STILL has no HEAD — the
      // branch cannot be published, so it is a failure, not an accepted no-op.
      if (res.pushed !== true) {
        pushFailures.push(
          `${r.repo} (${res.reason ?? (res.pushed === 'empty' ? 'no_commit_to_push' : 'unknown')}${res.detail ? `: ${res.detail}` : ''})`,
        );
      }
    }
    if (pushFailures.length > 0) {
      return {
        ok: false,
        reason: 'intent_branch_push_failed',
        detail: `could not publish the intent branch '${branch}' to the remote for ${pushFailures.join(', ')} — construction lanes cannot fork/merge without it`,
      };
    }
  }

  // 2. Create the Intent anchor in Neptune. Close the connection once done —
  // the graph is only needed here, and the long-lived session process would
  // otherwise leak this fd (see closeGraphSource / the EMFILE fix).
  const g = await openGraph();
  try {
    await ensureIntentVertex({ g, projectId, intentId, title: title ?? '', now });
  } catch (e) {
    return { ok: false, reason: 'intent_vertex_failed', detail: e.message };
  } finally {
    await closeGraphSource(g);
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
