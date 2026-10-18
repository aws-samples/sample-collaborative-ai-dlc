import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import { KMSClient } from '@aws-sdk/client-kms';

// With the MCP Gateway off (no GATEWAY_GRANT_KEY_ID), runtime dispatches must be
// byte-identical to the pre-grant payloads and never reach KMS. Graph
// authorization and AWS transport are stubbed; the HTTP handler is real.
vi.mock('@aws-sdk/credential-providers', () => ({
  fromNodeProviderChain: () => async () => ({ accessKeyId: 'test', secretAccessKey: 'test' }),
}));
vi.mock('gremlin', async (original) => {
  const actual = await original();
  const g = { V: () => g, has: () => g, hasNext: async () => false, withRemote: () => g };
  return {
    default: {
      ...actual.default,
      driver: {
        ...actual.default.driver,
        DriverRemoteConnection: class {
          async close() {}
        },
      },
      process: { ...actual.default.process, traversal: () => g },
    },
  };
});
vi.mock('../../shared/trackers.js', async (original) => ({
  ...(await original()),
  fetchMembershipRole: async () => 'OWNER',
}));
vi.mock('../../shared/ws-fanout.js', () => ({ broadcastToIntentChannel: async () => {} }));

import { handler } from '../index.js';

const ddb = mockClient(DynamoDBDocumentClient);
const agentcore = mockClient(BedrockAgentCoreClient);
const kms = mockClient(KMSClient);

describe('runtime dispatch without the MCP Gateway', () => {
  beforeEach(() => {
    ddb.reset();
    agentcore.reset();
    kms.reset();
    vi.stubEnv('NEPTUNE_ENDPOINT', 'localhost');
    vi.stubEnv('V2_PROCESS_TABLE', 'test-process');
    vi.stubEnv('AGENTCORE_RUNTIME_ARN', 'arn:aws:bedrock-agentcore:eu:1:runtime/x');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('sends the derive backfill payload unchanged and signs nothing', async () => {
    expect(process.env.GATEWAY_GRANT_KEY_ID).toBeUndefined();
    ddb.on(GetCommand).callsFake(async ({ Key }) =>
      Key.sk === 'META'
        ? {
            Item: {
              executionId: 'i1',
              intentId: 'i1',
              projectId: 'p1',
              status: 'SUCCEEDED',
              deriveEnrichment: 'llm',
              tierModels: { fast: 'm' },
            },
          }
        : {},
    );
    ddb.on(QueryCommand).resolves({ Items: [] });
    agentcore.on(InvokeAgentRuntimeCommand).resolves({
      response: { transformToString: async () => JSON.stringify({ ok: true }) },
    });

    const response = await handler({
      httpMethod: 'POST',
      path: '/projects/p1/intents/i1/derive',
      pathParameters: { projectId: 'p1', intentId: 'i1' },
      requestContext: {
        authorizer: { claims: { sub: 'u1', 'cognito:groups': 'platform-admin' } },
      },
      body: null,
    });

    expect(response.statusCode).toBe(200);
    const [call] = agentcore.commandCalls(InvokeAgentRuntimeCommand);
    expect(Buffer.from(call.args[0].input.payload).toString()).toBe(
      JSON.stringify({
        command: 'derive-artifacts',
        projectId: 'p1',
        intentId: 'i1',
        executionId: 'i1',
        enrichment: 'llm',
        tierModels: { fast: 'm' },
      }),
    );
    expect(kms.calls()).toHaveLength(0);
  });
});
