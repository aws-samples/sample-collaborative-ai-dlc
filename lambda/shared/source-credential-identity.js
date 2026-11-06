import { createHash } from 'node:crypto';
import { canonicalJson } from './workflow-checkpoint.js';

// Token refresh deliberately does not change identity. Disconnect/reconnect,
// a different delegation, app installation, or SSM owner does.
export const sourceCredentialIdentity = (binding, connection) =>
  createHash('sha256')
    .update(
      canonicalJson({
        authType: binding.authType,
        credentialRef: binding.credentialRef,
        connectionUserId: binding.connectionUserId ?? null,
        installationId: binding.installationId ?? null,
        connection: connection
          ? Object.fromEntries(
              ['provider', 'parameterName', 'createdAt', 'generation', 'status'].map((key) => [
                key,
                connection[key] ?? null,
              ]),
            )
          : null,
      }),
    )
    .digest('hex');
