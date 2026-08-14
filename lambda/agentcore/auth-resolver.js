// Invocation-scoped agent authentication.
//
// AgentCore sessions are long-lived and can serve different authenticated
// callers. Secrets must therefore never be installed into process.env. Each
// invocation resolves the server-generated credential binding, clones the
// non-secret base environment, and adds only the selected provider's secret.
// A rotation at the bound SSM path is visible on the next invocation; clearing
// it leaves the selected CLI unavailable and never falls back to another scope.

import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import {
  AGENT_CREDENTIAL_PROVIDERS,
  credentialEnvName,
  credentialProviderForCli,
  normalizeCredentialBinding,
  readCredentialBindingValue,
} from '../shared/agent-credentials.js';

const AUTH_ENV_NAMES = AGENT_CREDENTIAL_PROVIDERS.map(credentialEnvName);

const defaultGetParam = (client) => async (name) => {
  try {
    const res = await client.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
    return res.Parameter?.Value ?? '';
  } catch {
    return '';
  }
};

const cleanBaseEnv = (env) => {
  const invocationEnv = { ...env };
  for (const name of AUTH_ENV_NAMES) delete invocationEnv[name];
  return invocationEnv;
};

const legacyPlatformBinding = (requestedCli) => {
  const provider = credentialProviderForCli(requestedCli);
  return provider ? { provider, source: 'platform' } : null;
};

const bindingMatchesCli = (binding, requestedCli) => {
  if (!binding || !requestedCli) return true;
  return binding.provider === credentialProviderForCli(requestedCli);
};

export const authenticatedClisForEnv = ({ installed = [], env = {} } = {}) =>
  installed.filter((cli) => {
    const provider = credentialProviderForCli(cli);
    return provider && Boolean(env[credentialEnvName(provider)]);
  });

export const resolveInvocationAgentAuth = async ({
  payload = {},
  store = null,
  env = process.env,
  ssm = null,
} = {}) => {
  const invocationEnv = cleanBaseEnv(env);
  const base = env.AGENT_SETTINGS_SSM_PREFIX || env.MCP_SECRETS_SSM_PREFIX || '';
  const client = ssm ?? new SSMClient({ region: env.AWS_REGION || 'us-east-1' });
  let meta = null;
  const executionId = payload.executionId || payload.intentId || null;
  if (executionId && store?.getExecution) {
    meta = await store.getExecution(executionId);
  }

  let bindings = [];
  if (payload.command === 'capabilities' && payload.credentialBindings) {
    bindings = AGENT_CREDENTIAL_PROVIDERS.map(
      (provider) => payload.credentialBindings[provider],
    ).filter(Boolean);
  } else if (payload.command === 'compose-plan-start') {
    const requestedCli = payload.requestedCli || meta?.agentCli || null;
    // Fresh DRAFT composes must carry the binding resolved for the caller.
    // Older in-flight intents predate credentialBinding, so preserve their
    // historical platform credential without allowing a draft to fall back.
    const binding =
      payload.credentialBinding ??
      (payload.mode === 'inflight'
        ? (meta?.credentialBinding ?? legacyPlatformBinding(requestedCli))
        : null);
    if (binding && !bindingMatchesCli(binding, requestedCli)) {
      throw Object.assign(new Error('Agent credential does not match the selected CLI'), {
        code: 'credential_binding_mismatch',
      });
    }
    if (binding) bindings = [binding];
  } else {
    const requestedCli = payload.requestedCli || meta?.agentCli || null;
    const binding = meta?.credentialBinding || legacyPlatformBinding(requestedCli);
    if (binding && !bindingMatchesCli(binding, requestedCli)) {
      throw Object.assign(new Error('Pinned agent credential does not match the selected CLI'), {
        code: 'credential_binding_mismatch',
      });
    }
    if (binding) bindings = [binding];
  }

  const credentialBindings = [];
  const resolvedProviders = [];
  const missingProviders = [];
  const missingCredentialBindings = [];
  for (const rawBinding of bindings) {
    const binding = normalizeCredentialBinding(rawBinding);
    const credentialBinding = {
      provider: binding.provider,
      source: binding.source,
    };
    credentialBindings.push(credentialBinding);
    const value = await readCredentialBindingValue(client, {
      base,
      binding,
      projectId: payload.projectId || meta?.projectId || null,
    });
    if (!value) {
      missingProviders.push(binding.provider);
      missingCredentialBindings.push(credentialBinding);
      continue;
    }
    invocationEnv[credentialEnvName(binding.provider)] = value;
    resolvedProviders.push(binding.provider);
  }

  return {
    env: invocationEnv,
    credentialBindings,
    resolvedProviders,
    missingProviders,
    missingCredentialBindings,
  };
};

// Backward-compatible helper retained for focused tests and local tooling. It
// resolves the legacy platform paths into the supplied object, but production
// AgentCore no longer calls it or mutates process.env.
export const resolveAgentAuth = async ({ env = {}, getParam } = {}) => {
  const get = getParam ?? defaultGetParam(new SSMClient({ region: env.AWS_REGION || 'us-east-1' }));
  const resolved = [];
  const paths = {
    AWS_BEARER_TOKEN_BEDROCK: env.BEDROCK_BEARER_TOKEN_SSM_PATH,
    KIRO_API_KEY: env.KIRO_API_KEY_SSM_PATH,
  };
  for (const [target, path] of Object.entries(paths)) {
    if (env[target] || !path) continue;
    const value = await get(path);
    if (!value) continue;
    env[target] = value;
    resolved.push(target);
  }
  return resolved;
};
