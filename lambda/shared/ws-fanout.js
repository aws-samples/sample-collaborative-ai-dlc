'use strict';

// Server-origin WebSocket fan-out to a sprint channel. Used by the
// questions, sprints, and agents lambdas to emit
// `question.answered` / `sprint.phaseChanged` server-side — replacing the
// client-origin broadcasts that ws-message used to allowlist.
//
// Fan-out is BEST-EFFORT: persistence has already succeeded when this runs,
// and every handler re-fetches from REST on receipt (payload-blind reload
// hints), so a missed event only delays a refresh.

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, QueryCommand } = require('@aws-sdk/lib-dynamodb');
const {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} = require('@aws-sdk/client-apigatewaymanagementapi');
const { isTokenLive } = require('./realtime-token.js');

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/**
 * Broadcast `payload` to every live connection of `sprint:{sprintId}`.
 * Reads CONNECTIONS_TABLE / WEBSOCKET_ENDPOINT from the environment; no-ops
 * (with a log) when unconfigured. Never throws.
 *
 * @param {string} sprintId
 * @param {object} payload — must carry `action` (the client routing key)
 */
const broadcastToSprintChannel = async (sprintId, payload) => {
  const connectionsTable = process.env.CONNECTIONS_TABLE;
  const websocketEndpoint = process.env.WEBSOCKET_ENDPOINT;
  if (!connectionsTable || !websocketEndpoint || !sprintId) return;
  try {
    const result = await ddb.send(
      new QueryCommand({
        TableName: connectionsTable,
        IndexName: 'DocumentIdIndex',
        KeyConditionExpression: 'documentId = :docId',
        ExpressionAttributeValues: { ':docId': `sprint:${sprintId}` },
      }),
    );
    const api = new ApiGatewayManagementApiClient({ endpoint: websocketEndpoint });
    const data = JSON.stringify(payload);
    await Promise.all(
      (result.Items || [])
        // Never target connections whose scope token has expired.
        .filter((item) => isTokenLive(item.tokenExp))
        .map((item) =>
          api
            .send(new PostToConnectionCommand({ ConnectionId: item.connectionId, Data: data }))
            .catch(() => {}),
        ),
    );
  } catch (err) {
    console.error('Sprint-channel fanout failed:', err.message);
  }
};

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

module.exports = { broadcastToSprintChannel, broadcastToIntentChannel };
