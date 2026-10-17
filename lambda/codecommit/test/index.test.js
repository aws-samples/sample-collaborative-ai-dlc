import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCodeCommitHandler } from '../index.js';
import { ProviderError } from '../../shared/git-providers/errors.js';

const PRINCIPALS = [
  'arn:aws:iam::999999999999:role/aidlc-credential-broker-dev',
  'arn:aws:iam::999999999999:role/aidlc-source-control-dev',
  'arn:aws:iam::999999999999:role/aidlc-codecommit-connector-dev',
];
const ROLE = 'arn:aws:iam::123456789012:role/aidlc-codecommit-access';
const EXTERNAL_ID = 'aidlc:0f8fad5b-d9cb-469f-a165-70867728950e';
const PARAM = '/aidlc/dev/codecommit-connection';

const event = (httpMethod, path, { body, admin = false, authed = true } = {}) => ({
  httpMethod,
  path: `/api${path}`,
  queryStringParameters: null,
  body: body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body),
  headers: { origin: 'http://localhost:5173' },
  requestContext: authed
    ? {
        authorizer: {
          claims: {
            sub: 'user-1',
            ...(admin ? { 'cognito:groups': 'platform-admin' } : {}),
          },
        },
      }
    : {},
});

const parse = (res) => ({ status: res.statusCode, body: JSON.parse(res.body) });

