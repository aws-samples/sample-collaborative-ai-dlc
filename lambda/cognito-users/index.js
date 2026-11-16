// Cognito user directory + platform-admin role management.
//
// Routes:
//   GET /users
//     Any authenticated user — the user directory backing member pickers.
//   GET /admin/users
//     Platform-admin only — the directory plus each user's Cognito username
//     and whether they hold the `platform-admin` group.
//   PUT /admin/users/{username}/platform-admin   body: { isAdmin: boolean }
//     Platform-admin only — grants/revokes the `platform-admin` group.
//     Self-demotion is rejected so an admin can never lock the platform out
//     of its last administrator by accident.
//   GET /admin/sso-mappings
//     Platform-admin only — configured SSO connections with their source
//     attribute and saved business-role mappings, plus the role catalog.
//   PUT /admin/sso-mappings/{providerId}   body: { roleMappings: { roleId: [values] } }
//     Platform-admin only — saves the mapping and its audit entry in one
//     transaction. The next role calculation uses it without a deployment.
//
// Group membership rides on the ID token, so a change takes effect when the
// affected user's token refreshes (typically at next sign-in).
import {
  CognitoIdentityProviderClient,
  ListUsersCommand,
  ListUsersInGroupCommand,
  AdminGetUserCommand,
  AdminAddUserToGroupCommand,
  AdminRemoveUserFromGroupCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { buildResponse } from '../shared/response.js';
import { logSafeEventIfEnabled } from '../shared/safe-event-logger.js';
import { requirePlatformAdmin, PLATFORM_ADMIN_GROUP } from '../shared/authz.js';
import { evaluateSsoRoles, parseRoleConfig } from '../shared/sso-roles.js';
import { BUSINESS_ROLES, businessRoleMappingView } from '../shared/business-roles.js';
import { membershipStore } from '../shared/space-membership.js';
import { Logger } from '@aws-lambda-powertools/logger';

const client = new CognitoIdentityProviderClient({});

const logger = new Logger({ persistentKeys: { component: 'cognito-users' } });

const attrsToMap = (attributes = []) => {
  const attrs = {};
  for (const a of attributes) attrs[a.Name] = a.Value;
  return attrs;
};

const identityDetails = (attrs) => {
  const result = evaluateSsoRoles(attrs, parseRoleConfig());
  return {
    identitySource: result.federated ? 'sso' : 'cognito',
    identityProvider: result.identity?.providerName || null,
    mappedRoles: result.federated ? result.roles : [],
    roleManagedExternally: result.federated,
    accessGranted: result.admitted,
  };
};

const isAssignableDirectoryUser = (user) =>
  user.enabled &&
  user.accessGranted &&
  (user.identitySource === 'sso' || user.status === 'CONFIRMED');

const listAllUsers = async (userPoolId) => {
  const users = [];
  let paginationToken;
  do {
    const result = await client.send(
      new ListUsersCommand({ UserPoolId: userPoolId, Limit: 60, PaginationToken: paginationToken }),
    );
    for (const u of result.Users || []) {
      const attrs = attrsToMap(u.Attributes);
      users.push({
        userId: attrs.sub,
        username: u.Username,
        email: attrs.email || '',
        displayName: attrs['custom:display_name'] || '',
        enabled: u.Enabled,
        status: u.UserStatus,
        ...identityDetails(attrs),
      });
    }
    paginationToken = result.PaginationToken;
  } while (paginationToken);
  return users;
};

// Usernames of every member of the platform-admin group. One paginated group
// listing instead of N AdminListGroupsForUser calls.
const listPlatformAdminUsernames = async (userPoolId) => {
  const usernames = new Set();
  let nextToken;
  do {
    const result = await client.send(
      new ListUsersInGroupCommand({
        UserPoolId: userPoolId,
        GroupName: PLATFORM_ADMIN_GROUP,
        Limit: 60,
        NextToken: nextToken,
      }),
    );
    for (const u of result.Users || []) usernames.add(u.Username);
    nextToken = result.NextToken;
  } while (nextToken);
  return usernames;
};

export const handler = async (event, context) => {
  if (context) logger.addContext(context);
  logSafeEventIfEnabled(logger, event);
  const response = buildResponse(event, { methods: 'GET,PUT,OPTIONS' });
  if (event.httpMethod === 'OPTIONS') {
    return response(200, {});
  }

  const claims = event.requestContext?.authorizer?.claims || {};
  const requestingUserId = claims.sub;
  if (!requestingUserId) {
    return response(401, { error: 'Unauthorized' });
  }

  const userPoolId = process.env.COGNITO_USER_POOL_ID;
  if (!userPoolId) {
    return response(500, { error: 'User pool not configured' });
  }

  const path = event.path || '';
  const isAdminRoute = path.includes('/admin/users');
  const isSsoMappingsRoute = path.includes('/admin/sso-mappings');

  try {
    // ── Platform-admin: SSO business-role mappings ────────────────────────
    if (isSsoMappingsRoute) {
      const denied = requirePlatformAdmin(event);
      if (denied) return response(denied.statusCode, { error: denied.error, code: denied.code });

      const config = parseRoleConfig();
      const providerEntries = Object.entries(config.providers || {});

      if (event.httpMethod === 'GET') {
        const providers = await Promise.all(
          providerEntries.map(async ([providerId, provider]) => {
            const saved = await membershipStore.getRoleMappingRecord(providerId);
            return {
              providerId,
              displayName: provider.displayName || providerId,
              sourceAttribute: provider.roleClaim || '',
              revision: saved.revision,
              ...businessRoleMappingView(provider, saved.roleMappings),
            };
          }),
        );
        return response(200, { providers, businessRoles: BUSINESS_ROLES });
      }

      if (event.httpMethod === 'PUT') {
        const providerId = decodeURIComponent(event.pathParameters?.providerId || '');
        const provider = config.providers?.[providerId];
        if (!providerId || !provider) {
          return response(404, { error: `SSO connection "${providerId}" is not configured` });
        }
        if (!provider.roleClaim) {
          return response(409, {
            error:
              'Complete SSO setup first: this connection has no source attribute (claims.roles) configured, so no IdP values reach the application.',
            code: 'SOURCE_ATTRIBUTE_MISSING',
          });
        }
        let data;
        try {
          data = event.body ? JSON.parse(event.body) : {};
        } catch {
          return response(400, { error: 'Invalid JSON body' });
        }
        const saved = await membershipStore.saveRoleMappings({
          providerId,
          actorId: requestingUserId,
          roleMappings: data?.roleMappings,
          expectedRevision: data?.expectedRevision ?? null,
        });
        logger.info('sso business-role mappings changed', {
          providerId,
          by: requestingUserId,
        });
        return response(200, {
          providerId,
          revision: saved.revision,
          ...businessRoleMappingView(provider, saved.roleMappings),
        });
      }

      return response(405, { error: 'Method not allowed' });
    }

    // ── Platform-admin routes ─────────────────────────────────────────────
    if (isAdminRoute) {
      const denied = requirePlatformAdmin(event);
      if (denied) return response(denied.statusCode, { error: denied.error, code: denied.code });

      // GET /admin/users — directory + platform-admin flags
      if (event.httpMethod === 'GET') {
        const [users, adminUsernames] = await Promise.all([
          listAllUsers(userPoolId),
          listPlatformAdminUsernames(userPoolId),
        ]);
        return response(
          200,
          users.map((u) => ({
            ...u,
            platformAdmin: u.roleManagedExternally
              ? u.accessGranted && u.mappedRoles.includes(PLATFORM_ADMIN_GROUP)
              : adminUsernames.has(u.username),
          })),
        );
      }

      // PUT /admin/users/{username}/platform-admin — grant/revoke the role
      if (event.httpMethod === 'PUT' && path.endsWith('/platform-admin')) {
        const username = decodeURIComponent(event.pathParameters?.username || '');
        if (!username) return response(400, { error: 'username path parameter is required' });

        let data;
        try {
          data = event.body ? JSON.parse(event.body) : {};
        } catch {
          return response(400, { error: 'Invalid JSON body' });
        }
        if (typeof data.isAdmin !== 'boolean') {
          return response(400, { error: 'isAdmin (boolean) is required' });
        }

        let target;
        try {
          target = await client.send(
            new AdminGetUserCommand({ UserPoolId: userPoolId, Username: username }),
          );
        } catch (err) {
          if (err?.name === 'UserNotFoundException') {
            return response(404, { error: `User "${username}" not found` });
          }
          throw err;
        }
        if (identityDetails(attrsToMap(target.UserAttributes)).roleManagedExternally) {
          return response(409, {
            error: 'This role is managed by the user’s enterprise identity provider',
            code: 'EXTERNALLY_MANAGED_ROLE',
          });
        }

        // Self-demotion guard: the last admin must not be able to lock the
        // platform out of its Admin page with one misclick. Granting to
        // yourself is a harmless no-op and stays allowed.
        const callerUsername = claims['cognito:username'] || '';
        if (!data.isAdmin && callerUsername && username === callerUsername) {
          return response(409, {
            error: 'You cannot remove your own platform-admin role — ask another administrator',
            code: 'SELF_DEMOTION_FORBIDDEN',
          });
        }

        const Command = data.isAdmin ? AdminAddUserToGroupCommand : AdminRemoveUserFromGroupCommand;
        try {
          await client.send(
            new Command({
              UserPoolId: userPoolId,
              Username: username,
              GroupName: PLATFORM_ADMIN_GROUP,
            }),
          );
        } catch (err) {
          if (err?.name === 'UserNotFoundException') {
            return response(404, { error: `User "${username}" not found` });
          }
          throw err;
        }
        logger.info('platform-admin role changed', {
          target: username,
          isAdmin: data.isAdmin,
          by: requestingUserId,
        });
        return response(200, { username, platformAdmin: data.isAdmin });
      }

      return response(404, { error: 'Not found' });
    }

    // ── GET /users — the user directory (any authenticated user) ─────────
    if (event.httpMethod !== 'GET') {
      return response(405, { error: 'Method not allowed' });
    }
    const users = await listAllUsers(userPoolId);
    // This endpoint is the assignable identity directory, not a raw user-pool
    // listing. Keep Cognito usernames private and key membership on sub. Local
    // users must be confirmed; federated users use Cognito's provider-neutral
    // admission result instead of a provider-specific status check.
    return response(
      200,
      users
        .filter(isAssignableDirectoryUser)
        .map(
          ({ userId, email, displayName, enabled, status, identitySource, identityProvider }) => ({
            userId,
            email,
            displayName,
            enabled,
            status,
            identitySource,
            identityProvider,
          }),
        ),
    );
  } catch (err) {
    logger.error('Error handling users request', err);
    return response(err.statusCode || 500, {
      error: err.statusCode ? err.message : 'Internal server error',
    });
  }
};
