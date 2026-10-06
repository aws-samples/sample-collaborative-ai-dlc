import { createAgentAuthInventoryRepository } from './agent-auth-inventory-repository.js';
import { createAgentAuthReviewRepository } from './agent-auth-review-repository.js';
import {
  authScopeKey,
  inventoryReferenceWrites,
  scopeActivityWrites,
} from './agent-auth-inventory.js';
import { GetCommand, UpdateCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
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
  };
  return Object.assign(
    repository,
    createAgentAuthInventoryRepository({ ddb, tableName, get, requireTable }),
    createAgentAuthReviewRepository({
      ddb,
      tableName,
      get,
      requireTable,
      defaultConnectionId: DEFAULT_AUTH_POLICY.defaultConnectionId,
    }),
  );
};
