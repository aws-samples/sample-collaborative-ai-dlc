import { describe, it, expect } from 'vitest';
import {
  classify,
  isGauge,
  aggregateMetrics,
  rollupAggregates,
  KNOWN_METRIC_KEYS,
} from '../metric-classification.js';

const sample = (metrics, timestamp = '2026-01-01T00:00:00Z') => ({ metrics, timestamp });

describe('classify', () => {
  it('classifies known keys, defaults unknown to additive', () => {
    expect(classify('tokensInput')).toBe('additive');
    expect(classify('contextWindowPct')).toBe('gauge:max');
    expect(classify('mysteryKey')).toBe('additive');
    expect(isGauge('contextWindowPct')).toBe(true);
    expect(isGauge('tokensInput')).toBe(false);
  });
});

describe('aggregateMetrics', () => {
  it('sums additive keys and peaks gauges (the 629% bug)', () => {
    const out = aggregateMetrics([
      sample({ tokensInput: 100, tokensOutput: 20, contextWindowPct: 28 }),
      sample({ tokensInput: 150, tokensOutput: 30, contextWindowPct: 45 }),
      sample({ tokensInput: 200, tokensOutput: 10, contextWindowPct: 35 }),
    ]);
    expect(out.tokensInput).toBe(450);
    expect(out.tokensOutput).toBe(60);
    expect(out.contextWindowPct).toBe(45); // NOT 108
  });

  it('handles a gauge absent on some samples and ignores non-numeric', () => {
    const out = aggregateMetrics([
      sample({ tokensInput: 100 }),
      sample({ tokensInput: 'x', tokensOutput: NaN, contextWindowPct: 70 }),
    ]);
    expect(out.tokensInput).toBe(100);
    expect(out.tokensOutput).toBeUndefined();
    expect(out.contextWindowPct).toBe(70);
  });
});

describe('rollupAggregates', () => {
  it('sums additive and peaks gauges across scopes', () => {
    const out = rollupAggregates([
      { tokensInput: 450, contextWindowPct: 45 },
      { tokensInput: 300, contextWindowPct: 82 },
    ]);
    expect(out.tokensInput).toBe(750);
    expect(out.contextWindowPct).toBe(82);
  });
});

describe('registry parity with the frontend', () => {
  it('exposes a stable known-key set', () => {
    // The frontend test asserts equality against this object; keep it explicit
    // here so a change on either side fails a test.
    expect(KNOWN_METRIC_KEYS).toEqual({
      tokensInput: 'additive',
      tokensOutput: 'additive',
      contextWindowPct: 'gauge:max',
    });
  });
});
