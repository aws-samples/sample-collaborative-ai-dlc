import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { AlertCircle, CircleDot, CheckCircle2, Loader2, Play, Search } from 'lucide-react';
import {
  githubIssuesService,
  type GitHubIssue,
  type GitHubIssueComment,
  type IssuePageResult,
} from '@/services/githubIssues';
import { sprintsService, type Sprint } from '@/services/sprints';
import { ApiError } from '@/services/api';
import type { Project } from '@/services/projects';

interface Props {
  project: Project;
  sprints: Sprint[];
  onSprintCreated: (sprint: Sprint) => void;
}

const PER_PAGE = 30;

// Simple Icons GitHub mark — https://simpleicons.org/?q=github (CC0)
const GitHubIcon = ({ className }: { className?: string }) => (
  <svg
    role="img"
    viewBox="0 0 24 24"
    xmlns="http://www.w3.org/2000/svg"
    aria-label="GitHub"
    className={className}
    fill="currentColor"
  >
    <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
  </svg>
);

const parseRepo = (gitRepo: string): { owner: string; repo: string } | null => {
  const parts = gitRepo.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  return { owner: parts[0], repo: parts[1] };
};

const buildSprintDescription = (issue: GitHubIssue, comments: GitHubIssueComment[]) => {
  const head = `# ${issue.title}\n\n${issue.body ?? ''}`.trimEnd();
  if (comments.length === 0) return head;
  const formatted = comments
    .map((c) => {
      const when = new Date(c.createdAt).toISOString().split('T')[0];
      return `### @${c.user.login} — ${when}\n\n${c.body.trim()}`;
    })
    .join('\n\n');
  return `${head}\n\n---\n\n## Discussion (${comments.length} comment${comments.length === 1 ? '' : 's'})\n\n${formatted}`;
};

const formatError = (err: unknown): string => {
  if (err instanceof ApiError) {
    if (err.status === 429) {
      const retryAfter = typeof err.body?.retryAfter === 'number' ? err.body.retryAfter : null;
      return retryAfter
        ? `GitHub rate limit reached. Try again in ${retryAfter}s.`
        : 'GitHub rate limit reached. Try again soon.';
    }
    if (typeof err.body?.error === 'string') return err.body.error;
  }
  return err instanceof Error ? err.message : 'Failed to load issues';
};

