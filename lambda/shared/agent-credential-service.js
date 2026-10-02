import {
  authError,
  credentialProviderForCli,
  legacyPlatformBinding,
  normalizeCredentialBinding,
  assertRuntimeSupportsBinding,
} from './agent-auth-contracts.js';
import { resolveEffectiveCredentialBindingsViaBroker } from './agent-credential-metadata.js';
import { qualifyAgentAuthRuntime } from './agent-auth-runtime-capabilities.js';
import { issueAgentCredentialGrant } from './agent-credential-grants.js';

// Callers authorize their operation and supply trusted project/user/execution
// context. This service owns selection and issuance for every command purpose.
export const resolveSelectedAgentCredential = async (
  { projectId, userId, agentCli, runtimeCapabilities },
  {
    resolveBindings = resolveEffectiveCredentialBindingsViaBroker,
    qualifyRuntime = qualifyAgentAuthRuntime,
  } = {},
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
  const bindings = await resolveBindings({
    projectId,
    userId,
    providers: [provider],
    reserve: true,
  });
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
    const qualified =
      credentialBinding.version === 2
        ? await qualifyRuntime(runtimeCapabilities, {
            requiredModes: [credentialBinding.mode === 'kiro' ? 'keys' : credentialBinding.mode],
          })
        : runtimeCapabilities;
    assertRuntimeSupportsBinding(credentialBinding, qualified);
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
  {
    ssm,
    issueGrant = (claims) => issueAgentCredentialGrant(ssm, claims),
    qualifyRuntime = qualifyAgentAuthRuntime,
  } = {},
) => {
  const selected = credentialBindings
    ? Object.values(credentialBindings).filter(Boolean)
    : [credentialBinding ?? (legacyExecution ? legacyPlatformBinding(agentCli) : null)].filter(
        Boolean,
      );
  const bindings = selected.map(normalizeCredentialBinding);
  const qualified = bindings.some((binding) => binding.version === 2)
    ? await qualifyRuntime(runtimeCapabilities, {
        requiredModes: bindings
          .filter((binding) => binding.version === 2)
          .map((binding) => (binding.mode === 'kiro' ? 'keys' : binding.mode)),
      })
    : runtimeCapabilities;
  for (const binding of bindings) {
    if (binding.source === 'space' && binding.version === 2 && binding.projectId !== projectId) {
      throw authError('AGENT_AUTH_CONTEXT_MISMATCH', 'Credential does not belong to this space');
    }
    assertRuntimeSupportsBinding(binding, qualified);
  }
  return {
    credentialBindings: bindings,
    agentCredentialGrant: bindings.length
      ? await issueGrant({ purpose, projectId, executionId, bindings })
      : null,
  };
};
