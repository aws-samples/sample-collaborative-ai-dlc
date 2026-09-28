import { createHash } from 'node:crypto';
import {
  authError,
  assertIdentifier,
  assertSource,
  credentialChangeAffects,
} from './agent-auth-contracts.js';

export const AUTH_INVENTORY_KEY = Object.freeze({ pk: 'AGENTAUTH#INVENTORY', sk: 'META' });
export const authenticationScope = ({ source = 'platform', projectId, userId } = {}) => {
  assertSource(source);
  return {
    source,
    ...(source === 'space' ? { projectId: assertIdentifier(projectId, 'projectId') } : {}),
    ...(source === 'user' ? { userId: assertIdentifier(userId, 'userId') } : {}),
  };
};
export const authScopeKey = (scope) => {
  const selected = authenticationScope(scope);
  return {
    pk:
      selected.source === 'platform'
        ? 'AGENTAUTH#POLICY'
        : `AGENTAUTH#SCOPE#${selected.source}#${selected.projectId ?? selected.userId}`,
    sk: 'META',
  };
};
export const inventoryScopes = (row) => {
  const scopes = [];
  if (row.projectId) scopes.push({ source: 'space', projectId: row.projectId });
  if (row.source === 'user' && row.userId) scopes.push({ source: 'user', userId: row.userId });
  for (const binding of row.credentialBindings ?? [row.credentialBinding].filter(Boolean)) {
    if (binding.source === 'user') scopes.push({ source: 'user', userId: binding.userId });
  }
  return [...new Map(scopes.map((scope) => [authScopeKey(scope).pk, scope])).values()];
};
export const scopeContainsRow = (scope, row) =>
  scope.source === 'platform' ||
  inventoryScopes(row).some((candidate) => authScopeKey(candidate).pk === authScopeKey(scope).pk);

// References contain no copied execution state. Queries re-read the authoritative
// row and check ownership again, including references left by a changed binding.
export const inventoryReferenceWrites = (tableName, row) => {
  const digest = createHash('sha256')
    .update(JSON.stringify([row.pk, row.sk]))
    .digest('hex');
  return inventoryScopes(row).map((scope) => ({
    Put: {
      TableName: tableName,
      Item: {
        pk: authScopeKey(scope).pk,
        sk: `REF#${digest}`,
        type: 'AgentAuthInventoryReference',
        target: { pk: row.pk, sk: row.sk },
        ...(row.agentAuthTtl ? { agentAuthTtl: row.agentAuthTtl } : {}),
      },
    },
  }));
};

export const scopeActivityWrites = (tableName, rows, { includePlatform = false } = {}) => {
  const scopes = rows.flatMap(inventoryScopes);
  if (includePlatform) scopes.push({ source: 'platform' });
  return [...new Map(scopes.map((scope) => [authScopeKey(scope).pk, scope])).values()].map(
    (scope) => ({
      Update: {
        TableName: tableName,
        Key: authScopeKey(scope),
        UpdateExpression: 'ADD activityRevision :one',
        ExpressionAttributeValues: { ':one': 1 },
      },
    }),
  );
};

export const assertScopeAvailable = async ({ repository, bindings, projectId }) => {
  const scopes = inventoryScopes({ projectId, credentialBindings: bindings });
  for (const scope of scopes) {
    const state = await repository.getScopeState(scope);
    if (!state.pendingReview) continue;
    const review = await repository.getReview(state.pendingReview);
    // A space also inventories personal bindings. Only the credential actually
    // being changed is unavailable while its external secret write is pending.
    if (bindings.some((binding) => credentialChangeAffects(review?.candidate, binding, projectId)))
      throw authError('AGENT_AUTH_CHANGE_IN_PROGRESS', 'The selected credential is being updated');
  }
};
