import type { IntentDetail } from '@/services/intents';
import { gitBranchWebUrl, gitProviderForRepo, gitRepoSlug } from '@/services/gitProvider';

// Code-items builder: one entry per repo that has real code on the remote (the
// engine pushed, or a PR opened). Used by ProvenanceTree to render the Code
// branch.

export interface CodeItem {
  repo: string;
  provider: string | null;
  branch: string | null;
  baseBranch: string | null;
  branchUrl: string | null;
  prUrl: string | null;
  prNumber: string | null;
}

export interface UnitBranchTarget {
  repo: string;
  provider: string | null;
  url: string | null;
  prUrl: string | null;
  prNumber: string | number | null;
}

export interface UnitBranchItem {
  sectionIndex: number | null;
  unitSlug: string;
  branch: string | null;
  targets: UnitBranchTarget[];
}

export function buildUnitBranchItems(detail: IntentDetail): UnitBranchItem[] {
  const repos = detail.intent.repos ?? [];
  return (detail.units ?? []).map((unit) => ({
    sectionIndex: unit.sectionIndex ?? null,
    unitSlug: unit.slug,
    branch: unit.branch,
    targets: repos.map((repo) => {
      const slug = gitRepoSlug(repo);
      const unitPr =
        (detail.unitPrs ?? []).find(
          (pr) =>
            pr.unitSlug === unit.slug &&
            (unit.sectionIndex == null || pr.sectionIndex === unit.sectionIndex) &&
            (pr.repository === repo ||
              pr.repository === slug ||
              gitRepoSlug(pr.repository) === slug),
        ) ?? null;
      const provider =
        unitPr?.provider ??
        gitProviderForRepo(repo, detail.intent.gitProvider, detail.intent.repoProviders);
      return {
        repo: slug,
        provider,
        url: unit.branch ? gitBranchWebUrl(provider, repo, unit.branch) : null,
        prUrl: unitPr?.url ?? null,
        prNumber: unitPr?.number ?? null,
      };
    }),
  }));
}

export function buildCodeItems(detail: IntentDetail): CodeItem[] {
  const pushedSummaries = detail.events
    .filter((e) => e.type === 'v2.git.pushed')
    .map((e) => e.summary ?? '');
  const repoPushed = (slug: string) => pushedSummaries.some((s) => s.includes(slug));

  const prByRepo = new Map((detail.pullRequests ?? []).map((pr) => [pr.repository ?? '', pr]));
  return (detail.intent.repos ?? [])
    .map((repo) => {
      const slug = gitRepoSlug(repo);
      const pr = prByRepo.get(slug) ?? prByRepo.get(repo) ?? null;
      const branch = pr?.branch ?? detail.intent.branch;
      const provider = gitProviderForRepo(
        repo,
        detail.intent.gitProvider,
        detail.intent.repoProviders,
      );
      return {
        item: {
          repo: slug,
          provider,
          branch,
          baseBranch: pr?.baseBranch ?? null,
          branchUrl: branch ? gitBranchWebUrl(provider, repo, branch) : null,
          prUrl: pr?.prUrl ?? null,
          prNumber: pr?.prNumber ?? null,
        },
        hasCode: pr != null || repoPushed(slug),
      };
    })
    .filter((x) => x.hasCode)
    .map((x) => x.item);
}
