import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { IntentSensorRun, SensorDetail } from '@/services/intents';

// Sensor result → chip styling. `held: true` marks a blocking failure — the
// run is held on it — so it gets the loudest treatment. INCONCLUSIVE is an
// advisory miss (the check ran but couldn't confirm — e.g. a required artifact
// "not found in graph"): it does NOT hold the stage, but it is still worth
// flagging, so it gets the warning palette rather than a muted one.
const RESULT_CLS: Record<string, string> = {
  PASS: 'bg-agent-success/15 text-agent-success border-agent-success/30',
  FAIL: 'bg-agent-error/15 text-agent-error border-agent-error/30',
  INCONCLUSIVE: 'bg-agent-waiting/15 text-agent-waiting border-agent-waiting/30',
  BLOCKED: 'bg-muted/50 text-muted-foreground border-transparent',
};

// A non-PASS verdict is worth the reader's attention even when it did not hold
// the stage (advisory INCONCLUSIVE/FAIL). Used to mark the chip and drive the
// detail explanation.
export function sensorNeedsAttention(r: IntentSensorRun): boolean {
  return r.result !== 'PASS';
}

// Condense a sensor's structured `detail` into a short human explanation, the
// same shapes the backend summarizer handles: missing artifacts, unreferenced
// upstreams, a bare reason, or an error. Returns null when there is nothing
// terse worth showing.
export function summarizeSensorDetail(detail: SensorDetail | null): string | null {
  if (!detail || typeof detail !== 'object') return null;
  const missing = Array.isArray(detail.artifacts)
    ? detail.artifacts.filter((a) => a?.reason === 'not found in graph').map((a) => a.artifact)
    : [];
  if (missing.length) return `missing: ${missing.join(', ')}`;
  if (Array.isArray(detail.unreferenced) && detail.unreferenced.length) {
    return `unreferenced: ${detail.unreferenced.join(', ')}`;
  }
  if (detail.error) return String(detail.error);
  if (detail.reason) return String(detail.reason);
  return null;
}

// A stage can accumulate multiple runs per sensor across attempts — the row
// chips show only the latest verdict per sensor (the full history renders in
// the stage drill-down).
export function latestSensorRuns(runs: IntentSensorRun[]): IntentSensorRun[] {
  const bySensor = new Map<string, IntentSensorRun>();
  for (const r of runs) {
    const prev = bySensor.get(r.sensorId);
    if (!prev || (r.timestamp ?? '') >= (prev.timestamp ?? '')) bySensor.set(r.sensorId, r);
  }
  return [...bySensor.values()];
}

export function SensorChips({ runs, className }: { runs: IntentSensorRun[]; className?: string }) {
  const latest = latestSensorRuns(runs);
  if (latest.length === 0) return null;
  return (
    <span className={cn('inline-flex flex-wrap items-center gap-1', className)}>
      {latest.map((r) => {
        const explain = summarizeSensorDetail(r.detail);
        const attention = sensorNeedsAttention(r);
        return (
          <Badge
            key={r.sensorRunId}
            variant="outline"
            title={`${r.sensorId}: ${r.result}${r.severity ? ` (${r.severity})` : ''}${
              r.held ? ' — blocking' : ''
            }${explain ? ` — ${explain}` : ''}`}
            className={cn(
              'px-1 py-0 text-[9px] gap-0.5',
              RESULT_CLS[r.result] ?? RESULT_CLS.BLOCKED,
            )}
          >
            {/* A non-PASS advisory verdict is easy to miss as just a colour;
                a leading marker makes "needs a look" scannable in the row. */}
            {attention && !r.held && <span aria-hidden>⚠</span>}
            {r.sensorId}
            {r.held && <span className="font-semibold">· blocking</span>}
          </Badge>
        );
      })}
    </span>
  );
}
