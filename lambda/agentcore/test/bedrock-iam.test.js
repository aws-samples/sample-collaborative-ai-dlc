import { afterEach, describe, expect, it, vi } from 'vitest';
import { fromHttp } from '@aws-sdk/credential-providers';
import { BedrockClient, ListInferenceProfilesCommand } from '@aws-sdk/client-bedrock';
import { prepareBedrockIamEnv } from '../bedrock-iam.js';
import { getDriver } from '../cli/drivers.js';
import { buildMcpConfig, toCodexMcpToml } from '../stage-materializer.js';
import { restoreRuntimeAwsAuth } from '../runtime-aws-auth.js';
import { resolveInvocationAgentAuth } from '../auth-resolver.js';
import { verifyBedrockIam } from '../commands/verify-bedrock-iam.js';
import { createBusyTracker, dispatchInvocation, invocationBusyTracker } from '../http-server.js';
import { createRunStageStart } from '../commands/run-stage-start.js';

const config = { roleArn: 'arn:aws:iam::222222222222:role/Inference', region: 'eu-west-1' };
const binding = { provider: 'bedrock', source: 'space', authType: 'iam', iam: config };
const credentials = (time, key = 'TARGET1') => ({
  AccessKeyId: key,
  SecretAccessKey: 'inert-target-secret',
  Token: 'inert-target-token',
  Expiration: new Date(time + 3600_000).toISOString(),
});
const handles = [];
const prepare = async ({
  now = () => Date.now(),
  renew = async () => credentials(now(), 'TARGET2'),
} = {}) => {
  const handle = await prepareBedrockIamEnv(
    {
      binding,
      iamCredentials: credentials(now()),
      renewalToken: 'inert-renewal',
      renewalExpiresAt: now() + 8 * 3600_000,
    },
    { now, renew },
  );
  handles.push(handle);
  return handle;
};
const request = (env, token = env.BEDROCK_IAM_AUTHORIZATION_TOKEN) =>
  fetch(env.BEDROCK_IAM_CREDENTIALS_URI, {
    headers: { Authorization: token },
  });
