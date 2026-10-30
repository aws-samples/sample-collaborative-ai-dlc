// Gateway grant retirement.
//
// A grant is signed for up to 8h, but its legitimate use usually ends much
// sooner. Two kinds of record live in one control-plane table and every grant
// consumer (mcp-tools, engine-data, the credential broker and the source-control
// runtime alias) rejects a grant either one covers, through verifyGatewayGrant's
// `isRetired` seam:
//
//   pk = GRANT#<jti>          one grant, recorded by its issuer once the
//                             grant's use ends: a stage attempt's grant when
//                             the stage callback arrives (or the dispatch
//                             fails), and the grant of every synchronous
//                             engine command (init-ws, checkpoints,
//                             promote-units, lane git, record-pr, derive, ...)
//                             as soon as the command returns.
//   pk = EXEC#<executionId>   every grant of one execution issued at or before
//                             `retiredAt` (epoch seconds), recorded only by a
//                             deliberate stop: cancel, delete, rewind,
//                             recompose, lane repair and the durable watchdog.
//                             A run's own terminal outcome writes none: its
//                             grants are already retired one by one, so a
//                             grant issued after the run ended (a discussion,
//                             an artifact-edit derive) stays valid.
//
// A jti whose retirement exhausted its retries is kept on the execution's META
// (`pendingGrantRetirements`) and every consumer treats it as retired (one
// more consistent GetItem, on the process table); /start, rewind, recompose and
// lane repair retire those first and refuse (503) while they cannot.
//
// The two prefixes never collide: a key is the prefix plus the raw id, so no jti
// or execution id can produce the other kind of key.
//
// The execution rule compares the grant's `iat` (whole seconds, the only issue
// time the grant carries) with `retiredAt`, so a later run of the same
// execution (start after cancel, rewind, recompose, repair) gets fresh grants
// that stay valid. Two clocks meet in that comparison: the writer's and the
// issuer's. `retiredAt` is therefore pushed forward by
// GATEWAY_GRANT_RETIREMENT_SKEW_MS before it is truncated, so a grant signed
// just before the retirement by an issuer whose clock runs ahead is still
// covered; a grant issued in the same (or skew-adjacent) second is treated as
// retired. A new orchestrator run waits until its own clock is past `retiredAt`
// before it signs anything (awaitGrantIssuanceAfterRetirement), so a re-drive
// that follows a retirement immediately is delayed by at most ~2s instead of
// being handed grants that are already dead.
//
// Every execution-level writer is conditional on the run it observed
// (`ifOrchestratorRunId`): a stale request (two concurrent rewinds) or a late
// watchdog that lost a race with a relaunch finds another run id on META and
// writes nothing (`superseded`), so it can never retire the new run's grants.
//
// The table is control-plane only: the orchestrator and the intents/projects
// Lambdas write, consumers read with consistent reads, and the AgentCore runtime
// role is explicitly denied every action on it
// (terraform/modules/compute/agentcore/grant-retirement.tf), so code in the
// agent's VM can neither read nor clear a retirement.
//
// Rows expire through DynamoDB TTL only after any grant they name has expired:
// a retired grant was signed at or before its retirement, so it expires at most
// GATEWAY_GRANT_MAX_TTL_SECONDS after the retirement is written.
import { GetCommand, PutCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { GATEWAY_GRANT_MAX_TTL_SECONDS } from './gateway-grant.js';
import { executionMetaKey } from './v2-process-keys.js';

export const GATEWAY_GRANT_RETIREMENT_TABLE_ENV = 'GATEWAY_GRANT_RETIREMENT_TABLE';
export const GATEWAY_GRANT_RETIREMENT_MARGIN_SECONDS = 60 * 60;
// Upper bound on the clock difference between a grant issuer and a retirement
// writer (both Lambda hosts on Amazon Time Sync, normally well under 1ms).
export const GATEWAY_GRANT_RETIREMENT_SKEW_MS = 1000;
// The longest a new run waits for its clock to pass a retirement: one second of
// `iat` granularity plus the skew allowance, plus slack for the read itself.
const MAX_ISSUANCE_WAIT_MS = 1000 + GATEWAY_GRANT_RETIREMENT_SKEW_MS + 500;
const MAX_ID_LENGTH = 128;

const invalidId = (code, message) => Object.assign(new Error(message), { code });

// Raised by a control-plane writer whose retirement write failed. Retirement
// is fail-closed: the caller aborts the operation that would end or replace
// the run (cancel, rewind, delete, ...) before changing any state, and reports
// a retryable error.
export class GatewayGrantRetirementError extends Error {
  constructor(executionId, cause) {
    super('Gateway grants of the execution could not be retired', { cause });
    this.name = 'GatewayGrantRetirementError';
    this.code = 'GATEWAY_GRANT_RETIREMENT_FAILED';
    this.executionId = executionId;
  }
}

const validId = (id) => typeof id === 'string' && id && id.length <= MAX_ID_LENGTH;

const grantKey = (grantId) => {
  if (!validId(grantId)) {
    throw invalidId('GATEWAY_GRANT_ID_INVALID', 'Gateway grant id is invalid');
  }
  return { pk: `GRANT#${grantId}` };
};

const executionKey = (executionId) => {
  if (!validId(executionId)) {
    throw invalidId('GATEWAY_EXECUTION_ID_INVALID', 'Gateway grant execution id is invalid');
  }
  return { pk: `EXEC#${executionId}` };
};

export const gatewayGrantRetirementExpiry = (nowMs) =>
  Math.floor(nowMs / 1000) +
  GATEWAY_GRANT_MAX_TTL_SECONDS +
  GATEWAY_GRANT_RETIREMENT_MARGIN_SECONDS;

// The last `iat` second a retirement written at `nowMs` covers.
export const executionRetirementSecond = (nowMs) =>
  Math.floor((nowMs + GATEWAY_GRANT_RETIREMENT_SKEW_MS) / 1000);

// Idempotent: the first retirement wins and a repeat (durable replay, retried
// step) is a no-op success.
export const retireGatewayGrant = async (
  { ddb, tableName, now = Date.now },
  { grantId, executionId = null, stageId = null, stageCallbackId = null, outcome = null },
) => {
  const nowMs = now();
  try {
    await ddb.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          ...grantKey(grantId),
          grantId,
          executionId,
          stageId,
          stageCallbackId,
          outcome,
          retiredAt: new Date(nowMs).toISOString(),
          expiresAt: gatewayGrantRetirementExpiry(nowMs),
        },
        ConditionExpression: 'attribute_not_exists(pk)',
      }),
    );
    return { retired: true, alreadyRetired: false };
  } catch (error) {
    if (error?.name === 'ConditionalCheckFailedException') {
      return { retired: true, alreadyRetired: true };
    }
    throw error;
  }
};

