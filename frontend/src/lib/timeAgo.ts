export function getTimeAgo(timestamp: string): string {
  const diff = Date.now() - new Date(timestamp).getTime();
  if (!Number.isFinite(diff) || diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Timeline-only formatter.
 * - Invalid / < 1 min  → "just now"
 * - 1 min – 23h 59m    → "Xm ago" / "Xh ago"
 * - ≥ 24 h             → "DD MMM - HH:mm"  (local time, zero-padded)
 */
export function formatTimelineTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  const diff = Date.now() - date.getTime();
  if (!Number.isFinite(diff) || diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  const day = String(date.getDate()).padStart(2, '0');
  const month = MONTHS[date.getMonth()];
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${day} ${month} - ${hours}:${minutes}`;
}

type DateInput = Date | string | number | null | undefined;

function toTime(value: DateInput): number {
  if (value == null) return Number.NaN;
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

const DATE_PART_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function datePartFormatter(timeZone: string | undefined): Intl.DateTimeFormat {
  const key = timeZone ?? '';
  let formatter = DATE_PART_FORMATTERS.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', {
      day: 'numeric',
      month: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZone,
    });
    DATE_PART_FORMATTERS.set(key, formatter);
  }
  return formatter;
}

export interface FormatAbsoluteOptions {
  /** IANA zone; defaults to the browser zone. Pass one in tests for stable output. */
  timeZone?: string;
  /** Append ", HH:mm" (default true). */
  includeTime?: boolean;
}

/**
 * Unambiguous absolute timestamp, en-GB order with a fixed month table:
 * "5 Aug 2026, 15:08" (or "5 Aug 2026" without time). Invalid / missing → "—".
 * Intended for tooltips and `<time>` titles next to relative times.
 */
export function formatAbsolute(date: DateInput, options: FormatAbsoluteOptions = {}): string {
  const time = toTime(date);
  if (!Number.isFinite(time)) return '—';
  const parts: Record<string, string> = {};
  for (const part of datePartFormatter(options.timeZone).formatToParts(time)) {
    parts[part.type] = part.value;
  }
  const day = `${Number(parts.day)} ${MONTHS[Number(parts.month) - 1]} ${parts.year}`;
  if (options.includeTime === false) return day;
  return `${day}, ${parts.hour}:${parts.minute}`;
}

const AGE_UNITS: [ms: number, unit: string][] = [
  [86_400_000, 'day'],
  [3_600_000, 'hour'],
  [60_000, 'minute'],
];

/**
 * Elapsed time in the largest whole unit, spelled out: "108 days", "3 hours",
 * "1 minute", "less than a minute". For "waiting for 3 hours" / "no activity
 * for 2 days" copy. Future timestamps (clock skew) read as less than a minute.
 */
export function formatAge(since: DateInput, now: DateInput = Date.now()): string {
  const diff = toTime(now) - toTime(since);
  if (!Number.isFinite(diff)) return '—';
  for (const [ms, unit] of AGE_UNITS) {
    const count = Math.floor(diff / ms);
    if (count >= 1) return `${count} ${unit}${count === 1 ? '' : 's'}`;
  }
  return 'less than a minute';
}

export interface FormatRelativeOptions extends Omit<FormatAbsoluteOptions, 'includeTime'> {
  now?: DateInput;
  /** At or beyond this many days, show the absolute date instead (default 30). */
  absoluteAfterDays?: number;
}

/**
 * Compact relative time ("just now", "5m ago", "3h ago", "12d ago") that turns
 * into an absolute date ("5 Aug 2026") once older than `absoluteAfterDays`, so
 * one column never mixes "1d ago" with a locale date string. Missing / invalid
 * → "—"; future timestamps → "just now".
 */
export function formatRelative(date: DateInput, options: FormatRelativeOptions = {}): string {
  const { now = Date.now(), absoluteAfterDays = 30, timeZone } = options;
  const diff = toTime(now) - toTime(date);
  if (!Number.isFinite(diff)) return '—';
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  const days = Math.floor(diff / 86_400_000);
  if (days < absoluteAfterDays) return `${days}d ago`;
  return formatAbsolute(date, { timeZone, includeTime: false });
}
