import { AUTH_MECHANISMS, authError, assertIdentifier } from '../shared/agent-auth-protocol.js';
import { AGENT_AUTH_MODES } from '../shared/agent-command-registry.js';
import {
  AGENT_CREDENTIAL_GRANT_AUDIENCE,
  loadAgentCredentialGrantSecret,
  verifyAgentCredentialGrant,
} from '../shared/agent-credential-grants.js';
import { normalizeCredentialLease } from '../shared/agent-credential-lease.js';
import { AGENT_BROKER_PROVIDERS } from './agent-broker-providers.js';
import { composeLease, signRenewal, verifyRenewal } from './agent-credential-renewal.js';

export const RESOLVE_AGENT_CREDENTIALS = 'resolve-agent-credentials';
export const BASE_AGENT_CREDENTIAL_ERROR_CODES = Object.freeze([
  'AGENT_CREDENTIAL_GRANT_EXPIRED',
  'AGENT_CREDENTIAL_GRANT_INVALID',
  'AGENT_CREDENTIAL_GRANT_NOT_CONFIGURED',
  'AGENT_AUTH_CONNECTION_UNAVAILABLE',
  'AGENT_AUTH_CHANGE_IN_PROGRESS',
]);
const BROKER_FAILED = 'AGENT_CREDENTIAL_BROKER_FAILED';
// index.js serves source control for every action it does not route here.
const RESERVED_ACTIONS = Object.freeze([RESOLVE_AGENT_CREDENTIALS, 'source-control']);
const PROVIDER_KEYS = Object.freeze([
  'id',
  'adapters',
  'renewal',
  'verification',
  'isolateCapabilityFailures',
  'errorCodes',
  'classifyError',
  'legacyResponse',
  'createDependencies',
]);
const RENEWAL_KEYS = Object.freeze(['action', 'tokenField', 'audience', 'ttlSeconds']);
const RENEWAL_TOKEN_FIELDS = Object.freeze(['grant', 'renewalToken']);
const MAX_RENEWAL_TTL_SECONDS = 86_400;
const ERROR_CODE = /^[A-Z][A-Z0-9_]+$/;
// Redemption owns these credential fields; legacyResponse may only add provider wire fields.
const RESPONSE_FIELDS = Object.freeze(['binding', 'lease', 'value', 'error']);

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const defineBrokerProvider = (provider) => {
  if (!isRecord(provider)) throw new TypeError('Broker provider is required');
  const {
    id,
    adapters,
    renewal,
    verification = false,
    isolateCapabilityFailures = false,
    errorCodes = [],
    classifyError = null,
    legacyResponse = null,
    createDependencies = null,
  } = provider;
  assertIdentifier(id, 'Broker provider id');
  const invalid = (problem) => new TypeError(`Broker provider ${id} ${problem}`);
  const unsupported = Object.keys(provider).filter((key) => !PROVIDER_KEYS.includes(key));
  if (unsupported.length) throw invalid(`declares unsupported fields: ${unsupported.join(', ')}`);
  if (!isRecord(adapters) || !Object.keys(adapters).length) throw invalid('requires adapters');
  for (const [key, adapter] of Object.entries(adapters)) {
    const [backend, mechanism, ...rest] = key.split(':');
    assertIdentifier(backend, `Broker provider ${id} adapter backend`);
    if (rest.length || !Object.hasOwn(AUTH_MECHANISMS, mechanism ?? ''))
      throw invalid(`declares an adapter for an unknown mechanism: ${key}`);
    if (typeof adapter !== 'function') throw invalid(`declares a non-function adapter: ${key}`);
  }
  if (renewal !== undefined) {
    if (!isRecord(renewal) || Object.keys(renewal).some((key) => !RENEWAL_KEYS.includes(key)))
      throw invalid('declares an invalid renewal policy');
    assertIdentifier(renewal.action, `Broker provider ${id} renewal action`);
    if (RESERVED_ACTIONS.includes(renewal.action))
      throw invalid(`cannot renew on the reserved action ${renewal.action}`);
    if (!RENEWAL_TOKEN_FIELDS.includes(renewal.tokenField))
      throw invalid(`declares an unsupported renewal token field: ${renewal.tokenField}`);
    if (
      typeof renewal.audience !== 'string' ||
      !renewal.audience.trim() ||
      renewal.audience === AGENT_CREDENTIAL_GRANT_AUDIENCE
    )
      throw invalid('requires a renewal audience distinct from the grant audience');
    if (
      !Number.isInteger(renewal.ttlSeconds) ||
      renewal.ttlSeconds < 1 ||
      renewal.ttlSeconds > MAX_RENEWAL_TTL_SECONDS
    )
      throw invalid('declares an invalid renewal lifetime');
  }
  for (const [name, flag] of Object.entries({ verification, isolateCapabilityFailures }))
    if (typeof flag !== 'boolean') throw invalid(`declares a non-boolean ${name} flag`);
  if (
    !Array.isArray(errorCodes) ||
    new Set(errorCodes).size !== errorCodes.length ||
    errorCodes.some((code) => typeof code !== 'string' || !ERROR_CODE.test(code))
  )
    throw invalid('declares invalid error codes');
  for (const [name, hook] of Object.entries({ classifyError, legacyResponse, createDependencies }))
    if (hook !== null && typeof hook !== 'function')
      throw invalid(`declares a non-function ${name}`);
  if (classifyError && !errorCodes.length)
    throw invalid('classifies errors without declaring codes');
  return Object.freeze({
    id,
    adapters: Object.freeze({ ...adapters }),
    renewal: renewal
      ? Object.freeze({
          action: renewal.action,
          tokenField: renewal.tokenField,
          audience: renewal.audience,
          ttlSeconds: renewal.ttlSeconds,
        })
      : null,
    verification,
    isolateCapabilityFailures,
    errorCodes: Object.freeze([...errorCodes]),
    classifyError,
    legacyResponse,
    createDependencies,
  });
};

