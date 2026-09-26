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

// Composite-key connections table stand-in (userId + providerInstance), with
// the conditional put the get-or-create relies on.
const fakeDdb = (rows = []) => {
  const items = new Map(rows.map((row) => [`${row.userId}|${row.providerInstance}`, row]));
  const id = (k) => `${k.userId}|${k.providerInstance}`;
  return {
    items,
    async send(command) {
      const { input } = command;
      if (command.constructor.name === 'GetCommand') return { Item: items.get(id(input.Key)) };
      if (command.constructor.name === 'PutCommand') {
        if (input.ConditionExpression && items.has(id(input.Item))) {
          throw Object.assign(new Error('exists'), { name: 'ConditionalCheckFailedException' });
        }
        items.set(id(input.Item), input.Item);
        return {};
      }
      throw new Error(`unexpected ${command.constructor.name}`);
    },
  };
};

const connection = (userId, externalId) => ({
  userId,
  providerInstance: 'codecommit#public',
  provider: 'codecommit',
  externalId,
});

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
    process.env.GIT_PROVIDER_CONNECTIONS_TABLE = 'git-provider-connections-test';
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

  it('connect-info mints the caller external id once and renders the trust policy for it', async () => {
    const ddb = fakeDdb();
    const handler = createCodeCommitHandler({ stsClient: stsOk(), ddbClient: ddb, provider: {} });
    const res = parse(await handler(event('GET', '/codecommit/connect-info')));
    expect(res.status).toBe(200);
    expect(res.body.externalId).toMatch(/^aidlc:[0-9a-f-]{36}$/);
    expect(res.body.principals).toEqual(PRINCIPALS);
    const [statement] = res.body.trustPolicy.Statement;
    expect(statement.Principal.AWS).toEqual(PRINCIPALS);
    expect(statement.Condition.StringEquals['sts:ExternalId']).toBe(res.body.externalId);
    // Persisted against its owner: the same user always gets the same id.
    expect(ddb.items.get('user-1|codecommit#public')?.externalId).toBe(res.body.externalId);
    const again = parse(await handler(event('GET', '/codecommit/connect-info')));
    expect(again.body.externalId).toBe(res.body.externalId);
  });

  it('connect-info renders the permissions policy and the supported regions', async () => {
    const handler = createCodeCommitHandler({
      stsClient: stsOk(),
      ddbClient: fakeDdb(),
      provider: {},
    });
    const { body } = parse(await handler(event('GET', '/codecommit/connect-info')));
    expect(body.permissionsPolicy.Statement[0]).toMatchObject({
      Action: 'codecommit:ListRepositories',
      Resource: '*',
    });
    expect(body.regions).toContain('ap-south-2');
    expect(body.regions).not.toContain('eu-central-2');
    expect(body.regions.some((r) => r.startsWith('cn-') || r.startsWith('us-gov-'))).toBe(false);
  });

  it('connect-info never renders a request-supplied external id', async () => {
    const handler = createCodeCommitHandler({
      stsClient: stsOk(),
      ddbClient: fakeDdb(),
      provider: {},
    });
    const res = parse(
      await handler(
        event('GET', '/codecommit/connect-info', { query: { externalId: EXTERNAL_ID } }),
      ),
    );
    expect(res.status).toBe(200);
    expect(res.body.externalId).not.toBe(EXTERNAL_ID);
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
    const handler = createCodeCommitHandler({
      stsClient: sts,
      ddbClient: fakeDdb([connection('user-1', EXTERNAL_ID)]),
      provider,
    });
    const res = parse(
      await handler(
        event('POST', '/codecommit/repos', { body: { roleArn: ROLE, region: 'eu-west-1' } }),
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
    const handler = createCodeCommitHandler({
      stsClient: sts,
      ddbClient: fakeDdb([connection('user-1', EXTERNAL_ID)]),
      provider: {},
    });
    const cases = [
      [{ roleArn: 'nope', region: 'eu-west-1' }, 'ROLE_ARN_INVALID'],
      [{ roleArn: ROLE, region: 'Europe' }, 'REGION_INVALID'],
      // Well-formed but not offered: no CodeCommit there, or another partition.
      [{ roleArn: ROLE, region: 'eu-central-2' }, 'REGION_UNSUPPORTED'],
      [{ roleArn: ROLE, region: 'cn-north-1' }, 'REGION_UNSUPPORTED'],
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

  it('repos refuses another user external id before STS is called', async () => {
    // user-2 learned user-1's role ARN and external ID.
    const OTHER = 'aidlc:7c9e6679-7425-40de-944b-e07fc1f90ae7';
    const asOther = (body) => ({
      ...event('POST', '/codecommit/repos', { body }),
      requestContext: { authorizer: { claims: { sub: 'user-2' } } },
    });
    for (const [rows, status, code] of [
      [[connection('user-1', EXTERNAL_ID)], 409, 'CONNECTION_REQUIRED'],
      [
        [connection('user-1', EXTERNAL_ID), connection('user-2', OTHER)],
        403,
        'EXTERNAL_ID_NOT_OWNED',
      ],
    ]) {
      const sts = stsOk();
      const handler = createCodeCommitHandler({
        stsClient: sts,
        ddbClient: fakeDdb(rows),
        provider: { listRepos: async () => [] },
      });
      const res = parse(
        await handler(asOther({ roleArn: ROLE, externalId: EXTERNAL_ID, region: 'eu-west-1' })),
      );
      expect(res).toMatchObject({ status, body: { code } });
      expect(sts.calls).toHaveLength(0);
    }
  });

  it('repos surfaces a refused trust policy as 424 with the stable code', async () => {
    const sts = {
      async send() {
        throw Object.assign(new Error('not authorized'), { name: 'AccessDenied' });
      },
    };
    const handler = createCodeCommitHandler({
      stsClient: sts,
      ddbClient: fakeDdb([connection('user-1', EXTERNAL_ID)]),
      provider: {},
    });
    const res = parse(
      await handler(
        event('POST', '/codecommit/repos', { body: { roleArn: ROLE, region: 'eu-west-1' } }),
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
