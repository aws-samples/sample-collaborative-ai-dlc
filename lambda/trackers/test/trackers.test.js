import { beforeAll, beforeEach, afterAll, afterEach, describe, it, expect, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { randomUUID } from 'node:crypto';
import gremlin from 'gremlin';
import { PartitionStrategy } from 'gremlin/lib/process/traversal-strategy.js';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  DeleteCommand,
  QueryCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  SSMClient,
  GetParameterCommand,
  PutParameterCommand,
  DeleteParameterCommand,
} from '@aws-sdk/client-ssm';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
  PutSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

const ddbMock = mockClient(DynamoDBDocumentClient);
const ssmMock = mockClient(SSMClient);
const secretsMock = mockClient(SecretsManagerClient);
const lambdaMock = mockClient(LambdaClient);

const NOW = new Date('2026-05-28T00:00:00.000Z');
const PARTITION = `t-${randomUUID()}`;
const GIT_TABLE = 'test-git-connections';
const TRACKER_TABLE = 'test-tracker-connections';
const PARAM_NAME = '/aidlc/dev/git-token/user-1';
const JIRA_PARAM_NAME = '/aidlc/dev/jira-token/user-1';
const TOKEN = 'gho_testtoken';
const JIRA_OAUTH_SECRET_NAME = 'jira-oauth-secret';
const GITHUB_OAUTH_SECRET_NAME = 'github-oauth-secret';
const GITLAB_OAUTH_SECRET_NAME = 'gitlab-oauth-secret';
const BITBUCKET_OAUTH_SECRET_NAME = 'bitbucket-oauth-secret';
const JIRA_CLIENT_ID = 'jira-cid';
const JIRA_CLIENT_SECRET = 'jira-cs';
const JIRA_REDIRECT_URI = 'https://example.com/trackers/callback/jira-cloud';
const JIRA_CLOUD_ID = 'cloud-uuid-1';
const JIRA_SITE_HOST = 'acme.atlassian.net';

let handler;
let resetProviderCache;
let conn;
let g;

beforeAll(async () => {
  vi.stubEnv('GREMLIN_PARTITION', PARTITION);
  vi.stubEnv('AWS_PROFILE', undefined);
  vi.stubEnv('GIT_CONNECTIONS_TABLE', GIT_TABLE);
  vi.stubEnv('SOURCE_CONTROL_BINDINGS_TABLE', 'test-source-control-bindings');
  vi.stubEnv('TRACKER_CONNECTIONS_TABLE', TRACKER_TABLE);
  vi.stubEnv('CORS_ALLOWED_ORIGINS', 'https://example.com');
  vi.stubEnv('JIRA_OAUTH_SECRET_NAME', JIRA_OAUTH_SECRET_NAME);
  vi.stubEnv('GITHUB_OAUTH_SECRET_NAME', GITHUB_OAUTH_SECRET_NAME);
  vi.stubEnv('GITLAB_OAUTH_SECRET_NAME', GITLAB_OAUTH_SECRET_NAME);
  vi.stubEnv('BITBUCKET_OAUTH_SECRET_NAME', BITBUCKET_OAUTH_SECRET_NAME);
  vi.stubEnv('JIRA_REDIRECT_URI', JIRA_REDIRECT_URI);
  vi.stubEnv('JIRA_TOKEN_SSM_PREFIX', 'aidlc/dev/jira-token');
  vi.stubEnv('SOURCE_CONTROL_FUNCTION', 'source-control-test');
  ({ handler } = await import('../index.js'));
  ({ __resetCache: resetProviderCache } = await import('../providers/github-issues.js'));

  const url = `ws://${process.env.NEPTUNE_ENDPOINT}:${process.env.GREMLIN_PORT}/gremlin`;
  conn = new gremlin.driver.DriverRemoteConnection(url);
  g = gremlin.process.AnonymousTraversalSource.traversal()
    .withRemote(conn)
    .withStrategies(
      new PartitionStrategy({
        partitionKey: '_partition',
        writePartition: PARTITION,
        readPartitions: [PARTITION],
      }),
    );
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await conn?.close();
});