const invalidLease = () => authError('AGENT_AUTH_LEASE_INVALID', 'Credential lease is invalid');

// Adapters return material and its expiry. A whole lease is accepted only without renewal
// authority or an authorization deadline: the host composes both from the declared policy.
const adapterMaterial = (result) => {
  if (!isRecord(result)) throw invalidLease();
  if (!Object.hasOwn(result, 'lease')) {
    if (!Object.hasOwn(result, 'material')) throw invalidLease();
    return { material: result.material, expiresAt: result.expiresAt ?? null };
  }
  const lease = normalizeCredentialLease(result.lease);
  if (lease.renewal || lease.authorizationExpiresAt !== null) throw invalidLease();
  return { material: lease.material, expiresAt: lease.expiresAt };
};

// Only a provider's own adapter errors are classified, and only into its declared codes, so
// no provider can relabel a foundation failure such as an SSM denial on a key read.
const classified = (provider, error) => {
  const code = provider.classifyError?.(error);
  return provider.errorCodes.includes(code)
    ? authError(code, 'Credential provider rejected the request')
    : error;
};

// Entries are re-validated, so a root or test may list spread copies of providers.
export const createBrokerProviderRegistry = (providers) => {
  if (!Array.isArray(providers)) throw new TypeError('Broker providers must be a list');
  const ids = new Set();
  const owners = new Map();
  const renewals = new Map();
  const audiences = new Set();
  const codes = new Set(BASE_AGENT_CREDENTIAL_ERROR_CODES);
  for (const provider of providers.map(defineBrokerProvider)) {
    if (ids.has(provider.id))
      throw new TypeError(`Broker provider ${provider.id} is registered twice`);
    ids.add(provider.id);
    for (const key of Object.keys(provider.adapters)) {
      if (owners.has(key)) throw new TypeError(`Credential adapter ${key} is registered twice`);
      owners.set(key, provider);
    }
    if (provider.renewal) {
      const { action, audience } = provider.renewal;
      if (renewals.has(action)) throw new TypeError(`Renewal action ${action} is registered twice`);
      if (audiences.has(audience))
        throw new TypeError(`Renewal audience ${audience} is registered twice`);
      renewals.set(action, provider);
      audiences.add(audience);
    }
    for (const code of provider.errorCodes) {
      if (codes.has(code) || code === BROKER_FAILED)
        throw new TypeError(`Credential error code ${code} is already declared`);
      codes.add(code);
    }
  }
  const errorCodes = Object.freeze([...codes]);

  // Created on a provider's first adapter call and reused for the life of the registry.
  const dependencies = new Map();
  const dependenciesOf = (provider) => {
    if (!provider.createDependencies) return {};
    if (!dependencies.has(provider.id))
      dependencies.set(provider.id, provider.createDependencies());
    return dependencies.get(provider.id);
  };
  const bind =
    (provider, adapter, { claims, request, key, presentedToken, overrides }) =>
    async ({ ssm, connection, binding }) => {
      const deps = { ...dependenciesOf(provider), ...overrides };
      let result;
      try {
        result = await adapter({ ssm, connection, binding, claims, request, deps });
      } catch (error) {
        throw classified(provider, error);
      }
      const lease = composeLease({
        ...adapterMaterial(result),
        claims,
        request,
        policy: provider.renewal,
        presentedToken,
        issueRenewal: () => signRenewal({ claims, binding, policy: provider.renewal, key }),
      });
      const legacy = provider.legacyResponse?.(lease) ?? {};
      if (!isRecord(legacy) || Object.keys(legacy).some((field) => RESPONSE_FIELDS.includes(field)))
        throw invalidLease();
      return { ...legacy, lease };
    };

  return Object.freeze({
    errorCodes,
    ownerOf: (binding) =>
      binding?.version === 2
        ? (owners.get(`${binding.backend}:${binding.mechanism}`) ?? null)
        : null,
    renewalProvider: (action) => renewals.get(action) ?? null,
    loggableErrorCode: (error) => (codes.has(error?.code) ? error.code : BROKER_FAILED),
    // Adapters bound to one verified request; a renewal binds only the renewing provider's.
    adaptersFor: (request) =>
      Object.freeze(
        Object.fromEntries(
          [...owners]
            .filter(([, provider]) => !request.provider || provider === request.provider)
            .map(([key, provider]) => [key, bind(provider, provider.adapters[key], request)]),
        ),
      ),
  });
};