// SSM stub holding one connection value, recording puts.
const fakeSsm = (value = '{}') => ({
  value,
  puts: [],
  async send(command) {
    const name = command.constructor.name;
    if (name === 'GetParameterCommand') return { Parameter: { Value: this.value } };
    if (name === 'PutParameterCommand') {
      this.puts.push(command.input);
      this.value = command.input.Value;
      return {};
    }
    throw new Error(`unexpected ${name}`);
  },
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

const stsDenied = () => ({
  calls: [],
  async send(command) {
    this.calls.push(command);
    throw Object.assign(new Error('not authorized to perform sts:AssumeRole'), {
      name: 'AccessDenied',
    });
  },
});

const repo = (name) => ({
  name,
  fullName: `arn:aws:codecommit:eu-west-1:123456789012:${name}`,
  arn: `arn:aws:codecommit:eu-west-1:123456789012:${name}`,
});

describe('codecommit handler', () => {
  let env;
  beforeEach(() => {
    env = { ...process.env };
    process.env.CODECOMMIT_PLATFORM_PRINCIPALS = PRINCIPALS.join(',');
    process.env.CODECOMMIT_EXTERNAL_ID = EXTERNAL_ID;
    process.env.CODECOMMIT_CONNECTION_PARAM = PARAM;
    process.env.CORS_ALLOWED_ORIGINS = 'http://localhost:5173';
  });
  afterEach(() => {
    process.env = env;
  });

  it('answers preflight and rejects unauthenticated callers', async () => {
    const handler = createCodeCommitHandler({ ssmClient: fakeSsm(), provider: {} });
    expect((await handler(event('OPTIONS', '/codecommit/status'))).statusCode).toBe(200);
    expect(parse(await handler(event('GET', '/codecommit/status', { authed: false }))).status).toBe(
      401,
    );
  });

  // ----- denied access first (AGENTS.md) --------------------------------------

  it('refuses /admin/config to a non-admin on both methods', async () => {
    const handler = createCodeCommitHandler({
      stsClient: stsOk(),
      ssmClient: fakeSsm(),
      provider: {},
    });
    for (const method of ['GET', 'PUT']) {
      const res = parse(
        await handler(
          event(method, '/codecommit/admin/config', {
            admin: false,
            body: method === 'PUT' ? { roleArn: ROLE, region: 'eu-west-1' } : undefined,
          }),
        ),
      );
      expect(res).toMatchObject({ status: 403, body: { code: 'PLATFORM_ADMIN_REQUIRED' } });
    }
  });

  it('never returns principals or external id to non-admin status or repos routes', async () => {
    const ssm = fakeSsm(JSON.stringify({ roleArn: ROLE, region: 'eu-west-1' }));
    const handler = createCodeCommitHandler({
      stsClient: stsOk(),
      ssmClient: ssm,
      provider: { listRepos: async () => [], getRepositoryAccess: async () => ({}) },
    });
    const status = parse(await handler(event('GET', '/codecommit/status')));
    expect(status.body).toEqual({ configured: true, region: 'eu-west-1' });
    expect(JSON.stringify(status.body)).not.toContain('aidlc:');
    expect(JSON.stringify(status.body)).not.toContain('role/');
  });

  // ----- admin GET/PUT --------------------------------------------------------

  it('admin GET returns principals, external id, trust/permissions policies and the saved connection', async () => {
    const ssm = fakeSsm(JSON.stringify({ roleArn: ROLE, region: 'eu-west-1' }));
    const handler = createCodeCommitHandler({ stsClient: stsOk(), ssmClient: ssm, provider: {} });
    const res = parse(await handler(event('GET', '/codecommit/admin/config', { admin: true })));
    expect(res.status).toBe(200);
    expect(res.body.principals).toEqual(PRINCIPALS);
    expect(res.body.externalId).toBe(EXTERNAL_ID);
    expect(res.body.roleArn).toBe(ROLE);
    expect(res.body.region).toBe('eu-west-1');
    const [statement] = res.body.trustPolicy.Statement;
    expect(statement.Principal.AWS).toEqual(PRINCIPALS);
    expect(statement.Condition.StringEquals['sts:ExternalId']).toBe(EXTERNAL_ID);
    // Permissions policy is the tag variant with placeholders: the admin card
    // fills them from the values being typed, so a change never shows the old
    // scope. The region list is the backend's, served to the card.
    const tagged = res.body.permissionsPolicy.Statement[1];
    expect(tagged.Resource).toBe('arn:aws:codecommit:<region>:<account-id>:*');
    expect(res.body.regions).toContain('eu-west-1');
    expect(tagged.Condition).toEqual({ StringEquals: { 'aws:ResourceTag/aidlc': 'true' } });
  });

  it('admin GET reports a null connection before anything is saved', async () => {
    const handler = createCodeCommitHandler({
      stsClient: stsOk(),
      ssmClient: fakeSsm('{}'),
      provider: {},
    });
    const res = parse(await handler(event('GET', '/codecommit/admin/config', { admin: true })));
    expect(res.body.roleArn).toBeNull();
    expect(res.body.region).toBeNull();
    expect(res.body.permissionsPolicy.Statement[1].Resource).toBe(
      'arn:aws:codecommit:<region>:<account-id>:*',
    );
  });

  it('admin PUT validates the region and role before touching STS', async () => {
    const sts = stsOk();
    const ssm = fakeSsm('{}');
    const handler = createCodeCommitHandler({ stsClient: sts, ssmClient: ssm, provider: {} });
    const cases = [
      [{ roleArn: 'nope', region: 'eu-west-1' }, 'ROLE_ARN_INVALID'],
      [{ roleArn: ROLE, region: 'Europe' }, 'REGION_INVALID'],
      [{ roleArn: ROLE, region: 'eu-central-2' }, 'REGION_UNSUPPORTED'],
      [{ roleArn: ROLE, region: 'cn-north-1' }, 'REGION_UNSUPPORTED'],
    ];
    for (const [body, code] of cases) {
      const res = parse(
        await handler(event('PUT', '/codecommit/admin/config', { admin: true, body })),
      );
      expect(res).toMatchObject({ status: 400, body: { code } });
    }
    expect(sts.calls).toHaveLength(0);
    expect(ssm.puts).toHaveLength(0);
  });

  it('admin PUT proves the trust (assume + list), then writes and echoes the connection', async () => {
    const sts = stsOk();
    const ssm = fakeSsm('{}');
    const listed = [];
    const provider = {
      listRepos: async (ctx) => {
        listed.push(ctx);
        return [];
      },
    };
    const handler = createCodeCommitHandler({ stsClient: sts, ssmClient: ssm, provider });
    const res = parse(
      await handler(
        event('PUT', '/codecommit/admin/config', {
          admin: true,
          body: { roleArn: ROLE, region: 'eu-west-1' },
        }),
      ),
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ roleArn: ROLE, region: 'eu-west-1' });
    // One AssumeRole with the platform external id and the discover profile.
    expect(sts.calls).toHaveLength(1);
    expect(sts.calls[0].input.ExternalId).toBe(EXTERNAL_ID);
    expect(JSON.parse(sts.calls[0].input.Policy).Statement[0].Sid).toBe('DiscoverRepositories');
    // One ListRepositories under the assumed role.
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ region: 'eu-west-1', accountId: '123456789012' });
    // Written exactly once.
    expect(ssm.puts).toHaveLength(1);
    expect(JSON.parse(ssm.puts[0].Value)).toEqual({ roleArn: ROLE, region: 'eu-west-1' });
  });

  it('admin PUT on a refused trust is 424 and writes nothing', async () => {
    const sts = stsDenied();
    const ssm = fakeSsm('{}');
    const handler = createCodeCommitHandler({
      stsClient: sts,
      ssmClient: ssm,
      provider: { listRepos: async () => [] },
    });
    const res = parse(
      await handler(
        event('PUT', '/codecommit/admin/config', {
          admin: true,
          body: { roleArn: ROLE, region: 'eu-west-1' },
        }),
      ),
    );
    expect(res.status).toBe(424);
    expect(res.body.code).toBe('ROLE_ASSUMPTION_DENIED');
    expect(res.body.hint).toBeTruthy();
    expect(res.body.error).not.toContain('not authorized');
    expect(ssm.puts).toHaveLength(0);
  });

  // ----- status ---------------------------------------------------------------

  it('status reports configured/region for any user', async () => {
    const handler = (value) =>
      createCodeCommitHandler({ stsClient: stsOk(), ssmClient: fakeSsm(value), provider: {} });
    expect(parse(await handler('{}')(event('GET', '/codecommit/status'))).body).toEqual({
      configured: false,
      region: null,
    });
    expect(
      parse(
        await handler(JSON.stringify({ roleArn: ROLE, region: 'eu-west-1' }))(
          event('GET', '/codecommit/status'),
        ),
      ).body,
    ).toEqual({ configured: true, region: 'eu-west-1' });
  });

  // ----- repos ----------------------------------------------------------------

  it('repos returns a bare array and hides unreadable (403) and absent (404) repos', async () => {
    const ssm = fakeSsm(JSON.stringify({ roleArn: ROLE, region: 'eu-west-1' }));
    const probes = [];
    const provider = {
      listRepos: async () => [repo('open'), repo('untagged'), repo('deleted')],
      getRepositoryAccess: async (_ctx, repoId) => {
        probes.push(repoId);
        if (repoId.endsWith(':untagged')) throw new ProviderError(403, 'CodeCommit denied');
        if (repoId.endsWith(':deleted')) throw new ProviderError(404, 'CodeCommit gone');
        return { canRead: true, canWrite: true };
      },
    };
    const res = parse(await handler_repos({ stsClient: stsOk(), ssmClient: ssm, provider }));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.map((r) => r.name)).toEqual(['open']);
    // Every listed repo was probed with GetRepository.
    expect(probes).toHaveLength(3);
  });

  it('repos fails the request on a throttle instead of hiding the repo', async () => {
    const ssm = fakeSsm(JSON.stringify({ roleArn: ROLE, region: 'eu-west-1' }));
    const provider = {
      listRepos: async () => [repo('a'), repo('b')],
      getRepositoryAccess: async (_ctx, repoId) => {
        if (repoId.endsWith(':b')) throw new ProviderError(429, 'CodeCommit throttled');
        return { canRead: true };
      },
    };
    const res = parse(await handler_repos({ stsClient: stsOk(), ssmClient: ssm, provider }));
    expect(res.status).toBe(429);
  });

  it('repos keeps the GetRepository probe concurrency bounded', async () => {
    const ssm = fakeSsm(JSON.stringify({ roleArn: ROLE, region: 'eu-west-1' }));
    let inFlight = 0;
    let peak = 0;
    const provider = {
      listRepos: async () => Array.from({ length: 25 }, (_v, i) => repo(`svc-${i}`)),
      getRepositoryAccess: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight -= 1;
        return { canRead: true };
      },
    };
    const res = parse(await handler_repos({ stsClient: stsOk(), ssmClient: ssm, provider }));
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(25);
    expect(peak).toBeLessThanOrEqual(5);
    expect(peak).toBeGreaterThan(1);
  });

  it('repos is an empty array when no connection is configured', async () => {
    const sts = stsOk();
    const res = parse(
      await handler_repos({
        stsClient: sts,
        ssmClient: fakeSsm('{}'),
        provider: { listRepos: async () => [repo('x')], getRepositoryAccess: async () => ({}) },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    // Not configured: no role is assumed.
    expect(sts.calls).toHaveLength(0);
  });

  it('unknown routes are 404', async () => {
    const handler = createCodeCommitHandler({
      stsClient: stsOk(),
      ssmClient: fakeSsm(),
      provider: {},
    });
    expect(parse(await handler(event('GET', '/codecommit/whatever'))).status).toBe(404);
  });
});

// Small helper: GET /codecommit/repos as an authenticated non-admin user.
const handler_repos = (opts) =>
  createCodeCommitHandler(opts)({
    httpMethod: 'GET',
    path: '/api/codecommit/repos',
    queryStringParameters: null,
    body: null,
    headers: { origin: 'http://localhost:5173' },
    requestContext: { authorizer: { claims: { sub: 'user-1' } } },
  });
