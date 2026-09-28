import { authActionWrites } from './agent-auth-actions.js';
import {
  AUTH_INVENTORY_KEY,
  authenticationScope,
  authScopeKey,
  inventoryReferenceWrites,
  scopeActivityWrites,
  scopeContainsRow,
} from './agent-auth-inventory.js';
import {
  GetCommand,
  PutCommand,
  UpdateCommand,
  ScanCommand,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  authError,
  credentialChangeAffects,
  assertIdentifier,
  normalizeConnection,
  AGENT_AUTH_MODES_CATALOG,
} from './agent-auth-catalog.js';
import { agentCredentialPath } from './agent-key-repository.js';
import { randomUUID } from 'node:crypto';

export const AUTH_POLICY_KEY = Object.freeze({ pk: 'AGENTAUTH#POLICY', sk: 'META' });
export const DEFAULT_AUTH_POLICY = Object.freeze({
  revision: 0,
  activityRevision: 0,
  mode: 'keys',
  defaultConnectionId: 'legacy-platform-bedrock',
});
export const legacyConnectionId = ({ provider, source, projectId, userId }) =>
  `legacy-${source}-${provider}${source === 'space' ? `-${projectId}` : source === 'user' ? `-${userId}` : ''}`;
export const legacyConnection = (id) => {
  const match = /^legacy-(platform|space|user)-(bedrock|kiro)(?:-(.+))?$/.exec(id);
  if (!match) return null;
  const [, source, backend, owner] = match;
  if ((source === 'platform') !== !owner)
    throw authError('AGENT_AUTH_INVALID', 'Legacy connection reference is invalid');
  return normalizeConnection({
    id,
    revision: 0,
    mode: backend === 'kiro' ? 'kiro' : 'keys',
    backend,
    mechanism: 'api-key',
    source,
    projectId: source === 'space' ? owner : undefined,
    userId: source === 'user' ? owner : undefined,
    configuration: {},
  });
};
const connectionKey = (id, revision) => ({
  pk: `AGENTAUTH#CONNECTION#${assertIdentifier(id, 'connectionId')}`,
  sk: revision === undefined ? 'META' : `REV#${revision}`,
});
export const normalizeAuthPolicy = (policy) => {
  const mode = AGENT_AUTH_MODES_CATALOG.find((item) => item.id === policy?.mode);
  if (!mode) throw authError('AGENT_AUTH_INVALID', 'Unsupported authentication mode');
  if (!Number.isSafeInteger(policy.revision) || policy.revision < 0)
    throw authError('AGENT_AUTH_INVALID', 'Policy revision is invalid');
  return {
    mode: mode.id,
    revision: policy.revision,
    activityRevision: policy.activityRevision ?? 0,
    defaultConnectionId: assertIdentifier(policy.defaultConnectionId, 'defaultConnectionId'),
    ...(policy.pendingReview ? { pendingReview: policy.pendingReview } : {}),
  };
};

