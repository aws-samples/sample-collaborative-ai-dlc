import {
  CREDENTIAL_MATERIAL_ADAPTERS,
  CREDENTIAL_MATERIAL_ENV_NAMES,
} from './credential-material-registry.js';
export { CREDENTIAL_MATERIAL_ADAPTERS } from './credential-material-registry.js';
import { authError, bindingIdentity } from '../shared/agent-auth-contracts.js';
import { apiKeyLease, normalizeCredentialLease } from '../shared/agent-credential-lease.js';
import { APPLICATION_CREDENTIAL_ENV, INFERENCE_CREDENTIAL_ENV } from './cli/environment.js';

// Custom MCP children are scrubbed of exactly these names plus every controlled env name, so
// an adapter that wrote any other name would hand its credential to project MCP servers.
const assertProviderEnv = (type, controlledEnv, ...environments) => {
  const permitted = [
    ...APPLICATION_CREDENTIAL_ENV,
    ...INFERENCE_CREDENTIAL_ENV,
    ...(controlledEnv[type] ?? []),
  ];
  if (environments.some((names) => names.some((name) => !permitted.includes(name))))
    throw authError(
      'AGENT_AUTH_LEASE_INVALID',
      'Credential adapter wrote an environment variable its provider does not control',
    );
};

// Brokers that predate leases send only a key `value`; it stays the last reader.
export const credentialLeaseFromResponse = (credential) =>
  credential.lease
    ? normalizeCredentialLease(credential.lease)
    : apiKeyLease(typeof credential.value === 'string' ? credential.value : null);

export const prepareCredentialLeases = async ({
  credentials,
  baseEnv,
  broker,
  context,
  adapters = CREDENTIAL_MATERIAL_ADAPTERS,
  controlledEnv = CREDENTIAL_MATERIAL_ENV_NAMES,
  now = Date.now,
}) => {
  let current = credentials.map(({ binding, lease }) => ({ binding, lease }));
  const prepare = () => {
    const env = { ...baseEnv };
    const credentialEnvironment = {};
    const materialTypes = new Set();
    for (const { binding, lease } of current) {
      if (!lease.material) continue;
      if (
        [lease.expiresAt, lease.authorizationExpiresAt].some(
          (time) => time !== null && time <= now(),
        )
      )
        throw authError('AGENT_AUTH_LEASE_EXPIRED', 'Credential lease has expired');
      const adapter = adapters[lease.material.type];
      if (!adapter)
        throw authError(
          'AGENT_AUTH_RUNTIME_UNSUPPORTED',
          'Credential material is unsupported by this runtime',
        );
      const prepared = adapter({ binding, material: lease.material });
      assertProviderEnv(
        lease.material.type,
        controlledEnv,
        Object.keys(prepared.env ?? {}),
        Object.keys(prepared.credentialEnvironment ?? {}),
      );
      Object.assign(env, prepared.env);
      Object.assign(credentialEnvironment, prepared.credentialEnvironment);
      materialTypes.add(lease.material.type);
    }
    const minimum = (field) => {
      const values = current.map(({ lease }) => lease[field]).filter((value) => value !== null);
      return values.length ? Math.min(...values) : null;
    };
    return {
      env,
      credentialEnvironment,
      // Capability hooks run only for the materials this invocation adapted.
      materialTypes: [...materialTypes],
      expiresAt: minimum('expiresAt'),
      authorizationExpiresAt: minimum('authorizationExpiresAt'),
    };
  };
  const initial = prepare();
  const state = {
    ...initial,
    refresh: current.some(({ lease }) => lease.renewal)
      ? async () => {
          const next = await Promise.all(
            current.map(async ({ binding, lease }) => {
              if (!lease.renewal) return { binding, lease };
              const response = await broker({
                action: lease.renewal.action ?? 'resolve-agent-credentials',
                grant: lease.renewal.grant,
              });
              if (
                response.purpose !== context.purpose ||
                (response.projectId ?? null) !== context.projectId ||
                (response.executionId ?? null) !== context.executionId ||
                response.credentials?.length !== 1 ||
                bindingIdentity(response.credentials[0].binding) !== bindingIdentity(binding)
              )
                throw authError(
                  'AGENT_AUTH_LEASE_INVALID',
                  'Renewed credential does not match the invocation',
                );
              const renewed = credentialLeaseFromResponse(response.credentials[0]);
              // Renewal never widens the initial authorization boundary.
              return {
                binding,
                lease: { ...renewed, authorizationExpiresAt: lease.authorizationExpiresAt },
              };
            }),
          );
          current = next;
          return prepare();
        }
      : null,
  };
  const owned = current.filter(({ lease }) => adapters[lease.material?.type]?.createSession);
  if (owned.length > 1)
    throw authError(
      'AGENT_AUTH_RUNTIME_UNSUPPORTED',
      'This runtime supports one session-owning inference adapter per invocation',
    );
  if (owned.length) {
    const credential = owned[0];
    const { type } = credential.lease.material;
    const session = await adapters[type].createSession({
      credential,
      env: initial.env,
      renew: async () => {
        await state.refresh();
        return current.find(
          ({ binding }) => bindingIdentity(binding) === bindingIdentity(credential.binding),
        ).lease;
      },
    });
    try {
      assertProviderEnv(
        type,
        controlledEnv,
        Object.keys(session.env ?? {}).filter((name) => session.env[name] !== initial.env[name]),
        Object.keys(session.credentialEnvironment ?? {}),
      );
    } catch (error) {
      await session.release?.();
      throw error;
    }
    state.credentialSession = session;
    state.env = session.env;
  }
  return state;
};
