import { describe, expect, it, vi } from 'vitest';
import { Logger } from '@aws-lambda-powertools/logger';
import { logSafeEventIfEnabled, redactEventForLogging } from '../safe-event-logger.js';

const sensitiveRouteEvents = [
  {
    name: 'agent settings credentials',
    event: {
      httpMethod: 'PUT',
      path: '/agents/settings',
      headers: {
        Authorization: 'Bearer cognito-jwt-secret',
        Cookie: 'session=session-secret',
      },
      requestContext: {
        requestId: 'request-1',
        stage: 'api',
        authorizer: { claims: { sub: 'user-1', email: 'private@example.com' } },
      },
      body: JSON.stringify({
        bedrockBearerToken: 'bedrock-bearer-secret',
        kiroApiKey: 'kiro-api-secret',
        cliModels: { claude: 'model-id' },
      }),
    },
  },
  {
    name: 'personal agent credentials',
    event: {
      httpMethod: 'PUT',
      path: '/users/me/agent-credentials',
      body: JSON.stringify({
        bedrockBearerToken: 'bedrock-bearer-secret',
        kiroApiKey: 'kiro-api-secret',
      }),
    },
  },
  {
    name: 'project agent credentials',
    event: {
      httpMethod: 'PUT',
      path: '/projects/project-1/agent-credentials',
      pathParameters: { projectId: 'project-1' },
      body: JSON.stringify({
        bedrockBearerToken: 'bedrock-bearer-secret',
        kiroApiKey: 'kiro-api-secret',
      }),
    },
  },
  {
    name: 'project MCP secrets',
    event: {
      httpMethod: 'PUT',
      path: '/projects/project-1/custom-mcp-servers/secrets',
      pathParameters: { projectId: 'project-1' },
      body: JSON.stringify({
        mcpSecrets: { GITHUB_TOKEN: 'mcp-secret-value' },
        customMcpServers: {
          private: {
            url: 'https://example.com/mcp?api_key=mcp-url-secret',
            headers: { Authorization: 'Bearer mcp-header-secret' },
          },
        },
      }),
    },
  },
  {
    name: 'MCP verification drafts',
    event: {
      httpMethod: 'POST',
      path: '/agents/verify-mcp',
      body: JSON.stringify({
        projectId: 'project-1',
        mcpServers: {
          private: {
            command: 'npx',
            args: ['server.js', '--api-key', 'mcp-args-secret'],
            env: { API_KEY: 'inline-mcp-env-secret' },
            headers: { Authorization: 'Bearer inline-mcp-header-secret' },
          },
        },
        unsavedSecrets: {
          CONTEXT7_API_KEY: 'just-typed-mcp-secret',
        },
      }),
    },
  },
  {
    name: 'tracker OAuth callback',
    event: {
      httpMethod: 'GET',
      path: '/trackers/callback/jira-cloud',
      queryStringParameters: {
        code: 'oauth-authorization-code',
        state: 'signed-oauth-state',
      },
      rawQueryString: 'code=oauth-authorization-code&state=signed-oauth-state',
      cookies: ['oauth-session=cookie-secret'],
    },
  },
  {
    name: 'tracker OAuth configuration',
    event: {
      httpMethod: 'PUT',
      path: '/trackers/providers/jira-cloud/oauth-config',
      headers: { 'X-Api-Key': 'api-key-secret' },
      body: JSON.stringify({
        clientId: 'oauth-client-id',
        clientSecret: 'oauth-client-secret',
      }),
    },
  },
  {
    name: 'tracker OAuth connection ticket',
    event: {
      httpMethod: 'POST',
      path: '/trackers/connections/jira-cloud/cloud',
      body: JSON.stringify({
        ticket: 'signed-token-ticket',
        cloudId: 'cloud-123',
      }),
    },
  },
];

