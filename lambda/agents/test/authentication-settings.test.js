import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { DynamoDBClient, CreateTableCommand, DeleteTableCommand } from '@aws-sdk/client-dynamodb';
import {
  SSMClient,
  GetParametersCommand,
  GetParametersByPathCommand,
  PutParameterCommand,
} from '@aws-sdk/client-ssm';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import { mockClient } from 'aws-sdk-client-mock';

const ssm = mockClient(SSMClient);
const lambda = mockClient(LambdaClient);
const agentcore = mockClient(BedrockAgentCoreClient);
const tables = [];
const ddb = new DynamoDBClient({
  endpoint: process.env.DYNAMODB_LOCAL_ENDPOINT,
  region: 'us-east-1',
  credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
});
let handler;
const request = (body, { admin = true, personal = false } = {}) => ({
  httpMethod: 'PUT',
  path: personal ? '/users/me/agent-credentials' : '/agents/settings',
  body: JSON.stringify(body),
  requestContext: {
    authorizer: {
      claims: {
        sub: 'reviewer',
        ...(admin ? { 'cognito:groups': 'platform-admin' } : {}),
      },
    },
  },
});
const invoke = async (...args) => {
  const result = await handler(request(...args));
  return { status: result.statusCode, data: JSON.parse(result.body) };
};

beforeAll(async () => {
  vi.stubEnv('AWS_ENDPOINT_URL_DYNAMODB', process.env.DYNAMODB_LOCAL_ENDPOINT);
  vi.stubEnv('AWS_REGION', 'us-east-1');
  vi.stubEnv('AWS_ACCESS_KEY_ID', 'local');
  vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'local');
  vi.stubEnv('GREMLIN_PARTITION', `auth-settings-${randomUUID()}`);
  vi.stubEnv('AGENT_SETTINGS_SSM_PREFIX', '/collab/test');
  vi.stubEnv('AGENT_CREDENTIAL_METADATA_FUNCTION', 'metadata');
  vi.stubEnv('ENVIRONMENT_REGISTRY_TABLE', '');
  ({ handler } = await import('../index.js'));
});
beforeEach(async () => {
  const TableName = `agent-auth-api-${randomUUID()}`;
  await ddb.send(
    new CreateTableCommand({
      TableName,
      BillingMode: 'PAY_PER_REQUEST',
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
      AttributeDefinitions: [
        { AttributeName: 'pk', AttributeType: 'S' },
        { AttributeName: 'sk', AttributeType: 'S' },
      ],
    }),
  );
  tables.push(TableName);
  vi.stubEnv('V2_PROCESS_TABLE', TableName);
  ssm.reset();
  lambda.reset();
  agentcore.reset();
  vi.stubEnv(
    'AGENTCORE_RUNTIME_ARN',
    'arn:aws:bedrock-agentcore:us-east-1:111111111111:runtime/test-runtime',
  );
  vi.stubEnv('AGENT_CREDENTIAL_GRANT_SECRET', 'iam-verification-fixture'.repeat(3));
  ssm.on(GetParametersCommand).resolves({ Parameters: [] });
  ssm.on(GetParametersByPathCommand).resolves({ Parameters: [] });
  ssm.on(PutParameterCommand).resolves({});
  lambda.on(InvokeCommand).resolves({
    Payload: Buffer.from(
      JSON.stringify({
        ok: true,
        scopes: [],
        status: { bedrockBearerTokenSet: false, kiroApiKeySet: false },
      }),
    ),
  });
});
afterAll(async () => {
  await Promise.all(tables.map((TableName) => ddb.send(new DeleteTableCommand({ TableName }))));
  ddb.destroy();
  vi.unstubAllEnvs();
});

