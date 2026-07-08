// Server-origin WebSocket fan-out to the v2 intent channel.
//
// Fan-out is BEST-EFFORT: persistence has already succeeded when this runs,
// and every handler re-fetches from REST on receipt (payload-blind reload
// hints), so a missed event only delays a refresh.

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from '@aws-sdk/client-apigatewaymanagementapi';
import { isTokenLive } from './realtime-token.js';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/**
 * Broadcast `payload` to every live connection of `intent:{intentId}` — the v2
 * realtime channel (the AgentCore runtime fans out the same channel from
 * lambda/agentcore/clients.js; this lets server-side callers like the durable
 * orchestrator emit live too). Best-effort, never throws.
 *
 * @param {string} intentId
 * @param {object} payload — must carry `action` (the client routing key)
 */
const broadcastToIntentChannel = async (intentId, payload) => {
  const connectionsTable = process.env.CONNECTIONS_TABLE;
  const websocketEndpoint = process.env.WEBSOCKET_ENDPOINT;
  if (!connectionsTable || !websocketEndpoint || !intentId) return;
  try {
    // Drain LastEvaluatedKey: a Query page caps at 1MB, and truncation would
    // silently stop broadcasting to connections past the first page.
    const items = [];
    let ExclusiveStartKey;
    do {
      const page = await ddb.send(
        new QueryCommand({
          TableName: connectionsTable,
          IndexName: 'DocumentIdIndex',
          KeyConditionExpression: 'documentId = :docId',
          ExpressionAttributeValues: { ':docId': `intent:${intentId}` },
          ExclusiveStartKey,
        }),
      );
      items.push(...(page.Items ?? []));
      ExclusiveStartKey = page.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    const api = new ApiGatewayManagementApiClient({ endpoint: websocketEndpoint });
    const data = JSON.stringify(payload);
    await Promise.all(
      items
        // Never target connections whose scope token has expired.
        .filter((item) => isTokenLive(item.tokenExp))
        .map((item) =>
          api
            .send(new PostToConnectionCommand({ ConnectionId: item.connectionId, Data: data }))
            .catch(() => {}),
        ),
    );
  } catch (err) {
    console.error('Intent-channel fanout failed:', err.message);
  }
};

export { broadcastToIntentChannel };
export default { broadcastToIntentChannel };
