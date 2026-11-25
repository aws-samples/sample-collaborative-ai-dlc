import { describe, expect, it } from 'vitest';
import { formatBytes, formatCount } from './format';

describe('formatBytes', () => {
  it('formats bytes with 1024-based units, one decimal (UsageMetrics format)', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1023)).toBe('1\u202f023 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatBytes(3.25 * 1024 ** 3)).toBe('3.3 GB');
    expect(formatBytes(2 * 1024 ** 4)).toBe('2.0 TB');
    expect(formatBytes(2048 * 1024 ** 4)).toBe('2048.0 TB');
  });

  it('handles negatives and non-finite values', () => {
    expect(formatBytes(-2048)).toBe('-2.0 KB');
    expect(formatBytes(Number.NaN)).toBe('—');
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

describe('formatCount', () => {
  it('groups thousands with a narrow no-break space', () => {
    expect(formatCount(0)).toBe('0');
    expect(formatCount(999)).toBe('999');
    expect(formatCount(1234)).toBe('1\u202f234');
    expect(formatCount(1_234_567)).toBe('1\u202f234\u202f567');
    expect(formatCount(-1234)).toBe('-1\u202f234');
  });

  it('rounds to an integer and guards non-finite values', () => {
    expect(formatCount(12.6)).toBe('13');
    expect(formatCount(Number.NaN)).toBe('—');
  });
});
