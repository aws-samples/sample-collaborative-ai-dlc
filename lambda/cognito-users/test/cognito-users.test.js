// Cognito user directory + platform-admin role management
// (GET /users, GET /admin/users, PUT /admin/users/{username}/platform-admin).

import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  CognitoIdentityProviderClient,
  ListUsersCommand,
  ListUsersInGroupCommand,
  AdminGetUserCommand,
  AdminAddUserToGroupCommand,
  AdminRemoveUserFromGroupCommand,
} from '@aws-sdk/client-cognito-identity-provider';

import { handler } from '../index.js';

const cognitoMock = mockClient(CognitoIdentityProviderClient);

const POOL_ID = 'eu-central-1_testpool';

const cognitoUser = (username, sub, email, extra = {}) => ({
  Username: username,
  Enabled: true,
  UserStatus: 'CONFIRMED',
  Attributes: [
    { Name: 'sub', Value: sub },
    { Name: 'email', Value: email },
  ],
  ...extra,
});

const federatedUser = (providerName, providerType, username, sub, email, claimValues) =>
  cognitoUser(username, sub, email, {
    UserStatus: 'EXTERNAL_PROVIDER',
    Attributes: [
      ...cognitoUser(username, sub, email).Attributes,
      {
        Name: 'identities',
        Value: JSON.stringify([{ providerName, providerType, userId: sub }]),
      },
      { Name: 'custom:sso_roles', Value: claimValues },
    ],
  });

const makeEvent = (
  httpMethod,
  path,
  { admin = false, username, body = null, claims = {} } = {},
) => ({
  httpMethod,
  path,
  headers: { origin: 'https://app.example.com' },
  pathParameters: username ? { username } : null,
  requestContext: {
    authorizer: {
      claims: {
        sub: 'caller-sub',
        'cognito:username': 'caller',
        ...(admin ? { 'cognito:groups': 'platform-admin' } : {}),
        ...claims,
      },
    },
  },
  body,
});

