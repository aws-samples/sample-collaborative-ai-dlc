import { Logger } from '@aws-lambda-powertools/logger';
import { KMSClient, GetPublicKeyCommand } from '@aws-sdk/client-kms';
import { ddb, openGraph } from './clients.js';
import { createProcessStore } from '../shared/v2-process-store.js';
import { kmsPublicKeyResolver, verifyGatewayGrant } from '../shared/gateway-grant.js';
import { ENGINE_DATA_GRAPH_PREFIX } from '../shared/engine-data-ops.js';
import { createGraphManager } from '../shared/mcp/graph-manager.js';
import { closeGraphSource } from '../shared/mcp/graph-writer.js';
import { createStoreGateway } from './store-gateway.js';
import { createGraphGateway } from './graph-gateway.js';

const logger = new Logger({ persistentKeys: { component: 'engine-data' } });

const publicKeyFor = kmsPublicKeyResolver({
  kms: new KMSClient({}),
  GetPublicKeyCommand,
  allowedKeyIds: (process.env.GATEWAY_GRANT_KEY_IDS ?? '').split(','),
});

const verifyGrant = (token) => verifyGatewayGrant(token, { publicKeyFor });
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

export const handler = (event) =>
  typeof event?.op === 'string' && event.op.startsWith(ENGINE_DATA_GRAPH_PREFIX)
    ? graphHandler(event)
    : storeHandler(event);
