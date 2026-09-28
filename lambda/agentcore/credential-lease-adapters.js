import { credentialEnvName, authError, bindingIdentity } from '../shared/agent-auth-contracts.js';
import { apiKeyLease, normalizeCredentialLease } from '../shared/agent-credential-lease.js';

export const CREDENTIAL_MATERIAL_ADAPTERS = Object.freeze({
  'api-key': ({ binding, material }) => {
    if (typeof material.value !== 'string' || !material.value)
      throw authError('AGENT_AUTH_LEASE_INVALID', 'API key material is invalid');
    return { env: { [credentialEnvName(binding.provider)]: material.value } };
  },
});

export const credentialLeaseFromResponse = (credential) =>
  credential.lease
    ? normalizeCredentialLease(credential.lease)
    : apiKeyLease(typeof credential.value === 'string' ? credential.value : null);

export const prepareCredentialLeases = ({
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
  return {
    ...initial,
    refresh: current.some(({ lease }) => lease.renewal)
      ? async () => {
          const next = await Promise.all(
            current.map(async ({ binding, lease }) => {
              if (!lease.renewal) return { binding, lease };
              const response = await broker({
                action: 'resolve-agent-credentials',
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
};
