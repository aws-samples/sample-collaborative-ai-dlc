// engine-data: the server side of the runtime's live intent broadcasts.
//
// Each call arrives as `{ op: 'realtime.broadcastIntent', args: [{ payload }],
// grant }` and is authorized on its own:
//   1. the grant is verified: engine grants may send agent/compose events, a
//      discussion grant only discussion.message;
//   2. the payload must match the closed event DTO and encode within 32 KiB;
//   3. every ownership id the event carries must equal the grant's. The
//      execution META (consistent read) must belong to the grant's project and
//      intent; without META, a draft compose or a discussion falls back to the
//      Neptune Intent anchor. An existing contradictory META always denies;
//   4. ids the event embeds resolve inside the granted scope: stages (or the
//      Quorum edit behind a `qedit-` pane) in the execution, the compose row in
//      the execution, the discussion message in the intent.
// The channel is always `intent:<grant.intentId>`; connection ids, table and
// endpoint never cross the wire. Delivery queries every connection page, posts
// to all of them, tolerates gone recipients and returns counts only. A failed
// post is not retried: the runtime treats the broadcast as best-effort and a
// duplicate frame is worse than a missed one.
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';
import {
  ENGINE_DATA_REALTIME_OPS,
  ENGINE_DATA_REALTIME_PREFIX,
} from '../shared/engine-data-ops.js';
import { discussionMessageInIntent, readIntentAnchor } from '../shared/engine-graph-ops.js';
import { executionPk } from '../shared/v2-process-keys.js';
import { MAX_EVENT_BYTES, REALTIME_OPS } from './realtime-schemas.js';
import {
  ENGINE_GRANT_MODES,
  EngineDataAccessDenied,
  denialResponse,
  deny,
  grantAudit,
  hasPrototypeKey,
  issuePaths,
  serializeError,
  verifyGrantOrDeny,
} from './gateway-common.js';

const ALLOWED_OPS = new Set(ENGINE_DATA_REALTIME_OPS);
const DISCUSSION_ACTION = 'discussion.message';
const QUORUM_EDIT_PANE = /^qedit-(.+)$/;

const realtimeError = (code, message) => ({
  error: { name: 'EngineRealtimeError', code, message, conflict: false },
});

const isGone = (error) =>
  error?.name === 'GoneException' || error?.$metadata?.httpStatusCode === 410;

const checkIds = (grant, payload) => {
  const executionId = grant.executionId ?? null;
  if (
    (payload.projectId !== undefined && payload.projectId !== grant.projectId) ||
    (payload.intentId !== undefined && payload.intentId !== grant.intentId) ||
    (payload.sprintId !== undefined && payload.sprintId !== grant.intentId) ||
    (payload.executionId !== undefined && payload.executionId !== executionId)
  ) {
    deny('scope_mismatch');
  }
};

const composeIdOf = (compose) => {
  if (typeof compose.composeId === 'string' && compose.composeId) return compose.composeId;
  return typeof compose.sk === 'string' && compose.sk.startsWith('COMPOSE#')
    ? compose.sk.slice('COMPOSE#'.length)
    : null;
};

const checkEmbedded = async (store, grant, payload) => {
  const executionId = grant.executionId;
  const stageInstanceId = payload.stageInstanceId;
  if (stageInstanceId) {
    const pane = payload.action === 'agent.output' ? QUORUM_EDIT_PANE.exec(stageInstanceId) : null;
    if (pane) {
      const edit = await store.getQuorumEdit(executionId, pane[1]);
      if (!edit || (edit.executionId && edit.executionId !== executionId)) deny('scope_mismatch');
    } else {
      const stage = await store.getStage(executionId, stageInstanceId, { consistentRead: true });
      if (!stage || stage.executionId !== executionId) deny('scope_mismatch');
    }
  }
  if (payload.action === 'compose.updated') {
    const { compose } = payload;
    const composeId = composeIdOf(compose);
    if (
      !composeId ||
      (compose.executionId !== undefined && compose.executionId !== executionId) ||
      (compose.pk !== undefined && compose.pk !== executionPk(executionId))
    ) {
      deny('scope_mismatch');
    }
    if (!(await store.getCompose(executionId, composeId))) deny('scope_mismatch');
  }
};

