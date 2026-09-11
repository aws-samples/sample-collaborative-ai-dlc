import { Badge } from '@/components/ui/badge';
import type { SensorDetail, SensorFileDiagnostic, SensorHarnessFailure } from '@/services/intents';

const REDACTED = '[REDACTED]';
const TRUNCATION_MARKER = '… [truncated]';

export const SENSOR_DIAGNOSTIC_LIMITS = Object.freeze({
  harnessFailures: 20,
  fileResults: 100,
  sampleFiles: 5,
  inlineTextChars: 512,
  reasonChars: 256,
  diagnosticTextChars: 4096,
  pathChars: 512,
  omissionReasonChars: 256,
  redactionLookaheadChars: 1024,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

// Sensor details are redacted before persistence. Keep a second, deliberately
// conservative display boundary for old rows and mixed-version deployments:
// only allowlisted fields are rendered, credential-shaped text is masked, and
// even malformed legacy strings are processed and rendered within fixed caps.
export function redactRenderedDiagnostic(
  value: unknown,
  maxLength: number = SENSOR_DIAGNOSTIC_LIMITS.inlineTextChars,
): string | null {
  if (typeof value !== 'string') return null;
  const requestedLimit = Number.isSafeInteger(maxLength)
    ? maxLength
    : SENSOR_DIAGNOSTIC_LIMITS.inlineTextChars;
  const boundedLength = Math.min(
    SENSOR_DIAGNOSTIC_LIMITS.diagnosticTextChars,
    Math.max(TRUNCATION_MARKER.length, requestedLimit),
  );
  // Slice before regex processing so a malicious legacy payload cannot make
  // rendering perform unbounded work. The lookahead lets a credential beginning
  // at the visible boundary be consumed and redacted before the final trim.
  const text = value
    .slice(0, boundedLength + SENSOR_DIAGNOSTIC_LIMITS.redactionLookaheadChars)
    .trim();
  if (!text) return null;
  const redacted = text
    .replace(
      /(\bauthorization\b["']?\s*[:=]\s*["']?)(?:[^\s,;"']+\s+)?[^\s,;"']+/gi,
      `$1${REDACTED}`,
    )
    .replace(
      /(\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|passwd|secret|credential)\b["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      `$1${REDACTED}`,
    )
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, REDACTED)
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, REDACTED)
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)([^/\s@]+)@/gi, `$1${REDACTED}@`)
    .replace(
      /(?:\/(?:home|root|runtime|var\/run)\/[^\s:'"`]*(?:\.aws\/credentials|git-askpass|credential)[^\s:'"`]*)/gi,
      REDACTED,
    );
  if (redacted.length <= boundedLength) return redacted;
  return `${redacted.slice(0, boundedLength - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
}

function positiveCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function safeExitCode(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

function plural(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? '' : 's'}`;
}

function HarnessFailure({ failure }: { failure: SensorHarnessFailure }) {
  const reason =
    redactRenderedDiagnostic(failure.reason, SENSOR_DIAGNOSTIC_LIMITS.reasonChars) ??
    'Harness failure';
  const result = redactRenderedDiagnostic(failure.result, 64);
  const stderr = redactRenderedDiagnostic(
    failure.stderr,
    SENSOR_DIAGNOSTIC_LIMITS.diagnosticTextChars,
  );
  const fileCount = positiveCount(failure.fileCount);
  const exitCode = safeExitCode(failure.exitCode);
  const rawSampleFiles = Array.isArray(failure.sampleFiles) ? failure.sampleFiles : [];
  const sampleFiles = rawSampleFiles
    .slice(0, SENSOR_DIAGNOSTIC_LIMITS.sampleFiles)
    .map((file) => redactRenderedDiagnostic(file, SENSOR_DIAGNOSTIC_LIMITS.pathChars))
    .filter((file): file is string => Boolean(file));
  const sampleFilesOmitted = Math.max(0, rawSampleFiles.length - sampleFiles.length);

  return (
    <li className="rounded border border-agent-waiting/20 bg-background/60 p-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-medium text-foreground">{reason}</span>
        {result && <Badge variant="outline">{result}</Badge>}
        {fileCount && <span>{plural(fileCount, 'file')}</span>}
        {exitCode !== null && <span>exit {exitCode}</span>}
      </div>
      {sampleFiles.length > 0 && (
        <p className="mt-1 break-all font-mono text-[10px]">Samples: {sampleFiles.join(', ')}</p>
      )}
      {sampleFilesOmitted > 0 && (
        <p className="mt-1 text-[10px]">
          {plural(sampleFilesOmitted, 'additional sample')} hidden — frontend display limit.
        </p>
      )}
      {stderr && (
        <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/60 p-2 font-mono text-[10px] leading-relaxed text-foreground">
          {stderr}
        </pre>
      )}
    </li>
  );
}

function FileDiagnostic({ entry }: { entry: SensorFileDiagnostic }) {
  const file =
    redactRenderedDiagnostic(entry.file, SENSOR_DIAGNOSTIC_LIMITS.pathChars) ?? 'Unknown file';
  const result = redactRenderedDiagnostic(entry.result, 64);
  const reason = redactRenderedDiagnostic(
    entry.detail?.reason,
    SENSOR_DIAGNOSTIC_LIMITS.reasonChars,
  );
  const stderr = redactRenderedDiagnostic(
    entry.detail?.stderr,
    SENSOR_DIAGNOSTIC_LIMITS.diagnosticTextChars,
  );
  const exitCode = safeExitCode(entry.detail?.exitCode);

  return (
    <li className="rounded border bg-background/60 p-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="break-all font-mono text-[10px] text-foreground">{file}</span>
        {result && <Badge variant="outline">{result}</Badge>}
        {entry.timedOut === true && <span>timed out</span>}
        {exitCode !== null && <span>exit {exitCode}</span>}
        {reason && <span>{reason}</span>}
      </div>
      {stderr && (
        <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/60 p-2 font-mono text-[10px] leading-relaxed text-foreground">
          {stderr}
        </pre>
      )}
    </li>
  );
}

export function SensorDiagnostics({
  detail,
  sensorId,
}: {
  detail: SensorDetail | null;
  sensorId: string;
}) {
  if (!detail || typeof detail !== 'object') return null;

  const rawHarnessFailures = Array.isArray(detail.harnessFailures) ? detail.harnessFailures : [];
  const harnessFailures = rawHarnessFailures
    .slice(0, SENSOR_DIAGNOSTIC_LIMITS.harnessFailures)
    .filter(isRecord) as SensorHarnessFailure[];
  const harnessFailuresOmitted = Math.max(0, rawHarnessFailures.length - harnessFailures.length);

  const rawFiles = Array.isArray(detail.files) ? detail.files : [];
  const files = rawFiles
    .slice(0, SENSOR_DIAGNOSTIC_LIMITS.fileResults)
    .filter(isRecord) as unknown as SensorFileDiagnostic[];
  const fileResultsHidden = Math.max(0, rawFiles.length - files.length);

  const filesOmitted = positiveCount(detail.filesOmitted);
  const omissionReason = redactRenderedDiagnostic(
    detail.omissionReason,
    SENSOR_DIAGNOSTIC_LIMITS.omissionReasonChars,
  );
  if (
    harnessFailures.length === 0 &&
    files.length === 0 &&
    filesOmitted === null &&
    harnessFailuresOmitted === 0 &&
    fileResultsHidden === 0
  ) {
    return null;
  }

  const safeSensorId = redactRenderedDiagnostic(sensorId, 128) ?? 'sensor';
  return (
    <div
      className="mt-1.5 space-y-1.5 rounded-md border border-dashed px-2.5 py-2 text-[11px] text-muted-foreground"
      aria-label={`Bounded diagnostics for ${safeSensorId}`}
    >
      <p className="font-medium text-foreground">Harness diagnostics</p>
      {harnessFailures.length > 0 && (
        <ul className="space-y-1">
          {harnessFailures.map((failure, index) => (
            <HarnessFailure key={`harness-${index}`} failure={failure} />
          ))}
        </ul>
      )}
      {files.length > 0 && (
        <ul className="space-y-1">
          {files.map((entry, index) => (
            <FileDiagnostic key={`file-${index}`} entry={entry} />
          ))}
        </ul>
      )}
      {filesOmitted !== null && (
        <p className="rounded bg-muted/60 px-2 py-1" role="note">
          {plural(filesOmitted, 'file result')} omitted —{' '}
          {omissionReason ?? 'omission reason unavailable'}.
        </p>
      )}
      {harnessFailuresOmitted > 0 && (
        <p className="rounded bg-muted/60 px-2 py-1" role="note">
          {plural(harnessFailuresOmitted, 'additional harness failure group')} hidden — frontend
          display limit.
        </p>
      )}
      {fileResultsHidden > 0 && (
        <p className="rounded bg-muted/60 px-2 py-1" role="note">
          {plural(fileResultsHidden, 'additional file result')} hidden — frontend display limit.
        </p>
      )}
    </div>
  );
}
