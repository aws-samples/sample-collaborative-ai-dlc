import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import { SSMClient } from '@aws-sdk/client-ssm';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import {
  resolveBindingCredential,
  resolveReadOnlySourceCredential,
  verifyBindingCredential,
  verifyReadOnlySourceCredential,
} from '../source-control-credentials.js';
import {
  prepareWorkflowSourceBinding,
  workflowSourceIdentity,
  workflowSourceView,
} from '../workflow-source-bindings.js';
import { createWorkflowSourceService } from '../workflow-source-service.js';

const ddbMock = mockClient(DynamoDBDocumentClient);
const ssmMock = mockClient(SSMClient);
const secretsMock = mockClient(SecretsManagerClient);
const clients = {
  ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})),
  ssm: new SSMClient({}),
  secrets: new SecretsManagerClient({}),
};
const TABLE = 'workflow-public-bindings';
const REPO = 'acme/workflows';
const CREDENTIAL_FIELDS = [
  'credentialRef',
  'credentials',
  'connectionUserId',
  'connectionCreatedAt',
  'connectionIdentity',
  'connectionDisplayName',
  'connectionFutureField',
  'installationId',
  'installationAccount',
  'token',
  'accessToken',
  'refreshToken',
  'idToken',
  'tokenType',
  'parameterName',
  'username',
  'password',
  'Authorization',
  'Cookie',
  'refresh',
];
const publicVerification = () => ({
  purpose: 'workflow-source',
  authType: 'public',
  capabilities: {
    repositoryRead: true,
    metadata: 'read',
    contents: 'read',
    pullRequests: 'none',
    issues: 'none',
    workflows: 'none',
    repositoryWrite: false,
  },
});
const membershipSnapshot = (role = 'owner', actorId = 'owner') =>
  role === null
    ? null
    : { role, membershipId: `${actorId}-edge-1`, projectIdentity: 'project-vertex-1' };
// Direct credential-domain fixtures are not membership authorization. Service
// tests below use the production snapshot port and persist graph identity pins.
const binding = (provider = 'github') =>
  prepareWorkflowSourceBinding({
    projectId: 'p1',
    provider,
    repository: REPO,
    actorId: 'owner',
    verified: publicVerification(),
  });
const branchUrl = (provider) =>
  ({
    github: 'https://api.github.com/repos/acme/workflows/branches?per_page=100',
    gitlab: 'https://gitlab.com/api/v4/projects/acme%2Fworkflows/repository/branches?per_page=100',
    bitbucket:
      'https://api.bitbucket.org/2.0/repositories/acme/workflows/refs/branches?pagelen=100',
  })[provider];
const branches = (provider) =>
  Response.json(
    provider === 'bitbucket'
      ? { values: [{ name: 'main' }], next: 'https://unrelated.invalid/private' }
      : [{ name: 'main' }],
  );
const expectCredentialFree = (value) => {
  for (const key of CREDENTIAL_FIELDS) expect(value).not.toHaveProperty(key);
};
const expectAnonymousRequest = (fetchMock, provider) => {
  expect(fetchMock).toHaveBeenCalled();
  for (const [url, options] of fetchMock.mock.calls) {
    expect(url).toBe(branchUrl(provider));
    expect(options).toMatchObject({
      method: 'GET',
      credentials: 'omit',
      redirect: 'error',
      signal: expect.any(AbortSignal),
    });
    expect(new Headers(options.headers).has('authorization')).toBe(false);
    expect(new Headers(options.headers).has('cookie')).toBe(false);
  }
};
const configureRequest = (provider = 'github') => ({
  projectId: 'p1',
  actorId: 'owner',
  selection: { provider, repository: REPO, authType: 'public' },
  expectedRevision: null,
});
const selected = (view, actorId = 'member') => ({
  projectId: 'p1',
  actorId,
  sourceId: view.sourceId,
  expectedRevision: view.revision,
});
let row;
let unexpectedIo;