describe('reviewed credential settings API', () => {
  it('requires platform authorization and a reviewed update before writing secrets', async () => {
    expect((await invoke({ bedrockBearerToken: 'fixture-key' }, { admin: false })).status).toBe(
      403,
    );
    expect(await invoke({ bedrockBearerToken: 'fixture-key' })).toMatchObject({
      status: 409,
      data: { code: 'AGENT_AUTH_REVIEW_REQUIRED' },
    });
    expect(ssm.commandCalls(PutParameterCommand)).toHaveLength(0);
  });
  it('previews without a secret write, rejects edited input and applies the exact review once', async () => {
    const input = { bedrockBearerToken: 'fixture-key' };
    const preview = await invoke({ ...input, reviewAction: 'preview' });
    expect(preview.status).toBe(200);
    expect(JSON.stringify(preview.data)).not.toContain('fixture-key');
    expect(ssm.commandCalls(PutParameterCommand)).toHaveLength(0);
    expect(
      await invoke({ bedrockBearerToken: 'different', reviewId: preview.data.id }),
    ).toMatchObject({
      status: 409,
      data: { code: 'AGENT_AUTH_REVIEW_STALE' },
    });
    const apply = { ...input, reviewId: preview.data.id };
    expect(await invoke(apply)).toMatchObject({ status: 200, data: { saved: true, revision: 1 } });
    expect(await invoke(apply)).toMatchObject({ status: 200, data: { saved: true, revision: 1 } });
    expect(ssm.commandCalls(PutParameterCommand)).toHaveLength(1);
    expect(ssm.commandCalls(PutParameterCommand)[0].args[0].input).toMatchObject({
      Name: '/collab/test/bedrock-bearer-token',
      Type: 'SecureString',
      Value: 'fixture-key',
    });
  });
  it('binds a personal review and write to the authenticated caller', async () => {
    const input = { bedrockBearerToken: 'personal-fixture', userId: 'someone-else' };
    const preview = await invoke(
      { ...input, reviewAction: 'preview' },
      { admin: false, personal: true },
    );
    expect(preview.status).toBe(200);
    expect(preview.data.candidate.userId).toBe('reviewer');
    expect(
      (await invoke({ ...input, reviewId: preview.data.id }, { admin: false, personal: true }))
        .status,
    ).toBe(200);
    expect(ssm.commandCalls(PutParameterCommand)[0].args[0].input.Name).toBe(
      '/collab/test/users/reviewer/agent-credentials/bedrock-bearer-token',
    );
  });
  it('keeps future modes gated and reports missing inherited credentials', async () => {
    expect(
      await invoke({
        authenticationChange: {
          action: 'preview',
          candidate: { mode: 'litellm', defaultConnectionId: 'future' },
        },
      }),
    ).toMatchObject({
      status: 409,
      data: { code: 'AGENT_AUTH_MODE_UNAVAILABLE' },
    });
    const result = await handler({ ...request({}), httpMethod: 'GET' });
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body).authentication).toMatchObject({
      policy: { mode: 'keys', revision: 0 },
      reviewRequired: true,
      connection: { id: 'legacy-platform-bedrock', state: 'missing' },
    });
  });
});