let fetchMock;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  ddbMock.reset();
  ssmMock.reset();
  secretsMock.reset();
  lambdaMock.reset();
  resetProviderCache();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  // Default: GitHub is connected and the SSM token resolves cleanly. Tests
  // that need an unconnected user override this on the ddbMock.
  ddbMock.on(GetCommand, { TableName: GIT_TABLE }).resolves({
    Item: { userId: 'user-1', parameterName: PARAM_NAME, createdAt: NOW.toISOString() },
  });
  ssmMock.on(GetParameterCommand).resolves({
    Parameter: { Value: JSON.stringify({ accessToken: TOKEN }) },
  });
  ddbMock.on(ScanCommand, { TableName: TRACKER_TABLE }).resolves({ Items: [] });
  ddbMock.on(QueryCommand, { TableName: 'test-source-control-bindings' }).resolves({ Items: [] });
  lambdaMock.on(InvokeCommand).resolves({
    Payload: Buffer.from(JSON.stringify({ ok: true, result: 'main' })),
  });
  secretsMock.on(GetSecretValueCommand).resolves({
    SecretString: JSON.stringify({ client_id: JIRA_CLIENT_ID, client_secret: JIRA_CLIENT_SECRET }),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// TinkerGraph defaults to single cardinality; Neptune defaults to set. Check
// the submitted bytecode so a passing local write also replaces values there.
const expectSingleCardinalityWrites = (submit, expectedKeys) => {
  const writes = submit.mock.calls
    .flatMap(([bytecode]) => bytecode.stepInstructions)
    .filter(
      ([step, first, second]) =>
        step === 'property' && (expectedKeys.includes(first) || expectedKeys.includes(second)),
    );
  for (const step of writes) expect(step[1]).toBe(gremlin.process.cardinality.single);
  expect(new Set(writes.map((step) => step[2]))).toEqual(new Set(expectedKeys));
};

const DELEGATION_KEYS = [
  'connection_user_id',
  'cloud_id',
  'external_project_id',
  'external_project_key',
  'status',
  'invalid_reason',
  'delegated_at',
];

const claims = (sub = 'user-1') => ({
  requestContext: { authorizer: { claims: { sub, email: `${sub}@x` } } },
});

// Platform-admin caller (Cognito group claim) — required by the oauth-config
// writer since the platform-admin gating landed.
const adminClaims = (sub = 'admin-1') => ({
  requestContext: {
    authorizer: {
      claims: { sub, email: `${sub}@x`, 'cognito:groups': '[platform-admin]' },
    },
  },
});

const seedProjectAndBinding = async ({
  gitRepo = 'acme/widgets',
  provider = 'github-issues',
  instance = 'public',
} = {}) => {
  const projectId = randomUUID();
  const bindingId = randomUUID();
  const userId = 'user-1';

  // User vertex
  const userExists = await g.V().has('User', 'id', userId).hasNext();
  if (!userExists) {
    await g.addV('User').property('id', userId).property('email', `${userId}@x`).next();
  }
  // Project vertex
  await g
    .addV('Project')
    .property('id', projectId)
    .property('name', `P-${projectId.slice(0, 8)}`)
    .property('git_provider', 'github')
    .property('git_repo', gitRepo)
    .property('agent_cli', 'kiro')
    .property('issue_integration_enabled', 'true')
    .property('created_at', NOW.toISOString())
    .next();
  // Owner edge
  await g
    .V()
    .has('Project', 'id', projectId)
    .addE('HAS_MEMBER')
    .property('role', 'owner')
    .to(gremlin.process.statics.V().has('User', 'id', userId))
    .next();
  // Binding
  await g
    .V()
    .has('Project', 'id', projectId)
    .as('p')
    .addV('TrackerBinding')
    .property('id', bindingId)
    .property('provider', provider)
    .property('instance', instance)
    .property('external_project_key', gitRepo)
    .property('display_name', gitRepo)
    .property('created_at', NOW.toISOString())
    .property('created_by', userId)
    .as('b')
    .addE('HAS_TRACKER')
    .from_('p')
    .to('b')
    .next();
  return { projectId, bindingId };
};

const seedProjectWithRole = async (role, { gitRepo = 'acme/widgets' } = {}) => {
  const projectId = randomUUID();
  const userId = 'user-1';
  const userExists = await g.V().has('User', 'id', userId).hasNext();
  if (!userExists) {
    await g.addV('User').property('id', userId).property('email', `${userId}@x`).next();
  }
  await g
    .addV('Project')
    .property('id', projectId)
    .property('name', 'P')
    .property('git_repo', gitRepo)
    .property('created_at', NOW.toISOString())
    .next();
  await g
    .V()
    .has('Project', 'id', projectId)
    .addE('HAS_MEMBER')
    .property('role', role)
    .to(gremlin.process.statics.V().has('User', 'id', userId))
    .next();
  return projectId;
};

// Legacy-shaped project: issue_integration_enabled='true', git_provider set,
// gitRepo populated, NO HAS_TRACKER edge. Used to exercise the synthetic
// legacy-github binding the trackers lambda surfaces (#194).
const seedLegacyProject = async ({ gitRepo = 'acme/widgets' } = {}) => {
  const projectId = randomUUID();
  const userId = 'user-1';
  const userExists = await g.V().has('User', 'id', userId).hasNext();
  if (!userExists) {
    await g.addV('User').property('id', userId).property('email', `${userId}@x`).next();
  }
  await g
    .addV('Project')
    .property('id', projectId)
    .property('name', 'P')
    .property('git_provider', 'github')
    .property('git_repo', gitRepo)
    .property('issue_integration_enabled', 'true')
    .property('created_at', NOW.toISOString())
    .next();
  await g
    .V()
    .has('Project', 'id', projectId)
    .addE('HAS_MEMBER')
    .property('role', 'owner')
    .to(gremlin.process.statics.V().has('User', 'id', userId))
    .next();
  return projectId;
};

const baseEvent = (overrides = {}) => ({
  httpMethod: 'GET',
  path: '/trackers',
  pathParameters: null,
  headers: { origin: 'https://example.com' },
  queryStringParameters: null,
  ...claims(),
  ...overrides,
});

const makeHeaders = (init = {}) => {
  const map = new Map(Object.entries(init).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return { get: (k) => (map.has(k.toLowerCase()) ? map.get(k.toLowerCase()) : null) };
};

const okResponse = (body, headers = {}) => ({
  ok: true,
  status: 200,
  json: async () => body,
  headers: makeHeaders(headers),
});
const trackerIssueFixture = (overrides = {}) => ({
  resourceId: '42',
  resourceUrl: 'https://github.com/acme/widgets/issues/42',
  resourceType: 'issue',
  entityType: null,
  entityIconUrl: null,
  title: 'Add login flow',
  body: 'We need login.',
  state: 'open',
  labels: [{ name: 'enhancement', color: 'a2eeef' }],
  author: { handle: 'octocat', avatarUrl: 'https://example.com/a.png' },
  createdAt: '2026-05-01T00:00:00Z',
  updatedAt: '2026-05-02T00:00:00Z',
  ...overrides,
});

const trackerCommentFixture = (overrides = {}) => ({
  id: '1001',
  author: { handle: 'octocat', avatarUrl: 'https://example.com/a.png' },
  body: 'I think we should also handle X.',
  createdAt: '2026-05-03T00:00:00Z',
  updatedAt: '2026-05-03T00:00:00Z',
  ...overrides,
});

const sourceControlResponse = (result) => ({
  Payload: Buffer.from(JSON.stringify({ ok: true, result })),
});

const sourceControlRequest = (index = 0) =>
  JSON.parse(
    Buffer.from(lambdaMock.commandCalls(InvokeCommand)[index].args[0].input.Payload).toString(),
  );

describe('OPTIONS', () => {
  it('short-circuits with 200 + CORS headers', async () => {
    const res = await handler(baseEvent({ httpMethod: 'OPTIONS' }));
    expect(res.statusCode).toBe(200);
    expect(res.headers['Access-Control-Allow-Origin']).toBe('https://example.com');
  });
});

describe('Authentication', () => {
  it('returns 401 when no userId claim is present', async () => {
    const { projectId, bindingId } = await seedProjectAndBinding();
    const res = await handler({
      httpMethod: 'GET',
      path: `/projects/${projectId}/trackers/${bindingId}/issues`,
      pathParameters: { projectId, bindingId },
      headers: { origin: 'https://example.com' },
      requestContext: { authorizer: { claims: {} } },
    });
    expect(res.statusCode).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('Authorization', () => {
  it('returns 403 when caller is not a project member', async () => {
    const { projectId, bindingId } = await seedProjectAndBinding();
    const res = await handler({
      httpMethod: 'GET',
      path: `/projects/${projectId}/trackers/${bindingId}/issues`,
      pathParameters: { projectId, bindingId },
      headers: { origin: 'https://example.com' },
      ...claims('intruder'),
    });
    expect(res.statusCode).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('internal issue attachment import', () => {
  it('resolves the project binding and delegates without exposing its credentials', async () => {
    const { projectId, bindingId } = await seedProjectAndBinding();
    lambdaMock.on(InvokeCommand).resolves(sourceControlResponse({ attachments: [] }));
    const result = await handler({
      action: 'issue-attachments',
      projectId,
      bindingId,
      userId: 'user-1',
      resourceId: '42',
    });
    expect(result).toEqual({ attachments: [] });
    const payload = JSON.parse(
      Buffer.from(lambdaMock.commandCalls(InvokeCommand).at(-1).args[0].input.Payload).toString(),
    );
    expect(payload).toMatchObject({
      action: 'operate',
      projectId,
      provider: 'github',
      repo: 'acme/widgets',
      operation: 'issue-attachments',
      args: { number: '42' },
    });
  });

  it('refuses an internal request for a project the user cannot access', async () => {
    const { projectId, bindingId } = await seedProjectAndBinding();
    const before = lambdaMock.commandCalls(InvokeCommand).length;
    const result = await handler({
      action: 'issue-attachments',
      projectId,
      bindingId,
      userId: 'other-user',
      resourceId: '42',
    });
    expect(result).toMatchObject({ status: 'failed', reason: expect.stringContaining('Access') });
    expect(lambdaMock.commandCalls(InvokeCommand)).toHaveLength(before);
  });
});

describe('GET /trackers (unified listing)', () => {
  it('returns the user’s github-issues row from git-connections', async () => {
    const res = await handler(baseEvent());
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toEqual([
      expect.objectContaining({ provider: 'github-issues', instance: 'public' }),
    ]);
  });

  it('returns empty list when nothing is connected', async () => {
    ddbMock.on(GetCommand, { TableName: GIT_TABLE }).resolves({});
    ddbMock.on(ScanCommand, { TableName: TRACKER_TABLE }).resolves({ Items: [] });
    const res = await handler(baseEvent());
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual([]);
  });

  it('merges rows from tracker-connections (Phase 3 forward compat)', async () => {
    ddbMock.on(GetCommand, { TableName: GIT_TABLE }).resolves({});
    ddbMock.on(ScanCommand, { TableName: TRACKER_TABLE }).resolves({
      Items: [
        {
          userId: 'user-1',
          providerInstance: 'jira-cloud#cloud',
          createdAt: NOW.toISOString(),
          scope: 'read:jira-work',
        },
      ],
    });
    const res = await handler(baseEvent());
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toEqual([expect.objectContaining({ provider: 'jira-cloud', instance: 'cloud' })]);
  });
});

describe('DELETE /trackers/{provider}/{instance}', () => {
  it('disconnects github-issues by deleting the SSM param + git-connections row', async () => {
    const res = await handler({
      httpMethod: 'DELETE',
      path: '/trackers/github-issues/public',
      pathParameters: { provider: 'github-issues', instance: 'public' },
      headers: { origin: 'https://example.com' },
      ...claims(),
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ success: true });
    expect(ssmMock).toHaveReceivedCommand(DeleteParameterCommand);
    expect(ddbMock).toHaveReceivedCommand(DeleteCommand);
    expect(ddbMock).toHaveReceivedCommand(QueryCommand);
  });

  it('returns 400 for unknown provider/instance pair', async () => {
    const res = await handler({
      httpMethod: 'DELETE',
      path: '/trackers/unknown-provider/cloud',
      pathParameters: { provider: 'unknown-provider', instance: 'cloud' },
      headers: { origin: 'https://example.com' },
      ...claims(),
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('Auth/callback stubs', () => {
  it('returns 501 redirect for /trackers/auth/github-issues (real path: /github/auth)', async () => {
    const res = await handler({
      httpMethod: 'GET',
      path: '/trackers/auth/github-issues',
      pathParameters: { provider: 'github-issues' },
      headers: { origin: 'https://example.com' },
      ...claims(),
    });
    expect(res.statusCode).toBe(501);
  });

  it('returns 404 for unknown provider in auth path', async () => {
    const res = await handler({
      httpMethod: 'GET',
      path: '/trackers/auth/bogus',
      pathParameters: { provider: 'bogus' },
      headers: { origin: 'https://example.com' },
      ...claims(),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /projects/{id}/trackers', () => {
  it('lists bindings for the project', async () => {
    const { projectId } = await seedProjectAndBinding();
    const res = await handler({
      httpMethod: 'GET',
      path: `/projects/${projectId}/trackers`,
      pathParameters: { projectId },
      headers: { origin: 'https://example.com' },
      ...claims(),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({
      provider: 'github-issues',
      instance: 'public',
      externalProjectKey: 'acme/widgets',
    });
  });
});

describe('POST /projects/{id}/trackers', () => {
  it('creates a github-issues binding for an owner with GitHub connected', async () => {
    const projectId = await seedProjectWithRole('owner');
    const res = await handler({
      httpMethod: 'POST',
      path: `/projects/${projectId}/trackers`,
      pathParameters: { projectId },
      headers: { origin: 'https://example.com' },
      body: JSON.stringify({
        provider: 'github-issues',
        instance: 'public',
        externalProjectKey: 'octo/repo',
        displayName: 'octo/repo',
      }),
      ...claims(),
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({
      provider: 'github-issues',
      externalProjectKey: 'octo/repo',
      createdBy: 'user-1',
    });
  });

  it('rejects non-owner/admin members with 403', async () => {
    const projectId = await seedProjectWithRole('member');
    const res = await handler({
      httpMethod: 'POST',
      path: `/projects/${projectId}/trackers`,
      pathParameters: { projectId },
      headers: { origin: 'https://example.com' },
      body: JSON.stringify({
        provider: 'github-issues',
        instance: 'public',
        externalProjectKey: 'octo/repo',
      }),
      ...claims(),
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects unknown provider with 400', async () => {
    const projectId = await seedProjectWithRole('owner');
    const res = await handler({
      httpMethod: 'POST',
      path: `/projects/${projectId}/trackers`,
      pathParameters: { projectId },
      headers: { origin: 'https://example.com' },
      body: JSON.stringify({
        provider: 'unknown-provider',
        instance: 'cloud',
        externalProjectKey: 'PROJ',
      }),
      ...claims(),
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a git-backed tracker when the project binding is not ready', async () => {
    lambdaMock.on(InvokeCommand).resolves({
      Payload: Buffer.from(JSON.stringify({ ok: false, code: 'SOURCE_CONTROL_NOT_READY' })),
    });
    const projectId = await seedProjectWithRole('owner');
    const res = await handler({
      httpMethod: 'POST',
      path: `/projects/${projectId}/trackers`,
      pathParameters: { projectId },
      headers: { origin: 'https://example.com' },
      body: JSON.stringify({
        provider: 'github-issues',
        instance: 'public',
        externalProjectKey: 'octo/repo',
      }),
      ...claims(),
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toMatchObject({
      error: 'Project source control is not ready',
      code: 'SOURCE_CONTROL_NOT_READY',
    });
  });
});

describe('DELETE /projects/{id}/trackers/{bindingId}', () => {
  it('drops the binding for an owner', async () => {
    const { projectId, bindingId } = await seedProjectAndBinding();
    const res = await handler({
      httpMethod: 'DELETE',
      path: `/projects/${projectId}/trackers/${bindingId}`,
      pathParameters: { projectId, bindingId },
      headers: { origin: 'https://example.com' },
      ...claims(),
    });
    expect(res.statusCode).toBe(204);
    // The HAS_TRACKER edge is gone. The seed sets
    // issue_integration_enabled='true', so dropping the real binding flips
    // the project back to "legacy" and GET surfaces a synthetic
    // legacy-github entry (issue #194 — keeps the issues panel visible
    // for unmigrated projects).
    const after = await handler({
      httpMethod: 'GET',
      path: `/projects/${projectId}/trackers`,
      pathParameters: { projectId },
      headers: { origin: 'https://example.com' },
      ...claims(),
    });
    expect(JSON.parse(after.body)).toEqual([
      expect.objectContaining({ id: 'legacy-github', provider: 'github-issues' }),
    ]);
  });
});

describe('GET /projects/{id}/trackers/{bid}/issues (github-issues provider)', () => {
  let projectId;
  let bindingId;

  beforeEach(async () => {
    ({ projectId, bindingId } = await seedProjectAndBinding({ gitRepo: 'acme/widgets' }));
  });

  const issuesEvent = (overrides = {}) => ({
    httpMethod: 'GET',
    path: `/projects/${projectId}/trackers/${bindingId}/issues`,
    pathParameters: { projectId, bindingId },
    headers: { origin: 'https://example.com' },
    queryStringParameters: null,
    ...claims(),
    ...overrides,
  });

  it('lists issues through the project source-control service', async () => {
    lambdaMock.on(InvokeCommand).resolves(
      sourceControlResponse({
        items: [trackerIssueFixture()],
        page: 1,
        perPage: 30,
        hasNext: false,
        hasPrev: false,
        totalCount: null,
      }),
    );
    const res = await handler(issuesEvent());

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({
      page: 1,
      perPage: 30,
      hasNext: false,
      hasPrev: false,
      totalCount: null,
    });
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      resourceId: '42',
      title: 'Add login flow',
      state: 'open',
      resourceType: 'issue',
      author: { handle: 'octocat' },
    });
    expect(sourceControlRequest()).toEqual({
      action: 'operate',
      projectId,
      provider: 'github',
      repo: 'acme/widgets',
      operation: 'list-issues',
      args: {},
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forwards issue filters without resolving a caller credential', async () => {
    lambdaMock.on(InvokeCommand).resolves(
      sourceControlResponse({
        items: [],
        page: 3,
        perPage: 100,
        hasNext: false,
        hasPrev: true,
        totalCount: 0,
      }),
    );
    await handler(issuesEvent({ queryStringParameters: { page: '3', perPage: '500' } }));

    expect(sourceControlRequest()).toMatchObject({
      operation: 'list-issues',
      args: { page: '3', perPage: '500' },
    });
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
    expect(ssmMock.commandCalls(GetParameterCommand)).toHaveLength(0);
  });

  it('returns 409 when the project binding is not ready', async () => {
    lambdaMock.on(InvokeCommand).resolves({
      Payload: Buffer.from(JSON.stringify({ ok: false, code: 'SOURCE_CONTROL_NOT_READY' })),
    });
    const res = await handler(issuesEvent());
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe('SOURCE_CONTROL_NOT_READY');
  });
});

describe('GET /projects/{id}/trackers/{bid}/issues/{rid}', () => {
  let projectId;
  let bindingId;

  beforeEach(async () => {
    ({ projectId, bindingId } = await seedProjectAndBinding({ gitRepo: 'acme/widgets' }));
  });

  const detailEvent = (resourceId = '42') => ({
    httpMethod: 'GET',
    path: `/projects/${projectId}/trackers/${bindingId}/issues/${resourceId}`,
    pathParameters: { projectId, bindingId, resourceId },
    headers: { origin: 'https://example.com' },
    queryStringParameters: null,
    ...claims(),
  });

  it('returns issue detail through the project source-control service', async () => {
    lambdaMock.on(InvokeCommand).resolves(sourceControlResponse(trackerIssueFixture()));
    const res = await handler(detailEvent());
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({
      resourceId: '42',
      resourceUrl: 'https://github.com/acme/widgets/issues/42',
      resourceType: 'issue',
    });
    expect(sourceControlRequest()).toMatchObject({
      projectId,
      provider: 'github',
      repo: 'acme/widgets',
      operation: 'get-issue',
      args: { number: '42' },
    });
  });
});

describe('/projects/{id}/trackers/{bid}/issues/{rid}/comments', () => {
  let projectId;
  let bindingId;

  beforeEach(async () => {
    ({ projectId, bindingId } = await seedProjectAndBinding({ gitRepo: 'acme/widgets' }));
  });

  const commentsEvent = (resourceId = '42', overrides = {}) => ({
    httpMethod: 'GET',
    path: `/projects/${projectId}/trackers/${bindingId}/issues/${resourceId}/comments`,
    pathParameters: { projectId, bindingId, resourceId },
    headers: { origin: 'https://example.com' },
    queryStringParameters: null,
    ...claims(),
    ...overrides,
  });

  it('returns comments through the project source-control service', async () => {
    lambdaMock
      .on(InvokeCommand)
      .resolves(
        sourceControlResponse([
          trackerCommentFixture({ id: '1' }),
          trackerCommentFixture({ id: '2', body: 'Another point.' }),
        ]),
      );

    const res = await handler(commentsEvent());

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveLength(2);
    expect(body[0]).toMatchObject({
      id: '1',
      author: { handle: 'octocat' },
      body: 'I think we should also handle X.',
    });
    expect(sourceControlRequest()).toMatchObject({
      operation: 'list-issue-comments',
      args: { number: '42' },
    });
  });

  it('adds a comment through the project source-control service', async () => {
    lambdaMock
      .on(InvokeCommand)
      .resolves(sourceControlResponse(trackerCommentFixture({ body: 'Ship it.' })));
    const res = await handler(
      commentsEvent('42', {
        httpMethod: 'POST',
        body: JSON.stringify({ body: ' Ship it. ' }),
      }),
    );
    expect(res.statusCode).toBe(201);
    expect(sourceControlRequest()).toMatchObject({
      operation: 'add-issue-comment',
      args: { number: '42', body: 'Ship it.' },
    });
  });
});

// #194: synthetic legacy-github binding — surfaces a github-issues panel for
// projects that still use issue_integration_enabled and have no real
// HAS_TRACKER edge. No graph state is written; the binding is materialized
// from the project's gitRepo on every read.
describe('Legacy github-issues binding (#194)', () => {
  it('GET /projects/{id}/trackers includes the synthetic legacy-github entry', async () => {
    const projectId = await seedLegacyProject({ gitRepo: 'acme/widgets' });
    const res = await handler({
      httpMethod: 'GET',
      path: `/projects/${projectId}/trackers`,
      pathParameters: { projectId },
      headers: { origin: 'https://example.com' },
      ...claims(),
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual([
      expect.objectContaining({
        id: 'legacy-github',
        provider: 'github-issues',
        instance: 'public',
        externalProjectKey: 'acme/widgets',
        displayName: 'acme/widgets',
      }),
    ]);
  });

  it('GET /projects/{id}/trackers/legacy-github/issues serves the FE panel', async () => {
    const projectId = await seedLegacyProject({ gitRepo: 'acme/widgets' });
    lambdaMock.on(InvokeCommand).resolves(
      sourceControlResponse({
        items: [trackerIssueFixture()],
        page: 1,
        perPage: 30,
        hasNext: false,
        hasPrev: false,
        totalCount: null,
      }),
    );

    const res = await handler({
      httpMethod: 'GET',
      path: `/projects/${projectId}/trackers/legacy-github/issues`,
      pathParameters: { projectId, bindingId: 'legacy-github' },
      headers: { origin: 'https://example.com' },
      ...claims(),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ resourceId: '42', title: 'Add login flow' });
    expect(sourceControlRequest()).toMatchObject({
      projectId,
      repo: 'acme/widgets',
      operation: 'list-issues',
    });
  });

  it('GET .../legacy-github/issues/{rid}/comments works', async () => {
    const projectId = await seedLegacyProject({ gitRepo: 'acme/widgets' });
    lambdaMock.on(InvokeCommand).resolves(sourceControlResponse([trackerCommentFixture()]));

    const res = await handler({
      httpMethod: 'GET',
      path: `/projects/${projectId}/trackers/legacy-github/issues/42/comments`,
      pathParameters: { projectId, bindingId: 'legacy-github', resourceId: '42' },
      headers: { origin: 'https://example.com' },
      ...claims(),
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toHaveLength(1);
  });

  it('returns 404 when the project never had legacy github-issues enabled', async () => {
    // Project missing issue_integration_enabled — no synthetic binding to serve.
    const projectId = await seedProjectWithRole('owner', { gitRepo: 'a/b' });
    const res = await handler({
      httpMethod: 'GET',
      path: `/projects/${projectId}/trackers/legacy-github/issues`,
      pathParameters: { projectId, bindingId: 'legacy-github' },
      headers: { origin: 'https://example.com' },
      ...claims(),
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error).toBe('Binding not found');
  });

  it('rejects DELETE on the synthetic id with a "migrate first" hint', async () => {
    const projectId = await seedLegacyProject();
    const res = await handler({
      httpMethod: 'DELETE',
      path: `/projects/${projectId}/trackers/legacy-github`,
      pathParameters: { projectId, bindingId: 'legacy-github' },
      headers: { origin: 'https://example.com' },
      ...claims(),
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain('Migrate this project');
  });
});

// Helper for the multi-step Jira finalize flow: pulls a fresh ticket from a
// just-completed multi-resource callback so the test can POST it back. Keeps
// the inner HMAC details opaque to the assertion code.
const captureMultiResourceTicket = async () => {
  fetchMock
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'jat', refresh_token: 'jrt', expires_in: 3600 }),
      headers: makeHeaders(),
    })
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => [
        { id: JIRA_CLOUD_ID, name: 'Acme', url: `https://${JIRA_SITE_HOST}` },
        { id: 'cloud-2', name: 'Other', url: 'https://other.atlassian.net' },
      ],
      headers: makeHeaders(),
    });
  // Build a valid signed state. Signing must use the same client_secret the
  // handler reads from Secrets Manager.
  const { createHmac } = await import('node:crypto');
  const data = Buffer.from(JSON.stringify({ userId: 'user-1', ts: Date.now() })).toString(
    'base64url',
  );
  const sig = createHmac('sha256', JIRA_CLIENT_SECRET).update(data).digest('hex');
  const state = `${data}.${sig}`;

  const cb = await handler({
    httpMethod: 'GET',
    path: '/trackers/callback/jira-cloud',
    pathParameters: { provider: 'jira-cloud' },
    headers: { origin: 'https://example.com' },
    queryStringParameters: { code: 'auth-code', state },
    requestContext: { authorizer: { claims: {} } },
  });
  expect(cb.statusCode).toBe(200);
  const cbBody = JSON.parse(cb.body);
  expect(cbBody.pendingChoice).toBeDefined();
  return cbBody.pendingChoice;
};

describe('Jira Cloud — /trackers/auth/jira-cloud', () => {
  it('returns a signed authorize URL for an authenticated user', async () => {
    const res = await handler({
      httpMethod: 'GET',
      path: '/trackers/auth/jira-cloud',
      pathParameters: { provider: 'jira-cloud' },
      headers: { origin: 'https://example.com' },
      ...claims(),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.url).toContain('https://auth.atlassian.com/authorize');
    expect(body.url).toContain(`client_id=${JIRA_CLIENT_ID}`);
    expect(body.url).toContain('state=');
  });

  it('returns 401 without a Cognito JWT', async () => {
    const res = await handler({
      httpMethod: 'GET',
      path: '/trackers/auth/jira-cloud',
      pathParameters: { provider: 'jira-cloud' },
      headers: { origin: 'https://example.com' },
      requestContext: { authorizer: { claims: {} } },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 503 when the Jira OAuth secret is missing client_id/client_secret', async () => {
    secretsMock.on(GetSecretValueCommand).resolves({ SecretString: '{}' });
    const res = await handler({
      httpMethod: 'GET',
      path: '/trackers/auth/jira-cloud',
      pathParameters: { provider: 'jira-cloud' },
      headers: { origin: 'https://example.com' },
      ...claims(),
    });
    expect(res.statusCode).toBe(503);
  });
});

describe('Jira Cloud — /trackers/callback/jira-cloud', () => {
  it('persists immediately when accessible-resources returns one site', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'jat', refresh_token: 'jrt', expires_in: 3600 }),
        headers: makeHeaders(),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [{ id: JIRA_CLOUD_ID, name: 'Acme', url: `https://${JIRA_SITE_HOST}` }],
        headers: makeHeaders(),
      });

    const { createHmac } = await import('node:crypto');
    const data = Buffer.from(JSON.stringify({ userId: 'user-1', ts: Date.now() })).toString(
      'base64url',
    );
    const sig = createHmac('sha256', JIRA_CLIENT_SECRET).update(data).digest('hex');
    const state = `${data}.${sig}`;

    const res = await handler({
      httpMethod: 'GET',
      path: '/trackers/callback/jira-cloud',
      pathParameters: { provider: 'jira-cloud' },
      headers: { origin: 'https://example.com' },
      queryStringParameters: { code: 'auth-code', state },
      requestContext: { authorizer: { claims: {} } },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ success: true });
    expect(ssmMock).toHaveReceivedCommand(PutParameterCommand);
    expect(ddbMock).toHaveReceivedCommandWith(PutCommand, {
      TableName: TRACKER_TABLE,
      Item: expect.objectContaining({ oauthClientId: JIRA_CLIENT_ID }),
    });
  });

  it('returns pendingChoice and writes nothing for >1 site', async () => {
    const initialPuts = ssmMock.commandCalls(PutParameterCommand).length;
    const choice = await captureMultiResourceTicket();
    expect(choice.ticket).toBeTruthy();
    expect(choice.resources).toHaveLength(2);
    expect(choice.resources[0]).toMatchObject({ cloudId: JIRA_CLOUD_ID, name: 'Acme' });
    expect(ssmMock.commandCalls(PutParameterCommand).length).toBe(initialPuts);
  });

  it('rejects an invalid state', async () => {
    const res = await handler({
      httpMethod: 'GET',
      path: '/trackers/callback/jira-cloud',
      pathParameters: { provider: 'jira-cloud' },
      headers: { origin: 'https://example.com' },
      queryStringParameters: { code: 'auth-code', state: 'bogus.signature' },
      requestContext: { authorizer: { claims: {} } },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a state envelope older than STATE_TTL_MS', async () => {
    // Sign a valid envelope, but with a `ts` 11 minutes in the past (TTL is
    // 10 min). The signature is correct; verifyEnvelope must still reject.
    const { createHmac } = await import('node:crypto');
    const elevenMinutesAgo = Date.now() - 11 * 60 * 1000;
    const data = Buffer.from(JSON.stringify({ userId: 'user-1', ts: elevenMinutesAgo })).toString(
      'base64url',
    );
    const sig = createHmac('sha256', JIRA_CLIENT_SECRET).update(data).digest('hex');
    const state = `${data}.${sig}`;

    const res = await handler({
      httpMethod: 'GET',
      path: '/trackers/callback/jira-cloud',
      pathParameters: { provider: 'jira-cloud' },
      headers: { origin: 'https://example.com' },
      queryStringParameters: { code: 'auth-code', state },
      requestContext: { authorizer: { claims: {} } },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/Invalid or expired state/);
    // No token exchange should have been attempted on a stale state.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 400 when accessible-resources is empty', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'jat', refresh_token: 'jrt', expires_in: 3600 }),
        headers: makeHeaders(),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [],
        headers: makeHeaders(),
      });

    const { createHmac } = await import('node:crypto');
    const data = Buffer.from(JSON.stringify({ userId: 'user-1', ts: Date.now() })).toString(
      'base64url',
    );
    const sig = createHmac('sha256', JIRA_CLIENT_SECRET).update(data).digest('hex');
    const state = `${data}.${sig}`;

    const res = await handler({
      httpMethod: 'GET',
      path: '/trackers/callback/jira-cloud',
      pathParameters: { provider: 'jira-cloud' },
      headers: { origin: 'https://example.com' },
      queryStringParameters: { code: 'auth-code', state },
      requestContext: { authorizer: { claims: {} } },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('Jira Cloud — POST /trackers/connections/jira-cloud/cloud', () => {
  it('finalizes the connection from a valid ticket', async () => {
    const choice = await captureMultiResourceTicket();
    // Re-list accessible-resources during finalize to validate the chosen cloudId.
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => [
        { id: JIRA_CLOUD_ID, name: 'Acme', url: `https://${JIRA_SITE_HOST}` },
        { id: 'cloud-2', name: 'Other', url: 'https://other.atlassian.net' },
      ],
      headers: makeHeaders(),
    });

    const res = await handler({
      httpMethod: 'POST',
      path: '/trackers/connections/jira-cloud/cloud',
      pathParameters: { provider: 'jira-cloud', instance: 'cloud' },
      headers: { origin: 'https://example.com' },
      body: JSON.stringify({ ticket: choice.ticket, cloudId: JIRA_CLOUD_ID }),
      ...claims(),
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ success: true });
    expect(ssmMock).toHaveReceivedCommand(PutParameterCommand);
    expect(ddbMock).toHaveReceivedCommandWith(PutCommand, {
      TableName: TRACKER_TABLE,
      Item: expect.objectContaining({ oauthClientId: JIRA_CLIENT_ID }),
    });
  });

  it('rejects a ticket issued to a previous client even when its secret is unchanged', async () => {
    const choice = await captureMultiResourceTicket();
    fetchMock.mockClear();
    secretsMock.on(GetSecretValueCommand).resolves({
      SecretString: JSON.stringify({
        client_id: 'replacement-client',
        client_secret: JIRA_CLIENT_SECRET,
      }),
    });
    const res = await handler({
      httpMethod: 'POST',
      path: '/trackers/connections/jira-cloud/cloud',
      pathParameters: { provider: 'jira-cloud', instance: 'cloud' },
      headers: { origin: 'https://example.com' },
      body: JSON.stringify({ ticket: choice.ticket, cloudId: JIRA_CLOUD_ID }),
      ...claims(),
    });
    expect(res.statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(ssmMock).not.toHaveReceivedCommand(PutParameterCommand);
    expect(ddbMock).not.toHaveReceivedCommand(PutCommand);
  });

  it('rejects a ticket whose userId does not match the caller', async () => {
    const choice = await captureMultiResourceTicket();
    const res = await handler({
      httpMethod: 'POST',
      path: '/trackers/connections/jira-cloud/cloud',
      pathParameters: { provider: 'jira-cloud', instance: 'cloud' },
      headers: { origin: 'https://example.com' },
      body: JSON.stringify({ ticket: choice.ticket, cloudId: JIRA_CLOUD_ID }),
      ...claims('intruder'),
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when the cloudId does not match any accessible resource', async () => {
    const choice = await captureMultiResourceTicket();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => [{ id: JIRA_CLOUD_ID, name: 'Acme', url: `https://${JIRA_SITE_HOST}` }],
      headers: makeHeaders(),
    });
    const res = await handler({
      httpMethod: 'POST',
      path: '/trackers/connections/jira-cloud/cloud',
      pathParameters: { provider: 'jira-cloud', instance: 'cloud' },
      headers: { origin: 'https://example.com' },
      body: JSON.stringify({ ticket: choice.ticket, cloudId: 'cloud-not-yours' }),
      ...claims(),
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('Jira Cloud — DELETE /trackers/jira-cloud/cloud', () => {
  it('deletes the SSM param and tracker-connections row', async () => {
    ddbMock
      .on(GetCommand, {
        TableName: TRACKER_TABLE,
        Key: { userId: 'user-1', providerInstance: 'jira-cloud#cloud' },
      })
      .resolves({
        Item: {
          userId: 'user-1',
          providerInstance: 'jira-cloud#cloud',
          parameterName: JIRA_PARAM_NAME,
        },
      });

    const res = await handler({
      httpMethod: 'DELETE',
      path: '/trackers/jira-cloud/cloud',
      pathParameters: { provider: 'jira-cloud', instance: 'cloud' },
      headers: { origin: 'https://example.com' },
      ...claims(),
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ success: true });
    expect(ssmMock).toHaveReceivedCommand(DeleteParameterCommand);
    expect(ddbMock).toHaveReceivedCommand(DeleteCommand);
  });
});

describe('Jira Cloud — POST /projects/{id}/trackers connection check', () => {
  it('rejects creating a jira-cloud binding when no connection exists', async () => {
    const projectId = await seedProjectWithRole('owner');
    ddbMock
      .on(GetCommand, {
        TableName: TRACKER_TABLE,
        Key: { userId: 'user-1', providerInstance: 'jira-cloud#cloud' },
      })
      .resolves({});
    const res = await handler({
      httpMethod: 'POST',
      path: `/projects/${projectId}/trackers`,
      pathParameters: { projectId },
      headers: { origin: 'https://example.com' },
      body: JSON.stringify({
        provider: 'jira-cloud',
        confirmDelegation: true,
        instance: 'cloud',
        externalProjectKey: 'PROJ',
      }),
      ...claims(),
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('Jira Cloud not connected');
  });

  it('creates a jira-cloud binding when a connection exists', async () => {
    fetchMock.mockResolvedValue(okResponse({ id: '10000', key: 'PROJ' }));
    ssmMock.on(GetParameterCommand).resolves({
      Parameter: {
        Value: JSON.stringify({
          accessToken: 'jira-delegated',
          expiresAt: NOW.getTime() + 3600000,
        }),
      },
    });
    const projectId = await seedProjectWithRole('owner');
    const submit = vi.spyOn(gremlin.driver.DriverRemoteConnection.prototype, 'submit');
    ddbMock
      .on(GetCommand, {
        TableName: TRACKER_TABLE,
        Key: { userId: 'user-1', providerInstance: 'jira-cloud#cloud' },
      })
      .resolves({
        Item: {
          userId: 'user-1',
          providerInstance: 'jira-cloud#cloud',
          parameterName: JIRA_PARAM_NAME,
          cloudId: JIRA_CLOUD_ID,
          oauthClientId: JIRA_CLIENT_ID,
          scope: 'read:jira-work write:jira-work',
          baseUrl: `https://api.atlassian.com/ex/jira/${JIRA_CLOUD_ID}`,
        },
      });
    const res = await handler({
      httpMethod: 'POST',
      path: `/projects/${projectId}/trackers`,
      pathParameters: { projectId },
      headers: { origin: 'https://example.com' },
      body: JSON.stringify({
        provider: 'jira-cloud',
        confirmDelegation: true,
        instance: 'cloud',
        externalProjectKey: 'PROJ',
        displayName: 'Project',
      }),
      ...claims(),
    });
    expect(res.statusCode).toBe(201);
    expectSingleCardinalityWrites(submit, [
      'id',
      'provider',
      'instance',
      'display_name',
      'created_at',
      'created_by',
      ...DELEGATION_KEYS,
    ]);
    expect(JSON.parse(res.body)).toMatchObject({
      provider: 'jira-cloud',
      instance: 'cloud',
      externalProjectKey: 'PROJ',
    });
  });
});

describe('Jira Cloud — GET /trackers/external-projects/jira-cloud/cloud', () => {
  it('proxies through the provider and returns the project list', async () => {
    ddbMock
      .on(GetCommand, {
        TableName: TRACKER_TABLE,
        Key: { userId: 'user-1', providerInstance: 'jira-cloud#cloud' },
      })
      .resolves({
        Item: {
          userId: 'user-1',
          providerInstance: 'jira-cloud#cloud',
          parameterName: JIRA_PARAM_NAME,
          cloudId: JIRA_CLOUD_ID,
          baseUrl: `https://api.atlassian.com/ex/jira/${JIRA_CLOUD_ID}`,
          siteHost: JIRA_SITE_HOST,
          oauthClientId: JIRA_CLIENT_ID,
          expiresAt: NOW.getTime() + 3600 * 1000,
        },
      });
    ssmMock.on(GetParameterCommand, { Name: JIRA_PARAM_NAME }).resolves({
      Parameter: {
        Value: JSON.stringify({
          accessToken: 'jat',
          refreshToken: 'jrt',
          expiresAt: NOW.getTime() + 3600 * 1000,
        }),
      },
    });
    fetchMock.mockResolvedValueOnce(okResponse({ values: [{ key: 'PROJ', name: 'Project' }] }));

    const res = await handler({
      httpMethod: 'GET',
      path: '/trackers/external-projects/jira-cloud/cloud',
      pathParameters: { provider: 'jira-cloud', instance: 'cloud' },
      headers: { origin: 'https://example.com' },
      ...claims(),
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual([{ key: 'PROJ', name: 'Project', displayKey: 'PROJ' }]);
    expect(fetchMock.mock.calls[0][0]).toContain('/rest/api/3/project/search');
  });

  it('returns 400 NOT_CONNECTED when no row exists', async () => {
    ddbMock
      .on(GetCommand, {
        TableName: TRACKER_TABLE,
        Key: { userId: 'user-1', providerInstance: 'jira-cloud#cloud' },
      })
      .resolves({});
    const res = await handler({
      httpMethod: 'GET',
      path: '/trackers/external-projects/jira-cloud/cloud',
      pathParameters: { provider: 'jira-cloud', instance: 'cloud' },
      headers: { origin: 'https://example.com' },
      ...claims(),
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({ reconnect: true });
  });
});

describe('GET /trackers/providers — operator OAuth-config status', () => {
  it('reports configured: true for all providers when their secrets are populated', async () => {
    const res = await handler({
      httpMethod: 'GET',
      path: '/trackers/providers',
      pathParameters: null,
      headers: { origin: 'https://example.com' },
      ...claims(),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const ids = body.map((p) => p.id);
    expect(ids).toContain('github-issues');
    expect(ids).toContain('gitlab-issues');
    expect(ids).toContain('jira-cloud');
    for (const p of body) {
      expect(p.configured).toBe(true);
    }
  });

  it('reports configured: false for a provider whose secret is missing', async () => {
    secretsMock
      .on(GetSecretValueCommand, { SecretId: JIRA_OAUTH_SECRET_NAME })
      .rejects({ name: 'ResourceNotFoundException' });
    secretsMock.on(GetSecretValueCommand, { SecretId: GITHUB_OAUTH_SECRET_NAME }).resolves({
      SecretString: JSON.stringify({ client_id: 'g', client_secret: 's' }),
    });
    const res = await handler({
      httpMethod: 'GET',
      path: '/trackers/providers',
      pathParameters: null,
      headers: { origin: 'https://example.com' },
      ...claims(),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const jira = body.find((p) => p.id === 'jira-cloud');
    const github = body.find((p) => p.id === 'github-issues');
    expect(jira.configured).toBe(false);
    expect(github.configured).toBe(true);
  });

  it('reports configured: false for malformed JSON', async () => {
    secretsMock
      .on(GetSecretValueCommand, { SecretId: JIRA_OAUTH_SECRET_NAME })
      .resolves({ SecretString: 'not-json' });
    const res = await handler({
      httpMethod: 'GET',
      path: '/trackers/providers',
      pathParameters: null,
      headers: { origin: 'https://example.com' },
      ...claims(),
    });
    const jira = JSON.parse(res.body).find((p) => p.id === 'jira-cloud');
    expect(jira.configured).toBe(false);
  });

  it('reports configured: false when client_id / client_secret keys are missing', async () => {
    secretsMock
      .on(GetSecretValueCommand, { SecretId: JIRA_OAUTH_SECRET_NAME })
      .resolves({ SecretString: '{}' });
    const res = await handler({
      httpMethod: 'GET',
      path: '/trackers/providers',
      pathParameters: null,
      headers: { origin: 'https://example.com' },
      ...claims(),
    });
    const jira = JSON.parse(res.body).find((p) => p.id === 'jira-cloud');
    expect(jira.configured).toBe(false);
  });

  it('returns 401 without a Cognito JWT', async () => {
    const res = await handler({
      httpMethod: 'GET',
      path: '/trackers/providers',
      pathParameters: null,
      headers: { origin: 'https://example.com' },
      requestContext: { authorizer: { claims: {} } },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('PUT /trackers/providers/{provider}/oauth-config — admin secret writer', () => {
  beforeEach(() => {
    secretsMock.on(PutSecretValueCommand).resolves({});
  });

  it('writes the Jira OAuth pair to the Jira secret slot', async () => {
    const res = await handler({
      httpMethod: 'PUT',
      path: '/trackers/providers/jira-cloud/oauth-config',
      pathParameters: { provider: 'jira-cloud' },
      headers: { origin: 'https://example.com' },
      body: JSON.stringify({ clientId: 'jc-id', clientSecret: 'jc-secret' }),
      ...adminClaims(),
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ success: true });
    const calls = secretsMock.commandCalls(PutSecretValueCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input.SecretId).toBe(JIRA_OAUTH_SECRET_NAME);
    expect(JSON.parse(calls[0].args[0].input.SecretString)).toEqual({
      client_id: 'jc-id',
      client_secret: 'jc-secret',
    });
  });

  it('writes the GitHub OAuth pair to the GitHub secret slot', async () => {
    const res = await handler({
      httpMethod: 'PUT',
      path: '/trackers/providers/github-issues/oauth-config',
      pathParameters: { provider: 'github-issues' },
      headers: { origin: 'https://example.com' },
      body: JSON.stringify({ clientId: 'gh-id', clientSecret: 'gh-secret' }),
      ...adminClaims(),
    });
    expect(res.statusCode).toBe(200);
    const calls = secretsMock.commandCalls(PutSecretValueCommand);
    expect(calls[0].args[0].input.SecretId).toBe(GITHUB_OAUTH_SECRET_NAME);
  });

  it('rejects an unknown provider with 400', async () => {
    const res = await handler({
      httpMethod: 'PUT',
      path: '/trackers/providers/unknown-provider/oauth-config',
      pathParameters: { provider: 'unknown-provider' },
      headers: { origin: 'https://example.com' },
      body: JSON.stringify({ clientId: 'a', clientSecret: 'b' }),
      ...adminClaims(),
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a missing clientId / clientSecret with 400', async () => {
    const res = await handler({
      httpMethod: 'PUT',
      path: '/trackers/providers/jira-cloud/oauth-config',
      pathParameters: { provider: 'jira-cloud' },
      headers: { origin: 'https://example.com' },
      body: JSON.stringify({ clientId: '', clientSecret: '' }),
      ...adminClaims(),
    });
    expect(res.statusCode).toBe(400);
    expect(secretsMock.commandCalls(PutSecretValueCommand)).toHaveLength(0);
  });

  it('rejects credentials that exceed the length cap', async () => {
    const res = await handler({
      httpMethod: 'PUT',
      path: '/trackers/providers/jira-cloud/oauth-config',
      pathParameters: { provider: 'jira-cloud' },
      headers: { origin: 'https://example.com' },
      body: JSON.stringify({ clientId: 'x', clientSecret: 'y'.repeat(2000) }),
      ...adminClaims(),
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a request without a Cognito JWT', async () => {
    const res = await handler({
      httpMethod: 'PUT',
      path: '/trackers/providers/jira-cloud/oauth-config',
      pathParameters: { provider: 'jira-cloud' },
      headers: { origin: 'https://example.com' },
      body: JSON.stringify({ clientId: 'a', clientSecret: 'b' }),
      requestContext: { authorizer: { claims: {} } },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects an authenticated non-platform-admin caller with 403', async () => {
    const res = await handler({
      httpMethod: 'PUT',
      path: '/trackers/providers/jira-cloud/oauth-config',
      pathParameters: { provider: 'jira-cloud' },
      headers: { origin: 'https://example.com' },
      body: JSON.stringify({ clientId: 'a', clientSecret: 'b' }),
      ...claims(),
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).code).toBe('PLATFORM_ADMIN_REQUIRED');
    expect(secretsMock.commandCalls(PutSecretValueCommand)).toHaveLength(0);
  });
});

describe('Unknown paths', () => {
  it('returns 404 when no route matches', async () => {
    const res = await handler({
      httpMethod: 'GET',
      path: '/something/else',
      pathParameters: null,
      headers: { origin: 'https://example.com' },
      ...claims(),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('Jira space delegation', () => {
  const jiraRow = () => ({
    userId: 'user-1',
    providerInstance: 'jira-cloud#cloud',
    parameterName: JIRA_PARAM_NAME,
    cloudId: JIRA_CLOUD_ID,
    baseUrl: `https://api.atlassian.com/ex/jira/${JIRA_CLOUD_ID}`,
    siteHost: JIRA_SITE_HOST,
    oauthClientId: JIRA_CLIENT_ID,
    scope: 'read:jira-work write:jira-work',
  });
  beforeEach(() => {
    ddbMock.on(GetCommand, { TableName: TRACKER_TABLE }).resolves({ Item: jiraRow() });
    ssmMock.on(GetParameterCommand).resolves({
      Parameter: {
        Value: JSON.stringify({
          accessToken: 'jira-delegated',
          expiresAt: NOW.getTime() + 3600000,
        }),
      },
    });
  });
  const seed = async ({ legacy = false } = {}) => {
    const ids = await seedProjectAndBinding({
      provider: 'jira-cloud',
      instance: 'cloud',
      gitRepo: 'PROJ',
    });
    if (!legacy)
      await g
        .V()
        .has('TrackerBinding', 'id', ids.bindingId)
        .property('connection_user_id', 'user-1')
        .property('cloud_id', JIRA_CLOUD_ID)
        .property('status', 'active')
        .property('delegated_at', NOW.toISOString())
        .toList();
    const member = randomUUID();
    await g
      .addV('User')
      .property('id', member)
      .as('u')
      .V()
      .has('Project', 'id', ids.projectId)
      .addE('HAS_MEMBER')
      .property('role', 'member')
      .to('u')
      .toList();
    return { ...ids, member };
  };
  const request = ({ projectId, bindingId, member }, suffix = '', method = 'GET', extra = {}) =>
    handler({
      httpMethod: method,
      path: `/projects/${projectId}/trackers/${bindingId}/issues${suffix}`,
      pathParameters: { projectId, bindingId, ...(suffix ? { resourceId: 'PROJ-1' } : {}) },
      headers: { origin: 'https://example.com' },
      ...claims(member),
      ...extra,
    });
  const boundIssue = {
    id: '1',
    key: 'PROJ-1',
    fields: { summary: 'Shared ticket', project: { id: '10000', key: 'PROJ' } },
  };

  it.each([
    ['', 'GET'],
    ['/PROJ-1', 'GET'],
    ['/PROJ-1/comments', 'GET'],
    ['/PROJ-1/comments', 'POST'],
  ])('uses the delegated connection for a member without Jira: %s %s', async (suffix, method) => {
    const ids = await seed();
    ddbMock
      .on(GetCommand, {
        TableName: TRACKER_TABLE,
        Key: { userId: ids.member, providerInstance: 'jira-cloud#cloud' },
      })
      .resolves({});
    fetchMock.mockImplementation(async (url) =>
      okResponse(
        url.includes('/comment')
          ? method === 'POST'
            ? { id: 'c1' }
            : { comments: [] }
          : url.includes('/search/jql')
            ? { issues: [boundIssue] }
            : boundIssue,
      ),
    );
    const res = await request(ids, suffix, method, {
      body: JSON.stringify({ body: 'Shared comment' }),
    });
    expect(res.statusCode).toBe(method === 'POST' ? 201 : 200);
    expect(
      ddbMock.commandCalls(GetCommand).every((call) => call.args[0].input.Key.userId === 'user-1'),
    ).toBe(true);
    expect(
      fetchMock.mock.calls.every(
        ([, init]) => init.headers.Authorization === 'Bearer jira-delegated',
      ),
    ).toBe(true);
  });

  it('imports attachments through the delegated connection for a member without Jira', async () => {
    const ids = await seed();
    ddbMock
      .on(GetCommand, {
        TableName: TRACKER_TABLE,
        Key: { userId: ids.member, providerInstance: 'jira-cloud#cloud' },
      })
      .resolves({});
    fetchMock.mockImplementation(async () =>
      okResponse({ ...boundIssue, fields: { ...boundIssue.fields, attachment: [] } }),
    );
    const result = await handler({
      action: 'issue-attachments',
      projectId: ids.projectId,
      bindingId: ids.bindingId,
      userId: ids.member,
      resourceId: 'PROJ-1',
    });
    expect(result).toEqual({ attachments: [] });
    expect(
      ddbMock.commandCalls(GetCommand).every((call) => call.args[0].input.Key.userId === 'user-1'),
    ).toBe(true);
    expect(
      fetchMock.mock.calls.every(
        ([, init]) => init.headers.Authorization === 'Bearer jira-delegated',
      ),
    ).toBe(true);
  });

  it('fails attachment import for a binding without delegation before calling Jira', async () => {
    const ids = await seed({ legacy: true });
    const result = await handler({
      action: 'issue-attachments',
      projectId: ids.projectId,
      bindingId: ids.bindingId,
      userId: ids.member,
      resourceId: 'PROJ-1',
    });
    expect(result).toMatchObject({ status: 'failed' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('denies a non-member before resolving credentials', async () => {
    const res = await request({ ...(await seed()), member: 'outsider' });
    expect(res.statusCode).toBe(403);
    expect(ddbMock).not.toHaveReceivedCommand(GetCommand);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['legacy', 'removed', 'disconnected', 'site-changed'])(
    'requires reconnection for %s bindings without falling back to the caller',
    async (reason) => {
      const ids = await seed({ legacy: reason === 'legacy' });
      if (reason === 'removed')
        await g
          .V()
          .has('Project', 'id', ids.projectId)
          .outE('HAS_MEMBER')
          .where(gremlin.process.statics.inV().has('id', 'user-1'))
          .drop()
          .toList();
      if (reason === 'disconnected')
        ddbMock.on(GetCommand, { TableName: TRACKER_TABLE }).resolves({});
      if (reason === 'site-changed')
        ddbMock
          .on(GetCommand, { TableName: TRACKER_TABLE })
          .resolves({ Item: { ...jiraRow(), cloudId: 'other-site' } });
      const submit = vi.spyOn(gremlin.driver.DriverRemoteConnection.prototype, 'submit');
      const res = await request(ids);
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).code).toBe('TRACKER_BINDING_NOT_READY');
      expect(fetchMock).not.toHaveBeenCalled();
      if (reason !== 'legacy') {
        expectSingleCardinalityWrites(submit, ['status', 'invalid_reason']);
        expect(
          (await g.V().has('TrackerBinding', 'id', ids.bindingId).values('status').next()).value,
        ).toBe('invalid');
      }
    },
  );

  it('marks bindings invalid on disconnect and does not revive them on personal reconnection', async () => {
    const ids = await seed();
    const submit = vi.spyOn(gremlin.driver.DriverRemoteConnection.prototype, 'submit');
    const res = await handler({
      httpMethod: 'DELETE',
      path: '/trackers/jira-cloud/cloud',
      pathParameters: { provider: 'jira-cloud', instance: 'cloud' },
      ...claims(),
    });
    expect(res.statusCode).toBe(200);
    expectSingleCardinalityWrites(submit, ['status', 'invalid_reason']);
    expect((await request(ids)).statusCode).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('invalidates only the removed delegator’s bindings in the affected space', async () => {
    const { invalidateTrackerBindingsByDelegator } =
      await import('../../shared/tracker-binding-delegation.js');
    const first = await seed();
    const second = await seed();
    const submit = vi.spyOn(gremlin.driver.DriverRemoteConnection.prototype, 'submit');
    await invalidateTrackerBindingsByDelegator(g, 'user-1', 'delegator_removed', first.projectId);
    expectSingleCardinalityWrites(submit, ['status', 'invalid_reason']);
    expect((await request(first)).statusCode).toBe(409);
    fetchMock.mockResolvedValue(okResponse({ issues: [] }));
    expect((await request(second)).statusCode).toBe(200);
  });

  it.each(['/OTHER-1', '/OTHER-1/comments'])(
    'denies an issue outside the bound project: %s',
    async (suffix) => {
      const ids = await seed();
      fetchMock
        .mockResolvedValueOnce(
          okResponse({ key: 'OTHER-1', fields: { project: { key: 'OTHER' } } }),
        )
        .mockResolvedValueOnce(okResponse({ projectTypeKey: 'software' }));
      const res = await request(ids, suffix, 'GET', {
        pathParameters: {
          projectId: ids.projectId,
          bindingId: ids.bindingId,
          resourceId: 'OTHER-1',
        },
      });
      expect(res.statusCode).toBe(404);
      expect(fetchMock.mock.calls.some(([url]) => url.includes('/comment'))).toBe(false);
    },
  );

  it('requires explicit delegation and verifies access before saving', async () => {
    const projectId = await seedProjectWithRole('owner');
    const event = {
      httpMethod: 'POST',
      path: `/projects/${projectId}/trackers`,
      pathParameters: { projectId },
      ...claims(),
    };
    const input = { provider: 'jira-cloud', instance: 'cloud', externalProjectKey: 'PROJ' };
    expect((await handler({ ...event, body: JSON.stringify(input) })).statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValue({ ok: false, status: 403 });
    expect(
      (await handler({ ...event, body: JSON.stringify({ ...input, confirmDelegation: true }) }))
        .statusCode,
    ).toBe(403);
    expect(await g.V().has('Project', 'id', projectId).out('HAS_TRACKER').hasNext()).toBe(false);
  });

  it('replaces the delegator and discards old values before later invalidations', async () => {
    const { invalidateTrackerBindingsByDelegator } =
      await import('../../shared/tracker-binding-delegation.js');
    const { jiraBindingContext } = await import('../jira-binding.js');
    const ids = await seed();
    const oldContext = jiraBindingContext({
      g,
      projectId: ids.projectId,
      binding: {
        id: ids.bindingId,
        connectionUserId: 'user-1',
        cloudId: JIRA_CLOUD_ID,
        delegatedAt: NOW.toISOString(),
      },
    });
    await g
      .V()
      .has('Project', 'id', ids.projectId)
      .outE('HAS_MEMBER')
      .where(gremlin.process.statics.inV().has('id', ids.member))
      .property('role', 'admin')
      .toList();
    // Explicitly seed set-valued properties: stock TinkerGraph otherwise hides
    // the old Neptune behavior by defaulting to single cardinality.
    await g
      .V()
      .has('TrackerBinding', 'id', ids.bindingId)
      .property(gremlin.process.cardinality.set, 'connection_user_id', 'retired-admin')
      .property(gremlin.process.cardinality.set, 'status', 'invalid')
      .property(gremlin.process.cardinality.set, 'external_project_key', 'OLD')
      .toList();
    ddbMock
      .on(GetCommand, { TableName: TRACKER_TABLE })
      .resolves({ Item: { ...jiraRow(), userId: ids.member } });
    fetchMock.mockResolvedValue(okResponse({ id: '10000', key: 'RENAMED' }));
    vi.setSystemTime(new Date(NOW.getTime() + 60000));
    const res = await handler({
      httpMethod: 'POST',
      path: `/projects/${ids.projectId}/trackers`,
      pathParameters: { projectId: ids.projectId },
      ...claims(ids.member),
      body: JSON.stringify({
        bindingId: ids.bindingId,
        provider: 'jira-cloud',
        instance: 'cloud',
        externalProjectKey: 'RENAMED',
        confirmDelegation: true,
      }),
    });
    expect(res.statusCode).toBe(200);
    const saved = await g.V().has('TrackerBinding', 'id', ids.bindingId).valueMap().next();
    expect(saved.value.get('connection_user_id')).toEqual([ids.member]);
    expect(saved.value.get('external_project_key')).toEqual(['RENAMED']);
    expect(saved.value.get('delegated_at')).toEqual([new Date().toISOString()]);
    expect(saved.value.get('cloud_id')).toEqual([JIRA_CLOUD_ID]);
    expect(saved.value.get('status')).toEqual(['active']);

    await invalidateTrackerBindingsByDelegator(g, 'user-1', 'oauth_disconnected');
    await expect(oldContext.onConnectionError({ code: 'NOT_CONNECTED' })).rejects.toMatchObject({
      code: 'TRACKER_BINDING_NOT_READY',
    });
    expect(
      await g.V().has('TrackerBinding', 'id', ids.bindingId).values('status').toList(),
    ).toEqual(['active']);
    fetchMock.mockResolvedValue(okResponse({ issues: [] }));
    expect((await request(ids)).statusCode).toBe(200);
  });

  it.each([true, false])('reconnects a renamed project in place (legacy=%s)', async (legacy) => {
    const ids = await seed({ legacy });
    if (!legacy) {
      await g
        .V()
        .has('TrackerBinding', 'id', ids.bindingId)
        .property('external_project_id', '10000')
        .next();
    }
    fetchMock.mockResolvedValue(okResponse({ id: '10000', key: 'RENAMED' }));
    const submit = vi.spyOn(gremlin.driver.DriverRemoteConnection.prototype, 'submit');
    const res = await handler({
      httpMethod: 'POST',
      path: `/projects/${ids.projectId}/trackers`,
      pathParameters: { projectId: ids.projectId },
      ...claims(),
      body: JSON.stringify({
        bindingId: ids.bindingId,
        provider: 'jira-cloud',
        instance: 'cloud',
        externalProjectKey: 'RENAMED',
        confirmDelegation: true,
      }),
    });
    expect(res.statusCode).toBe(200);
    expectSingleCardinalityWrites(submit, DELEGATION_KEYS);
    expect(JSON.parse(res.body)).toMatchObject({
      id: ids.bindingId,
      createdBy: 'user-1',
      connectionUserId: 'user-1',
      cloudId: JIRA_CLOUD_ID,
      externalProjectId: '10000',
      status: 'active',
    });
    expect(
      (await g.V().has('Project', 'id', ids.projectId).out('HAS_TRACKER').count().next()).value,
    ).toBe(1);
    fetchMock.mockResolvedValue(okResponse({ issues: [] }));
    expect((await request(ids)).statusCode).toBe(200);
    expect(new URL(fetchMock.mock.calls.at(-1)[0]).searchParams.get('jql')).toContain(
      'project = "10000"',
    );
  });
  it.each([false, true])(
    'scheduled delivery survives legacy delegation repair (legacy=%s)',
    async (legacy) => {
      const ids = await seed({ legacy });
      await g
        .V()
        .has('TrackerBinding', 'id', ids.bindingId)
        .property('created_by', 'old-creator')
        .next();
      const { bindingContext } = await import('../index.js');
      const { getProvider } = await import('../providers/index.js');
      const { createDeliverySynchronizer } = await import('../delivery-sync.js');
      const candidate = {
        executionId: 'execution-659',
        projectId: ids.projectId,
        intentId: 'intent-659',
        source: { bindingId: ids.bindingId, resourceId: 'PROJ-1' },
        state: 'PR_CREATED',
        attempts: 9,
        pullRequests: [
          {
            provider: 'github',
            repoId: 'acme/widgets',
            prNumber: 1,
            prUrl: 'https://github.com/acme/widgets/pull/1',
            branch: 'feat/test',
          },
        ],
      };
      const store = {
        claimTrackerSync: vi.fn(async () => ({ ...candidate })),
        updateTrackerSync: vi.fn(async ({ state, fields }) =>
          Object.assign(candidate, { state, ...fields }),
        ),
        listTrackerSyncs: vi.fn(async () =>
          ['BLOCKED', 'COMPLETED'].includes(candidate.state) ? [] : [candidate],
        ),
        appendEvent: vi.fn(async () => ({})),
      };
      fetchMock.mockImplementation(async (url, options) =>
        okResponse(
          url.includes('/comment')
            ? options.method === 'POST'
              ? { id: 'comment-659' }
              : { comments: [] }
            : url.includes('/project/')
              ? { id: '10000', key: 'PROJ' }
              : boundIssue,
        ),
      );
      const sync = createDeliverySynchronizer({
        store,
        resolveBinding: async () => {
          const response = await handler({
            httpMethod: 'GET',
            path: `/projects/${ids.projectId}/trackers`,
            pathParameters: { projectId: ids.projectId },
            ...claims(),
          });
          expect(response.statusCode).toBe(200);
          return JSON.parse(response.body).find((b) => b.id === ids.bindingId);
        },
        getTrackerProvider: getProvider,
        trackerContext: (projectId, value) => bindingContext(g, projectId, value),
        getPullRequestStatus: vi.fn(async () => ({ state: 'merged' })),
        applicationUrl: 'https://example.com',
        broadcast: vi.fn(),
      });
      if (legacy) {
        for (let poll = 0; poll < 3; poll += 1) {
          expect((await sync.runScheduled()).results[0]).toMatchObject({
            state: 'PR_CREATED',
            reconnect: true,
          });
          expect(candidate).toMatchObject({
            state: 'PR_CREATED',
            attempts: 9,
            lastError: { code: 'TRACKER_BINDING_NOT_READY', reconnect: true },
          });
        }
        expect(fetchMock).not.toHaveBeenCalled();
        expect(store.appendEvent).toHaveBeenCalledTimes(1);
        expect(store.appendEvent).toHaveBeenCalledWith(
          expect.objectContaining({ summary: 'Reconnect Jira to resume tracker synchronization' }),
        );
        const repaired = await handler({
          httpMethod: 'POST',
          path: `/projects/${ids.projectId}/trackers`,
          pathParameters: { projectId: ids.projectId },
          ...claims(),
          body: JSON.stringify({
            bindingId: ids.bindingId,
            provider: 'jira-cloud',
            instance: 'cloud',
            externalProjectKey: 'PROJ',
            confirmDelegation: true,
          }),
        });
        expect(repaired.statusCode).toBe(200);
      }
      expect((await sync.runScheduled()).results[0]).toEqual({ state: 'WAITING_FOR_MERGE' });
      expect(candidate).toMatchObject({ attempts: 0, lastError: null });
      expect((await sync.runScheduled()).results[0]).toEqual({ state: 'PR_MERGED' });
      expect((await sync.runScheduled()).results[0]).toEqual({ state: 'COMPLETED' });
      expect(fetchMock.mock.calls.filter(([, options]) => options.method === 'POST')).toHaveLength(
        2,
      );
      expect(
        ddbMock
          .commandCalls(GetCommand)
          .every((call) => call.args[0].input.Key.userId === 'user-1'),
      ).toBe(true);
    },
  );

  it('a missing write scope does not prevent other members from reading', async () => {
    const ids = await seed();
    ddbMock
      .on(GetCommand, { TableName: TRACKER_TABLE })
      .resolves({ Item: { ...jiraRow(), scope: 'read:jira-work' } });
    const response = await request(ids, '/PROJ-1/comments', 'POST', {
      body: JSON.stringify({ body: 'Delivery' }),
    });
    expect(response.statusCode).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      (await g.V().has('TrackerBinding', 'id', ids.bindingId).values('status').next()).value,
    ).toBe('active');
    fetchMock.mockResolvedValue(okResponse({ issues: [] }));
    expect((await request(ids)).statusCode).toBe(200);
  });

  it('a repeated API 401 does not invalidate a refreshable grant', async () => {
    const ids = await seed();
    fetchMock
      .mockResolvedValueOnce({ status: 401 })
      .mockResolvedValueOnce(
        okResponse({ access_token: 'fresh', refresh_token: 'refresh', expires_in: 3600 }),
      )
      .mockResolvedValueOnce({ status: 401 });
    expect((await request(ids)).statusCode).toBe(401);
    expect(
      (await g.V().has('TrackerBinding', 'id', ids.bindingId).values('status').next()).value,
    ).toBe('active');
    fetchMock.mockResolvedValue(okResponse({ issues: [] }));
    expect((await request(ids)).statusCode).toBe(200);
  });

  it.each(['invalid_grant', 'changed_client'])(
    'invalidates a confirmed unavailable grant: %s',
    async (reason) => {
      const ids = await seed();
      if (reason === 'changed_client') {
        ddbMock
          .on(GetCommand, { TableName: TRACKER_TABLE })
          .resolves({ Item: { ...jiraRow(), oauthClientId: 'old-client' } });
      } else {
        fetchMock.mockResolvedValueOnce({ status: 401 }).mockResolvedValueOnce({
          ok: false,
          status: 400,
          json: async () => ({ error: 'invalid_grant' }),
        });
      }
      expect((await request(ids)).statusCode).toBe(409);
      expect(
        (await g.V().has('TrackerBinding', 'id', ids.bindingId).values('status').next()).value,
      ).toBe('invalid');
      if (reason === 'invalid_grant')
        expect(ssmMock.commandCalls(GetParameterCommand)).toHaveLength(3);
    },
  );
});
