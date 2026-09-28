import { authError, assertIdentifier, normalizeConnection } from './agent-auth-contracts.js';
import { AGENT_AUTH_MODES_CATALOG } from './agent-auth-providers.js';
import { authenticationScope } from './agent-auth-inventory.js';

// Provider setup produces these domain actions. Review and persistence know
// nothing about role setup, token acquisition, or gateway configuration.
export const normalizeAuthAction = async (input, repository) => {
  const kind = input?.kind === 'policy' ? 'policy-change' : input?.kind;
  if (kind === 'credential-update') {
    const scope = authenticationScope(input);
    if (!Array.isArray(input.changes) || !input.changes.length)
      throw authError('AGENT_AUTH_INVALID', 'Credential changes are required');
    const changes = input.changes.map(({ provider, action, digest }) => {
      assertIdentifier(provider, 'provider');
      if (!['rotate', 'clear'].includes(action) || !/^[a-f0-9]{64}$/.test(digest))
        throw authError('AGENT_AUTH_INVALID', 'Credential change is invalid');
      return { provider, action, digest };
    });
    if (new Set(changes.map(({ provider }) => provider)).size !== changes.length)
      throw authError('AGENT_AUTH_INVALID', 'Credential changes must be unique');
    return { kind, ...scope, changes };
  }
  if (kind === 'policy-change') {
    const descriptor = AGENT_AUTH_MODES_CATALOG.find((mode) => mode.id === input.mode);
    if (!descriptor?.available)
      throw authError(
        'AGENT_AUTH_MODE_UNAVAILABLE',
        'The selected authentication mode is unavailable',
      );
    const connection = await repository.getConnection(input.defaultConnectionId);
    if (
      !connection ||
      connection.mode !== input.mode ||
      connection.source !== 'platform' ||
      connection.state !== 'ready'
    )
      throw authError(
        'AGENT_AUTH_INVALID',
        'A ready platform connection matching the selected mode is required',
      );
    return { kind, mode: input.mode, defaultConnectionId: connection.id };
  }
  if (kind === 'connection-create') {
    const connection = normalizeConnection(input.connection);
    if (connection.revision !== 1 || connection.id.startsWith('legacy-'))
      throw authError(
        'AGENT_AUTH_INVALID',
        'A new connection requires a unique identity and revision one',
      );
    if (
      !AGENT_AUTH_MODES_CATALOG.some((mode) => mode.id === connection.mode && mode.available) &&
      connection.mode !== 'kiro'
    )
      throw authError(
        'AGENT_AUTH_MODE_UNAVAILABLE',
        'The selected authentication mode is unavailable',
      );
    const storage = input.storage ?? {};
    if (Object.keys(storage).some((key) => key !== 'secretReference'))
      throw authError('AGENT_AUTH_INVALID', 'Unsupported connection storage reference');
    repository.validateStorageReference(connection.id, storage.secretReference);
    return { kind, ...authenticationScope(connection), connection, storage };
  }
  if (kind === 'space-selection') {
    const scope = authenticationScope({ source: 'space', projectId: input.projectId });
    const connectionId =
      input.connectionId === null ? null : assertIdentifier(input.connectionId, 'connectionId');
    if (connectionId) {
      const connection = await repository.getConnection(connectionId);
      const policy = await repository.getPolicy();
      if (
        !connection ||
        connection.state !== 'ready' ||
        connection.mode !== policy.mode ||
        (connection.source !== 'platform' &&
          (connection.source !== 'space' || connection.projectId !== scope.projectId))
      )
        throw authError(
          'AGENT_AUTH_INVALID',
          'The selected connection is not available to this space',
        );
    }
    return { kind, ...scope, connectionId };
  }
  throw authError('AGENT_AUTH_INVALID', 'Unsupported configuration change');
};

export const authActionWrites = ({ action, tableName }) => {
  if (action.kind === 'connection-create') {
    const row = { ...action.connection, ...action.storage };
    return [
      ['META', 'AgentConnectionHead'],
      [`REV#${row.revision}`, 'AgentConnection'],
    ].map(([sk, type]) => ({
      Put: {
        TableName: tableName,
        Item: { pk: `AGENTAUTH#CONNECTION#${row.id}`, sk, type, ...row },
        ConditionExpression: 'attribute_not_exists(pk)',
      },
    }));
  }
  if (action.kind === 'space-selection') {
    const Key = { pk: `AGENTAUTH#SPACE#${action.projectId}`, sk: 'META' };
    return action.connectionId === null
      ? [{ Delete: { TableName: tableName, Key } }]
      : [
          {
            Put: {
              TableName: tableName,
              Item: {
                ...Key,
                type: 'AgentSpaceSelection',
                projectId: action.projectId,
                connectionId: action.connectionId,
              },
            },
          },
        ];
  }
  return [];
};
