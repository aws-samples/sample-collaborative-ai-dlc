import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { IntentSensorRun } from '@/services/intents';

// Sensor result → chip styling. `held: true` marks a blocking failure — the
// run is held on it — so it gets the loudest treatment.
const RESULT_CLS: Record<string, string> = {
  PASS: 'bg-agent-success/15 text-agent-success border-agent-success/30',
  FAIL: 'bg-agent-error/15 text-agent-error border-agent-error/30',
  INCONCLUSIVE: 'bg-agent-waiting/15 text-agent-waiting border-agent-waiting/30',
  BLOCKED: 'bg-muted/50 text-muted-foreground border-transparent',
};

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
      {latest.map((r) => (
        <Badge
          key={r.sensorRunId}
          variant="outline"
          title={`${r.sensorId}: ${r.result}${r.severity ? ` (${r.severity})` : ''}${r.held ? ' — blocking' : ''}`}
          className={cn('px-1 py-0 text-[9px] gap-0.5', RESULT_CLS[r.result] ?? RESULT_CLS.BLOCKED)}
        >
          {r.sensorId}
          {r.held && <span className="font-semibold">· blocking</span>}
        </Badge>
      ))}
    </span>
  );
}
