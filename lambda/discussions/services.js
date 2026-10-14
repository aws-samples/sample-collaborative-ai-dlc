// lambda/discussions — cross-cutting services: sprint authorization, server-
// driven WebSocket fan-out, and realtime doc-secret resolution.

import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from '@aws-sdk/client-apigatewaymanagementapi';
import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { GetParameterCommand } from '@aws-sdk/client-ssm';
import { InvokeAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore';
import { createHash } from 'node:crypto';
import { Logger } from '@aws-lambda-powertools/logger';
import { isTokenLive } from '../shared/realtime-token.js';
import { runtimeTargetInput } from '../shared/runtime-target.js';
import { fetchMembershipRole } from '../shared/trackers.js';
import { nativeRuntimeBindingKey } from '../shared/native-runtime-binding.js';
import { resolveNativeCollaborationAccess } from '../shared/native-realtime-ownership.js';
import { fetchWorkflowSourceMembership } from '../shared/workflow-source-membership.js';
import { agentcore, ddb, ssm, s3, query } from './clients.js';
import { createNativePublications } from '../shared/native-publication.js';
import { createNativeArtifactRevisions } from '../shared/native-artifact-revision.js';
import { fetchProjectIdForSprint, fetchProjectIdForIntent } from './data-access.js';

const logger = new Logger({ persistentKeys: { component: 'discussions' } });

// ─── Authorization ───

// Every route resolves the caller's role once, generically over the scope's root
// (Sprint or Intent). Returns { res } with an error response, or { projectId, role }.
export const authorizeScope = async (scope, sub, res) => {
  if (!sub) return { res: res(401, { error: 'Unauthorized' }) };
  if (!scope) return { res: res(404, { error: 'Not found' }) };
  if (scope.kind === 'native') return authorizeNativeScope(scope, sub, res);
  // A platform route must never reach a protected native execution through the
  // path-project fallback below (native IDs are only unique per project).
  if (scope.kind === 'intent' && scope.projectId && (await nativeRecordExists(scope))) {
    return { res: res(404, { error: scope.notFoundError }) };
  }
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

const nativeTable = () => process.env.NATIVE_RUNTIME_BINDINGS_TABLE || '';

const nativeRecordExists = async (scope) => {
  if (!nativeTable()) return false;
  let key;
  try {
    key = nativeRuntimeBindingKey({ projectId: scope.projectId, executionId: scope.rootId });
  } catch {
    return false;
  }
  for (const sk of ['EXECUTION', 'RUNTIME']) {
    const { Item } = await ddb.send(
      new GetCommand({ TableName: nativeTable(), Key: { ...key, sk }, ConsistentRead: true }),
    );
    if (Item) return true;
  }
  return false;
};

// Native threads: current membership snapshot plus the protected binding. The
// resolved `native` access (binding + execution rows) is returned for anchor
// verification and Quorum context; it never confers execution authority.
const authorizeNativeScope = async (scope, sub, res) => {
  let access;
  try {
    access = await resolveNativeCollaborationAccess({
      ddb,
      nativeTable: nativeTable(),
      projectId: scope.projectId,
      executionId: scope.executionId,
      membership: () => query((g) => fetchWorkflowSourceMembership(g, scope.projectId, sub)),
    });
  } catch (err) {
    if (err?.code === 'WORKFLOW_SOURCE_FORBIDDEN') {
      return { res: res(403, { error: 'Not a project member' }) };
    }
    throw err;
  }
  if (access.status === 403) return { res: res(403, { error: 'Not a project member' }) };
  if (access.status !== 200) return { res: res(404, { error: scope.notFoundError }) };
  return { projectId: scope.projectId, role: access.member.role, native: access };
};

export const recheckNativeScope = async (scope, sub, before, res) => {
  if (scope.kind !== 'native') return null;
  const after = await authorizeNativeScope(scope, sub, res);
  if (after.res) return after.res;
  if (
    after.native.member.membershipId !== before.native.member.membershipId ||
    after.native.member.projectIdentity !== before.native.member.projectIdentity ||
    after.native.binding.bindingId !== before.native.binding.bindingId
  )
    return res(403, { error: 'Native discussion access changed' });
  return null;
};

// Back-compat shim: the sprint-scoped callers still pass a bare sprintId.
export const authorizeSprint = async (sprintId, sub, res) => {
  if (!sprintId) return { res: res(404, { error: 'Sprint not found' }) };
  const { sprintScope } = await import('./scope.js');
  return authorizeScope(sprintScope(sprintId), sub, res);
};

// Verified native revision reads (discussion anchors and Quorum context),
// constructed lazily: platform-only deployments never configure the bucket.
let revisions = null;
export const nativeArtifactRevisions = () => {
  if (revisions) return revisions;
  revisions = createNativeArtifactRevisions({
    ddb,
    nativeTable: nativeTable(),
    publications: createNativePublications({
      s3: s3(),
      bucket: process.env.NATIVE_EXECUTION_PUBLICATION_BUCKET,
      accountId: process.env.NATIVE_RUNTIME_ACCOUNT_ID,
    }),
  });
  return revisions;
};
export const resetNativeArtifactRevisionsForTest = () => {
  revisions = null;
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
    logger.error('WS fanout failed', err);
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
    logger.error('Mention notification failed', err);
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

const discussionRuntimeTargetFor = async (intentId, fallbackRuntimeArn) => {
  const processTable = process.env.V2_PROCESS_TABLE;
  if (!processTable) throw new Error('V2_PROCESS_TABLE is not configured');
  // A missing/failed read cannot establish whether this is a platform or
  // isolated native execution. Do not dispatch its data to the shared runtime.
  const { Item: meta } = await ddb.send(
    new GetCommand({
      TableName: processTable,
      Key: { pk: `EXEC#${intentId}`, sk: 'META' },
      ConsistentRead: true,
    }),
  );
  if (!meta) {
    throw Object.assign(new Error('Discussion intent runtime snapshot is missing'), {
      code: 'execution_runtime_snapshot_missing',
    });
  }
  return runtimeTargetInput(meta, fallbackRuntimeArn);
};

export const invokeDiscussionAssist = async ({ intentId, payload }) => {
  const fallbackRuntimeArn = process.env.AGENTCORE_RUNTIME_ARN || '';
  const target = await discussionRuntimeTargetFor(intentId, fallbackRuntimeArn);
  if (!target.agentRuntimeArn) throw new Error('AGENTCORE_RUNTIME_ARN is not configured');
  const res = await agentcore.send(
    new InvokeAgentRuntimeCommand({
      ...target,
      runtimeSessionId: discussionSessionIdFor(intentId, payload.discussionId),
      contentType: 'application/json',
      accept: 'application/json',
      payload: Buffer.from(JSON.stringify(payload)),
    }),
  );
  const text = res.response ? await res.response.transformToString() : '';
  return text ? JSON.parse(text) : {};
};

// Native Quorum is advisory: it runs in the shared platform discussion runtime,
// never in the isolated native writer, and receives only the verified context
// in its payload. Native records never select this target.
const nativeDiscussionSessionIdFor = (rootId, discussionId) =>
  `aidlc-discuss-native-${createHash('sha256')
    .update(JSON.stringify([rootId, discussionId]))
    .digest('hex')}`;

export const invokeNativeDiscussionAssist = async ({ scope, payload }) => {
  const agentRuntimeArn = process.env.AGENTCORE_RUNTIME_ARN || '';
  if (!agentRuntimeArn) throw new Error('AGENTCORE_RUNTIME_ARN is not configured');
  const res = await agentcore.send(
    new InvokeAgentRuntimeCommand({
      agentRuntimeArn,
      runtimeSessionId: nativeDiscussionSessionIdFor(scope.rootId, payload.discussionId),
      contentType: 'application/json',
      accept: 'application/json',
      payload: Buffer.from(JSON.stringify(payload)),
    }),
  );
  const text = res.response ? await res.response.transformToString() : '';
  return text ? JSON.parse(text) : {};
};

export { discussionSessionIdFor, nativeDiscussionSessionIdFor };
