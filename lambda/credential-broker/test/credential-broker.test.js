import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { SSMClient, GetParameterCommand, PutParameterCommand } from '@aws-sdk/client-ssm';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import {
  CREDENTIAL_ACTIVE_EXECUTION_STATUSES,
  authorizeAgentCredentialRequest,
  authorizeCredentialRequest,
  authorizeExecutionDataRequest,
  executionIncludesRepository,
} from '../index.js';
import {
  signAgentCredentialGrant,
  signExecutionDataGrant,
} from '../../shared/agent-credential-grants.js';

const ddbMock = mockClient(DynamoDBDocumentClient);
const ssmMock = mockClient(SSMClient);
const secretsMock = mockClient(SecretsManagerClient);
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ssm = new SSMClient({});
const secrets = new SecretsManagerClient({});

describe('execution data credential issuance and renewal', () => {
  const secret = 'd'.repeat(48);
  const start = Date.parse('2026-09-29T12:00:00Z');
  const env = {
    EXECUTION_DATA_ROLE_ARN: 'arn:aws:iam::123456789012:role/execution-data',
  };
  const grant = signExecutionDataGrant({ executionId: 'A' }, secret, {
    now: () => start,
  });
  const sts = () => ({
    send: vi.fn(async ({ input }) => ({
      Credentials: {
        AccessKeyId: 'test-access',
        SecretAccessKey: 'test-secret',
        SessionToken: 'test-session',
        Expiration: new Date(start + input.DurationSeconds * 1000),
      },
    })),
  });

  it('tags the session with the signed execution, ignoring caller-supplied role or policy', async () => {
    const stsClient = sts();
    const ssmClient = { send: vi.fn() };
    const result = await authorizeExecutionDataRequest(
      {
        grant,
        executionId: 'A',
        policy: '*',
        roleArn: 'untrusted',
        tags: [{ Key: 'x' }],
      },
      { secret, env, stsClient, ssmClient, now: () => start },
    );
    const { input } = stsClient.send.mock.calls[0][0];
    expect(input).toEqual({
      RoleArn: env.EXECUTION_DATA_ROLE_ARN,
      RoleSessionName: 'exec-A',
      DurationSeconds: 3600,
      Tags: [{ Key: 'execution_id', Value: 'A' }],
    });
    expect(ssmClient.send).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      executionId: 'A',
      credentials: { sessionToken: 'test-session' },
    });
  });

  it.each(['6099969a-c67a-4bdd-8557-8f87350bf18d', 'A'.repeat(59)])(
    'includes the execution ID in the session name when it fits: %s',
    async (executionId) => {
      const stsClient = sts();
      await authorizeExecutionDataRequest(
        {
          executionId,
          grant: signExecutionDataGrant({ executionId }, secret, { now: () => start }),
        },
        { secret, env, stsClient, now: () => start },
      );
      expect(stsClient.send.mock.calls[0][0].input.RoleSessionName).toBe(`exec-${executionId}`);
    },
  );

  it('keeps long accepted IDs distinct within the STS session-name limit', async () => {
    const stsClient = sts();
    const executionIds = ['A'.repeat(60), `${'A'.repeat(127)}B`, `${'A'.repeat(127)}C`];
    for (const executionId of executionIds) {
      await authorizeExecutionDataRequest(
        {
          executionId,
          grant: signExecutionDataGrant({ executionId }, secret, { now: () => start }),
        },
        { secret, env, stsClient, now: () => start },
      );
    }
    const requests = stsClient.send.mock.calls.map(([command]) => command.input);
    const names = requests.map((request) => request.RoleSessionName);
    expect(new Set(names).size).toBe(executionIds.length);
    for (const name of names) {
      expect(name).toMatch(/^exec-[A-Za-z0-9_-]+$/);
      expect(name.length).toBeLessThanOrEqual(64);
    }
    expect(requests.map((request) => request.Tags)).toEqual(
      executionIds.map((executionId) => [{ Key: 'execution_id', Value: executionId }]),
    );
  });

  it('renews within the lease and refuses after it expires, before STS', async () => {
    const stsClient = sts();
    await authorizeExecutionDataRequest(
      { grant, executionId: 'A' },
      { secret, env, stsClient, now: () => start + 7.9 * 3600_000 },
    );
    expect(stsClient.send).toHaveBeenCalledTimes(1);
    await expect(
      authorizeExecutionDataRequest(
        { grant, executionId: 'A' },
        { secret, env, stsClient, now: () => start + 8 * 3600_000 },
      ),
    ).rejects.toThrow('invalid or expired');
    expect(stsClient.send).toHaveBeenCalledTimes(1);
  });

  it('rejects a request to use or renew A authorization for B before STS', async () => {
    const stsClient = sts();
    await expect(
      authorizeExecutionDataRequest(
        { grant, executionId: 'B' },
        { secret, env, stsClient, now: () => start },
      ),
    ).rejects.toThrow('scope mismatch');
    expect(stsClient.send).not.toHaveBeenCalled();
  });
});

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

