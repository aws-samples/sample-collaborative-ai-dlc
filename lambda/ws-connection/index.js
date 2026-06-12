import {
  DynamoDBClient,
  PutItemCommand,
  DeleteItemCommand,
  QueryCommand,
} from '@aws-sdk/client-dynamodb';
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from '@aws-sdk/client-apigatewaymanagementapi';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import {
  verifyRealtimeAccess,
  requiredScopeForChannel,
  isTokenLive,
} from '../shared/realtime-token.js';

const client = new DynamoDBClient();
const ssm = new SSMClient();

// Operational kill switch only (plan §4, D3): set to "false" to log-and-allow
// during an incident. Default is enforcing.
const docTokenEnforce = () => process.env.DOC_TOKEN_ENFORCE !== 'false';

// Doc-secret resolution: REALTIME_DOC_SECRET env wins (test seam / local),
// otherwise fetch the SSM SecureString named by REALTIME_SECRET_PARAM once
// per container and cache it.
let cachedSecret = null;
const getSecret = async () => {
  if (process.env.REALTIME_DOC_SECRET) return process.env.REALTIME_DOC_SECRET;
  if (cachedSecret) return cachedSecret;
  const paramName = process.env.REALTIME_SECRET_PARAM;
  if (!paramName) return '';
  const result = await ssm.send(new GetParameterCommand({ Name: paramName, WithDecryption: true }));
  cachedSecret = result.Parameter?.Value || '';
  return cachedSecret;
};

export const handler = async (event) => {
  const connectionId = event.requestContext.connectionId;
  const routeKey = event.requestContext.routeKey;
  const userId = event.requestContext.authorizer?.userId || 'anonymous';
  const userName = event.requestContext.authorizer?.userName || userId;
  const documentId = event.queryStringParameters?.documentId || 'default';

  console.log('Connection event:', routeKey, connectionId, documentId);

  if (routeKey === '$connect') {
    // Scope-token check (plan §4a): signature, expiry, scope coverage for the
    // requested documentId, and principal binding to the JWT-authenticated
    // user (the ws-authorizer puts the Cognito sub in `authorizer.userId`).
    // Unknown documentId formats are rejected (deny-by-default).
    const docToken = event.queryStringParameters?.docToken;
    const access = verifyRealtimeAccess({
      token: docToken,
      secret: await getSecret(),
      requiredScope: requiredScopeForChannel(documentId),
      sub: event.requestContext.authorizer?.userId,
    });
    if (!access.ok) {
      if (docTokenEnforce()) {
        console.warn(`$connect rejected: doc token ${access.reason} for document "${documentId}"`);
        return { statusCode: 403, body: 'Forbidden' };
      }
      console.warn(
        `$connect allowed despite doc token ${access.reason} for document "${documentId}" (DOC_TOKEN_ENFORCE=false)`,
      );
    }

    const item = {
      connectionId: { S: connectionId },
      userId: { S: userId },
      userName: { S: userName },
      documentId: { S: documentId },
      connectedAt: { N: String(Date.now()) },
      expiresAt: { N: String(Math.floor(Date.now() / 1000) + 3600) },
    };
    // Stored so every fan-out path (and the ws-message send path) can filter
    // out connections whose authorization has lapsed (plan §4a).
    if (access.ok) item.tokenExp = { N: String(access.payload.exp) };

    await client.send(
      new PutItemCommand({
        TableName: process.env.CONNECTIONS_TABLE,
        Item: item,
      }),
    );
  } else if (routeKey === '$disconnect') {
    // Notify others that user left
    const existing = await client
      .send(
        new QueryCommand({
          TableName: process.env.CONNECTIONS_TABLE,
          IndexName: 'DocumentIdIndex',
          KeyConditionExpression: 'documentId = :docId',
          ExpressionAttributeValues: { ':docId': { S: documentId } },
        }),
      )
      .catch(() => ({ Items: [] }));

    const api = new ApiGatewayManagementApiClient({ endpoint: process.env.WEBSOCKET_ENDPOINT });
    await Promise.all(
      (existing.Items || []).map(async (item) => {
        if (item.connectionId.S === connectionId) return;
        // Never target connections whose scope token has expired (plan §4a).
        if (!isTokenLive(item.tokenExp?.N)) return;
        await api
          .send(
            new PostToConnectionCommand({
              ConnectionId: item.connectionId.S,
              Data: JSON.stringify({ action: 'awareness', type: 'leave', userId }),
            }),
          )
          .catch(() => {});
      }),
    );

    await client.send(
      new DeleteItemCommand({
        TableName: process.env.CONNECTIONS_TABLE,
        Key: { connectionId: { S: connectionId } },
      }),
    );
  }
  return { statusCode: 200 };
};
