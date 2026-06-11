import { DynamoDBClient, QueryCommand, GetItemCommand } from '@aws-sdk/client-dynamodb';
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from '@aws-sdk/client-apigatewaymanagementapi';
import { isTokenLive } from '../shared/realtime-token.js';

const dynamodb = new DynamoDBClient();
const getApiClient = () =>
  new ApiGatewayManagementApiClient({ endpoint: process.env.WEBSOCKET_ENDPOINT });

// -----------------------------------------------------------------------------
// Client-origin event allowlist (discussions plan §4b, D10 — END STATE).
//
// All realtime events are now SERVER-ORIGIN: `question.answered` is emitted by
// the questions lambda (PUT) and the agents lambda (answer endpoint), and
// `sprint.phaseChanged` by the sprints lambda (phase update) — see
// lambda/shared/ws-fanout.js. The frontend no longer client-broadcasts
// anything, so the allowlist is EMPTY: every client `broadcastToDocument` is
// dropped and logged. Connected clients cannot inject events at all.
// -----------------------------------------------------------------------------
const CLIENT_EVENT_ALLOWLIST = [];

export const handler = async (event) => {
  const connectionId = event.requestContext.connectionId;
  const body = JSON.parse(event.body || '{}');
  const { action } = body;
  console.log('Message received:', JSON.stringify({ action, connectionId }));

  // Only broadcastToDocument remains client-reachable. The legacy `broadcast`
  // (table scan) and client-origin `notification` paths had no frontend
  // callers and allowed cross-document/event spoofing — removed (plan §4b).
  if (action !== 'broadcastToDocument') {
    console.warn(`Dropped non-allowlisted action "${action}" from ${connectionId}`);
    return { statusCode: 200 };
  }

  // Allowlist check FIRST (it is empty — nothing client-origin passes), so
  // dropped messages cost no DynamoDB work.
  const message = body.data || {};
  const eventType = message.action || message.type;
  if (!CLIENT_EVENT_ALLOWLIST.includes(eventType)) {
    console.warn(`Dropped non-allowlisted client event "${eventType}" from ${connectionId}`);
    return { statusCode: 200 };
  }

  // Resolve the sender's registered connection row. The broadcast target is
  // NEVER taken from the message body — a client can only reach peers of the
  // document it authenticated for at $connect.
  const senderRow = await dynamodb
    .send(
      new GetItemCommand({
        TableName: process.env.CONNECTIONS_TABLE,
        Key: { connectionId: { S: connectionId } },
      }),
    )
    .then((r) => r.Item)
    .catch((e) => {
      console.error('Sender lookup error:', e);
      return null;
    });
  if (!senderRow?.documentId?.S) {
    console.warn(`Dropped message from unregistered connection ${connectionId}`);
    return { statusCode: 200 };
  }

  // Reject sends from connections whose scope token has lapsed (plan §4a).
  if (!isTokenLive(senderRow.tokenExp?.N)) {
    console.warn(`Dropped message from connection ${connectionId} with expired token`);
    return { statusCode: 200 };
  }

  const registeredDocumentId = senderRow.documentId.S;
  if (body.documentId && body.documentId !== registeredDocumentId) {
    // Body value is advisory only — log the mismatch, use the registered doc.
    console.warn(
      `documentId mismatch from ${connectionId}: body="${body.documentId}" registered="${registeredDocumentId}"`,
    );
  }

  await broadcastToDocument(registeredDocumentId, message, connectionId);
  return { statusCode: 200 };
};

const broadcastToDocument = async (documentId, message, excludeConnectionId) => {
  const connections = await dynamodb
    .send(
      new QueryCommand({
        TableName: process.env.CONNECTIONS_TABLE,
        IndexName: 'DocumentIdIndex',
        KeyConditionExpression: 'documentId = :docId',
        ExpressionAttributeValues: { ':docId': { S: documentId } },
      }),
    )
    .catch((e) => {
      console.error('Query error:', e);
      return { Items: [] };
    });
  await broadcast(connections.Items || [], message, excludeConnectionId);
};

const broadcast = async (items, message, excludeConnectionId) => {
  const api = getApiClient();
  const payload = JSON.stringify(message);
  await Promise.all(
    items.map(async (item) => {
      const connId = item.connectionId.S;
      if (connId === excludeConnectionId) return;
      // Never target connections whose scope token has expired (plan §4a).
      if (!isTokenLive(item.tokenExp?.N)) return;
      try {
        await api.send(new PostToConnectionCommand({ ConnectionId: connId, Data: payload }));
      } catch (e) {
        if (e.statusCode !== 410) console.log('Send error to', connId, ':', e.message);
      }
    }),
  );
};
