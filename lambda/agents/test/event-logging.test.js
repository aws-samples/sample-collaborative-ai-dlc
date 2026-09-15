import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { PutParameterCommand, SSMClient } from '@aws-sdk/client-ssm';

const ssmMock = mockClient(SSMClient);
let handler;

beforeAll(async () => {
  vi.stubEnv('POWERTOOLS_LOGGER_LOG_EVENT', 'true');
  vi.stubEnv('AGENT_SETTINGS_SSM_PREFIX', '/collab/dev');
  vi.resetModules();
  ({ handler } = await import('../index.js'));
});

afterAll(() => {
  vi.unstubAllEnvs();
});

beforeEach(() => {
  ssmMock.reset();
  ssmMock.on(PutParameterCommand).resolves({});
});

describe('credential-safe event logging', () => {
  it('does not log PUT /agents/settings credentials or authorization', async () => {
    const lines = [];
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      lines.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    });
    try {
      const response = await handler({
        httpMethod: 'PUT',
        path: '/agents/settings',
        headers: {
          Authorization: 'Bearer raw-cognito-token',
          'Content-Type': 'application/json',
        },
        requestContext: {
          requestId: 'request-settings-1',
          authorizer: {
            claims: {
              sub: 'platform-admin-user',
              email: 'private-admin@example.com',
              'cognito:groups': 'platform-admin',
            },
          },
        },
        body: JSON.stringify({
          bedrockBearerToken: 'raw-bedrock-bearer-token',
          kiroApiKey: 'raw-kiro-api-key',
          cliModels: { claude: 'safe-model-id' },
        }),
      });

      expect(response.statusCode).toBe(200);
      const raw = lines.join('');
      const logged = lines
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .find((line) => line?.message === 'Lambda invocation event');

      expect(logged?.event).toMatchObject({
        httpMethod: 'PUT',
        path: '/agents/settings',
        headers: {
          Authorization: '[REDACTED]',
          'Content-Type': 'application/json',
        },
        requestContext: {
          requestId: 'request-settings-1',
          authorizer: '[REDACTED]',
        },
      });
      expect(JSON.parse(logged.event.body)).toEqual({
        bedrockBearerToken: '[REDACTED]',
        kiroApiKey: '[REDACTED]',
        cliModels: { claude: 'safe-model-id' },
      });
      expect(raw).not.toContain('raw-cognito-token');
      expect(raw).not.toContain('raw-bedrock-bearer-token');
      expect(raw).not.toContain('raw-kiro-api-key');
      expect(raw).not.toContain('private-admin@example.com');
    } finally {
      stdoutSpy.mockRestore();
    }
  });
});
