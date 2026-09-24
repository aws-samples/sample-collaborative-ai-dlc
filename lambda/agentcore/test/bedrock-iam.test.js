import { afterEach, describe, expect, it, vi } from 'vitest';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { setImmediate as tick } from 'node:timers/promises';
import { prepareBedrockIamSession, listIamBedrockModels } from '../bedrock-iam.js';
import { getDriver } from '../cli/drivers.js';
import { childEnvironment } from '../cli/environment.js';
import { resolveInvocationAgentAuth } from '../auth-resolver.js';
import { captureChild } from '../cli/spawn.js';
import { resolveModelId } from '../model-resolver.js';
import { runCredentialJob } from '../credential-session.js';
import { normalizeConnection } from '../../shared/agent-auth-catalog.js';
import { connectionBinding } from '../../shared/agent-binding-selection.js';
const HOUR = 3600_000;
const config = {
  roleArn: 'arn:aws:iam::222222222222:role/Inference',
  region: 'eu-west-1',
  externalId: 'fixture-external',
};
const binding = connectionBinding(
  normalizeConnection({
    id: 'iam-space',
    revision: 1,
    source: 'space',
    projectId: 'p',
    mode: 'iam',
    backend: 'bedrock',
    mechanism: 'assume-role',
    configuration: config,
  }),
  1,
);
const credentials = (time, key = 'TARGET1') => ({
  AccessKeyId: key,
  SecretAccessKey: 'inert-target-secret',
  Token: 'inert-target-token',
  Expiration: new Date(time + HOUR).toISOString(),
});
const sessions = [];
const clock = () => {
  let time = Date.now();
  let sequence = 0;
  const timers = new Map();
  return {
    now: () => time,
    setTimer: (fn, ms) => {
      const id = ++sequence;
      timers.set(id, { fn, at: time + ms });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    advance: async (ms) => {
      const end = time + ms;
      for (;;) {
        const next = [...timers]
          .filter(([, timer]) => timer.at <= end)
          .toSorted((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        timers.delete(next[0]);
        time = next[1].at;
        next[1].fn();
        await tick();
      }
      time = end;
      await tick();
    },
  };
};
const prepare = async (options = {}) => {
  const now = options.now ?? Date.now;
  const session = await prepareBedrockIamSession(
    {
      binding,
      iamCredentials: credentials(now()),
      renewalToken: 'inert-renewal',
      renewalExpiresAt: now() + 8 * HOUR,
    },
    {
      env: { AWS_REGION: 'us-east-1' },
      renew: async () => credentials(now(), 'TARGET2'),
      ...options,
    },
  );
  sessions.push(session);
  return session;
};
const request = (env, token = env.AWS_CONTAINER_AUTHORIZATION_TOKEN) =>
  fetch(env.AWS_CONTAINER_CREDENTIALS_FULL_URI, { headers: { Authorization: token } });
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.release()));
  vi.restoreAllMocks();
});

