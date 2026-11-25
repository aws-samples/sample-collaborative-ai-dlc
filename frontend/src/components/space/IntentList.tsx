import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpDown, Search } from 'lucide-react';
import type { Intent } from '@/services/intents';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Disclosure } from '@/components/ui/disclosure';
import { EmptyState } from '@/components/ui/empty-state';
import { useOfferIdleCandidates } from '@/hooks/useIdleNext';
import { cn } from '@/lib/utils';
import { IntentRow } from './IntentRow';
import {
  INTENT_SORT_LABELS,
  SPACE_FILTER_LABELS,
  intentGroup,
  matchesIntentQuery,
  matchesSpaceFilter,
  needsAttention,
  orderIntents,
  type IntentSort,
  type SpaceFilter,
} from './intentGrouping';

const INTENT_SORT_KEY = 'aidlc.intentSort';
const IDLE_PREFETCH_MAX = 2;
const SORT_OPTIONS: readonly IntentSort[] = ['attention', 'updated', 'created', 'title'];
const FILTER_CHIPS: readonly SpaceFilter[] = ['all', 'active', 'needs-attention', 'finished'];

function loadIntentSort(): IntentSort {
  try {
    const value = localStorage.getItem(INTENT_SORT_KEY);
    return SORT_OPTIONS.includes(value as IntentSort) ? (value as IntentSort) : 'attention';
  } catch {
    return 'attention';
  }
}

function saveIntentSort(value: IntentSort): void {
  try {
    localStorage.setItem(INTENT_SORT_KEY, value);
  } catch {
    /* persistence is best-effort */
  }
}

// The first rows waiting for a person that scroll into view are offered to the
// shell's idle next-page pass (useIdleNext), which owns the budget and gates.
function useIdleCandidateRows(projectId: string, enabled: boolean) {
  const listRef = useRef<HTMLUListElement>(null);
  const [hrefs, setHrefs] = useState<string[]>([]);
  useEffect(() => {
    setHrefs([]);
    const list = listRef.current;
    if (!enabled || !list || typeof IntersectionObserver === 'undefined') return;
    const candidates = list.querySelectorAll<HTMLElement>('li[data-group-attention]');
    if (candidates.length === 0) return;
    const seen: string[] = [];
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (seen.length === IDLE_PREFETCH_MAX) break;
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        const href = entry.target.querySelector('a[href]')?.getAttribute('href');
        if (href && !seen.includes(href)) seen.push(href);
      }
      setHrefs([...seen]);
      if (seen.length === IDLE_PREFETCH_MAX) observer.disconnect();
    });
    candidates.forEach((candidate) => observer.observe(candidate));
    return () => observer.disconnect();
  }, [projectId, enabled]);
  useOfferIdleCandidates('page', hrefs);
  return listRef;
}

export interface IntentListProps {
  projectId: string;
  intents: readonly Intent[];
  filter: SpaceFilter;
  onFilterChange: (filter: SpaceFilter) => void;
  rowActions?: (intent: Intent) => React.ReactNode;
  deletingId?: string | null;
  /** The "New intent" button shown when nothing is live (finished rows stay listed below). */
  idleAction?: React.ReactNode;
  now?: number;
}

