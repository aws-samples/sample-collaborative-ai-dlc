import {
  authError,
  credentialProviderForCli,
  legacyPlatformBinding,
  normalizeCredentialBinding,
  assertMatchingConnection,
  normalizeConnection,
  assertRuntimeSupportsBinding,
} from './agent-auth-catalog.js';
import { resolveEffectiveCredentialBindingsViaBroker } from './agent-credential-metadata.js';
import { issueAgentCredentialGrant } from './agent-credential-grants.js';

// Callers authorize their operation and supply trusted project/user/execution
// context. This service owns selection and issuance for every command purpose.
export const resolveSelectedAgentCredential = async (
  { projectId, userId, agentCli, runtimeCapabilities },
  { resolveBindings = resolveEffectiveCredentialBindingsViaBroker } = {},
) => {
  const provider = credentialProviderForCli(agentCli);
  if (!provider)
    return {
      error: {
        statusCode: 400,
        body: {
          error: `Unsupported agent CLI "${agentCli || ''}"`,
          code: 'unsupported_agent_cli',
        },
      },
    };
  const bindings = await resolveBindings({ projectId, userId, reserve: true });
  const credentialBinding = bindings[provider];
  if (!credentialBinding)
    return {
      error: {
        statusCode: 409,
        body: {
          error: `No ${provider === 'kiro' ? 'Kiro' : 'Bedrock'} credential is available for this CLI`,
          code: 'agent_credential_required',
          provider,
        },
      },
    };
  try {
    assertRuntimeSupportsBinding(credentialBinding, runtimeCapabilities);
  } catch (error) {
    return { error: { statusCode: 409, body: { error: error.message, code: error.code } } };
  }
  return { provider, credentialBinding: normalizeCredentialBinding(credentialBinding) };
};

export const executionCredentialBinding = (
  { credentialBinding, agentCli, projectId },
  expectedProjectId = projectId,
) => {
  if (projectId && projectId !== expectedProjectId)
    throw authError('AGENT_AUTH_CONTEXT_MISMATCH', 'Execution does not belong to this space');
  return normalizeCredentialBinding(credentialBinding) ?? legacyPlatformBinding(agentCli);
};

export const prepareAgentInvocation = async (
  {
    purpose,
    projectId = null,
    executionId = null,
    credentialBinding = null,
    credentialBindings = null,
    agentCli = null,
    legacyExecution = false,
    runtimeCapabilities,
  },
  { ssm, issueGrant = (claims) => issueAgentCredentialGrant(ssm, claims) } = {},
) => {
  const selected = credentialBindings
    ? Object.values(credentialBindings).filter(Boolean)
    : [credentialBinding ?? (legacyExecution ? legacyPlatformBinding(agentCli) : null)].filter(
        Boolean,
      );
  const bindings = selected.map(normalizeCredentialBinding);
  for (const binding of bindings) {
    if (binding.source === 'space' && binding.version === 2 && binding.projectId !== projectId) {
      throw authError('AGENT_AUTH_CONTEXT_MISMATCH', 'Credential does not belong to this space');
    }
    assertRuntimeSupportsBinding(binding, runtimeCapabilities);
  }
  return {
    credentialBindings: bindings,
    agentCredentialGrant: bindings.length
      ? await issueGrant({ purpose, projectId, executionId, bindings })
      : null,
  };
};

// Future provider packages plug into this resolver, never into intent handlers.
// Resolve a COMPLETE connection before considering a personal API-key override.
export const selectConnection = ({
  policy,
  platform,
  space = null,
  personal = null,
  projectId,
  userId,
  cli,
}) => {
  if (cli === 'kiro') {
    const selected = personal ?? space ?? platform;
    return selected ? normalizeConnection(selected) : null;
  }
  const effective = normalizeConnection(space ?? platform);
  if (effective.mode !== policy.mode)
    throw authError(
      'AGENT_AUTH_MODE_MISMATCH',
      'Space connection cannot override the platform authentication mode',
    );
  if (effective.source === 'space' && effective.projectId !== projectId)
    throw authError('AGENT_AUTH_CONTEXT_MISMATCH', 'Connection does not belong to this space');
  if (effective.state !== 'ready')
    throw authError(
      'AGENT_AUTH_CONNECTION_UNAVAILABLE',
      'Connection needs reconnect or credential repair',
    );
  if (personal && policy.mode !== 'iam') {
    const override = normalizeConnection(personal);
    if (
      override.source !== 'user' ||
      override.userId !== userId ||
      override.mechanism !== 'api-key'
    ) {
      throw authError(
        'AGENT_AUTH_CONTEXT_MISMATCH',
        'Personal overrides require the caller API key',
      );
    }
    assertMatchingConnection(override, effective);
    if (override.state !== 'ready')
      throw authError(
        'AGENT_AUTH_CONNECTION_UNAVAILABLE',
        'Personal connection needs credential repair',
      );
    return override;
  }
  return effective;
};
