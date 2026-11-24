// When a run ends, delete the intent's branches from each repository it never
// changed. init-ws publishes the intent branch to every repository of the space
// and lanes publish their unit branches to every repository, so a repository
// the intent never touches is otherwise left with branches that only point at
// commits already on its base branch. The source-control service decides per
// repository (unused-branch-cleanup.js); a repository with any work keeps every
// branch. Best-effort: a failure is logged and never changes the run's outcome.
// A rewind or restart re-creates a missing intent branch (init-ws step 1b).
import { repoProvider } from './repo-provider.js';

// Time kept back from the caller's lease for the provider call in flight: the
// source-control service checks and deletes nothing after `until - margin`, and
// no repository is started after it.
const LEASE_MARGIN_MS = 60_000;

export const deleteUnusedIntentBranches = async ({
  meta,
  operation,
  logger = null,
  until = null,
  now = () => Date.now(),
}) => {
  if (!meta?.branch || !meta.projectId || !Array.isArray(meta.repos)) return [];
  const results = [];
  for (const entry of meta.repos) {
    const repoId = typeof entry === 'string' ? entry : entry?.url;
    if (!repoId) continue;
    if (until != null && now() > until - LEASE_MARGIN_MS) {
      results.push({ repoId, deleted: [], kept: [], error: 'lease_expiring' });
      continue;
    }
    try {
      const result = await operation({
        projectId: meta.projectId,
        provider: repoProvider(repoId, meta.gitProvider, meta.repoProviders),
        repo: repoId,
        operation: 'delete-unused-branches',
        args: {
          branch: meta.branch,
          baseBranch: meta.baseBranches?.[repoId] ?? meta.baseBranch ?? null,
          ...(until != null ? { deadline: until - LEASE_MARGIN_MS } : {}),
        },
      });
      results.push({
        repoId,
        deleted: result?.deleted ?? [],
        kept: result?.kept ?? [],
      });
    } catch (error) {
      results.push({ repoId, deleted: [], kept: [], error: error?.code ?? 'cleanup_failed' });
    }
  }
  // Why each branch was kept, so a refused delete (say a 403) can be traced.
  logger?.info?.('unused intent branch cleanup', {
    executionId: meta.executionId,
    deleted: results.reduce((n, r) => n + r.deleted.length, 0),
    kept: results.flatMap((r) => r.kept.map((k) => ({ repoId: r.repoId, ...k }))),
    failedRepositories: results
      .filter((r) => r.error)
      .map((r) => ({ repoId: r.repoId, error: r.error })),
  });
  return results;
};

// Repositories whose branches were all deleted, for a timeline summary.
export const cleanupSummary = (results) => {
  const cleaned = results.filter((r) => r.deleted.length && !r.kept.length && !r.error);
  if (!cleaned.length) return null;
  return `Deleted the unused intent branch from ${cleaned.length} unchanged ${
    cleaned.length === 1 ? 'repository' : 'repositories'
  }: ${cleaned.map((r) => r.repoId).join(', ')}`;
};
