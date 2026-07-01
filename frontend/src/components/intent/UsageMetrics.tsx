import { cn } from '@/lib/utils';
import { formatTokens, formatCost, contextGaugeTone } from '@/lib/metricAggregation';

// Shared usage/cost renderer for aggregated metric bags — used at stage, intent
// and project scope so the three surfaces read identically. Callers pass an
// already-aggregated bag (see metricAggregation) plus an optional cost total.
// It renders only what's present: token counts, a context-window gauge, cost.

interface UsageMetricsProps {
  metrics: Record<string, number>;
  // Total cost across the scope, if computable. `priced === false` means at
  // least one sample's model had no price entry (newer model / Kiro credits
  // without a captured rate) — we show "cost unavailable" instead of a
  // misleading number. `estimated === true` means Kiro credit-estimated dollars
  // (priced at the plan's $/credit overage rate) are in the total — shown as
  // "~$X.XX" and labelled an estimate, since in-plan credits are covered by the
  // subscription and this is not billing truth.
  cost?: { totalCost: number; currency: string; priced: boolean; estimated?: boolean } | null;
  // 'peak' relabels the context gauge when rolled up across intents/stages.
  contextLabel?: string;
  className?: string;
}

// A slim threshold-colored bar for the context-window percentage. Not the shared
// Progress primitive because that has a fixed color; here color IS the signal.
function ContextGauge({ pct, label }: { pct: number; label: string }) {
  const tone = contextGaugeTone(pct);
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[11px]">
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

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className="text-sm font-medium tabular-nums">{value}</p>
    </div>
  );
}

export function UsageMetrics({
  metrics,
  cost,
  contextLabel = 'Context window',
  className,
}: UsageMetricsProps) {
  const tokensIn = metrics.tokensInput ?? 0;
  const tokensOut = metrics.tokensOutput ?? 0;
  const hasTokens = 'tokensInput' in metrics || 'tokensOutput' in metrics;
  const ctx = metrics.contextWindowPct;
  // Any numeric key we don't render explicitly, shown generically so an
  // agent-chosen key isn't silently dropped.
  const extras = Object.entries(metrics).filter(
    ([k]) => !['tokensInput', 'tokensOutput', 'contextWindowPct'].includes(k),
  );

  const nothing = !hasTokens && ctx === undefined && extras.length === 0 && !cost;
  if (nothing) return null;

  return (
    <div className={cn('space-y-3', className)}>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {hasTokens && <Stat label="Input tokens" value={formatTokens(tokensIn)} />}
        {hasTokens && <Stat label="Output tokens" value={formatTokens(tokensOut)} />}
        {hasTokens && <Stat label="Total tokens" value={formatTokens(tokensIn + tokensOut)} />}
        {cost && (
          <Stat
            label={cost.priced && cost.estimated ? 'Cost (est.)' : 'Cost'}
            value={
              cost.priced
                ? `${cost.estimated ? '~' : ''}${formatCost(cost.totalCost, cost.currency)}`
                : 'unavailable'
            }
          />
        )}
        {extras.map(([k, v]) => (
          <Stat key={k} label={k} value={v.toLocaleString()} />
        ))}
      </div>
      {ctx !== undefined && <ContextGauge pct={ctx} label={contextLabel} />}
    </div>
  );
}
