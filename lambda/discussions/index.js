import { create } from 'neptune-lambda-client';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { buildResponse } from '../shared/response.js';
import { fetchMembershipRole } from '../shared/trackers.js';
import { signRealtimeToken } from '../shared/realtime-token.js';

// lambda/discussions — sprint-scoped discussion threads (discussions plan).
//
// PR 1 scope: realtime scope-token issuance only (plan §4a).
//   POST /sprints/{sprintId}/realtime-token
//   POST /projects/{projectId}/realtime-token
//
// Both routes verify project membership (Project -HAS_MEMBER-> User) before
// minting a short-lived HMAC token that the Yjs server and ws-connection
// verify at connect time. Discussion CRUD/messages land in PR 2.

// Tests point GREMLIN_PROTOCOL at a plain ws:// gremlin-server (no IAM); Neptune
// in production is wss:// + SigV4. Tying useIam to the protocol keeps the test
// seam to a single env var that globalSetup already sets.
const protocol = process.env.GREMLIN_PROTOCOL ?? 'wss';

const { query, close } = create(process.env.NEPTUNE_ENDPOINT, process.env.GREMLIN_PORT ?? '8182', {
  useIam: protocol === 'wss',
  protocol,
  partition: process.env.GREMLIN_PARTITION
    ? {
        partitionKey: '_partition',
        writePartition: process.env.GREMLIN_PARTITION,
        readPartitions: [process.env.GREMLIN_PARTITION],
      }
    : undefined,
});

// Exported for test teardown only — production reuses the connection.
export { close };

const ssm = new SSMClient();

// Doc-secret resolution: REALTIME_DOC_SECRET env wins (test seam / local),
// otherwise fetch the SSM SecureString named by REALTIME_SECRET_PARAM once
// per container and cache it.
let cachedSecret = null;
const getSecret = async () => {
  if (process.env.REALTIME_DOC_SECRET) return process.env.REALTIME_DOC_SECRET;
  if (cachedSecret) return cachedSecret;
  const paramName = process.env.REALTIME_SECRET_PARAM;
  if (!paramName) throw new Error('REALTIME_SECRET_PARAM is not configured');
  const result = await ssm.send(new GetParameterCommand({ Name: paramName, WithDecryption: true }));
  cachedSecret = result.Parameter?.Value || '';
  if (!cachedSecret) throw new Error(`SSM parameter ${paramName} is empty`);
  return cachedSecret;
};

// Caller identity comes from the Cognito User Pools authorizer — clients
// cannot spoof it.
const getCaller = (event) => {
  const claims = event?.requestContext?.authorizer?.claims || {};
  return {
    sub: claims.sub || '',
    displayName: claims['custom:display_name'] || claims.email || '',
  };
};

// Resolve the project a sprint belongs to (Project -HAS_SPRINT-> Sprint).
const fetchProjectIdForSprint = async (g, sprintId) => {
  const r = await g
    .V()
    .has('Sprint', 'id', sprintId)
    .in_('HAS_SPRINT')
    .hasLabel('Project')
    .values('id')
    .next();
  return r.done ? null : r.value;
};

// POST /sprints/{sprintId}/realtime-token | POST /projects/{projectId}/realtime-token
//
// Issues a 10-minute HMAC scope token bound to the caller's Cognito sub
// (plan §4a). Sprint tokens carry both the sprint scope and the owning
// project scope so one token covers every doc/channel of the sprint's
// collaboration surface (incl. inception-{projectId}).
const issueRealtimeToken = async (event, res) => {
  const { sub } = getCaller(event);
  if (!sub) return res(401, { error: 'Unauthorized' });

  const { sprintId, projectId: pathProjectId } = event.pathParameters || {};

  let projectId = pathProjectId;
  let scopes;
  if (sprintId) {
    projectId = await query((g) => fetchProjectIdForSprint(g, sprintId));
    if (!projectId) return res(404, { error: 'Sprint not found' });
    scopes = [`sprint:${sprintId}`, `project:${projectId}`];
  } else if (pathProjectId) {
    scopes = [`project:${pathProjectId}`];
  } else {
    return res(400, { error: 'Missing sprintId or projectId' });
  }

  const role = await query((g) => fetchMembershipRole(g, projectId, sub));
  if (!role) return res(403, { error: 'Not a project member' });

  const secret = await getSecret();
  const { token, exp } = signRealtimeToken({ sub, scopes }, secret);
  return res(200, { token, exp, scopes });
};

export const handler = async (event) => {
  const res = buildResponse(event);
  if (event.httpMethod === 'OPTIONS') return res(200, {});

  try {
    const path = event.resource || event.path || '';

    if (event.httpMethod === 'POST' && path.endsWith('/realtime-token')) {
      return await issueRealtimeToken(event, res);
    }

    return res(404, { error: 'Not found' });
  } catch (err) {
    console.error('discussions handler error:', err);
    return res(500, { error: 'Internal server error' });
  }
};