// Built at load from the root, so a misregistered provider fails the Lambda at init.
const BROKER_REGISTRY = createBrokerProviderRegistry(AGENT_BROKER_PROVIDERS);

export const isAgentCredentialAction = (action) =>
  action === RESOLVE_AGENT_CREDENTIALS || Boolean(BROKER_REGISTRY.renewalProvider(action));
export const loggableAgentCredentialErrorCode = (error) => BROKER_REGISTRY.loggableErrorCode(error);

// The signing key never leaves the host: providers receive claims, the request kind and their
// dependencies, and renewal tokens are signed here from the provider's declared policy.
export const createAgentProviderContext = async (
  event = {},
  {
    ssmClient,
    secret = null,
    env = process.env,
    now,
    registry = BROKER_REGISTRY,
    ...overrides
  } = {},
) => {
  const action = event.action ?? RESOLVE_AGENT_CREDENTIALS;
  const renewing = action === RESOLVE_AGENT_CREDENTIALS ? null : registry.renewalProvider(action);
  if (action !== RESOLVE_AGENT_CREDENTIALS && !renewing)
    throw authError('AGENT_CREDENTIAL_GRANT_INVALID', 'Agent credential action is not supported');
  const presentedToken = renewing ? event[renewing.renewal.tokenField] : event.grant;
  if (!presentedToken)
    throw authError('AGENT_CREDENTIAL_GRANT_INVALID', 'Agent credential grant is required');
  const key = secret ?? (await loadAgentCredentialGrantSecret(ssmClient, { env }));
  const claims = renewing
    ? verifyRenewal({
        token: presentedToken,
        key,
        policy: renewing.renewal,
        owns: (binding) => registry.ownerOf(binding) === renewing,
        now,
      })
    : verifyAgentCredentialGrant(presentedToken, key, { now });
  // The grant rules already pin a verification to one v2 binding and no execution. The host
  // also refuses to renew one (verifyRenewal rejects the purpose too), and only a provider
  // that opted in may redeem an unsaved connection.
  const verification = claims.purpose === AGENT_AUTH_MODES.VERIFY_CONNECTION;
  const verifier = verification ? registry.ownerOf(claims.bindings[0]) : null;
  if (verification && renewing)
    throw authError('AGENT_CREDENTIAL_GRANT_INVALID', 'Connection verification is not renewable');
  if (verification && !verifier?.verification)
    throw authError(
      'AGENT_CREDENTIAL_GRANT_INVALID',
      'Connection verification is not supported for this mechanism',
    );
  const adapters = registry.adaptersFor({
    claims,
    request: renewing ? 'renew' : verification ? 'verify' : 'resolve',
    key,
    presentedToken: renewing ? presentedToken : null,
    provider: renewing ?? verifier,
    overrides,
  });
  return {
    claims,
    verification,
    adapters,
    // The signed binding stands in for the connection row: no repository read, and the
    // 'verify' lease carries no renewal and ends with the grant.
    verify: async (binding) => {
      const adapter = verification ? adapters[`${binding.backend}:${binding.mechanism}`] : null;
      if (!adapter)
        throw authError('AGENT_CREDENTIAL_GRANT_INVALID', 'Grant does not verify this connection');
      return adapter({ ssm: ssmClient, connection: binding, binding });
    },
    // Discovery only: renewals and every other purpose fail closed.
    isolateDiscoveryFailure: (binding) =>
      !renewing &&
      claims.purpose === AGENT_AUTH_MODES.CAPABILITIES &&
      registry.ownerOf(binding)?.isolateCapabilityFailures === true,
    loggableErrorCode: registry.loggableErrorCode,
  };
};
