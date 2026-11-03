import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { AlertTriangle, Inbox, Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { PendingQuestionItem } from '@/components/my-work/PendingQuestionItem';
import { usePendingQuestions } from '@/hooks/usePendingQuestions';
import { useProjectsCache } from '@/hooks/useProjectsCache';
import type { PendingQuestionKind, UnavailableSpace } from '@/services/myWork';

const ALL = 'all';
const TYPE_FILTERS: Record<string, { label: string; kinds: PendingQuestionKind[] }> = {
  questions: { label: 'Questions', kinds: ['question'] },
  approvals: {
    label: 'Approvals and reviews',
    kinds: ['approval', 'review-verdict', 'validation'],
  },
};

const spaceNames = (spaces: UnavailableSpace[]) =>
  spaces.map((s) => s.projectName || s.projectId).join(', ');

function PartialAlert({
  unavailable,
  onRetry,
}: {
  unavailable: UnavailableSpace[];
  onRetry: () => void;
}) {
  const failed = unavailable.filter((s) => s.reason !== 'LIMIT_EXCEEDED');
  const limited = unavailable.filter((s) => s.reason === 'LIMIT_EXCEEDED');
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400"
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <div className="flex-1 space-y-1">
        {failed.length > 0 && (
          <p>
            Some spaces couldn't be checked: {spaceNames(failed)}. Questions from them may be
            missing.
          </p>
        )}
        {limited.length > 0 && (
          <p>
            Some spaces have too many active intents to check at once: {spaceNames(limited)}.
            Questions from them may be missing.
          </p>
        )}
      </div>
      <Button variant="ghost" size="sm" className="h-7 shrink-0" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

export default function MyWork() {
  const [searchParams, setSearchParams] = useSearchParams();
  const spaceParam = searchParams.get('space');
  const typeParam = searchParams.get('type');
  const typeFilter = typeParam ? TYPE_FILTERS[typeParam] : undefined;
  const { projects } = useProjectsCache();
  const spaces = useMemo(
    () =>
      projects
        .filter((p) => p.project.kind === 'v2')
        .map((p) => p.project)
        .toSorted((a, b) => a.name.localeCompare(b.name)),
    [projects],
  );

  const { items, unavailable, status, error, accessLost, hasMore, loadingMore, refresh, loadMore } =
    usePendingQuestions({ projectId: spaceParam, kinds: typeFilter?.kinds ?? null });

  const [accessLostNotice, setAccessLostNotice] = useState(false);
  const setFilter = (key: 'space' | 'type', value: string) => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value === ALL) next.delete(key);
        else next.set(key, value);
        return next;
      },
      { replace: true },
    );
  };
  // Access to the filtered space was lost: say so and fall back to all spaces.
  useEffect(() => {
    if (!accessLost) return;
    setAccessLostNotice(true);
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('space');
        return next;
      },
      { replace: true },
    );
  }, [accessLost, setSearchParams]);

  const nothingWaiting = status === 'ready' && items.length === 0;

  return (
    <div className="h-full">
      <div className="mb-6 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">My work</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Questions waiting for an answer in your spaces
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => refresh()}
          className="gap-2"
          disabled={status === 'loading'}
        >
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
          Refresh
        </Button>
      </div>

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <Select
          value={spaceParam ?? ALL}
          onValueChange={(v) => {
            setAccessLostNotice(false);
            setFilter('space', v);
          }}
        >
          <SelectTrigger className="h-9 w-[220px]" aria-label="Space">
            <SelectValue placeholder="All spaces" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All spaces</SelectItem>
            {spaces.map((space) => (
              <SelectItem key={space.id} value={space.id}>
                {space.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={typeFilter ? typeParam! : ALL} onValueChange={(v) => setFilter('type', v)}>
          <SelectTrigger className="h-9 w-[220px]" aria-label="Type">
            <SelectValue placeholder="All types" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All types</SelectItem>
            {Object.entries(TYPE_FILTERS).map(([value, { label }]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-4">
        {accessLostNotice && (
          <div
            role="status"
            className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm text-muted-foreground"
          >
            <span>You no longer have access to that space. Showing all your spaces.</span>
            <Button
              variant="ghost"
              size="sm"
              className="h-7"
              onClick={() => setAccessLostNotice(false)}
            >
              Dismiss
            </Button>
          </div>
        )}

        {status === 'loading' ? (
          <div className="space-y-2" aria-busy="true" aria-label="Loading questions">
            {[1, 2, 3].map((i) => (
              <Card key={i}>
                <CardContent className="p-4">
                  <Skeleton className="mb-3 h-3 w-1/3" />
                  <Skeleton className="mb-3 h-4 w-2/3" />
                  <Skeleton className="h-3 w-1/2" />
                </CardContent>
              </Card>
            ))}
          </div>
        ) : status === 'error' ? (
          <Card className="border-destructive/40 bg-destructive/5">
            <CardContent className="flex flex-col items-center justify-center py-16">
              <h3 className="mb-1 text-lg font-semibold">Couldn't load your questions</h3>
              <p className="mb-6 max-w-sm text-center text-sm text-muted-foreground">{error}</p>
              <Button variant="outline" onClick={() => refresh()} className="gap-2">
                <RefreshCw className="h-4 w-4" aria-hidden="true" />
                Retry
              </Button>
            </CardContent>
          </Card>
        ) : (
          <>
            {unavailable.length > 0 && (
              <PartialAlert unavailable={unavailable} onRetry={() => refresh()} />
            )}
            {nothingWaiting ? (
              <Card className="border-dashed">
                <CardContent className="flex flex-col items-center justify-center py-16">
                  <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-muted">
                    <Inbox className="h-7 w-7 text-muted-foreground" aria-hidden="true" />
                  </div>
                  <h3 className="mb-1 text-lg font-semibold">
                    {unavailable.length > 0
                      ? 'No questions found in the spaces that could be checked'
                      : 'Nothing is waiting for your answer'}
                  </h3>
                </CardContent>
              </Card>
            ) : (
              <ul aria-label="Pending questions" className="space-y-2">
                {items.map((item) => (
                  <PendingQuestionItem key={item.id} item={item} />
                ))}
              </ul>
            )}
            {error && (
              <p role="alert" className="text-sm text-destructive">
                Couldn't load more questions: {error}
              </p>
            )}
            {hasMore && (
              <div className="flex justify-center">
                <Button
                  variant="outline"
                  onClick={() => loadMore()}
                  disabled={loadingMore}
                  className="gap-2"
                >
                  {loadingMore && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
                  Load more
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
