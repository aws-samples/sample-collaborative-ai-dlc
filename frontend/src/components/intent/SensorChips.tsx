import { forwardRef, type HTMLAttributes, type ReactNode } from 'react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { humanizeSlug } from '@/lib/displayNames';
import { TONE_CLASSES, deriveSensorStatus, getStatus, type StatusTone } from '@/lib/statusModel';
import { redactRenderedDiagnostic } from '@/components/intent/SensorDiagnostics';
import type { IntentSensorRun, SensorDetail } from '@/services/intents';

// A non-PASS verdict is worth the reader's attention even when it did not hold
// the stage (advisory INCONCLUSIVE/FAIL). Used to mark the chip and drive the
// detail explanation.
export function sensorNeedsAttention(r: IntentSensorRun): boolean {
  return r.result !== 'PASS';
}

// Condense a sensor's structured `detail` into a short human explanation, the
// same shapes the backend summarizer handles: missing artifacts, unreferenced
// upstreams, an error, or a bare reason. A `script` sensor reports once per
// matching file, so its detail is an aggregate and the reason sits on the entry
// that produced the result — mirrors `lambda/shared/sensor-verdict.js`, which
// reads only the `reason` and `file` of an entry (the rest is the script's own
// output). Returns null when there is nothing terse worth showing.
// Same ceiling as `MAX_SENSOR_REASON_LENGTH` in `lambda/shared/sensor-verdict.js`.
// Text is redacted on the way out: a per-file reason is the script's own stdout.
const MAX_SENSOR_REASON_LENGTH = 500;
const bounded = (value: unknown) => redactRenderedDiagnostic(value, MAX_SENSOR_REASON_LENGTH);

// The runner groups a harness failure (`script-error` / `tool-unavailable`) out
// of `files[]` into `harnessFailures[]`, so when every failing file hit the same
// harness problem the only reason available sits on the group. Flatten both into
// one candidate list, the script's own per-file reasons first.
type ReasonCandidate = { file: string | null; result?: string; reason: unknown };

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

function pickReasonCandidate(detail: SensorDetail, result?: string): ReasonCandidate | undefined {
  const files = (Array.isArray(detail.files) ? detail.files : [])
    .filter((f) => f && typeof f === 'object' && f.result !== 'PASS')
    .map((f) => ({
      file: text(f.file) || null,
      result: f.result,
      reason: f.detail?.reason,
      notApplicable: f.detail?.notApplicable === true,
    }));
  const harness = (Array.isArray(detail.harnessFailures) ? detail.harnessFailures : [])
    .filter((g) => g && typeof g === 'object' && g.result !== 'PASS')
    .map((g) => ({
      file: text(g.sampleFiles?.[0]) || null,
      result: g.result,
      reason: g.reason,
      notApplicable: false,
    }));
  const candidates = [...files, ...harness];
  // An entry that only says "nothing to inspect here" explains nothing, and one
  // that timed out silently ahead of the file that failed must not hide it — so
  // it is the last resort, not a filter.
  const applicable = candidates.filter((c) => !c.notApplicable);
  return (
    applicable.find((c) => c.result === result && text(c.reason)) ?? applicable[0] ?? candidates[0]
  );
}

export function summarizeSensorDetail(detail: SensorDetail | null, result?: string): string | null {
  if (!detail || typeof detail !== 'object') return null;
  const missing = Array.isArray(detail.artifacts)
    ? detail.artifacts.filter((a) => a?.reason === 'not found in graph').map((a) => a.artifact)
    : [];
  if (missing.length) {
    return redactRenderedDiagnostic(`missing: ${missing.join(', ')}`);
  }
  if (Array.isArray(detail.unreferenced) && detail.unreferenced.length) {
    return redactRenderedDiagnostic(`unreferenced: ${detail.unreferenced.join(', ')}`);
  }
  if (typeof detail.error === 'string' && detail.error) return bounded(detail.error);
  // The top level WINS whenever it carries any explanatory field — that is the
  // `graph` shape and the runner's own `{ error }` verdicts, which must read
  // exactly as before. Only an aggregate-only detail falls through to the
  // per-file entries.
  const explains =
    detail.reason !== undefined ||
    detail.artifact !== undefined ||
    detail.error !== undefined ||
    detail.notApplicable !== undefined;
  const entry = explains ? undefined : pickReasonCandidate(detail, result);
  if (!entry) return detail.reason ? bounded(detail.reason) : null;
  const reason = typeof entry.reason === 'string' ? entry.reason.trim() : '';
  if (!reason) return null;
  return bounded(entry.file ? `${entry.file}: ${reason}` : reason);
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

function sensorLine(run: IntentSensorRun): string {
  const explain = summarizeSensorDetail(run.detail, run.result);
  return explain ? `${humanizeSlug(run.sensorId)} — ${explain}` : humanizeSlug(run.sensorId);
}

function SensorTooltip({ children, lines }: { children: ReactNode; lines: string[] }) {
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent className="max-w-xs space-y-1">
          {lines.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

const Pill = forwardRef<
  HTMLSpanElement,
  { tone: StatusTone; focusable?: boolean } & HTMLAttributes<HTMLSpanElement>
>(function Pill({ tone, focusable = true, className, children, ...props }, ref) {
  return (
    <span
      ref={ref}
      data-tone={tone}
      tabIndex={focusable ? 0 : undefined}
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-2xs font-medium',
        'cursor-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        TONE_CLASSES[tone].pill,
        className,
      )}
      {...props}
    >
      <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" />
      {children}
    </span>
  );
});

// Latest verdict per sensor. `summary` is for a collapsed row and shows only
// what holds the stage: one "1 blocking check" pill, nothing otherwise
// (advisory misses are listed in the stage detail). The full mode names every
// sensor with its registry status.
export function SensorChips({
  runs,
  summary = false,
  className,
}: {
  runs: IntentSensorRun[];
  summary?: boolean;
  className?: string;
}) {
  const latest = latestSensorRuns(runs);
  if (latest.length === 0) return null;

  if (summary) {
    const blocking = latest.filter((r) => sensorNeedsAttention(r) && r.held);
    if (blocking.length === 0) return null;
    const entry = getStatus('sensor', 'blocking');
    // The row is itself a button: no tab stop or tooltip inside it, the names
    // go in `title` (the stage detail lists them in full).
    return (
      <Pill
        tone={entry.tone}
        focusable={false}
        title={[...blocking.map(sensorLine), entry.help].join('\n')}
        className={className}
      >
        {blocking.length} blocking check{blocking.length === 1 ? '' : 's'}
      </Pill>
    );
  }

  return (
    <span className={cn('inline-flex flex-wrap items-center gap-1', className)}>
      {latest.map((r) => {
        const entry = getStatus('sensor', deriveSensorStatus(r));
        const explain = summarizeSensorDetail(r.detail, r.result);
        return (
          <SensorTooltip key={r.sensorRunId} lines={[explain ?? entry.label, entry.help]}>
            <Pill tone={entry.tone}>
              <span>{humanizeSlug(r.sensorId)}</span>
              <span className="font-normal opacity-80">{entry.label}</span>
            </Pill>
          </SensorTooltip>
        );
      })}
    </span>
  );
}
