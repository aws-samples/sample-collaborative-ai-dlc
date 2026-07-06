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
//
// Group membership rides on the ID token, so a change takes effect when the
// affected user's token refreshes (typically at next sign-in).
import {
  CognitoIdentityProviderClient,
  ListUsersCommand,
  ListUsersInGroupCommand,
  AdminAddUserToGroupCommand,
  AdminRemoveUserFromGroupCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { buildResponse } from '../shared/response.js';
import { requirePlatformAdmin, PLATFORM_ADMIN_GROUP } from '../shared/authz.js';

const client = new CognitoIdentityProviderClient({});

const attrsToMap = (attributes = []) => {
  const attrs = {};
  for (const a of attributes) attrs[a.Name] = a.Value;
  return attrs;
};

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

export const handler = async (event) => {
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

  try {
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
          users.map((u) => ({ ...u, platformAdmin: adminUsernames.has(u.username) })),
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
        console.log('[cognito-users] platform-admin role changed', {
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
    // Preserve the original wire shape (no username — the directory is for
    // member pickers, which key on the sub).
    return response(
      200,
      users.map(({ username: _username, ...u }) => u),
    );
  } catch (err) {
    console.error('Error handling users request:', err);
    return response(500, { error: 'Internal server error' });
  }
};
