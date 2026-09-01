// Invocation-scoped agent authentication.
//
// AgentCore sessions are long-lived and can serve different authenticated
// callers. Secrets must therefore never be installed into process.env. Each
// invocation resolves the server-generated credential binding, clones the
// non-secret base environment, and adds only the selected provider's secret.
// A rotation at the bound SSM path is visible on the next invocation; clearing
// it leaves the selected CLI unavailable and never falls back to another scope.

import { SSMClient } from '@aws-sdk/client-ssm';
import {
  AGENT_CREDENTIAL_PROVIDERS,
  credentialEnvName,
  credentialProviderForCli,
  normalizeCredentialBinding,
  readCredentialBindingValue,
} from '../shared/agent-credentials.js';
import { AGENT_AUTH_MODES } from './command-registry.js';

const AUTH_ENV_NAMES = AGENT_CREDENTIAL_PROVIDERS.map(credentialEnvName);

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

const singleBinding = ({ binding, requestedCli, mismatchMessage }) => {
  if (!binding) return [];
  if (!bindingMatchesCli(binding, requestedCli)) {
    throw Object.assign(new Error(mismatchMessage), {
      code: 'credential_binding_mismatch',
    });
  }
  return [binding];
};

const bindingResolvers = Object.freeze({
  [AGENT_AUTH_MODES.CAPABILITIES]: ({ payload }) =>
    payload.credentialBindings
      ? AGENT_CREDENTIAL_PROVIDERS.map((provider) => payload.credentialBindings[provider]).filter(
          Boolean,
        )
      : [],
  [AGENT_AUTH_MODES.COMPOSE]: ({ payload, meta }) => {
    const requestedCli = payload.requestedCli || meta?.agentCli || null;
    // Fresh DRAFT composes must carry the binding resolved for the caller.
    // Older in-flight intents predate credentialBinding, so preserve their
    // historical platform credential without allowing a draft to fall back.
    const binding =
      payload.credentialBinding ??
      (payload.mode === 'inflight'
        ? (meta?.credentialBinding ?? legacyPlatformBinding(requestedCli))
        : null);
    return singleBinding({
      binding,
      requestedCli,
      mismatchMessage: 'Agent credential does not match the selected CLI',
    });
  },
  [AGENT_AUTH_MODES.DISCUSSION]: ({ payload, meta }) => {
    const requestedCli = meta?.agentCli || payload.requestedCli || null;
    // Started intents keep their pinned binding (or the historical platform
    // binding). A DRAFT has no pinned CLI yet, so it must carry the binding
    // resolved for the caller alongside their selected CLI.
    const binding =
      meta?.credentialBinding ??
      (meta?.agentCli ? legacyPlatformBinding(requestedCli) : (payload.credentialBinding ?? null));
    return singleBinding({
      binding,
      requestedCli,
      mismatchMessage: 'Agent credential does not match the selected CLI',
    });
  },
  [AGENT_AUTH_MODES.EXECUTION]: ({ payload, meta }) => {
    const requestedCli = payload.requestedCli || meta?.agentCli || null;
    const binding = meta?.credentialBinding || legacyPlatformBinding(requestedCli);
    return singleBinding({
      binding,
      requestedCli,
      mismatchMessage: 'Pinned agent credential does not match the selected CLI',
    });
  },
});

export const authenticatedClisForEnv = ({ installed = [], env = {} } = {}) =>
  installed.filter((cli) => {
    const provider = credentialProviderForCli(cli);
    return provider && Boolean(env[credentialEnvName(provider)]);
  });

export const resolveInvocationAgentAuth = async ({
  payload = {},
  authMode = AGENT_AUTH_MODES.EXECUTION,
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

  const resolveBindings =
    typeof authMode === 'string' && Object.hasOwn(bindingResolvers, authMode)
      ? bindingResolvers[authMode]
      : null;
  if (!resolveBindings) throw new Error(`Unsupported agent auth mode: ${authMode}`);
  const bindings = resolveBindings({ payload, meta });

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
