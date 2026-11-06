import { inventoryReferenceWrites, scopeActivityWrites } from './agent-auth-inventory.js';
import { randomUUID } from 'node:crypto';
import { GetCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { authError, credentialChangeAffects } from './agent-auth-contracts.js';

// `budget` ({ grantId, limit, expiresAt }) caps how many invocations one signed grant may
// begin. Its counter commits with the begin, so only begins that took effect count.
const budgetWrite = (tableName, { grantId, limit, expiresAt }) => ({
  Update: {
    TableName: tableName,
    Key: { pk: `AGENTAUTH#INVOCATION-BUDGET#${grantId}`, sk: 'META' },
    UpdateExpression:
      'SET #type = :type, agentAuthTtl = if_not_exists(agentAuthTtl, :ttl) ADD begins :one',
    ConditionExpression: 'attribute_not_exists(begins) OR begins < :limit',
    ExpressionAttributeNames: { '#type': 'type' },
    ExpressionAttributeValues: {
      ':type': 'AgentInvocationBudget',
      ':ttl': expiresAt,
      ':one': 1,
      ':limit': limit,
    },
  },
});

export const beginCredentialInvocation = async ({
  ddb,
  tableName,
  payload,
  bindings = [],
  id = randomUUID(),
  now = Date.now,
  budget = null,
}) => {
  if (!tableName || bindings.length === 0) return;
  const Key = { pk: `AGENTAUTH#INVOCATION#${id}`, sk: 'META' };
  const stamp = () => new Date(now()).toISOString();
  const policyKey = { pk: 'AGENTAUTH#POLICY', sk: 'META' };
  const { Item: policy } = await ddb.send(
    new GetCommand({ TableName: tableName, Key: policyKey, ConsistentRead: true }),
  );
  if (policy?.pendingReview) {
    const { Item: pending } = await ddb.send(
      new GetCommand({
        TableName: tableName,
        Key: { pk: `AGENTAUTH#REVIEW#${policy.pendingReview}`, sk: 'META' },
        ConsistentRead: true,
      }),
    );
    if (
      bindings.some((binding) =>
        credentialChangeAffects(pending?.candidate, binding, payload.projectId),
      )
    ) {
      throw authError('AGENT_AUTH_CHANGE_IN_PROGRESS', 'The selected credential is being updated');
    }
  }
  const invocation = {
    ...Key,
    type: 'AgentInvocation',
    id,
    executionId: payload.executionId ?? payload.intentId ?? null,
    projectId: payload.projectId ?? null,
    command: payload.command,
    credentialBinding: bindings[0] ?? null,
    credentialBindings: bindings,
    agentAuthProtocol: 2,
    state: 'ACTIVE',
    startedAt: stamp(),
    heartbeatAt: stamp(),
  };
  const scopeWrites = scopeActivityWrites(tableName, [invocation]);
  for (const { Update: write } of scopeWrites) {
    const { Item: state } = await ddb.send(
      new GetCommand({ TableName: tableName, Key: write.Key, ConsistentRead: true }),
    );
    write.ConditionExpression = '(attribute_not_exists(revision) OR revision = :revision)';
    write.ExpressionAttributeValues[':revision'] = state?.revision ?? 0;
    if (state?.pendingReview) {
      const { Item: pending } = await ddb.send(
        new GetCommand({
          TableName: tableName,
          Key: { pk: `AGENTAUTH#REVIEW#${state.pendingReview}`, sk: 'META' },
          ConsistentRead: true,
        }),
      );
      if (
        bindings.some((binding) =>
          credentialChangeAffects(pending?.candidate, binding, payload.projectId),
        )
      )
        throw authError(
          'AGENT_AUTH_CHANGE_IN_PROGRESS',
          'The selected credential is being updated',
        );
    }
  }
  const transactItems = [
    ...scopeWrites,
    ...inventoryReferenceWrites(tableName, invocation),
    {
      Put: {
        TableName: tableName,
        Item: invocation,
        ConditionExpression: 'attribute_not_exists(pk)',
      },
    },
    {
      Update: {
        TableName: tableName,
        Key: policyKey,
        UpdateExpression:
          'SET revision = if_not_exists(revision, :zero), #mode = if_not_exists(#mode, :mode), defaultConnectionId = if_not_exists(defaultConnectionId, :connection) ADD activityRevision :one',
        ConditionExpression: '(attribute_not_exists(revision) OR revision = :revision)',
        ExpressionAttributeNames: { '#mode': 'mode' },
        ExpressionAttributeValues: {
          ':zero': 0,
          ':one': 1,
          ':mode': 'keys',
          ':connection': 'legacy-platform-bedrock',
          ':revision': policy?.revision ?? 0,
        },
      },
    },
    ...(budget ? [budgetWrite(tableName, budget)] : []),
  ];
  try {
    await ddb.send(new TransactWriteCommand({ TransactItems: transactItems }));
  } catch (error) {
    if (
      budget &&
      error?.name === 'TransactionCanceledException' &&
      error.CancellationReasons?.[transactItems.length - 1]?.Code === 'ConditionalCheckFailed'
    ) {
      // The id is derived from the grant and nonce, so a row under it is this same begin,
      // committed by a concurrent retry that took the last slot: a duplicate begin the
      // caller recovers from that row, not a new invocation over the cap.
      const stored = await readCredentialInvocation({ ddb, tableName, id });
      if (stored?.type === 'AgentInvocation' && stored.id === id) throw error;
      throw authError(
        'INVOCATION_ACCOUNTING_LIMIT',
        'This credential grant has begun its maximum number of invocations',
      );
    }
    throw error;
  }
  return invocation;
};

export const readCredentialInvocation = async ({ ddb, tableName, id }) => {
  const { Item } = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: { pk: `AGENTAUTH#INVOCATION#${id}`, sk: 'META' },
      ConsistentRead: true,
    }),
  );
  return Item;
};

export const heartbeatCredentialInvocation = ({ ddb, tableName, invocation, now = Date.now }) =>
  ddb.send(
    new UpdateCommand({
      TableName: tableName,
      Key: { pk: invocation.pk, sk: invocation.sk },
      UpdateExpression: 'SET heartbeatAt = :now',
      ConditionExpression: '#state = :active',
      ExpressionAttributeNames: { '#state': 'state' },
      ExpressionAttributeValues: { ':now': new Date(now()).toISOString(), ':active': 'ACTIVE' },
    }),
  );

export const finishCredentialInvocation = async ({
  ddb,
  tableName,
  invocation,
  now = Date.now,
}) => {
  if (invocation.state === 'FINISHED') return;
  const agentAuthTtl = Math.floor(now() / 1000) + 86400;
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: tableName,
              Key: { pk: invocation.pk, sk: invocation.sk },
              UpdateExpression: 'SET #state = :state, completedAt = :now, agentAuthTtl = :ttl',
              ConditionExpression: '#state = :active',
              ExpressionAttributeNames: { '#state': 'state' },
              ExpressionAttributeValues: {
                ':state': 'FINISHED',
                ':now': new Date(now()).toISOString(),
                ':ttl': agentAuthTtl,
                ':active': 'ACTIVE',
              },
            },
          },
          ...inventoryReferenceWrites(tableName, { ...invocation, agentAuthTtl }),
        ],
      }),
    );
  } catch (error) {
    if (error.name === 'TransactionCanceledException') {
      const stored = await readCredentialInvocation({ ddb, tableName, id: invocation.id });
      if (stored?.type === 'AgentInvocation' && stored.state === 'FINISHED') return;
    }
    throw error;
  }
};
