import { Logger } from '@aws-lambda-powertools/logger';
import { KMSClient, GetPublicKeyCommand } from '@aws-sdk/client-kms';
import { ddb, openGraph } from './clients.js';
import { closeGraphSource } from '../shared/mcp/graph-writer.js';
import { createProcessStore } from '../shared/v2-process-store.js';
import { kmsPublicKeyResolver, verifyGatewayGrant } from '../shared/gateway-grant.js';
import { gatewayGrantRetirementCheckFromEnv } from '../shared/gateway-grant-retirement.js';
import { createGatewayAuthorizer } from '../shared/mcp/gateway-authorization.js';
import { customTargetsFromEnv } from '../shared/mcp/gateway-custom-targets.js';
import { createGatewayInterceptor } from './interceptor.js';

const logger = new Logger({ persistentKeys: { component: 'mcp-interceptor' } });

const publicKeyFor = kmsPublicKeyResolver({
  kms: new KMSClient({}),
  GetPublicKeyCommand,
  allowedKeyIds: (process.env.GATEWAY_GRANT_KEY_IDS ?? '').split(','),
});

const isRetired = gatewayGrantRetirementCheckFromEnv({ ddb });

// Parsed on first use and per request until it parses, so a malformed registry
// denies requests instead of failing the Lambda's initialization.
let customTargets;
const loadCustomTargets = () => (customTargets ??= customTargetsFromEnv(process.env));

export const handler = createGatewayInterceptor({
  authorizer: createGatewayAuthorizer({
    verifyGrant: (token) => verifyGatewayGrant(token, { publicKeyFor, isRetired }),
    createStore: () => createProcessStore({ ddb, tableName: process.env.V2_PROCESS_TABLE }),
    openGraph,
    closeGraphSource,
    processTable: process.env.V2_PROCESS_TABLE,
    customTargets: loadCustomTargets,
  }),
  audit: (record) =>
    record.decision === 'deny'
      ? logger.warn('mcp gateway request denied', record)
      : logger.info('mcp gateway request', record),
});
