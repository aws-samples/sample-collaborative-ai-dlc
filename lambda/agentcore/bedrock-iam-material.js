import { authError } from '../shared/agent-auth-contracts.js';
import { prepareBedrockIamSession } from './bedrock-iam.js';
export const IAM_MATERIAL_ADAPTER = Object.assign(
  ({ binding }) => {
    if (binding.backend !== 'bedrock' || binding.mechanism !== 'assume-role')
      throw authError(
        'AGENT_AUTH_LEASE_INVALID',
        'IAM material does not match the pinned mechanism',
      );
    return { env: { BEDROCK_REGION: binding.configuration.region } };
  },
  {
    createSession: ({ credential: { binding, lease }, env, renew }) =>
      prepareBedrockIamSession(
        {
          binding,
          iamCredentials: lease.material.credentials,
          renewalExpiresAt: lease.authorizationExpiresAt,
          renewalToken: lease.renewal?.grant,
        },
        { env, renew: async () => (await renew()).material.credentials },
      ),
  },
);
