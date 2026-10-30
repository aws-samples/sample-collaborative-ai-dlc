import { KMSClient, GetPublicKeyCommand } from '@aws-sdk/client-kms';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { Logger } from '@aws-lambda-powertools/logger';
import { kmsPublicKeyResolver, verifyGatewayGrant } from '../shared/gateway-grant.js';
import { authError } from '../shared/agent-auth-contracts.js';
import { gatewayGrantRetirementCheckFromEnv } from '../shared/gateway-grant-retirement.js';
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

// A retired grant is denied wherever a grant is verified, in transition and in
// enforcement alike: like every other grant claim, a presented grant is never
// downgraded. Only legacy-shape requests, which carry no grant, are unaffected.
const isRetired = gatewayGrantRetirementCheckFromEnv({
  ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})),
});

export const verifyBrokerGatewayGrant = (token) =>
  verifyGatewayGrant(token, { publicKeyFor, isRetired });

const renewalEnded = () =>
  authError('AGENT_CREDENTIAL_GRANT_INVALID', 'The renewal is no longer authorized');

// A renewal re-runs only what can end it, never the handoff's Gateway verification or
// invocation accounting: the execution must not have been cancelled since the handoff,
// and the Gateway grant the handoff was authorized by (named in the renewal token) must
// not have been retired. A run that ends on its own retires its grants one by one, so
// its renewals end with them, while a grant issued after the run (a discussion, an
// artifact-edit derive) keeps renewing. Renewal tokens issued before the binding name
// no grant: served the legacy way in transition, refused once grants are enforced.
// `execution` is the META row the caller read; a missing one is already refused.
export const assertRenewalAuthority = async ({
  claims,
  execution,
  env,
  action,
  isGrantRetired = isRetired,
}) => {
  const origin = claims.gatewayGrant ?? null;
  if (!origin) {
    if (runtimeGrantsEnforced(env)) throw renewalEnded();
    if (engineDataEnabled(env))
      logger.warn('legacy renewal token', { code: 'LEGACY_RENEWAL_TOKEN', action });
  }
  if (execution?.status === 'CANCELLED') {
    const cancelledAt = Date.parse(execution.completedAt);
    const issuedAt = origin?.issuedAt ?? claims.issuedAt;
    if (!Number.isFinite(cancelledAt) || issuedAt * 1000 <= cancelledAt) throw renewalEnded();
  }
  if (!origin) return;
  // Fail closed: a lookup failure throws an uncoded error the runtime retries.
  if (typeof isGrantRetired !== 'function')
    throw new Error('Gateway grant retirement is not configured');
  if ((await isGrantRetired(origin)) !== false) throw renewalEnded();
};

export const authorizeGitGateway = async (request, verifyGrant = verifyBrokerGatewayGrant) =>
  assertEngineGrantFor(await verifyGrant(request.gatewayGrant), request);
