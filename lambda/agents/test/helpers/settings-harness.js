// Test helper: the agents handler over a fresh DynamoDB Local control table per test, with the
// SSM, metadata-broker Lambda and AgentCore clients mocked. Call useSettingsHarness() once per
// file; vi.mock any composition root in the test file itself so the handler loads with it.
import { afterAll, beforeAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import gremlin from 'gremlin';
import { PartitionStrategy } from 'gremlin/lib/process/traversal-strategy.js';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, CreateTableCommand, DeleteTableCommand } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  SSMClient,
  GetParametersCommand,
  GetParametersByPathCommand,
  PutParameterCommand,
} from '@aws-sdk/client-ssm';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { BedrockAgentCoreClient } from '@aws-sdk/client-bedrock-agentcore';
import { createAgentConnectionRepository } from '../../../shared/agent-connection-repository.js';

export const RUNTIME_ARN = 'arn:aws:bedrock-agentcore:us-east-1:111111111111:runtime/test-runtime';
export const GRANT_SECRET = 'settings-harness-grant-secret'.repeat(2);
export const CALLER_ID = 'reviewer';
export const mocks = Object.freeze({
  ssm: mockClient(SSMClient),
  lambda: mockClient(LambdaClient),
  agentcore: mockClient(BedrockAgentCoreClient),
});

const client = new DynamoDBClient({
  endpoint: process.env.DYNAMODB_LOCAL_ENDPOINT,
  region: 'us-east-1',
  credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
});
const ddb = DynamoDBDocumentClient.from(client);
const partition = `auth-settings-${randomUUID()}`;
const tables = [];
let handler;
let graphConnection;
let callerVertex;
const spaces = new Set();

// Credential set-state the mocked metadata broker reports, per scope source.
export const scopeStatuses = {};
const defaultStatus = { bedrockBearerTokenSet: false, kiroApiKeySet: false };

export const loadHandler = async () => {
  vi.stubEnv('AWS_ENDPOINT_URL_DYNAMODB', process.env.DYNAMODB_LOCAL_ENDPOINT);
  vi.stubEnv('AWS_REGION', 'us-east-1');
  vi.stubEnv('AWS_ACCESS_KEY_ID', 'local');
  vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'local');
  vi.stubEnv('GREMLIN_PARTITION', partition);
  vi.stubEnv('AGENT_SETTINGS_SSM_PREFIX', '/collab/test');
  vi.stubEnv('AGENT_CREDENTIAL_METADATA_FUNCTION', 'metadata');
  vi.stubEnv('ENVIRONMENT_REGISTRY_TABLE', '');
  ({ handler } = await import('../../index.js'));
  return handler;
};

export const request = (
  body,
  { admin = true, personal = false, method = 'PUT', path, projectId } = {},
) => ({
  httpMethod: method,
  path:
    path ??
    (projectId
      ? `/projects/${projectId}/agent-credentials`
      : personal
        ? '/users/me/agent-credentials'
        : '/agents/settings'),
  ...(projectId ? { pathParameters: { projectId } } : {}),
  body: typeof body === 'string' ? body : JSON.stringify(body),
  requestContext: {
    authorizer: {
      claims: {
        sub: CALLER_ID,
        ...(admin ? { 'cognito:groups': 'platform-admin' } : {}),
      },
    },
  },
});

export const invoke = async (...args) => {
  const result = await handler(request(...args));
  return { status: result.statusCode, data: JSON.parse(result.body) };
};

// A space the handler's Neptune lookups resolve (on the fallback runtime); with callerRole the
// request's caller is a member. Spaces live for the whole file, so adding one twice is a no-op.
export const addSpace = async (projectId, { callerRole } = {}) => {
  if (spaces.has(projectId)) return;
  spaces.add(projectId);
  graphConnection ??= new gremlin.driver.DriverRemoteConnection(
    `ws://${process.env.NEPTUNE_ENDPOINT}:${process.env.GREMLIN_PORT}/gremlin`,
  );
  const g = gremlin.process.AnonymousTraversalSource.traversal()
    .withRemote(graphConnection)
    .withStrategies(
      new PartitionStrategy({
        partitionKey: '_partition',
        writePartition: partition,
        readPartitions: [partition],
      }),
    );
  await g.addV('Project').property('id', projectId).next();
  if (!callerRole) return;
  callerVertex ??= g.addV('User').property('id', CALLER_ID).next();
  await callerVertex;
  await g
    .V()
    .has('Project', 'id', projectId)
    .as('p')
    .V()
    .has('User', 'id', CALLER_ID)
    .as('u')
    .addE('HAS_MEMBER')
    .from_('p')
    .to('u')
    .property('role', callerRole)
    .next();
};

export const useSettingsHarness = () => {
  // A function returned from beforeAll is a teardown, so do not return the handler here.
  beforeAll(async () => {
    await loadHandler();
  });
  beforeEach(async () => {
    const TableName = `agent-auth-api-${randomUUID()}`;
    await client.send(
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
    vi.stubEnv('AGENTCORE_RUNTIME_ARN', RUNTIME_ARN);
    vi.stubEnv('AGENT_CREDENTIAL_GRANT_SECRET', GRANT_SECRET);
    await createAgentConnectionRepository({ ddb, tableName: TableName }).initializeInventory();
    for (const key of Object.keys(scopeStatuses)) delete scopeStatuses[key];
    mocks.ssm.reset();
    mocks.lambda.reset();
    mocks.agentcore.reset();
    mocks.ssm.on(GetParametersCommand).resolves({ Parameters: [] });
    mocks.ssm.on(GetParametersByPathCommand).resolves({ Parameters: [] });
    mocks.ssm.on(PutParameterCommand).resolves({});
    mocks.lambda.on(InvokeCommand).callsFake(async (input) => {
      const payload = JSON.parse(Buffer.from(input.Payload).toString());
      return {
        Payload: Buffer.from(
          JSON.stringify({
            ok: true,
            scopes: [],
            status: scopeStatuses[payload.source] ?? defaultStatus,
          }),
        ),
      };
    });
  });
  afterAll(async () => {
    await Promise.all(
      tables.splice(0).map((TableName) => client.send(new DeleteTableCommand({ TableName }))),
    );
    client.destroy();
    await graphConnection?.close();
    vi.unstubAllEnvs();
  });
};
