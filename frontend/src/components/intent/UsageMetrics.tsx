import { useId, useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import { contextGaugeTone, formatCost, formatMillis, formatTokens } from '@/lib/metricAggregation';
import { formatBytes, formatUsageBreakdown, type UsagePart } from '@/lib/format';
import { Disclosure } from '@/components/ui/disclosure';
import { MetricRow, Stat } from '@/components/ui/stat';
import { displayModels } from '@/lib/displayNames';
import { useIntentOptional, type IntentStageRow } from '@/contexts/IntentContext';
import { formatDuration } from '@/components/intent/stageStyle';
import { BarChart3, ChevronDown } from 'lucide-react';

const KNOWN_LABELS: Record<string, string> = {
  artifactsCreated: 'Artifacts created',
  questionsAsked: 'Questions asked',
  filesModified: 'Files modified',
  suggestionsAccepted: 'Suggestions accepted',
  iterationsRun: 'Iterations run',
  decisionsLogged: 'Decisions logged',
  promptBytes: 'Assembled prompts',
  compiledContextBytes: 'Compiled graph context',
  tokensCacheRead: 'Cache read tokens',
  tokensCacheWrite: 'Cache write tokens',
};

function humanizeKey(key: string): string {
  if (KNOWN_LABELS[key]) return KNOWN_LABELS[key];
  const spaced = key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export type UsageCost = {
  totalCost: number;
  currency: string;
  priced: boolean;
  estimated?: boolean;
} | null;

// Shared usage/cost renderer for aggregated metric bags — used at stage, intent
// and project scope so the three surfaces read identically. Callers pass an
// already-aggregated bag (see metricAggregation) plus an optional cost total.

interface UsageMetricsProps {
  metrics: Record<string, number>;
  // Total cost across the scope, if computable. `priced === false` means at
  // least one sample's model had no price entry (newer model / Kiro credits
  // without a captured rate) — we show "cost unavailable" instead of a
  // misleading number. `estimated === true` means Kiro credit-estimated dollars
  // (priced at the plan's $/credit overage rate) are in the total, or a sample
  // is a lower bound because its CLI ended without a usage report — shown as
  // "~$X.XX" and labelled an estimate, since this is not billing truth.
  cost?: UsageCost;
  // 'peak' relabels the context gauge when rolled up across intents/stages.
  contextLabel?: string;
  className?: string;
  /** Hide the advanced diagnostics behind a "Usage details" toggle. */
  collapsibleAdvanced?: boolean;
  /** Render ONLY Input/Output/Total tokens + Cost (Space scope). */
  coreOnly?: boolean;
  /** One metric row (Tokens · Cost · Wall time · Stages run) and a "Details"
   *  disclosure with the labelled token breakdown. Diagnostic metrics are not
   *  part of this view: they live in Audit. */
  compact?: boolean;
  /** Show the token and cost fields even when a sample omitted them. */
  showMissingValues?: boolean;
  /** Compact only: elapsed wall-clock time of the run (shown as "Elapsed"). */
  wallTime?: string | null;
  /** Compact only: agent-active time. Derived from the intent's stage rows when omitted. */
  activeTime?: string | null;
  /** Compact only: completed in-scope stages over the in-scope total. */
  stagesRun?: { done: number; total: number } | null;
  /** Compact only: tokens attributed to stages, to explain the "Other" residue. */
  stageTokens?: number | null;
}

// A slim threshold-colored bar for the context-window percentage. Not the shared
// Progress primitive because that has a fixed color; here color IS the signal.
function ContextGauge({ pct, label }: { pct: number; label: string }) {
  const tone = contextGaugeTone(pct);
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className={cn('font-medium tabular-nums', tone.text)}>{Math.round(pct)}%</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn('h-full rounded-full transition-all', tone.bar)}
          style={{ width: `${clamped}%` }}
        />
      </div>
    </div>
  );
}

function costStatProps(cost: UsageCost | undefined) {
  if (!cost) return { label: 'Cost', value: 'Not recorded' };
  if (!cost.priced) return { label: 'Cost', value: 'Unavailable' };
  return {
    label: cost.estimated ? 'Cost (est.)' : 'Cost',
    value: `${cost.estimated ? '~' : ''}${formatCost(cost.totalCost, cost.currency)}`,
  };
}

function CostStat({ cost }: Pick<UsageMetricsProps, 'cost'>) {
  return <Stat {...costStatProps(cost)} />;
}

function hasUsageDiagnostics(metrics: Record<string, number>) {
  return Object.keys(metrics).some((key) => key !== 'tokensInput' && key !== 'tokensOutput');
}

