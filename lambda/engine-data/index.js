import { Logger } from '@aws-lambda-powertools/logger';
import { KMSClient, GetPublicKeyCommand } from '@aws-sdk/client-kms';
import { ddb } from './clients.js';
import { createProcessStore } from '../shared/v2-process-store.js';
import { kmsPublicKeyResolver, verifyGatewayGrant } from '../shared/gateway-grant.js';
import { createStoreGateway } from './store-gateway.js';

const logger = new Logger({ persistentKeys: { component: 'engine-data' } });

const publicKeyFor = kmsPublicKeyResolver({
  kms: new KMSClient({}),
  GetPublicKeyCommand,
  allowedKeyIds: (process.env.GATEWAY_GRANT_KEY_IDS ?? '').split(','),
});

export const handler = createStoreGateway({
  verifyGrant: (token) => verifyGatewayGrant(token, { publicKeyFor }),
  createStore: () => createProcessStore({ ddb, tableName: process.env.V2_PROCESS_TABLE }),
  audit: (record) =>
    record.decision === 'deny'
      ? logger.warn('engine data call denied', record)
      : logger.info('engine data call', record),
});
