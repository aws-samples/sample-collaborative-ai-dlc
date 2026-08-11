import { randomUUID } from 'node:crypto';

const CREATED_PHRASE = 'AI-DLC completed the workflow for this issue.';
const CREATED_TASK_PHRASE = 'AI-DLC completed the workflow for this task.';
const MERGED_PHRASE = 'AI-DLC merged all delivery pull requests';
const MERGED_MR_PHRASE = 'AI-DLC merged all delivery merge requests';
const MAX_TRACKER_WRITE_ATTEMPTS = 10;
const CLAIM_LEASE_MS = 90_000;
const SCHEDULED_CONCURRENCY = 5;

const trimBaseUrl = (value) => String(value || '').replace(/\/+$/, '');

const intentUrlFor = (applicationUrl, sync) =>
  `${trimBaseUrl(applicationUrl)}/space/${encodeURIComponent(
    sync.projectId,
  )}/intent/${encodeURIComponent(sync.intentId)}`;

const intentLabel = (sync) => sync.intentTitle || sync.intentId;

const createdPhraseFor = (sync) =>
  sync.source?.provider === 'jira-cloud' ? CREATED_TASK_PHRASE : CREATED_PHRASE;

const trackerIssueLabel = (sync) => {
  const resourceId = String(sync.source?.resourceId || '').replace(/^#/, '');
  return resourceId ? `Issue #${resourceId}` : 'Issue';
};

const branchUrlFor = (pr, fallbackBranch) => {
  const branch = pr.branch || fallbackBranch;
  if (!branch || !pr.prUrl || !pr.repoId) return null;
  try {
    const url = new URL(pr.prUrl);
    const encodedBranch = encodeURIComponent(branch);
    if (pr.provider === 'github') {
      url.pathname = `/${pr.repoId}/tree/${encodedBranch}`;
    } else if (pr.provider === 'gitlab') {
      url.pathname = `/${pr.repoId}/-/tree/${encodedBranch}`;
    } else if (pr.provider === 'bitbucket') {
      url.pathname = `/${pr.repoId}/branch/${encodedBranch}`;
    } else {
      return null;
    }
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
};

const branchLink = (pr, fallbackBranch) => {
  const branch = pr.branch || fallbackBranch;
  if (!branch) return null;
  const url = branchUrlFor(pr, fallbackBranch);
  return url ? `[\`${branch}\`](${url})` : `\`${branch}\``;
};

const branchLines = (sync) => {
  const rows = sync.pullRequests
    .map((pr) => ({ pr, link: branchLink(pr, sync.branch) }))
    .filter((row) => row.link);
  if (rows.length === 0) return [];
  if (rows.length === 1) return [`- Branch: ${rows[0].link}`];
  return ['- Branches:', ...rows.map(({ pr, link }) => `  - \`${pr.repoId}\`: ${link}`)];
};

const pullRequestLines = (pullRequests) =>
  pullRequests.map((pr) => `  - \`${pr.repoId}\`: ${pr.prUrl}`);

const mergedPullRequestLines = (pullRequests) =>
  pullRequests.map((pr) => {
    const prefix = pr.provider === 'gitlab' ? '!' : '#';
    return `- \`${pr.repoId}\`: [${prefix}${pr.prNumber}](${pr.prUrl})`;
  });

const mergedPhraseFor = (sync) =>
  sync.pullRequests[0]?.provider === 'gitlab' ? MERGED_MR_PHRASE : MERGED_PHRASE;

const createdComment = (sync, applicationUrl) => {
  const lines = [
    createdPhraseFor(sync),
    '',
    `- Intent: [${intentLabel(sync)}](${intentUrlFor(applicationUrl, sync)})`,
  ];
  if (sync.workflowId) {
    const version = sync.workflowVersion == null ? '' : `@${sync.workflowVersion}`;
    const scope = sync.scope ? ` (\`${sync.scope}\`)` : '';
    lines.push(`- Workflow: \`${sync.workflowId}${version}\`${scope}`);
  }
  lines.push(...branchLines(sync));
  lines.push('- Pull requests:', ...pullRequestLines(sync.pullRequests));
  return lines.join('\n');
};

const mergedComment = (sync) =>
  [mergedPhraseFor(sync), '', ...mergedPullRequestLines(sync.pullRequests)].join('\n');

const hasDeliveryComment = (comments, phrase, intentUrl) =>
  comments.some((comment) => {
    const body = String(comment?.body || '');
    return body.includes(phrase) && body.includes(intentUrl);
  });

const normalizeCommentBody = (body) =>
  String(body || '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{2,}/g, '\n\n')
    .trim();

const hasMergedDeliveryComment = (comments, body) => {
  const expected = normalizeCommentBody(body);
  return comments.some((comment) => normalizeCommentBody(comment?.body) === expected);
};

const sanitizedError = (error) => ({
  code: error?.code || error?.name || 'TRACKER_SYNC_FAILED',
  message: String(error?.message || 'Tracker synchronization failed').slice(0, 500),
});

const isPermanentTrackerWriteError = (error) => [401, 403].includes(Number(error?.status));

const mapWithConcurrency = async (items, limit, worker) => {
  const results = Array.from({ length: items.length });
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
};

const createDeliverySynchronizer = ({
  store,
  resolveBinding,
  getTrackerProvider,
  trackerContext,
  getPullRequestStatus,
  applicationUrl = process.env.APPLICATION_URL,
  broadcast,
  clock = () => new Date(),
  ids = randomUUID,
  maxTrackerWriteAttempts = MAX_TRACKER_WRITE_ATTEMPTS,
}) => {
  const emit = async (sync, type, summary) => {
    try {
      await store.appendEvent?.({
        executionId: sync.executionId,
        type,
        actor: 'tracker-sync',
        summary,
      });
    } catch {
      // Timeline events are best-effort and never control synchronization.
      return;
    }
    try {
      await broadcast?.(sync.intentId, {
        action: 'agent.note',
        executionId: sync.executionId,
        intentId: sync.intentId,
        projectId: sync.projectId,
        noteType: type,
        summary,
      });
    } catch {
      // Realtime delivery is best-effort; the persisted event appears on reload.
    }
  };

  const update = (sync, claimId, state, fields = {}) =>
    store.updateTrackerSync({
      executionId: sync.executionId,
      claimId,
      state,
      fields: { lastCheckedAt: clock().toISOString(), ...fields },
    });

  const trackerWriteFailed = async (sync, claimId, error) => {
    const attempts = Number(sync.attempts || 0) + 1;
    const permanent = isPermanentTrackerWriteError(error);
    const blocked = permanent || attempts >= maxTrackerWriteAttempts;
    await update(sync, claimId, blocked ? 'BLOCKED' : sync.state, {
      attempts,
      lastError: sanitizedError(error),
    });
    await emit(
      sync,
      blocked ? 'v2.tracker.blocked' : 'v2.tracker.failed',
      permanent
        ? 'Tracker synchronization stopped after a non-retryable authorization failure'
        : blocked
          ? `Tracker synchronization stopped after ${attempts} failed write attempts`
          : `Tracker write attempt ${attempts} failed`,
    );
    return { blocked, attempts, permanent };
  };

  const ensureComment = async ({ sync, binding, provider, ctx, phrase, body, matchExisting }) => {
    const intentUrl = intentUrlFor(applicationUrl, sync);
    const comments = await provider.getIssueDiscussion(
      ctx,
      binding.externalProjectKey,
      sync.source.resourceId,
    );
    const existing = matchExisting
      ? matchExisting(comments, body, intentUrl)
      : hasDeliveryComment(comments, phrase, intentUrl);
    if (existing) return { existing: true };
    await provider.addIssueComment(ctx, binding.externalProjectKey, sync.source.resourceId, body);
    return { existing: false };
  };

  const processClaimed = async (sync, claimId) => {
    const binding = await resolveBinding(sync.projectId, sync.source.bindingId);
    if (!binding) {
      await update(sync, claimId, 'BLOCKED', {
        lastError: { code: 'TRACKER_BINDING_NOT_FOUND', message: 'Tracker binding not found' },
      });
      await emit(sync, 'v2.tracker.blocked', 'Tracker binding no longer exists');
      return { state: 'BLOCKED' };
    }

    const provider = getTrackerProvider(binding.provider, binding.instance);
    const ctx = trackerContext(sync.projectId, binding);

    if (sync.state === 'PR_CREATED') {
      try {
        await ensureComment({
          sync,
          binding,
          provider,
          ctx,
          phrase: createdPhraseFor(sync),
          body: createdComment(sync, applicationUrl),
        });
      } catch (error) {
        return trackerWriteFailed(sync, claimId, error);
      }
      await update(sync, claimId, 'WAITING_FOR_MERGE', {
        attempts: 0,
        lastError: null,
        createdCommentedAt: clock().toISOString(),
      });
      await emit(sync, 'v2.tracker.commented', 'Added tracker delivery comment');
      return { state: 'WAITING_FOR_MERGE' };
    }

    if (sync.state === 'WAITING_FOR_MERGE') {
      const incompleteIdentity =
        !Array.isArray(sync.pullRequests) ||
        sync.pullRequests.length === 0 ||
        sync.pullRequests.some(
          (pr) => !pr?.provider || !pr?.repoId || pr.prNumber === null || pr.prNumber === undefined,
        );
      if (incompleteIdentity) {
        await update(sync, claimId, 'BLOCKED', {
          lastError: {
            code: 'PR_IDENTITY_INCOMPLETE',
            message: 'One or more final pull request identities are incomplete',
          },
        });
        await emit(
          sync,
          'v2.tracker.blocked',
          'Tracker synchronization stopped because final pull request identity is incomplete',
        );
        return { state: 'BLOCKED' };
      }

      let statuses;
      try {
        statuses = await Promise.all(
          sync.pullRequests.map((pr) =>
            getPullRequestStatus({
              projectId: sync.projectId,
              provider: pr.provider,
              repository: pr.repoId,
              number: pr.prNumber,
            }),
          ),
        );
      } catch (error) {
        await update(sync, claimId, 'WAITING_FOR_MERGE', {
          lastError: sanitizedError(error),
        });
        return { state: 'WAITING_FOR_MERGE', unavailable: true };
      }
      if (statuses.some((status) => !status?.state)) {
        await update(sync, claimId, 'WAITING_FOR_MERGE', {
          lastError: {
            code: 'PR_STATUS_UNAVAILABLE',
            message: 'One or more pull request statuses are unavailable',
          },
        });
        return { state: 'WAITING_FOR_MERGE', unavailable: true };
      }
      if (statuses.some((status) => status.state === 'closed')) {
        await update(sync, claimId, 'BLOCKED', {
          lastError: {
            code: 'PR_CLOSED_WITHOUT_MERGE',
            message: 'A final pull request was closed without merging',
          },
        });
        await emit(
          sync,
          'v2.tracker.blocked',
          'Tracker synchronization stopped because a final pull request was closed',
        );
        return { state: 'BLOCKED' };
      }
      if (statuses.every((status) => status.state === 'merged')) {
        await update(sync, claimId, 'PR_MERGED', {
          attempts: 0,
          lastError: null,
        });
        return { state: 'PR_MERGED' };
      }
      await update(sync, claimId, 'WAITING_FOR_MERGE', { lastError: null });
      return { state: 'WAITING_FOR_MERGE' };
    }

    if (sync.state === 'PR_MERGED') {
      try {
        await ensureComment({
          sync,
          binding,
          provider,
          ctx,
          phrase: mergedPhraseFor(sync),
          body: mergedComment(sync),
          matchExisting: hasMergedDeliveryComment,
        });
        if (typeof provider.closeIssue === 'function') {
          await provider.closeIssue(ctx, binding.externalProjectKey, sync.source.resourceId);
        }
      } catch (error) {
        return trackerWriteFailed(sync, claimId, error);
      }
      await update(sync, claimId, 'COMPLETED', {
        attempts: 0,
        lastError: null,
        mergedCommentedAt: clock().toISOString(),
        closedAt: typeof provider.closeIssue === 'function' ? clock().toISOString() : null,
      });
      await emit(sync, 'v2.tracker.merged_commented', 'Added merged delivery comment');
      if (typeof provider.closeIssue === 'function') {
        await emit(sync, 'v2.tracker.closed', `Closed ${trackerIssueLabel(sync)}`);
      }
      return { state: 'COMPLETED' };
    }

    await update(sync, claimId, 'BLOCKED', {
      lastError: { code: 'INVALID_TRACKER_SYNC_STATE', message: `Unexpected state: ${sync.state}` },
    });
    return { state: 'BLOCKED' };
  };

  const process = async (candidate) => {
    const claimId = ids();
    const claimExpiresAt = new Date(clock().getTime() + CLAIM_LEASE_MS).toISOString();
    const claimed = await store.claimTrackerSync({
      executionId: candidate.executionId,
      claimId,
      claimExpiresAt,
      now: clock().toISOString(),
    });
    if (!claimed) return { claimed: false };
    try {
      return await processClaimed(claimed, claimId);
    } catch (error) {
      // Keep ownership until the short lease expires so another worker cannot overlap this retry.
      await update(claimed, claimId, claimed.state, {
        lastError: sanitizedError(error),
      }).catch(() => {});
      return { state: claimed.state, error: sanitizedError(error) };
    }
  };

  const runScheduled = async ({ limit = 25, concurrency = SCHEDULED_CONCURRENCY } = {}) => {
    const candidates = await store.listTrackerSyncs({ limit });
    const results = await mapWithConcurrency(candidates, concurrency, async (candidate) => {
      try {
        return await process(candidate);
      } catch (error) {
        return { error: sanitizedError(error) };
      }
    });
    return { processed: results.length, results };
  };

  return { process, runScheduled };
};

export {
  CREATED_PHRASE,
  CREATED_TASK_PHRASE,
  MERGED_PHRASE,
  MERGED_MR_PHRASE,
  branchUrlFor,
  createdPhraseFor,
  mergedPhraseFor,
  trackerIssueLabel,
  MAX_TRACKER_WRITE_ATTEMPTS,
  createdComment,
  mergedComment,
  hasDeliveryComment,
  hasMergedDeliveryComment,
  createDeliverySynchronizer,
};