function UsageDiagnostics({
  metrics,
  contextLabel = 'Peak context window',
}: Pick<UsageMetricsProps, 'metrics' | 'contextLabel'>) {
  const {
    tokensInput: _input,
    tokensOutput: _output,
    contextWindowPct: ctx,
    agentLaunchMs: launchMs,
    ...other
  } = metrics;
  const extras = Object.entries(other);
  if (!hasUsageDiagnostics(metrics)) return null;
  return (
    <div className="space-y-3">
      {(launchMs !== undefined || extras.length > 0) && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-6">
          {launchMs !== undefined && (
            <Stat
              label="Peak dispatch delay"
              value={formatMillis(launchMs)}
              hint="Longest wait for the runtime to accept a job, before agent work starts."
            />
          )}
          {extras.map(([k, v]) => (
            <Stat
              key={k}
              label={humanizeKey(k)}
              hint={
                k === 'promptBytes'
                  ? 'Total size of prompts assembled for measured agent starts, including supplied context.'
                  : k === 'compiledContextBytes'
                    ? 'Graph context included in those prompts.'
                    : undefined
              }
              value={
                k === 'promptBytes' || k === 'compiledContextBytes'
                  ? formatBytes(v)
                  : k === 'tokensCacheRead' || k === 'tokensCacheWrite'
                    ? formatTokens(v)
                    : v.toLocaleString()
              }
            />
          ))}
        </div>
      )}
      {ctx !== undefined && <ContextGauge pct={ctx} label={contextLabel} />}
    </div>
  );
}

function tokenParts(metrics: Record<string, number>): UsagePart[] {
  const { parts } = formatUsageBreakdown({
    input: metrics.tokensInput,
    output: metrics.tokensOutput,
    cacheRead: metrics.tokensCacheRead,
    cacheWrite: metrics.tokensCacheWrite,
  });
  // A Total that reads like one of its parts ("Output 2.0K · Total 2.0K")
  // adds nothing and looks like a bug, so it is dropped.
  const total = parts.find((p) => p.key === 'total');
  if (total && parts.some((p) => p.key !== 'total' && p.text === total.text)) {
    return parts.filter((p) => p.key !== 'total');
  }
  return parts;
}

export function StageUsage({
  models,
  metrics,
  cost,
}: Pick<UsageMetricsProps, 'metrics' | 'cost'> & { models: string[] }) {
  const parts = tokenParts(metrics);
  const hasOutput = parts.some((p) => p.key === 'output');
  return (
    <div
      data-testid="usage-metrics"
      className="flex flex-wrap gap-x-5 gap-y-2 [&>*+*]:border-l [&>*+*]:border-border [&>*+*]:pl-4"
    >
      <Stat
        label="Model"
        value={models.length ? displayModels(models) : undefined}
        state={models.length ? 'ok' : 'missing'}
        className="basis-full sm:basis-auto"
      />
      {parts.map((part) => (
        <Stat key={part.key} label={part.label} value={part.text} />
      ))}
      {!hasOutput && <Stat label="Output" value={undefined} state="missing" />}
      {cost ? <CostStat cost={cost} /> : <Stat label="Cost" value={undefined} state="missing" />}
    </div>
  );
}

type ActiveTimeRow = Pick<IntentStageRow, 'startedAt' | 'completedAt' | 'waitMs' | 'parkedAt'>;

// Agent-active time across stages: wall time from first start to completion
// (or now), minus recorded waits and the open park window — the same rule as
// stageDurations, summed. Null when no stage has started, so the stat is
// omitted rather than shown as a fake zero.
function activeTimeOf(rows: readonly ActiveTimeRow[], now = Date.now()): string | null {
  let total = 0;
  let started = false;
  for (const row of rows) {
    if (!row.startedAt) continue;
    const start = new Date(row.startedAt).getTime();
    if (!Number.isFinite(start)) continue;
    started = true;
    const end = row.completedAt ? new Date(row.completedAt).getTime() : now;
    const parkedAt = row.parkedAt ? new Date(row.parkedAt).getTime() : NaN;
    const openPark = Number.isFinite(parkedAt) ? Math.max(0, Math.min(end, now) - parkedAt) : 0;
    const waited = Math.max(0, row.waitMs ?? 0) + openPark;
    total += Math.max(0, Math.max(0, end - start) - waited);
  }
  if (!started) return null;
  return formatDuration(new Date(0).toISOString(), new Date(total).toISOString());
}

