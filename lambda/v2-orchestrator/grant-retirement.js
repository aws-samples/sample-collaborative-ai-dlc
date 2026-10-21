// Gateway grant retirement steps shared by the stage loop (index.js), the
// parallel sections (section.js, through index.js's runtimeStep) and the
// quorum-edit flow (quorum-edit.js).
import { JitterStrategy, createRetryStrategy } from '@aws/durable-execution-sdk-js';
import { Logger } from '@aws-lambda-powertools/logger';
import { pendingGrantRetirementIds } from '../shared/gateway-grant-retirement.js';

const logger = new Logger({ persistentKeys: { component: 'v2-orchestrator' } });

// Gateway grant retirement is fail-closed: a retirement step THROWS on a write
// failure so the durable SDK retries it (the step result is only checkpointed
// once the write lands), and the workflow never advances past it in between.
// Bounded exponential backoff, 5s doubling to a 60s cap over 8 attempts (about
// 2-4 minutes with half jitter). An "already retired" outcome (a replayed or
// repeated write of the same jti) is a success, not a failure. Once the
// attempts are exhausted the jti is recorded on META (pendingGrantRetirements:
// every grant consumer treats a jti recorded there as retired, and /start,
// rewind, recompose and lane repair retire it before they relaunch) and the
// caller fails the stage or run; the only window left is a DynamoDB outage
// longer than both backoffs — which also stops engine-data's own process-table
// writes, the main thing a stale grant could still do.
export const GATEWAY_GRANT_RETIREMENT_RETRY = createRetryStrategy({
  maxAttempts: 8,
  initialDelay: { seconds: 5 },
  maxDelay: { seconds: 60 },
  backoffRate: 2,
  jitter: JitterStrategy.HALF,
});
export const GATEWAY_GRANT_RETIREMENT_FAILURE = 'gateway_grant_retirement_failed';

const logRetirementExhausted = (fields, error) =>
  logger.error('gateway grant retirement failed after retries', {
    code: 'GATEWAY_GRANT_RETIREMENT_FAILED',
    metric: 'GatewayGrantRetirementFailed',
    value: 1,
    ...fields,
    error: error?.cause?.name ?? error?.name ?? 'Error',
  });

// The jtis META still records as unretired (a lane whose retirement exhausted
// and that was then retried or skipped), retired and cleared. Read and write in
// steps; false once the retries are exhausted.
export const retirePendingGrantsDurably = async (
  ctx,
  { retireGatewayGrant, store, executionId },
) => {
  const pending = await ctx.step('load-pending-grant-retirements', async () =>
    pendingGrantRetirementIds(await store.getExecution(executionId, { consistentRead: true })),
  );
  if (!pending.length) return true;
  try {
    await ctx.step(
      'retire-pending-grants',
      async () => {
        for (const grantId of pending) {
          await retireGatewayGrant({ grantId, executionId, outcome: 'pending_retry' });
        }
        await store.clearPendingGrantRetirements({ executionId, grantIds: pending });
        return { retired: pending.length };
      },
      { retryStrategy: GATEWAY_GRANT_RETIREMENT_RETRY },
    );
    return true;
  } catch (error) {
    logRetirementExhausted({ executionId, pending: pending.length }, error);
    return false;
  }
};

// Thrown when a grant could not be retired; the run's catch-all fails the run
// (a lane, its lane) with GATEWAY_GRANT_RETIREMENT_FAILURE, and best-effort
// catches rethrow it. `cause` is the command's own error when the command
// failed too; `recorded` is false when not even the jti's record on META
// landed.
export class GatewayGrantRetirementExhaustedError extends Error {
  constructor(grantId, { cause, recorded = true } = {}) {
    super(
      recorded
        ? 'the Gateway grant of an engine command could not be retired'
        : 'the Gateway grant of an engine command could neither be retired nor recorded',
      cause === undefined ? undefined : { cause },
    );
    this.name = 'GatewayGrantRetirementExhaustedError';
    this.code = GATEWAY_GRANT_RETIREMENT_FAILURE;
    this.grantId = grantId;
    this.recorded = recorded;
  }
}

// Retire one grant by jti in `retire-grant-<stepKey>`, retried with
// GATEWAY_GRANT_RETIREMENT_RETRY. On exhaustion the jti is added to META's
// pendingGrantRetirements (its own step, before the caller writes any failure)
// and false is returned. When that record cannot be written either (same retry
// strategy), GatewayGrantRetirementExhaustedError is thrown with
// `recorded: false`, so no best-effort catch can mistake it for an ordinary
// command failure.
export const retireGrantDurably = async (
  ctx,
  { retireGatewayGrant, store, executionId },
  { stepKey, grant },
) => {
  try {
    await ctx.step(
      `retire-grant-${stepKey}`,
      async () => {
        await retireGatewayGrant(grant);
        return { retired: true };
      },
      { retryStrategy: GATEWAY_GRANT_RETIREMENT_RETRY },
    );
    return true;
  } catch (error) {
    logRetirementExhausted(
      { grantId: grant.grantId, ...(grant.stageId ? { stageId: grant.stageId } : {}) },
      error,
    );
    try {
      await ctx.step(
        `pending-grant-${stepKey}`,
        () => store.addPendingGrantRetirements({ executionId, grantIds: [grant.grantId] }),
        { retryStrategy: GATEWAY_GRANT_RETIREMENT_RETRY },
      );
    } catch (recordError) {
      logRetirementExhausted({ grantId: grant.grantId, record: 'pending' }, recordError);
      throw new GatewayGrantRetirementExhaustedError(grant.grantId, {
        cause: recordError,
        recorded: false,
      });
    }
    return false;
  }
};