// Non-secret control records use the existing process table. Immutable revisions
// retain old definitions; a retirement never deletes a pinned revision or secret.
export const createAgentConnectionRepository = ({ ddb, tableName, base = '' }) => {
  const get = async (Key) =>
    (await ddb.send(new GetCommand({ TableName: tableName, Key, ConsistentRead: true }))).Item ??
    null;
  const requireTable = () => {
    if (!tableName || !ddb)
      throw authError(
        'AGENT_AUTH_NOT_CONFIGURED',
        'Agent authentication control store is not configured',
      );
  };
  const repository = {
    async getPolicy(scope = {}) {
      if (scope.source && scope.source !== 'platform') {
        const policy = await repository.getPolicy();
        const state = await repository.getScopeState(scope);
        return { ...policy, ...state, configurationRevision: policy.revision };
      }
      if (!tableName) return { ...DEFAULT_AUTH_POLICY };
      return normalizeAuthPolicy({ ...DEFAULT_AUTH_POLICY, ...(await get(AUTH_POLICY_KEY)) });
    },
    async getScopeState(scope) {
      const state = tableName ? await get(authScopeKey(scope)) : null;
      return {
        revision: state?.revision ?? 0,
        activityRevision: state?.activityRevision ?? 0,
        ...(state?.pendingReview ? { pendingReview: state.pendingReview } : {}),
      };
    },
    async getConnection(id, revision) {
      const legacy = legacyConnection(id);
      if (legacy) {
        if (revision !== undefined && revision !== 0) return null;
        return {
          ...legacy,
          secretReference: agentCredentialPath({
            base,
            provider: legacy.backend,
            source: legacy.source,
            projectId: legacy.projectId,
            userId: legacy.userId,
          }),
        };
      }
      requireTable();
      const row = await get(connectionKey(id, revision));
      return row
        ? {
            ...normalizeConnection(row),
            ...(row.secretReference ? { secretReference: row.secretReference } : {}),
          }
        : null;
    },
    async getSpaceSelection(projectId) {
      if (!tableName) return null;
      return get({ pk: `AGENTAUTH#SPACE#${assertIdentifier(projectId, 'projectId')}`, sk: 'META' });
    },
    validateStorageReference(id, secretReference) {
      if (
        secretReference !== undefined &&
        (typeof secretReference !== 'string' ||
          !secretReference.startsWith(`${base}/connections/${id}/`))
      )
        throw authError('AGENT_AUTH_INVALID', 'Connection requires a dedicated secret reference');
    },
    async putConnection(connection, secretReference) {
      requireTable();
      const normalized = normalizeConnection(connection);
      if (
        legacyConnection(normalized.id) ||
        normalized.revision < 1 ||
        (secretReference !== undefined &&
          (typeof secretReference !== 'string' ||
            !secretReference.startsWith(`${base}/connections/${normalized.id}/`)))
      ) {
        throw authError('AGENT_AUTH_INVALID', 'Connection requires a dedicated secret reference');
      }
      await ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            ...inventoryReferenceWrites(tableName, {
              ...connectionKey(normalized.id),
              ...normalized,
            }),
            ...scopeActivityWrites(tableName, [normalized], { includePlatform: true }),
            {
              Put: {
                TableName: tableName,
                Item: {
                  ...connectionKey(normalized.id, normalized.revision),
                  ...normalized,
                  ...(secretReference ? { secretReference } : {}),
                  type: 'AgentConnection',
                },
                ConditionExpression: 'attribute_not_exists(pk)',
              },
            },
            {
              Put: {
                TableName: tableName,
                Item: {
                  ...connectionKey(normalized.id),
                  ...normalized,
                  ...(secretReference ? { secretReference } : {}),
                  type: 'AgentConnectionHead',
                },
                ConditionExpression:
                  normalized.revision === 1 ? 'attribute_not_exists(pk)' : 'revision = :previous',
                ...(normalized.revision === 1
                  ? {}
                  : { ExpressionAttributeValues: { ':previous': normalized.revision - 1 } }),
              },
            },
          ],
        }),
      );
      return normalized;
    },
    async claimSelection(expectedPolicyRevision, context) {
      if (!tableName) return;
      // Epoch changes invalidate impact reviews even if selection occurs while a
      // paginated inventory is being assembled.
      const update = {
        TableName: tableName,
        Key: AUTH_POLICY_KEY,
        UpdateExpression:
          'SET revision = if_not_exists(revision, :zero), #mode = if_not_exists(#mode, :mode), defaultConnectionId = if_not_exists(defaultConnectionId, :connection) ADD activityRevision :one',
        ConditionExpression:
          expectedPolicyRevision === 0
            ? '(attribute_not_exists(revision) OR revision = :revision)'
            : 'revision = :revision',
        ExpressionAttributeNames: { '#mode': 'mode' },
        ExpressionAttributeValues: {
          ':zero': 0,
          ':one': 1,
          ':revision': expectedPolicyRevision,
          ':mode': 'keys',
          ':connection': DEFAULT_AUTH_POLICY.defaultConnectionId,
        },
      };
      if (!context) return ddb.send(new UpdateCommand(update));
      const selectedAt = new Date().toISOString();
      const bindings = Object.values(context.bindings ?? {}).filter(Boolean);
      const rows = bindings.map((binding) => ({
        pk: `AGENTAUTH#SELECTION#${randomUUID()}`,
        sk: 'META',
        type: 'AgentSelection',
        projectId: context.projectId ?? null,
        credentialBinding: binding,
        status: 'PENDING',
        selectedAt,
        agentAuthTtl: Math.floor(Date.now() / 1000) + 600,
      }));
      const scopeWrites = scopeActivityWrites(tableName, rows);
      for (const { Update: write } of scopeWrites) {
        const state = await get(write.Key);
        write.ConditionExpression = '(attribute_not_exists(revision) OR revision = :revision)';
        write.ExpressionAttributeValues[':revision'] = state?.revision ?? 0;
        if (state?.pendingReview) {
          const pending = await repository.getReview(state.pendingReview);
          if (
            bindings.some((binding) =>
              credentialChangeAffects(pending?.candidate, binding, context.projectId),
            )
          )
            throw authError(
              'AGENT_AUTH_CHANGE_IN_PROGRESS',
              'The selected credential is being updated',
            );
        }
      }
      await ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            { Update: update },
            ...scopeWrites,
            ...rows.flatMap((row) => [
              { Put: { TableName: tableName, Item: row } },
              ...inventoryReferenceWrites(tableName, row),
            ]),
          ],
        }),
      );
    },
    async loadInventory(candidate = {}) {
      const scope = authenticationScope(candidate);
      if (scope.source === 'platform') return repository.scanInventory();
      requireTable();
      const readiness = await get(AUTH_INVENTORY_KEY);
      if (readiness?.version !== 1)
        throw authError(
          'AGENT_AUTH_INVENTORY_NOT_READY',
          'The scoped authentication inventory must be initialized before reviewing credentials',
        );
      const rows = [];
      let referenceCount = 0;
      let ExclusiveStartKey;
      do {
        const page = await ddb.send(
          new QueryCommand({
            TableName: tableName,
            ConsistentRead: true,
            ExclusiveStartKey,
            KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
            ExpressionAttributeValues: { ':pk': authScopeKey(scope).pk, ':prefix': 'REF#' },
            Limit: 100,
          }),
        );
        for (const reference of page.Items ?? []) {
          referenceCount += 1;
          if (referenceCount > 5000)
            throw authError(
              'AGENT_AUTH_INVENTORY_TOO_LARGE',
              'This scope requires an administrator inventory review',
            );
          const row = await get(reference.target);
          if (row && scopeContainsRow(scope, row)) rows.push(row);
        }
        if (rows.length > 5000)
          throw authError(
            'AGENT_AUTH_INVENTORY_TOO_LARGE',
            'This scope requires an administrator inventory review',
          );
        ExclusiveStartKey = page.LastEvaluatedKey;
      } while (ExclusiveStartKey);
      // Auxiliary records inherit their execution binding. Query only their key
      // prefixes, never the execution's potentially large output/event partition.
      for (const execution of rows.filter((row) => row.type === 'Execution')) {
        for (const prefix of ['COMPOSE#', 'QEDIT#']) {
          let cursor;
          do {
            const page = await ddb.send(
              new QueryCommand({
                TableName: tableName,
                ConsistentRead: true,
                ExclusiveStartKey: cursor,
                KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
                ExpressionAttributeValues: { ':pk': execution.pk, ':prefix': prefix },
                Limit: 100,
              }),
            );
            rows.push(...(page.Items ?? []));
            if (rows.length > 5000)
              throw authError(
                'AGENT_AUTH_INVENTORY_TOO_LARGE',
                'This scope requires an administrator inventory review',
              );
            cursor = page.LastEvaluatedKey;
          } while (cursor);
        }
      }
      return rows;
    },
    async initializeInventory() {
      // Explicit operator-only backfill. Never called from personal/space HTTP paths.
      const rows = await repository.scanInventory();
      for (const row of rows) {
        const writes = inventoryReferenceWrites(tableName, row);
        if (writes.length) await ddb.send(new TransactWriteCommand({ TransactItems: writes }));
      }
      await ddb.send(
        new PutCommand({
          TableName: tableName,
          Item: { ...AUTH_INVENTORY_KEY, version: 1, initializedAt: new Date().toISOString() },
        }),
      );
      return { records: rows.length };
    },
    async scanInventory() {
      requireTable();
      const items = [];
      let ExclusiveStartKey;
      do {
        const page = await ddb.send(
          new ScanCommand({
            TableName: tableName,
            ConsistentRead: true,
            ExclusiveStartKey,
            FilterExpression:
              'begins_with(pk, :auth) OR begins_with(pk, :execution) OR begins_with(pk, :environment)',
            ExpressionAttributeValues: {
              ':auth': 'AGENTAUTH#',
              ':execution': 'EXEC#',
              ':environment': 'ENV#',
            },
          }),
        );
        const relevant = (page.Items ?? []).filter((row) =>
          [
            'Execution',
            'AgentConnectionHead',
            'AgentInvocation',
            'AgentSelection',
            'EnvironmentRevision',
            'Compose',
            'QuorumEdit',
          ].includes(row.type),
        );
        const currentRows = await Promise.all(
          relevant.map((row) => get({ pk: row.pk, sk: row.sk })),
        );
        items.push(...currentRows.filter(Boolean));
        ExclusiveStartKey = page.LastEvaluatedKey;
      } while (ExclusiveStartKey);
      return items;
    },
    async putReview(review) {
      requireTable();
      const { items: _items, ...storedReview } = review;
      await ddb.send(
        new PutCommand({
          TableName: tableName,
          Item: {
            pk: `AGENTAUTH#REVIEW#${review.id}`,
            sk: 'META',
            ...storedReview,
            type: 'AgentAuthReview',
          },
          ConditionExpression: 'attribute_not_exists(pk)',
        }),
      );
    },
    async getReview(id) {
      requireTable();
      return get({ pk: `AGENTAUTH#REVIEW#${assertIdentifier(id, 'reviewId')}`, sk: 'META' });
    },
    async lockReview(review) {
      requireTable();
      const lock = {
        TableName: tableName,
        Key: authScopeKey(review.candidate),
        UpdateExpression:
          'SET pendingReview = :review, revision = :next, activityRevision = if_not_exists(activityRevision, :activity), #mode = if_not_exists(#mode, :mode), defaultConnectionId = if_not_exists(defaultConnectionId, :connection)',
        ConditionExpression:
          'attribute_not_exists(pendingReview) AND (attribute_not_exists(revision) OR revision = :revision) AND (attribute_not_exists(activityRevision) OR activityRevision = :activity)',
        ExpressionAttributeNames: { '#mode': 'mode' },
        ExpressionAttributeValues: {
          ':review': review.id,
          ':revision': review.policyRevision,
          ':next': review.policyRevision + 1,
          ':activity': review.activityRevision,
          ':mode': 'keys',
          ':connection': DEFAULT_AUTH_POLICY.defaultConnectionId,
        },
      };
      if (review.configurationRevision === undefined) return ddb.send(new UpdateCommand(lock));
      await ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            { Update: lock },
            {
              Update: {
                TableName: tableName,
                Key: AUTH_POLICY_KEY,
                UpdateExpression: 'ADD activityRevision :one',
                ConditionExpression:
                  '(attribute_not_exists(revision) OR revision = :revision) AND attribute_not_exists(pendingReview)',
                ExpressionAttributeValues: { ':one': 1, ':revision': review.configurationRevision },
              },
            },
          ],
        }),
      );
    },
    async applyReview({ review, actorId, policy, now }) {
      requireTable();
      const selectedPlatform =
        review.candidate.kind === 'connection-create' &&
        review.candidate.select &&
        review.candidate.connection.source === 'platform'
          ? review.candidate.connection
          : null;
      const next = {
        mode:
          selectedPlatform?.mode ??
          (review.candidate.kind === 'policy-change' ? review.candidate.mode : policy.mode),
        defaultConnectionId:
          selectedPlatform?.id ??
          (review.candidate.kind === 'policy-change'
            ? review.candidate.defaultConnectionId
            : policy.defaultConnectionId),
        revision: review.policyRevision + 1,
        activityRevision: policy.activityRevision,
      };
      const values = { ':revision': review.policyRevision, ':activity': review.activityRevision };
      let condition =
        review.policyRevision === 0 && review.activityRevision === 0
          ? '(attribute_not_exists(revision) OR revision = :revision) AND (attribute_not_exists(activityRevision) OR activityRevision = :activity)'
          : 'revision = :revision AND activityRevision = :activity';
      condition += ' AND attribute_not_exists(pendingReview)';
      const policyWrite =
        review.candidate.kind === 'credential-update'
          ? {
              Update: {
                TableName: tableName,
                Key: authScopeKey(review.candidate),
                UpdateExpression: 'SET updatedBy = :actor, updatedAt = :now REMOVE pendingReview',
                ConditionExpression: 'revision = :revision AND pendingReview = :review',
                ExpressionAttributeValues: {
                  ':revision': next.revision,
                  ':review': review.id,
                  ':actor': actorId,
                  ':now': now,
                },
              },
            }
          : {
              Put: {
                TableName: tableName,
                Item: {
                  ...authScopeKey(review.candidate),
                  ...next,
                  type: 'AgentAuthPolicy',
                  updatedBy: actorId,
                  updatedAt: now,
                },
                ConditionExpression: condition,
                ExpressionAttributeValues: values,
              },
            };
      await ddb.send(
        new TransactWriteCommand({
          ClientRequestToken: review.id,
          TransactItems: [
            policyWrite,
            ...authActionWrites({ action: review.candidate, tableName }),
            ...(review.candidate.kind === 'connection-create'
              ? inventoryReferenceWrites(tableName, {
                  pk: `AGENTAUTH#CONNECTION#${review.candidate.connection.id}`,
                  sk: 'META',
                  ...review.candidate.connection,
                })
              : []),
            ...(review.configurationRevision !== undefined &&
            review.candidate.kind !== 'credential-update'
              ? [
                  {
                    Update: {
                      TableName: tableName,
                      Key: AUTH_POLICY_KEY,
                      UpdateExpression: 'ADD activityRevision :one',
                      ConditionExpression:
                        '(attribute_not_exists(revision) OR revision = :revision) AND attribute_not_exists(pendingReview)',
                      ExpressionAttributeValues: {
                        ':one': 1,
                        ':revision': review.configurationRevision,
                      },
                    },
                  },
                ]
              : []),
            {
              Update: {
                TableName: tableName,
                Key: { pk: `AGENTAUTH#REVIEW#${review.id}`, sk: 'META' },
                UpdateExpression:
                  'SET appliedRevision = :revision, appliedBy = :actor, appliedAt = :now',
                ConditionExpression: 'attribute_not_exists(appliedRevision)',
                ExpressionAttributeValues: {
                  ':revision': next.revision,
                  ':actor': actorId,
                  ':now': now,
                },
              },
            },
            {
              Put: {
                TableName: tableName,
                Item: {
                  pk: `${authScopeKey(review.candidate).pk}#AUDIT`,
                  sk: `REV#${String(next.revision).padStart(12, '0')}`,
                  type: 'AgentAuthAudit',
                  reviewId: review.id,
                  revision: next.revision,
                  actorId,
                  at: now,
                  candidate: review.candidate,
                  inventoryHash: review.inventoryHash,
                },
                ConditionExpression: 'attribute_not_exists(pk)',
              },
            },
          ],
        }),
      );
      return next;
    },
  };
  return repository;
};
