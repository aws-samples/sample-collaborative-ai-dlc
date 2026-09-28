import {
  CREDENTIAL_MATERIAL_ADAPTERS,
  CREDENTIAL_RESPONSE_READERS,
} from './credential-material-registry.js';
export { CREDENTIAL_MATERIAL_ADAPTERS } from './credential-material-registry.js';
import { authError, bindingIdentity } from '../shared/agent-auth-contracts.js';
import { apiKeyLease, normalizeCredentialLease } from '../shared/agent-credential-lease.js';

export const credentialLeaseFromResponse = (credential) =>
  credential.lease
    ? normalizeCredentialLease(credential.lease)
    : (CREDENTIAL_RESPONSE_READERS.map((read) => read(credential)).find(Boolean) ??
      apiKeyLease(typeof credential.value === 'string' ? credential.value : null));

export const prepareCredentialLeases = async ({
  credentials,
  baseEnv,
  broker,
  context,
  adapters = CREDENTIAL_MATERIAL_ADAPTERS,
  now = Date.now,
}) => {
  let current = credentials.map(({ binding, lease }) => ({ binding, lease }));
  const prepare = () => {
    const env = { ...baseEnv };
    const credentialEnvironment = {};
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
      Object.assign(env, prepared.env);
      Object.assign(credentialEnvironment, prepared.credentialEnvironment);
    }
    const minimum = (field) => {
      const values = current.map(({ lease }) => lease[field]).filter((value) => value !== null);
      return values.length ? Math.min(...values) : null;
    };
    return {
      env,
      credentialEnvironment,
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
                [lease.renewal.tokenField ?? 'grant']: lease.renewal.grant,
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
    state.credentialSession = await adapters[credential.lease.material.type].createSession({
      credential,
      env: initial.env,
      renew: async () => {
        await state.refresh();
        return current.find(
          ({ binding }) => bindingIdentity(binding) === bindingIdentity(credential.binding),
        ).lease;
      },
    });
    state.env = state.credentialSession.env;
  }
  return state;
};
