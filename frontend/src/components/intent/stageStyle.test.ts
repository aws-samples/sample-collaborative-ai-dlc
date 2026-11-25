import { describe, expect, it } from 'vitest';
import { formatDuration, stageDurations } from './stageStyle';

describe('stage durations', () => {
  it('formats long waits in days rather than thousands of hours', () => {
    expect(formatDuration('2026-01-01T00:00:00Z', '2026-05-17T10:04:00Z')).toBe('136d 10h');
  });

  it('uses the same compact day format for the active and waiting breakdown', () => {
    const duration = stageDurations({
      startedAt: '2026-01-01T00:00:00Z',
      completedAt: '2026-05-17T10:04:00Z',
      waitMs: 136 * 86_400_000 + 10 * 3_600_000,
    });
    expect(duration).toMatchObject({
      total: '136d 10h',
      active: '4m 0s',
      waiting: '136d 10h',
    });
  });
});
