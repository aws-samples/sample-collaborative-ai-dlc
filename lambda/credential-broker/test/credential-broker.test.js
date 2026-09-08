import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { SSMClient, GetParameterCommand, PutParameterCommand } from '@aws-sdk/client-ssm';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import {
  CREDENTIAL_ACTIVE_EXECUTION_STATUSES,
  ROLE_SESSION_DURATION_SECONDS,
  authorizeAgentCredentialRequest,
  authorizeCredentialRequest,
  executionIncludesRepository,
  loggableAgentCredentialErrorCode,
} from '../index.js';
import { signAgentCredentialGrant } from '../../shared/agent-credential-grants.js';

const ddbMock = mockClient(DynamoDBDocumentClient);
const ssmMock = mockClient(SSMClient);
const secretsMock = mockClient(SecretsManagerClient);
const stsMock = mockClient(STSClient);
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ssm = new SSMClient({});
const sts = new STSClient({});
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
          kind: 'bearer',
          value: 'bedrock-space',
        },
        {
          binding: { provider: 'kiro', source: 'user', userId: 'u-1' },
          kind: 'bearer',
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

// specs/bedrock-iam-role-credential-mode — req-broker-side-assume,
// req-broker-credential-resolution, req-session-name-attribution,
// req-capabilities-authed.
describe('bedrock role credential resolution', () => {
  const SECRET = 'g'.repeat(48);
  const NOW = Date.parse('2026-09-01T12:00:00.000Z');
  const PROJECT_ID = 'aa11bb22-cc33-dd44-ee55-ff6677889900';
  const ROLE_ARN = 'arn:aws:iam::111122223333:role/aidlc-bedrock-inference';
  const PLATFORM_PATH = '/app/dev/bedrock-bearer-token';
  const STS_CREDENTIALS = {
    AccessKeyId: 'ASIAEXAMPLEEXAMPLE',
    SecretAccessKey: 'secret-access-key',
    SessionToken: 'session-token',
    Expiration: new Date('2026-09-01T13:00:00.000Z'),
  };

  const grantFor = (purpose, extra = {}) =>
    signAgentCredentialGrant(
      {
        purpose,
        projectId: PROJECT_ID,
        bindings: [{ provider: 'bedrock', source: 'platform' }],
        ...extra,
      },
      SECRET,
      { now: () => NOW, randomId: () => 'grant-1234567890' },
    );

  const resolve = (grant) =>
    authorizeAgentCredentialRequest(
      { grant },
      {
        ssmClient: ssm,
        stsClient: sts,
        secret: SECRET,
        env: { AGENT_SETTINGS_SSM_PREFIX: '/app/dev' },
        now: () => NOW,
      },
    );

  const storeValue = (value) => {
    ssmMock.on(GetParameterCommand).callsFake((input) => ({
      Parameter: input.Name === PLATFORM_PATH ? { Name: input.Name, Value: value } : undefined,
    }));
  };

  beforeEach(() => {
    ssmMock.reset();
    stsMock.reset();
    vi.stubEnv('AGENT_SETTINGS_SSM_PREFIX', '/app/dev');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('assumes the role read from SSM and returns a kind-discriminated result', async () => {
    storeValue(JSON.stringify({ roleArn: ROLE_ARN }));
    stsMock.on(AssumeRoleCommand).resolves({ Credentials: STS_CREDENTIALS });

    const result = await resolve(grantFor('execution', { executionId: 'e-1' }));

    expect(result.credentials).toEqual([
      {
        binding: { provider: 'bedrock', source: 'platform' },
        kind: 'role',
        credentials: {
          AccessKeyId: 'ASIAEXAMPLEEXAMPLE',
          SecretAccessKey: 'secret-access-key',
          SessionToken: 'session-token',
          Expiration: '2026-09-01T13:00:00.000Z',
        },
      },
    ]);
    // No `value` field on a role entry: the resolver treats a valueless bearer
    // entry as missing, which is why the discriminator exists.
    expect(result.credentials[0]).not.toHaveProperty('value');
  });

  it('pins the AssumeRole input: session name, 3600s duration, and no Tags', async () => {
    storeValue(JSON.stringify({ roleArn: ROLE_ARN }));
    stsMock.on(AssumeRoleCommand).resolves({ Credentials: STS_CREDENTIALS });

    await resolve(grantFor('execution', { executionId: 'e-1' }));

    const input = stsMock.commandCalls(AssumeRoleCommand)[0].args[0].input;
    expect(input).toEqual({
      RoleArn: ROLE_ARN,
      RoleSessionName: `aidlc-${PROJECT_ID}`,
      DurationSeconds: 3600,
    });
    // con-role-chaining-3600 is a hard STS ceiling, not a tuning knob.
    expect(ROLE_SESSION_DURATION_SECONDS).toBe(3600);
    // con-session-name-fits: 42 characters against the 64-character STS limit.
    expect(input.RoleSessionName.length).toBeLessThanOrEqual(64);
    // con-tagsession-required: any Tags would fail closed on a trust policy that
    // omits sts:TagSession.
    expect(input).not.toHaveProperty('Tags');
  });

  it('passes the external id when the binding carries one', async () => {
    storeValue(JSON.stringify({ roleArn: ROLE_ARN, externalId: 'ext-0123456789' }));
    stsMock.on(AssumeRoleCommand).resolves({ Credentials: STS_CREDENTIALS });

    await resolve(grantFor('execution', { executionId: 'e-1' }));

    expect(stsMock.commandCalls(AssumeRoleCommand)[0].args[0].input.ExternalId).toBe(
      'ext-0123456789',
    );
  });

  it('never accepts a role ARN from the request, only from SSM', async () => {
    storeValue(JSON.stringify({ roleArn: ROLE_ARN }));
    stsMock.on(AssumeRoleCommand).resolves({ Credentials: STS_CREDENTIALS });

    await authorizeAgentCredentialRequest(
      {
        grant: grantFor('execution', { executionId: 'e-1' }),
        // Attacker-supplied fields on the event are ignored outright.
        roleArn: 'arn:aws:iam::999988887777:role/attacker',
        externalId: 'attacker-external-id',
      },
      {
        ssmClient: ssm,
        stsClient: sts,
        secret: SECRET,
        env: { AGENT_SETTINGS_SSM_PREFIX: '/app/dev' },
        now: () => NOW,
      },
    );

    const input = stsMock.commandCalls(AssumeRoleCommand)[0].args[0].input;
    expect(input.RoleArn).toBe(ROLE_ARN);
    expect(input.ExternalId).toBeUndefined();
  });

  it('answers a capabilities grant from the binding alone, with no AssumeRole', async () => {
    storeValue(JSON.stringify({ roleArn: ROLE_ARN }));

    const result = await resolve(grantFor('capabilities'));

    expect(result.credentials).toEqual([
      { binding: { provider: 'bedrock', source: 'platform' }, kind: 'role', usable: true },
    ]);
    // req-capabilities-authed: minting here would mean one AssumeRole per
    // settings render, which AWS warns can exceed the STS request-rate quota.
    expect(stsMock.commandCalls(AssumeRoleCommand)).toHaveLength(0);
  });

  it('resolves a plain string as a bearer token without touching STS', async () => {
    storeValue('ABSKQmVkcm9jaw==');

    const result = await resolve(grantFor('execution', { executionId: 'e-1' }));

    expect(result.credentials).toEqual([
      {
        binding: { provider: 'bedrock', source: 'platform' },
        kind: 'bearer',
        value: 'ABSKQmVkcm9jaw==',
      },
    ]);
    expect(stsMock.commandCalls(AssumeRoleCommand)).toHaveLength(0);
  });

  it('reports an unconfigured binding as kind null rather than failing', async () => {
    storeValue('placeholder');

    const result = await resolve(grantFor('execution', { executionId: 'e-1' }));

    expect(result.credentials).toEqual([
      { binding: { provider: 'bedrock', source: 'platform' }, kind: null, value: null },
    ]);
  });

  it('rejects a malformed role value as BEDROCK_ROLE_BINDING_INVALID before calling STS', async () => {
    storeValue('{"roleArn":"not-an-arn"}');

    await expect(resolve(grantFor('execution', { executionId: 'e-1' }))).rejects.toMatchObject({
      code: 'BEDROCK_ROLE_BINDING_INVALID',
    });
    expect(stsMock.commandCalls(AssumeRoleCommand)).toHaveLength(0);
  });

  it.each([
    ['AccessDenied', 'BEDROCK_ROLE_ASSUME_DENIED'],
    ['AccessDeniedException', 'BEDROCK_ROLE_ASSUME_DENIED'],
    ['ExpiredToken', 'BEDROCK_ROLE_ASSUME_DENIED'],
    ['ThrottlingException', 'BEDROCK_ROLE_ASSUME_THROTTLED'],
    ['TooManyRequestsException', 'BEDROCK_ROLE_ASSUME_THROTTLED'],
    ['ValidationError', 'BEDROCK_ROLE_RESOLUTION_FAILED'],
    ['SomethingUnexpected', 'BEDROCK_ROLE_RESOLUTION_FAILED'],
  ])('maps an STS %s onto %s and leaks no provider text', async (stsErrorName, expectedCode) => {
    storeValue(JSON.stringify({ roleArn: ROLE_ARN }));
    const stsError = Object.assign(
      new Error(
        `User: arn:aws:sts::111122223333:assumed-role/broker/session is not authorized to perform: sts:AssumeRole on resource: ${ROLE_ARN}`,
      ),
      { name: stsErrorName },
    );
    stsMock.on(AssumeRoleCommand).rejects(stsError);

    let thrown;
    try {
      await resolve(grantFor('execution', { executionId: 'e-1' }));
    } catch (error) {
      thrown = error;
    }

    expect(thrown.code).toBe(expectedCode);
    // The allowlisted code is the only thing that may surface. STS messages name
    // the caller session and the target role.
    expect(thrown.message).not.toContain('assumed-role');
    expect(thrown.message).not.toContain(ROLE_ARN);
    expect(loggableAgentCredentialErrorCode(thrown)).toBe(expectedCode);
  });

  it('fails typed when STS returns no credentials', async () => {
    storeValue(JSON.stringify({ roleArn: ROLE_ARN }));
    stsMock.on(AssumeRoleCommand).resolves({});

    await expect(resolve(grantFor('execution', { executionId: 'e-1' }))).rejects.toMatchObject({
      code: 'BEDROCK_ROLE_RESOLUTION_FAILED',
    });
  });

  it('refuses to compose a session name without a project id', async () => {
    storeValue(JSON.stringify({ roleArn: ROLE_ARN }));
    const grant = signAgentCredentialGrant(
      {
        purpose: 'execution',
        executionId: 'e-1',
        bindings: [{ provider: 'bedrock', source: 'platform' }],
      },
      SECRET,
      { now: () => NOW, randomId: () => 'grant-1234567890' },
    );

    await expect(resolve(grant)).rejects.toMatchObject({
      code: 'BEDROCK_ROLE_RESOLUTION_FAILED',
    });
    expect(stsMock.commandCalls(AssumeRoleCommand)).toHaveLength(0);
  });

  it('keeps an unrelated failure on the generic broker code', () => {
    expect(loggableAgentCredentialErrorCode(new Error('boom'))).toBe(
      'AGENT_CREDENTIAL_BROKER_FAILED',
    );
  });

  // req-grant-model-unchanged: the grant model is untouched, so a grant that
  // expires before the broker can resolve it must surface as a typed failure
  // rather than a silent hang — and must do so before any STS round trip.
  it('surfaces an expired grant as an allowlisted code without calling STS', async () => {
    storeValue(JSON.stringify({ roleArn: ROLE_ARN }));
    stsMock.on(AssumeRoleCommand).resolves({ Credentials: STS_CREDENTIALS });
    const grant = grantFor('execution', { executionId: 'e-1' });

    let thrown;
    try {
      await authorizeAgentCredentialRequest(
        { grant },
        {
          ssmClient: ssm,
          stsClient: sts,
          secret: SECRET,
          env: { AGENT_SETTINGS_SSM_PREFIX: '/app/dev' },
          // The 300s TTL has elapsed (con-grant-ttl-300), plus the clock skew.
          now: () => NOW + 400_000,
        },
      );
    } catch (error) {
      thrown = error;
    }

    expect(loggableAgentCredentialErrorCode(thrown)).toBe('AGENT_CREDENTIAL_GRANT_EXPIRED');
    expect(stsMock.commandCalls(AssumeRoleCommand)).toHaveLength(0);
    expect(ssmMock.commandCalls(GetParameterCommand)).toHaveLength(0);
  });

  // specs/bedrock-iam-role-credential-mode — req-resolution-resilience.
  //
  // The broker reads SSM on EVERY resolution, concurrently across stages, so SSM's
  // own request rate is on the critical path. A throttled read has to be legible as
  // throttling rather than as a generic broker failure, because the operator
  // response differs: throttling clears on the stage retry, an unavailable store
  // does not.
  it.each([
    ['ThrottlingException', 'AGENT_CREDENTIAL_STORE_THROTTLED'],
    ['TooManyRequestsException', 'AGENT_CREDENTIAL_STORE_THROTTLED'],
    ['RequestLimitExceeded', 'AGENT_CREDENTIAL_STORE_THROTTLED'],
    ['AccessDeniedException', 'AGENT_CREDENTIAL_STORE_UNAVAILABLE'],
    ['KMSKeyDisabled', 'AGENT_CREDENTIAL_STORE_UNAVAILABLE'],
    ['InternalServerError', 'AGENT_CREDENTIAL_STORE_UNAVAILABLE'],
  ])('maps an SSM %s onto %s and leaks no parameter path', async (ssmErrorName, expectedCode) => {
    const ssmError = Object.assign(
      // A real SSM message echoes the parameter name, which identifies the tenant.
      new Error(`Parameter ${PLATFORM_PATH} could not be read`),
      { name: ssmErrorName },
    );
    ssmMock.on(GetParameterCommand).rejects(ssmError);

    let thrown;
    try {
      await resolve(grantFor('execution', { executionId: 'e-1' }));
    } catch (error) {
      thrown = error;
    }

    expect(loggableAgentCredentialErrorCode(thrown)).toBe(expectedCode);
    expect(thrown.message).not.toContain(PLATFORM_PATH);
    // A store failure must never be mistaken for a usable credential, so no
    // AssumeRole is attempted.
    expect(stsMock.commandCalls(AssumeRoleCommand)).toHaveLength(0);
  });

  it('treats a cleared binding as missing rather than as a store failure', async () => {
    // A deleted parameter is a REVOKED binding. It must fail closed as "no
    // credential" — reporting a store outage would send an operator chasing SSM.
    ssmMock
      .on(GetParameterCommand)
      .rejects(Object.assign(new Error('not found'), { name: 'ParameterNotFound' }));

    const result = await resolve(grantFor('execution', { executionId: 'e-1' }));

    expect(result.credentials).toEqual([
      { binding: { provider: 'bedrock', source: 'platform' }, kind: null, value: null },
    ]);
    expect(stsMock.commandCalls(AssumeRoleCommand)).toHaveLength(0);
  });

  it('surfaces a role deleted or re-trusted mid-stage as a typed failure on the next resolution', async () => {
    // Nothing is cached: the ARN is read and the role assumed on every invocation,
    // so a role deleted or a trust policy narrowed between two stages of the same
    // intent is caught at the next one rather than producing a stale credential.
    storeValue(JSON.stringify({ roleArn: ROLE_ARN }));
    stsMock.on(AssumeRoleCommand).resolvesOnce({ Credentials: STS_CREDENTIALS });

    const first = await resolve(grantFor('execution', { executionId: 'e-1' }));
    expect(first.credentials[0].kind).toBe('role');

    // The operator deletes the role, or removes the broker from its trust policy.
    stsMock
      .on(AssumeRoleCommand)
      .rejects(Object.assign(new Error('denied'), { name: 'AccessDenied' }));

    let thrown;
    try {
      await resolve(grantFor('execution', { executionId: 'e-2' }));
    } catch (error) {
      thrown = error;
    }
    expect(loggableAgentCredentialErrorCode(thrown)).toBe('BEDROCK_ROLE_ASSUME_DENIED');
    // Two resolutions, two AssumeRole calls: per-invocation minting is what makes a
    // revocation visible at all.
    expect(stsMock.commandCalls(AssumeRoleCommand)).toHaveLength(2);
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
