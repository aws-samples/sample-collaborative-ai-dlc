import {
  authError,
  normalizeConnection,
  normalizeCredentialBinding,
} from './agent-auth-contracts.js';
import { authModeDescriptor } from './agent-auth-providers.js';
import { legacyConnectionId } from './agent-connection-repository.js';

export const connectionBinding = (connection, policyRevision) =>
  normalizeCredentialBinding({
    version: 2,
    provider: connection.backend,
    backend: connection.backend,
    mode: connection.mode,
    mechanism: connection.mechanism,
    source: connection.source,
    connectionId: connection.id,
    connectionRevision: connection.revision,
    policyRevision,
    projectId: connection.projectId,
    userId: connection.userId,
    configuration: connection.configuration,
  });

const selectKeysBinding = async ({
  policy,
  legacyBindings,
  spaceSelection,
  projectId,
  userId,
  repository,
}) => {
  // Existing key overrides keep their precedence. A deliberate space selection
  // is complete; field fragments cannot replace an inherited destination.
  const selected = legacyBindings.bedrock;
  const connectionId =
    selected?.source === 'user'
      ? legacyConnectionId({ ...selected, projectId, userId })
      : ((spaceSelection?.mode && spaceSelection.mode !== policy.mode
          ? null
          : spaceSelection?.connectionId) ??
        (selected?.source && selected.source !== 'platform'
          ? legacyConnectionId({ ...selected, projectId, userId })
          : policy.defaultConnectionId));
  const connection = await repository.getConnection(connectionId);
  if (
    !connection ||
    connection.mode !== policy.mode ||
    (connection.source === 'space' && connection.projectId !== projectId) ||
    (connection.source === 'user' && connection.userId !== userId)
  ) {
    throw authError(
      'AGENT_AUTH_MODE_MISMATCH',
      'The selected connection is not permitted in this space',
    );
  }
  if (connection.state !== 'ready')
    throw authError(
      'AGENT_AUTH_CONNECTION_UNAVAILABLE',
      'Selected connection requires credential repair',
    );
  normalizeConnection(connection);
  return connection.id.startsWith('legacy-')
    ? selected
    : connectionBinding(connection, policy.revision);
};

// A space selection overrides the platform default only when it was written for the policy
// mode. Mode-less rows make no such claim, so only the keys strategy honours them.
export const spaceConnectionIdFor = ({ policy, spaceSelection }) =>
  spaceSelection?.mode === policy.mode ? (spaceSelection.connectionId ?? null) : null;

// Default for registered modes without their own strategy: platform and space connections of
// the policy mode only; personal overrides remain a keys concern.
export const selectConnectionBinding = async ({
  policy,
  spaceSelection,
  projectId,
  repository,
}) => {
  const connection = await repository.getConnection(
    spaceConnectionIdFor({ policy, spaceSelection }) ?? policy.defaultConnectionId,
  );
  if (
    !connection ||
    connection.mode !== policy.mode ||
    connection.source === 'user' ||
    (connection.source === 'space' && connection.projectId !== projectId)
  )
    throw authError(
      'AGENT_AUTH_MODE_MISMATCH',
      'The selected connection is not available to this space',
    );
  if (connection.state !== 'ready')
    throw authError(
      'AGENT_AUTH_CONNECTION_UNAVAILABLE',
      'Selected connection requires credential repair',
    );
  return connectionBinding(normalizeConnection(connection), policy.revision);
};

// A mode owns only selection. Snapshot consistency and reservation stay in the coordinator.
export const AUTH_SELECTION_STRATEGIES = Object.freeze({ keys: selectKeysBinding });

// Planned and unregistered modes have no strategy, so the coordinator refuses them.
export const selectionStrategyFor = (mode, strategies = AUTH_SELECTION_STRATEGIES) => {
  if (Object.hasOwn(strategies, mode)) return strategies[mode];
  const descriptor = authModeDescriptor(mode);
  return descriptor && !descriptor.planned ? selectConnectionBinding : null;
};
