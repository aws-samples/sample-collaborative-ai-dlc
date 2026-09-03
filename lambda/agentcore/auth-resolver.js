// Invocation-scoped agent authentication.
//
// AgentCore sessions are long-lived and can serve different authenticated
// callers. Secrets must therefore never be installed into process.env. Each
// invocation derives the expected server-side binding, redeems a signed grant
// through the credential broker, clones the non-secret base environment, and
// adds only the selected provider's secret. AgentCore never reads credential
// SSM paths directly. A rotation at the bound path is visible on the next
// invocation; clearing it never falls back to another scope.

import {
  AGENT_CREDENTIAL_ENV_NAMES,
  AGENT_CREDENTIAL_PROVIDERS,
  credentialEnvName,
  credentialProviderForCli,
  normalizeCredentialBinding,
} from '../shared/agent-credentials.js';
import { AGENT_AUTH_MODES } from './command-registry.js';
import { invokeCredentialBroker } from './clients.js';

const bindingKey = (binding) =>
  `${binding.provider}:${binding.source}:${binding.source === 'user' ? binding.userId : ''}`;
const grantMismatch = () =>
  Object.assign(new Error('Agent credential grant does not match this invocation'), {
    code: 'credential_grant_mismatch',
  });

const cleanBaseEnv = (env) => {
  const invocationEnv = { ...env };
  for (const name of AGENT_CREDENTIAL_ENV_NAMES) delete invocationEnv[name];
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
  broker = invokeCredentialBroker,
} = {}) => {
  const invocationEnv = cleanBaseEnv(env);
  let meta = null;
  const executionId = payload.executionId || payload.intentId || null;
  if (executionId && store?.getExecution) {
    meta = await store.getExecution(executionId);
  }
  const projectId = meta?.projectId ?? payload.projectId ?? null;

  const resolveBindings =
    typeof authMode === 'string' && Object.hasOwn(bindingResolvers, authMode)
      ? bindingResolvers[authMode]
      : null;
  if (!resolveBindings) throw new Error(`Unsupported agent auth mode: ${authMode}`);
  const bindings = resolveBindings({ payload, meta }).map(normalizeCredentialBinding);

  const credentialBindings = [];
  const resolvedProviders = [];
  const missingProviders = [];
  const missingCredentialBindings = [];
  if (bindings.length === 0) {
    return {
      env: invocationEnv,
      credentialBindings,
      resolvedProviders,
      missingProviders,
      missingCredentialBindings,
    };
  }
  if (!payload.agentCredentialGrant) {
    throw Object.assign(new Error('Agent credential grant is required'), {
      code: 'credential_grant_required',
    });
  }
  const brokerResult = await broker({
    action: 'resolve-agent-credentials',
    grant: payload.agentCredentialGrant,
  });
  if (
    brokerResult.purpose !== authMode ||
    (brokerResult.projectId ?? null) !== projectId ||
    (brokerResult.executionId ?? null) !== executionId ||
    !Array.isArray(brokerResult.credentials)
  ) {
    throw grantMismatch();
  }
  const authorized = new Map();
  try {
    for (const credential of brokerResult.credentials) {
      const binding = normalizeCredentialBinding(credential?.binding);
      authorized.set(bindingKey(binding), {
        binding,
        value: typeof credential?.value === 'string' ? credential.value : '',
      });
    }
  } catch {
    throw grantMismatch();
  }
  if (brokerResult.credentials.length !== authorized.size) {
    throw grantMismatch();
  }
  const expectedKeys = bindings.map(bindingKey).toSorted();
  const authorizedKeys = [...authorized.keys()].toSorted();
  if (
    expectedKeys.length !== authorizedKeys.length ||
    expectedKeys.some((key, index) => key !== authorizedKeys[index])
  ) {
    throw grantMismatch();
  }

  for (const binding of bindings) {
    const credentialBinding = {
      provider: binding.provider,
      source: binding.source,
    };
    credentialBindings.push(credentialBinding);
    const value = authorized.get(bindingKey(binding))?.value || '';
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
