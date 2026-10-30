import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  AlertCircle,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  CornerDownRight,
  ListTree,
  Loader2,
  Search,
} from 'lucide-react';
import {
  trackersService,
  type IssuePageResult,
  type IssueStateFilter,
  type TrackerIssue,
  type TrackerIssueType,
} from '@/services/trackers';
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

// Jira projects define their own issue types (Spike, Defect, Initiative,
// Idea, ...), so the type filter lists what the bound project has,
// loaded with the first page. Hierarchy levels: 2+ Initiative and above,
// 1 Epic, 0 Story/Task/Bug/Idea, -1 Sub-task.
const levelLabel = (t: TrackerIssueType) =>
  t.subtask || t.hierarchyLevel < 0
    ? 'Sub-task level'
    : t.hierarchyLevel >= 1
      ? 'Parent level'
      : 'Standard';

// One step of a drill-down: the issue whose children (or linked items) are shown.
interface Crumb {
  resourceId: string;
  title: string;
}

const STATE_LABEL: Record<IssueStateFilter, string> = {
  open: 'open',
  closed: 'closed',
  all: '',
};

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

  const [state, setState] = useState<IssueStateFilter>('open');
  const [jiraType, setJiraType] = useState('');
  const isJira = binding?.provider === 'jira-cloud';
  // Issue types and project type of the bound Jira project, keyed by binding.
  const [projectInfo, setProjectInfo] = useState<{
    bindingId: string;
    issueTypes: TrackerIssueType[];
    projectTypeKey: string | null;
  } | null>(null);
  const issueTypes = useMemo(
    () => (projectInfo?.bindingId === binding?.id ? projectInfo.issueTypes : []),
    [projectInfo, binding?.id],
  );
  const isDiscovery =
    projectInfo?.bindingId === binding?.id && projectInfo.projectTypeKey === 'product_discovery';
  // Drill-down trail: [] is the whole project; the last entry is being browsed.
  const [trail, setTrail] = useState<Crumb[]>([]);
  const parentKey = trail.at(-1)?.resourceId;
  // Linked items sit in other projects with their own types, so no Type filter.
  const showTypeFilter = isJira && !(isDiscovery && trail.length > 0);
  // 'all', types and drill-down only exist for Jira; don't send them elsewhere.
  const effectiveState: IssueStateFilter = !isJira && state === 'all' ? 'open' : state;
  const effectiveType = showTypeFilter && jiraType ? jiraType : undefined;
  const effectiveParent = isJira ? parentKey : undefined;
  const [searchInput, setSearchInput] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [issues, setIssues] = useState<TrackerIssue[]>([]);
  const [hasNext, setHasNext] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sentinelRef = useRef<HTMLDivElement | null>(null);
  // The current request and the binding it is for. A response from any other
  // iterator is superseded and dropped.
  const requestRef = useRef<{
    iter: AsyncGenerator<IssuePageResult>;
    bindingId: string;
  } | null>(null);

  // A new binding starts at the top level with no type filter.
  useEffect(() => {
    setTrail([]);
    setJiraType('');
  }, [binding?.id]);

  const typeByName = useMemo(() => new Map(issueTypes.map((t) => [t.name, t])), [issueTypes]);
  // Software projects nest through the parent field, so anything above
  // sub-task level can have children. Discovery items are joined by links.
  const canDrill = (issue: TrackerIssue) => {
    if (!isJira) return false;
    if (isDiscovery) return true;
    const t = issue.entityType ? typeByName.get(issue.entityType) : undefined;
    return !!t && !t.subtask && t.hierarchyLevel >= 0;
  };
  const drillLabel = isDiscovery ? 'Linked items' : 'Children';
  // The type and search that found the parent would hide its children
  // (type=Epic AND parent=PROJ-5 is empty), so they are cleared.
  const drillInto = (issue: TrackerIssue) => {
    setTrail([...trail, { resourceId: issue.resourceId, title: issue.title }]);
    setJiraType('');
    setSearchInput('');
    setDebouncedQuery('');
  };

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
    async (
      request: { iter: AsyncGenerator<IssuePageResult>; bindingId: string },
      append: boolean,
    ) => {
      const current = () => requestRef.current === request;
      if (append) setLoadingMore(true);
      else {
        setLoading(true);
        setError(null);
      }
      try {
        const { value, done } = await request.iter.next();
        if (!current()) return;
        if (done || !value) {
          setHasNext(false);
          return;
        }
        setIssues((prev) => (append ? [...prev, ...value.items] : value.items));
        setHasNext(!value.done);
        if (value.issueTypes) {
          setProjectInfo({
            bindingId: request.bindingId,
            issueTypes: value.issueTypes,
            projectTypeKey: value.projectTypeKey ?? null,
          });
        }
      } catch (err) {
        if (!current()) return;
        setError(formatError(err));
        if (!append) setIssues([]);
        setHasNext(false);
      } finally {
        if (current()) {
          setLoading(false);
          setLoadingMore(false);
        }
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
      effectiveState,
      debouncedQuery || undefined,
      PER_PAGE,
      abortController.signal,
      isJira ? { type: effectiveType, parent: effectiveParent, withTypes: true } : {},
    );
    const request = { iter, bindingId: binding.id };
    requestRef.current = request;
    setIssues([]);
    setHasNext(false);
    pullNextPage(request, false);
    return () => {
      abortController.abort();
      if (requestRef.current === request) requestRef.current = null;
    };
  }, [
    project.id,
    binding,
    isJira,
    effectiveState,
    effectiveType,
    effectiveParent,
    debouncedQuery,
    pullNextPage,
  ]);

  const loadMore = useCallback(() => {
    if (loading || loadingMore || !hasNext || !requestRef.current) return;
    pullNextPage(requestRef.current, true);
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
    return <p className="text-xs text-muted-foreground">No tracker connected for this space.</p>;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col space-y-2">
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
            className={cn('h-7 gap-1', isJira ? 'rounded-none' : 'rounded-l-none')}
            onClick={() => setState('closed')}
          >
            <CheckCircle2 className="h-3 w-3" /> Closed
          </Button>
          {isJira && (
            <Button
              type="button"
              variant={state === 'all' ? 'secondary' : 'ghost'}
              size="sm"
              className="h-7 rounded-l-none"
              onClick={() => setState('all')}
            >
              All
            </Button>
          )}
        </div>
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder={
              isJira
                ? `Search ${chrome.resourceLabel}s or type a key…`
                : `Search ${chrome.resourceLabel}s…`
            }
            aria-label={`Search ${chrome.resourceLabel}s`}
            className="pl-8 h-7 text-xs"
          />
        </div>
      </div>

      {isJira && (
        <div className="flex items-center gap-2 flex-wrap">
          {showTypeFilter && (
            <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              Type
              <select
                value={jiraType}
                onChange={(e) => setJiraType(e.target.value)}
                className="h-7 rounded-md border bg-background px-2 text-xs text-foreground"
                aria-label="Issue type"
              >
                <option value="">All types</option>
                {(['Parent level', 'Standard', 'Sub-task level'] as const).map((group) => {
                  const inGroup = issueTypes.filter((t) => levelLabel(t) === group);
                  return inGroup.length === 0 ? null : (
                    <optgroup key={group} label={group}>
                      {inGroup.map((t) => (
                        <option key={t.name} value={t.name}>
                          {t.name}
                        </option>
                      ))}
                    </optgroup>
                  );
                })}
              </select>
            </label>
          )}
          {trail.length > 0 && (
            <nav aria-label="Hierarchy" className="flex items-center gap-1 text-[11px] flex-wrap">
              <button
                type="button"
                className="text-primary hover:underline"
                onClick={() => setTrail([])}
              >
                All
              </button>
              {trail.map((c, i) => (
                <span key={c.resourceId} className="flex items-center gap-1">
                  <ChevronRight className="h-3 w-3 text-muted-foreground" aria-hidden />
                  {i === trail.length - 1 ? (
                    <span aria-current="location" className="font-medium" title={c.title}>
                      {c.resourceId}
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="text-primary hover:underline"
                      title={c.title}
                      onClick={() => setTrail(trail.slice(0, i + 1))}
                    >
                      {c.resourceId}
                    </button>
                  )}
                </span>
              ))}
              <span className="text-muted-foreground">
                · {isDiscovery ? 'linked items' : 'children'}
              </span>
            </nav>
          )}
        </div>
      )}

      <div className="max-h-64 min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-0.5 lg:max-h-none lg:basis-0">
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
            {(() => {
              const noun = [STATE_LABEL[effectiveState], effectiveType, 'issues']
                .filter(Boolean)
                .join(' ');
              return debouncedQuery ? `No ${noun} match "${debouncedQuery}".` : `No ${noun}.`;
            })()}
          </p>
        ) : (
          <>
            {issues.map((issue) => {
              const isSelected =
                selected?.bindingId === binding.id && selected?.resourceId === issue.resourceId;
              return (
                <div
                  key={`${binding.id}#${issue.resourceId}`}
                  className={cn(
                    'flex items-stretch border rounded-md transition-colors',
                    isSelected && 'border-primary bg-primary/[0.04] ring-1 ring-primary/30',
                  )}
                >
                  <button
                    type="button"
                    onClick={() => onSelect(issue, binding)}
                    aria-pressed={isSelected}
                    className="flex-1 min-w-0 text-left p-2.5 rounded-md hover:bg-accent/40"
                  >
                    <div className="flex items-center gap-2 flex-wrap">
                      {issue.entityIconUrl && (
                        <img src={issue.entityIconUrl} alt="" className="h-3.5 w-3.5 shrink-0" />
                      )}
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
                    {issue.parent && !parentKey && (
                      <p className="text-[11px] text-muted-foreground mt-0.5 flex items-center gap-1 min-w-0">
                        <CornerDownRight className="h-3 w-3 shrink-0" aria-hidden />
                        <span className="truncate">
                          {issue.parent.entityType ? `${issue.parent.entityType} ` : ''}
                          {issue.parent.resourceId} {issue.parent.title}
                        </span>
                      </p>
                    )}
                    <p className="text-[11px] text-muted-foreground mt-0.5">
                      Opened by {issue.author.handle} ·{' '}
                      {new Date(issue.createdAt).toLocaleDateString()}
                    </p>
                  </button>
                  {canDrill(issue) && (
                    <button
                      type="button"
                      onClick={() => drillInto(issue)}
                      className="shrink-0 px-2.5 border-l text-[11px] text-muted-foreground hover:text-foreground hover:bg-accent/40 rounded-r-md flex flex-col items-center justify-center gap-0.5"
                      aria-label={`${drillLabel} of ${issue.resourceId}`}
                      title={`${drillLabel} of ${issue.resourceId}`}
                    >
                      <ListTree className="h-3.5 w-3.5" aria-hidden />
                      {drillLabel}
                    </button>
                  )}
                </div>
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
