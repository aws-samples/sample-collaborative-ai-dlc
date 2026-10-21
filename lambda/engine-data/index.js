import { Logger } from '@aws-lambda-powertools/logger';
import { KMSClient, GetPublicKeyCommand } from '@aws-sdk/client-kms';
import { ddb, openGraph, s3 } from './clients.js';
import { createProcessStore } from '../shared/v2-process-store.js';
import { kmsPublicKeyResolver, verifyGatewayGrant } from '../shared/gateway-grant.js';
import { gatewayGrantRetirementCheckFromEnv } from '../shared/gateway-grant-retirement.js';
import { ApiGatewayManagementApiClient } from '@aws-sdk/client-apigatewaymanagementapi';
import {
  ENGINE_DATA_BLOB_PREFIX,
  ENGINE_DATA_CATALOG_PREFIX,
  ENGINE_DATA_GRAPH_PREFIX,
  ENGINE_DATA_OP_PREFIX,
  ENGINE_DATA_REALTIME_PREFIX,
} from '../shared/engine-data-ops.js';
import { createGraphManager } from '../shared/mcp/graph-manager.js';
import { closeGraphSource } from '../shared/mcp/graph-writer.js';
import { createStoreGateway } from './store-gateway.js';
import { createGraphGateway } from './graph-gateway.js';
import { createCatalogGateway } from './catalog-gateway.js';
import { createBlobGateway } from './blob-gateway.js';
import { createRealtimeGateway } from './realtime-gateway.js';
import { createNamespaceDispatch } from './gateway-common.js';

const logger = new Logger({ persistentKeys: { component: 'engine-data' } });

const publicKeyFor = kmsPublicKeyResolver({
  kms: new KMSClient({}),
  GetPublicKeyCommand,
  allowedKeyIds: (process.env.GATEWAY_GRANT_KEY_IDS ?? '').split(','),
});

// Retirement is checked per call like every other grant claim. Writes the
// engine makes before its stage callback carry a live grant and are unaffected.
const isRetired = gatewayGrantRetirementCheckFromEnv({ ddb });
const verifyGrant = (token) => verifyGatewayGrant(token, { publicKeyFor, isRetired });
const createStore = () => createProcessStore({ ddb, tableName: process.env.V2_PROCESS_TABLE });
const audit = (record) =>
  record.decision === 'deny'
    ? logger.warn('engine data call denied', record)
    : logger.info('engine data call', record);

// One lazily opened Neptune connection per Lambda environment, refreshed before
// its SigV4 headers age out. Only the connection is shared: every request
// builds its own writer from its own verified grant.
const graph = createGraphManager({ openGraph, closeGraphSource });

const storeHandler = createStoreGateway({ verifyGrant, createStore, audit });
const graphHandler = createGraphGateway({
  verifyGrant,
  createStore,
  withGraph: graph.withGraph,
  audit,
});

const catalogHandler = createCatalogGateway({
  verifyGrant,
  s3,
  ddb,
  bucket: process.env.ARTIFACTS_BUCKET,
  blocksTable: process.env.BLOCKS_TABLE,
  audit,
});

const blobHandler = createBlobGateway({
  verifyGrant,
  createStore,
  s3,
  bucket: process.env.ARTIFACTS_BUCKET,
  audit,
});

const websocketEndpoint = process.env.WEBSOCKET_ENDPOINT;
const realtimeHandler = createRealtimeGateway({
  verifyGrant,
  createStore,
  withGraph: graph.withGraph,
  ddb,
  api: websocketEndpoint
    ? new ApiGatewayManagementApiClient({ endpoint: websocketEndpoint })
    : null,
  connectionsTable: process.env.CONNECTIONS_TABLE,
  audit,
});

export const handler = createNamespaceDispatch(
  {
    [ENGINE_DATA_OP_PREFIX]: storeHandler,
    [ENGINE_DATA_GRAPH_PREFIX]: graphHandler,
    [ENGINE_DATA_CATALOG_PREFIX]: catalogHandler,
    [ENGINE_DATA_BLOB_PREFIX]: blobHandler,
    [ENGINE_DATA_REALTIME_PREFIX]: realtimeHandler,
  },
  { audit },
);
