import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import gremlin from 'gremlin';
import {
  WorkflowSourceError,
  workflowSourceIdentity,
} from '../../shared/workflow-source-bindings.js';
import { createWorkflowSourcesHandler } from '../handler.js';

// HTTP/service and lazy connection ports are injected. No AWS/Neptune request,
// provider verification, or JWT signature validation is performed by these tests.
const COLLECTION = '/api/projects/{projectId}/workflow-sources';
const ITEM = `${COLLECTION}/{sourceId}`;
const REVISION = '11111111-1111-4111-8111-111111111111';
const ACTOR = 'authenticated-cognito-sub';
const PROJECT = 'project-one';
const SOURCE = workflowSourceIdentity('github', 'example/workflows').sourceId;
const SECRET = 'private-error-token-or-connection-details';
const requestBody = () => ({
  provider: 'github',
  repository: 'example/workflows',
  authType: 'public',
  expectedRevision: null,
});
const request = (method = 'GET', overrides = {}) => {
  const item = method === 'DELETE';
  return {
    resource: item ? ITEM : COLLECTION,
    httpMethod: method,
    path: `/api/projects/${PROJECT}/workflow-sources${item ? `/${SOURCE}` : ''}`,
    pathParameters: { projectId: PROJECT, ...(item ? { sourceId: SOURCE } : {}) },
    requestContext: { authorizer: { claims: { sub: ACTOR } } },
    headers: { Origin: 'https://app.example.test' },
    isBase64Encoded: false,
    ...(method === 'POST' ? { body: JSON.stringify(requestBody()) } : {}),
    ...(method === 'DELETE' ? { body: JSON.stringify({ expectedRevision: REVISION }) } : {}),
    ...overrides,
  };
};
const decoded = (response) => JSON.parse(response.body);
let service;
let handle;
beforeEach(() => {
  service = {
    list: vi.fn(async () => [
      { sourceId: SOURCE, provider: 'github', repository: 'example/workflows' },
    ]),
    configure: vi.fn(async () => ({ sourceId: SOURCE, revision: REVISION })),
    remove: vi.fn(async () => {}),
    getAuthorizedBinding: vi.fn(),
  };
  handle = createWorkflowSourcesHandler({ service, enabled: true });
});
afterEach(() => vi.unstubAllEnvs());
const unused = () => {
  expect(service.list).not.toHaveBeenCalled();
  expect(service.configure).not.toHaveBeenCalled();
  expect(service.remove).not.toHaveBeenCalled();
  expect(service.getAuthorizedBinding).not.toHaveBeenCalled();
};
const invalidPost = async (body, status = 400) => {
  const result = await handle(
    request('POST', {
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );
  expect(result.statusCode).toBe(status);
  expect(result.body).not.toContain(SECRET);
  unused();
};

describe('dedicated workflow-source HTTP boundary', () => {
  it('lists sources using claims.sub and path projectId only', async () => {
    const result = await handle(
      request('GET', {
        actorId: 'forged-actor',
        userId: 'forged-user',
        headers: { Authorization: `Bearer ${SECRET}`, 'X-Actor-Id': 'forged-header' },
      }),
    );
    expect(result.statusCode).toBe(200);
    expect(decoded(result)).toEqual({
      sources: await service.list.mock.results[0].value,
      capabilities: { packageImportsEnabled: false },
    });
    expect(service.list).toHaveBeenCalledExactlyOnceWith({ projectId: PROJECT, actorId: ACTOR });
    expect(service.getAuthorizedBinding).not.toHaveBeenCalled();
  });

  it.each([undefined, false, 'true', 1, true])(
    'advertises only effective package-import enablement for flag %s',
    async (packageJobsEnabled) => {
      service.list.mockResolvedValue([]);
      const packageJobs = { get: vi.fn(), create: vi.fn() };
      const invoke = createWorkflowSourcesHandler({
        service,
        packageJobs,
        enabled: true,
        packageJobsEnabled,
      });
      const result = await invoke(request());
      expect(result.statusCode).toBe(200);
      expect(decoded(result)).toEqual({
        sources: [],
        capabilities: { packageImportsEnabled: packageJobsEnabled === true },
      });
      expect(service.list).toHaveBeenCalledExactlyOnceWith({
        projectId: PROJECT,
        actorId: ACTOR,
      });
      expect(packageJobs.get).not.toHaveBeenCalled();
      expect(packageJobs.create).not.toHaveBeenCalled();
    },
  );

  it.each([null, REVISION])(
    'configures with explicit revision %s and only selected fields',
    async (expectedRevision) => {
      const body = {
        provider: 'github',
        repository: 'Example/Workflows',
        authType: 'github-oauth',
        confirmDelegation: true,
        expectedRevision,
      };
      const result = await handle(request('POST', { body: JSON.stringify(body) }));
      expect(result.statusCode).toBe(200);
      expect(decoded(result)).toEqual({ sourceId: SOURCE, revision: REVISION });
      expect(service.configure).toHaveBeenCalledExactlyOnceWith({
        projectId: PROJECT,
        actorId: ACTOR,
        expectedRevision,
        selection: {
          provider: body.provider,
          repository: body.repository,
          authType: body.authType,
          confirmDelegation: true,
        },
      });
    },
  );

  it('removes the path source with the required revision', async () => {
    const result = await handle(request('DELETE'));
    expect(result.statusCode).toBe(204);
    expect(result.body).toBe('');
    expect(service.remove).toHaveBeenCalledExactlyOnceWith({
      projectId: PROJECT,
      actorId: ACTOR,
      sourceId: SOURCE,
      expectedRevision: REVISION,
    });
  });

  it.each([
    ['gitlab', 'public'],
    ['gitlab', 'gitlab-oauth'],
    ['bitbucket', 'public'],
    ['bitbucket', 'bitbucket-oauth'],
    ['github', 'github-app'],
  ])('accepts supported %s/%s selections', async (provider, authType) => {
    const result = await handle(
      request('POST', {
        body: JSON.stringify({ ...requestBody(), provider, authType, confirmDelegation: true }),
      }),
    );
    expect(result.statusCode).toBe(200);
  });

  it.each([undefined, false, 'true', 1])(
    'keeps the factory disabled unless enabled is boolean true: %s',
    async (enabled) => {
      const disabled = createWorkflowSourcesHandler({ service, enabled });
      const result = await disabled(request('POST'));
      expect(result.statusCode).toBe(503);
      expect(decoded(result).code).toBe('WORKFLOW_SOURCE_API_DISABLED');
      unused();
    },
  );

  it('allows CORS OPTIONS on an exact resource without auth or enabling the API', async () => {
    vi.stubEnv('CORS_ALLOWED_ORIGINS', 'https://app.example.test');
    const result = await createWorkflowSourcesHandler({ service })(
      request('OPTIONS', { requestContext: {} }),
    );
    expect(result.statusCode).toBe(200);
    expect(decoded(result)).toEqual({});
    expect(result.headers['Access-Control-Allow-Origin']).toBe('https://app.example.test');
    expect(result.headers['Access-Control-Allow-Methods']).toBe('GET,POST,DELETE,OPTIONS');
    unused();
  });

  it.each([
    undefined,
    {},
    { authorizer: {} },
    { authorizer: { claims: {} } },
    { authorizer: { claims: { sub: '' } } },
    { authorizer: { claims: { sub: ' ' } } },
    { authorizer: { claims: { sub: 123 } } },
    { authorizer: { principalId: ACTOR } },
    { authorizer: { jwt: { claims: { sub: ACTOR } } } },
    { identity: { cognitoIdentityId: ACTOR } },
    { authorizer: { claims: Object.create({ sub: ACTOR }) } },
  ])(
    'requires an own REST Cognito claims.sub rather than alternative identities: %j',
    async (requestContext) => {
      const result = await handle(
        request('POST', {
          requestContext,
          actorId: ACTOR,
          userId: ACTOR,
          headers: { Authorization: `Bearer ${SECRET}` },
        }),
      );
      expect(result.statusCode).toBe(401);
      expect(decoded(result)).toEqual({ code: 'UNAUTHORIZED', error: 'Authentication required' });
      unused();
    },
  );

  it.each([
    undefined,
    '/projects/{projectId}/workflow-sources',
    '/projects/{projectId}/workflow-sources/{sourceId}',
    '/api/projects/{projectId}/source-control',
    '/api/projects/{projectId}/workflow-sources/verify',
    '/api/projects/{projectId}/workflow-sources/{sourceId}/loadForExecution',
    '/api/projects/{projectId}/workflow-sources/{sourceId}/releases',
    '/api/projects/{projectId}/workflow-sources/',
  ])('rejects unlisted resources including native/internal operations: %s', async (resource) => {
    const result = await handle(request('POST', { resource }));
    expect(result.statusCode).toBe(404);
    unused();
  });

  it('does not accept an internal operation envelope', async () => {
    const result = await handle({ operation: 'list', projectId: PROJECT, actorId: ACTOR });
    expect(result.statusCode).toBe(404);
    unused();
  });

  it.each(['operation', 'op', 'action'])(
    'rejects an internal %s mixed into an HTTP envelope',
    async (key) => {
      const result = await handle(request('GET', { [key]: 'getAuthorizedBinding' }));
      expect(result.statusCode).toBe(400);
      unused();
    },
  );

  it.each([
    ['PUT', COLLECTION],
    ['PATCH', COLLECTION],
    ['DELETE', COLLECTION],
    ['GET', ITEM],
    ['POST', ITEM],
    ['HEAD', COLLECTION],
    ['post', COLLECTION],
  ])('rejects method %s on %s without dispatch', async (method, resource) => {
    const result = await handle(request(method, { resource }));
    expect(result.statusCode).toBe(405);
    expect(result.headers.Allow).toBe(
      resource === COLLECTION ? 'GET,POST,OPTIONS' : 'DELETE,OPTIONS',
    );
    unused();
  });

  it.each([
    '../other',
    'project/other',
    'project%2Fother',
    'project%252Fother',
    '.',
    '',
    'a'.repeat(257),
  ])('rejects unsafe project identity %s', async (projectId) => {
    const result = await handle(request('GET', { pathParameters: { projectId }, path: undefined }));
    expect(result.statusCode).toBe(400);
    unused();
  });

  it('allows an existing UUID project identity', async () => {
    const result = await handle(
      request('GET', {
        pathParameters: { projectId: REVISION },
        path: `/api/projects/${REVISION}/workflow-sources`,
      }),
    );
    expect(result.statusCode).toBe(200);
    expect(service.list).toHaveBeenCalledWith({ projectId: REVISION, actorId: ACTOR });
  });

  it.each(['../other', 'A'.repeat(64), 'a'.repeat(63), `${SOURCE}%2Fother`])(
    'requires an exact lowercase source hash: %s',
    async (sourceId) => {
      const result = await handle(
        request('DELETE', {
          pathParameters: { projectId: PROJECT, sourceId },
          path: undefined,
        }),
      );
      expect(result.statusCode).toBe(400);
      unused();
    },
  );

  it('rejects contradictory path parameters and literal path', async () => {
    const result = await handle(request('GET', { path: '/api/projects/other/workflow-sources' }));
    expect(result.statusCode).toBe(400);
    unused();
  });

  it.each(['queryStringParameters', 'multiValueQueryStringParameters'])(
    'rejects unsupported %s overrides',
    async (key) => {
      const result = await handle(
        request('GET', { [key]: { actorId: 'forged', operation: 'loadForExecution' } }),
      );
      expect(result.statusCode).toBe(400);
      unused();
    },
  );

  it.each([
    'actorId',
    'userId',
    'token',
    'credentialRef',
    'connectionUserId',
    'parameterName',
    'projectId',
    'sourceId',
    'operation',
    'getAuthorizedBinding',
    'unknown',
    '__proto__',
  ])('rejects unexpected POST key %s', async (key) => {
    const body = { ...requestBody(), [key]: SECRET };
    await invalidPost(body);
  });

  it.each([
    null,
    [],
    true,
    1,
    '{}',
    '{invalid json',
    JSON.stringify('string'),
    { ...requestBody(), expectedRevision: undefined },
    { ...requestBody(), expectedRevision: '' },
    { ...requestBody(), expectedRevision: 'not-a-uuid' },
    { ...requestBody(), expectedRevision: 123 },
    { ...requestBody(), provider: 'other' },
    { ...requestBody(), repository: 'https://user:secret@github.com/example/workflows' },
    { ...requestBody(), repository: '../workflows' },
    { ...requestBody(), authType: 'gitlab-oauth', confirmDelegation: true },
    { ...requestBody(), authType: 'github-oauth' },
    { ...requestBody(), authType: 'github-oauth', confirmDelegation: false },
    { ...requestBody(), confirmDelegation: 'true' },
  ])('rejects malformed or incomplete POST body: %j', async (body) => {
    await invalidPost(body);
  });

  it('rejects pre-parsed object bodies and base64 encoding', async () => {
    for (const overrides of [
      { body: requestBody() },
      {
        body: Buffer.from(JSON.stringify(requestBody())).toString('base64'),
        isBase64Encoded: true,
      },
      { body: JSON.stringify(requestBody()), isBase64Encoded: true },
    ]) {
      expect((await handle(request('POST', overrides))).statusCode).toBe(400);
    }
    unused();
  });

  it('enforces the 16 KiB boundary in bytes before JSON parsing', async () => {
    const base = JSON.stringify(requestBody());
    const exact = base + ' '.repeat(16 * 1024 - Buffer.byteLength(base));
    expect((await handle(request('POST', { body: exact }))).statusCode).toBe(200);
    service.configure.mockClear();
    await invalidPost(`${exact} `, 413);
    const multibyte = JSON.stringify({ ...requestBody(), repository: '💡'.repeat(5000) });
    expect(multibyte.length).toBeLessThan(16 * 1024);
    await invalidPost(multibyte, 413);
  });

  it.each([
    {},
    { expectedRevision: null },
    { expectedRevision: 'bad' },
    { expectedRevision: REVISION, actorId: ACTOR },
  ])('requires a DELETE body containing only a revision UUID: %j', async (body) => {
    const result = await handle(request('DELETE', { body: JSON.stringify(body) }));
    expect(result.statusCode).toBe(400);
    unused();
  });

  it('rejects GET bodies instead of interpreting nested operations', async () => {
    const result = await handle(
      request('GET', { body: JSON.stringify({ operation: 'getAuthorizedBinding' }) }),
    );
    expect(result.statusCode).toBe(400);
    unused();
  });

  it.each([
    ['WORKFLOW_SOURCE_INVALID', 400],
    ['WORKFLOW_SOURCE_FORBIDDEN', 403],
    ['WORKFLOW_SOURCE_CONFLICT', 409],
    ['WORKFLOW_SOURCE_NOT_FOUND', 404],
    ['WORKFLOW_SOURCE_UNAVAILABLE', 503],
  ])('maps only typed %s to fixed HTTP %i without its private message', async (code, status) => {
    service.configure.mockRejectedValueOnce(new WorkflowSourceError(code, SECRET));
    const result = await handle(request('POST'));
    expect(result.statusCode).toBe(status);
    expect(decoded(result).code).toBe(code);
    expect(result.body).not.toContain(SECRET);
  });

  it.each([
    [
      'CONNECTION_REQUIRED',
      400,
      'Connect or reconnect your Git provider account before configuring this source',
    ],
    [
      'CONNECTION_CHANGED',
      400,
      'Your Git provider connection changed. Reload your connections and retry',
    ],
    [
      'DELEGATION_CONFIRMATION_REQUIRED',
      400,
      'Confirm delegation of your connected account to this workflow source',
    ],
    [
      'BINDING_INVALID',
      400,
      'The workflow source credential configuration is invalid. Reload and configure the source again',
    ],
    [
      'MISSING_SCOPES',
      403,
      'Reconnect your Git provider account with the required repository permissions',
    ],
    [
      'INSUFFICIENT_REPOSITORY_ACCESS',
      403,
      'Repository read access could not be verified. Check the repository and selected authentication method',
    ],
    [
      'APP_INSTALLATION_UNAVAILABLE',
      403,
      'Install or re-enable the GitHub App for this repository, then retry',
    ],
    [
      'APP_CONFIG_INCOMPLETE',
      503,
      'A platform administrator must configure the GitHub App before it can be used',
    ],
    [
      'APP_CREDENTIAL_FAILED',
      503,
      'GitHub App authentication failed. Ask a platform administrator to check its configuration',
    ],
    [
      'CREDENTIAL_REFRESH_FAILED',
      503,
      'The provider connection could not be refreshed. Retry, or reconnect your account',
    ],
  ])(
    'maps documented credential code %s to a fixed actionable HTTP %i response',
    async (code, status, message) => {
      const error = Object.assign(new Error(SECRET, { cause: new Error(SECRET) }), {
        code,
        token: SECRET,
        missingScopes: [SECRET],
        providerResponse: { message: SECRET },
        status: 200,
        statusCode: 201,
        $metadata: { httpStatusCode: 401 },
      });
      service.configure.mockRejectedValueOnce(error);
      const result = await handle(request('POST'));
      expect(result.statusCode).toBe(status);
      expect(decoded(result)).toEqual({ code, error: message });
      expect(result.body).not.toContain(SECRET);
      expect(Object.keys(decoded(result)).toSorted()).toEqual(['code', 'error']);

      // Changing provider-supplied diagnostic fields must not change HTTP output.
      error.message = `${SECRET}-mutated`;
      error.status = 503;
      error.statusCode = 403;
      error.cause = { nested: SECRET };
      service.configure.mockRejectedValueOnce(error);
      expect(await handle(request('POST'))).toEqual(result);
    },
  );

  it('does not read private error messages even when they are accessors', async () => {
    const error = Object.assign(new Error(), { code: 'CONNECTION_REQUIRED' });
    const message = vi.fn(() => {
      throw new Error(SECRET);
    });
    Object.defineProperty(error, 'message', { get: message });
    service.configure.mockRejectedValueOnce(error);
    const result = await handle(request('POST'));
    expect(result.statusCode).toBe(400);
    expect(decoded(result).code).toBe('CONNECTION_REQUIRED');
    expect(message).not.toHaveBeenCalled();
  });

  it.each([
    'GITHUB_APP_NOT_CONFIGURED',
    'SCOPES_MISSING',
    'CONNECTION_REQUIRED\n',
    `CONNECTION_REQUIRED:${SECRET}`,
    '__proto__',
    'constructor',
    new String('CONNECTION_REQUIRED'),
  ])('does not widen credential mappings to undocumented or coercible codes: %s', async (code) => {
    service.configure.mockRejectedValueOnce(Object.assign(new Error(SECRET), { code }));
    const result = await handle(request('POST'));
    expect(result.statusCode).toBe(500);
    expect(decoded(result)).toEqual({
      code: 'WORKFLOW_SOURCE_INTERNAL_ERROR',
      error: 'Workflow source request failed',
    });
    expect(result.body).not.toContain(SECRET);
  });

  it('does not execute arbitrary error code getters or accept inherited codes', async () => {
    const getter = vi.fn(() => {
      throw new Error(SECRET);
    });
    const accessorError = new Error(SECRET);
    Object.defineProperty(accessorError, 'code', { get: getter });
    const inheritedError = new Error(SECRET);
    Object.setPrototypeOf(
      inheritedError,
      Object.assign(Object.create(Error.prototype), {
        code: 'CONNECTION_REQUIRED',
      }),
    );
    for (const error of [
      accessorError,
      inheritedError,
      { code: 'CONNECTION_REQUIRED', message: SECRET },
    ]) {
      service.configure.mockRejectedValueOnce(error);
      const result = await handle(request('POST'));
      expect(result.statusCode).toBe(500);
      expect(decoded(result).code).toBe('WORKFLOW_SOURCE_INTERNAL_ERROR');
      expect(result.body).not.toContain(SECRET);
    }
    expect(getter).not.toHaveBeenCalled();
  });

  it.each([
    new Error(SECRET),
    Object.assign(new Error(SECRET), { code: 'WORKFLOW_SOURCE_FORBIDDEN', statusCode: 403 }),
    { name: 'WorkflowSourceError', code: 'WORKFLOW_SOURCE_CONFLICT', message: SECRET },
    new WorkflowSourceError('PRIVATE_UNKNOWN_CODE', SECRET),
    Object.assign(new Error(SECRET), {
      name: 'ProjectAuthorityError',
      code: 'PROJECT_AUTHORITY_FORBIDDEN',
    }),
  ])('sanitizes untyped, spoofed, and unknown service failures', async (error) => {
    service.list.mockRejectedValueOnce(error);
    const result = await handle(request());
    expect(result.statusCode).toBe(500);
    expect(decoded(result)).toEqual({
      code: 'WORKFLOW_SOURCE_INTERNAL_ERROR',
      error: 'Workflow source request failed',
    });
    expect(result.body).not.toContain(SECRET);
  });
});

describe('workflow-source Lambda connection lifecycle', () => {
  let createWorkflowSourcesLambda;
  let lambdaHandler;
  beforeAll(async () => {
    ({ createWorkflowSourcesLambda, handler: lambdaHandler } = await import('../index.js'));
  });
  it('wires the real snapshot helper and service while keeping graph identities out of HTTP views', async () => {
    vi.stubEnv('WORKFLOW_SOURCE_BINDINGS_TABLE', 'workflow-source-bindings-test');
    const toList = vi.spyOn(gremlin.process.GraphTraversal.prototype, 'toList').mockResolvedValue([
      {
        projectIdentity: 'actual-project-vertex',
        memberships: [{ membershipId: 'actual-membership-edge', roles: ['member'] }],
      },
    ]);
    const connection = { close: vi.fn(async () => {}) };
    const ddb = {
      send: vi.fn(async () => ({
        Items: [
          {
            projectId: PROJECT,
            sourceId: SOURCE,
            provider: 'github',
            repository: 'example/workflows',
            status: 'active',
            revision: REVISION,
            authType: 'public',
            projectIdentity: 'actual-project-vertex',
            delegatorMembershipIdentity: 'private-delegator-edge',
            credentialRef: SECRET,
          },
        ],
      })),
    };
    const invoke = createWorkflowSourcesLambda({
      enabled: true,
      ddb,
      ssm: {},
      secrets: {},
      openConnection: async () => connection,
    });
    try {
      const result = await invoke(request());
      expect(result.statusCode).toBe(200);
      const source = decoded(result).sources[0];
      expect(source).toMatchObject({ sourceId: SOURCE, status: 'active', revision: REVISION });
      for (const key of ['projectIdentity', 'delegatorMembershipIdentity', 'credentialRef']) {
        expect(source).not.toHaveProperty(key);
      }
      expect(result.body).not.toContain(SECRET);
      expect(ddb.send).toHaveBeenCalledTimes(1);
      expect(connection.close).toHaveBeenCalledTimes(1);
      toList.mockResolvedValueOnce([]);
      expect((await invoke(request())).statusCode).toBe(403);
      expect(ddb.send).toHaveBeenCalledTimes(1);
      expect(connection.close).toHaveBeenCalledTimes(2);
    } finally {
      toList.mockRestore();
    }
  });
  const setup = ({
    enabled = true,
    failRole = false,
    failClose = false,
    failOpen = false,
  } = {}) => {
    const connection = {
      close: vi.fn(async () => {
        if (failClose) throw new Error(SECRET);
      }),
    };
    const openConnection = vi.fn(async () => {
      if (failOpen) throw new Error(SECRET);
      return connection;
    });
    const membership = Object.freeze({
      role: 'owner',
      membershipId: 'actual-edge-one',
      projectIdentity: 'actual-project-vertex-one',
    });
    const membershipSnapshot = vi.fn(async () => {
      if (failRole) throw new Error(SECRET);
      return membership;
    });
    const serviceFactory = vi.fn(({ getMembershipSnapshot }) => ({
      list: async ({ projectId, actorId }) => {
        expect(await getMembershipSnapshot(projectId, actorId)).toBe(membership);
        return [];
      },
      configure: async ({ projectId, actorId }) => {
        const snapshots = await Promise.all([
          getMembershipSnapshot(projectId, actorId),
          getMembershipSnapshot(projectId, actorId),
        ]);
        expect(snapshots).toEqual([membership, membership]);
        return { sourceId: SOURCE };
      },
      remove: async () => {},
    }));
    return {
      connection,
      openConnection,
      membershipSnapshot,
      serviceFactory,
      invoke: createWorkflowSourcesLambda({
        enabled,
        ddb: {},
        ssm: {},
        secrets: {},
        openConnection,
        membershipSnapshot,
        serviceFactory,
      }),
    };
  };

  it('reuses one request connection for role rechecks and closes it before responding', async () => {
    const f = setup();
    expect((await f.invoke(request('POST'))).statusCode).toBe(200);
    expect(f.openConnection).toHaveBeenCalledTimes(1);
    expect(f.membershipSnapshot).toHaveBeenCalledTimes(2);
    expect(f.membershipSnapshot.mock.calls[0].slice(1)).toEqual([PROJECT, ACTOR]);
    expect(f.membershipSnapshot.mock.calls[0][0]).toBe(f.membershipSnapshot.mock.calls[1][0]);
    expect(f.serviceFactory.mock.calls[0][0]).toHaveProperty('getMembershipSnapshot');
    expect(f.serviceFactory.mock.calls[0][0]).not.toHaveProperty('getMembershipRole');
    expect(f.connection.close).toHaveBeenCalledTimes(1);
    await f.invoke(request());
    expect(f.openConnection).toHaveBeenCalledTimes(2);
    expect(f.connection.close).toHaveBeenCalledTimes(2);
  });

  it.each([
    [false, request('POST'), 503],
    [true, request('POST', { requestContext: {} }), 401],
    [true, request('POST', { body: '{"token":"secret"}' }), 400],
    [true, { operation: 'configure', actorId: ACTOR }, 404],
    [false, request('OPTIONS', { requestContext: {} }), 200],
  ])(
    'does not open Neptune for rejected/disabled/preflight requests',
    async (enabled, event, status) => {
      const f = setup({ enabled });
      expect((await f.invoke(event)).statusCode).toBe(status);
      expect(f.openConnection).not.toHaveBeenCalled();
      expect(f.membershipSnapshot).not.toHaveBeenCalled();
      expect(f.serviceFactory).not.toHaveBeenCalled();
    },
  );

  it.each(['failRole', 'failClose', 'failOpen'])(
    'sanitizes %s connection failures',
    async (failure) => {
      const f = setup({ [failure]: true });
      const result = await f.invoke(request());
      expect(result.statusCode).toBe(500);
      expect(result.body).not.toContain(SECRET);
      expect(f.connection.close).toHaveBeenCalledTimes(failure === 'failOpen' ? 0 : 1);
    },
  );

  it.each([undefined, 'false', 'TRUE', '1', 'yes'])(
    'keeps the exported Lambda off for env flag %s',
    async (flag) => {
      vi.stubEnv('WORKFLOW_SOURCE_API_ENABLED', flag);
      expect((await lambdaHandler(request())).statusCode).toBe(503);
    },
  );

  it('enables the exported HTTP boundary only for the exact environment value true', async () => {
    vi.stubEnv('WORKFLOW_SOURCE_API_ENABLED', 'true');
    // No sub: enabling is observable without opening any AWS/Neptune client.
    expect((await lambdaHandler(request('GET', { requestContext: {} }))).statusCode).toBe(401);
  });
});
