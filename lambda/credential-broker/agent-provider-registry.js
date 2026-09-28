import { verifyIssuedAgentCredentialGrant } from '../shared/agent-credential-grants.js';
import { KEY_REDEMPTION_ADAPTERS } from '../shared/agent-auth-redemption.js';
export const isAgentCredentialAction = (action) => action === 'resolve-agent-credentials';
export const loggableAgentCredentialErrorCode = (error) =>
  [
    'AGENT_CREDENTIAL_GRANT_EXPIRED',
    'AGENT_CREDENTIAL_GRANT_INVALID',
    'AGENT_CREDENTIAL_GRANT_NOT_CONFIGURED',
    'AGENT_AUTH_CONNECTION_UNAVAILABLE',
    'AGENT_AUTH_CHANGE_IN_PROGRESS',
  ].includes(error?.code)
    ? error.code
    : 'AGENT_CREDENTIAL_BROKER_FAILED';
export const createAgentProviderContext = async ({ grant }, { ssmClient, secret, env, now }) => ({
  claims: await verifyIssuedAgentCredentialGrant(ssmClient, grant, {
    secret,
    env,
    ...(now ? { now } : {}),
  }),
  adapters: KEY_REDEMPTION_ADAPTERS,
  verification: false,
  isolateDiscoveryFailure: () => false,
});