beforeEach(() => {
  cognitoMock.reset();
  vi.stubEnv('COGNITO_USER_POOL_ID', POOL_ID);
  vi.stubEnv('CORS_ALLOWED_ORIGINS', 'https://app.example.com');
  cognitoMock.on(ListUsersCommand).resolves({
    Users: [cognitoUser('alice', 'sub-alice', 'alice@x'), cognitoUser('bob', 'sub-bob', 'bob@x')],
  });
  cognitoMock.on(ListUsersInGroupCommand).resolves({
    Users: [cognitoUser('alice', 'sub-alice', 'alice@x')],
  });
  cognitoMock.on(AdminGetUserCommand).resolves({
    Username: 'bob',
    UserAttributes: cognitoUser('bob', 'sub-bob', 'bob@x').Attributes,
  });
  cognitoMock.on(AdminAddUserToGroupCommand).resolves({});
  cognitoMock.on(AdminRemoveUserFromGroupCommand).resolves({});
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('GET /users (directory)', () => {
  it('lists assignable users without exposing Cognito usernames', async () => {
    const res = await handler(makeEvent('GET', '/users'));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toEqual([
      {
        userId: 'sub-alice',
        email: 'alice@x',
        displayName: '',
        enabled: true,
        status: 'CONFIRMED',
        identitySource: 'cognito',
        identityProvider: null,
      },
      {
        userId: 'sub-bob',
        email: 'bob@x',
        displayName: '',
        enabled: true,
        status: 'CONFIRMED',
        identitySource: 'cognito',
        identityProvider: null,
      },
    ]);
  });

  it('returns 401 without a Cognito sub', async () => {
    const event = makeEvent('GET', '/users');
    event.requestContext.authorizer.claims = {};
    const res = await handler(event);
    expect(res.statusCode).toBe(401);
  });

  it('follows Cognito pagination', async () => {
    cognitoMock
      .on(ListUsersCommand)
      .resolvesOnce({
        Users: [cognitoUser('alice', 'sub-alice', 'alice@x')],
        PaginationToken: 'next',
      })
      .resolvesOnce({ Users: [cognitoUser('bob', 'sub-bob', 'bob@x')] });
    const res = await handler(makeEvent('GET', '/users'));
    expect(JSON.parse(res.body)).toHaveLength(2);
  });

  it.each(['OIDC', 'SAML'])(
    'includes admitted %s identities without relying on CONFIRMED status',
    async (providerType) => {
      const providerName = `Test${providerType}`;
      vi.stubEnv(
        'SSO_ROLE_CONFIG',
        JSON.stringify({
          providers: {
            [providerName]: {
              roleMappings: { 'platform-admin': ['aidlc-admin'] },
              requiredClaimValues: ['aidlc-user'],
            },
          },
        }),
      );
      cognitoMock.on(ListUsersCommand).resolves({
        Users: [
          cognitoUser('local', 'sub-local', 'local@x'),
          federatedUser(
            providerName,
            providerType,
            `${providerName}_member`,
            'sub-member',
            'member@x',
            '[aidlc-user]',
          ),
          federatedUser(
            providerName,
            providerType,
            `${providerName}_denied`,
            'sub-denied',
            'denied@x',
            '[other-group]',
          ),
        ],
      });

      const res = await handler(makeEvent('GET', '/users'));

      expect(JSON.parse(res.body)).toEqual([
        expect.objectContaining({
          userId: 'sub-local',
          identitySource: 'cognito',
          status: 'CONFIRMED',
        }),
        expect.objectContaining({
          userId: 'sub-member',
          identitySource: 'sso',
          identityProvider: providerName,
          status: 'EXTERNAL_PROVIDER',
        }),
      ]);
    },
  );

  it('excludes disabled and unconfirmed local users', async () => {
    cognitoMock.on(ListUsersCommand).resolves({
      Users: [
        cognitoUser('confirmed', 'sub-confirmed', 'confirmed@x'),
        cognitoUser('unconfirmed', 'sub-unconfirmed', 'unconfirmed@x', {
          UserStatus: 'UNCONFIRMED',
        }),
        cognitoUser('disabled', 'sub-disabled', 'disabled@x', { Enabled: false }),
      ],
    });

    const res = await handler(makeEvent('GET', '/users'));

    expect(JSON.parse(res.body).map((user) => user.userId)).toEqual(['sub-confirmed']);
  });

  it('excludes federated identities whose provider is no longer configured', async () => {
    vi.stubEnv('SSO_ROLE_CONFIG', JSON.stringify({ providers: {} }));
    cognitoMock.on(ListUsersCommand).resolves({
      Users: [
        federatedUser(
          'RemovedProvider',
          'OIDC',
          'RemovedProvider_user',
          'sub-removed',
          'removed@x',
          '[aidlc-user]',
        ),
      ],
    });

    const res = await handler(makeEvent('GET', '/users'));

    expect(JSON.parse(res.body)).toEqual([]);
  });
});

describe('GET /admin/users', () => {
  it('rejects non-platform-admins with 403', async () => {
    const res = await handler(makeEvent('GET', '/admin/users'));
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).code).toBe('PLATFORM_ADMIN_REQUIRED');
  });

  it('lists users with username + platformAdmin flags for admins', async () => {
    const res = await handler(makeEvent('GET', '/admin/users', { admin: true }));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toEqual([
      expect.objectContaining({
        username: 'alice',
        userId: 'sub-alice',
        platformAdmin: true,
        identitySource: 'cognito',
        roleManagedExternally: false,
      }),
      expect.objectContaining({
        username: 'bob',
        userId: 'sub-bob',
        platformAdmin: false,
        identitySource: 'cognito',
        roleManagedExternally: false,
      }),
    ]);
  });

  it('reports federated roles from the authoritative IdP mapping', async () => {
    vi.stubEnv(
      'SSO_ROLE_CONFIG',
      JSON.stringify({
        providers: {
          TestOIDC: {
            roleMappings: { 'platform-admin': ['aidlc-admin'] },
            requiredClaimValues: [],
          },
        },
      }),
    );
    cognitoMock.on(ListUsersCommand).resolves({
      Users: [
        cognitoUser('TestOIDC_alice', 'sub-sso', 'alice@x', {
          Attributes: [
            ...cognitoUser('TestOIDC_alice', 'sub-sso', 'alice@x').Attributes,
            {
              Name: 'identities',
              Value: JSON.stringify([{ providerName: 'TestOIDC', providerType: 'OIDC' }]),
            },
            { Name: 'custom:sso_roles', Value: '[aidlc-admin]' },
          ],
        }),
      ],
    });
    const res = await handler(makeEvent('GET', '/admin/users', { admin: true }));
    expect(JSON.parse(res.body)[0]).toMatchObject({
      identitySource: 'sso',
      identityProvider: 'TestOIDC',
      mappedRoles: ['platform-admin'],
      roleManagedExternally: true,
      accessGranted: true,
      platformAdmin: true,
    });
  });

  it('retains denied identities for administrators without granting mapped roles', async () => {
    vi.stubEnv(
      'SSO_ROLE_CONFIG',
      JSON.stringify({
        providers: {
          TestOIDC: {
            roleMappings: { 'platform-admin': ['aidlc-admin'] },
            requiredClaimValues: ['aidlc-user'],
          },
        },
      }),
    );
    cognitoMock.on(ListUsersCommand).resolves({
      Users: [
        federatedUser(
          'TestOIDC',
          'OIDC',
          'TestOIDC_denied',
          'sub-denied',
          'denied@x',
          '[aidlc-admin]',
        ),
      ],
    });

    const res = await handler(makeEvent('GET', '/admin/users', { admin: true }));

    expect(JSON.parse(res.body)[0]).toMatchObject({
      identitySource: 'sso',
      accessGranted: false,
      mappedRoles: ['platform-admin'],
      platformAdmin: false,
    });
  });
});

