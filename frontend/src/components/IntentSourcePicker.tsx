import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { AlertCircle, CheckCircle2, CircleDot, Loader2, Search } from 'lucide-react';
import { trackersService, type IssuePageResult, type TrackerIssue } from '@/services/trackers';
import { ApiError } from '@/services/api';
import type { Project, TrackerBinding } from '@/services/projects';
import { getTrackerProvider } from '@/lib/trackerProviders';
import { cn } from '@/lib/utils';

interface Props {
  project: Project;
  // The currently picked issue (so the row can render a selected state). The
  // binding is tracked alongside because resourceIds aren't unique across
  // bindings (PROJ-1 vs OTHER-1).
  selected: { bindingId: string; resourceId: string } | null;
  onSelect: (issue: TrackerIssue, binding: TrackerBinding) => void;
}

const PER_PAGE = 30;

const formatError = (err: unknown): string => {
  if (err instanceof ApiError) {
    if (err.status === 429) return 'Rate limit reached. Try again soon.';
    if (typeof err.body?.error === 'string') return err.body.error;
  }
  return err instanceof Error ? err.message : 'Failed to load issues';
};

// Embeddable tracker-issue picker for seeding a v2 intent. Mirrors
// TrackerIssueListPanel's binding-tabs + search + infinite-scroll pattern but
// returns the chosen issue via onSelect instead of starting a sprint.
export function IntentSourcePicker({ project, selected, onSelect }: Props) {
  const trackers = project.trackers;
  const [bindingId, setBindingId] = useState(trackers[0]?.id ?? '');
  const binding = useMemo(
    () => trackers.find((t) => t.id === bindingId) ?? trackers[0],
    [trackers, bindingId],
  );

  const [state, setState] = useState<'open' | 'closed'>('open');
  const [searchInput, setSearchInput] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [issues, setIssues] = useState<TrackerIssue[]>([]);
  const [hasNext, setHasNext] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const iteratorRef = useRef<AsyncGenerator<IssuePageResult> | null>(null);

  const chrome = useMemo(() => {
    if (!binding) return null;
    const meta = getTrackerProvider(binding.provider);
    return { resourceLabel: meta.resourceLabel };
  }, [binding]);

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
      else {
        setLoading(true);
        setError(null);
      }
      try {
        const { value, done } = await iter.next();
        if (done || !value) {
          setHasNext(false);
          return;
        }
        setIssues((prev) => (append ? [...prev, ...value.items] : value.items));
        setHasNext(!value.done);
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

  useEffect(() => {
    if (!project.id || !binding) return;
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
    pullNextPage(iter, false);
    return () => {
      abortController.abort();
      iteratorRef.current = null;
    };
  }, [project.id, binding, state, debouncedQuery, pullNextPage]);

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
      { rootMargin: '120px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasNext, loadMore]);

  if (!binding || !chrome) {
    return <p className="text-xs text-muted-foreground">No tracker connected for this project.</p>;
  }

  return (
    <div className="space-y-2">
      {/* Binding tabs — only when the project has more than one tracker. */}
      {trackers.length > 1 && (
        <div className="flex items-center gap-1 border-b">
          {trackers.map((b) => {
            const meta = getTrackerProvider(b.provider);
            const label = b.displayName || b.externalProjectKey || meta.tabLabel;
            return (
              <button
                key={b.id}
                type="button"
                onClick={() => setBindingId(b.id)}
                className={cn(
                  'px-3 py-1.5 text-xs border-b-2 -mb-px transition-colors',
                  b.id === binding.id
                    ? 'border-primary text-foreground font-medium'
                    : 'border-transparent text-muted-foreground hover:text-foreground',
                )}
              >
                <span className="text-muted-foreground mr-1.5">{meta.tabLabel}</span>
                {label}
              </button>
            );
          })}
        </div>
      )}

      <div className="flex items-center gap-2">
        <div className="flex items-center border rounded-md text-xs">
          <Button
            type="button"
            variant={state === 'open' ? 'secondary' : 'ghost'}
            size="sm"
            className="h-7 rounded-r-none gap-1"
            onClick={() => setState('open')}
          >
            <CircleDot className="h-3 w-3" /> Open
          </Button>
          <Button
            type="button"
            variant={state === 'closed' ? 'secondary' : 'ghost'}
            size="sm"
            className="h-7 rounded-l-none gap-1"
            onClick={() => setState('closed')}
          >
            <CheckCircle2 className="h-3 w-3" /> Closed
          </Button>
        </div>
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder={`Search ${chrome.resourceLabel}s…`}
            className="pl-8 h-7 text-xs"
          />
        </div>
      </div>

      <div className="max-h-64 overflow-y-auto space-y-1.5 pr-0.5">
        {error ? (
          <div className="flex items-start gap-2 text-xs text-destructive bg-destructive/5 border border-destructive/20 rounded-md p-2.5">
            <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <p>{error}</p>
          </div>
        ) : loading ? (
          <div className="space-y-1.5">
            {[1, 2, 3].map((i) => (
              <div key={i} className="border rounded-md p-2.5">
                <Skeleton className="h-3.5 w-2/3 mb-1.5" />
                <Skeleton className="h-3 w-1/3" />
              </div>
            ))}
          </div>
        ) : issues.length === 0 ? (
          <p className="text-xs text-muted-foreground py-4 text-center">
            {debouncedQuery
              ? `No ${state} issues match "${debouncedQuery}".`
              : `No ${state} issues.`}
          </p>
        ) : (
          <>
            {issues.map((issue) => {
              const isSelected =
                selected?.bindingId === binding.id && selected?.resourceId === issue.resourceId;
              return (
                <button
                  key={`${binding.id}#${issue.resourceId}`}
                  type="button"
                  onClick={() => onSelect(issue, binding)}
                  className={cn(
                    'w-full text-left border rounded-md p-2.5 transition-colors hover:bg-accent/40',
                    isSelected && 'border-primary bg-primary/[0.04] ring-1 ring-primary/30',
                  )}
                >
                  <div className="flex items-center gap-2 flex-wrap">
                    {issue.entityType && (
                      <Badge variant="secondary" className="text-[9px] h-4 px-1.5">
                        {issue.entityType}
                      </Badge>
                    )}
                    <span className="text-sm font-medium truncate">
                      {/^\d+$/.test(issue.resourceId) ? `#${issue.resourceId}` : issue.resourceId}{' '}
                      {issue.title}
                    </span>
                    {isSelected && <CheckCircle2 className="h-3.5 w-3.5 text-primary shrink-0" />}
                  </div>
                  <p className="text-[11px] text-muted-foreground mt-0.5">
                    Opened by {issue.author.handle} ·{' '}
                    {new Date(issue.createdAt).toLocaleDateString()}
                  </p>
                </button>
              );
            })}
            {hasNext && (
              <div ref={sentinelRef} className="pt-1 flex justify-center">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="gap-1.5 h-7"
                  onClick={loadMore}
                  disabled={loadingMore}
                >
                  {loadingMore && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  {loadingMore ? 'Loading…' : 'Load more'}
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
