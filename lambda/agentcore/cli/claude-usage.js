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
