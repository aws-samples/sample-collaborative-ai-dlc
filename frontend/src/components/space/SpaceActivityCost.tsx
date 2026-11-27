import { useEffect, useMemo, useState } from 'react';
import { api } from '@/services/api';
import type { Intent, ProjectMetrics } from '@/services/intents';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { ErrorState } from '@/components/ui/empty-state';
import { MetricRow, Stat } from '@/components/ui/stat';
import { useQuery } from '@tanstack/react-query';
import { qk } from '@/lib/queryKeys';
import { formatCost, formatTokens } from '@/lib/metricAggregation';
import { formatCount } from '@/lib/format';
import { formatAge } from '@/lib/timeAgo';

const USAGE_STALE_MS = 5 * 60_000;
const API_INTENT_CAP = 100;
const SLOW_LOAD_AFTER_S = 8;

// The per-run usage read is slow (one PRISM read per intent), so it only runs
// when asked for; a fresh cached answer is shown without asking again.
function useSpaceMetrics(projectId: string) {
  const [requested, setRequested] = useState(false);
  const query = useQuery({
    queryKey: qk.spaceMetrics(projectId, 'all'),
    queryFn: ({ signal }) =>
      api.get<ProjectMetrics>(`/projects/${projectId}/intents/metrics`, { signal }),
    staleTime: USAGE_STALE_MS,
    enabled: requested,
  });
  return {
    data: query.data,
    error: query.error,
    isFetching: query.isFetching,
    available:
      requested || (query.data !== undefined && Date.now() - query.dataUpdatedAt < USAGE_STALE_MS),
    load: () => setRequested(true),
    retry: () => query.refetch(),
  };
}

function useElapsedSeconds(active: boolean): number {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!active) return;
    setSeconds(0);
    const timer = setInterval(() => setSeconds((value) => value + 1), 1_000);
    return () => clearInterval(timer);
  }, [active]);
  return active ? seconds : 0;
}

const positive = (value: number | undefined | null): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;

// Tokens and cost as /metrics returns them: the space total and the average
// over the intents that recorded usage.
function UsageStats({ data }: { data: ProjectMetrics }) {
  const metrics = data.project?.metrics ?? null;
  const cost = data.project?.cost ?? null;
  const withUsage = data.perIntent?.length ?? 0;
  const tokens = positive((metrics?.tokensInput ?? 0) + (metrics?.tokensOutput ?? 0));
  const totalCost = positive(cost?.totalCost);
  const summaryMissing = metrics === null && cost === null;
  if (!summaryMissing && tokens === null && totalCost === null && !cost?.anyUnpriced) {
    return <p className="text-xs text-muted-foreground">No usage recorded for this space yet.</p>;
  }
  const average = (total: number | null) =>
    total !== null && withUsage > 0 ? total / withUsage : null;
  const costState =
    !cost || cost.anyUnpriced || totalCost === null
      ? 'missing'
      : cost.anyEstimated
        ? 'estimated'
        : 'ok';
  const costHint = !cost
    ? 'No cost summary was returned for this space.'
    : cost.anyUnpriced
      ? 'Some runs used a model without a known price.'
      : cost.anyEstimated
        ? 'Includes credit-based estimates.'
        : undefined;
  const averageTokens = average(tokens);
  const averageCost = average(totalCost);

  return (
    <MetricRow aria-label="Usage and cost">
      <Stat
        label="Total tokens"
        value={tokens === null ? null : formatTokens(tokens)}
        state={tokens === null ? 'missing' : 'ok'}
        hint={`Input and output, across ${formatCount(withUsage)} ${withUsage === 1 ? 'intent' : 'intents'} with recorded usage.`}
      />
      <Stat
        label="Average tokens per intent"
        value={averageTokens === null ? null : formatTokens(averageTokens)}
        state={averageTokens === null ? 'missing' : 'ok'}
      />
      <Stat
        label="Total cost"
        value={cost && totalCost !== null ? formatCost(totalCost, cost.currency) : null}
        state={costState}
        hint={costHint}
      />
      <Stat
        label="Average cost per intent"
        value={cost && averageCost !== null ? formatCost(averageCost, cost.currency) : null}
        state={costState}
      />
    </MetricRow>
  );
}

function UsagePanel({ projectId }: { projectId: string }) {
  const { data, error, isFetching, available, load, retry } = useSpaceMetrics(projectId);
  const loading = available && !data && isFetching;
  const elapsed = useElapsedSeconds(loading);

  if (!available) {
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Button type="button" variant="outline" size="sm" onClick={() => load()}>
          Compute tokens and cost
        </Button>
        <span className="text-xs text-muted-foreground">
          Reads the usage of every run; can take up to a minute.
        </span>
      </div>
    );
  }
  if (loading) {
    return (
      <p role="status" aria-label="Loading usage" className="text-xs text-muted-foreground">
        <span className="tabular-nums">Reading usage for every run… {elapsed} s</span>
        {elapsed >= SLOW_LOAD_AFTER_S ? (
          <span className="block">
            Metrics are read run by run, which can take up to a minute on large spaces.
          </span>
        ) : null}
      </p>
    );
  }
  if (!data) {
    return (
      <ErrorState
        size="section"
        title="Couldn't load usage and cost"
        description={
          error instanceof Error && error.message
            ? error.message
            : 'The usage summary could not be retrieved.'
        }
        onRetry={retry}
        retrying={isFetching}
      />
    );
  }
  return <UsageStats data={data} />;
}

// From the intents already on the page: how many there are and how long a
// finished one took, start to end.
function averageDuration(intents: readonly Intent[]): { ms: number; count: number } | null {
  let total = 0;
  let count = 0;
  for (const intent of intents) {
    if (intent.status !== 'SUCCEEDED' || !intent.completedAt || !intent.createdAt) continue;
    const ms = Date.parse(intent.completedAt) - Date.parse(intent.createdAt);
    if (!Number.isFinite(ms) || ms < 0) continue;
    total += ms;
    count += 1;
  }
  return count > 0 ? { ms: total / count, count } : null;
}

export interface SpaceActivityCostProps {
  projectId: string;
  intents: readonly Intent[];
  /** Owners see token usage and cost; members only the activity. */
  canSeeCost: boolean;
  now?: number;
}

export function SpaceActivityCost({ projectId, intents, canSeeCost }: SpaceActivityCostProps) {
  const duration = useMemo(() => averageDuration(intents), [intents]);
  const capped = intents.length >= API_INTENT_CAP;

  return (
    <section aria-labelledby="space-activity-heading">
      <Card>
        <CardHeader className="pb-3">
          <h2 id="space-activity-heading" className="text-sm font-semibold leading-none">
            {canSeeCost ? 'Activity & cost' : 'Activity'}
          </h2>
        </CardHeader>
        <CardContent className="space-y-4">
          <MetricRow aria-label="Space activity">
            <Stat
              label="Intents"
              value={<span data-testid="space-activity-count">{formatCount(intents.length)}</span>}
              hint={capped ? `The first ${API_INTENT_CAP} returned by the space.` : undefined}
            />
            <Stat
              label="Average time per intent"
              value={duration ? formatAge(0, duration.ms) : null}
              state={duration ? 'ok' : 'missing'}
              hint={
                duration
                  ? `From start to completion, over ${formatCount(duration.count)} completed ${duration.count === 1 ? 'intent' : 'intents'}.`
                  : 'No intent has completed yet.'
              }
            />
          </MetricRow>
          {canSeeCost ? <UsagePanel projectId={projectId} /> : null}
        </CardContent>
      </Card>
    </section>
  );
}
