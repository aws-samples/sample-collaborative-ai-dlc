import { KMSClient, SignCommand } from '@aws-sdk/client-kms';
import { issueGatewayGrant, kmsSigner } from './gateway-grant.js';

// Null when the deployment has not enabled the MCP Gateway: callers then send
// no grant and the runtime keeps its local MCP server.
export const gatewayGrantIssuerFromEnv = (env = process.env, kms = null) => {
  const keyId = env.GATEWAY_GRANT_KEY_ID;
  if (!keyId) return null;
  const sign = kmsSigner({ kms: kms ?? new KMSClient({}), SignCommand, keyId });
  return (scope, options = {}) => issueGatewayGrant(scope, { ...options, sign, keyId });
};
