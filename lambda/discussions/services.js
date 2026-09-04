// lambda/discussions — cross-cutting services: sprint authorization, server-
// driven WebSocket fan-out, and realtime doc-secret resolution.

import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from '@aws-sdk/client-apigatewaymanagementapi';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { GetParameterCommand } from '@aws-sdk/client-ssm';
import { InvokeAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore';
import { isTokenLive } from '../shared/realtime-token.js';
import { fetchMembershipRole } from '../shared/trackers.js';
import { agentcore, ddb, ssm, query } from './clients.js';
import { fetchProjectIdForSprint, fetchProjectIdForIntent } from './data-access.js';

// ─── Authorization ───

// Every route resolves the caller's role once, generically over the scope's root
// (Sprint or Intent). Returns { res } with an error response, or { projectId, role }.
export const authorizeScope = async (scope, sub, res) => {
  if (!sub) return { res: res(401, { error: 'Unauthorized' }) };
  if (!scope) return { res: res(404, { error: 'Not found' }) };
  const projectId =
    scope.kind === 'intent'
      ? // The intent path carries projectId from the route, but verify the Intent
        // actually belongs to it (defends against scope confusion); fall back to
        // the graph when the intent vertex exists.
        (await query((g) => fetchProjectIdForIntent(g, scope.rootId))) || scope.projectId
      : await query((g) => fetchProjectIdForSprint(g, scope.rootId));
  if (!projectId) return { res: res(404, { error: scope.notFoundError }) };
  const role = await query((g) => fetchMembershipRole(g, projectId, sub));
  if (!role) return { res: res(403, { error: 'Not a project member' }) };
  return { projectId, role };
};

// Back-compat shim: the sprint-scoped callers still pass a bare sprintId.
export const authorizeSprint = async (sprintId, sub, res) => {
  if (!sprintId) return { res: res(404, { error: 'Sprint not found' }) };
  const { sprintScope } = await import('./scope.js');
  return authorizeScope(sprintScope(sprintId), sub, res);
};

// ─── WebSocket fanout (server-driven) ───

// Fan a payload out to every live connection subscribed to the scope's channel
// (`sprint:<id>` or `intent:<id>`).
export const broadcastToScope = async (scope, payload) => {
  const connectionsTable = process.env.CONNECTIONS_TABLE;
  const websocketEndpoint = process.env.WEBSOCKET_ENDPOINT;
  if (!connectionsTable || !websocketEndpoint) return;
  try {
    const result = await ddb.send(
      new QueryCommand({
        TableName: connectionsTable,
        IndexName: 'DocumentIdIndex',
        KeyConditionExpression: 'documentId = :docId',
        ExpressionAttributeValues: { ':docId': scope.channel },
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
    // Fanout is best-effort — persistence already succeeded; clients have the
    // change-delta reconciliation backstop.
    console.error('WS fanout failed:', err.message);
  }
};

// Per-user delivery for mention notifications (online, in-app only) —
// every live connection of the mentioned user, via UserIdIndex.
export const broadcastToUser = async (userId, payload) => {
  const connectionsTable = process.env.CONNECTIONS_TABLE;
  const websocketEndpoint = process.env.WEBSOCKET_ENDPOINT;
  if (!connectionsTable || !websocketEndpoint) return;
  try {
    const result = await ddb.send(
      new QueryCommand({
        TableName: connectionsTable,
        IndexName: 'UserIdIndex',
        KeyConditionExpression: 'userId = :uid',
        ExpressionAttributeValues: { ':uid': userId },
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
    console.error('Mention notification failed:', err.message);
  }
};

// ─── Realtime token issuance ───

// Doc-secret resolution: REALTIME_DOC_SECRET env wins (test seam / local),
// otherwise fetch the SSM SecureString named by REALTIME_SECRET_PARAM once
// per container and cache it.
let cachedSecret = null;
export const getSecret = async () => {
  if (process.env.REALTIME_DOC_SECRET) return process.env.REALTIME_DOC_SECRET;
  if (cachedSecret) return cachedSecret;
  const paramName = process.env.REALTIME_SECRET_PARAM;
  if (!paramName) throw new Error('REALTIME_SECRET_PARAM is not configured');
  const result = await ssm.send(new GetParameterCommand({ Name: paramName, WithDecryption: true }));
  cachedSecret = result.Parameter?.Value || '';
  if (!cachedSecret) throw new Error(`SSM parameter ${paramName} is empty`);
  return cachedSecret;
};

const discussionSessionIdFor = (intentId, discussionId) =>
  `aidlc-discuss-${intentId}-${discussionId}`.padEnd(33, '0');

export const invokeDiscussionAssist = async ({ intentId, payload }) => {
  const runtimeArn = process.env.AGENTCORE_RUNTIME_ARN || '';
  if (!runtimeArn) throw new Error('AGENTCORE_RUNTIME_ARN is not configured');
  const res = await agentcore.send(
    new InvokeAgentRuntimeCommand({
      agentRuntimeArn: runtimeArn,
      runtimeSessionId: discussionSessionIdFor(intentId, payload.discussionId),
      contentType: 'application/json',
      accept: 'application/json',
      payload: Buffer.from(JSON.stringify(payload)),
    }),
  );
  const text = res.response ? await res.response.transformToString() : '';
  return text ? JSON.parse(text) : {};
};

export { discussionSessionIdFor };
