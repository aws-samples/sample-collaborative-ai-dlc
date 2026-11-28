import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DeleteParameterCommand,
  SSMClient,
  GetParametersCommand,
  PutParameterCommand,
} from '@aws-sdk/client-ssm';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';

const ssmMock = mockClient(SSMClient);
const lambdaMock = mockClient(LambdaClient);
let credentialMetadataHandler;
let handler;

const event = (method, body, groups = null) => ({
  httpMethod: method,
  path: '/agents/settings',
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  requestContext: {
    authorizer: {
      claims: {
        sub: 'user-1',
        ...(groups ? { 'cognito:groups': groups } : {}),
      },
    },
  },
});

beforeAll(async () => {
  process.env.AGENT_SETTINGS_SSM_PREFIX = '/collab/dev';
  process.env.AGENT_CREDENTIAL_METADATA_FUNCTION = 'credential-metadata-test';
  ({ handler } = await import('../index.js'));
});

beforeEach(() => {
  ssmMock.reset();
  lambdaMock.reset();
  credentialMetadataHandler = () => ({
    ok: true,
    status: { bedrockBearerTokenSet: false, kiroApiKeySet: false },
  });
  lambdaMock.on(InvokeCommand).callsFake((input) => {
    const request = JSON.parse(Buffer.from(input.Payload).toString());
    return {
      Payload: Buffer.from(JSON.stringify(credentialMetadataHandler(request))),
    };
  });
});

afterEach(() => vi.unstubAllEnvs());

describe('stage role enforcement', () => {
  const ddb = mockClient(DynamoDBDocumentClient);
  const get = (role) =>
    handler({ ...event('GET', undefined, role), queryStringParameters: { section: 'stageRoles' } });
  const put = (enabled, role) => handler(event('PUT', { enforceStageRoles: enabled }, role));
  beforeEach(() => {
    vi.stubEnv('ACCESS_TABLE', 'access-test');
    ddb.reset();
  });

  it('allows only platform admins to read or change the switch', async () => {
    expect((await get()).statusCode).toBe(403);
    expect((await put(false)).statusCode).toBe(403);
    expect((await put('false', 'platform-admin')).statusCode).toBe(400);
    expect(ddb.calls()).toHaveLength(0);
  });

  it('reads back the saved value and requires an explicit false to relax permissions', async () => {
    const key = { pk: 'SETTINGS#STAGE_ROLES', sk: 'CURRENT' };
    let item;
    ddb
      .on(GetCommand, { TableName: 'access-test', Key: key, ConsistentRead: true })
      .callsFake(() => ({ Item: item }));
    ddb.on(PutCommand, { TableName: 'access-test' }).callsFake(({ Item }) => {
      item = Item;
      return {};
    });
    expect(JSON.parse((await get('platform-admin')).body)).toEqual({ enforceStageRoles: true });
    for (const enabled of [false, true]) {
      expect((await put(enabled, 'platform-admin')).statusCode).toBe(200);
      expect(item).toEqual({ ...key, enabled });
      expect(JSON.parse((await get('platform-admin')).body)).toEqual({
        enforceStageRoles: enabled,
      });
    }
    ddb.on(GetCommand).rejects('read failed');
    expect((await get('platform-admin')).statusCode).toBe(500);
  });
});

describe('Bedrock inference region', () => {
  it.each([
    ['us-west-2', 'eu-central-1', 'us-west-2'],
    [undefined, 'eu-central-1', 'eu-central-1'],
    ['', 'eu-central-1', 'eu-central-1'],
    [undefined, undefined, 'us-east-1'],
  ])('reports the effective region for %s / %s', async (bedrockRegion, awsRegion, expected) => {
    vi.stubEnv('BEDROCK_REGION', bedrockRegion);
    vi.stubEnv('AWS_REGION', awsRegion);
    ssmMock.on(GetParametersCommand).resolves({ Parameters: [] });
    const response = await handler(event('GET'));
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).bedrockRegion).toBe(expected);
  });
});

