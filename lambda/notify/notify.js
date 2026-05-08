import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const wsClient = new ApiGatewayManagementApiClient({ endpoint: process.env.WEBSOCKET_ENDPOINT });

export const handler = async (event) => {
  const { detail, 'detail-type': detailType } = event;

  const message = JSON.stringify({ action: detailType, ...detail });

  // Always broadcast to the projectId channel (the frontend subscribes here,
  // and agent ECS also broadcasts directly to this same channel).
  const docIds = new Set();
  if (detail.projectId) docIds.add(detail.projectId);
  // Keep backward-compat: also broadcast to sprint-scoped channel
  if (detail.sprintId) docIds.add(`sprint:${detail.sprintId}`);

  for (const docId of docIds) {
    const connections = await ddb.send(new QueryCommand({
      TableName: process.env.CONNECTIONS_TABLE,
      IndexName: 'DocumentIdIndex',
      KeyConditionExpression: 'documentId = :docId',
      ExpressionAttributeValues: { ':docId': docId }
    }));

    await Promise.allSettled((connections.Items ?? []).map(item =>
      wsClient.send(new PostToConnectionCommand({
        ConnectionId: item.connectionId,
        Data: message
      }))
    ));
  }

  return { statusCode: 200 };
};