// Keeps the latest retirement: a repeat with an equal or earlier `retiredAt`
// (cancel twice, a retried request, cancel then the watchdog) fails the
// condition and is a no-op success.
const executionRetirementUpdate = ({ tableName, executionId, nowMs, reason }) => {
  const retiredAt = executionRetirementSecond(nowMs);
  return {
    retiredAt,
    update: {
      TableName: tableName,
      Key: executionKey(executionId),
      UpdateExpression:
        'SET executionId = :executionId, retiredAt = :retiredAt, expiresAt = :expiresAt, ' +
        'retirementReason = :reason, updatedAt = :updatedAt',
      ConditionExpression: 'attribute_not_exists(retiredAt) OR retiredAt < :retiredAt',
      ExpressionAttributeValues: {
        ':executionId': executionId,
        ':retiredAt': retiredAt,
        ':expiresAt':
          retiredAt + GATEWAY_GRANT_MAX_TTL_SECONDS + GATEWAY_GRANT_RETIREMENT_MARGIN_SECONDS,
        ':reason': typeof reason === 'string' && reason ? reason.slice(0, 64) : 'unspecified',
        ':updatedAt': new Date(nowMs).toISOString(),
      },
    },
  };
};

// Retire every grant of `executionId` issued up to now.
//
// `ifOrchestratorRunId` (optional) makes the write conditional on the
// execution's META still naming that run (null: naming none), in one
// transaction. Every control-plane writer passes the run id it read: a write
// that lost a race with a relaunch (a delayed rewind, a late watchdog) would
// otherwise retire the new run's grants. A relaunch replaces the run id before
// the new run signs anything, so the condition fails instead and nothing is
// written (`superseded`); the caller treats that as a stale request.
export const retireGatewayExecution = async (
  { ddb, tableName, processTableName = null, now = Date.now },
  { executionId, reason = null, ifOrchestratorRunId = undefined },
) => {
  const nowMs = now();
  const { retiredAt, update } = executionRetirementUpdate({
    tableName,
    executionId,
    nowMs,
    reason,
  });
  if (ifOrchestratorRunId === undefined) {
    try {
      await ddb.send(new UpdateCommand(update));
      return { retired: true, alreadyRetired: false, retiredAt };
    } catch (error) {
      if (error?.name === 'ConditionalCheckFailedException') {
        return { retired: true, alreadyRetired: true, retiredAt };
      }
      throw error;
    }
  }
  if (!processTableName) {
    throw invalidId(
      'GATEWAY_RETIREMENT_PROCESS_TABLE_MISSING',
      'A run-conditional execution retirement needs the process table',
    );
  }
  const ownsRun = ifOrchestratorRunId
    ? {
        ConditionExpression: 'orchestratorRunId = :retiringRun',
        ExpressionAttributeValues: { ':retiringRun': ifOrchestratorRunId },
      }
    : {
        // "Naming none": a fresh intent's META stores orchestratorRunId as a
        // DynamoDB NULL (buildExecutionMeta), which attribute_not_exists does
        // not match.
        ConditionExpression:
          'attribute_exists(pk) AND (attribute_not_exists(orchestratorRunId) OR ' +
          'attribute_type(orchestratorRunId, :nullType))',
        ExpressionAttributeValues: { ':nullType': 'NULL' },
      };
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            ConditionCheck: {
              TableName: processTableName,
              Key: executionMetaKey(executionId),
              ...ownsRun,
            },
          },
          { Update: update },
        ],
      }),
    );
    return { retired: true, alreadyRetired: false, retiredAt };
  } catch (error) {
    if (error?.name === 'TransactionCanceledException') {
      const [run, retirement] = error.CancellationReasons ?? [];
      if (run?.Code === 'ConditionalCheckFailed') {
        return { retired: false, superseded: true, retiredAt: null };
      }
      if (retirement?.Code === 'ConditionalCheckFailed') {
        return { retired: true, alreadyRetired: true, retiredAt };
      }
    }
    throw error;
  }
};

