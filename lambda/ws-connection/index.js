const { DynamoDBClient, PutItemCommand, DeleteItemCommand, QueryCommand } = require('@aws-sdk/client-dynamodb');
const { ApiGatewayManagementApiClient, PostToConnectionCommand } = require('@aws-sdk/client-apigatewaymanagementapi');
const client = new DynamoDBClient();

exports.handler = async (event) => {
  const connectionId = event.requestContext.connectionId;
  const routeKey = event.requestContext.routeKey;
  const userId = event.requestContext.authorizer?.userId || 'anonymous';
  const userName = event.requestContext.authorizer?.userName || userId;
  const documentId = event.queryStringParameters?.documentId || 'default';

  console.log('Connection event:', routeKey, connectionId, documentId);

  if (routeKey === '$connect') {
    await client.send(new PutItemCommand({
      TableName: process.env.CONNECTIONS_TABLE,
      Item: {
        connectionId: { S: connectionId },
        userId: { S: userId },
        userName: { S: userName },
        documentId: { S: documentId },
        connectedAt: { N: String(Date.now()) },
        expiresAt: { N: String(Math.floor(Date.now() / 1000) + 3600) }
      }
    }));
  } else if (routeKey === '$disconnect') {
    // Notify others that user left
    const existing = await client.send(new QueryCommand({
      TableName: process.env.CONNECTIONS_TABLE,
      IndexName: 'DocumentIdIndex',
      KeyConditionExpression: 'documentId = :docId',
      ExpressionAttributeValues: { ':docId': { S: documentId } }
    })).catch(() => ({ Items: [] }));

    const api = new ApiGatewayManagementApiClient({ endpoint: process.env.WEBSOCKET_ENDPOINT });
    await Promise.all((existing.Items || []).map(async (item) => {
      if (item.connectionId.S === connectionId) return;
      await api.send(new PostToConnectionCommand({
        ConnectionId: item.connectionId.S,
        Data: JSON.stringify({ action: 'awareness', type: 'leave', userId })
      })).catch(() => {});
    }));

    await client.send(new DeleteItemCommand({
      TableName: process.env.CONNECTIONS_TABLE,
      Key: { connectionId: { S: connectionId } }
    }));
  }
  return { statusCode: 200 };
};
