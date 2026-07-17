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
