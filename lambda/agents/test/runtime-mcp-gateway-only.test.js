import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DeleteParameterCommand,
  GetParametersCommand,
  PutParameterCommand,
  SSMClient,
} from '@aws-sdk/client-ssm';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from '@aws-sdk/client-bedrock-agentcore';

const ssm = mockClient(SSMClient);
const lambda = mockClient(LambdaClient);
const runtime = mockClient(BedrockAgentCoreClient);
const SENTINEL = 'sentinel-mcp-secret-0b5e';
let handler;

const event = (method, path, body) => ({
  httpMethod: method,
  path,
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  requestContext: {
    authorizer: { claims: { sub: 'admin-1', 'cognito:groups': 'platform-admin' } },
  },
});
const remote = {
  wiki: { type: 'http', url: 'https://wiki.example/mcp', headers: { Authorization: SENTINEL } },
};
const stdio = { tool: { command: 'npx', env: { KEY: '${WIKI_KEY}' } } };

beforeAll(async () => {
  process.env.AGENT_SETTINGS_SSM_PREFIX = '/collab/dev';
  process.env.AGENT_CREDENTIAL_METADATA_FUNCTION = 'credential-metadata-test';
  process.env.AGENTCORE_RUNTIME_ARN = 'arn:aws:bedrock-agentcore:eu-central-1:1:runtime/test';
  ({ handler } = await import('../index.js'));
});

beforeEach(() => {
  ssm.reset();
  lambda.reset();
  runtime.reset();
  ssm.on(PutParameterCommand).resolves({});
  ssm.on(DeleteParameterCommand).resolves({});
  ssm.on(GetParametersCommand).resolves({ Parameters: [] });
  lambda.on(InvokeCommand).resolves({
    Payload: Buffer.from(
      JSON.stringify({ ok: true, status: { bedrockBearerTokenSet: false, kiroApiKeySet: false } }),
    ),
  });
  runtime.onAnyCommand().resolves({});
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('runtime_mcp_credentials = gateway_only — platform settings', () => {
  beforeEach(() => vi.stubEnv('RUNTIME_MCP_CREDENTIALS', 'gateway_only'));

  it.each([
    ['a remote server with an inline header', remote],
    ['a stdio server with a secret ref', stdio],
  ])('refuses %s before writing any setting', async (_label, config) => {
    const result = await handler(
      event('PUT', '/agents/settings', { prStrategy: 'pr-per-unit', customMcpServers: config }),
    );
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toMatchObject({
      code: 'runtime_mcp_gateway_only',
      error: expect.stringContaining('mcp_gateway_custom_targets'),
    });
    expect(ssm.commandCalls(PutParameterCommand)).toHaveLength(0);
  });

  it('refuses setting an MCP secret but lets an admin clear one', async () => {
    const set = await handler(event('PUT', '/agents/settings', { mcpSecrets: { K: SENTINEL } }));
    expect(set.statusCode).toBe(400);
    expect(ssm.commandCalls(PutParameterCommand)).toHaveLength(0);

    const cleared = await handler(event('PUT', '/agents/settings', { mcpSecrets: { K: '' } }));
    expect(cleared.statusCode).toBe(200);
    expect(ssm.commandCalls(DeleteParameterCommand)).toHaveLength(1);
  });

  it('still saves an empty server map so existing servers can be removed', async () => {
    const result = await handler(event('PUT', '/agents/settings', { customMcpServers: '{}' }));
    expect(result.statusCode).toBe(200);
    expect(ssm.commandCalls(PutParameterCommand)[0].args[0].input).toMatchObject({
      Name: '/collab/dev/custom-mcp-servers',
      Value: '{}',
    });
  });

  it('still reads the settings and names the profile', async () => {
    const result = await handler(event('GET', '/agents/settings'));
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body).runtimeMcpCredentials).toBe('gateway_only');
  });

  it('refuses verification before issuing a grant or invoking the runtime', async () => {
    const result = await handler(
      event('POST', '/agents/verify-mcp', {
        mcpServers: stdio,
        unsavedSecrets: { WIKI_KEY: SENTINEL },
      }),
    );
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).code).toBe('runtime_mcp_gateway_only');
    expect(runtime.commandCalls(InvokeAgentRuntimeCommand)).toHaveLength(0);
    expect(JSON.stringify(runtime.calls())).not.toContain(SENTINEL);
  });
});

describe('runtime_mcp_credentials = allow (default)', () => {
  it('keeps saving direct servers and omits the profile from the settings', async () => {
    const saved = await handler(event('PUT', '/agents/settings', { customMcpServers: stdio }));
    expect(saved.statusCode).toBe(200);
    const read = await handler(event('GET', '/agents/settings'));
    expect(JSON.parse(read.body)).not.toHaveProperty('runtimeMcpCredentials');
  });

  it('fails loudly on an unknown profile value instead of falling back to allow', async () => {
    vi.stubEnv('RUNTIME_MCP_CREDENTIALS', 'deny');
    const result = await handler(event('PUT', '/agents/settings', { customMcpServers: stdio }));
    expect(result.statusCode).toBe(500);
    expect(ssm.commandCalls(PutParameterCommand)).toHaveLength(0);
  });
});
