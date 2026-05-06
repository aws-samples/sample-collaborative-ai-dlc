const { DynamoDBClient, QueryCommand, ScanCommand } = require('@aws-sdk/client-dynamodb');
const { ApiGatewayManagementApiClient, PostToConnectionCommand } = require('@aws-sdk/client-apigatewaymanagementapi');

const dynamodb = new DynamoDBClient();
const getApiClient = () => new ApiGatewayManagementApiClient({ endpoint: process.env.WEBSOCKET_ENDPOINT });

exports.handler = async (event) => {
  const connectionId = event.requestContext.connectionId;
  const body = JSON.parse(event.body || '{}');
  const { action, documentId } = body;
  console.log('Message received:', JSON.stringify({ action, connectionId }));

  if (action === 'notification' && body.data?.userId) {
    await broadcastToUser(body.data.userId, body);
  } else if (action === 'broadcast') {
    await broadcastToAll(body, connectionId);
  } else if (action === 'broadcastToDocument' && documentId) {
    // Broadcast a message to all connections on the same document, excluding sender.
    // The inner `data` payload is forwarded so receivers get the actual event type.
    await broadcastToDocument(documentId, body.data || body, connectionId);
  }
  return { statusCode: 200 };
};

const broadcastToDocument = async (documentId, message, excludeConnectionId) => {
  const connections = await dynamodb.send(new QueryCommand({
    TableName: process.env.CONNECTIONS_TABLE,
    IndexName: 'DocumentIdIndex',
    KeyConditionExpression: 'documentId = :docId',
    ExpressionAttributeValues: { ':docId': { S: documentId } }
  })).catch((e) => { console.error('Query error:', e); return { Items: [] }; });
  await broadcast(connections.Items || [], message, excludeConnectionId);
};

const broadcastToUser = async (userId, message) => {
  const connections = await dynamodb.send(new QueryCommand({
    TableName: process.env.CONNECTIONS_TABLE,
    IndexName: 'UserIdIndex',
    KeyConditionExpression: 'userId = :uid',
    ExpressionAttributeValues: { ':uid': { S: userId } }
  }));
  await broadcast(connections.Items || [], message);
};

const broadcastToAll = async (message, excludeConnectionId) => {
  const connections = await dynamodb.send(new ScanCommand({ TableName: process.env.CONNECTIONS_TABLE }));
  await broadcast(connections.Items || [], message, excludeConnectionId);
};

const broadcast = async (items, message, excludeConnectionId) => {
  const api = getApiClient();
  const payload = JSON.stringify(message);
  await Promise.all(items.map(async (item) => {
    const connId = item.connectionId.S;
    if (connId === excludeConnectionId) return;
    try {
      await api.send(new PostToConnectionCommand({ ConnectionId: connId, Data: payload }));
    } catch (e) {
      if (e.statusCode !== 410) console.log('Send error to', connId, ':', e.message);
    }
  }));
};
