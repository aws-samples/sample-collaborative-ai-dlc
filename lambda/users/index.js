import gremlin from 'gremlin';
import {
  BUSINESS_ROLES,
  combineMemberRoles,
  computeSsoBusinessRoles,
} from '../shared/business-roles.js';
import { evaluateSsoRoles, parseRoleConfig } from '../shared/sso-roles.js';
import { PartitionStrategy } from 'gremlin/lib/process/traversal-strategy.js';
import {
  CognitoIdentityProviderClient,
  ListUsersCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import {
  membershipStore,
  fetchMembershipRole,
  normalizeMembershipRole,
} from '../shared/space-membership.js';
import { getVal } from '../shared/trackers.js';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { getUrlAndHeaders } from 'gremlin-aws-sigv4/lib/utils.js';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { buildResponse } from '../shared/response.js';
import { logSafeEventIfEnabled } from '../shared/safe-event-logger.js';
import { invalidateTrackerBindingsByDelegator } from '../shared/tracker-binding-delegation.js';
import { invalidateProjectBindingsByDelegator } from '../shared/source-control-bindings.js';
import { Logger } from '@aws-lambda-powertools/logger';

const DriverRemoteConnection = gremlin.driver.DriverRemoteConnection;
const traversal = gremlin.process.AnonymousTraversalSource.traversal;
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const cognito = new CognitoIdentityProviderClient({});

const attrsToMap = (attributes = []) => {
  const attrs = {};
  for (const attribute of attributes) attrs[attribute.Name] = attribute.Value;
  return attrs;
};

const requireUserPool = () => {
  const userPoolId = process.env.COGNITO_USER_POOL_ID;
  if (!userPoolId) throw new Error('User pool not configured');
  return userPoolId;
};

// One targeted lookup per requested member (covers offline members), so member
// pages never depend on the size of the rest of the directory.
const getAttrsForSub = async (userId) => {
  const result = await cognito.send(
    new ListUsersCommand({
      UserPoolId: requireUserPool(),
      Limit: 1,
      Filter: `sub = "${String(userId).replaceAll('"', '')}"`,
    }),
  );
  return attrsToMap(result.Users?.[0]?.Attributes);
};

// SSO business roles come from trusted Cognito attributes plus the saved
// mapping for the member's provider. Identity and mapping reads are memoized
// across members within one request; read failures propagate as errors instead
// of degrading to empty role lists.
const createSsoRoleResolver = () => {
  const config = parseRoleConfig();
  const ssoEnabled = Object.keys(config.providers || {}).length > 0;
  const mappings = new Map();
  const attributes = new Map();
  const mappingFor = async (providerId) => {
    if (!mappings.has(providerId)) {
      mappings.set(providerId, await membershipStore.getRoleMappings(providerId));
    }
    return mappings.get(providerId);
  };
  const forUser = async (userId) => {
    if (!ssoEnabled) return [];
    if (!attributes.has(userId)) attributes.set(userId, await getAttrsForSub(userId));
    const result = evaluateSsoRoles(attributes.get(userId) || {}, config);
    if (!result.federated || !result.admitted) return [];
    return computeSsoBusinessRoles(
      result.claimValues,
      await mappingFor(result.identity.providerName),
    );
  };
  return {
    forUser,
    forMembers: async (userIds) => {
      const roles = new Map();
      for (const id of userIds) roles.set(id, await forUser(id));
      return roles;
    },
  };
};

const memberRoleView = (member, ssoRoles = []) => ({
  userId: member.userId,
  role: member.membershipRole,
  localRoles: member.localRoles || [],
  excludedRoles: member.excludedRoles || [],
  ssoRoles,
  effectiveRoles: combineMemberRoles({
    ssoRoles,
    localRoles: member.localRoles || [],
    excludedRoles: member.excludedRoles || [],
  }),
});

const logger = new Logger({ persistentKeys: { component: 'users' } });

const getConnection = async () => {
  const host = process.env.NEPTUNE_ENDPOINT;
  const port = process.env.GREMLIN_PORT || '8182';
  if (process.env.GREMLIN_PROTOCOL === 'ws')
    return new DriverRemoteConnection(`ws://${host}:${port}/gremlin`);
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
    let g = traversal().withRemote(conn);
    if (process.env.GREMLIN_PARTITION) {
      g = g.withStrategies(
        new PartitionStrategy({
          partitionKey: '_partition',
          writePartition: process.env.GREMLIN_PARTITION,
          readPartitions: [process.env.GREMLIN_PARTITION],
        }),
      );
    }
    const { httpMethod, pathParameters, body } = event;
    const { projectId, userId: targetUserId } = pathParameters || {};
    const actorId = event.requestContext?.authorizer?.claims?.sub;
    if (!actorId) return response(401, { error: 'Unauthorized' });
    const actorRole = await fetchMembershipRole(g, projectId, actorId);
    if (!actorRole) return response(403, { error: 'Access denied' });

    const route = event.resource || event.path || '';
    const businessRolesRoute = route.endsWith('/business-roles');
    const excludedRolesRoute = route.endsWith('/excluded-roles');
    const historyRoute = route.endsWith('/membership-history');
    if (historyRoute) {
      if (httpMethod !== 'GET') return response(405, { error: 'Method not allowed' });
      const { from, to, nextToken } = event.queryStringParameters || {};
      return response(
        200,
        await membershipStore.listHistory(projectId, { from, to, token: nextToken }),
      );
    }
    if (businessRolesRoute && httpMethod === 'GET' && !targetUserId) {
      return response(200, BUSINESS_ROLES);
    }
    if ((businessRolesRoute || excludedRolesRoute) && (httpMethod !== 'PUT' || !targetUserId))
      return response(405, { error: 'Method not allowed' });

    if (httpMethod === 'GET') {
      const params = event.queryStringParameters || {};
      const paged = params.paged === '1';
      const resolver = createSsoRoleResolver();
      const members = [];
      let nextToken = paged ? params.nextToken : undefined;
      do {
        const page = await membershipStore.listMembers(projectId, nextToken);
        const ssoRoles = await resolver.forMembers(page.items.map((member) => member.userId));
        members.push(
          ...(await Promise.all(
            page.items.map(async (member) => {
              const user = await g.V().has('User', 'id', member.userId).valueMap('email').next();
              return {
                email: getVal(user.value, 'email'),
                ...memberRoleView(member, ssoRoles.get(member.userId)),
              };
            }),
          )),
        );
        nextToken = page.nextToken;
        if (paged) return response(200, { items: members, nextToken });
      } while (nextToken);
      return response(200, members);
    }
    if (!['POST', 'PUT', 'DELETE'].includes(httpMethod))
      return response(405, { error: 'Method not allowed' });
    if (actorRole !== 'owner') return response(403, { error: 'Space Owner access required' });
    let data = {};
    if (httpMethod !== 'DELETE') {
      try {
        data = JSON.parse(body || '{}');
      } catch {
        return response(400, { error: 'Invalid JSON body' });
      }
      if (!data || typeof data !== 'object' || Array.isArray(data))
        return response(400, { error: 'Invalid JSON body' });
    }
    const userId = httpMethod === 'POST' ? data.userId : targetUserId;
    if (typeof userId !== 'string' || !userId.trim())
      return response(400, { error: 'userId is required' });
    if (businessRolesRoute) {
      // Resolve SSO roles before the fenced write: a failed lookup must surface
      // as an error without having committed the role change.
      const ssoRoles = await createSsoRoleResolver().forUser(userId);
      const member = await membershipStore.changeLocalRoles({
        spaceId: projectId,
        userId,
        actorId,
        localRoles: data.localRoles,
      });
      return response(200, { projectId, ...memberRoleView(member, ssoRoles) });
    }
    if (excludedRolesRoute) {
      // New exclusions must target roles the member currently inherits through
      // SSO, so the inherited list is resolved before the fenced write.
      const ssoRoles = await createSsoRoleResolver().forUser(userId);
      const member = await membershipStore.changeExcludedRoles({
        spaceId: projectId,
        userId,
        actorId,
        excludedRoles: data.excludedRoles,
        inheritedSsoRoles: ssoRoles,
      });
      return response(200, { projectId, ...memberRoleView(member, ssoRoles) });
    }
    const role =
      httpMethod === 'DELETE'
        ? null
        : normalizeMembershipRole(data.role || (httpMethod === 'POST' ? 'member' : undefined));
    if (role !== null && !['owner', 'member'].includes(role))
      return response(400, { error: 'Invalid role. Must be owner or member' });
    const before = await membershipStore.get(projectId, userId);
    if (httpMethod === 'POST' && before)
      return response(409, { error: 'User is already a member of this space' });
    if (httpMethod !== 'POST' && !before) return response(404, { error: 'Member not found' });
    if (
      before?.membershipRole === 'owner' &&
      role !== 'owner' &&
      !(await membershipStore.hasOtherOwner(projectId, userId))
    ) {
      return response(400, {
        error: 'Cannot remove or demote the last owner. Transfer ownership first.',
      });
    }
    if (httpMethod === 'POST') {
      const userExists = await g.V().has('User', 'id', userId).hasNext();
      if (!userExists)
        await g
          .addV('User')
          .property('id', userId)
          .property('email', data.email || '')
          .next();
    }
    if (httpMethod === 'DELETE') {
      await invalidateTrackerBindingsByDelegator(g, userId, 'delegator_removed', projectId);
      await invalidateProjectBindingsByDelegator(ddb, projectId, userId, 'delegator_removed', {
        actor: actorId,
      });
    }
    await membershipStore.change({
      spaceId: projectId,
      userId,
      actorId,
      role,
      before,
      action: { POST: 'member-added', PUT: 'role-changed', DELETE: 'member-removed' }[httpMethod],
    });
    return httpMethod === 'DELETE'
      ? response(204, null)
      : response(httpMethod === 'POST' ? 201 : 200, { projectId, userId, role });
  } catch (err) {
    logger.error('Unhandled error', err);
    return response(err.statusCode || 500, {
      error: err.statusCode ? err.message : 'Internal server error',
    });
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
