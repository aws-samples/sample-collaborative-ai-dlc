import { randomUUID } from 'node:crypto';
import { GetCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { authError, credentialChangeAffects } from '../shared/agent-auth-catalog.js';

// Auxiliary work can outlive HTTP requests and RUNNING intent status. Account
// for its actual session lifetime; stale heartbeats are uncertainty, not proof
// that the work has stopped.
export const accountCredentialInvocation = async ({
  ddb,
  tableName,
  session,
  payload,
  bindings = [],
  now = Date.now,
}) => {
  if (!tableName || bindings.length === 0) return;
  const id = randomUUID();
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
  await ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: tableName,
            Item: {
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
            },
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
      ],
    }),
  );
  let stopped = false;
  let pending = Promise.resolve();
  const timer = setInterval(() => {
    if (stopped) return;
    pending = pending
      .then(() =>
        ddb.send(
          new UpdateCommand({
            TableName: tableName,
            Key,
            UpdateExpression: 'SET heartbeatAt = :now',
            ConditionExpression: '#state = :active',
            ExpressionAttributeNames: { '#state': 'state' },
            ExpressionAttributeValues: { ':now': stamp(), ':active': 'ACTIVE' },
          }),
        ),
      )
      .catch(() => {
        /* inventory reports stale evidence */
      });
  }, 30_000);
  timer.unref?.();
  const finish = async () => {
    stopped = true;
    clearInterval(timer);
    await pending;
    await ddb.send(
      new UpdateCommand({
        TableName: tableName,
        Key,
        UpdateExpression: 'SET #state = :state, completedAt = :now, agentAuthTtl = :ttl',
        ExpressionAttributeNames: { '#state': 'state' },
        ExpressionAttributeValues: {
          ':state': 'FINISHED',
          ':now': stamp(),
          ':ttl': Math.floor(now() / 1000) + 86400,
        },
      }),
    );
  };
  try {
    session.own(finish);
  } catch (error) {
    await finish();
    throw error;
  }
};