export function IntentList({
  projectId,
  intents,
  filter,
  onFilterChange,
  rowActions,
  deletingId,
  idleAction,
  now = Date.now(),
}: IntentListProps) {
  const [sort, setSort] = useState<IntentSort>(loadIntentSort);
  const [query, setQuery] = useState('');
  const changeSort = useCallback((value: string) => {
    if (!SORT_OPTIONS.includes(value as IntentSort)) return;
    setSort(value as IntentSort);
    saveIntentSort(value as IntentSort);
  }, []);

  const counts = useMemo(() => {
    const tally = { all: 0, active: 0, 'needs-attention': 0, failed: 0, finished: 0 };
    for (const intent of intents) {
      tally.all += 1;
      const group = intentGroup(intent, now);
      if (group === 'attention' || group === 'active') tally.active += 1;
      if (needsAttention(intent, now)) tally['needs-attention'] += 1;
      if (group === 'failed') tally.failed += 1;
      if (group === 'finished') tally.finished += 1;
    }
    return tally;
  }, [intents, now]);

  const { visible, finished } = useMemo(() => {
    const matching = orderIntents(intents, sort, now).filter(
      (intent) => matchesSpaceFilter(intent, filter, now) && matchesIntentQuery(intent, query),
    );
    if (filter !== 'all') return { visible: matching, finished: [] as Intent[] };
    return {
      visible: matching.filter((intent) => intentGroup(intent, now) !== 'finished'),
      finished: matching.filter((intent) => intentGroup(intent, now) === 'finished'),
    };
  }, [intents, sort, filter, query, now]);

  const listRef = useIdleCandidateRows(projectId, visible.length > 0);
  const hasActiveFilter = filter !== 'all' || query.trim() !== '';
  const chips = filter === 'failed' ? [...FILTER_CHIPS, 'failed' as const] : FILTER_CHIPS;

  const renderRow = (intent: Intent) => (
    <IntentRow
      key={intent.id}
      projectId={projectId}
      intent={intent}
      now={now}
      deleting={deletingId === intent.id}
      actions={rowActions?.(intent)}
    />
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-60">
          <label htmlFor="intent-filter-query" className="sr-only">
            Filter intents
          </label>
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            id="intent-filter-query"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter intents…"
            className="h-8 pl-8 text-sm"
          />
        </div>
        <ToggleGroup
          type="single"
          aria-label="Show intents"
          value={filter}
          onValueChange={(value) => {
            if (value) onFilterChange(value as SpaceFilter);
          }}
          className="flex-wrap"
        >
          {chips.map((chip) => (
            <ToggleGroupItem key={chip} value={chip} className="h-8 gap-1.5 px-2.5 text-xs">
              {SPACE_FILTER_LABELS[chip]}
              {chip !== 'all' ? (
                <>
                  {' '}
                  <span className="tabular-nums font-normal opacity-80">{counts[chip]}</span>
                </>
              ) : null}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="ml-auto gap-1.5 whitespace-nowrap">
              <ArrowUpDown aria-hidden="true" className="text-muted-foreground" />
              <span className="sr-only">Sort intents:</span>
              {INTENT_SORT_LABELS[sort]}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuRadioGroup value={sort} onValueChange={changeSort}>
              {SORT_OPTIONS.map((option) => (
                <DropdownMenuRadioItem key={option} value={option}>
                  {INTENT_SORT_LABELS[option]}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {visible.length === 0 && finished.length === 0 ? (
        <EmptyState
          size="section"
          title="No intents match these filters"
          description="Try another status or a shorter search."
          action={
            hasActiveFilter ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setQuery('');
                  onFilterChange('all');
                }}
              >
                Clear filters
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          {visible.length > 0 ? (
            <ul
              ref={listRef}
              aria-label="Intents"
              className={cn(
                'divide-y overflow-hidden rounded-lg border bg-card text-card-foreground',
              )}
            >
              {visible.map(renderRow)}
            </ul>
          ) : null}
          {visible.length === 0 ? (
            <EmptyState
              size="section"
              title="Nothing is running or waiting for you in this space"
              description="Every intent here has finished. Start a new one when you have the next thing to build."
              action={idleAction}
            />
          ) : null}
          {finished.length > 0 ? (
            <Disclosure
              variant="row"
              title={`${finished.length} finished`}
              summary="Completed and cancelled"
              defaultOpen={visible.length === 0}
              contentClassName="px-0 pb-0 pt-2"
            >
              <ul
                aria-label="Finished intents"
                className="divide-y overflow-hidden rounded-lg border bg-card text-card-foreground"
              >
                {finished.map(renderRow)}
              </ul>
            </Disclosure>
          ) : null}
        </>
      )}
    </div>
  );
}