describe('IAM settings on the foundation', () => {
  const configuration = {
    roleArn: 'arn:aws:iam::222222222222:role/Inference',
    region: 'eu-west-1',
    externalId: 'external-fixture',
  };
  it('requires platform admin for IAM activation and refuses personal role inputs', async () => {
    const input = {
      authenticationChange: {
        action: 'preview',
        candidate: { kind: 'iam-connection', configuration },
      },
    };
    expect((await invoke(input, { admin: false })).status).toBe(403);
    expect(
      (await invoke({ bedrockIam: configuration }, { admin: false, personal: true })).status,
    ).toBe(400);
  });
  it('previews without activation, applies the same role, disables Bedrock keys and keeps Kiro independent', async () => {
    const preview = await invoke({
      authenticationChange: {
        action: 'preview',
        candidate: { kind: 'iam-connection', configuration },
      },
    });
    expect(preview.status).toBe(200);
    expect(preview.data.candidate.connection.configuration).toEqual(configuration);
    const settings = async () =>
      JSON.parse((await handler({ ...request({}), httpMethod: 'GET' })).body);
    expect((await settings()).authentication.policy.mode).toBe('keys');
    expect(
      (await invoke({ authenticationChange: { action: 'apply', reviewId: preview.data.id } }))
        .status,
    ).toBe(200);
    expect((await settings()).authentication).toMatchObject({
      policy: { mode: 'iam' },
      canManageIam: true,
      connection: { configuration, mechanism: 'assume-role' },
    });
    expect((await invoke({ bedrockBearerToken: 'disabled', reviewAction: 'preview' })).status).toBe(
      409,
    );
    expect((await invoke({ kiroApiKey: 'independent', reviewAction: 'preview' })).status).toBe(200);
    expect(ssm.commandCalls(PutParameterCommand)).toHaveLength(0);
  });
  it('authorizes setup documents for platform admins only and returns both account policies', async () => {
    vi.stubEnv('CREDENTIAL_BROKER_ROLE_ARN', 'arn:aws:iam::111111111111:role/Broker');
    const post = (admin) => ({
      ...request({ action: 'setup', config: configuration }, { admin }),
      httpMethod: 'POST',
      path: '/agents/bedrock-iam',
    });
    expect((await handler(post(false))).statusCode).toBe(403);
    const result = await handler(post(true));
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({
      applicationAccountId: '111111111111',
      inferenceAccountId: '222222222222',
      config: configuration,
    });
  });

  const verificationRequest = () => ({
    ...request({ action: 'verify', config: configuration }),
    httpMethod: 'POST',
    path: '/agents/bedrock-iam',
  });

  it('passes a structured runtime IAM denial to the wizard instead of a connectivity error', async () => {
    const denial = {
      verified: false,
      code: 'BEDROCK_IAM_ACCESS_DENIED',
      error: 'AWS denied the credential broker access to the inference role.',
    };
    agentcore.on(InvokeAgentRuntimeCommand).resolves({
      response: { transformToString: async () => JSON.stringify(denial) },
    });
    const result = await handler(verificationRequest());
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual(denial);
    const payload = JSON.parse(
      agentcore.commandCalls(InvokeAgentRuntimeCommand)[0].args[0].input.payload,
    );
    expect(payload.command).toBe('verify-bedrock-iam');
    expect(payload.credentialBindings.bedrock.configuration).toEqual(configuration);
    expect(payload.agentCredentialGrant).toBeTruthy();
  });

  it('distinguishes a runtime rejection from an unreachable runtime', async () => {
    agentcore
      .on(InvokeAgentRuntimeCommand)
      .rejects(
        Object.assign(new Error('private runtime diagnostics'), { name: 'RuntimeClientError' }),
      );
    const result = await handler(verificationRequest());
    expect(result.statusCode).toBe(502);
    expect(JSON.parse(result.body).error).toContain('runtime rejected');
    expect(result.body).not.toContain('private');
  });

  it('reports authorization failures before invoking the runtime', async () => {
    vi.stubEnv('AGENT_CREDENTIAL_GRANT_SECRET', '');
    vi.stubEnv('AGENT_CREDENTIAL_GRANT_SECRET_PARAM', '');
    const result = await handler(verificationRequest());
    expect(result.statusCode).toBe(502);
    expect(JSON.parse(result.body).error).toContain('Could not authorize');
    expect(agentcore.commandCalls(InvokeAgentRuntimeCommand)).toHaveLength(0);
  });

  it('reports an unreadable response separately from runtime invocation failure', async () => {
    agentcore.on(InvokeAgentRuntimeCommand).resolves({
      response: { transformToString: async () => 'not JSON' },
    });
    const result = await handler(verificationRequest());
    expect(result.statusCode).toBe(502);
    expect(JSON.parse(result.body).error).toContain('unreadable');
  });
});
