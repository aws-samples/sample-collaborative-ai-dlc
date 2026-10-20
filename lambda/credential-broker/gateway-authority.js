import { KMSClient, GetPublicKeyCommand } from '@aws-sdk/client-kms';
import { kmsPublicKeyResolver, verifyGatewayGrant } from '../shared/gateway-grant.js';
import { assertEngineGrantFor } from '../shared/execution-repository-authority.js';

export {
  assertGatewayExecution,
  gatewayScopeDenied,
} from '../shared/execution-repository-authority.js';

export const brokerEnforcementEnabled = (env) => env.ENGINE_DATA_ENABLED === 'true';

const publicKeyFor = kmsPublicKeyResolver({
  kms: new KMSClient({}),
  GetPublicKeyCommand,
  allowedKeyIds: (process.env.GATEWAY_GRANT_KEY_IDS ?? '').split(',').map((id) => id.trim()),
});

export const verifyBrokerGatewayGrant = (token) => verifyGatewayGrant(token, { publicKeyFor });

export const authorizeGitGateway = async (request, verifyGrant = verifyBrokerGatewayGrant) =>
  assertEngineGrantFor(await verifyGrant(request.gatewayGrant), request);
