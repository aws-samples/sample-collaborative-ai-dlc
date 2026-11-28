import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { formatAbsolute, formatAge, formatRelative, formatTimelineTimestamp } from './timeAgo';

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

describe('formatAbsolute', () => {
  it.each([
    ['2026-08-05T15:08:00Z', {}, '5 Aug 2026, 15:08'],
    [new Date('2026-09-05T03:04:00Z'), {}, '5 Sep 2026, 03:04'],
    [Date.parse('2026-12-31T23:59:00Z'), {}, '31 Dec 2026, 23:59'],
    ['2026-08-05T15:08:00Z', { timeZone: 'Europe/Paris' }, '5 Aug 2026, 17:08'],
    ['2026-08-05T23:30:00Z', { timeZone: 'Asia/Tokyo' }, '6 Aug 2026, 08:30'],
    ['2026-08-05T15:08:00Z', { includeTime: false }, '5 Aug 2026'],
    ['nope', {}, '—'],
    [null, {}, '—'],
  ])('%s %o → %s', (date, options, expected) => {
    expect(formatAbsolute(date, { timeZone: 'UTC', ...options })).toBe(expected);
  });
});

describe('formatAge', () => {
  const now = Date.parse('2026-11-22T12:00:00Z');

  it.each([
    ['2026-08-06T12:00:00Z', '108 days'],
    [now - 3 * 3_600_000 - 59 * 60_000, '3 hours'],
    [new Date(now - 2 * 60_000 - 5_000), '2 minutes'],
    [now - 86_400_000, '1 day'],
    [now - 60_000, '1 minute'],
    [now - 10_000, 'less than a minute'],
    [now + 60_000, 'less than a minute'],
    ['nope', '—'],
    [null, '—'],
  ])('%s → %s', (since, expected) => {
    expect(formatAge(since, now)).toBe(expected);
  });
});

describe('formatRelative', () => {
  const now = Date.parse('2026-11-22T12:00:00Z');

  it.each([
    [now - 30_000, {}, 'just now'],
    [now + 120_000, {}, 'just now'],
    [now - 5 * 60_000, {}, '5m ago'],
    [now - 3 * 3_600_000, {}, '3h ago'],
    [now - 29 * 86_400_000, {}, '29d ago'],
    ['2026-08-05T15:08:00Z', {}, '5 Aug 2026'],
    [now - 8 * 86_400_000, { absoluteAfterDays: 7 }, '14 Nov 2026'],
    [null, {}, '—'],
    ['nope', {}, '—'],
  ])('%s %o → %s', (date, options, expected) => {
    expect(formatRelative(date, { now, timeZone: 'UTC', ...options })).toBe(expected);
  });
});
