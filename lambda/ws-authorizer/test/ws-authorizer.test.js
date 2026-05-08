import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { CognitoJwtVerifier } from 'aws-jwt-verify';

vi.mock('aws-jwt-verify', () => ({
  CognitoJwtVerifier: { create: vi.fn() },
}));

const USER_POOL_ID = 'eu-west-1_test';
const CLIENT_ID = 'test-client-id';
const METHOD_ARN = 'arn:aws:execute-api:eu-west-1:123456789012:abc/test/$connect';
const TOKEN = 'header.payload.signature';

const loadHandler = async () => {
  vi.resetModules();
  return (await import('../index.js')).handler;
};

const mockVerifier = (impl) => {
  const verify = vi.fn(impl);
  CognitoJwtVerifier.create.mockReturnValue({ verify });
  return verify;
};

describe('ws-authorizer handler', () => {
  beforeEach(() => {
    CognitoJwtVerifier.create.mockReset();
    vi.stubEnv('COGNITO_USER_POOL_ID', USER_POOL_ID);
    vi.stubEnv('COGNITO_CLIENT_ID', CLIENT_ID);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('denies when queryStringParameters is missing', async () => {
    const handler = await loadHandler();

    const res = await handler({ methodArn: METHOD_ARN });

    expect(res).toEqual({
      principalId: 'user',
      policyDocument: {
        Version: '2012-10-17',
        Statement: [
          { Action: 'execute-api:Invoke', Effect: 'Deny', Resource: METHOD_ARN },
        ],
      },
      context: {},
    });
    expect(CognitoJwtVerifier.create).not.toHaveBeenCalled();
  });

  it('denies when the token query parameter is undefined', async () => {
    const handler = await loadHandler();

    const res = await handler({
      methodArn: METHOD_ARN,
      queryStringParameters: { other: 'value' },
    });

    expect(res.policyDocument.Statement[0].Effect).toBe('Deny');
    expect(res.principalId).toBe('user');
    expect(CognitoJwtVerifier.create).not.toHaveBeenCalled();
  });

  it('allows a valid token and returns context from the payload', async () => {
    mockVerifier(async () => ({
      sub: 'user-123',
      'cognito:username': 'alice',
      email: 'alice@example.com',
    }));
    const handler = await loadHandler();

    const res = await handler({
      methodArn: METHOD_ARN,
      queryStringParameters: { token: TOKEN },
    });

    expect(res).toEqual({
      principalId: 'user-123',
      policyDocument: {
        Version: '2012-10-17',
        Statement: [
          { Action: 'execute-api:Invoke', Effect: 'Allow', Resource: METHOD_ARN },
        ],
      },
      context: { userId: 'user-123', userName: 'alice' },
    });
  });

  it('falls back to email when cognito:username is missing', async () => {
    mockVerifier(async () => ({
      sub: 'user-123',
      email: 'alice@example.com',
    }));
    const handler = await loadHandler();

    const res = await handler({
      methodArn: METHOD_ARN,
      queryStringParameters: { token: TOKEN },
    });

    expect(res.context).toEqual({
      userId: 'user-123',
      userName: 'alice@example.com',
    });
  });

  it('falls back to sub when cognito:username and email are missing', async () => {
    mockVerifier(async () => ({ sub: 'user-123' }));
    const handler = await loadHandler();

    const res = await handler({
      methodArn: METHOD_ARN,
      queryStringParameters: { token: TOKEN },
    });

    expect(res.context).toEqual({
      userId: 'user-123',
      userName: 'user-123',
    });
  });

  it('denies when verification throws and does not reject', async () => {
    mockVerifier(async () => {
      throw new Error('token expired');
    });
    const handler = await loadHandler();

    const res = await handler({
      methodArn: METHOD_ARN,
      queryStringParameters: { token: TOKEN },
    });

    expect(res.principalId).toBe('user');
    expect(res.policyDocument.Statement[0].Effect).toBe('Deny');
    expect(res.policyDocument.Statement[0].Resource).toBe(METHOD_ARN);
  });

  it('builds a policy document with the exact shape API Gateway expects', async () => {
    mockVerifier(async () => ({ sub: 'user-123', 'cognito:username': 'alice' }));
    const handler = await loadHandler();

    const res = await handler({
      methodArn: METHOD_ARN,
      queryStringParameters: { token: TOKEN },
    });

    expect(res.policyDocument).toEqual({
      Version: '2012-10-17',
      Statement: [
        { Action: 'execute-api:Invoke', Effect: 'Allow', Resource: METHOD_ARN },
      ],
    });
  });

  it('constructs the verifier once and reuses it across invocations', async () => {
    const verify = mockVerifier(async () => ({
      sub: 'user-123',
      'cognito:username': 'alice',
    }));
    const handler = await loadHandler();

    await handler({
      methodArn: METHOD_ARN,
      queryStringParameters: { token: TOKEN },
    });
    await handler({
      methodArn: METHOD_ARN,
      queryStringParameters: { token: TOKEN },
    });

    expect(CognitoJwtVerifier.create).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledTimes(2);
  });

  it('passes env-driven config to create() and the token to verify()', async () => {
    const verify = mockVerifier(async () => ({
      sub: 'user-123',
      'cognito:username': 'alice',
    }));
    const handler = await loadHandler();

    await handler({
      methodArn: METHOD_ARN,
      queryStringParameters: { token: TOKEN },
    });

    expect(CognitoJwtVerifier.create).toHaveBeenCalledWith({
      userPoolId: USER_POOL_ID,
      tokenUse: 'id',
      clientId: CLIENT_ID,
    });
    expect(verify).toHaveBeenCalledWith(TOKEN);
  });
});
