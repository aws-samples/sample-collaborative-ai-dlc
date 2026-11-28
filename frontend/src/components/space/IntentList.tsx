import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Search } from 'lucide-react';
import type { Intent } from '@/services/intents';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { EmptyState } from '@/components/ui/empty-state';
import { useOfferIdleCandidates } from '@/hooks/useIdleNext';
import { useIntentStatusReader, type DerivedIntentStatus } from '@/lib/statusModel';
import { formatCount } from '@/lib/format';
import { IntentRow } from './IntentRow';
import {
  SPACE_FILTER_LABELS,
  intentGroup,
  matchesIntentQuery,
  matchesSpaceFilter,
  needsAttention,
  orderIntents,
  SPACE_FILTER_PARAM,
  type SpaceFilter,
} from './intentGrouping';

const IDLE_PREFETCH_MAX = 2;
const FILTER_CHIPS: readonly SpaceFilter[] = ['all', 'active', 'needs-attention', 'finished'];
// Chips that say what needs doing carry their count; the others stay plain.
const COUNTED_CHIPS: ReadonlySet<SpaceFilter> = new Set(['needs-attention', 'failed']);
// One page of rows; the list is already in the browser, so paging is instant.
export const INTENTS_PER_PAGE = 20;
// The page (1-based) and the search text live in the address, replaced rather
// than pushed, so Back from an intent returns to the same rows.
export const INTENT_PAGE_PARAM = 'page';
const QUERY_PARAM = 'q';

function parsePage(value: string | null): number {
  const page = Number.parseInt(value ?? '', 10);
  return Number.isFinite(page) && page > 1 ? page - 1 : 0;
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
  /** The list's own action ("New intent"), at the end of the filter row. */
  action?: React.ReactNode;
  now?: number;
}

export function IntentList({
  projectId,
  intents: listed,
  filter,
  onFilterChange,
  rowActions,
  deletingId,
  action,
  now = Date.now(),
}: IntentListProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  const query = searchParams.get(QUERY_PARAM) ?? '';
  const page = parsePage(searchParams.get(INTENT_PAGE_PARAM));
  const replaceParams = useCallback(
    (update: (params: URLSearchParams) => void) =>
      setSearchParams(
        (previous) => {
          const params = new URLSearchParams(previous);
          update(params);
          return params;
        },
        { replace: true },
      ),
    [setSearchParams],
  );
  const setPage = useCallback(
    (next: number) =>
      replaceParams((params) => {
        if (next > 0) params.set(INTENT_PAGE_PARAM, String(next + 1));
        else params.delete(INTENT_PAGE_PARAM);
      }),
    [replaceParams],
  );
  // A new search starts at the first page (a new filter does too: the page drops it).
  const setQuery = (text: string) =>
    replaceParams((params) => {
      if (text) params.set(QUERY_PARAM, text);
      else params.delete(QUERY_PARAM);
      params.delete(INTENT_PAGE_PARAM);
    });

  // Groups, filters and counts read each intent as its row's pill does: the
  // cached detail when it is current, else the list summary.
  const readStatus = useIntentStatusReader();
  const { intents, statusOf } = useMemo(() => {
    const byId = new Map<string, DerivedIntentStatus>();
    const shown = listed.map((summary) => {
      const { intent, status } = readStatus(projectId, summary, { now });
      byId.set(intent.id, status);
      return intent;
    });
    return { intents: shown, statusOf: (intent: Intent) => byId.get(intent.id) };
  }, [listed, readStatus, projectId, now]);

  const counts = useMemo(() => {
    const tally = { all: 0, active: 0, 'needs-attention': 0, failed: 0, finished: 0 };
    for (const intent of intents) {
      tally.all += 1;
      const group = intentGroup(intent, now);
      if (group === 'attention' || group === 'active') tally.active += 1;
      if (needsAttention(intent, now, statusOf(intent))) tally['needs-attention'] += 1;
      if (group === 'failed') tally.failed += 1;
      if (group === 'finished') tally.finished += 1;
    }
    return tally;
  }, [intents, statusOf, now]);

  const matching = useMemo(
    () =>
      orderIntents(intents, now).filter(
        (intent) =>
          matchesSpaceFilter(intent, filter, now, statusOf(intent)) &&
          matchesIntentQuery(intent, query),
      ),
    [intents, statusOf, filter, query, now],
  );

  // A shrinking list never leaves the reader on an empty page, and the clamp
  // is written back so the list does not jump to the old page when it grows.
  const pageCount = Math.max(1, Math.ceil(matching.length / INTENTS_PER_PAGE));
  const current = Math.min(page, pageCount - 1);
  useEffect(() => {
    if (current !== page) setPage(current);
  }, [current, page, setPage]);
  const start = current * INTENTS_PER_PAGE;
  const visible = matching.slice(start, start + INTENTS_PER_PAGE);

  const listRef = useIdleCandidateRows(projectId, visible.length > 0);
  const hasActiveFilter = filter !== 'all' || query.trim() !== '';
  const chips = filter === 'failed' ? [...FILTER_CHIPS, 'failed' as const] : FILTER_CHIPS;

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
              {COUNTED_CHIPS.has(chip) && counts[chip] > 0 ? (
                <>
                  {' '}
                  <span className="tabular-nums font-normal opacity-80">{counts[chip]}</span>
                </>
              ) : null}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        {action ? <div className="ml-auto">{action}</div> : null}
      </div>

      {matching.length === 0 ? (
        <EmptyState
          size="section"
          title="No intents match these filters"
          description="Try another status or a shorter search."
          action={
            hasActiveFilter ? (
              <Button
                variant="outline"
                size="sm"
                // One history entry, like a filter chip: no filter, search or page.
                onClick={() =>
                  setSearchParams((previous) => {
                    const params = new URLSearchParams(previous);
                    for (const key of [SPACE_FILTER_PARAM, QUERY_PARAM, INTENT_PAGE_PARAM])
                      params.delete(key);
                    return params;
                  })
                }
              >
                Clear filters
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <ul
            ref={listRef}
            aria-label="Intents"
            className="divide-y overflow-hidden rounded-lg border bg-card text-card-foreground"
          >
            {visible.map((intent) => (
              <IntentRow
                key={intent.id}
                projectId={projectId}
                intent={intent}
                now={now}
                deleting={deletingId === intent.id}
                actions={rowActions?.(intent)}
              />
            ))}
          </ul>
          {pageCount > 1 ? (
            <nav
              aria-label="Intent pages"
              className="flex items-center justify-between gap-3 text-xs text-muted-foreground"
            >
              <span className="tabular-nums">
                {formatCount(start + 1)}–{formatCount(start + visible.length)} of{' '}
                {formatCount(matching.length)}
              </span>
              <span className="flex items-center gap-1.5">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={current === 0}
                  onClick={() => setPage(current - 1)}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={current >= pageCount - 1}
                  onClick={() => setPage(current + 1)}
                >
                  Next
                </Button>
              </span>
            </nav>
          ) : null}
        </>
      )}
    </div>
  );
}
