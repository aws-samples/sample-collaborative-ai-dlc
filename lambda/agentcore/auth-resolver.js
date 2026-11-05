import { AUTHENTICATION_BINDING_RESOLVERS } from './authentication-command-registry.js';
import { CREDENTIAL_ADAPTER_ENV_NAMES } from './credential-material-registry.js';
import {
  credentialLeaseFromResponse,
  prepareCredentialLeases,
} from './credential-lease-adapters.js';
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
  credentialProviderForCli,
  normalizeCredentialBinding,
  bindingIdentity,
} from '../shared/agent-auth-contracts.js';
import { AGENT_AUTH_MODES } from './command-registry.js';
import { invokeCredentialBroker } from './clients.js';

const bindingKey = bindingIdentity;
const grantMismatch = () =>
  Object.assign(new Error('Agent credential grant does not match this invocation'), {
    code: 'credential_grant_mismatch',
  });

// Adapter-controlled names that are deployment configuration, not credentials. The platform sets
// BEDROCK_REGION (Terraform) as the default inference region; stripping it would send API-key
// inference to the runtime's own region. An adapter that writes the name, as IAM does with its
// binding's region, still overrides it for that invocation.
const PLATFORM_ENV_NAMES = Object.freeze(['BEDROCK_REGION']);

const cleanBaseEnv = (env) => {
  const invocationEnv = { ...env };
  for (const name of [...AGENT_CREDENTIAL_ENV_NAMES, ...CREDENTIAL_ADAPTER_ENV_NAMES])
    if (!PLATFORM_ENV_NAMES.includes(name)) delete invocationEnv[name];
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
  [AGENT_AUTH_MODES.NATIVE_PROBE]: ({ payload }) => {
    // An operator experiment has no project, member, or execution-store row.
    // Derive the sole allowed binding instead of trusting payload credentials.
    const binding = legacyPlatformBinding(payload.requestedCli);
    if (
      !binding ||
      payload.projectId !== undefined ||
      payload.intentId !== undefined ||
      payload.executionId !== payload.probeId ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
        payload.probeId || '',
      )
    ) {
      throw grantMismatch();
    }
    return [binding];
  },
  ...AUTHENTICATION_BINDING_RESOLVERS,
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

// A CLI is authenticated only by a lease prepared for this invocation, never by env,
// so ambient values cannot fake it. `providers` is the resolver's resolvedProviders.
export const authenticatedClis = ({ installed = [], providers = [] } = {}) =>
  installed.filter((cli) => providers.includes(credentialProviderForCli(cli)));

export const resolveInvocationAgentAuth = async ({
  payload = {},
  authMode = AGENT_AUTH_MODES.EXECUTION,
  store = null,
  env = process.env,
  broker = invokeCredentialBroker,
  leaseAdapters,
} = {}) => {
  if (
    authMode === AGENT_AUTH_MODES.NATIVE_PROBE &&
    env.NATIVE_INTERACTION_PROBE_ENABLED !== 'true'
  ) {
    throw Object.assign(new Error('Native interaction probe is disabled'), {
      code: 'native_probe_disabled',
    });
  }
  const invocationEnv = cleanBaseEnv(env);
  let meta = null;
  const executionId = payload.executionId || payload.intentId || null;
  if (authMode !== AGENT_AUTH_MODES.NATIVE_PROBE && executionId && store?.getExecution) {
    meta = await store.getExecution(executionId, { consistentRead: true });
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
  if (
    bindings.length === 0 ||
    (authMode === AGENT_AUTH_MODES.NATIVE_PROBE && ['status', 'cancel'].includes(payload.action))
  ) {
    // These operator-only diagnostics consume no model or project credentials.
    // Keep inspection/cancellation available during credential-store outages.
    return {
      env: invocationEnv,
      materialTypes: [],
      projectId,
      bindings,
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
        lease: credentialLeaseFromResponse(credential),
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
    const lease = authorized.get(bindingKey(binding))?.lease;
    if (!lease?.material) {
      missingProviders.push(binding.provider);
      missingCredentialBindings.push(credentialBinding);
      continue;
    }
    resolvedProviders.push(binding.provider);
  }

  const leaseState = await prepareCredentialLeases({
    credentials: [...authorized.values()],
    baseEnv: invocationEnv,
    broker,
    context: { purpose: authMode, projectId, executionId },
    ...(leaseAdapters ? { adapters: leaseAdapters } : {}),
  });
  return {
    ...leaseState,
    projectId,
    bindings,
    credentialBindings,
    resolvedProviders,
    missingProviders,
    missingCredentialBindings,
  };
};
