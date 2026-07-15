import { describe, it, expect, vi } from 'vitest';
import { handler } from '../index.js';

// Mock AWS SDK
vi.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: vi.fn(),
}));

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: {
    from: vi.fn(() => ({})),
  },
}));

vi.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: vi.fn(),
}));

vi.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: vi.fn(),
  PutParameterCommand: vi.fn(),
  DeleteParameterCommand: vi.fn(),
}));

describe('Bitbucket Lambda', () => {
  it('should handle OPTIONS request', async () => {
    const event = {
      httpMethod: 'OPTIONS',
      path: '/api/bitbucket/auth',
      headers: {},
      requestContext: {
        authorizer: {
          claims: {
            sub: 'test-user-id',
          },
        },
      },
    };

    const result = await handler(event);

    expect(result.statusCode).toBe(200);
    expect(result.headers).toMatchObject({
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    });
  });

  it('should require authentication for protected routes', async () => {
    const event = {
      httpMethod: 'GET',
      path: '/api/bitbucket/repos',
      headers: {},
      requestContext: {},
    };

    const result = await handler(event);

    expect(result.statusCode).toBe(401);
  });
});
