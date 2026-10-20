import { KMSClient, GetPublicKeyCommand } from '@aws-sdk/client-kms';
import { Logger } from '@aws-lambda-powertools/logger';
import { kmsPublicKeyResolver, verifyGatewayGrant } from '../shared/gateway-grant.js';
import { assertEngineGrantFor } from '../shared/execution-repository-authority.js';

export {
  assertGatewayExecution,
  gatewayScopeDenied,
} from '../shared/execution-repository-authority.js';

const logger = new Logger({ persistentKeys: { component: 'credential-broker' } });

// The broker's mode comes only from its own environment, never from a request.
// ENGINE_DATA_ENABLED makes the engine-data paths available; RUNTIME_GRANTS_ENFORCED
// additionally retires the legacy runtime request shapes.
export const engineDataEnabled = (env) => env.ENGINE_DATA_ENABLED === 'true';
export const runtimeGrantsEnforced = (env) =>
  engineDataEnabled(env) && env.RUNTIME_GRANTS_ENFORCED === 'true';

// Fields only engine-data runtimes send. Carrying any of them selects full
// verification; a present-but-invalid authority is denied, never downgraded.
const RUNTIME_AUTHORITY_FIELDS = Object.freeze([
  'gatewayGrant',
  'invocationNonce',
  'command',
  'verificationGrant',
  'ticket',
]);

// In transition only a request without any of these fields (or the action's
// `markers`, which its legacy shape never sends) keeps the legacy path.
export const runtimeAuthorityRequired = (request, env, { action, markers = [] }) => {
  if (!engineDataEnabled(env)) return false;
  if (runtimeGrantsEnforced(env)) return true;
  const fields = [...RUNTIME_AUTHORITY_FIELDS, ...markers];
  if (fields.some((field) => Object.hasOwn(request ?? {}, field))) return true;
  logger.warn('legacy runtime request', { code: 'LEGACY_RUNTIME_REQUEST', action });
  return false;
};

const publicKeyFor = kmsPublicKeyResolver({
  kms: new KMSClient({}),
  GetPublicKeyCommand,
  allowedKeyIds: (process.env.GATEWAY_GRANT_KEY_IDS ?? '').split(',').map((id) => id.trim()),
});

export const verifyBrokerGatewayGrant = (token) => verifyGatewayGrant(token, { publicKeyFor });

export const authorizeGitGateway = async (request, verifyGrant = verifyBrokerGatewayGrant) =>
  assertEngineGrantFor(await verifyGrant(request.gatewayGrant), request);
