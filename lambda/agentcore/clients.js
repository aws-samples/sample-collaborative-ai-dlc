// Shared AWS + Neptune clients for the AgentCore container, constructed once.
//
// Test seam mirrors the discussions lambda: GREMLIN_PROTOCOL=ws (plain, no IAM)
// for a local gremlin-server; wss + SigV4 in production Neptune. The DDB/S3/WS
// clients use the default credential chain (the ECS/AgentCore task role).

import gremlin from 'gremlin';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { getUrlAndHeaders } from 'gremlin-aws-sigv4/lib/utils';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from '@aws-sdk/client-apigatewaymanagementapi';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';

const traversal = gremlin.process.AnonymousTraversalSource.traversal;
const DriverRemoteConnection = gremlin.driver.DriverRemoteConnection;

export const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
export const s3 = new S3Client({});

let _conn = null;

// Open a Neptune (or local gremlin-server) traversal source. wss+SigV4 in prod;
// plain ws for the test container.
export const openGraph = async () => {
  const endpoint = process.env.NEPTUNE_ENDPOINT;
  const port = process.env.GREMLIN_PORT ?? '8182';
  const protocol = process.env.GREMLIN_PROTOCOL ?? 'wss';
  if (protocol === 'ws') {
    _conn = new DriverRemoteConnection(`ws://${endpoint}:${port}/gremlin`);
  } else {
    const region = process.env.AWS_REGION || 'us-east-1';
    const creds = await fromNodeProviderChain()();
    const signerCreds = {
      ...creds,
      accessKey: creds.accessKeyId,
      secretKey: creds.secretAccessKey,
      region,
    };
    const info = getUrlAndHeaders(endpoint, port, signerCreds, '/gremlin', 'wss');
    _conn = new DriverRemoteConnection(info.url, { headers: info.headers });
  }
  return traversal().withRemote(_conn);
};

export const closeGraph = async () => {
  await _conn?.close();
  _conn = null;
};

// Broadcast a payload to every live connection on the intent's realtime channel.
// Best-effort; never throws. Mirrors the v1 sprint-channel fanout but keyed on
// `intent:<intentId>` (the v2 realtime channel).
export const broadcastToIntent = async (intentId, payload) => {
  const connectionsTable = process.env.CONNECTIONS_TABLE;
  const websocketEndpoint = process.env.WEBSOCKET_ENDPOINT;
  if (!connectionsTable || !websocketEndpoint || !intentId) return;
  try {
    const { Items } = await ddb.send(
      new QueryCommand({
        TableName: connectionsTable,
        IndexName: 'DocumentIdIndex',
        KeyConditionExpression: 'documentId = :doc',
        ExpressionAttributeValues: { ':doc': `intent:${intentId}` },
      }),
    );
    const api = new ApiGatewayManagementApiClient({ endpoint: websocketEndpoint });
    const data = JSON.stringify(payload);
    await Promise.all(
      (Items ?? []).map((item) =>
        api
          .send(new PostToConnectionCommand({ ConnectionId: item.connectionId, Data: data }))
          .catch(() => {}),
      ),
    );
  } catch (err) {
    console.error('[agentcore] intent broadcast failed:', err.message);
  }
};