export const createRealtimeGateway = ({
  verifyGrant,
  createStore,
  withGraph,
  ddb,
  api,
  connectionsTable,
  audit = () => {},
  maxEventBytes = MAX_EVENT_BYTES,
  readAnchor = readIntentAnchor,
  messageInIntent = discussionMessageInIntent,
}) => {
  const authorize = async (event, record) => {
    const grant = await verifyGrantOrDeny(verifyGrant, event?.grant);
    Object.assign(record, grantAudit(grant));
    const discussion = grant.mode === 'discussion';
    if (!ENGINE_GRANT_MODES.has(grant.mode) && !discussion) deny('grant_mode_not_allowed');

    const op = typeof event.op === 'string' ? event.op : '';
    const name = op.startsWith(ENGINE_DATA_REALTIME_PREFIX)
      ? op.slice(ENGINE_DATA_REALTIME_PREFIX.length)
      : null;
    if (!name || !ALLOWED_OPS.has(name) || !Object.hasOwn(REALTIME_OPS, name)) {
      deny('op_not_allowed');
    }
    const { args } = event;
    if (!Array.isArray(args) || args.length !== 1 || hasPrototypeKey(args)) {
      deny('invalid_arguments');
    }
    const result = REALTIME_OPS[name].safeParse(args[0]);
    if (!result.success) deny('invalid_arguments', { issues: issuePaths(0, result.error) });
    const { action } = result.data.payload;
    record.action = action;
    if (discussion !== (action === DISCUSSION_ACTION)) deny('op_not_allowed');
    // The validated object is strict, so the original carries exactly the
    // checked fields and keeps the producer's field order on the wire.
    const payload = args[0].payload;
    checkIds(grant, payload);
    return { grant, payload, discussion };
  };

  const checkScope = async ({ grant, payload, discussion }) => {
    const store = createStore();
    const metaId = discussion ? grant.intentId : grant.executionId;
    const meta = await store.getExecution(metaId, { consistentRead: true });
    if (meta && (meta.projectId !== grant.projectId || meta.intentId !== grant.intentId)) {
      deny('scope_mismatch');
    }
    // Only a draft compose (an execution grant whose execution id is the
    // intent id) or a discussion runs before its intent has execution META.
    if (
      !meta &&
      !discussion &&
      (grant.mode !== 'execution' || grant.executionId !== grant.intentId)
    ) {
      deny('execution_not_found');
    }
    if (!discussion) await checkEmbedded(store, grant, payload);
    if (meta && !discussion) return;

    await withGraph(
      async (g) => {
        if (!meta) {
          const anchor = await readAnchor(g, grant.intentId);
          if (!anchor.exists) deny('intent_not_found');
          if (anchor.projectIds.length !== 1 || anchor.projectIds[0] !== grant.projectId) {
            deny('scope_mismatch');
          }
        }
        if (discussion) {
          const { discussionId, message } = payload;
          if (
            (message.discussionId !== undefined && message.discussionId !== discussionId) ||
            (message.sprintId !== undefined && message.sprintId !== grant.intentId) ||
            !(await messageInIntent(g, {
              intentId: grant.intentId,
              discussionId,
              messageId: message.id,
            }))
          ) {
            deny('discussion_not_in_scope');
          }
        }
      },
      { retryAuth: true },
    );
  };

  const deliver = async (grant, data) => {
    const items = [];
    let ExclusiveStartKey;
    do {
      const page = await ddb.send(
        new QueryCommand({
          TableName: connectionsTable,
          IndexName: 'DocumentIdIndex',
          KeyConditionExpression: 'documentId = :doc',
          ExpressionAttributeValues: { ':doc': `intent:${grant.intentId}` },
          ExclusiveStartKey,
        }),
      );
      items.push(...(page.Items ?? []));
      ExclusiveStartKey = page.LastEvaluatedKey;
    } while (ExclusiveStartKey);

    const outcomes = await Promise.allSettled(
      items.map((item) =>
        typeof item?.connectionId === 'string' && item.connectionId
          ? api.send(new PostToConnectionCommand({ ConnectionId: item.connectionId, Data: data }))
          : Promise.reject(new Error('connection row has no id')),
      ),
    );
    const counts = { recipients: items.length, delivered: 0, gone: 0, failed: 0 };
    for (const outcome of outcomes) {
      if (outcome.status === 'fulfilled') counts.delivered += 1;
      else if (isGone(outcome.reason)) counts.gone += 1;
      else counts.failed += 1;
    }
    return counts;
  };

  return async (event) => {
    const startedAt = Date.now();
    const record = { op: typeof event?.op === 'string' ? event.op : null };
    const finish = (fields) => audit({ ...record, ...fields, ms: Date.now() - startedAt });
    let authorized;
    try {
      authorized = await authorize(event, record);
      const data = JSON.stringify(authorized.payload);
      const bytes = Buffer.byteLength(data, 'utf8');
      if (bytes > maxEventBytes) {
        finish({ decision: 'error', outcome: 'event_too_large', bytes });
        return realtimeError('event_too_large', 'Realtime event is too large to broadcast');
      }
      await checkScope(authorized);
      if (!connectionsTable || !api) {
        finish({ decision: 'error', outcome: 'misconfigured' });
        return realtimeError(
          'realtime_misconfigured',
          'Engine data has no connections table or websocket endpoint',
        );
      }
      const counts = await deliver(authorized.grant, data);
      finish({ decision: 'allow', outcome: 'ok', ...counts });
      return { ok: true, result: counts };
    } catch (error) {
      if (error instanceof EngineDataAccessDenied) {
        finish({ ...error.detail, decision: 'deny', reason: error.reason });
        return denialResponse(error);
      }
      finish({
        decision: authorized ? 'allow' : 'error',
        outcome: authorized ? 'delivery_error' : 'error',
        error: error?.name ?? 'Error',
      });
      return { error: serializeError(error) };
    }
  };
};
