import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { Logger } from '@aws-lambda-powertools/logger';
import { aggregateMetrics } from '../../shared/metric-classification.js';
import { captureKiroCreditRate } from './kiro-usage.js';
import { ENGINE_DATA_DENIED_ERROR } from '../../shared/engine-data-ops.js';

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
//
// A Claude stage passes its session (`claudeSession`, the totals its output
// sinks update, and `sessionId`). When they change, flush saves them with the
// samples in one write (store.recordStageUsage), so the totals a resume
// subtracts are always those of the spend recorded:
//   - a write that fails for a transient reason is tried once more as it was;
//     one that landed although it reported an error (the stage row holds the
//     totals sent, or the repeat finds its rows) counts as saved, never twice;
//   - a write refused because another attempt took over the stage and goes on
//     with this session (its row names the session) records nothing: the
//     totals stay as they were, so that attempt counts this spend when it
//     resumes the session;
//   - any other refusal (a stage taken over by a fresh session, an execution
//     no longer live, an engine-data that doesn't know the op yet) records the
//     samples on their own and leaves the totals, since nothing will resume
//     the session from them. Where the attempt's grant was retired (a cancel,
//     rewind, recompose or repair) that is refused too, and the spend is lost;
//   - otherwise the write is kept, as it was, and sent again before anything
//     newer at the session's next flush (a repair turn). If there is none, the
//     stage row still holds the totals from before, so a resume counts this
//     spend again.
const REFUSALS = new Set(['ConditionalCheckFailedException', ENGINE_DATA_DENIED_ERROR]);
export const createUsageRecorder = ({
  store,
  scope,
  model,
  publish = async () => {},
  env,
  workspaceDir,
  spawnFn,
  claudeSession = null,
  sessionId = () => null,
  ids = () => randomUUID(),
  now = () => new Date(),
}) => {
  let byModel = new Map();
  let incomplete = new Set();
  let sessionChanged = false;
  const add = (key, delta, partial) => {
    byModel.set(key, aggregateMetrics([{ metrics: byModel.get(key) ?? null }, { metrics: delta }]));
    if (partial) incomplete.add(key);
  };
  const sampleFor = async ([sampleModel, sample], partialModels) => {
    const creditRate =
      sample.credits > 0
        ? await captureKiroCreditRate({ env, workspaceDir, spawnFn }).catch(() => null)
        : null;
    return {
      metrics: sample,
      resolvedModel: sampleModel,
      measured: true,
      ...(partialModels.has(sampleModel) ? { incomplete: true } : {}),
      ...(sample.credits > 0 ? { creditRate } : {}),
    };
  };
  const announce = (rows) =>
    Promise.all(
      rows.map(({ metricId, metrics }) =>
        publish({ action: 'agent.metric', ...scope, metricId, metrics }),
      ),
    );
  const recordEach = async (samples) => {
    for (const sample of samples) {
      try {
        const row = await store.recordMetric({ ...scope, ...sample });
        await announce([{ metricId: row.metricId, metrics: sample.metrics }]);
      } catch (error) {
        logger.error('cli usage not recorded', error, { stageInstanceId: scope.stageInstanceId });
      }
    }
  };
  const stageRow = async () => {
    try {
      return await store.getStage?.(scope.executionId, scope.stageInstanceId, {
        consistentRead: true,
      });
    } catch {
      return null;
    }
  };
  // Whether the stage row holds the totals a failed write sent: it landed.
  const landed = async (cliUsageTotals) =>
    isDeepStrictEqual((await stageRow())?.cliUsageTotals ?? null, cliUsageTotals);
  // The session the stage row's current attempt goes on with.
  const stageSession = async () => (await stageRow())?.cliSessionId ?? null;
  const send = async (request) => {
    const sent = () =>
      request.samples.map((sample, index) => ({
        metricId: `${request.requestId}-${index}`,
        ...sample,
      }));
    for (let attempt = 1; ; attempt += 1) {
      try {
        return { saved: await store.recordStageUsage(request) };
      } catch (error) {
        if (await landed(request.cliUsageTotals)) return { saved: sent() };
        if (REFUSALS.has(error?.name)) return { refused: error };
        if (attempt >= 2) return { failed: error };
      }
    }
  };
  // Writes not yet saved, oldest first: each is sent again as it was, so its
  // rows keep their keys and a repeat of one that landed is never counted.
  const queue = [];
  const drain = async () => {
    while (queue.length) {
      const request = queue[0];
      const outcome = await send(request);
      if (outcome.failed) {
        logger.error('cli usage not recorded; kept for the next flush', outcome.failed, {
          stageInstanceId: scope.stageInstanceId,
        });
        return;
      }
      queue.shift();
      if (outcome.saved) {
        await announce(outcome.saved).catch(() => {});
        continue;
      }
      const replaced =
        outcome.refused.code === 'stage_fence' &&
        (await stageSession()) === request.cliUsageTotals.sessionId;
      logger.warn(
        replaced
          ? 'claude usage left to the attempt that took over the session'
          : 'claude usage totals not saved; recording the samples alone',
        {
          stageInstanceId: scope.stageInstanceId,
          error: outcome.refused.message,
          code: outcome.refused.code,
        },
      );
      if (!replaced && store.recordMetric) await recordEach(request.samples);
    }
  };
  return {
    onUsage(delta, _event, { model: deltaModel = null, partial = false } = {}) {
      add(deltaModel ?? model ?? null, delta, partial);
    },
    onSessionTotals() {
      sessionChanged = true;
    },
    async flush() {
      const entries = [...byModel.entries()].filter(([, metrics]) => metrics);
      const partialModels = incomplete;
      byModel = new Map();
      incomplete = new Set();
      const id = sessionId();
      const withSession = sessionChanged && claudeSession && id && store?.recordStageUsage;
      sessionChanged = false;
      const samples = await Promise.all(entries.map((entry) => sampleFor(entry, partialModels)));
      if (withSession) {
        queue.push({
          ...scope,
          samples,
          cliUsageTotals: { sessionId: id, totals: claudeSession.totals },
          requestId: ids(),
          recordedAt: now().toISOString(),
        });
      }
      if (queue.length) await drain();
      if (!withSession && samples.length && store?.recordMetric) await recordEach(samples);
    },
  };
};