describe('redactEventForLogging', () => {
  it.each(sensitiveRouteEvents)('redacts values for $name', ({ event }) => {
    const redacted = redactEventForLogging(event);
    const serialized = JSON.stringify(redacted);

    expect(redacted.httpMethod).toBe(event.httpMethod);
    expect(redacted.path).toBe(event.path);
    if (event.body !== undefined) {
      expect(redacted.body).toBeTypeOf('string');
    }

    for (const secret of [
      'cognito-jwt-secret',
      'session-secret',
      'private@example.com',
      'bedrock-bearer-secret',
      'kiro-api-secret',
      'mcp-secret-value',
      'mcp-url-secret',
      'mcp-header-secret',
      'mcp-args-secret',
      'inline-mcp-env-secret',
      'inline-mcp-header-secret',
      'just-typed-mcp-secret',
      'oauth-authorization-code',
      'signed-oauth-state',
      'cookie-secret',
      'api-key-secret',
      'oauth-client-secret',
      'signed-token-ticket',
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('keeps non-secret agent settings while redacting all credential scopes', () => {
    const redacted = redactEventForLogging({
      httpMethod: 'PUT',
      resource: '/agents/settings',
      path: '/agents/settings',
      body: JSON.stringify({
        bedrockBearerToken: 'platform-bedrock-secret',
        kiroApiKey: 'platform-kiro-secret',
        cliModels: { claude: 'model-id' },
        customMcpServers: JSON.stringify({
          private: {
            command: 'npx',
            args: ['server.js', '--api-key', 'args-secret'],
            url: 'https://example.com/mcp?api_key=url-secret',
            env: { SAFE_SETTING: 'secret-env-value' },
            headers: { Authorization: 'Bearer custom-secret' },
          },
        }),
        mcpSecrets: { GITHUB_TOKEN: 'github-mcp-secret' },
      }),
    });

    const body = JSON.parse(redacted.body);
    expect(body).toMatchObject({
      bedrockBearerToken: '[REDACTED]',
      kiroApiKey: '[REDACTED]',
      cliModels: { claude: 'model-id' },
      mcpSecrets: { GITHUB_TOKEN: '[REDACTED]' },
    });
    expect(body.customMcpServers).toBe('[REDACTED]');
    expect(JSON.stringify(body)).not.toContain('args-secret');
    expect(JSON.stringify(body)).not.toContain('url-secret');
  });

  it('redacts values from managed environment-variable maps', () => {
    const redacted = redactEventForLogging({
      httpMethod: 'PUT',
      path: '/environments/custom',
      body: JSON.stringify({
        name: 'Custom',
        recipe: {
          environmentVariables: {
            BUILD_MODE: 'strict',
            SERVICE_TOKEN: 'environment-secret',
          },
        },
      }),
    });

    expect(JSON.parse(redacted.body)).toMatchObject({
      name: 'Custom',
      recipe: {
        environmentVariables: {
          BUILD_MODE: '[REDACTED]',
          SERVICE_TOKEN: '[REDACTED]',
        },
      },
    });
  });

  it('redacts the full MCP verification config and draft credentials', () => {
    const redacted = redactEventForLogging({
      httpMethod: 'POST',
      path: '/agents/verify-mcp',
      body: JSON.stringify({
        projectId: 'project-1',
        mcpServers: JSON.stringify({
          context7: {
            command: 'npx',
            args: ['-y', '@upstash/context7-mcp', '--api-key', 'args-secret'],
            url: 'https://example.com/mcp?api_key=url-secret',
            env: { CONTEXT7_API_KEY: 'inline-secret' },
            headers: { 'X-Api-Key': 'inline-header-secret' },
          },
        }),
        unsavedSecrets: {
          CONTEXT7_API_KEY: 'draft-secret',
        },
      }),
    });

    const body = JSON.parse(redacted.body);
    expect(body.projectId).toBe('project-1');
    expect(body.unsavedSecrets).toEqual({ CONTEXT7_API_KEY: '[REDACTED]' });
    expect(body.mcpServers).toBe('[REDACTED]');
    expect(JSON.stringify(body)).not.toContain('args-secret');
    expect(JSON.stringify(body)).not.toContain('url-secret');
  });

  it('preserves non-sensitive REST event fields while removing headers', () => {
    const redacted = redactEventForLogging({
      version: '2.0',
      routeKey: 'PUT /agents/settings',
      rawPath: '/agents/settings',
      headers: { Authorization: 'secret', 'Content-Type': 'application/json' },
      multiValueHeaders: { 'X-Origin-Verify': ['cloudfront-origin-secret'] },
      queryStringParameters: { state: 'open', page: '2' },
      multiValueQueryStringParameters: { tag: ['a', 'b'] },
      pathParameters: { projectId: 'project-secret' },
      requestContext: {
        requestId: 'request-123',
        stage: '$default',
        http: { method: 'PUT' },
      },
      body: '{}',
      isBase64Encoded: false,
    });

    expect(redacted).toMatchObject({
      queryStringParameters: { state: 'open', page: '2' },
      multiValueQueryStringParameters: { tag: ['a', 'b'] },
      pathParameters: { projectId: 'project-secret' },
      requestContext: {
        requestId: 'request-123',
        stage: '$default',
        http: { method: 'PUT' },
      },
      body: '{}',
    });
    expect(redacted).not.toHaveProperty('headers');
    expect(redacted).not.toHaveProperty('multiValueHeaders');
    expect(JSON.stringify(redacted)).not.toContain('cloudfront-origin-secret');
  });

  it('redacts normalized credential names in query maps', () => {
    const redacted = redactEventForLogging({
      path: '/example',
      headers: {
        token: 'header-secret',
        'Content-Type': 'application/json',
      },
      queryStringParameters: {
        accessToken: 'query-secret',
        state: 'open',
      },
    });

    expect(redacted).not.toHaveProperty('headers');
    expect(redacted.queryStringParameters).toEqual({
      accessToken: '[REDACTED]',
      state: 'open',
    });
  });
});

describe('logSafeEventIfEnabled', () => {
  it('passes only the sanitized event to Powertools', () => {
    const logger = { logEventIfEnabled: vi.fn() };
    const event = sensitiveRouteEvents[0].event;

    logSafeEventIfEnabled(logger, event);

    expect(logger.logEventIfEnabled).toHaveBeenCalledWith(redactEventForLogging(event));
    expect(JSON.stringify(logger.logEventIfEnabled.mock.calls)).not.toContain(
      'bedrock-bearer-secret',
    );
  });

  it('emits sanitized metadata through the real Powertools event logger', () => {
    vi.stubEnv('POWERTOOLS_LOGGER_LOG_EVENT', 'true');
    const lines = [];
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      lines.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    });
    try {
      const logger = new Logger({ serviceName: 'safe-event-test' });
      logSafeEventIfEnabled(logger, sensitiveRouteEvents[0].event);

      const output = lines.join('');
      expect(output).toContain('"message":"Lambda invocation event"');
      expect(output).toContain('"path":"/agents/settings"');
      expect(output).not.toContain('"headers"');
      expect(output).not.toContain('"Authorization"');
      expect(output).not.toContain('"Cookie"');
      expect(output).toContain('\\"bedrockBearerToken\\":\\"[REDACTED]\\"');
      expect(output).toContain('\\"cliModels\\":{\\"claude\\":\\"model-id\\"}');
      expect(output).not.toContain('cognito-jwt-secret');
      expect(output).not.toContain('session-secret');
      expect(output).not.toContain('bedrock-bearer-secret');
      expect(output).not.toContain('kiro-api-secret');
    } finally {
      stdoutSpy.mockRestore();
      vi.unstubAllEnvs();
    }
  });
});