afterEach(() => {
  for (const handle of handles.splice(0)) handle.dispose();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('IAM runtime credentials', () => {
  it('keeps Kiro authenticated without falling back to a Bedrock key when IAM is unavailable', async () => {
    const kiro = { provider: 'kiro', source: 'platform' };
    const result = await resolveInvocationAgentAuth({
      authMode: 'capabilities',
      payload: {
        projectId: 'p',
        agentCredentialGrant: 'grant',
        credentialBindings: { bedrock: binding, kiro },
      },
      env: { AWS_BEARER_TOKEN_BEDROCK: 'stale-key' },
      broker: async () => ({
        purpose: 'capabilities',
        projectId: 'p',
        executionId: null,
        credentials: [
          { binding, error: 'BEDROCK_IAM_ACCESS_DENIED' },
          { binding: kiro, value: 'inert-kiro' },
        ],
      }),
    });
    expect(result.resolvedProviders).toEqual(['kiro']);
    expect(result.missingProviders).toEqual(['bedrock']);
    expect(result.env.KIRO_API_KEY).toBe('inert-kiro');
    expect(result.env.AWS_BEARER_TOKEN_BEDROCK).toBeUndefined();
  });
  it('configures all three CLIs with renewable credentials, restoring the runtime identity only in the built-in MCP', async () => {
    const handle = await prepare();
    const env = {
      AWS_REGION: 'us-east-1',
      AWS_BEARER_TOKEN_BEDROCK: 'stale-key',
      AWS_CONTAINER_CREDENTIALS_FULL_URI: 'http://169.254.170.2/runtime',
      AWS_CONTAINER_AUTHORIZATION_TOKEN: 'inert-runtime-token',
      ...handle.env,
    };
    const mcp = buildMcpConfig({
      mcpEntry: '/app/mcp.js',
      scope: {},
      env,
      customServers: { custom: { command: 'example' } },
    });
    for (const cli of ['claude', 'opencode', 'codex']) {
      const auth = getDriver(cli).envForAuth(env);
      expect(auth.AWS_CONTAINER_CREDENTIALS_FULL_URI).toBe(handle.env.BEDROCK_IAM_CREDENTIALS_URI);
      expect(auth.AWS_REGION).toBe('eu-west-1');
      expect(auth.AWS_BEARER_TOKEN_BEDROCK).toBeUndefined();
      expect(auth.AWS_ACCESS_KEY_ID).toBeUndefined();
      const mcpEnv = { ...env, ...auth, ...mcp.mcpServers.aidlc.env };
      restoreRuntimeAwsAuth(mcpEnv);
      expect(mcpEnv.AWS_REGION).toBe('us-east-1');
      expect(mcpEnv.AWS_CONTAINER_CREDENTIALS_FULL_URI).toBe(
        env.AWS_CONTAINER_CREDENTIALS_FULL_URI,
      );
      expect(mcpEnv.AWS_CONTAINER_AUTHORIZATION_TOKEN).toBe('inert-runtime-token');
    }
    expect(mcp.mcpServers.custom.env.AWS_CONTAINER_AUTHORIZATION_TOKEN).toBe('');
    expect(mcp.mcpServers.custom.env.BEDROCK_IAM_AUTHORIZATION_TOKEN).toBe('');
    const toml = toCodexMcpToml(mcp.mcpServers, env);
    expect(toml).toContain('AIDLC_RUNTIME_AWS_ENV');
    expect(toml).not.toContain('inert-runtime-token');
    expect(toml).not.toContain(handle.env.BEDROCK_IAM_AUTHORIZATION_TOKEN);
  });

  it('rejects missing and cross-invocation endpoint tokens', async () => {
    const a = await prepare();
    const b = await prepare();
    expect((await request(a.env, '')).status).toBe(403);
    expect((await request(b.env, a.env.BEDROCK_IAM_AUTHORIZATION_TOKEN)).status).toBe(403);
    const own = await request(a.env);
    expect(own.status).toBe(200);
    const value = await own.json();
    expect(value.AccessKeyId).toBe('TARGET1');
    expect(value.renewalToken).toBeUndefined();
    expect(value.binding).toBeUndefined();
  });

  it('uses the real SDK HTTP provider to refresh the same Bedrock client after three hours', async () => {
    let currentTime = Date.now();
    const now = () => currentTime;
    const renew = vi.fn(async () => credentials(now(), 'TARGET2'));
    const handle = await prepare({ now, renew });
    vi.spyOn(Date, 'now').mockImplementation(now);
    const authorization = [];
    const client = new BedrockClient({
      region: config.region,
      credentials: fromHttp({
        awsContainerCredentialsFullUri: handle.env.BEDROCK_IAM_CREDENTIALS_URI,
        awsContainerAuthorizationToken: handle.env.BEDROCK_IAM_AUTHORIZATION_TOKEN,
        awsContainerCredentialsRelativeUri: '',
        awsContainerAuthorizationTokenFile: '',
      }),
      requestHandler: {
        handle: async (req) => {
          authorization.push(req.headers.authorization);
          return {
            response: {
              statusCode: 200,
              headers: { 'content-type': 'application/json' },
              body: Buffer.from('{"inferenceProfileSummaries":[]}'),
            },
          };
        },
      },
    });
    try {
      await client.send(new ListInferenceProfilesCommand({}));
      currentTime += 3 * 3600_000;
      await client.send(new ListInferenceProfilesCommand({}));
      expect(authorization[0]).toContain('Credential=TARGET1/');
      expect(authorization[1]).toContain('Credential=TARGET2/');
      expect(renew).toHaveBeenCalledTimes(1);
    } finally {
      client.destroy();
    }
  });

  it('coalesces renewal and fails closed when the broker cannot renew expired credentials', async () => {
    let time = Date.now();
    const now = () => time;
    const renew = vi.fn(async () => credentials(now(), 'TARGET2'));
    const handle = await prepare({ now, renew });
    time += 3 * 3600_000;
    const responses = await Promise.all(Array.from({ length: 5 }, () => request(handle.env)));
    expect(responses.every((r) => r.status === 200)).toBe(true);
    expect(renew).toHaveBeenCalledTimes(1);
    time += 2 * 3600_000;
    renew.mockRejectedValue(new Error('sensitive provider error'));
    const failed = await request(handle.env);
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain('sensitive');
    time += 4 * 3600_000;
    const expired = await request(handle.env);
    expect(expired.status).toBe(503);
  });

  it('gives resumed invocations fresh endpoints after hours or days without changing process.env', async () => {
    const before = { ...process.env };
    let time = Date.now();
    const broker = vi.fn(async () => ({
      purpose: 'execution',
      projectId: 'p',
      executionId: 'e',
      credentials: [
        {
          binding,
          iamCredentials: credentials(time),
          renewalToken: 'renew',
          renewalExpiresAt: time + 8 * 3600_000,
        },
      ],
    }));
    const store = {
      getExecution: async () => ({
        projectId: 'p',
        agentCli: 'claude',
        credentialBinding: binding,
      }),
    };
    const urls = [];
    for (const [grant, advance] of [
      ['initial', 0],
      ['after-three-hours', 3 * 3600_000],
      ['after-three-days', 3 * 24 * 3600_000],
    ]) {
      time += advance;
      const auth = await resolveInvocationAgentAuth({
        payload: { executionId: 'e', agentCredentialGrant: grant },
        store,
        broker,
        env: { AWS_REGION: 'us-east-1' },
        prepareIamEnv: (credential, options) =>
          prepareBedrockIamEnv(credential, { ...options, now: () => time }),
      });
      handles.push(auth);
      expect(auth.resolvedProviders).toEqual(['bedrock']);
      urls.push(auth.env.BEDROCK_IAM_CREDENTIALS_URI);
    }
    expect(new Set(urls).size).toBe(3);
    expect(broker.mock.calls.map(([r]) => r.grant)).toEqual([
      'initial',
      'after-three-hours',
      'after-three-days',
    ]);
    expect(process.env).toEqual(before);
  });

  it('does not accept a broker response for a different account or region', async () => {
    await expect(
      resolveInvocationAgentAuth({
        payload: { executionId: 'e', agentCredentialGrant: 'grant' },
        store: {
          getExecution: async () => ({
            projectId: 'p',
            agentCli: 'claude',
            credentialBinding: binding,
          }),
        },
        broker: async () => ({
          purpose: 'execution',
          projectId: 'p',
          executionId: 'e',
          credentials: [{ binding: { ...binding, iam: { ...config, region: 'us-east-1' } } }],
        }),
      }),
    ).rejects.toMatchObject({ code: 'credential_grant_mismatch' });
  });

  it('keeps credentials alive after a background accept and closes the endpoint when the job completes', async () => {
    const auth = await prepare();
    const busy = createBusyTracker();
    let finish;
    const stage = new Promise((resolve) => {
      finish = resolve;
    });
    let completed;
    const callback = new Promise((resolve) => {
      completed = resolve;
    });
    const result = await dispatchInvocation({
      payload: {
        command: 'run-stage-start',
        executionId: 'e',
        stageId: 's',
        stageCallbackId: 'cb',
      },
      prepareInvocation: async () => auth,
      busy,
      handlers: {
        runStageStart: (p, context) =>
          createRunStageStart({
            runStage: () => stage,
            sendCallbackHeartbeat: async () => ({ delivered: true }),
            sendCallbackSuccess: async () => {
              completed();
              return { delivered: true };
            },
            busy: invocationBusyTracker(busy, context),
            log: () => {},
          })(p),
      },
    });
    expect(result.body.accepted).toBe(true);
    expect((await request(auth.env)).status).toBe(200);
    finish({ ok: true });
    await callback;
    await new Promise((resolve) => setImmediate(resolve));
    await expect(request(auth.env)).rejects.toThrow();
    expect(busy.status).toBe('Healthy');
  });

  it('does not let the verification command obtain credentials from an arbitrary role payload', async () => {
    const listModels = vi.fn();
    expect(await verifyBedrockIam({ config }, { listModels })).toMatchObject({ verified: false });
    expect(listModels).not.toHaveBeenCalled();
  });
});
