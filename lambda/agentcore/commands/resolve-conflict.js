// resolve-conflict — the scoped conflict-resolution stage (docs/v2-parallel.md
// WP6, A3: "conflict → scoped conflict-resolution stage (sensors must pass) →
// human gate on repeat failure").
//
// Runs in the LANE session. The engine owns every git operation; the agent
// only edits files:
//
//   1. ENGINE: reverse merge — origin/<intentBranch> INTO the unit branch —
//      leaving real conflict markers in the tree (beginConflictMerge). The
//      intent branch never holds an in-progress merge.
//   2. AGENT: one focused CLI run, prompted with the exact conflicted paths
//      and hard boundaries (fix only those files, no git, no new scope). The
//      MCP scope is role=reviewer (read-only tools — no ask_question, so the
//      resolution can never park).
//   3. ENGINE: deterministic verification — no conflict markers may remain in
//      the previously conflicted files and the index must hold no unmerged
//      paths (the "sensors must pass" gate of this stage) — then the merge
//      commit is concluded with the engine identity and the unit branch is
//      pushed (concludeConflictMerge). Any verification failure ABORTS the
//      merge (pristine tree) and fails the command; the orchestrator's
//      halt-and-ask gate is the human escalation.
//
// After ok:true, the unit branch CONTAINS the intent branch, so the
// orchestrator's merge-lane retry is conflict-free by construction (unless a
// sibling lane merged meanwhile — that retry conflict escalates to the human).
//
// Failures are VALUES ({ ok:false, reason, detail }) — policy lives in the
// orchestrator.

import {
  beginConflictMerge as defaultBeginConflictMerge,
  concludeConflictMerge as defaultConcludeConflictMerge,
  repoTargetDir,
  runGit,
} from '../git-engine.js';
import { getDriver, selectCli } from '../cli/drivers.js';
import { runChild as defaultRunChild } from '../cli/spawn.js';
import { resolveStageModel } from '../model-resolver.js';
import {
  materializeMcpConfig as defaultMaterializeMcpConfig,
  materializeKiroAgent as defaultMaterializeKiroAgent,
  materializeOpenCodeConfig as defaultMaterializeOpenCodeConfig,
} from '../stage-materializer.js';
import {
  restoreKiroStore as defaultRestoreKiroStore,
  persistKiroStore as defaultPersistKiroStore,
} from '../cli/kiro-store.js';
import { withOpenCodeStore as defaultWithOpenCodeStore } from '../cli/opencode-store.js';

const repoUrl = (repo) => (typeof repo === 'string' ? repo : repo.url);

// The focused prompt. PURE — exported for tests. Hard boundaries: the agent
// edits ONLY the listed files; the engine performs all git.
export const buildConflictPrompt = ({ unitSlug, unitBranch, intentBranch, conflictedByRepo }) => {
  const fileLines = conflictedByRepo.flatMap(({ repo, conflicts }) =>
    conflicts.map((f) => `- ${repo}: ${f}`),
  );
  return [
    `# Merge-conflict resolution (engine-managed)`,
    '',
    `Unit lane "${unitSlug}" (branch ${unitBranch}) has a merge IN PROGRESS that`,
    `brings the integration branch ${intentBranch} into this workspace. The`,
    `following files contain git conflict markers (<<<<<<< / ======= / >>>>>>>):`,
    '',
    ...fileLines,
    '',
    '## Your task',
    '- Edit ONLY the files listed above.',
    '- Resolve EVERY conflict block: combine both sides so the intent of BOTH',
    `  changes is preserved ("${intentBranch}" carries other units' merged work;`,
    `  "${unitBranch}" carries this unit's work — keep both working).`,
    '- Remove ALL conflict markers.',
    '',
    '## Hard rules',
    '- Do NOT run any git command; the engine owns commits, merges, and pushes.',
    '- Do NOT create, delete, or modify any other file.',
    '- Do NOT add features, refactor, or "improve" code beyond the resolution.',
    '- When every marker is gone, STOP.',
  ].join('\n');
};