describe('agent credential grant authorization', () => {
  const SECRET = 'g'.repeat(48);
  const NOW = Date.parse('2026-09-01T12:00:00.000Z');

  beforeEach(() => {
    ssmMock.reset();
    vi.stubEnv('AGENT_SETTINGS_SSM_PREFIX', '/app/dev');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('resolves only the bindings carried by a valid signed grant', async () => {
    const grant = signAgentCredentialGrant(
      {
        purpose: 'capabilities',
        projectId: 'p-1',
        bindings: [
          { provider: 'bedrock', source: 'space' },
          { provider: 'kiro', source: 'user', userId: 'u-1' },
        ],
      },
      SECRET,
      { now: () => NOW, randomId: () => 'grant-1234567890' },
    );
    const values = new Map([
      ['/app/dev/projects/p-1/agent-credentials/bedrock-bearer-token', 'bedrock-space'],
      ['/app/dev/users/u-1/agent-credentials/kiro-api-key', 'kiro-user'],
    ]);
    ssmMock.on(GetParameterCommand).callsFake((input) => ({
      Parameter: values.has(input.Name)
        ? { Name: input.Name, Value: values.get(input.Name) }
        : undefined,
    }));

    await expect(
      authorizeAgentCredentialRequest(
        { grant },
        {
          ssmClient: ssm,
          secret: SECRET,
          env: { AGENT_SETTINGS_SSM_PREFIX: '/app/dev' },
          now: () => NOW,
        },
      ),
    ).resolves.toEqual({
      purpose: 'capabilities',
      projectId: 'p-1',
      executionId: null,
      credentials: [
        {
          binding: { provider: 'bedrock', source: 'space' },
          value: 'bedrock-space',
        },
        {
          binding: { provider: 'kiro', source: 'user', userId: 'u-1' },
          value: 'kiro-user',
        },
      ],
    });
    expect(
      ssmMock.commandCalls(GetParameterCommand).map((call) => call.args[0].input.Name),
    ).toEqual([
      '/app/dev/projects/p-1/agent-credentials/bedrock-bearer-token',
      '/app/dev/users/u-1/agent-credentials/kiro-api-key',
    ]);
  });

  it('rejects a tampered grant before reading any credential', async () => {
    const grant = signAgentCredentialGrant(
      {
        purpose: 'execution',
        projectId: 'p-1',
        executionId: 'e-1',
        bindings: [{ provider: 'kiro', source: 'space' }],
      },
      SECRET,
      { now: () => NOW, randomId: () => 'grant-1234567890' },
    );
    const [claims, signature] = grant.split('.');

    await expect(
      authorizeAgentCredentialRequest(
        { grant: `${claims.slice(0, -1)}A.${signature}` },
        {
          ssmClient: ssm,
          secret: SECRET,
          env: { AGENT_SETTINGS_SSM_PREFIX: '/app/dev' },
          now: () => NOW,
        },
      ),
    ).rejects.toMatchObject({ code: 'AGENT_CREDENTIAL_GRANT_INVALID' });
    expect(ssmMock.commandCalls(GetParameterCommand)).toHaveLength(0);
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
