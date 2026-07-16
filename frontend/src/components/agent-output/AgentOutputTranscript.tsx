import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  FilePenLine,
  FileText,
  Files,
  HelpCircle,
  MessageCircle,
  Terminal,
  Wrench,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { IntentOutput, IntentOutputDisplay } from '@/services/intents';

const outputTimeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

interface ProgressEntry {
  row: IntentOutput;
  display: IntentOutputDisplay;
}

function formatOutputTime(timestamp: string): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? '' : outputTimeFormatter.format(date);
}

function outputTimeTitle(timestamp: string): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? timestamp : date.toISOString();
}

function isLegacyPatchLine(row: IntentOutput): boolean {
  return !row.display && /^\s*[+-]\s*\d+:\s?/.test(row.content);
}

function patchDelta(content: string): string {
  const lines = content.split(/\r?\n/);
  const additions = lines.filter((line) => /^\s*\+\s*\d+:\s?/.test(line)).length;
  const deletions = lines.filter((line) => /^\s*-\s*\d+:\s?/.test(line)).length;
  if (!additions && !deletions) return '';
  if (additions && !deletions) return `+${additions} ${additions === 1 ? 'line' : 'lines'}`;
  if (!additions && deletions) return `-${deletions} ${deletions === 1 ? 'line' : 'lines'}`;
  return `+${additions}/-${deletions} lines`;
}

function coalesceLegacyPatchRows(rows: IntentOutput[]): IntentOutput[] {
  const result: IntentOutput[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const first = rows[index];
    if (!isLegacyPatchLine(first)) {
      result.push(first);
      continue;
    }
    const patchRows = [first];
    while (index + 1 < rows.length && isLegacyPatchLine(rows[index + 1])) {
      patchRows.push(rows[index + 1]);
      index += 1;
    }
    const content = patchRows.map((row) => row.content).join('');
    result.push({
      ...first,
      content,
      display: {
        type: 'edit',
        level: 'info',
        title: `Updated (${patchDelta(content)})`,
        details: content.trim(),
        hiddenByDefault: false,
      },
    });
  }
  return result;
}

function cleanProgressText(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*>\s?/, '').replace(/^\s*[\u2713\u2714]\s*/, ''))
    .join('\n')
    .trim();
}

function basenameish(value: string): string {
  const clean = value.trim().replace(/\/+$/, '');
  return clean.split('/').filter(Boolean).pop() || clean;
}

function nativeReadPath(entry: ProgressEntry): string {
  if (entry.display.type !== 'message') return '';
  const text = cleanProgressText(entry.display.summary || entry.row.content);
  return (
    text
      .match(/^Reading file:\s*(.+?)(?:,\s*all lines)?\s*\(using tool:\s*read\)(?:\n|$)/i)?.[1]
      ?.trim() ?? ''
  );
}

function nativeWriteInfo(entry: ProgressEntry): { action: string; path: string } | null {
  if (entry.display.type !== 'message') return null;
  const text = cleanProgressText(entry.display.summary || entry.row.content);
  const match = text.match(
    /^I'll\s+(create|update|modify|edit|write)\s+the following file:\s*(.+?)(?:\s+\(using tool:\s*(?:write|edit)\))?$/i,
  );
  if (!match?.[2]) return null;
  const operation = match[1].toLowerCase();
  return {
    action: operation === 'create' ? 'Created' : operation === 'write' ? 'Wrote' : 'Updated',
    path: match[2].trim(),
  };
}

function isNativeWriteStatus(entry: ProgressEntry, path: string): boolean {
  if (entry.display.type !== 'message') return false;
  const text = cleanProgressText(entry.display.summary || entry.row.content);
  const match = text.match(/^(?:Creating|Updating|Writing):\s*(.+)$/i);
  return !!match?.[1] && basenameish(match[1]) === basenameish(path);
}

function coalesceNativeFsRows(entries: ProgressEntry[]): ProgressEntry[] {
  const result: ProgressEntry[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const readPath = nativeReadPath(entry);
    if (readPath) {
      const bytes = entry.row.content.match(/Successfully read\s+(\d+)\s+bytes?/i)?.[1];
      result.push({
        row: entry.row,
        display: {
          type: 'batch_read',
          level: 'info',
          title: `Read: ${basenameish(readPath)}`,
          ...(bytes ? { summary: `${bytes} bytes` } : {}),
        },
      });
      continue;
    }

    const write = nativeWriteInfo(entry);
    const edit = write ? entries[index + 1] : null;
    if (write && edit?.display.type === 'edit') {
      const status = entries[index + 2];
      const hasStatus = !!status && isNativeWriteStatus(status, write.path);
      const delta = patchDelta(edit.row.content);
      const details = [entry.row.content, edit.row.content, hasStatus ? status.row.content : '']
        .filter(Boolean)
        .map((part) => part.trim())
        .join('\n');
      result.push({
        row: {
          ...edit.row,
          timestamp: entry.row.timestamp,
        },
        display: {
          ...edit.display,
          title: `${write.action}: ${basenameish(write.path)}${delta ? ` (${delta})` : ''}`,
          details,
        },
      });
      index += hasStatus ? 2 : 1;
      continue;
    }

    result.push(entry);
  }
  return result;
}