function CompactUsage({
  metrics,
  cost,
  wallTime,
  activeTime: activeTimeProp,
  stagesRun,
  stageTokens,
  className,
}: Pick<
  UsageMetricsProps,
  'metrics' | 'cost' | 'wallTime' | 'activeTime' | 'stagesRun' | 'stageTokens' | 'className'
>) {
  const intent = useIntentOptional();
  const contextRows = intent?.stageRows;
  const activeTime = useMemo(
    () => (activeTimeProp !== undefined ? activeTimeProp : activeTimeOf(contextRows ?? [])),
    [activeTimeProp, contextRows],
  );
  const breakdown = useMemo(() => tokenParts(metrics), [metrics]);
  const total = breakdown.reduce((sum, part) => (part.key === 'total' ? sum : sum + part.value), 0);
  const hasTokens = breakdown.length > 0;
  const residue =
    typeof stageTokens === 'number' && Number.isFinite(stageTokens) && total > stageTokens
      ? total - stageTokens
      : null;
  const costStat = costStatProps(cost);

  return (
    <div className={cn('space-y-3', className)} data-testid="usage-metrics">
      <MetricRow aria-label="Run cost and usage">
        <Stat
          label="Tokens"
          value={hasTokens ? formatTokens(total) : undefined}
          state={hasTokens ? 'ok' : 'missing'}
          size="lg"
        />
        <Stat
          label={costStat.label}
          value={costStat.value}
          state={cost?.priced ? (cost.estimated ? 'estimated' : 'ok') : 'ok'}
          size="lg"
        />
        {wallTime !== undefined && (
          <Stat
            label="Elapsed"
            value={wallTime ?? undefined}
            state={wallTime ? 'ok' : 'missing'}
            size="lg"
          />
        )}
        {wallTime !== undefined && activeTime && (
          <Stat label="Active time" value={activeTime} size="lg" />
        )}
        {stagesRun !== undefined && (
          <Stat
            label="Stages run"
            value={stagesRun ? `${stagesRun.done} of ${stagesRun.total}` : undefined}
            state={stagesRun ? 'ok' : 'missing'}
            size="lg"
          />
        )}
      </MetricRow>
      {hasTokens && (
        <Disclosure title="Details" variant="inline">
          <div className="flex flex-wrap gap-x-5 gap-y-2 [&>*+*]:border-l [&>*+*]:border-border [&>*+*]:pl-4">
            {breakdown.map((part) => (
              <Stat key={part.key} label={part.label} value={part.text} />
            ))}
            {residue !== null && (
              <Stat
                label="Other"
                value={formatTokens(residue)}
                hint="Not attributed to a stage: setup, questions, delivery."
              />
            )}
          </div>
        </Disclosure>
      )}
    </div>
  );
}

export function UsageMetrics({
  metrics,
  cost,
  contextLabel = 'Context window',
  className,
  collapsibleAdvanced = false,
  coreOnly = false,
  compact = false,
  showMissingValues = false,
  wallTime,
  activeTime,
  stagesRun,
  stageTokens,
}: UsageMetricsProps) {
  const hasInputTokens = Object.hasOwn(metrics, 'tokensInput');
  const hasOutputTokens = Object.hasOwn(metrics, 'tokensOutput');
  const hasTokens = hasInputTokens || hasOutputTokens;
  const hasAdvanced = !coreOnly && hasUsageDiagnostics(metrics);
  const [showAdvanced, setShowAdvanced] = useState(!collapsibleAdvanced);
  const detailsId = useId();

  if (compact) {
    return (
      <CompactUsage
        metrics={metrics}
        cost={cost}
        wallTime={wallTime}
        activeTime={activeTime}
        stagesRun={stagesRun}
        stageTokens={stageTokens}
        className={className}
      />
    );
  }

  const nothing = !hasTokens && !hasAdvanced && !cost && !showMissingValues;
  if (nothing) return null;

  return (
    <div className={cn('space-y-3', className)} data-testid="usage-metrics">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {(hasInputTokens || showMissingValues) && (
          <Stat
            label="Input tokens"
            value={hasInputTokens ? formatTokens(metrics.tokensInput) : 'Not recorded'}
          />
        )}
        {(hasOutputTokens || showMissingValues) && (
          <Stat
            label="Output tokens"
            value={hasOutputTokens ? formatTokens(metrics.tokensOutput) : 'Not recorded'}
          />
        )}
        {(hasTokens || showMissingValues) && (
          <Stat
            label="Total tokens"
            value={
              hasInputTokens && hasOutputTokens
                ? formatTokens(metrics.tokensInput + metrics.tokensOutput)
                : 'Not recorded'
            }
          />
        )}
        {(cost || collapsibleAdvanced || coreOnly || showMissingValues) && <CostStat cost={cost} />}
      </div>
      {!coreOnly && (
        <div id={detailsId} hidden={collapsibleAdvanced && !showAdvanced}>
          {(!collapsibleAdvanced || showAdvanced) && (
            <UsageDiagnostics metrics={metrics} contextLabel={contextLabel} />
          )}
        </div>
      )}
      {collapsibleAdvanced && hasAdvanced && (
        <button
          type="button"
          onClick={() => setShowAdvanced((s) => !s)}
          className={cn(
            'inline-flex min-h-7 items-center gap-1.5 rounded-md border px-2.5 py-1',
            'text-xs font-medium text-muted-foreground',
            'hover:bg-accent hover:text-foreground transition-colors',
          )}
          aria-expanded={showAdvanced}
          aria-controls={detailsId}
          data-testid="usage-more-stats"
        >
          <BarChart3 className="h-3 w-3" />
          <span>Usage details</span>
          <ChevronDown
            className={cn('h-3 w-3 transition-transform', showAdvanced && 'rotate-180')}
          />
        </button>
      )}
    </div>
  );
}
