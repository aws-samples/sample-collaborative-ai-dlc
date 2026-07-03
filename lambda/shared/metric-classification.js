'use strict';

// Metric aggregation — the single source of truth (server side) for how a metric
// key folds across samples. Mirror of frontend/src/lib/metricAggregation.ts; a
// cross-tree test asserts the known-key sets match. The runtime emits a free-form
// numeric bag per sample (`tokensInput`, `tokensOutput`, `contextWindowPct`, ...);
// counters must be summed, gauges (a percentage) must NOT be — summing a gauge is
// the "context full 629%" bug this classification prevents.

// Kinds: 'additive' (counter — sum), 'gauge:max' (level — peak), 'gauge:latest'
// (level — newest sample carrying the key). Only known gauges are special-cased;
// unknown keys default to additive (open set; counters are the common case).
const REGISTRY = {
  tokensInput: 'additive',
  tokensOutput: 'additive',
  credits: 'additive',
  contextWindowPct: 'gauge:max',
  // Agent launching time (cold start): orchestrator dispatch → container job
  // accept, one sample per dispatch leg. The peak — not the sum — is the
  // meaningful aggregate (summing launch latencies is nonsense).
  agentLaunchMs: 'gauge:max',
};

const classify = (key) => REGISTRY[key] ?? 'additive';
const isGauge = (key) => classify(key).startsWith('gauge');

// Fold a set of samples ({ metrics, timestamp }) into one aggregated bag, per-key
// by classification. Additive keys sum; gauge:max takes the max; gauge:latest
// takes the value from the sample with the greatest timestamp carrying the key.
const aggregateMetrics = (samples) => {
  const acc = {};
  const latestTs = {};
  for (const s of samples ?? []) {
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
};

// Roll up already-aggregated per-scope bags (e.g. per-intent → project). Additive
// keys sum; gauge keys become the peak across scopes.
const rollupAggregates = (bags) => {
  const acc = {};
  for (const bag of bags ?? []) {
    for (const [k, v] of Object.entries(bag ?? {})) {
      if (typeof v !== 'number' || Number.isNaN(v)) continue;
      if (isGauge(k)) {
        acc[k] = Math.max(acc[k] ?? Number.NEGATIVE_INFINITY, v);
      } else {
        acc[k] = (acc[k] ?? 0) + v;
      }
    }
  }
  return acc;
};

module.exports = {
  KNOWN_METRIC_KEYS: { ...REGISTRY },
  classify,
  isGauge,
  aggregateMetrics,
  rollupAggregates,
};
