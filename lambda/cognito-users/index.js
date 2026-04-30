const {
  CognitoIdentityProviderClient,
  ListUsersCommand,
} = require('@aws-sdk/client-cognito-identity-provider');
const { buildResponse } = require('./shared/response');

const client = new CognitoIdentityProviderClient({});

exports.handler = async (event) => {
  const response = buildResponse(event, { methods: 'GET,OPTIONS' });
  if (event.httpMethod === 'OPTIONS') {
    return response(200, {});
  }

  if (event.httpMethod !== 'GET') {
    return response(405, { error: 'Method not allowed' });
  }

  const requestingUserId = event.requestContext?.authorizer?.claims?.sub;
  if (!requestingUserId) {
    return response(401, { error: 'Unauthorized' });
  }

  try {
    const userPoolId = process.env.COGNITO_USER_POOL_ID;
    if (!userPoolId) {
      return response(500, { error: 'User pool not configured' });
    }

    const users = [];
    let paginationToken;

    do {
      const cmd = new ListUsersCommand({
        UserPoolId: userPoolId,
        Limit: 60,
        PaginationToken: paginationToken,
        AttributesToGet: ['sub', 'email', 'custom:display_name'],
      });

      const result = await client.send(cmd);

      for (const u of result.Users || []) {
        const attrs = {};
        for (const a of u.Attributes || []) {
          attrs[a.Name] = a.Value;
        }
        users.push({
          userId: attrs.sub,
          email: attrs.email || '',
          displayName: attrs['custom:display_name'] || '',
          enabled: u.Enabled,
          status: u.UserStatus,
        });
      }

      paginationToken = result.PaginationToken;
    } while (paginationToken);

    return response(200, users);
  } catch (err) {
    console.error('Error listing users:', err);
    return response(500, { error: 'Internal server error' });
  }
};