export const resolveConflict = async (
  {
    projectId,
    intentId,
    executionId,
    unitSlug,
    sectionIndex = null,
    repos = [],
    unitBranch,
    intentBranch,
    gitToken,
    gitProvider,
    // Commit attribution: conflict-resolution commits are authored by the
    // starting user, committed by AI-DLC Engine (see git-engine.js gitIdentity).
    gitAuthor = null,
    requestedCli,
    cliModels = {},
    tierModels = null,
    workspaceDir,
  },
  deps,
) => {
  const {
    store,
    availableClis = [],
    mcpEntry,
    broadcast = async () => {},
    env = process.env,
    spawnFn,
    runChild = defaultRunChild,
    beginConflictMerge = defaultBeginConflictMerge,
    concludeConflictMerge = defaultConcludeConflictMerge,
    materializeMcpConfig = defaultMaterializeMcpConfig,
    materializeKiroAgent = defaultMaterializeKiroAgent,
    materializeOpenCodeConfig = defaultMaterializeOpenCodeConfig,
    restoreKiroStore = defaultRestoreKiroStore,
    persistKiroStore = defaultPersistKiroStore,
    withOpenCodeStore = defaultWithOpenCodeStore,
    urlsFor = null, // test seam for file:// remotes
  } = deps;

  const publish = (payload) =>
    broadcast({ executionId, intentId, projectId, ...payload }).catch(() => {});
  const event = (type, summary) =>
    store
      ?.appendEvent({ executionId, type, unitSlug, sectionIndex, actor: 'agentcore', summary })
      .catch(() => {});

  if (!unitSlug) return { ok: false, reason: 'missing_unit_slug' };
  if (repos.length === 0) return { ok: false, reason: 'no_repos' };
  if (!unitBranch || !intentBranch) return { ok: false, reason: 'missing_branch' };

  const multi = repos.length > 1;
  const dirFor = (url) => repoTargetDir({ url, workspaceDir, multi });
  const mergeMessage = `aidlc(conflict-resolution): ${unitSlug} — ${executionId}`;

  // ── 1. ENGINE: begin the reverse merges, collecting real conflicts ────────
  const conflictedByRepo = [];
  for (const repo of repos) {
    const url = repoUrl(repo);
    const begin = await beginConflictMerge({
      dir: dirFor(url),
      repo: url,
      unitBranch,
      intentBranch,
      message: mergeMessage,
      author: gitAuthor,
      gitToken,
      gitProvider,
      urls: urlsFor ? urlsFor(url) : {},
    });
    if (begin.error) {
      await abortAll(conflictedByRepo, dirFor);
      return { ok: false, reason: begin.error, detail: `${url}: ${begin.detail ?? ''}`.trim() };
    }
    if (begin.conflicted) conflictedByRepo.push({ repo: url, conflicts: begin.conflicts });
    // A clean reverse merge (or up_to_date) needs no agent for THIS repo; the
    // conclude step below pushes any repo we merged. Track it with no
    // conflicts so conclude handles the push uniformly.
    else if (begin.merged === true) conflictedByRepo.push({ repo: url, conflicts: [] });
  }

  const needsAgent = conflictedByRepo.some((r) => r.conflicts.length > 0);
  const allConflicts = conflictedByRepo.flatMap((r) => r.conflicts.map((f) => `${r.repo}:${f}`));

  // ── 2. AGENT: one focused run over the conflicted tree ────────────────────
  if (needsAgent) {
    await event(
      'v2.conflict.resolving',
      `Conflict-resolution stage for unit ${unitSlug}: ${allConflicts.join(', ')}`,
    );
    await publish({
      action: 'agent.unit',
      unitSlug,
      sectionIndex,
      state: 'RESOLVING_CONFLICT',
      unitBranch,
    });

    const cli = selectCli({ requested: requestedCli, availableClis });
    if (!cli) {
      await abortAll(conflictedByRepo, dirFor);
      return {
        ok: false,
        reason: 'no_cli',
        detail: requestedCli
          ? `requested CLI "${requestedCli}" not available (have: ${availableClis.join(', ') || 'none'})`
          : `available: ${availableClis.join(', ') || 'none'}`,
      };
    }
    const model = resolveStageModel({ cliModels, tierModels, agentBlock: null, cli, env });
    // role=reviewer: the read-only MCP tool set — no ask_question (a conflict
    // resolution must never park), no artifact writes. Claude REQUIRES an
    // --mcp-config path; Kiro discovers its agent config from the workspace.
    const scope = {
      executionId,
      intentId,
      projectId,
      stageInstanceId: null,
      unitSlug,
      sectionIndex,
      role: 'reviewer',
      model,
    };
    const driver = getDriver(cli);
    const prompt = buildConflictPrompt({
      unitSlug,
      unitBranch,
      intentBranch,
      conflictedByRepo: conflictedByRepo.filter((r) => r.conflicts.length > 0),
    });
    let invocation;
    if (cli === 'kiro') {
      // Kiro keeps ALL conversations in one SQLite store — restore before /
      // persist after so this one-shot run can't clobber sibling stages'.
      await restoreKiroStore({ env }).catch(() => false);
      const agentName = await materializeKiroAgent({ workspaceDir, mcpEntry, scope, env });
      invocation = driver.buildInvocation({ prompt, model, agentName });
    } else if (cli === 'opencode') {
      const opencodeConfigContent = await materializeOpenCodeConfig({
        workspaceDir,
        mcpEntry,
        scope,
        env,
      });
      invocation = driver.buildInvocation({ prompt, model, opencodeConfigContent });
    } else {
      const mcpConfigPath = await materializeMcpConfig({ workspaceDir, mcpEntry, scope, env });
      invocation = driver.buildInvocation({ prompt, model, allowedTools: [], mcpConfigPath });
    }
    let result;
    const execute = () =>
      runChild({
        command: invocation.command,
        args: invocation.args,
        env: { ...invocation.env, ...driver.envForAuth(env) },
        cwd: workspaceDir,
        prompt,
        promptViaStdin: invocation.promptViaStdin,
        spawnFn,
      });
    try {
      result =
        cli === 'opencode' ? await withOpenCodeStore({ env, operation: execute }) : await execute();
    } catch (e) {
      console.error(
        `[resolve-conflict] cli_error cli=${cli} code=${e?.code ?? '-'} msg=${e?.message}`,
      );
      if (e?.stack) console.error(e.stack);
      await abortAll(conflictedByRepo, dirFor);
      return { ok: false, reason: 'cli_error', detail: e.message };
    } finally {
      if (cli === 'kiro') await persistKiroStore({ env }).catch(() => false);
    }
    if ((result?.exitCode ?? 0) !== 0) {
      await abortAll(conflictedByRepo, dirFor);
      return { ok: false, reason: 'cli_nonzero_exit', detail: String(result?.exitCode) };
    }
  }

  // ── 3. ENGINE: verify + conclude + push, per repo ──────────────────────────
  const concluded = [];
  for (const { repo, conflicts } of conflictedByRepo) {
    const res = await concludeConflictMerge({
      dir: dirFor(repo),
      repo,
      unitBranch,
      conflicts,
      author: gitAuthor,
      gitToken,
      gitProvider,
      urls: urlsFor ? urlsFor(repo) : {},
    });
    if (!res.concluded) {
      // This repo's merge is aborted by conclude; abort any still-open ones.
      await abortAll(
        conflictedByRepo.filter((r) => r.repo !== repo),
        dirFor,
      );
      const detail =
        res.reason === 'markers_remain'
          ? `${repo}: markers remain in ${(res.remaining ?? []).join(', ')}`
          : `${repo}: ${res.detail ?? res.reason}`;
      await event(
        'v2.conflict.unresolved',
        `Conflict resolution failed for ${unitSlug}: ${detail}`,
      );
      return { ok: false, reason: res.reason, detail, remaining: res.remaining ?? [] };
    }
    concluded.push({ repo, sha: res.sha });
  }

  await event(
    'v2.conflict.resolved',
    `Conflicts resolved for unit ${unitSlug} on ${unitBranch} (${
      concluded.map((c) => `${c.repo}@${(c.sha ?? '').slice(0, 8)}`).join(', ') || 'no-op'
    })`,
  );
  await publish({
    action: 'agent.unit',
    unitSlug,
    sectionIndex,
    state: 'CONFLICT_RESOLVED',
    unitBranch,
  });
  return { ok: true, unitSlug, resolvedFiles: allConflicts, repos: concluded };
};

// Best-effort: leave every touched repo with a pristine tree on any failure
// path — the halt-and-ask retry must never inherit a half-done merge.
const abortAll = async (entries, dirFor) => {
  for (const { repo } of entries) {
    await runGit(['merge', '--abort'], { cwd: dirFor(repo) });
  }
};
