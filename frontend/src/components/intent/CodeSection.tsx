import type { IntentDetail } from '@/services/intents';

// Code-items builder: one entry per repo that has real code on the remote (the
// engine pushed, or a PR opened). Used by ProvenanceTree to render the Code
// branch.

export interface CodeItem {
  repo: string;
  branch: string | null;
  baseBranch: string | null;
  branchUrl: string | null;
  prUrl: string | null;
  prNumber: string | null;
}

const repoSlug = (r: string) => r.replace(/^https?:\/\/[^/]+\//, '').replace(/\.git$/, '');

const branchWebUrl = (
  provider: string | null | undefined,
  repo: string,
  branch: string,
): string | null => {
  const enc = branch.split('/').map(encodeURIComponent).join('/');
  if (provider === 'gitlab') return `https://gitlab.com/${repo}/-/tree/${enc}`;
  if (provider === 'github') return `https://github.com/${repo}/tree/${enc}`;
  if (provider === 'bitbucket') return `https://bitbucket.org/${repo}/src/${enc}`;
  return null;
};

export function buildCodeItems(detail: IntentDetail): CodeItem[] {
  const pushedSummaries = detail.events
    .filter((e) => e.type === 'v2.git.pushed')
    .map((e) => e.summary ?? '');
  const repoPushed = (slug: string) => pushedSummaries.some((s) => s.includes(slug));

  const prByRepo = new Map((detail.pullRequests ?? []).map((pr) => [pr.repository ?? '', pr]));
  return (detail.intent.repos ?? [])
    .map((repo) => {
      const slug = repoSlug(repo);
      const pr = prByRepo.get(slug) ?? prByRepo.get(repo) ?? null;
      const branch = pr?.branch ?? detail.intent.branch;
      return {
        item: {
          repo: slug,
          branch,
          baseBranch: pr?.baseBranch ?? null,
          branchUrl: branch ? branchWebUrl(detail.intent.gitProvider, slug, branch) : null,
          prUrl: pr?.prUrl ?? null,
          prNumber: pr?.prNumber ?? null,
        },
        hasCode: pr != null || repoPushed(slug),
      };
    })
    .filter((x) => x.hasCode)
    .map((x) => x.item);
}
