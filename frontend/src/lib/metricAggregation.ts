// Metric aggregation — the single source of truth for how a metric key folds
// across samples. The runtime emits a free-form numeric bag per sample
// (`tokensInput`, `tokensOutput`, `contextWindowPct`, ...); some keys are
// counters (sum them) and some are gauges (a percentage that must NOT be
// summed). Summing a gauge is exactly the "context full 629%" bug this fixes.
//
// Keep the KNOWN registry in sync with lambda/shared/metric-classification.js
// (a cross-tree unit test asserts the known-key sets match).

// How a metric key folds across samples.
//   - 'additive': a counter — sum every sample.
//   - 'gauge:max': a level reading — take the peak (the meaningful signal for
//     context-window pressure; a spike matters even if it later recedes).
//   - 'gauge:latest': a level reading — take the newest sample carrying the key
//     (used when the key is absent on some samples and only "current" matters).
export type MetricKind = 'additive' | 'gauge:max' | 'gauge:latest';

// Only known gauges are special-cased. Unknown keys default to additive — the
// bag is an open set and counters are the common case (also matches the prior
// behavior for every key except the gauges below).
const REGISTRY: Record<string, MetricKind> = {
  tokensInput: 'additive',
  tokensOutput: 'additive',
  contextWindowPct: 'gauge:max',
};

export function classify(key: string): MetricKind {
  return REGISTRY[key] ?? 'additive';
}

export function isGauge(key: string): boolean {
  return classify(key).startsWith('gauge');
}

// The known keys, exported so a test can assert parity with the lambda registry.
export const KNOWN_METRIC_KEYS = Object.freeze({ ...REGISTRY });

export interface MetricSample {
  metrics: Record<string, number>;
  timestamp: string;
}

// Fold a set of samples into one aggregated bag, per-key by classification.
// Additive keys sum; gauge:max takes the max; gauge:latest takes the value from
// the sample with the greatest timestamp that carries the key. Non-numeric
// values are ignored. Works at any scope — pass a stage's samples, an intent's
// samples, or (composed) per-intent aggregates.
export function aggregateMetrics(samples: MetricSample[]): Record<string, number> {
  const acc: Record<string, number> = {};
  // Track the winning timestamp per gauge:latest key.
  const latestTs: Record<string, string> = {};
  for (const s of samples) {
    for (const [k, v] of Object.entries(s.metrics ?? {})) {
      if (typeof v !== 'number' || Number.isNaN(v)) continue;
      const kind = classify(k);
      if (kind === 'gauge:max') {
        acc[k] = Math.max(acc[k] ?? Number.NEGATIVE_INFINITY, v);
      } else if (kind === 'gauge:latest') {
        if (latestTs[k] === undefined || s.timestamp > latestTs[k]) {
          acc[k] = v;
          latestTs[k] = s.timestamp;
        }
      } else {
        acc[k] = (acc[k] ?? 0) + v;
      }
    }
  }
  return acc;
}

// Roll up already-aggregated per-scope bags (e.g. per-intent → project). Additive
// keys sum; gauge keys become the peak across scopes (labelled "peak" in the UI —
// a project-wide gauge sum is meaningless). Order-independent.
export function rollupAggregates(bags: Record<string, number>[]): Record<string, number> {
  const acc: Record<string, number> = {};
  for (const bag of bags) {
    for (const [k, v] of Object.entries(bag)) {
      if (typeof v !== 'number' || Number.isNaN(v)) continue;
      if (isGauge(k)) {
        acc[k] = Math.max(acc[k] ?? Number.NEGATIVE_INFINITY, v);
      } else {
        acc[k] = (acc[k] ?? 0) + v;
      }
    }
  }
  return acc;
}

// ── Presentation helpers ────────────────────────────────────────────────────

// Compact token count: 18500 → "18.5K", 2_400_000 → "2.4M".
export function formatTokens(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

// USD amount. Sub-cent costs keep more precision so a cheap stage isn't "$0.00".
export function formatCost(amount: number, currency = 'USD'): string {
  const symbol = currency === 'USD' ? '$' : `${currency} `;
  if (!Number.isFinite(amount)) return '—';
  if (amount > 0 && amount < 0.01) return `${symbol}${amount.toFixed(4)}`;
  return `${symbol}${amount.toFixed(2)}`;
}

// Threshold color for a context-window gauge: green <50, amber 50–80, red >80.
// Returns tailwind text/bg tokens the caller composes.
export function contextGaugeTone(pct: number): { text: string; bar: string } {
  if (pct > 80) return { text: 'text-agent-error', bar: 'bg-agent-error' };
  if (pct >= 50) return { text: 'text-agent-waiting', bar: 'bg-agent-waiting' };
  return { text: 'text-agent-success', bar: 'bg-agent-success' };
}
