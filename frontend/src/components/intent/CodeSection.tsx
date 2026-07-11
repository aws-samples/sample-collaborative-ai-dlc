import { AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ExternalLink, GitBranch, GitPullRequest } from 'lucide-react';
import type { IntentDetail } from '@/services/intents';

// The "Code" accordion group on the intent workbench: one entry per repo that
// has real code on the remote (the engine pushed, or a PR opened). A repo shows
// as its intent BRANCH until a PR opens; the PR then adds the number, link and
// the source → target (base) branches. Extracted alongside DocumentsSection /
// DerivedItemsSection so IntentView stays a thin composition layer.

export const CODE_ACCORDION_VALUE = 'code';

export interface CodeItem {
  repo: string;
  branch: string | null;
  baseBranch: string | null;
  branchUrl: string | null;
  prUrl: string | null;
  prNumber: string | null;
}

// Normalize a repo entry (slug or URL) to its "owner/repo" slug so it matches
// the `repository` prop stored on a PR record.
const repoSlug = (r: string) => r.replace(/^https?:\/\/[^/]+\//, '').replace(/\.git$/, '');

// Web link to a branch on the code host. GitHub and GitLab use different paths;
// null when the provider is unknown (older executions) so the UI shows plain text.
const branchWebUrl = (
  provider: string | null | undefined,
  repo: string,
  branch: string,
): string | null => {
  const enc = branch.split('/').map(encodeURIComponent).join('/');
  if (provider === 'gitlab') return `https://gitlab.com/${repo}/-/tree/${enc}`;
  if (provider === 'github') return `https://github.com/${repo}/tree/${enc}`;
  return null;
};

// One entry per repo that has code on the remote (pushed, or a PR opened).
// Before that the branch is local-only and there is nothing to show.
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
          // Base (target) is a PR-only concept — a bare branch has no target.
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

export function CodeSection({ items }: { items: CodeItem[] }) {
  if (items.length === 0) return null;

  return (
    <AccordionItem value={CODE_ACCORDION_VALUE} className="rounded-md border px-3">
      <AccordionTrigger className="py-3 hover:no-underline">
        <div className="flex items-center gap-2">
          <GitPullRequest className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">Code</span>
          <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
            {items.length}
          </Badge>
        </div>
      </AccordionTrigger>
      <AccordionContent className="space-y-1 pb-3">
        {items.map((item) => (
          <div
            key={item.repo}
            className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5"
          >
            <div className="min-w-0 space-y-1">
              <div className="flex items-center gap-2 text-sm font-medium">
                <span className="truncate">{item.repo || 'Repository'}</span>
                {item.prNumber && (
                  <span className="text-muted-foreground">PR #{item.prNumber}</span>
                )}
              </div>
              {item.branch && (
                <p className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
                  <GitBranch className="h-3 w-3 shrink-0" />
                  {item.branchUrl ? (
                    <a
                      href={item.branchUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-mono text-primary hover:underline underline-offset-2"
                    >
                      {item.branch}
                    </a>
                  ) : (
                    <code className="font-mono">{item.branch}</code>
                  )}
                  {item.baseBranch && (
                    <>
                      {' → '}
                      <code className="font-mono">{item.baseBranch}</code>
                    </>
                  )}
                </p>
              )}
            </div>
            {item.prUrl && (
              <Button asChild size="sm" variant="outline" className="shrink-0">
                <a href={item.prUrl} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
                  Open PR
                </a>
              </Button>
            )}
          </div>
        ))}
      </AccordionContent>
    </AccordionItem>
  );
}