// The jtis a META row still owes a retirement (a DynamoDB string set, read back
// as a Set; an array is accepted too).
export const pendingGrantRetirementIds = (meta) => {
  const raw = meta?.pendingGrantRetirements;
  if (!raw) return [];
  return [...new Set([...raw].filter((id) => validId(id)))];
};

export const getGatewayExecutionRetirement = async ({ ddb, tableName }, executionId) => {
  const { Item } = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: executionKey(executionId),
      ConsistentRead: true,
      ProjectionExpression: 'retiredAt',
    }),
  );
  return Item ? (Item.retiredAt ?? null) : null;
};

// The jtis the execution's META still owes a retirement. A jti whose retirement
// exhausted its retries is retired already as far as consumers are concerned:
// the record on META is the only trace of it until /start (or rewind, recompose,
// lane repair) writes the GRANT# row and clears it.
const getPendingGrantRetirements = async ({ ddb, processTableName }, executionId) => {
  const { Item } = await ddb.send(
    new GetCommand({
      TableName: processTableName,
      Key: executionMetaKey(executionId),
      ConsistentRead: true,
      ProjectionExpression: 'pendingGrantRetirements',
    }),
  );
  return pendingGrantRetirementIds(Item);
};

// `claims` are the verified grant's { grantId, executionId, issuedAt }. For an
// execution grant, read META first: a pending jti means retired, and a
// concurrent recovery may write the GRANT# row and clear META immediately after
// this read. Only after META rules out a pending jti do we read the GRANT# and
// EXEC# records concurrently (consistent GetItems; consumers keep their
// GetItem-only permission). A malformed execution record retires the grant, and
// an execution grant cannot be checked without the process table (fail closed).
export const isGatewayGrantRetired = async (
  { ddb, tableName, processTableName = null },
  { grantId, executionId = null, issuedAt } = {},
) => {
  const grant = grantKey(grantId);
  const execution = executionId ? executionKey(executionId) : null;
  if (execution && !Number.isInteger(issuedAt)) {
    throw invalidId('GATEWAY_GRANT_ISSUED_AT_INVALID', 'Gateway grant issue time is invalid');
  }
  if (execution && !processTableName) {
    throw invalidId(
      'GATEWAY_RETIREMENT_PROCESS_TABLE_MISSING',
      'An execution grant retirement check needs the process table',
    );
  }
  const pending = execution
    ? await getPendingGrantRetirements({ ddb, processTableName }, executionId)
    : [];
  if (pending.includes(grantId)) return true;

  const [grantRecord, retiredAt] = await Promise.all([
    ddb.send(
      new GetCommand({
        TableName: tableName,
        Key: grant,
        ConsistentRead: true,
        ProjectionExpression: 'pk',
      }),
    ),
    execution ? getGatewayExecutionRetirement({ ddb, tableName }, executionId) : null,
  ]);
  if (grantRecord?.Item) return true;
  if (retiredAt === null || retiredAt === undefined) return false;
  if (!Number.isFinite(retiredAt)) return true;
  return issuedAt <= retiredAt;
};

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Called by a new orchestrator run after it has claimed the execution and
// before it signs any grant: waits until this process's clock (the one that
// stamps `iat`) is past the execution's retirement, so the run's grants are not
// born retired. The wait is bounded; a retirement further in the future than
// any honest writer can produce is logged by the caller, not waited out.
export const awaitGrantIssuanceAfterRetirement = async (
  { ddb, tableName, now = Date.now, sleep = sleepMs },
  executionId,
) => {
  const retiredAt = await getGatewayExecutionRetirement({ ddb, tableName }, executionId);
  if (!Number.isFinite(retiredAt)) return { retiredAt: null, waitedMs: 0, bounded: false };
  const waitMs = (retiredAt + 1) * 1000 - now();
  if (waitMs <= 0) return { retiredAt, waitedMs: 0, bounded: false };
  const waitedMs = Math.min(waitMs, MAX_ISSUANCE_WAIT_MS);
  await sleep(waitedMs);
  return { retiredAt, waitedMs, bounded: waitedMs < waitMs };
};

