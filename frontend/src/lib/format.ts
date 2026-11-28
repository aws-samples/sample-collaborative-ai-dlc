// Shared number formatting for the UI. One implementation per concept so the
// same value reads identically on every screen (usage cards, audit, compose).

import { formatTokens } from './metricAggregation';

const NARROW_NBSP = '\u202f';

/**
 * Integer count with thousands grouped by a narrow no-break space (SI style,
 * unambiguous for English and French readers): 1234 → "1 234". Rounds to an
 * integer; non-finite → "—".
 */
export function formatCount(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const rounded = Math.round(n);
  const digits = String(Math.abs(rounded)).replace(/\B(?=(\d{3})+(?!\d))/g, NARROW_NBSP);
  return rounded < 0 ? `-${digits}` : digits;
}

const BYTE_UNITS = ['KB', 'MB', 'GB', 'TB'];

/**
 * Byte size with 1024-based units and one decimal: 512 → "512 B",
 * 1536 → "1.5 KB", 5 MiB → "5.0 MB". Non-finite → "—".
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return '—';
  if (Math.abs(bytes) < 1024) return `${formatCount(bytes)} B`;
  let value = bytes / 1024;
  let unit = BYTE_UNITS[0];
  for (let index = 1; index < BYTE_UNITS.length && Math.abs(value) >= 1024; index += 1) {
    value /= 1024;
    unit = BYTE_UNITS[index];
  }
  return `${value.toFixed(1)} ${unit}`;
}

export interface UsageTokens {
  input?: number | null;
  output?: number | null;
  cacheRead?: number | null;
  cacheWrite?: number | null;
}

export type UsagePartKey = 'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'total';

export interface UsagePart {
  key: UsagePartKey;
  label: string;
  value: number;
  /** Compact token count, e.g. "2.0K". */
  text: string;
}

const known = (n: number | null | undefined): n is number =>
  typeof n === 'number' && Number.isFinite(n);

/**
 * Labeled token breakdown that cannot mislead:
 * - with cache reads, the input count is only the uncached part, so it is
 *   labeled "Uncached input" and the total includes cache reads and writes;
 * - cache rows appear only when non-zero;
 * - "Total" appears only when at least two components are non-zero, so it is
 *   never equal to a single component ("Output 2.0K · Total 2.0K").
 */
export function formatUsageBreakdown(tokens: UsageTokens): { parts: UsagePart[] } {
  const { input, output, cacheRead, cacheWrite } = tokens;
  const hasCacheReads = known(cacheRead) && cacheRead > 0;
  const candidates: [UsagePartKey, string, number | null | undefined, boolean][] = [
    ['input', hasCacheReads ? 'Uncached input' : 'Input', input, true],
    ['output', 'Output', output, true],
    ['cacheRead', 'Cache reads', cacheRead, false],
    ['cacheWrite', 'Cache writes', cacheWrite, false],
  ];
  const parts: UsagePart[] = [];
  for (const [key, label, value, showZero] of candidates) {
    if (!known(value) || (!showZero && value === 0)) continue;
    parts.push({ key, label, value, text: formatTokens(value) });
  }
  if (parts.filter((part) => part.value !== 0).length >= 2) {
    const total = parts.reduce((sum, part) => sum + part.value, 0);
    parts.push({ key: 'total', label: 'Total', value: total, text: formatTokens(total) });
  }
  return { parts };
}
