import {
  GetCommand,
  PutCommand,
  UpdateCommand,
  ScanCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  authError,
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
    async getPolicy() {
      if (!tableName) return { ...DEFAULT_AUTH_POLICY };
      return normalizeAuthPolicy((await get(AUTH_POLICY_KEY)) ?? DEFAULT_AUTH_POLICY);
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
      return row ? { ...normalizeConnection(row), secretReference: row.secretReference } : null;
    },
    async getSpaceSelection(projectId) {
      if (!tableName) return null;
      return get({ pk: `AGENTAUTH#SPACE#${assertIdentifier(projectId, 'projectId')}`, sk: 'META' });
    },
    async putConnection(connection, secretReference) {
      requireTable();
      const normalized = normalizeConnection(connection);
      if (
        legacyConnection(normalized.id) ||
        normalized.revision < 1 ||
        (normalized.mechanism !== 'assume-role' &&
          (typeof secretReference !== 'string' ||
            !secretReference.startsWith(`${base}/connections/${normalized.id}/`)))
      ) {
        throw authError('AGENT_AUTH_INVALID', 'Connection requires a dedicated secret reference');
      }
      await ddb.send(
        new TransactWriteCommand({
          TransactItems: [
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
      await ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            { Update: update },
            ...bindings.map((binding) => ({
              Put: {
                TableName: tableName,
                Item: {
                  pk: `AGENTAUTH#SELECTION#${randomUUID()}`,
                  sk: 'META',
                  type: 'AgentSelection',
                  projectId: context.projectId,
                  credentialBinding: binding,
                  status: 'PENDING',
                  selectedAt,
                  agentAuthTtl: Math.floor(Date.now() / 1000) + 600,
                },
              },
            })),
          ],
        }),
      );
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
      await ddb.send(
        new UpdateCommand({
          TableName: tableName,
          Key: AUTH_POLICY_KEY,
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
        }),
      );
    },
    async applyReview({ review, actorId, policy, now }) {
      requireTable();
      const { candidate } = review;
      const connection = candidate.kind === 'iam-connection' ? candidate.connection : null;
      const platformConnection = connection?.source === 'platform';
      const next = {
        mode: platformConnection
          ? 'iam'
          : candidate.kind === 'policy'
            ? candidate.mode
            : policy.mode,
        defaultConnectionId: platformConnection
          ? connection.id
          : candidate.kind === 'policy'
            ? candidate.defaultConnectionId
            : policy.defaultConnectionId,
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
                Key: AUTH_POLICY_KEY,
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
                  ...AUTH_POLICY_KEY,
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
            ...(connection
              ? ['AgentConnection', 'AgentConnectionHead'].map((type) => ({
                  Put: {
                    TableName: tableName,
                    Item: {
                      ...connectionKey(connection.id, type === 'AgentConnection' ? 1 : undefined),
                      ...connection,
                      type,
                    },
                    ConditionExpression: 'attribute_not_exists(pk)',
                  },
                }))
              : []),
            ...(connection?.source === 'space'
              ? [
                  {
                    Put: {
                      TableName: tableName,
                      Item: {
                        pk: `AGENTAUTH#SPACE#${connection.projectId}`,
                        sk: 'META',
                        type: 'AgentSpaceSelection',
                        projectId: connection.projectId,
                        mode: 'iam',
                        connectionId: connection.id,
                        revision: next.revision,
                      },
                    },
                  },
                ]
              : []),
            ...(candidate.kind === 'space-inherit'
              ? [
                  {
                    Delete: {
                      TableName: tableName,
                      Key: { pk: `AGENTAUTH#SPACE#${candidate.projectId}`, sk: 'META' },
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
                  pk: 'AGENTAUTH#AUDIT',
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
