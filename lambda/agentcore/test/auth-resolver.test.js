import { describe, it, expect } from 'vitest';
import {
  authenticatedClisForEnv,
  resolveAgentAuth,
  resolveInvocationAgentAuth,
} from '../auth-resolver.js';

describe('resolveAgentAuth', () => {
  it('loads the bearer token + kiro key from their SSM paths into env', async () => {
    const env = {
      BEDROCK_BEARER_TOKEN_SSM_PATH: '/p/bedrock',
      KIRO_API_KEY_SSM_PATH: '/p/kiro',
      AWS_REGION: 'us-east-1',
    };
    const store = { '/p/bedrock': 'bearer-xyz', '/p/kiro': 'kiro-abc' };
    const resolved = await resolveAgentAuth({ env, getParam: async (n) => store[n] ?? '' });
    expect(env.AWS_BEARER_TOKEN_BEDROCK).toBe('bearer-xyz');
    expect(env.KIRO_API_KEY).toBe('kiro-abc');
    expect(resolved.toSorted()).toEqual(['AWS_BEARER_TOKEN_BEDROCK', 'KIRO_API_KEY']);
  });

  it('never overwrites an already-set env var', async () => {
    const env = {
      AWS_BEARER_TOKEN_BEDROCK: 'preset',
      BEDROCK_BEARER_TOKEN_SSM_PATH: '/p/bedrock',
    };
    const resolved = await resolveAgentAuth({ env, getParam: async () => 'from-ssm' });
    expect(env.AWS_BEARER_TOKEN_BEDROCK).toBe('preset');
    expect(resolved).not.toContain('AWS_BEARER_TOKEN_BEDROCK');
  });

  it('skips a target whose SSM path is not configured', async () => {
    const env = { KIRO_API_KEY_SSM_PATH: '/p/kiro' }; // no bedrock path
    const resolved = await resolveAgentAuth({ env, getParam: async () => 'k' });
    expect(env.AWS_BEARER_TOKEN_BEDROCK).toBeUndefined();
    expect(resolved).toEqual(['KIRO_API_KEY']);
  });

  it('skips a path that resolves empty (SSM miss/error) without throwing', async () => {
    const env = { BEDROCK_BEARER_TOKEN_SSM_PATH: '/p/missing' };
    const resolved = await resolveAgentAuth({ env, getParam: async () => '' });
    expect(env.AWS_BEARER_TOKEN_BEDROCK).toBeUndefined();
    expect(resolved).toEqual([]);
  });
});

describe('resolveInvocationAgentAuth', () => {
  it('keeps concurrent users in separate invocation environments', async () => {
    const values = new Map([
      ['/app/dev/users/u-1/agent-credentials/kiro-api-key', 'kiro-user-1'],
      ['/app/dev/users/u-2/agent-credentials/kiro-api-key', 'kiro-user-2'],
    ]);
    const ssm = {
      send: async ({ input }) => {
        const value = values.get(input.Name);
        return value ? { Parameter: { Name: input.Name, Value: value } } : {};
      },
    };
    const metas = {
      e1: {
        projectId: 'p-1',
        agentCli: 'kiro',
        credentialBinding: { provider: 'kiro', source: 'user', userId: 'u-1' },
      },
      e2: {
        projectId: 'p-1',
        agentCli: 'kiro',
        credentialBinding: { provider: 'kiro', source: 'user', userId: 'u-2' },
      },
    };
    const store = { getExecution: async (id) => metas[id] };
    const baseEnv = {
      AGENT_SETTINGS_SSM_PREFIX: '/app/dev',
      KIRO_API_KEY: 'must-not-leak',
      AWS_BEARER_TOKEN_BEDROCK: 'must-not-leak',
    };

    const [one, two] = await Promise.all([
      resolveInvocationAgentAuth({
        payload: { command: 'run-stage', executionId: 'e1', requestedCli: 'kiro' },
        store,
        env: baseEnv,
        ssm,
      }),
      resolveInvocationAgentAuth({
        payload: { command: 'run-stage', executionId: 'e2', requestedCli: 'kiro' },
        store,
        env: baseEnv,
        ssm,
      }),
    ]);

    expect(one.env.KIRO_API_KEY).toBe('kiro-user-1');
    expect(two.env.KIRO_API_KEY).toBe('kiro-user-2');
    expect(one.env.AWS_BEARER_TOKEN_BEDROCK).toBeUndefined();
    expect(two.env.AWS_BEARER_TOKEN_BEDROCK).toBeUndefined();
    expect(baseEnv.KIRO_API_KEY).toBe('must-not-leak');
    expect(authenticatedClisForEnv({ installed: ['kiro', 'claude'], env: one.env })).toEqual([
      'kiro',
    ]);
  });

  it('does not fall back when a pinned credential was cleared', async () => {
    const ssm = {
      send: async ({ input }) =>
        input.Name === '/app/dev/kiro-api-key'
          ? { Parameter: { Name: input.Name, Value: 'platform-key' } }
          : {},
    };
    const result = await resolveInvocationAgentAuth({
      payload: { command: 'run-stage', executionId: 'e1', requestedCli: 'kiro' },
      store: {
        getExecution: async () => ({
          projectId: 'p-1',
          agentCli: 'kiro',
          credentialBinding: { provider: 'kiro', source: 'user', userId: 'u-1' },
        }),
      },
      env: { AGENT_SETTINGS_SSM_PREFIX: '/app/dev' },
      ssm,
    });
    expect(result.env.KIRO_API_KEY).toBeUndefined();
    expect(result.missingProviders).toEqual(['kiro']);
    expect(result.credentialBindings).toEqual([{ provider: 'kiro', source: 'user' }]);
    expect(result.missingCredentialBindings).toEqual([{ provider: 'kiro', source: 'user' }]);
  });

  it('never falls back to a platform key when pre-start compose has no binding', async () => {
    const reads = [];
    const result = await resolveInvocationAgentAuth({
      payload: {
        command: 'compose-plan-start',
        projectId: 'p-1',
        executionId: 'e1',
        requestedCli: 'kiro',
      },
      store: { getExecution: async () => ({ projectId: 'p-1', status: 'DRAFT' }) },
      env: { AGENT_SETTINGS_SSM_PREFIX: '/app/dev' },
      ssm: {
        send: async ({ input }) => {
          reads.push(input.Name);
          return { Parameter: { Name: input.Name, Value: 'platform-key' } };
        },
      },
    });
    expect(reads).toEqual([]);
    expect(result.env.KIRO_API_KEY).toBeUndefined();
  });

  it('rejects a compose binding for a different provider than the selected CLI', async () => {
    await expect(
      resolveInvocationAgentAuth({
        payload: {
          command: 'compose-plan-start',
          requestedCli: 'kiro',
          credentialBinding: { provider: 'bedrock', source: 'platform' },
        },
        env: { AGENT_SETTINGS_SSM_PREFIX: '/app/dev' },
        ssm: { send: async () => ({}) },
      }),
    ).rejects.toMatchObject({ code: 'credential_binding_mismatch' });
  });
});
