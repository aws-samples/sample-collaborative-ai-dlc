import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCodeCommitHandler } from '../index.js';

const PRINCIPALS = [
  'arn:aws:iam::999999999999:role/aidlc-credential-broker-dev',
  'arn:aws:iam::999999999999:role/aidlc-source-control-dev',
  'arn:aws:iam::999999999999:role/aidlc-codecommit-connector-dev',
];
const ROLE = 'arn:aws:iam::123456789012:role/aidlc-codecommit-access';
const EXTERNAL_ID = 'aidlc:0f8fad5b-d9cb-469f-a165-70867728950e';

const event = (httpMethod, path, { body, query, authed = true } = {}) => ({
  httpMethod,
  path: `/api${path}`,
  queryStringParameters: query ?? null,
  body: body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body),
  headers: { origin: 'http://localhost:5173' },
  requestContext: authed ? { authorizer: { claims: { sub: 'user-1' } } } : {},
});

const parse = (res) => ({ status: res.statusCode, body: JSON.parse(res.body) });

const stsOk = () => ({
  calls: [],
  async send(command) {
    this.calls.push(command);
    return {
      Credentials: {
        AccessKeyId: 'ASIA',
        SecretAccessKey: 's',
        SessionToken: 't',
        Expiration: new Date(),
      },
      AssumedRoleUser: { Arn: 'arn:aws:sts::123456789012:assumed-role/x/y' },
    };
  },
});

