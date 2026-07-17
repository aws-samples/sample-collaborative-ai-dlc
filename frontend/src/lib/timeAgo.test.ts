import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { formatTimelineTimestamp } from './timeAgo';

const NOW = new Date(2026, 6, 16, 14, 32, 0, 0);

describe('formatTimelineTimestamp', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns "just now" for an invalid timestamp', () => {
    expect(formatTimelineTimestamp('not-a-date')).toBe('just now');
  });

  it('returns "just now" for a timestamp less than 1 minute ago', () => {
    const ts = new Date(NOW.getTime() - 59_000).toISOString();
    expect(formatTimelineTimestamp(ts)).toBe('just now');
  });

  it('returns "Xm ago" for a timestamp in the minutes range', () => {
    const ts = new Date(NOW.getTime() - 5 * 60_000).toISOString();
    expect(formatTimelineTimestamp(ts)).toBe('5m ago');
  });

  it('returns "Xh ago" for a timestamp in the hours range', () => {
    const ts = new Date(NOW.getTime() - 3 * 3_600_000).toISOString();
    expect(formatTimelineTimestamp(ts)).toBe('3h ago');
  });

  it('returns "DD MMM - HH:mm" for a timestamp exactly 24h ago', () => {
    const past = new Date(NOW.getTime() - 86_400_000);
    const day = String(past.getDate()).padStart(2, '0');
    const hours = String(past.getHours()).padStart(2, '0');
    const minutes = String(past.getMinutes()).padStart(2, '0');
    const months = [
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec',
    ];
    const month = months[past.getMonth()];
    expect(formatTimelineTimestamp(past.toISOString())).toBe(
      `${day} ${month} - ${hours}:${minutes}`,
    );
  });

  it('returns "DD MMM - HH:mm" for an older date with zero-padded values', () => {
    const past = new Date(2026, 6, 1, 9, 5, 0, 0);
    expect(formatTimelineTimestamp(past.toISOString())).toBe('01 Jul - 09:05');
  });
});
