import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DeleteParameterCommand,
  SSMClient,
  GetParametersCommand,
  PutParameterCommand,
} from '@aws-sdk/client-ssm';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';

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