export function IssueListPanel({ project, sprints, onSprintCreated }: Props) {
  const navigate = useNavigate();
  const [state, setState] = useState<'open' | 'closed'>('open');
  const [searchInput, setSearchInput] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [issues, setIssues] = useState<GitHubIssue[]>([]);
  const [hasNext, setHasNext] = useState(false);
  const [totalCount, setTotalCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [startingNumber, setStartingNumber] = useState<number | null>(null);

  const repoInfo = useMemo(() => parseRepo(project.gitRepo), [project.gitRepo]);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const iteratorRef = useRef<AsyncGenerator<IssuePageResult> | null>(null);

  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => setDebouncedQuery(searchInput.trim()), 300);
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, [searchInput]);

  const pullNextPage = useCallback(
    async (iter: AsyncGenerator<IssuePageResult>, append: boolean) => {
      if (append) setLoadingMore(true);
      else setLoading(true);
      if (!append) setError(null);
      try {
        const { value, done } = await iter.next();
        if (done || !value) {
          setHasNext(false);
          return;
        }
        setIssues((prev) => (append ? [...prev, ...value.items] : value.items));
        setHasNext(!value.done);
        setTotalCount(value.totalCount);
      } catch (err) {
        setError(formatError(err));
        if (!append) setIssues([]);
        setHasNext(false);
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [],
  );

  // Reset and reload whenever filters change
  useEffect(() => {
    if (!repoInfo) return;
    const abortController = new AbortController();
    const iter = githubIssuesService.listPages(
      repoInfo.owner,
      repoInfo.repo,
      state,
      debouncedQuery || undefined,
      PER_PAGE,
      abortController.signal,
    );
    iteratorRef.current = iter;
    setIssues([]);
    setHasNext(false);
    setTotalCount(null);
    pullNextPage(iter, false);
    return () => {
      abortController.abort();
      iteratorRef.current = null;
    };
  }, [repoInfo, state, debouncedQuery, pullNextPage]);

  const loadMore = useCallback(() => {
    if (loading || loadingMore || !hasNext || !iteratorRef.current) return;
    pullNextPage(iteratorRef.current, true);
  }, [loading, loadingMore, hasNext, pullNextPage]);

  // IntersectionObserver-driven auto-load
  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || !hasNext) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) loadMore();
      },
      { rootMargin: '200px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasNext, loadMore]);

  const sprintByIssue = useMemo(() => {
    const map = new Map<string, Sprint>();
    for (const s of sprints) {
      if (s.issueNumber) map.set(s.issueNumber, s);
    }
    return map;
  }, [sprints]);

  const handleStartSprint = async (issue: GitHubIssue) => {
    if (!project.id || !repoInfo) return;
    const existing = sprintByIssue.get(String(issue.number));
    if (existing) {
      navigate(`/project/${project.id}/sprint/${existing.id}`);
      return;
    }
    setStartingNumber(issue.number);
    setWarning(null);
    try {
      let comments: GitHubIssueComment[] = [];
      try {
        comments = await githubIssuesService.listComments(
          repoInfo.owner,
          repoInfo.repo,
          issue.number,
        );
      } catch (err) {
        setWarning(
          `Couldn't load issue comments — sprint created from issue body only. (${formatError(err)})`,
        );
      }
      const sprint = await sprintsService.create(project.id, {
        name: issue.title,
        description: buildSprintDescription(issue, comments),
        issueNumber: issue.number,
        issueUrl: issue.htmlUrl,
      });
      onSprintCreated(sprint);
      navigate(`/project/${project.id}/sprint/${sprint.id}`);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setStartingNumber(null);
    }
  };

  if (!repoInfo) {
    return (
      <Card className="border-dashed mt-6">
        <CardContent className="p-4 text-sm text-muted-foreground">
          Issue integration is enabled, but the project's git repository is not in{' '}
          <code className="font-mono">owner/repo</code> format.
        </CardContent>
      </Card>
    );
  }

  const countLine = (() => {
    if (loading) return null;
    if (issues.length === 0) return null;
    if (totalCount != null) {
      return `Showing ${issues.length} of ${totalCount.toLocaleString()} matches`;
    }
    return `Showing ${issues.length} issue${issues.length === 1 ? '' : 's'}${hasNext ? '+' : ''}`;
  })();

  return (
    <Card className="mt-6">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <GitHubIcon className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-sm">Start a sprint from a GitHub issue</CardTitle>
            <span className="text-xs text-muted-foreground">
              {repoInfo.owner}/{repoInfo.repo}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center border rounded-md text-xs">
              <Button
                variant={state === 'open' ? 'secondary' : 'ghost'}
                size="sm"
                className="h-7 rounded-r-none gap-1"
                onClick={() => setState('open')}
              >
                <CircleDot className="h-3 w-3" /> Open
              </Button>
              <Button
                variant={state === 'closed' ? 'secondary' : 'ghost'}
                size="sm"
                className="h-7 rounded-l-none gap-1"
                onClick={() => setState('closed')}
              >
                <CheckCircle2 className="h-3 w-3" /> Closed
              </Button>
            </div>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder="Search issues..."
                className="pl-8 h-7 w-48 text-xs"
              />
            </div>
          </div>
        </div>
        {countLine && <p className="text-[11px] text-muted-foreground mt-2">{countLine}</p>}
      </CardHeader>
      <CardContent className="pt-0">
        {warning && (
          <div className="flex items-start gap-2 text-xs text-muted-foreground bg-muted/40 border rounded-md p-2 mb-2">
            <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <p className="flex-1">{warning}</p>
            <button
              type="button"
              className="text-xs hover:underline"
              onClick={() => setWarning(null)}
            >
              Dismiss
            </button>
          </div>
        )}
        {error ? (
          <div className="flex items-start gap-2 text-sm text-destructive bg-destructive/5 border border-destructive/20 rounded-md p-3">
            <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
            <div className="flex-1">
              <p>{error}</p>
              {error.toLowerCase().includes('not connected') && (
                <Button
                  variant="link"
                  size="sm"
                  className="h-auto p-0 text-xs"
                  onClick={() => navigate(`/project/${project.id}/settings`)}
                >
                  Connect GitHub in project settings
                </Button>
              )}
            </div>
          </div>
        ) : loading ? (
          <div className="space-y-2">
            {[1, 2, 3].map((i) => (
              <div key={i} className="border rounded-md p-3">
                <Skeleton className="h-4 w-2/3 mb-2" />
                <Skeleton className="h-3 w-1/3" />
              </div>
            ))}
          </div>
        ) : issues.length === 0 ? (
          <p className="text-xs text-muted-foreground py-4 text-center">
            {debouncedQuery ? (
              <>
                No {state} issues match "{debouncedQuery}".{' '}
                <button
                  type="button"
                  className="underline hover:no-underline"
                  onClick={() => setSearchInput('')}
                >
                  Clear search
                </button>
                .
              </>
            ) : (
              `No ${state} issues.`
            )}
          </p>
        ) : (
          <div className="space-y-2">
            {issues.map((issue) => {
              const existingSprint = sprintByIssue.get(String(issue.number));
              const isStarting = startingNumber === issue.number;
              return (
                <div
                  key={issue.number}
                  className="border rounded-md p-3 flex items-start justify-between gap-3 hover:bg-accent/30 transition-colors"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <a
                        href={issue.htmlUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm font-medium hover:underline truncate"
                      >
                        #{issue.number} {issue.title}
                      </a>
                      {issue.labels.slice(0, 3).map((l) => (
                        <Badge
                          key={l.name}
                          variant="outline"
                          className="text-[9px] h-4 px-1.5"
                          style={{ borderColor: `#${l.color}`, color: `#${l.color}` }}
                        >
                          {l.name}
                        </Badge>
                      ))}
                    </div>
                    <p className="text-[11px] text-muted-foreground mt-0.5">
                      Opened by {issue.user.login} ·{' '}
                      {new Date(issue.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant={existingSprint ? 'outline' : 'default'}
                    className="gap-1.5 shrink-0"
                    onClick={() => handleStartSprint(issue)}
                    disabled={isStarting}
                  >
                    {isStarting ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Play className="h-3.5 w-3.5" />
                    )}
                    {existingSprint ? 'Open sprint' : 'Start sprint'}
                  </Button>
                </div>
              );
            })}

            {hasNext && (
              <div ref={sentinelRef} className="pt-2 flex justify-center">
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  onClick={loadMore}
                  disabled={loadingMore}
                >
                  {loadingMore && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  {loadingMore ? 'Loading...' : 'Load more'}
                </Button>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
