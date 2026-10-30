// Gateway grant retirement for the intents HTTP handlers: the refusal responses
// a writer returns when retirement fails or its run changed, the pending-grant
// cleanup before a relaunch, and the grants of synchronous runtime commands.
// The durable orchestrator has its own adapter (different retry and replay
// requirements). See docs/development/recovery-ownership.md.
import { randomUUID } from 'node:crypto';
import { gatewayScopeForCommand } from '../shared/gateway-grant.js';
import {
  GatewayGrantRetirementError,
  gatewayExecutionRetirerFromEnv,
  gatewayGrantRetirerFromEnv,
  pendingGrantRetirementIds,
} from '../shared/gateway-grant-retirement.js';

export class StaleRunRequestError extends Error {
  constructor(executionId) {
    super('The run changed while the request was in flight');
    this.name = 'StaleRunRequestError';
    this.executionId = executionId;
  }
}

export const grantRetirementUnavailable = (response) =>
  response(503, {
    error: 'The run’s Gateway grants could not be retired; nothing was changed. Retry.',
    code: 'grant_retirement_unavailable',
  });

// A synchronous command already acted, but neither its grant's retirement nor
// the record of it landed: the caller must not treat the request as done.
export const grantRetirementUnrecorded = (response) =>
  response(503, {
    error:
      'The command ran, but its Gateway grant could not be retired or recorded. Retry once the service recovers.',
    code: 'grant_retirement_unavailable',
  });

export const staleRunRequest = (response) =>
  response(409, {
    error:
      'The run changed while this request was in flight; nothing was changed. Refresh and retry.',
    code: 'run_superseded',
  });

