// Claude input_tokens excludes cache reads and writes. Keep those billing
// categories separate in storage; the API combines them for display.
export const claudeUsageMetrics = (usage) => {
  const fields = {
    tokensInput: usage?.input_tokens,
    tokensOutput: usage?.output_tokens,
    tokensCacheRead: usage?.cache_read_input_tokens,
    tokensCacheWrite: usage?.cache_creation_input_tokens,
    // A subset of cache writes, needed to price the longer TTL correctly.
    tokensCacheWrite1h: usage?.cache_creation?.ephemeral_1h_input_tokens,
  };
  const metrics = Object.fromEntries(
    Object.entries(fields).filter(
      ([, value]) => typeof value === 'number' && Number.isFinite(value) && value >= 0,
    ),
  );
  return Object.keys(metrics).length ? metrics : null;
};

const TOKEN_KEYS = [
  'tokensInput',
  'tokensOutput',
  'tokensCacheRead',
  'tokensCacheWrite',
  'tokensCacheWrite1h',
];
const isCount = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;

// A result's `modelUsage`: per model, the whole tree's usage, subagents
// included (its `usage` counts only the top-level loop). Claude Code reports a
// resumed session's earlier spend in it too, so it is a running total for the
// session, not this call's spend: see claudeUsageSince. null when the result
// has no usable modelUsage (an older Claude Code).
export const claudeModelUsageTotals = (event) => {
  const entries = Object.entries(event?.modelUsage ?? {}).filter(
    ([model, usage]) => model && usage && typeof usage === 'object',
  );
  const totals = {};
  for (const [model, usage] of entries) {
    const metrics = Object.fromEntries(
      [
        ['tokensInput', usage.inputTokens],
        ['tokensOutput', usage.outputTokens],
        ['tokensCacheRead', usage.cacheReadInputTokens],
        ['tokensCacheWrite', usage.cacheCreationInputTokens],
      ].filter(([, value]) => isCount(value)),
    );
    if (Object.keys(metrics).length) totals[model] = metrics;
  }
  return Object.keys(totals).length ? totals : null;
};

// The 1-hour share of this call's cache writes. Only the top-level loop's is
// reported (in the result's `usage`, which covers this call alone), so it is
// carried on the one model that wrote to the cache, capped at its writes.
export const withOneHourWrites = (since, event) => {
  const oneHour = event?.usage?.cache_creation?.ephemeral_1h_input_tokens;
  const writers = Object.keys(since).filter((model) => since[model].tokensCacheWrite > 0);
  if (!isCount(oneHour) || oneHour === 0 || writers.length !== 1) return since;
  const model = writers[0];
  return {
    ...since,
    [model]: {
      ...since[model],
      tokensCacheWrite1h: Math.min(oneHour, since[model].tokensCacheWrite),
    },
  };
};

// A session's spend since the totals last recorded for it: each model's
// running total less the baseline. A count lower than its baseline means the
// session's totals started again from zero (an older Claude Code, or a session
// that was not restored), so the count itself is this call's spend.
const restartedFrom = (metrics, before = {}) =>
  TOKEN_KEYS.some(
    (key) => isCount(metrics[key]) && isCount(before[key]) && metrics[key] < before[key],
  );

export const claudeUsageSince = (totals, baseline = {}) => {
  const since = {};
  for (const [model, metrics] of Object.entries(totals ?? {})) {
    const before = baseline?.[model] ?? {};
    const restarted = restartedFrom(metrics, before);
    const delta = {};
    for (const key of TOKEN_KEYS) {
      if (!isCount(metrics[key])) continue;
      const value = restarted ? metrics[key] : metrics[key] - (before[key] ?? 0);
      if (value > 0) delta[key] = value;
    }
    if (Object.keys(delta).length) since[model] = delta;
  }
  return since;
};

// The session's totals after a result: a model the result leaves out keeps its
// baseline, so a later result that reports it again counts only its new spend.
// When the session started again from zero, its totals start again too.
export const nextClaudeSessionTotals = (baseline = {}, totals = {}) =>
  Object.entries(totals).some(([model, metrics]) => restartedFrom(metrics, baseline[model]))
    ? totals
    : { ...baseline, ...totals };

// The session's totals after a run that ended without a result but exited by
// itself: Claude Code saves the session's spend when it exits, so a resume will
// report this run in its totals. The top-level steps recorded for it are added
// to the main model's baseline so the resume doesn't count them again. A run
// that was killed saves nothing, so its baseline is left as it was.
export const withClaudeStepTotals = (baseline = {}, model, metrics) => {
  if (!model || !metrics) return baseline;
  const before = baseline[model] ?? {};
  const after = { ...before };
  for (const key of TOKEN_KEYS.filter((k) => k !== 'tokensCacheWrite1h')) {
    if (isCount(metrics[key])) after[key] = (before[key] ?? 0) + metrics[key];
  }
  return { ...baseline, [model]: after };
};

// The fallback when a run ends without a usable result (the CLI was killed, or
// crashed and reported zeroed usage): the top-level loop's input and cache
// tokens, summed from its assistant messages, each API response counted once
// (parallel tool calls repeat a message id). Output tokens on these messages
// are a placeholder, so they are left out; subagent usage can't be recovered
// this way either. The sample is a lower bound, recorded as incomplete.
const STEP_KEYS = ['tokensInput', 'tokensCacheRead', 'tokensCacheWrite', 'tokensCacheWrite1h'];
export const createClaudeStepUsage = () => {
  const seen = new Set();
  let metrics = null;
  return {
    add(event) {
      if (event?.type !== 'assistant' || event.parent_tool_use_id) return;
      const id = event.message?.id;
      const usage = claudeUsageMetrics(event.message?.usage);
      if (!id || !usage || seen.has(id)) return;
      seen.add(id);
      metrics = metrics ?? {};
      for (const key of STEP_KEYS) {
        if (key in usage) metrics[key] = (metrics[key] ?? 0) + usage[key];
      }
    },
    get: () => metrics,
  };
};

// Whether a result carries usage worth recording: a crash's final result can
// report every count as zero, which would hide the steps that did run.
const anyCount = (metrics) => Object.values(metrics ?? {}).some((value) => value > 0);
export const claudeResultHasUsage = (event) =>
  anyCount(claudeUsageMetrics(event?.usage)) ||
  Object.values(claudeModelUsageTotals(event) ?? {}).some(anyCount);