describe('PUT /admin/users/{username}/platform-admin', () => {
  const put = (username, body, opts = {}) =>
    handler(
      makeEvent('PUT', `/admin/users/${username}/platform-admin`, {
        admin: true,
        username,
        body: JSON.stringify(body),
        ...opts,
      }),
    );

  it('rejects non-platform-admins with 403', async () => {
    const res = await handler(
      makeEvent('PUT', '/admin/users/bob/platform-admin', {
        username: 'bob',
        body: JSON.stringify({ isAdmin: true }),
      }),
    );
    expect(res.statusCode).toBe(403);
    expect(cognitoMock.commandCalls(AdminAddUserToGroupCommand)).toHaveLength(0);
  });

  it('grants the role via AdminAddUserToGroup', async () => {
    const res = await put('bob', { isAdmin: true });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ username: 'bob', platformAdmin: true });
    const calls = cognitoMock.commandCalls(AdminAddUserToGroupCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input).toEqual({
      UserPoolId: POOL_ID,
      Username: 'bob',
      GroupName: 'platform-admin',
    });
  });

  it('revokes the role via AdminRemoveUserFromGroup', async () => {
    const res = await put('bob', { isAdmin: false });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ username: 'bob', platformAdmin: false });
    const calls = cognitoMock.commandCalls(AdminRemoveUserFromGroupCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input.Username).toBe('bob');
  });

  it('rejects self-demotion with 409 (lock-out guard)', async () => {
    const res = await put('caller', { isAdmin: false });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe('SELF_DEMOTION_FORBIDDEN');
    expect(cognitoMock.commandCalls(AdminRemoveUserFromGroupCommand)).toHaveLength(0);
  });

  it('allows granting to yourself (harmless no-op)', async () => {
    const res = await put('caller', { isAdmin: true });
    expect(res.statusCode).toBe(200);
  });

  it('returns 404 for an unknown user', async () => {
    const err = new Error('User does not exist.');
    err.name = 'UserNotFoundException';
    cognitoMock.on(AdminGetUserCommand).rejects(err);
    const res = await put('ghost', { isAdmin: true });
    expect(res.statusCode).toBe(404);
  });

  it('rejects role changes for federated users', async () => {
    cognitoMock.on(AdminGetUserCommand).resolves({
      Username: 'TestOIDC_bob',
      UserAttributes: [
        ...cognitoUser('TestOIDC_bob', 'sub-sso', 'bob@x').Attributes,
        {
          Name: 'identities',
          Value: JSON.stringify([{ providerName: 'TestOIDC', providerType: 'OIDC' }]),
        },
      ],
    });
    const res = await put('TestOIDC_bob', { isAdmin: true });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe('EXTERNALLY_MANAGED_ROLE');
    expect(cognitoMock.commandCalls(AdminAddUserToGroupCommand)).toHaveLength(0);
  });

  it('validates the body', async () => {
    expect((await put('bob', {})).statusCode).toBe(400);
    const malformed = await handler(
      makeEvent('PUT', '/admin/users/bob/platform-admin', {
        admin: true,
        username: 'bob',
        body: '{not json',
      }),
    );
    expect(malformed.statusCode).toBe(400);
  });

  it('URL-decodes the username path parameter', async () => {
    const res = await put(encodeURIComponent('user@example.com'), { isAdmin: true });
    expect(res.statusCode).toBe(200);
    const calls = cognitoMock.commandCalls(AdminAddUserToGroupCommand);
    expect(calls[0].args[0].input.Username).toBe('user@example.com');
  });
});