describe('Bedrock gateway', () => {
  const personal = { ...event('GET'), path: '/users/me/agent-credentials' };

  it('tells the platform and personal credential views that Bedrock keys are gateway keys', async () => {
    vi.stubEnv('BEDROCK_GATEWAY_URL', 'https://gateway.example.com');
    ssmMock.on(GetParametersCommand).resolves({ Parameters: [] });

    for (const request of [event('GET'), personal]) {
      const response = await handler(request);
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body).bedrockGatewayUrl).toBe('https://gateway.example.com');
    }
  });

  it.each([undefined, ''])('reports no gateway when the deployment sets %j', async (url) => {
    vi.stubEnv('BEDROCK_GATEWAY_URL', url);
    ssmMock.on(GetParametersCommand).resolves({ Parameters: [] });

    for (const request of [event('GET'), personal]) {
      const response = await handler(request);
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).not.toHaveProperty('bedrockGatewayUrl');
    }
  });
});

describe('platform PR strategy settings', () => {
  it('reads pr-per-unit and fails safely to intent-pr for an unknown value', async () => {
    ssmMock.on(GetParametersCommand).resolves({
      Parameters: [{ Name: '/collab/dev/pr-strategy', Value: 'pr-per-unit' }],
    });
    const configured = await handler(event('GET'));
    expect(configured.statusCode).toBe(200);
    expect(JSON.parse(configured.body).prStrategy).toBe('pr-per-unit');
    expect(
      ssmMock
        .commandCalls(GetParametersCommand)
        .flatMap((call) => call.args[0].input.Names ?? [])
        .filter((name) => name.endsWith('/bedrock-bearer-token') || name.endsWith('/kiro-api-key')),
    ).toEqual([]);

    ssmMock.on(GetParametersCommand).resolves({
      Parameters: [{ Name: '/collab/dev/pr-strategy', Value: 'stacked' }],
    });
    const fallback = await handler(event('GET'));
    expect(JSON.parse(fallback.body).prStrategy).toBe('intent-pr');
  });

  it('allows only platform admins to update the strategy', async () => {
    const denied = await handler(event('PUT', { prStrategy: 'pr-per-unit' }));
    expect(denied.statusCode).toBe(403);
    expect(ssmMock.commandCalls(PutParameterCommand)).toHaveLength(0);

    ssmMock.on(PutParameterCommand).resolves({});
    const allowed = await handler(event('PUT', { prStrategy: 'pr-per-unit' }, 'platform-admin'));
    expect(allowed.statusCode).toBe(200);
    expect(ssmMock.commandCalls(PutParameterCommand)[0].args[0].input).toMatchObject({
      Name: '/collab/dev/pr-strategy',
      Value: 'pr-per-unit',
      Type: 'String',
      Overwrite: true,
    });
  });

  it('rejects removed and unknown strategies without writing SSM', async () => {
    const response = await handler(event('PUT', { prStrategy: 'stacked' }, 'platform-admin'));
    expect(response.statusCode).toBe(400);
    expect(ssmMock.commandCalls(PutParameterCommand)).toHaveLength(0);
  });
});

describe('platform lane sync settings', () => {
  it('reads before-stage and fails safely to none for an unknown value', async () => {
    ssmMock.on(GetParametersCommand).resolves({
      Parameters: [{ Name: '/collab/dev/lane-sync-policy', Value: 'before-stage' }],
    });
    expect(JSON.parse((await handler(event('GET'))).body).laneSyncPolicy).toBe('before-stage');

    ssmMock.on(GetParametersCommand).resolves({
      Parameters: [{ Name: '/collab/dev/lane-sync-policy', Value: 'always' }],
    });
    expect(JSON.parse((await handler(event('GET'))).body).laneSyncPolicy).toBe('none');
  });

  it('lets a platform admin update the policy and rejects unknown values', async () => {
    ssmMock.on(PutParameterCommand).resolves({});
    const allowed = await handler(
      event('PUT', { laneSyncPolicy: 'before-stage' }, 'platform-admin'),
    );
    expect(allowed.statusCode).toBe(200);
    expect(ssmMock.commandCalls(PutParameterCommand)[0].args[0].input).toMatchObject({
      Name: '/collab/dev/lane-sync-policy',
      Value: 'before-stage',
    });

    ssmMock.resetHistory();
    const rejected = await handler(event('PUT', { laneSyncPolicy: 'always' }, 'platform-admin'));
    expect(rejected.statusCode).toBe(400);
    expect(ssmMock.commandCalls(PutParameterCommand)).toHaveLength(0);
  });
});

