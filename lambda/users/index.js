import gremlin from 'gremlin';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { getUrlAndHeaders } from 'gremlin-aws-sigv4/lib/utils.js';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { buildResponse } from '../shared/response.js';
import { logSafeEventIfEnabled } from '../shared/safe-event-logger.js';
import { invalidateTrackerBindingsByDelegator } from '../shared/tracker-binding-delegation.js';
import { invalidateProjectBindingsByDelegator } from '../shared/source-control-bindings.js';
import {
  assertOwnerChangeAllowed,
  getMembership,
  getMembershipRole,
  listSpaceMembers,
  normalizeMembershipRole,
  removeMembership,
  saveMembershipChange,
} from '../shared/space-membership.js';
import { Logger } from '@aws-lambda-powertools/logger';

const DriverRemoteConnection = gremlin.driver.DriverRemoteConnection;
const traversal = gremlin.process.AnonymousTraversalSource.traversal;
const __ = gremlin.process.statics;
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const logger = new Logger({ persistentKeys: { component: 'users' } });

const VALID_ROLES = ['owner', 'member'];

const canManageMembers = (role) => role === 'owner';

const getVal = (obj, key) => {
  if (!obj) return '';
  const raw = obj instanceof Map ? obj.get(key) : obj[key];
  if (Array.isArray(raw)) return raw[0] ?? '';
  return raw ?? '';
};

const getConnection = async () => {
  const host = process.env.NEPTUNE_ENDPOINT;
  const port = '8182';
  const region = process.env.AWS_REGION || 'us-east-1';

  const credentials = await fromNodeProviderChain()();
  credentials.region = region;

  const connInfo = getUrlAndHeaders(host, port, credentials, '/gremlin', 'wss');

  return new DriverRemoteConnection(connInfo.url, { headers: connInfo.headers });
};

export const handler = async (event, context) => {
  if (context) logger.addContext(context);
  logSafeEventIfEnabled(logger, event);
  const response = buildResponse(event);
  if (event.httpMethod === 'OPTIONS') {
    return response(200, {});
  }

  let conn;
  try {
    conn = await getConnection();
    const g = traversal().withRemote(conn);

    const { httpMethod, pathParameters, body } = event;
    const { projectId, userId: targetUserId } = pathParameters || {};
    const requestingUserId = event.requestContext?.authorizer?.claims?.sub;

    if (!requestingUserId) return response(401, { error: 'Unauthorized' });

    const projectExists = async () => g.V().has('Project', 'id', projectId).hasNext();
    const getRequestingUserRole = async () => getMembershipRole(ddb, projectId, requestingUserId);

    switch (httpMethod) {
      case 'GET': {
        // Any project member can list members
        const role = await getRequestingUserRole();
        if (!role) return response(403, { error: 'Access denied' });

        if (!(await projectExists())) return response(404, { error: 'Project not found' });
        const page = await listSpaceMembers(ddb, projectId, {
          token: event.queryStringParameters?.nextToken,
        });
        const members = await Promise.all(
          page.items.map(async (membership) => {
            const vertex = (await g.V().has('User', 'id', membership.userId).valueMap().next())
              .value;
            return {
              userId: membership.userId,
              email: getVal(vertex, 'email'),
              role: membership.membershipRole,
            };
          }),
        );
        return response(200, { members, nextToken: page.nextToken });
      }

      case 'POST': {
        // Every Space Owner can add members.
        const role = await getRequestingUserRole();
        if (!canManageMembers(role)) {
          return response(403, { error: 'Only space owners can add members' });
        }
        const data = JSON.parse(body);
        if (!data.userId) {
          return response(400, { error: 'userId is required' });
        }

        // Validate role
        let newRole;
        try {
          newRole = normalizeMembershipRole(data.role || 'member');
        } catch {
          return response(400, {
            error: `Invalid role. Must be one of: ${VALID_ROLES.join(', ')}`,
          });
        }

        // Check if user is already a member
        const alreadyMember = await getMembership(ddb, projectId, data.userId);
        if (alreadyMember) {
          return response(409, { error: 'User is already a member of this project' });
        }

        const userExists = await g.V().has('User', 'id', data.userId).hasNext();
        if (!userExists) {
          await g
            .addV('User')
            .property('id', data.userId)
            .property('email', data.email || '')
            .next();
        }
        await saveMembershipChange(ddb, {
          spaceId: projectId,
          actorId: requestingUserId,
          targetUserId: data.userId,
          role: newRole,
        });
        return response(201, { projectId, userId: data.userId, role: newRole });
      }

      case 'PUT': {
        // Every Space Owner can change roles.
        const role = await getRequestingUserRole();
        if (!canManageMembers(role)) {
          return response(403, { error: 'Only space owners can change member roles' });
        }

        const data = JSON.parse(body);
        let newRole;
        try {
          newRole = normalizeMembershipRole(data.role);
        } catch {
          return response(400, {
            error: `Invalid role. Must be one of: ${VALID_ROLES.join(', ')}`,
          });
        }
        const before = await getMembership(ddb, projectId, targetUserId);
        if (!before) return response(404, { error: 'Member not found' });
        await saveMembershipChange(ddb, {
          spaceId: projectId,
          actorId: requestingUserId,
          targetUserId,
          role: newRole,
          before,
        });
        return response(200, { projectId, userId: targetUserId, role: newRole });
      }

      case 'DELETE': {
        // Every Space Owner can remove members.
        const role = await getRequestingUserRole();
        if (!canManageMembers(role)) {
          return response(403, { error: 'Only space owners can remove members' });
        }
        const before = await getMembership(ddb, projectId, targetUserId);
        if (!before) return response(404, { error: 'Member not found' });
        await assertOwnerChangeAllowed(ddb, projectId, targetUserId, before, null);

        await invalidateTrackerBindingsByDelegator(g, targetUserId, 'delegator_removed', projectId);
        await invalidateProjectBindingsByDelegator(
          ddb,
          projectId,
          targetUserId,
          'delegator_removed',
          { actor: requestingUserId },
        );
        await removeMembership(ddb, {
          spaceId: projectId,
          actorId: requestingUserId,
          targetUserId,
          before,
        });
        return response(204, null);
      }

      default:
        return response(405, { error: 'Method not allowed' });
    }
  } catch (err) {
    if (err?.code === 'LAST_OWNER') return response(409, { error: err.message });
    logger.error('Unhandled error', err);
    return response(500, { error: 'Internal server error' });
  } finally {
    if (conn) {
      try {
        await conn.close();
      } catch (e) {
        logger.error('Error closing connection', e);
      }
    }
  }
};