describe('IAM invocation sessions', () => {
  it.each(['claude', 'opencode', 'codex'])(
    'gives %s only the inference endpoint and selected region',
    async (cli) => {
      const session = await prepare();
      const ambient = {
        PATH: process.env.PATH,
        AWS_ACCESS_KEY_ID: 'application',
        AWS_CONTAINER_CREDENTIALS_FULL_URI: 'http://169.254.170.2/app',
        AWS_CONTAINER_AUTHORIZATION_TOKEN: 'application-token',
      };
      const env = childEnvironment(
        getDriver(cli).envForAuth(session.env),
        ambient,
        session.credentialEnvironment,
      );
      expect(env.AWS_REGION).toBe(config.region);
      expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
      expect(env.AWS_BEARER_TOKEN_BEDROCK).toBeUndefined();
      expect(env.AWS_CONTAINER_CREDENTIALS_FULL_URI).toMatch(/^http:\/\/127\.0\.0\.1:/);
      expect(JSON.stringify(env)).not.toContain('application');
      expect(resolveModelId('sonnet', { env: session.env })).toMatch(/^eu\./);
    },
  );
  it('authenticates endpoints per invocation and never returns renewal authority', async () => {
    const a = await prepare(),
      b = await prepare();
    expect((await request(a.credentialEnvironment, '')).status).toBe(403);
    expect(
      (
        await request(
          b.credentialEnvironment,
          a.credentialEnvironment.AWS_CONTAINER_AUTHORIZATION_TOKEN,
        )
      ).status,
    ).toBe(403);
    const result = await request(a.credentialEnvironment);
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect(await result.json()).toEqual(
      credentials(
        Date.parse((await request(a.credentialEnvironment).then((r) => r.json())).Expiration) -
          HOUR,
      ),
    );
  });
  it('refreshes the real SDK HTTP provider in the same child across more than three simulated hours', async () => {
    const time = clock();
    let generation = 0;
    const renew = vi.fn(async () => credentials(time.now(), `TARGET${++generation + 1}`));
    const session = await prepare({ ...time, renew });
    const child = fork(new URL('./fixtures/iam-sdk-child.js', import.meta.url), [], {
      env: childEnvironment(
        { AWS_REGION: config.region },
        process.env,
        session.credentialEnvironment,
      ),
      silent: true,
    });
    const send = async () => {
      const response = once(child, 'message');
      child.send({ time: time.now() });
      return (await response)[0];
    };
    try {
      const first = await send();
      expect(first.authorization).toContain('Credential=TARGET1/');
      for (let round = 0; round < 4; round++) {
        await time.advance(55 * 60_000 + 1);
        const next = await send();
        expect(next.error).toBeUndefined();
        expect(next.pid).toBe(first.pid);
        expect(next.authorization).toContain(`Credential=TARGET${round + 2}/`);
        expect(next.region).toBe(config.region);
      }
      expect(renew).toHaveBeenCalledTimes(4);
      expect(session.signal.aborted).toBe(false);
    } finally {
      child.disconnect();
      await once(child, 'exit');
    }
  });
  it('coalesces simultaneous refresh and retains usable credentials through transient errors', async () => {
    const time = clock();
    let complete;
    const renew = vi.fn(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const session = await prepare({ ...time, renew });
    await time.advance(55 * 60_000);
    const pending = Array.from({ length: 5 }, () => session.renew());
    expect(renew).toHaveBeenCalledOnce();
    complete(credentials(time.now(), 'TARGET2'));
    await Promise.all(pending);
    renew.mockRejectedValue(new Error('temporary unavailable'));
    await time.advance(55 * 60_000);
    expect(session.signal.aborted).toBe(false);
    const env = session.credentialEnvironment;
    expect((await request(env)).status).toBe(200);
    renew.mockResolvedValue(credentials(time.now(), 'TARGET3'));
    await time.advance(30_000);
    expect(session.signal.aborted).toBe(false);
    expect((await request(env).then((r) => r.json())).AccessKeyId).toBe('TARGET3');
  });
  it('stops a running child at STS expiry even when renewal never returns', async () => {
    const time = clock();
    const session = await prepare({ ...time, renew: () => new Promise(() => {}) });
    const env = session.credentialEnvironment;
    const childResult = session.run(() =>
      captureChild({
        command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'],
        env: {},
      }),
    );
    await time.advance(HOUR);
    expect(session.signal.reason.code).toBe('bedrock_credentials_expired');
    expect((await childResult).credentialError).toBeTruthy();
    expect((await request(env)).status).toBe(503);
  });
  it('stops at the original eight-hour authorization ceiling despite successful renewals', async () => {
    const time = clock();
    const session = await prepare(time);
    await time.advance(8 * HOUR);
    expect(session.signal.reason.code).toBe('bedrock_authorization_expired');
    expect(() => session.credentialEnvironment).toThrow();
  });
  it('cancels immediately on revoked authorization instead of retrying it', async () => {
    const time = clock();
    const renew = vi.fn(async () => {
      throw Object.assign(new Error('revoked'), { code: 'AGENT_AUTH_CONNECTION_UNAVAILABLE' });
    });
    const session = await prepare({ ...time, renew });
    await time.advance(55 * 60_000);
    expect(session.signal.aborted).toBe(true);
    expect(renew).toHaveBeenCalledOnce();
  });
  it('retains detached jobs and closes its endpoint after the last owner finishes', async () => {
    const session = await prepare();
    const env = session.credentialEnvironment;
    let finish;
    const pending = new Promise((resolve) => {
      finish = resolve;
    });
    const job = session.run(() => runCredentialJob(() => pending));
    await session.release();
    expect(session.disposed).toBe(false);
    expect((await request(env)).status).toBe(200);
    finish();
    await job;
    expect(session.disposed).toBe(true);
    await expect(request(env)).rejects.toThrow();
  });
  it('keeps Kiro usable when IAM fails and never falls back to a stale key', async () => {
    const kiro = { provider: 'kiro', source: 'platform' };
    const result = await resolveInvocationAgentAuth({
      authMode: 'capabilities',
      payload: {
        projectId: 'p',
        agentCredentialGrant: 'grant',
        credentialBindings: { bedrock: binding, kiro },
      },
      env: { AWS_BEARER_TOKEN_BEDROCK: 'stale', BEDROCK_AUTH_MODE: 'iam' },
      broker: async () => ({
        purpose: 'capabilities',
        projectId: 'p',
        executionId: null,
        credentials: [
          { binding, error: 'BEDROCK_IAM_ACCESS_DENIED' },
          { binding: kiro, value: 'kiro-key' },
        ],
      }),
    });
    expect(result.resolvedProviders).toEqual(['kiro']);
    expect(result.missingProviders).toEqual(['bedrock']);
    expect(result.env.AWS_BEARER_TOKEN_BEDROCK).toBeUndefined();
    expect(result.env.BEDROCK_AUTH_MODE).toBeUndefined();
  });
  it('paginates model discovery with the session credentials and inference region', async () => {
    const session = await prepare();
    let options;
    const client = {
      send: vi
        .fn()
        .mockResolvedValueOnce({ inferenceProfileSummaries: [], nextToken: 'next' })
        .mockResolvedValueOnce({ inferenceProfileSummaries: [] }),
      destroy: vi.fn(),
    };
    await session.run(() =>
      listIamBedrockModels(session.env, {
        createClient: (clientConfig) => {
          options = clientConfig;
          return client;
        },
      }),
    );
    expect(options.region).toBe(config.region);
    expect((await options.credentials()).accessKeyId).toBe('TARGET1');
    expect(client.send).toHaveBeenCalledTimes(2);
    expect(client.send.mock.calls[1][0].input.nextToken).toBe('next');
    expect(client.destroy).toHaveBeenCalledOnce();
  });
});

it('stops the owned process group and rejects a subsequent spawn after expiry', async () => {
  const time = clock();
  const session = await prepare({ ...time, renew: () => new Promise(() => {}) });
  const { EventEmitter } = await import('node:events');
  const child = new EventEmitter();
  child.pid = 123456;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const killProcessGroup = vi.fn();
  const spawnFn = vi.fn(() => child);
  const result = session.run(() =>
    captureChild({ command: 'fixture', args: [], env: {}, spawnFn, killProcessGroup }),
  );
  expect(spawnFn.mock.calls[0][2].detached).toBe(true);
  await time.advance(HOUR);
  expect(killProcessGroup).toHaveBeenCalledWith(-123456, 'SIGKILL');
  expect((await result).credentialError).toBe('bedrock_credentials_expired');
  expect(() =>
    session.run(() => captureChild({ command: 'fixture', args: [], env: {}, spawnFn })),
  ).toThrow();
  expect(spawnFn).toHaveBeenCalledOnce();
});

it.each(['execution', 'compose', 'discussion', 'capabilities', 'verify-bedrock-iam'])(
  'prepares IAM through the common resolver for %s',
  async (purpose) => {
    const execution = !['capabilities', 'verify-bedrock-iam'].includes(purpose);
    const now = Date.now();
    const auth = await resolveInvocationAgentAuth({
      authMode: purpose,
      payload: {
        projectId: 'p',
        ...(execution ? { executionId: 'e' } : {}),
        requestedCli: 'claude',
        credentialBinding: binding,
        credentialBindings: { bedrock: binding },
        agentCredentialGrant: 'signed-grant',
      },
      store: {
        getExecution: async () => ({
          projectId: 'p',
          agentCli: 'claude',
          credentialBinding: binding,
        }),
      },
      env: { AWS_REGION: 'us-east-1', AWS_BEARER_TOKEN_BEDROCK: 'stale-key' },
      broker: async () => ({
        purpose,
        projectId: 'p',
        executionId: execution ? 'e' : null,
        credentials: [
          {
            binding,
            iamCredentials: credentials(now),
            renewalToken: 'renewal',
            renewalExpiresAt: now + 8 * HOUR,
          },
        ],
      }),
    });
    sessions.push(auth.credentialSession);
    expect(auth.resolvedProviders).toEqual(['bedrock']);
    expect(auth.env.BEDROCK_REGION).toBe(config.region);
    expect(auth.env.AWS_BEARER_TOKEN_BEDROCK).toBeUndefined();
    expect((await request(auth.credentialSession.credentialEnvironment)).status).toBe(200);
  },
);
it('uses fresh endpoints when a pinned conversation resumes hours or days later', async () => {
  let time = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => time);
  const originalEnv = { ...process.env };
  const endpoints = [];
  for (const advance of [0, 3 * HOUR, 3 * 24 * HOUR]) {
    time += advance;
    const auth = await resolveInvocationAgentAuth({
      payload: { executionId: 'e', agentCredentialGrant: 'fresh-grant' },
      store: {
        getExecution: async () => ({
          projectId: 'p',
          agentCli: 'claude',
          credentialBinding: binding,
        }),
      },
      env: {},
      broker: async () => ({
        purpose: 'execution',
        projectId: 'p',
        executionId: 'e',
        credentials: [
          {
            binding,
            iamCredentials: credentials(time),
            renewalToken: 'fresh-renewal',
            renewalExpiresAt: time + 8 * HOUR,
          },
        ],
      }),
    });
    endpoints.push(auth.credentialSession.credentialEnvironment.AWS_CONTAINER_CREDENTIALS_FULL_URI);
    expect(auth.bindings).toEqual([binding]);
    await auth.credentialSession.release();
  }
  expect(new Set(endpoints).size).toBe(3);
  expect(process.env).toEqual(originalEnv);
});
it('rejects a renewal response for a different role or region and cancels the session', async () => {
  const now = Date.now();
  let calls = 0;
  const auth = await resolveInvocationAgentAuth({
    payload: { executionId: 'e', agentCredentialGrant: 'grant' },
    store: {
      getExecution: async () => ({
        projectId: 'p',
        agentCli: 'claude',
        credentialBinding: binding,
      }),
    },
    env: {},
    broker: async () => ({
      purpose: 'execution',
      projectId: 'p',
      executionId: 'e',
      credentials: [
        {
          binding: calls++
            ? { ...binding, configuration: { ...config, region: 'eu-north-1' } }
            : binding,
          iamCredentials: credentials(now),
          renewalToken: 'renewal',
          renewalExpiresAt: now + 8 * HOUR,
        },
      ],
    }),
  });
  sessions.push(auth.credentialSession);
  await expect(auth.credentialSession.renew()).rejects.toMatchObject({
    code: 'credential_grant_mismatch',
  });
  expect(auth.credentialSession.signal.aborted).toBe(true);
});
