import { describe, expect, it } from 'vitest';
import { formatBytes, formatCount, formatUsageBreakdown } from './format';

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

describe('formatUsageBreakdown', () => {
  const labels = (r: ReturnType<typeof formatUsageBreakdown>) =>
    r.parts.map((p) => `${p.label} ${p.text}`);

  it('labels input as uncached and totals every component when cache reads exist', () => {
    const r = formatUsageBreakdown({
      input: 27,
      output: 2000,
      cacheRead: 180_000,
      cacheWrite: 12_000,
    });
    expect(labels(r)).toEqual([
      'Uncached input 27',
      'Output 2.0K',
      'Cache reads 180.0K',
      'Cache writes 12.0K',
      'Total 194.0K',
    ]);
  });

  it('labels plain input when there are no cache reads', () => {
    const r = formatUsageBreakdown({ input: 1500, output: 500 });
    expect(labels(r)).toEqual(['Input 1.5K', 'Output 500', 'Total 2.0K']);
  });

  it('keeps cache writes without cache reads under the plain input label', () => {
    const r = formatUsageBreakdown({ input: 100, output: 50, cacheRead: 0, cacheWrite: 10 });
    expect(labels(r)).toEqual(['Input 100', 'Output 50', 'Cache writes 10', 'Total 160']);
  });

  it('never shows a Total equal to a single component', () => {
    const r = formatUsageBreakdown({ input: 0, output: 2000 });
    expect(labels(r)).toEqual(['Input 0', 'Output 2.0K']);
  });

  it('omits missing or non-finite components', () => {
    expect(formatUsageBreakdown({ output: 42 }).parts.map((p) => p.key)).toEqual(['output']);
    expect(formatUsageBreakdown({ input: Number.NaN }).parts).toEqual([]);
  });
});
