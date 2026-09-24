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
import { mockClient } from 'aws-sdk-client-mock';

const ssm = mockClient(SSMClient);
const lambda = mockClient(LambdaClient);
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
          candidate: { mode: 'iam', defaultConnectionId: 'future' },
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
