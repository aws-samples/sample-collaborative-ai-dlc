import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { AlertCircle, CircleDot, CheckCircle2, Loader2, Search } from 'lucide-react';
import { trackersService, type TrackerIssue, type IssuePageResult } from '@/services/trackers';
import { type Sprint } from '@/services/sprints';
import { ApiError } from '@/services/api';
import type { Project, TrackerBinding } from '@/services/projects';
import { getTrackerProvider } from '@/lib/trackerProviders';

// Read-only tracker issue browser for v1 projects. The v1 sprint lifecycle is
// retired, so issues can no longer start sprints — issues that already have a
// sprint keep their "Open sprint" link.
interface Props {
  project: Project;
  binding: TrackerBinding;
  sprints: Sprint[];
}

const PER_PAGE = 30;

interface FormattedError {
  message: string;
  reconnect: boolean;
  notConnected: boolean;
}

const formatErrorDetail = (err: unknown): FormattedError => {
  if (err instanceof ApiError) {
    const reconnect = err.body?.reconnect === true;
    const errorBody = typeof err.body?.error === 'string' ? err.body.error : undefined;
    if (err.status === 429) {
      const retryAfter = typeof err.body?.retryAfter === 'number' ? err.body.retryAfter : null;
      return {
        message: retryAfter
          ? `Rate limit reached. Try again in ${retryAfter}s.`
          : 'Rate limit reached. Try again soon.',
        reconnect: false,
        notConnected: false,
      };
    }
    if (errorBody) {
      return {
        message: errorBody,
        reconnect,
        notConnected: errorBody.toLowerCase().includes('not connected'),
      };
    }
  }
  const message = err instanceof Error ? err.message : 'Failed to load issues';
  return {
    message,
    reconnect: false,
    notConnected: message.toLowerCase().includes('not connected'),
  };
};

export function TrackerIssueListPanel({ project, binding, sprints }: Props) {
  const navigate = useNavigate();
  const [state, setState] = useState<'open' | 'closed'>('open');
  const [searchInput, setSearchInput] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [issues, setIssues] = useState<TrackerIssue[]>([]);
  const [hasNext, setHasNext] = useState(false);
  const [totalCount, setTotalCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorDetail, setErrorDetail] = useState<FormattedError | null>(null);

  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const iteratorRef = useRef<AsyncGenerator<IssuePageResult> | null>(null);

  const chrome = useMemo(() => {
    const meta = getTrackerProvider(binding.provider);
    const Icon = meta.icon;
    return {
      icon: <Icon className="h-4 w-4 text-muted-foreground" />,
      panelTitle: meta.panelTitle,
      resourceLabel: meta.resourceLabel,
    };
  }, [binding.provider]);

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
      if (!append) {
        setError(null);
        setErrorDetail(null);
      }
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
        const detail = formatErrorDetail(err);
        setError(detail.message);
        setErrorDetail(detail);
        if (!append) setIssues([]);
        setHasNext(false);
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [],
  );

  // Reset and reload whenever the binding or filters change.
  useEffect(() => {
    if (!project.id) return;
    const abortController = new AbortController();
    const iter = trackersService.listIssuePages(
      project.id,
      binding.id,
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
  }, [project.id, binding.id, state, debouncedQuery, pullNextPage]);

  const loadMore = useCallback(() => {
    if (loading || loadingMore || !hasNext || !iteratorRef.current) return;
    pullNextPage(iteratorRef.current, true);
  }, [loading, loadingMore, hasNext, pullNextPage]);

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

  // Dedup map keyed on `${binding.id}#${resourceId}` so two trackers under
  // the same project don't collide when their resourceIds happen to match
  // (e.g. PROJ-1 vs OTHER-1).
  const sprintByResource = useMemo(() => {
    const map = new Map<string, Sprint>();
    for (const s of sprints) {
      if (s.tracker?.resourceId) {
        map.set(`${binding.id}#${s.tracker.resourceId}`, s);
      } else if (s.issueNumber && binding.provider === 'github-issues') {
        // Legacy / unmigrated sprints — only collide with github-issues
        // bindings, so the fallback is provider-scoped.
        map.set(`${binding.id}#${s.issueNumber}`, s);
      }
    }
    return map;
  }, [sprints, binding.id, binding.provider]);

  const countLine = (() => {
    if (loading) return null;
    if (issues.length === 0) return null;
    if (totalCount != null) {
      return `Showing ${issues.length} of ${totalCount.toLocaleString()} matches`;
    }
    return `Showing ${issues.length} issue${issues.length === 1 ? '' : 's'}${hasNext ? '+' : ''}`;
  })();

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3 flex-wrap min-h-7">
          <div className="flex items-center gap-2">
            {chrome.icon}
            <CardTitle className="text-sm">{chrome.panelTitle}</CardTitle>
            {binding.displayName && (
              <span className="text-xs text-muted-foreground">{binding.displayName}</span>
            )}
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
        {error ? (
          <div className="flex items-start gap-2 text-sm text-destructive bg-destructive/5 border border-destructive/20 rounded-md p-3">
            <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
            <div className="flex-1">
              <p>
                {errorDetail?.reconnect
                  ? `${chrome.resourceLabel} authentication expired — reconnect to continue.`
                  : error}
              </p>
              {(errorDetail?.notConnected || errorDetail?.reconnect) && (
                <p className="mt-1 text-xs text-muted-foreground">
                  v1 space tracker settings are retired; existing linked sprints remain viewable.
                </p>
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
              const dedupeKey = `${binding.id}#${issue.resourceId}`;
              const existingSprint = sprintByResource.get(dedupeKey);
              return (
                <div
                  key={dedupeKey}
                  className="border rounded-md p-3 flex items-start justify-between gap-3 hover:bg-accent/30 transition-colors"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      {issue.entityType && (
                        <Badge
                          variant="secondary"
                          className="text-[9px] h-4 px-1.5 gap-1 shrink-0"
                          title={`${issue.entityType} (from ${chrome.resourceLabel.replace(/ issue$/, '')})`}
                        >
                          {issue.entityIconUrl && (
                            <img
                              src={issue.entityIconUrl}
                              alt=""
                              className="h-3 w-3"
                              loading="lazy"
                            />
                          )}
                          {issue.entityType}
                        </Badge>
                      )}
                      <a
                        href={issue.resourceUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm font-medium hover:underline truncate"
                      >
                        {/^\d+$/.test(issue.resourceId) ? `#${issue.resourceId}` : issue.resourceId}{' '}
                        {issue.title}
                      </a>
                      {issue.labels.slice(0, 3).map((l) => (
                        <Badge
                          key={l.name}
                          variant="outline"
                          className="text-[9px] h-4 px-1.5"
                          style={
                            l.color
                              ? { borderColor: `#${l.color}`, color: `#${l.color}` }
                              : undefined
                          }
                        >
                          {l.name}
                        </Badge>
                      ))}
                    </div>
                    <p className="text-[11px] text-muted-foreground mt-0.5">
                      Opened by {issue.author.handle} ·{' '}
                      {new Date(issue.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                  {existingSprint && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-1.5 shrink-0"
                      onClick={() => navigate(`/space/${project.id}/sprint/${existingSprint.id}`)}
                    >
                      Open sprint
                    </Button>
                  )}
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
