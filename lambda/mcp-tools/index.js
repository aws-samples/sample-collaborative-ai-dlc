import { Logger } from '@aws-lambda-powertools/logger';
import { KMSClient, GetPublicKeyCommand } from '@aws-sdk/client-kms';
import { ddb, openGraph } from './clients.js';
import { createGraphWriter, closeGraphSource } from '../shared/mcp/graph-writer.js';
import { createGraphManager } from '../shared/mcp/graph-manager.js';
import { createProcessBridge } from '../shared/mcp/process-bridge.js';
import { createProcessStore } from '../shared/v2-process-store.js';
import { broadcastToIntentChannel } from '../shared/ws-fanout.js';
import { kmsPublicKeyResolver, verifyGatewayGrant } from '../shared/gateway-grant.js';
import { createToolGateway } from './tool-gateway.js';

const logger = new Logger({ persistentKeys: { component: 'mcp-tools' } });

const publicKeyFor = kmsPublicKeyResolver({
  kms: new KMSClient({}),
  GetPublicKeyCommand,
  allowedKeyIds: (process.env.GATEWAY_GRANT_KEY_IDS ?? '').split(','),
});

export const handler = createToolGateway({
  verifyGrant: (token) => verifyGatewayGrant(token, { publicKeyFor }),
  createStore: () => createProcessStore({ ddb, tableName: process.env.V2_PROCESS_TABLE }),
  openGraph,
  closeGraphSource,
  createGraphWriter,
  createGraphManager,
  createProcessBridge,
  broadcastToIntent: broadcastToIntentChannel,
  processTable: process.env.V2_PROCESS_TABLE,
  bridgeOptions: {
    pollIntervalMs: Number(process.env.V2_QUESTION_POLL_MS) || 3000,
    parkGraceMs: Number(process.env.V2_QUESTION_PARK_GRACE_MS) || undefined,
  },
  audit: (record) =>
    record.decision === 'deny'
      ? logger.warn('mcp tool call denied', record)
      : logger.info('mcp tool call', record),
});
