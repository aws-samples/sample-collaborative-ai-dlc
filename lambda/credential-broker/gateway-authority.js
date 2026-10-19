import { KMSClient, GetPublicKeyCommand } from '@aws-sdk/client-kms';
import {
  GatewayGrantError,
  kmsPublicKeyResolver,
  verifyGatewayGrant,
} from '../shared/gateway-grant.js';

export const brokerEnforcementEnabled = (env) => env.ENGINE_DATA_ENABLED === 'true';

const publicKeyFor = kmsPublicKeyResolver({
  kms: new KMSClient({}),
  GetPublicKeyCommand,
  allowedKeyIds: (process.env.GATEWAY_GRANT_KEY_IDS ?? '').split(',').map((id) => id.trim()),
});

export const verifyBrokerGatewayGrant = (token) => verifyGatewayGrant(token, { publicKeyFor });

export const gatewayScopeDenied = () =>
  new GatewayGrantError('GATEWAY_GRANT_SCOPE_MISMATCH', 'Gateway grant does not match the request');

export const assertGatewayExecution = (grant, execution) => {
  if (
    !execution ||
    execution.projectId !== grant.projectId ||
    execution.intentId !== grant.intentId
  ) {
    throw gatewayScopeDenied();
  }
};

export const authorizeGitGateway = async (request, verifyGrant = verifyBrokerGatewayGrant) => {
  const grant = await verifyGrant(request.gatewayGrant);
  if (
    !['execution', 'stage', 'conflict'].includes(grant.mode) ||
    request.executionId !== grant.executionId ||
    request.projectId !== grant.projectId
  )
    throw gatewayScopeDenied();
  return grant;
};
