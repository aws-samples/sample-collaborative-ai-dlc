import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import {
  classify,
  aggregateMetrics,
  rollupAggregates,
  formatTokens,
  formatCost,
  contextGaugeTone,
  KNOWN_METRIC_KEYS,
} from './metricAggregation';

const sample = (metrics: Record<string, number>, timestamp = '2026-01-01T00:00:00Z') => ({
  metrics,
  timestamp,
});

describe('classify', () => {
  it('classifies known keys and defaults unknown to additive', () => {
    expect(classify('tokensInput')).toBe('additive');
    expect(classify('contextWindowPct')).toBe('gauge:max');
    expect(classify('somethingNew')).toBe('additive');
  });
});

describe('aggregateMetrics', () => {
  it('sums additive keys and takes the max of gauges (the 629% bug)', () => {
    const out = aggregateMetrics([
      sample({ tokensInput: 100, tokensOutput: 20, contextWindowPct: 28 }),
      sample({ tokensInput: 150, tokensOutput: 30, contextWindowPct: 45 }),
      sample({ tokensInput: 200, tokensOutput: 10, contextWindowPct: 35 }),
    ]);
    expect(out.tokensInput).toBe(450);
    expect(out.tokensOutput).toBe(60);
    // NOT 108 — a gauge takes the peak.
    expect(out.contextWindowPct).toBe(45);
  });

  it('handles a gauge absent on some samples', () => {
    const out = aggregateMetrics([
      sample({ tokensInput: 100 }),
      sample({ tokensInput: 50, contextWindowPct: 70 }),
    ]);
    expect(out.tokensInput).toBe(150);
    expect(out.contextWindowPct).toBe(70);
  });

  it('ignores non-numeric and NaN values', () => {
    const out = aggregateMetrics([
      // @ts-expect-error deliberately malformed
      sample({ tokensInput: 'x', tokensOutput: NaN, contextWindowPct: 40 }),
    ]);
    expect(out.tokensInput).toBeUndefined();
    expect(out.tokensOutput).toBeUndefined();
    expect(out.contextWindowPct).toBe(40);
  });

  it('is empty for no samples', () => {
    expect(aggregateMetrics([])).toEqual({});
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

describe('formatters', () => {
  it('formats tokens compactly', () => {
    expect(formatTokens(500)).toBe('500');
    expect(formatTokens(18500)).toBe('18.5K');
    expect(formatTokens(2_400_000)).toBe('2.4M');
  });

  it('formats cost with sub-cent precision', () => {
    expect(formatCost(1.234)).toBe('$1.23');
    expect(formatCost(0.0034)).toBe('$0.0034');
    expect(formatCost(0)).toBe('$0.00');
  });

  it('tones the context gauge by threshold', () => {
    expect(contextGaugeTone(30).bar).toContain('success');
    expect(contextGaugeTone(60).bar).toContain('waiting');
    expect(contextGaugeTone(90).bar).toContain('error');
  });
});

// Guard against drift between this TS registry and the lambda JS registry — they
// encode the same domain knowledge (which keys are gauges) and must not diverge.
describe('registry parity with lambda/shared/metric-classification.js', () => {
  it('has identical known-key classifications', () => {
    const require = createRequire(import.meta.url);
    const lambda = require('../../../lambda/shared/metric-classification.js');
    expect(KNOWN_METRIC_KEYS).toEqual(lambda.KNOWN_METRIC_KEYS);
  });
});