function lifecycleStatuses(text: string): string[] {
  const clean = cleanProgressText(text);
  const statuses: string[] = [];
  if (/\bparked\b/i.test(clean)) statuses.push('Parked');
  const answer = clean.match(/\banswered\s+["']([^"']+)["']/i)?.[1];
  if (answer) statuses.push(`Answered: ${answer}`);
  if (/\bresum(?:e|ed|ing)\b/i.test(clean)) statuses.push('Resumed');
  return statuses;
}

function coalesceQuestionLifecycle(entries: ProgressEntry[]): ProgressEntry[] {
  const result: ProgressEntry[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.display.type !== 'question') {
      result.push(entry);
      continue;
    }

    const statuses: string[] = [];
    const details = [entry.row.content.trim()];
    let cursor = index + 1;
    while (cursor < entries.length) {
      const candidate = entries[cursor];
      if (candidate.display.type !== 'message') break;
      const found = lifecycleStatuses(candidate.display.summary || candidate.row.content);
      if (!found.length) break;
      statuses.push(...found);
      details.push(candidate.row.content.trim());
      cursor += 1;
    }

    result.push({
      row: entry.row,
      display: {
        ...entry.display,
        ...(statuses.length ? { summary: [...new Set(statuses)].join('; ') } : {}),
        details: details.filter(Boolean).join('\n\n'),
      },
    });
    index = cursor - 1;
  }
  return result;
}

function progressEntries(rows: IntentOutput[]): ProgressEntry[] {
  const visible = coalesceLegacyPatchRows(rows)
    .map((row) => ({ row, display: displayForProgressRow(row) }))
    .filter(({ display }) => !display.hiddenByDefault);
  return coalesceQuestionLifecycle(coalesceNativeFsRows(visible));
}

export function AgentOutputTranscript({
  rows,
  loading = false,
  hasRaw = false,
}: {
  rows: IntentOutput[];
  loading?: boolean;
  hasRaw?: boolean;
}) {
  const visibleRows = progressEntries(rows);
  if (visibleRows.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        {loading
          ? 'Loading output...'
          : hasRaw
            ? 'Routine tool output is hidden in Progress.'
            : 'Waiting for output...'}
      </p>
    );
  }
  return (
    <div className="space-y-1">
      {visibleRows.map(({ row, display }, index) => (
        <ProgressRow key={`${row.seq}-${index}`} row={row} display={display} />
      ))}
    </div>
  );
}

function ProgressRow({ row, display }: { row: IntentOutput; display: IntentOutputDisplay }) {
  const Icon = iconForDisplay(display);
  const isProblem = display.level === 'error' || display.level === 'warning';
  const isSuccess = display.level === 'success';
  const isNarration = display.type === 'message' && !isProblem;
  const body = cleanProgressText(display.title || display.summary || row.content);
  const formattedTime = formatOutputTime(row.timestamp);
  return (
    <div
      data-output-type={display.type}
      data-output-level={display.level ?? 'info'}
      className={cn(
        'px-2.5 py-2',
        isNarration ? 'rounded-sm hover:bg-muted/30' : 'rounded-md border bg-background',
        isProblem && 'border-destructive/40 bg-destructive/5',
        isSuccess && 'border-emerald-500/30 bg-emerald-500/5',
      )}
    >
      <div className="flex min-w-0 items-start gap-2">
        <Icon
          className={cn(
            'mt-0.5 h-3.5 w-3.5 shrink-0',
            isProblem
              ? 'text-destructive'
              : isSuccess
                ? 'text-emerald-600 dark:text-emerald-400'
                : 'text-muted-foreground',
          )}
        />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-start justify-between gap-3">
            {isNarration ? (
              <div className="prose prose-sm max-w-none min-w-0 break-words text-xs leading-snug dark:prose-invert [&_code]:text-[11px] [&_p]:my-0 [&_p]:leading-snug">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{body}</ReactMarkdown>
              </div>
            ) : (
              <div className="min-w-0 whitespace-pre-wrap break-words text-xs font-medium leading-snug">
                {body}
              </div>
            )}
            {formattedTime && (
              <time
                dateTime={row.timestamp}
                title={outputTimeTitle(row.timestamp)}
                className="shrink-0 whitespace-nowrap font-mono text-[10px] tabular-nums text-muted-foreground/70"
              >
                {formattedTime}
              </time>
            )}
          </div>
          {display.summary && cleanProgressText(display.summary) !== body && (
            <div className="mt-0.5 whitespace-pre-wrap break-words text-[11px] text-muted-foreground">
              {cleanProgressText(display.summary)}
            </div>
          )}
        </div>
      </div>
      {display.details && (
        <details className="group mt-2" open={isProblem}>
          <summary className="flex cursor-pointer list-none items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground">
            <ChevronDown className="h-3 w-3 transition-transform group-open:rotate-180" />
            Details
          </summary>
          <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/60 p-2 font-mono text-[11px] leading-relaxed">
            {display.details}
          </pre>
        </details>
      )}
    </div>
  );
}

