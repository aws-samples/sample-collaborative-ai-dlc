import { Logger } from '@aws-lambda-powertools/logger';
import { aggregateMetrics } from '../../shared/metric-classification.js';
import { captureKiroCreditRate } from './kiro-usage.js';

const logger = new Logger({
  persistentKeys: { component: 'agentcore', module: 'usage-recorder' },
});

// CLI parsers emit usage deltas: a Claude result, an OpenCode step, a Codex
// turn, or Kiro metering. Persist one sample per model per invocation, on
// every exit: a Claude result can carry several models (a subagent's own
// model), each priced as itself. A delta with no model is the invocation's
// model. Every sample is `measured` (from the CLI's own report); one built
// from a partial delta (a run that ended without its usage report) is also
// `incomplete`, a lower bound. Call flush after the output sink is flushed,
// before returning/parking.
export const createUsageRecorder = ({
  store,
  scope,
  model,
  publish = async () => {},
  env,
  workspaceDir,
  spawnFn,
}) => {
  let byModel = new Map();
  let incomplete = new Set();
  return {
    onUsage(delta, _event, { model: deltaModel = null, partial = false } = {}) {
      const key = deltaModel ?? model ?? null;
      byModel.set(
        key,
        aggregateMetrics([{ metrics: byModel.get(key) ?? null }, { metrics: delta }]),
      );
      if (partial) incomplete.add(key);
    },
    async flush() {
      const samples = [...byModel.entries()].filter(([, metrics]) => metrics);
      const partialModels = incomplete;
      byModel = new Map();
      incomplete = new Set();
      if (!samples.length || !store?.recordMetric) return;
      for (const [sampleModel, sample] of samples) {
        try {
          const creditRate =
            sample.credits > 0
              ? await captureKiroCreditRate({
                  env,
                  workspaceDir,
                  spawnFn,
                }).catch(() => null)
              : null;
          const row = await store.recordMetric({
            ...scope,
            metrics: sample,
            resolvedModel: sampleModel,
            measured: true,
            ...(partialModels.has(sampleModel) ? { incomplete: true } : {}),
            ...(sample.credits > 0 ? { creditRate } : {}),
          });
          await publish({
            action: 'agent.metric',
            ...scope,
            metricId: row.metricId,
            metrics: sample,
          });
        } catch (error) {
          logger.error('cli usage not recorded', error, {
            stageInstanceId: scope.stageInstanceId,
          });
        }
      }
    },
  };
};
