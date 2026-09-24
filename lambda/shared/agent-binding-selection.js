import {
  authError,
  normalizeCredentialBinding,
  normalizeConnection,
  credentialChangeAffects,
} from './agent-auth-catalog.js';
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

// Called inside the metadata broker: key set-state and control records are read
// there, never by callers that have no secret-read permission.
export const resolvePolicyBindings = async ({
  repository,
  resolveLegacy,
  projectId,
  userId,
  reserve = false,
}) => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const policy = await repository.getPolicy();
    const bindings = await resolveLegacy();
    if (policy.pendingReview) {
      const pending = await repository.getReview(policy.pendingReview);
      if (
        Object.values(bindings).some((binding) =>
          credentialChangeAffects(pending?.candidate, binding, projectId),
        )
      ) {
        throw authError(
          'AGENT_AUTH_CHANGE_IN_PROGRESS',
          'The selected credential is being updated; retry after its reviewed change finishes',
        );
      }
    }
    const space = projectId ? await repository.getSpaceSelection(projectId) : null;
    if (policy.mode !== 'keys')
      throw authError('AGENT_AUTH_MODE_UNAVAILABLE', 'Authentication provider has not shipped');
    // Existing key overrides keep their precedence. A deliberate space selection
    // is complete; field fragments cannot replace an inherited destination.
    const selected = bindings.bedrock;
    const connectionId =
      selected?.source === 'user'
        ? legacyConnectionId({ ...selected, projectId, userId })
        : (space?.connectionId ??
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
    if (!connection.id.startsWith('legacy-'))
      bindings.bedrock = connectionBinding(connection, policy.revision);
    // An absent/cleared legacy credential stays absent; never invent readiness.
    try {
      if (reserve) await repository.claimSelection(policy.revision, { projectId, bindings });
      else if ((await repository.getPolicy()).revision !== policy.revision) continue;
      return bindings;
    } catch (error) {
      if (
        !['ConditionalCheckFailedException', 'TransactionCanceledException'].includes(error?.name)
      )
        throw error;
    }
  }
  throw authError(
    'AGENT_AUTH_POLICY_CHANGED',
    'Authentication policy changed during selection; retry the operation',
  );
};
