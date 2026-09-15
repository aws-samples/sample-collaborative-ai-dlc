import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DeleteParameterCommand,
  SSMClient,
  GetParametersCommand,
  PutParameterCommand,
} from '@aws-sdk/client-ssm';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import { verifyAgentCredentialGrant } from '../../shared/agent-credential-grants.js';

const ssmMock = mockClient(SSMClient);
const lambdaMock = mockClient(LambdaClient);
const agentcoreMock = mockClient(BedrockAgentCoreClient);
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
  process.env.CREDENTIAL_BROKER_ROLE_ARN = 'arn:aws:iam::111111111111:role/broker';
  process.env.AGENT_CREDENTIAL_GRANT_SECRET = 's'.repeat(48);
  process.env.AGENTCORE_RUNTIME_ARN =
    'arn:aws:bedrock-agentcore:us-east-1:111111111111:runtime/core';
  ({ handler } = await import('../index.js'));
});

beforeEach(() => {
  ssmMock.reset();
  ssmMock.on(GetParametersCommand).resolves({ Parameters: [] });
  lambdaMock.reset();
  agentcoreMock.reset();
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

describe('Bedrock IAM administration', () => {
  const config = { roleArn: 'arn:aws:iam::222222222222:role/Inference', region: 'eu-west-1' };
  const setupEvent = (body, groups = 'platform-admin') => ({
    ...event('POST', body, groups),
    path: '/agents/bedrock-iam',
  });

  it('gates setup and verification on platform administration', async () => {
    const denied = await handler(setupEvent({ action: 'setup', config }, null));
    expect(denied.statusCode).toBe(403);
    const allowed = await handler(setupEvent({ action: 'setup', config }));
    expect(allowed.statusCode).toBe(200);
    expect(JSON.parse(allowed.body)).toMatchObject({
      applicationAccountId: '111111111111',
      inferenceAccountId: '222222222222',
      config,
    });
    expect(ssmMock.commandCalls(PutParameterCommand)).toHaveLength(0);
    expect(agentcoreMock.commandCalls(InvokeAgentRuntimeCommand)).toHaveLength(0);
  });

  it('checks IAM through the runtime and does not activate the mode during verification', async () => {
    agentcoreMock.on(InvokeAgentRuntimeCommand).resolves({
      response: { transformToString: async () => JSON.stringify({ verified: true, models: [] }) },
    });
    const result = await handler(setupEvent({ action: 'verify', config }));
    expect(JSON.parse(result.body).verified).toBe(true);
    const call = agentcoreMock.commandCalls(InvokeAgentRuntimeCommand)[0].args[0].input;
    expect(call.agentRuntimeArn).toBe(process.env.AGENTCORE_RUNTIME_ARN);
    const payload = JSON.parse(Buffer.from(call.payload).toString());
    expect(payload.command).toBe('verify-bedrock-iam');
    expect(payload.config).toBeUndefined();
    expect(
      verifyAgentCredentialGrant(
        payload.agentCredentialGrant,
        process.env.AGENT_CREDENTIAL_GRANT_SECRET,
      ),
    ).toMatchObject({
      purpose: 'capabilities',
      projectId: null,
      bindings: [payload.credentialBindings.bedrock],
    });
    expect(payload.credentialBindings.bedrock.iam).toEqual(config);
    expect(ssmMock.commandCalls(PutParameterCommand)).toHaveLength(0);
  });

  it('denies space IAM setup and verification to non-platform admins before resolving a runtime', async () => {
    for (const action of ['defaults', 'setup', 'verify']) {
      const result = await handler(setupEvent({ action, projectId: 'space-b', config }, null));
      expect(result.statusCode).toBe(403);
    }
    expect(agentcoreMock.commandCalls(InvokeAgentRuntimeCommand)).toHaveLength(0);
  });

  it('allows only platform admins to set or clear a space role through the credential API', async () => {
    const request = (body, groups = null) => ({
      ...event('PUT', body, groups),
      path: '/projects/space-a/agent-credentials',
      pathParameters: { projectId: 'space-a' },
    });
    for (const bedrockIam of [config, null]) {
      const result = await handler(request({ bedrockIam }));
      expect(result.statusCode).toBe(403);
    }
    expect(ssmMock.commandCalls(PutParameterCommand)).toHaveLength(0);
    ssmMock.on(GetParametersCommand).resolves({
      Parameters: [
        { Name: '/collab/dev/bedrock-auth', Value: JSON.stringify({ mode: 'iam', iam: config }) },
      ],
    });
    const allowed = await handler(request({ bedrockIam: config }, 'platform-admin'));
    expect(allowed.statusCode).toBe(200);
    expect(ssmMock.commandCalls(PutParameterCommand)[0].args[0].input).toMatchObject({
      Name: '/collab/dev/projects/space-a/agent-credentials/bedrock-iam',
      Value: JSON.stringify(config),
    });
  });

  it('enforces the platform mode on API writes, including personal keys', async () => {
    ssmMock.on(GetParametersCommand).resolves({
      Parameters: [
        { Name: '/collab/dev/bedrock-auth', Value: JSON.stringify({ mode: 'iam', iam: config }) },
      ],
    });
    const rejected = await handler({
      ...event('PUT', { bedrockBearerToken: 'new-key' }),
      path: '/users/me/agent-credentials',
    });
    expect(rejected.statusCode).toBe(400);
    expect(JSON.parse(rejected.body).error).toContain('disabled');
    expect(ssmMock.commandCalls(PutParameterCommand)).toHaveLength(0);
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
