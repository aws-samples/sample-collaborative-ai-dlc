import gremlin from 'gremlin';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { getUrlAndHeaders } from 'gremlin-aws-sigv4/lib/utils.js';
import { buildResponse } from '../shared/response.js';

const DriverRemoteConnection = gremlin.driver.DriverRemoteConnection;
const traversal = gremlin.process.AnonymousTraversalSource.traversal;
const __ = gremlin.process.statics;

const VALID_ROLES = ['owner', 'admin', 'member'];

// Permission check: owner or admin can manage members.
const canManageMembers = (role) => role === 'owner' || role === 'admin';

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

export const handler = async (event) => {
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

    // Helper: get the requesting user's role on this project (null if not a member)
    const getRequestingUserRole = async () => {
      const edges = await g
        .V()
        .has('Project', 'id', projectId)
        .outE('HAS_MEMBER')
        .as('e')
        .inV()
        .has('User', 'id', requestingUserId)
        .select('e')
        .by(__.valueMap())
        .toList();
      if (edges.length === 0) return null;
      return getVal(edges[0], 'role') || null;
    };

    switch (httpMethod) {
      case 'GET': {
        // Any project member can list members
        const role = await getRequestingUserRole();
        if (!role) return response(403, { error: 'Access denied' });

        const raw = await g
          .V()
          .has('Project', 'id', projectId)
          .outE('HAS_MEMBER')
          .as('e')
          .inV()
          .as('u')
          .select('e', 'u')
          .by(__.valueMap())
          .by(__.valueMap())
          .toList();

        // Convert Neptune Maps to clean serializable objects
        const members = raw.map((item) => {
          const edge = item instanceof Map ? item.get('e') : item.e;
          const vertex = item instanceof Map ? item.get('u') : item.u;
          return {
            userId: getVal(vertex, 'id'),
            email: getVal(vertex, 'email'),
            role: getVal(edge, 'role') || 'member',
          };
        });
        return response(200, members);
      }

      case 'POST': {
        // Owners and admins can add members
        const role = await getRequestingUserRole();
        if (!canManageMembers(role)) {
          return response(403, { error: 'Only project owners and admins can add members' });
        }
        const data = JSON.parse(body);
        if (!data.userId) {
          return response(400, { error: 'userId is required' });
        }

        // Validate role
        const newRole = data.role || 'member';
        if (!VALID_ROLES.includes(newRole)) {
          return response(400, {
            error: `Invalid role. Must be one of: ${VALID_ROLES.join(', ')}`,
          });
        }

        // Only owners can assign the owner role
        if (newRole === 'owner' && role !== 'owner') {
          return response(403, { error: 'Only owners can assign the owner role' });
        }

        // Admins cannot assign admin or owner roles - they can only add members
        if (role === 'admin' && newRole !== 'member') {
          return response(403, { error: 'Admins can only add members, not admins or owners' });
        }

        // Check if user is already a member
        const alreadyMember = await g
          .V()
          .has('Project', 'id', projectId)
          .outE('HAS_MEMBER')
          .inV()
          .has('User', 'id', data.userId)
          .hasNext();
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
        await g
          .V()
          .has('Project', 'id', projectId)
          .addE('HAS_MEMBER')
          .property('role', newRole)
          .to(__.V().has('User', 'id', data.userId))
          .next();
        return response(201, { projectId, userId: data.userId, role: newRole });
      }

      case 'PUT': {
        // Owners and admins can change roles (with restrictions)
        const role = await getRequestingUserRole();
        if (!canManageMembers(role)) {
          return response(403, { error: 'Only project owners and admins can change member roles' });
        }

        const data = JSON.parse(body);
        const newRole = data.role;

        // Validate role
        if (!newRole || !VALID_ROLES.includes(newRole)) {
          return response(400, {
            error: `Invalid role. Must be one of: ${VALID_ROLES.join(', ')}`,
          });
        }

        // Only owners can assign/change to owner role
        if (newRole === 'owner' && role !== 'owner') {
          return response(403, { error: 'Only owners can assign the owner role' });
        }

        // Admins cannot promote to admin or owner
        if (role === 'admin' && newRole !== 'member') {
          return response(403, { error: 'Admins can only set members to the member role' });
        }

        // Admins cannot change the role of owners or other admins
        if (role === 'admin') {
          const targetEdges = await g
            .V()
            .has('Project', 'id', projectId)
            .outE('HAS_MEMBER')
            .as('e')
            .inV()
            .has('User', 'id', targetUserId)
            .select('e')
            .by(__.valueMap())
            .toList();
          const targetRole = getVal(targetEdges[0], 'role') || 'member';
          if (targetRole === 'owner' || targetRole === 'admin') {
            return response(403, {
              error: 'Admins cannot change the role of owners or other admins',
            });
          }
        }

        // Prevent removing the last owner
        if (newRole !== 'owner') {
          const targetIsOwner = await g
            .V()
            .has('Project', 'id', projectId)
            .outE('HAS_MEMBER')
            .has('role', 'owner')
            .inV()
            .has('User', 'id', targetUserId)
            .hasNext();
          if (targetIsOwner) {
            const ownerCount = await g
              .V()
              .has('Project', 'id', projectId)
              .outE('HAS_MEMBER')
              .has('role', 'owner')
              .count()
              .next();
            if (ownerCount.value <= 1) {
              return response(400, {
                error: 'Cannot demote the last owner. Transfer ownership first.',
              });
            }
          }
        }

        await g
          .V()
          .has('Project', 'id', projectId)
          .outE('HAS_MEMBER')
          .where(__.inV().has('User', 'id', targetUserId))
          .property('role', newRole)
          .next();
        return response(200, { projectId, userId: targetUserId, role: newRole });
      }

      case 'DELETE': {
        // Owners and admins can remove members (with restrictions)
        const role = await getRequestingUserRole();
        if (!canManageMembers(role)) {
          return response(403, { error: 'Only project owners and admins can remove members' });
        }

        // Admins cannot remove owners or other admins
        if (role === 'admin') {
          const targetEdges = await g
            .V()
            .has('Project', 'id', projectId)
            .outE('HAS_MEMBER')
            .as('e')
            .inV()
            .has('User', 'id', targetUserId)
            .select('e')
            .by(__.valueMap())
            .toList();
          const targetRole = getVal(targetEdges[0], 'role') || 'member';
          if (targetRole === 'owner' || targetRole === 'admin') {
            return response(403, { error: 'Admins cannot remove owners or other admins' });
          }
        }

        // Prevent removing the last owner
        const targetIsOwner = await g
          .V()
          .has('Project', 'id', projectId)
          .outE('HAS_MEMBER')
          .has('role', 'owner')
          .inV()
          .has('User', 'id', targetUserId)
          .hasNext();
        if (targetIsOwner) {
          const ownerCount = await g
            .V()
            .has('Project', 'id', projectId)
            .outE('HAS_MEMBER')
            .has('role', 'owner')
            .count()
            .next();
          if (ownerCount.value <= 1) {
            return response(400, {
              error: 'Cannot remove the last owner. Transfer ownership first.',
            });
          }
        }

        await g
          .V()
          .has('Project', 'id', projectId)
          .outE('HAS_MEMBER')
          .where(__.inV().has('User', 'id', targetUserId))
          .drop()
          .next();
        return response(204, null);
      }

      default:
        return response(405, { error: 'Method not allowed' });
    }
  } catch (err) {
    console.error('Error:', err);
    return response(500, { error: 'Internal server error' });
  } finally {
    if (conn) {
      try {
        await conn.close();
      } catch (e) {
        console.error('Error closing connection:', e);
      }
    }
  }
};
