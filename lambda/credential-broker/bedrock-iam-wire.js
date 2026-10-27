import { authError } from '../shared/agent-auth-protocol.js';
import { BEDROCK_IAM_RENEWAL } from './bedrock-iam-provider.js';

// Review-environment runtimes used renewalToken and top-level IAM material before
// the foundation standardized on grant and leases. Translate only at the broker
// boundary; signing, validation, renewal deadlines and redemption stay host-owned.
export const withBedrockIamWire =
  (authorize) =>
  async (event = {}, dependencies) => {
    let request = event;
    if (event.action === BEDROCK_IAM_RENEWAL.action && event.renewalToken !== undefined) {
      if (event.grant !== undefined && event.grant !== event.renewalToken)
        throw authError('AGENT_CREDENTIAL_GRANT_INVALID', 'Conflicting renewal credentials');
      request = { ...event, grant: event.renewalToken };
    }
    const response = await authorize(request, dependencies);
    return {
      ...response,
      credentials: response.credentials.map((credential) => {
        const { binding, lease } = credential;
        if (
          binding?.backend !== 'bedrock' ||
          binding.mechanism !== 'assume-role' ||
          lease?.material?.type !== 'bedrock-iam'
        )
          return credential;
        return {
          ...credential,
          iamCredentials: lease.material.credentials,
          renewalToken: lease.renewal?.grant ?? null,
          renewalExpiresAt: lease.authorizationExpiresAt,
        };
      }),
    };
  };
