import { describe, it, expect } from 'vitest';
import { orderReviewerRuns, reviewerRunVerdict } from './StageReviewPanel';
import type { IntentSensorRun } from '@/services/intents';

const run = (over: Partial<IntentSensorRun> = {}): IntentSensorRun =>
  ({
    sensorRunId: 'sr-1',
    stageInstanceId: 'si-1',
    sensorId: 'reviewer:architecture',
    result: 'PASS',
    severity: 'info',
    held: false,
    detail: null,
    timestamp: '2026-01-01T00:00:00Z',
    ...over,
  }) as IntentSensorRun;

describe('orderReviewerRuns', () => {
  it('orders parseable timestamps most-recent-first (FR1.1/FR1.2)', () => {
    const older = run({ sensorRunId: 'a', timestamp: '2026-01-01T00:00:00Z' });
    const newer = run({ sensorRunId: 'b', timestamp: '2026-03-01T00:00:00Z' });
    expect(orderReviewerRuns([older, newer]).map((r) => r.sensorRunId)).toEqual(['b', 'a']);
  });

  it('sinks a run with a missing timestamp to the bottom (R-01)', () => {
    const parseable = run({ sensorRunId: 'a', timestamp: '2026-01-01T00:00:00Z' });
    const missing = run({ sensorRunId: 'b', timestamp: undefined as unknown as string });
    expect(orderReviewerRuns([missing, parseable]).map((r) => r.sensorRunId)).toEqual(['a', 'b']);
  });

  it('sinks an unparseable timestamp to the bottom without throwing (R-01)', () => {
    const parseable = run({ sensorRunId: 'a', timestamp: '2026-01-01T00:00:00Z' });
    const bad = run({ sensorRunId: 'b', timestamp: 'not-a-date' });
    let ordered: IntentSensorRun[] = [];
    expect(() => {
      ordered = orderReviewerRuns([bad, parseable]);
    }).not.toThrow();
    expect(ordered.map((r) => r.sensorRunId)).toEqual(['a', 'b']);
  });

  it('preserves input order for equal timestamps (stable)', () => {
    const first = run({ sensorRunId: 'a', timestamp: '2026-01-01T00:00:00Z' });
    const second = run({ sensorRunId: 'b', timestamp: '2026-01-01T00:00:00Z' });
    expect(orderReviewerRuns([first, second]).map((r) => r.sensorRunId)).toEqual(['a', 'b']);
  });

  it('does not mutate the input array', () => {
    const input = [
      run({ sensorRunId: 'a', timestamp: '2026-01-01T00:00:00Z' }),
      run({ sensorRunId: 'b', timestamp: '2026-03-01T00:00:00Z' }),
    ];
    const before = input.map((r) => r.sensorRunId);
    orderReviewerRuns(input);
    expect(input.map((r) => r.sensorRunId)).toEqual(before);
  });

  it('REGRESSION: raw API order (oldest first) is reordered so newest is index 0 (NFR4)', () => {
    // Reproduces the defect: the old flat map rendered runs in API order, so an
    // older iteration appeared/opened first. Ordering must surface the newest.
    const rawApiOrder = [
      run({ sensorRunId: 'iter-1', timestamp: '2026-01-01T00:00:00Z' }),
      run({ sensorRunId: 'iter-2', timestamp: '2026-02-01T00:00:00Z' }),
      run({ sensorRunId: 'iter-3', timestamp: '2026-03-01T00:00:00Z' }),
    ];
    expect(orderReviewerRuns(rawApiOrder).map((r) => r.sensorRunId)).toEqual([
      'iter-3',
      'iter-2',
      'iter-1',
    ]);
  });
});

describe('reviewerRunVerdict', () => {
  it('returns detail.verdict when present', () => {
    expect(reviewerRunVerdict(run({ detail: { verdict: 'READY' }, result: 'PASS' }))).toBe('READY');
  });

  it('falls back to result when detail.verdict is absent', () => {
    expect(reviewerRunVerdict(run({ detail: null, result: 'FAIL' }))).toBe('FAIL');
  });
});
