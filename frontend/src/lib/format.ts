// Shared number formatting for the UI. One implementation per concept so the
// same value reads identically on every screen (usage cards, audit, compose).

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
