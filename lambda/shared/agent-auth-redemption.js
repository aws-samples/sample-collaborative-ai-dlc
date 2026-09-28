import { apiKeyLease, normalizeCredentialLease } from './agent-credential-lease.js';
import { GetParameterCommand } from '@aws-sdk/client-ssm';
import { authError, bindingIdentity, isConfiguredCredentialValue } from './agent-auth-contracts.js';
import { readCredentialBindingValue } from './agent-key-repository.js';
import { connectionBinding } from './agent-binding-selection.js';

const keyAdapter = async ({ ssm, connection }) => {
  try {
    const result = await ssm.send(
      new GetParameterCommand({ Name: connection.secretReference, WithDecryption: true }),
    );
    const value = result.Parameter?.Value;
    return { lease: apiKeyLease(isConfiguredCredentialValue(value) ? value : null) };
  } catch (error) {
    if (error?.name === 'ParameterNotFound') return { lease: apiKeyLease(null) };
    throw error;
  }
};
export const KEY_REDEMPTION_ADAPTERS = Object.freeze({
  'bedrock:api-key': keyAdapter,
  'kiro:api-key': keyAdapter,
});
export const redeemAgentBinding = async ({
  binding,
  projectId,
  repository,
  ssm,
  base,
  adapters = KEY_REDEMPTION_ADAPTERS,
}) => {
  if (binding.version !== 2) {
    const value = (await readCredentialBindingValue(ssm, { base, binding, projectId })) || null;
    return { binding, value, lease: apiKeyLease(value) };
  }
  const connection = await repository.getConnection(
    binding.connectionId,
    binding.connectionRevision,
  );
  if (
    !connection ||
    bindingIdentity(connectionBinding(connection, binding.policyRevision)) !==
      bindingIdentity(binding)
  ) {
    throw authError('AGENT_CREDENTIAL_GRANT_INVALID', 'Pinned connection does not match its grant');
  }
  if (connection.source === 'space' && connection.projectId !== projectId)
    throw authError('AGENT_CREDENTIAL_GRANT_INVALID', 'Pinned connection belongs to another space');
  const current = await repository.getConnection(binding.connectionId);
  if (
    ['revoked', 'reconnect-required'].includes(connection.state) ||
    ['revoked', 'reconnect-required'].includes(current?.state)
  )
    throw authError('AGENT_AUTH_CONNECTION_UNAVAILABLE', 'Connection requires credential repair');
  const adapter = adapters[`${connection.backend}:${connection.mechanism}`];
  if (!adapter)
    throw authError(
      'AGENT_AUTH_MODE_UNAVAILABLE',
      'Credential mechanism is not supported by this broker',
    );
  // Retired definitions remain redeemable by pinned work.
  const result = await adapter({ ssm, connection });
  const lease = normalizeCredentialLease(result.lease ?? apiKeyLease(result.value));
  // Keep the v1 value field for already-published key-only runtime sessions.
  return {
    binding,
    lease,
    ...(lease.material?.type === 'api-key'
      ? { value: lease.material.value }
      : lease.material === null
        ? { value: null }
        : {}),
  };
};
