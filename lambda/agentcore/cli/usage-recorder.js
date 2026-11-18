import { Logger } from '@aws-lambda-powertools/logger';
import { aggregateMetrics } from '../../shared/metric-classification.js';
import { captureKiroCreditRate } from './kiro-usage.js';

const logger = new Logger({ persistentKeys: { component: 'agentcore', module: 'usage-recorder' } });

// CLI parsers emit usage deltas: a Claude result, an OpenCode step, a Codex
// turn, or Kiro metering. Persist one sample per invocation, on every exit.
// Call flush after the output sink is flushed, before returning/parking.
export const createUsageRecorder = ({
  store,
  scope,
  model,
  publish = async () => {},
  env,
  workspaceDir,
  spawnFn,
}) => {
  let metrics = null;
  return {
    onUsage(delta) {
      metrics = aggregateMetrics([{ metrics }, { metrics: delta }]);
    },
    async flush() {
      const sample = metrics;
      metrics = null;
      if (!sample || !store?.recordMetric) return;
      try {
        const creditRate =
          sample.credits > 0
            ? await captureKiroCreditRate({ env, workspaceDir, spawnFn }).catch(() => null)
            : null;
        const row = await store.recordMetric({
          ...scope,
          metrics: sample,
          resolvedModel: model ?? null,
          ...(sample.credits > 0 ? { creditRate } : {}),
        });
        await publish({
          action: 'agent.metric',
          ...scope,
          metricId: row.metricId,
          metrics: sample,
        });
      } catch (error) {
        logger.error('cli usage not recorded', error, { stageInstanceId: scope.stageInstanceId });
      }
    },
  };
};