beforeEach(() => {
  row = undefined;
  unexpectedIo = [];
  ddbMock.reset();
  ssmMock.reset();
  secretsMock.reset();
  vi.stubEnv('WORKFLOW_SOURCE_BINDINGS_TABLE', TABLE);
  vi.stubEnv('GIT_PROVIDER_CONNECTIONS_TABLE', 'private-connections');
  vi.stubEnv('GIT_CONNECTIONS_TABLE', 'legacy-private-connections');
  vi.stubEnv('SOURCE_CONTROL_BINDINGS_TABLE', 'application-bindings');
  ddbMock.onAnyCommand().callsFake((input) => {
    unexpectedIo.push(input.TableName);
    throw new Error('Public source attempted unexpected DynamoDB access');
  });
  // Only the workflow-source service may use storage. Credential helpers must
  // make zero DDB calls. Evaluate actual source revision conditions on writes.
  ddbMock.on(GetCommand, { TableName: TABLE }).callsFake(async ({ Key }) => ({
    Item:
      row?.projectId === Key.projectId && row?.sourceId === Key.sourceId
        ? structuredClone(row)
        : undefined,
  }));
  ddbMock.on(PutCommand, { TableName: TABLE }).callsFake(async (input) => {
    const matches =
      input.ConditionExpression === 'attribute_not_exists(sourceId)'
        ? !row
        : input.ConditionExpression === '#revision = :expected' &&
          row?.revision === input.ExpressionAttributeValues[':expected'];
    if (!matches) {
      throw Object.assign(new Error('Source revision changed'), {
        name: 'ConditionalCheckFailedException',
      });
    }
    row = structuredClone(input.Item);
    return {};
  });
  ddbMock.on(QueryCommand, { TableName: TABLE }).callsFake(async (input) => ({
    Items:
      row?.projectId === input.ExpressionAttributeValues[':project'] ? [structuredClone(row)] : [],
  }));
  ssmMock.onAnyCommand().rejects(new Error('Public source attempted SSM access'));
  secretsMock.onAnyCommand().rejects(new Error('Public source attempted secret access'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  expect(unexpectedIo).toEqual([]);
  expect(ssmMock.calls()).toHaveLength(0);
  expect(secretsMock.calls()).toHaveLength(0);
});

describe.each(['github', 'gitlab', 'bitbucket'])('%s public workflow source', (provider) => {
  it('verifies and resolves anonymously without consent or credential storage access', async () => {
    const fetchMock = vi.fn(async () => branches(provider));
    const verified = await verifyReadOnlySourceCredential({
      ...clients,
      provider,
      repo: REPO,
      authType: 'public',
      fetchImpl: fetchMock,
    });
    expect(verified).toEqual(publicVerification());
    expectCredentialFree(verified);
    const stored = prepareWorkflowSourceBinding({
      projectId: 'p1',
      provider,
      repository: REPO,
      actorId: 'owner',
      verified,
    });
    expectCredentialFree(stored);
    expectCredentialFree(workflowSourceView(stored));
    expect(stored.sourceId).toBe(workflowSourceIdentity(provider, REPO).sourceId);

    await expect(
      resolveReadOnlySourceCredential({
        ...clients,
        binding: stored,
        fetchImpl: fetchMock,
      }),
    ).resolves.toEqual({ purpose: 'workflow-source', token: null });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expectAnonymousRequest(fetchMock, provider);
    expect(ddbMock.calls()).toHaveLength(0);
  });

  it.each([401, 403, 404, 429, 302])(
    'fails closed on HTTP %i without using OAuth or following redirects',
    async (status) => {
      const fetchMock = vi.fn(async () =>
        Response.json(
          { message: 'private provider detail' },
          { status, headers: { Location: 'https://unrelated.invalid/private' } },
        ),
      );
      await expect(
        resolveReadOnlySourceCredential({
          ...clients,
          binding: binding(provider),
          fetchImpl: fetchMock,
        }),
      ).rejects.toMatchObject({
        code: 'INSUFFICIENT_REPOSITORY_ACCESS',
        status,
        message: 'Workflow source repository read access could not be verified',
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expectAnonymousRequest(fetchMock, provider);
      expect(ddbMock.calls()).toHaveLength(0);
    },
  );

  it('rejects a private URL before any I/O instead of treating it as a source identity', async () => {
    const fetchMock = vi.fn();
    await expect(
      verifyReadOnlySourceCredential({
        ...clients,
        provider,
        repo: 'https://user:secret@private.invalid/acme/workflows',
        authType: 'public',
        fetchImpl: fetchMock,
      }),
    ).rejects.toMatchObject({ code: 'BINDING_INVALID' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(ddbMock.calls()).toHaveLength(0);
  });

  it('requires a valid repository response and accepts a confirmed empty branch list', async () => {
    const fetchMock = vi.fn(async () => Response.json({ message: 'not a branch response' }));
    await expect(
      resolveReadOnlySourceCredential({
        ...clients,
        binding: binding(provider),
        fetchImpl: fetchMock,
      }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_REPOSITORY_ACCESS' });
    fetchMock.mockImplementation(async () =>
      Response.json(provider === 'bitbucket' ? { values: [] } : []),
    );
    await expect(
      resolveReadOnlySourceCredential({
        ...clients,
        binding: binding(provider),
        fetchImpl: fetchMock,
      }),
    ).resolves.toEqual({ purpose: 'workflow-source', token: null });
    expect(ddbMock.calls()).toHaveLength(0);
  });

  it.each(['headers', 'body'])(
    'bounds stalled anonymous %s reads to ten seconds',
    async (phase) => {
      vi.useFakeTimers();
      const never = new Promise(() => {});
      const fetchMock = vi.fn(async () =>
        phase === 'headers' ? never : { ok: true, status: 200, json: () => never },
      );
      const result = resolveReadOnlySourceCredential({
        ...clients,
        binding: binding(provider),
        fetchImpl: fetchMock,
      });
      const rejected = expect(result).rejects.toMatchObject({
        code: 'INSUFFICIENT_REPOSITORY_ACCESS',
      });
      await vi.advanceTimersByTimeAsync(10_000);
      await rejected;
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
      expect(ddbMock.calls()).toHaveLength(0);
    },
  );

  it.each(['owner', 'admin'])(
    'lets an %s configure and a member select without a delegator connection',
    async (role) => {
      const fetchMock = vi.fn(async () => branches(provider));
      vi.stubGlobal('fetch', fetchMock);
      const roles = { owner: role, member: 'member' };
      const membership = vi.fn(async (_project, actor) =>
        membershipSnapshot(roles[actor] ?? null, actor),
      );
      const service = createWorkflowSourceService({
        ...clients,
        getMembershipSnapshot: membership,
      });
      const view = await service.configure(configureRequest(provider));
      expect(view).toMatchObject({
        provider,
        authType: 'public',
        access: 'read',
        status: 'active',
      });
      expectCredentialFree(row);
      expectCredentialFree(view);
      expect(row.projectIdentity).toBe('project-vertex-1');
      expect(row).not.toHaveProperty('delegatorMembershipIdentity');
      expect(view).not.toHaveProperty('projectIdentity');
      // Audit attribution does not make the creator a public-source delegator.
      roles.owner = null;
      membership.mockClear();
      const authorized = await service.getAuthorizedBinding(selected(view));
      expect(membership.mock.calls).toEqual([['p1', 'member']]);
      expect(await service.list({ projectId: 'p1', actorId: 'member' })).toEqual([view]);
      const reads = ddbMock.calls().length;
      await expect(
        resolveReadOnlySourceCredential({ ...clients, binding: authorized }),
      ).resolves.toEqual({ purpose: 'workflow-source', token: null });
      expect(ddbMock.calls()).toHaveLength(reads);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expectAnonymousRequest(fetchMock, provider);
    },
  );

  it('rechecks public visibility at intake and never uses credentials when the source becomes private', async () => {
    const fetchMock = vi.fn(async () => branches(provider));
    vi.stubGlobal('fetch', fetchMock);
    const service = createWorkflowSourceService({
      ...clients,
      getMembershipSnapshot: async (_project, actor) => membershipSnapshot('owner', actor),
    });
    const view = await service.configure(configureRequest(provider));
    const authorized = await service.getAuthorizedBinding(selected(view, 'owner'));
    const reads = ddbMock.calls().length;
    fetchMock.mockImplementation(async () =>
      Response.json({ message: 'private' }, { status: 404 }),
    );
    await expect(
      resolveReadOnlySourceCredential({ ...clients, binding: authorized }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_REPOSITORY_ACCESS', status: 404 });
    expect(ddbMock.calls()).toHaveLength(reads);
    expect(row.revision).toBe(view.revision);
    expectCredentialFree(row);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(['read', 'write'])(
    'cannot enter the application credential resolver for %s access',
    async (requiredAccess) => {
      const fetchMock = vi.fn();
      for (const purpose of ['workflow-source', 'application']) {
        await expect(
          resolveBindingCredential({
            ...clients,
            binding: { ...binding(provider), purpose, capabilities: { repositoryWrite: true } },
            requiredAccess,
            fetchImpl: fetchMock,
          }),
        ).rejects.toMatchObject({ code: 'BINDING_INVALID' });
      }
      await expect(
        verifyBindingCredential({
          ...clients,
          provider,
          repo: REPO,
          authType: 'public',
          userId: 'owner',
        }),
      ).rejects.toThrow(/Invalid auth type/);
      expect(ddbMock.calls()).toHaveLength(0);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});

describe('public source validation and project authority', () => {
  it.each(CREDENTIAL_FIELDS)(
    'rejects mixed public credential field %s, including undefined values',
    async (field) => {
      for (const value of ['must-not-be-used', undefined]) {
        expect(() =>
          prepareWorkflowSourceBinding({
            projectId: 'p1',
            provider: 'github',
            repository: REPO,
            actorId: 'owner',
            verified: { ...publicVerification(), [field]: value },
          }),
        ).toThrow(/must not contain credential fields/);
        const fetchMock = vi.fn();
        await expect(
          resolveReadOnlySourceCredential({
            ...clients,
            binding: { ...binding(), [field]: value },
            fetchImpl: fetchMock,
          }),
        ).rejects.toMatchObject({ code: 'BINDING_INVALID' });
        expect(fetchMock).not.toHaveBeenCalled();
      }
      expect(ddbMock.calls()).toHaveLength(0);
    },
  );

  it.each([undefined, null, 'anonymous', 'github-public'])(
    'does not infer public authentication from %s',
    async (authType) => {
      const fetchMock = vi.fn();
      await expect(
        verifyReadOnlySourceCredential({
          ...clients,
          provider: 'github',
          repo: REPO,
          authType,
          fetchImpl: fetchMock,
        }),
      ).rejects.toMatchObject({ code: 'BINDING_INVALID' });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(ddbMock.calls()).toHaveLength(0);
    },
  );

  it.each(['member', null, 'unknown'])(
    'rejects configuration and removal by %s before any source I/O',
    async (role) => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const service = createWorkflowSourceService({
        ...clients,
        getMembershipSnapshot: async (_project, actor) => membershipSnapshot(role, actor),
      });
      await expect(service.configure(configureRequest())).rejects.toMatchObject({
        code: 'WORKFLOW_SOURCE_FORBIDDEN',
      });
      await expect(service.remove(selected(binding()))).rejects.toMatchObject({
        code: 'WORKFLOW_SOURCE_FORBIDDEN',
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(ddbMock.calls()).toHaveLength(0);
    },
  );

  it('rechecks the configuring role after anonymous verification', async () => {
    const membership = vi
      .fn()
      .mockResolvedValueOnce(membershipSnapshot('owner'))
      .mockResolvedValueOnce(membershipSnapshot('member'));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => branches('github')),
    );
    const service = createWorkflowSourceService({
      ...clients,
      getMembershipSnapshot: membership,
    });
    await expect(service.configure(configureRequest())).rejects.toMatchObject({
      code: 'WORKFLOW_SOURCE_FORBIDDEN',
    });
    expect(row).toBeUndefined();
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  it('retains source identity and revision checks across reconfiguration and removal', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => branches('github')),
    );
    const service = createWorkflowSourceService({
      ...clients,
      getMembershipSnapshot: async (_project, actor) =>
        membershipSnapshot(actor === 'owner' ? 'owner' : 'member', actor),
    });
    const first = await service.configure(configureRequest());
    const second = await service.configure({
      ...configureRequest(),
      expectedRevision: first.revision,
    });
    expect(second.sourceId).toBe(first.sourceId);
    expect(second.revision).not.toBe(first.revision);
    await expect(service.getAuthorizedBinding(selected(first))).rejects.toMatchObject({
      code: 'WORKFLOW_SOURCE_CONFLICT',
    });
    expect((await service.getAuthorizedBinding(selected(second))).authType).toBe('public');
    await service.remove(selected(second, 'owner'));
    expect(await service.list({ projectId: 'p1', actorId: 'member' })).toEqual([]);
    expect(row.status).toBe('deleted');
    expectCredentialFree(row);
  });

  it('cannot overwrite a concurrent source configuration after a slow public probe', async () => {
    const started = Promise.withResolvers();
    const release = Promise.withResolvers();
    const fetchMock = vi
      .fn(async () => branches('github'))
      .mockImplementationOnce(async () => {
        started.resolve();
        await release.promise;
        return branches('github');
      });
    vi.stubGlobal('fetch', fetchMock);
    const service = createWorkflowSourceService({
      ...clients,
      getMembershipSnapshot: async (_project, actor) => membershipSnapshot('owner', actor),
    });
    const delayed = service.configure(configureRequest());
    await started.promise;
    const winner = await service.configure(configureRequest());
    release.resolve();
    await expect(delayed).rejects.toMatchObject({ code: 'WORKFLOW_SOURCE_CONFLICT' });
    expect(row.revision).toBe(winner.revision);
    expectCredentialFree(row);
  });
});
