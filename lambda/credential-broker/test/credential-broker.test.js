import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { SSMClient, GetParameterCommand, PutParameterCommand } from '@aws-sdk/client-ssm';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import {
  CREDENTIAL_ACTIVE_EXECUTION_STATUSES,
  authorizeCredentialRequest,
  executionIncludesRepository,
} from '../index.js';

const ddbMock = mockClient(DynamoDBDocumentClient);
const ssmMock = mockClient(SSMClient);
const secretsMock = mockClient(SecretsManagerClient);
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ssm = new SSMClient({});
const secrets = new SecretsManagerClient({});

describe('credential broker authorization', () => {
  beforeEach(() => {
    ddbMock.reset();
    vi.stubEnv('V2_PROCESS_TABLE', 'process');
    vi.stubEnv('SOURCE_CONTROL_BINDINGS_TABLE', 'bindings');
  });

  it('requires the repository and provider to be on the execution snapshot', () => {
    const meta = {
      gitProvider: 'github',
      repos: ['Acme/API', { url: 'group/web', provider: 'gitlab' }],
    };
    expect(executionIncludesRepository(meta, 'github', 'acme/api')).toBe(true);
    expect(executionIncludesRepository(meta, 'gitlab', 'group/web')).toBe(true);
    expect(executionIncludesRepository(meta, 'github', 'group/web')).toBe(false);
    expect(executionIncludesRepository(meta, 'github', 'acme/other')).toBe(false);
  });

  it('supports the explicit per-repository provider snapshot', () => {
    const meta = {
      gitProvider: 'github',
      repos: ['group/web'],
      repoProviders: { 'group/web': 'gitlab' },
    };
    expect(executionIncludesRepository(meta, 'gitlab', 'group/web')).toBe(true);
    expect(executionIncludesRepository(meta, 'github', 'group/web')).toBe(false);
  });

  it('only permits credentials while an execution can perform repository work', () => {
    expect([...CREDENTIAL_ACTIVE_EXECUTION_STATUSES]).toEqual(['CREATED', 'RUNNING']);
    for (const status of ['DRAFT', 'FAILED', 'CANCELLED', 'SUCCEEDED']) {
      expect(CREDENTIAL_ACTIVE_EXECUTION_STATUSES.has(status)).toBe(false);
    }
  });

  it.each(['DRAFT', 'FAILED', 'CANCELLED', 'SUCCEEDED'])(
    'denies credential resolution for terminal/inactive status %s',
    async (status) => {
      ddbMock.on(GetCommand, { TableName: 'process' }).resolves({
        Item: {
          projectId: 'p1',
          status,
          repos: ['acme/api'],
          gitProvider: 'github',
        },
      });
      await expect(
        authorizeCredentialRequest(
          {
            executionId: 'e1',
            projectId: 'p1',
            provider: 'github',
            repository: 'acme/api',
          },
          { ddbClient: ddb },
        ),
      ).rejects.toMatchObject({ code: 'EXECUTION_NOT_ACTIVE' });
      expect(ddbMock.commandCalls(GetCommand)).toHaveLength(1);
    },
  );

  it('denies a repository that was not snapshotted onto the execution', async () => {
    ddbMock.on(GetCommand, { TableName: 'process' }).resolves({
      Item: {
        projectId: 'p1',
        status: 'RUNNING',
        repos: ['acme/allowed'],
        gitProvider: 'github',
      },
    });
    await expect(
      authorizeCredentialRequest(
        {
          executionId: 'e1',
          projectId: 'p1',
          provider: 'github',
          repository: 'acme/other',
        },
        { ddbClient: ddb },
      ),
    ).rejects.toMatchObject({ code: 'REPOSITORY_NOT_ON_EXECUTION' });
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(1);
  });
});

describe('concurrent GitLab credential requests (refresh race)', () => {
  const PARAM = '/proj/dev/git-token/gitlab/lane-user';

  const stubTables = () => {
    // Execution snapshot for both requests.
    ddbMock.on(GetCommand, { TableName: 'process' }).resolves({
      Item: {
        projectId: 'p1',
        status: 'RUNNING',
        repos: [{ url: 'group/web', provider: 'gitlab' }],
        gitProvider: 'gitlab',
      },
    });
    // Active gitlab-oauth binding.
    ddbMock.on(GetCommand, { TableName: 'bindings' }).resolves({
      Item: {
        projectId: 'p1',
        bindingKey: 'gitlab#group/web',
        provider: 'gitlab',
        repo: 'group/web',
        authType: 'gitlab-oauth',
        status: 'active',
        connectionUserId: 'lane-user',
        credentialRef: 'oauth#gitlab#lane-user',
        capabilities: { repositoryWrite: true },
      },
    });
    // Delegated user's connection row (composite-key table).
    ddbMock.on(GetCommand, { TableName: 'provider-connections' }).resolves({
      Item: {
        userId: 'lane-user',
        providerInstance: 'gitlab#public',
        provider: 'gitlab',
        parameterName: PARAM,
        scope: 'api read_user',
      },
    });
    ddbMock.on(UpdateCommand).resolves({});
  };

  beforeEach(async () => {
    ddbMock.reset();
    ssmMock.reset();
    secretsMock.reset();
    vi.stubEnv('V2_PROCESS_TABLE', 'process');
    vi.stubEnv('SOURCE_CONTROL_BINDINGS_TABLE', 'bindings');
    vi.stubEnv('GIT_PROVIDER_CONNECTIONS_TABLE', 'provider-connections');
    vi.stubEnv('GITLAB_OAUTH_SECRET_NAME', 'test/gitlab-oauth');
    delete globalThis.fetch;
    stubTables();
    ssmMock.on(GetParameterCommand).resolves({
      Parameter: {
        Value: JSON.stringify({
          accessToken: 'stale',
          refreshToken: 'r1',
          expiresAt: Date.now() - 1000, // expired → both requests want a refresh
        }),
      },
    });
    ssmMock.on(PutParameterCommand).resolves({});
    secretsMock.on(GetSecretValueCommand).resolves({
      SecretString: JSON.stringify({ client_id: 'cid', client_secret: 'csec' }),
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    delete globalThis.fetch;
  });

  it('resolves both requests with one refresh and never invalidates the binding', async () => {
    // One-time-use refresh token: succeed once, then fail like GitLab would.
    let refreshCalls = 0;
    globalThis.fetch = vi.fn(async () => {
      refreshCalls += 1;
      if (refreshCalls === 1) {
        return {
          json: async () => ({
            access_token: 'fresh',
            refresh_token: 'r2',
            token_type: 'bearer',
            expires_in: 7200,
          }),
        };
      }
      return { status: 400, json: async () => ({ error: 'invalid_grant' }) };
    });

    const request = {
      executionId: 'e1',
      projectId: 'p1',
      provider: 'gitlab',
      repository: 'group/web',
      requiredAccess: 'write',
    };
    const [a, b] = await Promise.all([
      authorizeCredentialRequest(request, {
        ddbClient: ddb,
        ssmClient: ssm,
        secretsClient: secrets,
      }),
      authorizeCredentialRequest(request, {
        ddbClient: ddb,
        ssmClient: ssm,
        secretsClient: secrets,
      }),
    ]);

    expect(a.token).toBe('fresh');
    expect(b.token).toBe('fresh');
    expect(refreshCalls).toBe(1);
    // The losing request must NOT have marked the binding invalid.
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });
});