function displayForProgressRow(row: IntentOutput): IntentOutputDisplay {
  const display = row.display ? { ...row.display } : legacyDisplayFor(row);
  const clean = cleanProgressText(display.title || display.summary || row.content);

  if (display.type === 'artifact') {
    const isCreated = /^Created artifact:/i.test(display.title ?? '');
    const keys = isCreated ? ['title', 'id', 'artifactId', 'artifactType'] : ['id', 'artifactId'];
    const label = extractLegacyParam(row.content, keys);
    if (label && (isCreated || display.title?.match(/:\s*artifact$/i))) {
      display.title = `${isCreated ? 'Created artifact' : 'Loaded artifact'}: ${label}`;
    }
  }

  if (display.type === 'question' && !/^Question:/i.test(display.title ?? '')) {
    const question = extractLegacyParam(row.content, ['text', 'question']);
    if (question) display.title = `Question: ${question}`;
  }

  if (display.type === 'edit') {
    const target = extractLegacyParam(row.content, [
      'path',
      'file',
      'file_path',
      'filePath',
      'filename',
    ]);
    const delta = patchDelta(row.content);
    let action = '';
    if (/\bFile created successfully\b|\bCreating:\s/i.test(row.content)) action = 'Created';
    else if (/^Running tool (?:fs_)?write\b/im.test(row.content)) action = 'Wrote';
    if (action && target) display.title = `${action}: ${basenameish(target)}`;
    if (delta && display.title && !display.title.includes(`(${delta})`)) {
      display.title = `${display.title} (${delta})`;
    }
  }

  if (
    display.type === 'message' &&
    (/^Stage complete\b/i.test(clean) ||
      /^Local \S+ cold resume completed\.?$/i.test(clean) ||
      /\bfinished successfully\.?$/i.test(clean))
  ) {
    return {
      ...display,
      type: 'system',
      level: 'success',
      title: clean,
      summary: undefined,
    };
  }

  if (display.type === 'message') {
    display.summary = cleanProgressText(display.summary || row.content);
  }
  return display;
}

function legacyDisplayFor(row: IntentOutput): IntentOutputDisplay {
  const text = row.content.trim();
  if (isLegacyStructuralNoise(text)) {
    return {
      type: 'raw',
      level: 'info',
      summary: text || row.kind,
      hiddenByDefault: true,
    };
  }
  return {
    type: 'message',
    level: 'info',
    summary: cleanProgressText(text) || row.kind,
  };
}

function isLegacyStructuralNoise(text: string): boolean {
  if (!text) return true;
  if (/^stdout$/i.test(text)) return true;
  if (/^Running tool\b/i.test(text)) return true;
  if (/^[-\s]*(Completed|Failed|Errored|Error)\b/i.test(text)) return true;
  const stripped = text.replace(/^[.:…⋮\s]+/, '').trim();
  if (/^[{}[\],]+$/.test(stripped)) return true;
  if (/^"[^"]+"\s*:/.test(stripped)) return true;
  if (/^[{[]\s*"[^"]+"\s*:/.test(stripped)) return true;
  return false;
}

function extractLegacyParam(text: string, keys: string[]): string {
  for (const key of keys) {
    const quoted = new RegExp(`["']${key}["']\\s*:\\s*["']([^"']+)["']`, 'i').exec(text);
    if (quoted?.[1]) return quoted[1];
    const bare = new RegExp(`\\b${key}\\b\\s*:\\s*([^,}\\]\\s]+)`, 'i').exec(text);
    if (bare?.[1]) return bare[1].replace(/^["']|["']$/g, '');
  }
  return '';
}

function iconForDisplay(display: IntentOutputDisplay) {
  if (display.level === 'error' || display.level === 'warning') return AlertTriangle;
  if (display.level === 'success') return CheckCircle2;
  if (display.type === 'tool') return Wrench;
  if (display.type === 'edit') return FilePenLine;
  if (display.type === 'batch_read') return Files;
  if (display.type === 'artifact') return FileText;
  if (display.type === 'question') return HelpCircle;
  if (display.type === 'raw') return Terminal;
  return MessageCircle;
}
