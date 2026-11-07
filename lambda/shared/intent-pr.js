import { activePlanUnits } from './unit-completion.js';
import { repoProvider as sharedRepoProvider } from './repo-provider.js';
import { buildIntentAttribution } from './pr-attribution.js';
const repoProvider = (meta, repoId) =>
  sharedRepoProvider(repoId, meta.gitProvider, meta.repoProviders);

// ── WP6: open the fan-in PR(s) (intent-pr strategy) ─────────────────────────
// One PR per repo from the intent branch onto the base branch. Provider outcomes
// (opened / already-open / no-changes / guard-conflict / error) become timeline
// events the caller records. The PR body links back to the intent and carries
// an HONEST unit summary: lanes that were skipped after failure are named, so
// the reviewer knows what the increment does NOT contain (the human explicitly
// chose to continue without them — the fan-in gate is the decision record, the
// PR body is its mirror).
export const openIntentPrs = async ({
  openPr,
  comparePrBranches = null,
  store,
  meta,
  executionId,
  runId = null,
  applicationUrl,
  log,
}) => {
  const repos = meta.repos ?? [];
  const branch = meta.branch;
  const strategy = meta.prStrategy ?? 'intent-pr';
  // Per-repo base-branch override wins; the legacy single string is the
  // project-wide fallback; a repo absent from both falls through to null so
  // the provider resolves that repo's ACTUAL default branch (never 'main').
  const baseFor = (repoId) => meta.baseBranches?.[repoId] ?? meta.baseBranch ?? null;
  if (repos.length === 0) {
    return [
      { eventType: 'v2.pr.skipped', summary: 'No repositories on this intent — no PR to open' },
    ];
  }
  // Deterministic lost-work signal (2026-07 incident): did the engine record
  // repo work during this run? v2.git.pushed names repos whose commits reached
  // the remote; v2.git.push_failed names repos whose work did NOT become
  // durable. An artifact-only run has neither — for those, a commit-less
  // branch is genuinely "no changes". Best-effort: an unreadable timeline
  // just means the signal is silent (never blocks the PR).
  let gitEvents = [];
  try {
    gitEvents = ((await store.listEvents?.(executionId)) ?? []).filter(
      (e) => e.eventType === 'v2.git.pushed' || e.eventType === 'v2.git.push_failed',
    );
  } catch {
    /* signal is best-effort */
  }
  const repoGitActivity = (repoId) => ({
    pushed: gitEvents.some((e) => e.eventType === 'v2.git.pushed' && e.summary?.includes(repoId)),
    pushFailed: gitEvents.some(
      (e) => e.eventType === 'v2.git.push_failed' && e.summary?.includes(repoId),
    ),
  });

  // Unit transparency for the PR body (best-effort — a store without unit
  // rows, or a pre-WP3 run, just omits the section).
  let unitLines = [];
  try {
    const allUnits = (await store.listUnits?.(executionId)) ?? [];
    const unitPlan = await store.getUnitPlan?.(executionId);
    const units = unitPlan ? activePlanUnits(unitPlan, allUnits) : allUnits;
    const unmerged = units.filter((u) => u.state && u.state !== 'MERGED');
    if (units.length) {
      unitLines = [
        '',
        `Units: ${units.length} total, ${units.length - unmerged.length} integrated into the intent branch.`,
        ...unmerged.map(
          (u) =>
            `- ⚠️ unit \`${u.slug}\` NOT integrated (${u.state}${u.failureReason ? `: ${u.failureReason}` : ''}) — its branch is preserved`,
        ),
      ];
    }
  } catch {
    /* transparency section is best-effort */
  }

  const title = meta.title || `AI-DLC: ${branch}`;
  const aidlcAttribution = buildIntentAttribution({
    applicationUrl,
    projectId: meta.projectId,
    intentId: meta.intentId ?? executionId,
  });
  const trackerRepository = (() => {
    try {
      const pathname = decodeURIComponent(new URL(meta.source?.resourceUrl).pathname);
      if (meta.source?.provider === 'github-issues') {
        const parts = pathname.split('/').filter(Boolean);
        return parts.length >= 4 && parts[2] === 'issues' ? parts.slice(0, 2).join('/') : null;
      }
      if (meta.source?.provider === 'gitlab-issues') {
        const marker = '/-/issues/';
        const markerIndex = pathname.indexOf(marker);
        return markerIndex > 0 ? pathname.slice(1, markerIndex) : null;
      }
    } catch {
      // A missing or malformed source URL only omits the PR tracker reference.
    }
    return null;
  })();
  const trackerReferenceFor = (provider, repoId) => {
    const resourceId = String(meta.source?.resourceId || '').trim();
    if (!resourceId) return null;
    const matchingTracker =
      (meta.source?.provider === 'github-issues' && provider === 'github') ||
      (meta.source?.provider === 'gitlab-issues' && provider === 'gitlab');
    if (matchingTracker && trackerRepository) {
      const issueRef =
        trackerRepository.toLowerCase() === repoId.toLowerCase()
          ? `#${resourceId}`
          : `${trackerRepository}#${resourceId}`;
      return `Closes ${issueRef}`;
    }
    if (meta.source?.provider === 'jira-cloud') {
      return meta.source.resourceUrl
        ? `Related task: [${resourceId}](${meta.source.resourceUrl})`
        : `Related task: ${resourceId}`;
    }
    return meta.source?.resourceUrl
      ? `Related issue: [#${resourceId}](${meta.source.resourceUrl})`
      : null;
  };

  const results = [];
  for (const repo of repos) {
    const repoId = typeof repo === 'string' ? repo : repo.url;
    const provider = repoProvider(meta, repoId);
    try {
      const trackerReference = trackerReferenceFor(provider, repoId);
      const body = [
        `Automated ${provider === 'gitlab' ? 'MR' : 'PR'} created by ${aidlcAttribution} (strategy: ${strategy})`,
        ...unitLines,
        ...(trackerReference ? ['', trackerReference] : []),
      ].join('\n');
      const activity = repoGitActivity(repoId);
      // Pre-check: does the intent branch exist remotely with commits ahead of
      // base? 'unknown' (comparison unavailable) falls through to the PR call
      // — the pre-check adds safety, never a new way to block a good PR.
      const cmp = comparePrBranches
        ? await comparePrBranches({
            projectId: meta.projectId,
            gitProvider: provider,
            repoId,
            base: baseFor(repoId),
            head: branch,
          }).catch((e) => ({ status: 'unknown', detail: e?.message }))
        : { status: 'unknown' };
      if (cmp.status === 'missing_head') {
        results.push({
          eventType: 'v2.pr.failed',
          summary: `PR for ${repoId} not possible: intent branch "${branch}" does not exist on the remote — the engine never pushed it${
            activity.pushFailed
              ? ' (git push failures were recorded during the run; the work may still sit on the session workspace)'
              : ''
          }`,
        });
        continue;
      }
      if (cmp.status === 'identical' || cmp.status === 'behind') {
        // No commits to merge. Benign ONLY for a run that never had repo work;
        // a run that recorded engine git activity but ends commit-less has
        // LOST WORK and must fail loudly (the 2026-07 incident: two ENOSPC'd
        // commits, a clean-looking branch, and a quiet "no changes" skip).
        if (activity.pushed || activity.pushFailed) {
          results.push({
            eventType: 'v2.pr.failed',
            summary: `PR for ${repoId} not possible: "${branch}" has no commits ahead of ${cmp.base ?? 'the base branch'} although the run recorded ${
              activity.pushFailed ? 'engine push FAILURES' : 'engine pushes'
            } — likely lost work; check the run's v2.git events and the session workspace`,
          });
          continue;
        }
        results.push({
          eventType: 'v2.pr.skipped',
          summary: `No PR for ${repoId}: no changes between ${branch} and ${cmp.base ?? 'the base branch'} (no repo work was recorded this run)`,
        });
        continue;
      }
      const res = await openPr({
        projectId: meta.projectId,
        gitProvider: provider,
        repoId,
        branch,
        baseBranch: baseFor(repoId),
        title,
        body,
        // One creation attempt per orchestrator run. The execution id alone
        // is the intent id, identical across a rewind or repair relaunch, so
        // it would replay a PR a reviewer closed in the meantime (CodeCommit
        // cannot reopen it). A durable replay of this step keeps its run id
        // and therefore its key.
        attemptKey: runId ? `${executionId}:${runId}` : executionId,
      });
      if (res?.prUrl) {
        results.push({
          eventType: 'v2.pr.opened',
          summary: `${res.existing ? 'PR already open' : 'PR opened'} for ${repoId}: ${res.prUrl}`,
          // Structured data for record-pr (the graph write happens in the
          // VPC-attached runtime; the orchestrator has no Neptune access).
          pr: {
            repoId,
            provider,
            prUrl: res.prUrl,
            prNumber: res.prNumber ?? null,
            branch,
            // The provider retargets to the repo's real default branch when the
            // requested base was invalid — record the ACTUAL merge target.
            baseBranch: res.retargetedBase ?? baseFor(repoId),
          },
        });
      } else if (res?.skipped) {
        // The provider's own "no changes" verdict (compare was unavailable).
        // Same lost-work override as above: recorded git activity means this
        // skip is NOT benign.
        if (activity.pushed || activity.pushFailed) {
          results.push({
            eventType: 'v2.pr.failed',
            summary: `PR for ${repoId} reported "${res.reason ?? 'no changes'}" although the run recorded ${
              activity.pushFailed ? 'engine push FAILURES' : 'engine pushes'
            } — likely lost work; check the run's v2.git events and the session workspace`,
          });
        } else {
          results.push({
            eventType: 'v2.pr.skipped',
            summary: `No PR for ${repoId}: ${res.reason ?? 'no changes between the branches'}`,
          });
        }
      } else if (res?.failed) {
        results.push({
          eventType: 'v2.pr.failed',
          summary: `PR for ${repoId} failed (${res.reason ?? 'error'}): ${res.error ?? 'no detail'}`,
        });
      } else if (res?.conflict) {
        results.push({
          eventType: 'v2.pr.failed',
          summary: `PR blocked for ${repoId}: ${res.error ?? 'unmerged branches'}${
            res.unmergedBranches?.length ? ` (${res.unmergedBranches.join(', ')})` : ''
          }`,
        });
      } else {
        results.push({
          eventType: 'v2.pr.failed',
          summary: `PR for ${repoId} returned an unexpected result: ${JSON.stringify(res).slice(0, 300)}`,
        });
      }
    } catch (e) {
      log?.(`PR open failed for ${repoId}: ${e?.message}`);
      results.push({
        eventType: 'v2.pr.failed',
        summary: `PR open failed for ${repoId}: ${e?.message ?? String(e)}`,
      });
    }
  }
  return results;
};
