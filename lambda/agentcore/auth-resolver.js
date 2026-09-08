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
  CREDENTIAL_VALUE_KINDS,
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
// The broker refused or could not resolve the binding. Distinct from a mismatch:
// the grant was valid, the credential was not obtainable
// (specs/bedrock-iam-role-credential-mode: req-expiry-failure-legible). The
// broker's allowlisted code is the only detail carried — never provider text.
const resolutionFailed = (code) =>
  Object.assign(new Error('Agent credential resolution failed'), {
    code: 'credential_resolution_failed',
    brokerCode: typeof code === 'string' && code ? code : null,
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

// Which installed CLIs can actually run this invocation. Derived from the
// providers the broker RESOLVED, not from the presence of a secret environment
// variable: a Bedrock role binding sets temporary AWS credentials and no bearer
// token, so an env probe would exclude exactly the CLIs role mode enables
// (specs/bedrock-iam-role-credential-mode: req-credential-delivery-env).
export const authenticatedClisForProviders = ({ installed = [], resolvedProviders = [] } = {}) => {
  const resolved = new Set(resolvedProviders);
  return installed.filter((cli) => {
    const provider = credentialProviderForCli(cli);
    return Boolean(provider) && resolved.has(provider);
  });
};

// Apply ONE authorized broker entry to the invocation environment. Returns
// whether the provider is usable for this invocation. Branches on the explicit
// `kind` discriminator only — an entry whose shape must be guessed is treated as
// missing, so the stage fails rather than invoking with no credential
// (dec-explicit-discriminator, req-execution-role-no-bedrock).
const applyAuthorizedCredential = ({ entry, binding, invocationEnv, authMode }) => {
  if (!entry) return false;
  if (entry.kind === CREDENTIAL_VALUE_KINDS.ROLE) {
    // req-capabilities-authed: a capabilities request asks whether the binding is
    // usable, and the broker deliberately mints nothing to answer it. No
    // credential reaches the environment on this path.
    if (authMode === AGENT_AUTH_MODES.CAPABILITIES) return entry.usable === true;
    const credentials = entry.credentials;
    if (!credentials?.AccessKeyId || !credentials?.SecretAccessKey || !credentials?.SessionToken) {
      return false;
    }
    invocationEnv.AWS_ACCESS_KEY_ID = credentials.AccessKeyId;
    invocationEnv.AWS_SECRET_ACCESS_KEY = credentials.SecretAccessKey;
    invocationEnv.AWS_SESSION_TOKEN = credentials.SessionToken;
    // AWS_BEARER_TOKEN_BEDROCK stays unset. cleanBaseEnv already scrubbed it, and
    // con-one-binding-per-provider means a provider resolves to exactly one
    // binding, so the two credential shapes never coexist.
    return true;
  }
  if (entry.kind === CREDENTIAL_VALUE_KINDS.BEARER) {
    if (!entry.value) return false;
    invocationEnv[credentialEnvName(binding.provider)] = entry.value;
    return true;
  }
  // kind null means nothing is configured at the bound path. An UNKNOWN kind is
  // also missing: during the deploy window in which a newer container can meet an
  // older broker, that surfaces as a legible credential_resolution_failed and a
  // stage retry rather than a silent unauthenticated run.
  return false;
};

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
  // The earliest deadline among the resolved temporary credentials, as an epoch ms.
  // Stays null for a bearer binding, which never expires.
  let earliestExpiry = null;
  if (bindings.length === 0) {
    return {
      env: invocationEnv,
      credentialBindings,
      resolvedProviders,
      missingProviders,
      missingCredentialBindings,
      credentialExpiresAt: null,
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
  // The broker refuses with { ok: false, code } and mints nothing. That is a
  // resolution failure, not a grant mismatch: distinguishing them is what makes
  // the stage reason legible (req-expiry-failure-legible).
  if (brokerResult?.ok === false) throw resolutionFailed(brokerResult.code);
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
        kind: credential?.kind ?? null,
        value: typeof credential?.value === 'string' ? credential.value : '',
        credentials: credential?.credentials ?? null,
        usable: credential?.usable === true,
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
    const entry = authorized.get(bindingKey(binding));
    const usable = applyAuthorizedCredential({
      entry,
      binding,
      invocationEnv,
      authMode,
    });
    if (!usable) {
      missingProviders.push(binding.provider);
      missingCredentialBindings.push(credentialBinding);
      continue;
    }
    resolvedProviders.push(binding.provider);
    // req-expiry-tripwire: the deadline a temporary credential carries is the ONLY
    // deterministic expiry signal available to the runtime — the credential is
    // consumed inside the agent CLI subprocess, so everything else is that CLI's
    // stderr wording, which the platform does not control. Carrying it lets a
    // stage failure be attributed to expiry by arithmetic rather than by matching
    // a phrase. The EARLIEST deadline wins when several providers resolve.
    const expiresAt = Date.parse(entry?.credentials?.Expiration ?? '');
    if (Number.isFinite(expiresAt) && (earliestExpiry === null || expiresAt < earliestExpiry)) {
      earliestExpiry = expiresAt;
    }
  }

  return {
    env: invocationEnv,
    credentialBindings,
    resolvedProviders,
    missingProviders,
    missingCredentialBindings,
    // ISO string or null. Null for a bearer binding, which carries no deadline.
    credentialExpiresAt: earliestExpiry === null ? null : new Date(earliestExpiry).toISOString(),
  };
};