// The consumer seam for verifyGatewayGrant. Null when the deployment has no
// retirement table (the MCP Gateway is disabled, so no grant is ever issued).
// The process table is read lazily, like the execution retirer's.
export const gatewayGrantRetirementCheckFromEnv = ({ ddb, env = process.env }) => {
  const tableName = env[GATEWAY_GRANT_RETIREMENT_TABLE_ENV];
  if (!tableName) return null;
  return (claims) =>
    isGatewayGrantRetired(
      { ddb, tableName, processTableName: env.V2_PROCESS_TABLE || null },
      claims,
    );
};

export const gatewayGrantRetirerFromEnv = ({ ddb, env = process.env, now = Date.now }) => {
  const tableName = env[GATEWAY_GRANT_RETIREMENT_TABLE_ENV];
  if (!tableName) return null;
  return (retirement) => retireGatewayGrant({ ddb, tableName, now }, retirement);
};

// Execution-level writer and the issuance guard, both null without the table.
// The process table (the META row a run-conditional write checks) is read
// lazily so a test or a caller can set it after import.
export const gatewayExecutionRetirerFromEnv = ({ ddb, env = process.env, now = Date.now }) => {
  const tableName = env[GATEWAY_GRANT_RETIREMENT_TABLE_ENV];
  if (!tableName) return null;
  return (retirement) =>
    retireGatewayExecution(
      { ddb, tableName, processTableName: env.V2_PROCESS_TABLE || null, now },
      retirement,
    );
};

export const gatewayGrantIssuanceGuardFromEnv = ({ ddb, env = process.env, now = Date.now }) => {
  const tableName = env[GATEWAY_GRANT_RETIREMENT_TABLE_ENV];
  if (!tableName) return null;
  return (executionId) => awaitGrantIssuanceAfterRetirement({ ddb, tableName, now }, executionId);
};