describe('platform agent CLI availability settings', () => {
  it('reads the disabled set and defaults to every CLI enabled', async () => {
    ssmMock.on(GetParametersCommand).resolves({
      Parameters: [{ Name: '/collab/dev/disabled-clis', Value: '["codex","unknown"]' }],
    });
    const configured = await handler(event('GET'));
    expect(configured.statusCode).toBe(200);
    expect(JSON.parse(configured.body).disabledClis).toEqual(['codex']);
    expect(ssmMock.commandCalls(GetParametersCommand)[0].args[0].input.Names).toContain(
      '/collab/dev/disabled-clis',
    );

    ssmMock.on(GetParametersCommand).resolves({ Parameters: [] });
    const missing = await handler(event('GET'));
    expect(JSON.parse(missing.body).disabledClis).toEqual([]);
  });

  it('allows only platform admins to update the disabled set', async () => {
    const denied = await handler(event('PUT', { disabledClis: ['codex'] }));
    expect(denied.statusCode).toBe(403);
    expect(ssmMock.commandCalls(PutParameterCommand)).toHaveLength(0);

    ssmMock.on(PutParameterCommand).resolves({});
    const allowed = await handler(
      event('PUT', { disabledClis: ['codex', 'claude', 'codex'] }, 'platform-admin'),
    );
    expect(allowed.statusCode).toBe(200);
    expect(ssmMock.commandCalls(PutParameterCommand)[0].args[0].input).toMatchObject({
      Name: '/collab/dev/disabled-clis',
      Value: '["claude","codex"]',
      Type: 'String',
      Overwrite: true,
    });
  });

  it('rejects unknown CLIs and disabling every CLI without writing SSM', async () => {
    const unknown = await handler(event('PUT', { disabledClis: ['gemini'] }, 'platform-admin'));
    expect(unknown.statusCode).toBe(400);
    const all = await handler(
      event('PUT', { disabledClis: ['kiro', 'claude', 'opencode', 'codex'] }, 'platform-admin'),
    );
    expect(all.statusCode).toBe(400);
    expect(JSON.parse(all.body).issues).toEqual(['At least one agent CLI must stay enabled']);
    expect(ssmMock.commandCalls(PutParameterCommand)).toHaveLength(0);
  });
});

describe('personal agent credentials', () => {
  const personalEvent = (method, body) => ({
    ...event(method, body),
    path: '/users/me/agent-credentials',
  });

  it('returns set-state only for the authenticated user', async () => {
    credentialMetadataHandler = (request) => ({
      ok: true,
      status: {
        bedrockBearerTokenSet: request.source === 'user',
        kiroApiKeySet: false,
      },
    });
    const response = await handler(personalEvent('GET'));
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      bedrockBearerTokenSet: true,
      kiroApiKeySet: false,
    });
    expect(ssmMock.commandCalls(GetParametersCommand)).toHaveLength(0);
  });

  it('writes and clears only the caller-scoped parameters', async () => {
    ssmMock.on(PutParameterCommand).resolves({});
    ssmMock.on(DeleteParameterCommand).resolves({});
    const response = await handler(
      personalEvent('PUT', {
        bedrockBearerToken: 'new-token',
        kiroApiKey: '',
      }),
    );
    expect(response.statusCode).toBe(200);
    expect(ssmMock.commandCalls(PutParameterCommand)[0].args[0].input).toMatchObject({
      Name: '/collab/dev/users/user-1/agent-credentials/bedrock-bearer-token',
      Value: 'new-token',
      Type: 'SecureString',
    });
    expect(ssmMock.commandCalls(DeleteParameterCommand)[0].args[0].input).toEqual({
      Name: '/collab/dev/users/user-1/agent-credentials/kiro-api-key',
    });
  });
});