// `issueGatewayGrant` is null unless the deployment enabled the MCP Gateway.
export const createGrantRetirement = ({ ddb, store, logger, issueGatewayGrant }) => {
  const logGrantRetirementFailure = (fields, error) =>
    logger.error('gateway execution retirement failed', {
      code: 'GATEWAY_GRANT_RETIREMENT_FAILED',
      metric: 'GatewayGrantRetirementFailed',
      value: 1,
      ...fields,
      error: error?.name ?? 'Error',
    });

  // Retire every Gateway grant of an execution issued so far, for a deliberate
  // stop that ends or replaces its run (cancel, rewind, recompose, lane repair,
  // delete, the durable watchdog); a run's own end retires its grants one by one
  // and writes nothing here. Fail-closed: called BEFORE the operation changes
  // any state, and a failed write throws GatewayGrantRetirementError so the
  // operation aborts with a retryable error instead of ending the run while its
  // grants stay valid. `ifOrchestratorRunId` is the run id the caller read from
  // META (null: none): the write lands only while META still names it, so a
  // stale request (two concurrent rewinds, a watchdog racing a relaunch) can
  // never retire a newer run's grants; it gets `{ superseded: true }` back and
  // must not change anything either. A no-op when the deployment has no
  // retirement table (MCP Gateway disabled).
  const retireExecutionGrants = async (executionId, reason, { ifOrchestratorRunId }) => {
    const retire = gatewayExecutionRetirerFromEnv({ ddb });
    if (!retire) return null;
    try {
      return await retire({
        executionId,
        reason,
        ifOrchestratorRunId: ifOrchestratorRunId ?? null,
      });
    } catch (error) {
      logGrantRetirementFailure({ executionId, reason }, error);
      throw new GatewayGrantRetirementError(executionId, error);
    }
  };

  // For the HTTP writers: the 503 / 409 response to return, or null once
  // retired. `ifOrchestratorRunId` is the run id of the META row the request
  // validated, so a stale writer never revokes a relaunched run.
  const retireExecutionGrantsOrRefuse = async (
    executionId,
    reason,
    response,
    { ifOrchestratorRunId },
  ) => {
    try {
      const retired = await retireExecutionGrants(executionId, reason, { ifOrchestratorRunId });
      return retired?.superseded ? staleRunRequest(response) : null;
    } catch (error) {
      if (error instanceof GatewayGrantRetirementError) return grantRetirementUnavailable(response);
      throw error;
    }
  };

  // The jtis an earlier run could not retire (its retirement exhausted; the run
  // recorded them on META before it reported its failure). /start, rewind,
  // recompose and lane repair retire them before they relaunch, fail-closed, and
  // then clear them. Returns the 503 response to return, or null.
  const retirePendingGrantsOrRefuse = async (meta, response) => {
    const pending = pendingGrantRetirementIds(meta);
    if (!pending.length) return null;
    const retire = gatewayGrantRetirerFromEnv({ ddb });
    try {
      if (!retire) throw new Error('GATEWAY_GRANT_RETIREMENT_TABLE is not configured');
      for (const grantId of pending) {
        await retire({ grantId, executionId: meta.executionId, outcome: 'pending_retry' });
      }
    } catch (error) {
      logGrantRetirementFailure(
        { executionId: meta.executionId, reason: 'pending_grants', pending: pending.length },
        error,
      );
      return grantRetirementUnavailable(response);
    }
    // A relaunch requires the set to be gone (its write is conditioned on
    // attribute_not_exists), so a failed clear refuses too; the retry is
    // idempotent.
    try {
      await store.clearPendingGrantRetirements({
        executionId: meta.executionId,
        grantIds: pending,
      });
    } catch (error) {
      logGrantRetirementFailure(
        { executionId: meta.executionId, reason: 'pending_grants_clear', pending: pending.length },
        error,
      );
      return grantRetirementUnavailable(response);
    }
    return null;
  };

  // A relaunch write (status → CREATED) conditioned on META owing no grant
  // retirement. A concurrent derive can record an unretired jti after the
  // request read META; the condition then fails, and the jtis now on META are
  // retired and the write retried once. Returns { updated } or { refused } (the
  // 503 to return) — also when yet another jti arrived during that retry, so a
  // pending-grant refusal is always 503 grant_retirement_unavailable. Any other
  // condition failure propagates to the caller.
  const relaunchWithoutPendingGrants = async (executionId, write, response) => {
    const pendingAfterConditionFailure = async (error) => {
      if (error?.name !== 'ConditionalCheckFailedException') throw error;
      const current = await store.getExecution(executionId, { consistentRead: true });
      if (!pendingGrantRetirementIds(current).length) throw error;
      return current;
    };
    try {
      return { updated: await write() };
    } catch (error) {
      const current = await pendingAfterConditionFailure(error);
      const refused = await retirePendingGrantsOrRefuse(current, response);
      if (refused) return { refused };
    }
    try {
      return { updated: await write() };
    } catch (error) {
      await pendingAfterConditionFailure(error);
      logger.warn('gateway grants kept arriving while relaunching', {
        code: 'GATEWAY_GRANT_RETIREMENT_PENDING',
        executionId,
      });
      return { refused: grantRetirementUnavailable(response) };
    }
  };

  // Synchronous retirement attempts for a grant this Lambda issued for one
  // synchronous runtime command (no durable retry here: the HTTP request is the
  // unit of work). Three quick attempts, then the jti is recorded on META for the
  // next relaunch to retry.
  const SYNC_GRANT_RETIREMENT_ATTEMPTS = 3;
  const SYNC_GRANT_RETIREMENT_BACKOFF_MS = 100;

  // The signed grant a synchronous runtime command's registry scope declares,
  // with its jti pinned so it can be retired once the command returns. Identity
  // is the caller's verified intent (these commands run on the intent's own
  // execution). `fields` is empty without an issuer or for a command that needs
  // no grant, so the payload stays unchanged when the Gateway is off. `retire()`
  // never throws; it returns 'retired', 'recorded' (retirement failed, logged
  // GATEWAY_GRANT_RETIREMENT_FAILED, jti recorded on META for the next relaunch)
  // or 'unrecorded' (recording failed too). The command has already acted, so
  // the caller returns its result on 'recorded'; on 'unrecorded' nothing
  // durable remembers the live grant, and the caller answers 503
  // grant_retirement_unavailable even though the projection changed.
  // `ttlSeconds` narrows the grant's lifetime below the default.
  const issueSyncGatewayGrant = async (command, { projectId, intentId }, { ttlSeconds } = {}) => {
    const scope = issueGatewayGrant
      ? gatewayScopeForCommand({ command }, { projectId, intentId, executionId: intentId })
      : null;
    if (!scope) return { fields: {}, retire: async () => 'retired' };
    const retireGrant = gatewayGrantRetirerFromEnv({ ddb });
    const grantId = randomUUID();
    const gatewayGrant = await issueGatewayGrant(scope, {
      randomId: () => grantId,
      ...(ttlSeconds ? { ttlSeconds } : {}),
    });
    const retire = async () => {
      if (!retireGrant) return 'retired';
      let lastError = null;
      for (let attempt = 1; attempt <= SYNC_GRANT_RETIREMENT_ATTEMPTS; attempt += 1) {
        try {
          await retireGrant({ grantId, executionId: intentId, outcome: command });
          return 'retired';
        } catch (error) {
          lastError = error;
          if (attempt < SYNC_GRANT_RETIREMENT_ATTEMPTS) {
            await new Promise((resolve) =>
              setTimeout(resolve, SYNC_GRANT_RETIREMENT_BACKOFF_MS * attempt),
            );
          }
        }
      }
      logGrantRetirementFailure({ executionId: intentId, reason: command, grantId }, lastError);
      try {
        await store.addPendingGrantRetirements({ executionId: intentId, grantIds: [grantId] });
        return 'recorded';
      } catch (error) {
        logGrantRetirementFailure(
          { executionId: intentId, reason: `${command}_pending_record`, grantId },
          error,
        );
        return 'unrecorded';
      }
    };
    return { fields: { gatewayGrant }, retire };
  };

  return {
    issueSyncGatewayGrant,
    relaunchWithoutPendingGrants,
    retireExecutionGrants,
    retireExecutionGrantsOrRefuse,
    retirePendingGrantsOrRefuse,
  };
};