describe('codecommit handler', () => {
  let env;
  beforeEach(() => {
    env = { ...process.env };
    process.env.CODECOMMIT_PLATFORM_PRINCIPALS = PRINCIPALS.join(',');
    process.env.CORS_ALLOWED_ORIGINS = 'http://localhost:5173';
  });
  afterEach(() => {
    process.env = env;
  });

  it('answers preflight and rejects unauthenticated callers', async () => {
    const handler = createCodeCommitHandler({ stsClient: stsOk(), provider: {} });
    expect((await handler(event('OPTIONS', '/codecommit/status'))).statusCode).toBe(200);
    const res = parse(await handler(event('GET', '/codecommit/status', { authed: false })));
    expect(res.status).toBe(401);
  });

  it('status reports the platform principals and whether the deployment is configured', async () => {
    const handler = createCodeCommitHandler({ stsClient: stsOk(), provider: {} });
    const res = parse(await handler(event('GET', '/codecommit/status')));
    expect(res).toEqual({
      status: 200,
      body: { provider: 'codecommit', configured: true, principals: PRINCIPALS },
    });
    process.env.CODECOMMIT_PLATFORM_PRINCIPALS = '';
    expect(parse(await handler(event('GET', '/codecommit/status'))).body.configured).toBe(false);
  });

  it('connect-info mints an external id and renders the trust policy for it', async () => {
    const handler = createCodeCommitHandler({ stsClient: stsOk(), provider: {} });
    const res = parse(await handler(event('GET', '/codecommit/connect-info')));
    expect(res.status).toBe(200);
    expect(res.body.externalId).toMatch(/^aidlc:[0-9a-f-]{36}$/);
    expect(res.body.principals).toEqual(PRINCIPALS);
    const [statement] = res.body.trustPolicy.Statement;
    expect(statement.Principal.AWS).toEqual(PRINCIPALS);
    expect(statement.Condition.StringEquals['sts:ExternalId']).toBe(res.body.externalId);
    // Two calls never share an id.
    const again = parse(await handler(event('GET', '/codecommit/connect-info')));
    expect(again.body.externalId).not.toBe(res.body.externalId);
  });

  it('connect-info re-renders for an existing external id and rejects a malformed one', async () => {
    const handler = createCodeCommitHandler({ stsClient: stsOk(), provider: {} });
    const res = parse(
      await handler(
        event('GET', '/codecommit/connect-info', { query: { externalId: EXTERNAL_ID } }),
      ),
    );
    expect(res.body.externalId).toBe(EXTERNAL_ID);
    const bad = parse(
      await handler(event('GET', '/codecommit/connect-info', { query: { externalId: 'aidlc:x' } })),
    );
    expect(bad).toMatchObject({ status: 400, body: { code: 'EXTERNAL_ID_INVALID' } });
  });

  it('connect-info is 503 when the deployment has no platform principals', async () => {
    process.env.CODECOMMIT_PLATFORM_PRINCIPALS = '';
    const handler = createCodeCommitHandler({ stsClient: stsOk(), provider: {} });
    const res = parse(await handler(event('GET', '/codecommit/connect-info')));
    expect(res).toMatchObject({ status: 503, body: { code: 'CODECOMMIT_NOT_CONFIGURED' } });
  });

  it('repos assumes the role with the discover profile and lists through the provider', async () => {
    const sts = stsOk();
    const seen = [];
    const provider = {
      listRepos: async (ctx) => {
        seen.push(ctx);
        return [{ name: 'svc', fullName: 'arn:aws:codecommit:eu-west-1:123456789012:svc' }];
      },
    };
    const handler = createCodeCommitHandler({ stsClient: sts, provider });
    const res = parse(
      await handler(
        event('POST', '/codecommit/repos', {
          body: { roleArn: ROLE, externalId: EXTERNAL_ID, region: 'eu-west-1' },
        }),
      ),
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ accountId: '123456789012', region: 'eu-west-1' });
    expect(res.body.repositories).toHaveLength(1);
    expect(sts.calls).toHaveLength(1);
    const input = sts.calls[0].input;
    expect(input.ExternalId).toBe(EXTERNAL_ID);
    const policy = JSON.parse(input.Policy);
    expect(policy.Statement.map((s) => s.Sid)).toEqual(['DiscoverRepositories']);
    expect(seen[0]).toMatchObject({ region: 'eu-west-1', token: { accessKeyId: 'ASIA' } });
  });

  it('repos validates its body before touching STS', async () => {
    const sts = stsOk();
    const handler = createCodeCommitHandler({ stsClient: sts, provider: {} });
    const cases = [
      [{ roleArn: 'nope', externalId: EXTERNAL_ID, region: 'eu-west-1' }, 'ROLE_ARN_INVALID'],
      [{ roleArn: ROLE, externalId: 'aidlc:x', region: 'eu-west-1' }, 'EXTERNAL_ID_INVALID'],
      [{ roleArn: ROLE, externalId: EXTERNAL_ID, region: 'Europe' }, 'REGION_INVALID'],
    ];
    for (const [body, code] of cases) {
      const res = parse(await handler(event('POST', '/codecommit/repos', { body })));
      expect(res).toMatchObject({ status: 400, body: { code } });
    }
    expect(parse(await handler(event('POST', '/codecommit/repos', { body: '{' }))).status).toBe(
      400,
    );
    expect(sts.calls).toHaveLength(0);
  });

  it('repos surfaces a refused trust policy as 424 with the stable code', async () => {
    const sts = {
      async send() {
        throw Object.assign(new Error('not authorized'), { name: 'AccessDenied' });
      },
    };
    const handler = createCodeCommitHandler({ stsClient: sts, provider: {} });
    const res = parse(
      await handler(
        event('POST', '/codecommit/repos', {
          body: { roleArn: ROLE, externalId: EXTERNAL_ID, region: 'eu-west-1' },
        }),
      ),
    );
    expect(res.status).toBe(424);
    expect(res.body.code).toBe('ROLE_ASSUMPTION_DENIED');
    expect(res.body.error).not.toContain('not authorized');
  });

  it('unknown routes are 404', async () => {
    const handler = createCodeCommitHandler({ stsClient: stsOk(), provider: {} });
    expect(parse(await handler(event('GET', '/codecommit/whatever'))).status).toBe(404);
  });
});
