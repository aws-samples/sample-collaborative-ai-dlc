import { describe, it, expect, vi } from 'vitest';
import { authenticatedClisForEnv, resolveInvocationAgentAuth } from '../auth-resolver.js';
import { AGENT_AUTH_MODES } from '../command-registry.js';

describe('resolveInvocationAgentAuth', () => {
  it('strongly reads the credential pin before verifying a grant', async () => {
    const pinnedBinding = { provider: 'kiro', source: 'user', userId: 'starter' };
    const getExecution = vi.fn(async (_executionId, options) =>
      options?.consistentRead
        ? {
            projectId: 'p-1',
            status: 'RUNNING',
            agentCli: 'kiro',
            credentialBinding: pinnedBinding,
          }
        : {
            projectId: 'p-1',
            status: 'DRAFT',
            agentCli: 'kiro',
            credentialBinding: null,
          },
    );

    const result = await resolveInvocationAgentAuth({
      payload: {
        command: 'run-stage',
        executionId: 'e1',
        requestedCli: 'kiro',
        agentCredentialGrant: 'grant-starter',
      },
      store: { getExecution },
      env: { AGENT_SETTINGS_SSM_PREFIX: '/app/dev' },
      broker: async () => ({
        purpose: 'execution',
        projectId: 'p-1',
        executionId: 'e1',
        credentials: [{ binding: pinnedBinding, value: 'starter-key' }],
      }),
    });

    expect(getExecution).toHaveBeenCalledWith('e1', { consistentRead: true });
    expect(result.env.KIRO_API_KEY).toBe('starter-key');
  });

  it('keeps concurrent users in separate invocation environments', async () => {
    const broker = async ({ grant }) => {
      const userId = grant === 'grant-u-1' ? 'u-1' : 'u-2';
      return {
        purpose: 'execution',
        projectId: 'p-1',
        executionId: grant === 'grant-u-1' ? 'e1' : 'e2',
        credentials: [
          {
            binding: { provider: 'kiro', source: 'user', userId },
            value: `kiro-user-${userId.slice(-1)}`,
          },
        ],
      };
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
        payload: {
          command: 'run-stage',
          executionId: 'e1',
          requestedCli: 'kiro',
          agentCredentialGrant: 'grant-u-1',
        },
        store,
        env: baseEnv,
        broker,
      }),
      resolveInvocationAgentAuth({
        payload: {
          command: 'run-stage',
          executionId: 'e2',
          requestedCli: 'kiro',
          agentCredentialGrant: 'grant-u-2',
        },
        store,
        env: baseEnv,
        broker,
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
    const result = await resolveInvocationAgentAuth({
      payload: {
        command: 'run-stage',
        executionId: 'e1',
        requestedCli: 'kiro',
        agentCredentialGrant: 'grant-user',
      },
      store: {
        getExecution: async () => ({
          projectId: 'p-1',
          agentCli: 'kiro',
          credentialBinding: { provider: 'kiro', source: 'user', userId: 'u-1' },
        }),
      },
      env: { AGENT_SETTINGS_SSM_PREFIX: '/app/dev' },
      broker: async () => ({
        purpose: 'execution',
        projectId: 'p-1',
        executionId: 'e1',
        credentials: [
          {
            binding: { provider: 'kiro', source: 'user', userId: 'u-1' },
            value: null,
          },
        ],
      }),
    });
    expect(result.env.KIRO_API_KEY).toBeUndefined();
    expect(result.missingProviders).toEqual(['kiro']);
    expect(result.credentialBindings).toEqual([{ provider: 'kiro', source: 'user' }]);
    expect(result.missingCredentialBindings).toEqual([{ provider: 'kiro', source: 'user' }]);
  });

  it('resolves every supplied binding for a capabilities probe', async () => {
    const values = new Map([
      ['/app/dev/bedrock-bearer-token', 'bedrock-platform-key'],
      ['/app/dev/kiro-api-key', 'kiro-platform-key'],
    ]);
    const result = await resolveInvocationAgentAuth({
      authMode: AGENT_AUTH_MODES.CAPABILITIES,
      payload: {
        command: 'capabilities',
        credentialBindings: {
          bedrock: { provider: 'bedrock', source: 'platform' },
          kiro: { provider: 'kiro', source: 'platform' },
        },
        agentCredentialGrant: 'grant-platform',
      },
      env: { AGENT_SETTINGS_SSM_PREFIX: '/app/dev' },
      broker: async () => ({
        purpose: 'capabilities',
        projectId: null,
        executionId: null,
        credentials: [
          {
            binding: { provider: 'bedrock', source: 'platform' },
            value: values.get('/app/dev/bedrock-bearer-token'),
          },
          {
            binding: { provider: 'kiro', source: 'platform' },
            value: values.get('/app/dev/kiro-api-key'),
          },
        ],
      }),
    });

    expect(result.env).toMatchObject({
      AWS_BEARER_TOKEN_BEDROCK: 'bedrock-platform-key',
      KIRO_API_KEY: 'kiro-platform-key',
    });
    expect(result.resolvedProviders).toEqual(['bedrock', 'kiro']);
  });

  it('never falls back to a platform key when pre-start compose has no binding', async () => {
    const broker = async () => {
      throw new Error('broker should not be called');
    };
    const result = await resolveInvocationAgentAuth({
      authMode: AGENT_AUTH_MODES.COMPOSE,
      payload: {
        command: 'compose-plan-start',
        projectId: 'p-1',
        executionId: 'e1',
        requestedCli: 'kiro',
      },
      store: { getExecution: async () => ({ projectId: 'p-1', status: 'DRAFT' }) },
      env: { AGENT_SETTINGS_SSM_PREFIX: '/app/dev' },
      broker,
    });
    expect(result.env.KIRO_API_KEY).toBeUndefined();
  });

  it('uses the legacy platform credential for an in-flight compose without a binding', async () => {
    const result = await resolveInvocationAgentAuth({
      authMode: AGENT_AUTH_MODES.COMPOSE,
      payload: {
        command: 'compose-plan-start',
        projectId: 'p-1',
        executionId: 'e1',
        mode: 'inflight',
        requestedCli: 'kiro',
        agentCredentialGrant: 'grant-platform',
      },
      store: {
        getExecution: async () => ({
          projectId: 'p-1',
          status: 'WAITING',
          agentCli: 'kiro',
        }),
      },
      env: { AGENT_SETTINGS_SSM_PREFIX: '/app/dev' },
      broker: async () => ({
        purpose: 'compose',
        projectId: 'p-1',
        executionId: 'e1',
        credentials: [
          {
            binding: { provider: 'kiro', source: 'platform' },
            value: 'platform-key',
          },
        ],
      }),
    });

    expect(result.env.KIRO_API_KEY).toBe('platform-key');
    expect(result.credentialBindings).toEqual([{ provider: 'kiro', source: 'platform' }]);
  });

  it('resolves the caller binding for a DRAFT discussion assist', async () => {
    const result = await resolveInvocationAgentAuth({
      authMode: AGENT_AUTH_MODES.DISCUSSION,
      payload: {
        command: 'discussion-assist-start',
        projectId: 'p-1',
        intentId: 'e1',
        requestedCli: 'kiro',
        credentialBinding: { provider: 'kiro', source: 'user', userId: 'u-1' },
        agentCredentialGrant: 'grant-user',
      },
      store: {
        getExecution: async () => ({
          projectId: 'p-1',
          status: 'DRAFT',
          agentCli: null,
          credentialBinding: null,
        }),
      },
      env: { AGENT_SETTINGS_SSM_PREFIX: '/app/dev' },
      broker: async () => ({
        purpose: 'discussion',
        projectId: 'p-1',
        executionId: 'e1',
        credentials: [
          {
            binding: { provider: 'kiro', source: 'user', userId: 'u-1' },
            value: 'draft-user-key',
          },
        ],
      }),
    });

    expect(result.env.KIRO_API_KEY).toBe('draft-user-key');
    expect(authenticatedClisForEnv({ installed: ['kiro', 'claude'], env: result.env })).toEqual([
      'kiro',
    ]);
    expect(result.credentialBindings).toEqual([{ provider: 'kiro', source: 'user' }]);
  });

  it('keeps a started discussion assist on the intent pinned binding', async () => {
    const result = await resolveInvocationAgentAuth({
      authMode: AGENT_AUTH_MODES.DISCUSSION,
      payload: {
        command: 'discussion-assist-start',
        projectId: 'p-1',
        intentId: 'e1',
        requestedCli: 'kiro',
        credentialBinding: {
          provider: 'kiro',
          source: 'user',
          userId: 'collaborator',
        },
        agentCredentialGrant: 'grant-starter',
      },
      store: {
        getExecution: async () => ({
          projectId: 'p-1',
          status: 'RUNNING',
          agentCli: 'kiro',
          credentialBinding: { provider: 'kiro', source: 'user', userId: 'starter' },
        }),
      },
      env: { AGENT_SETTINGS_SSM_PREFIX: '/app/dev' },
      broker: async () => ({
        purpose: 'discussion',
        projectId: 'p-1',
        executionId: 'e1',
        credentials: [
          {
            binding: { provider: 'kiro', source: 'user', userId: 'starter' },
            value: 'starter-key',
          },
        ],
      }),
    });

    expect(result.env.KIRO_API_KEY).toBe('starter-key');
  });

  it('rejects a compose binding for a different provider than the selected CLI', async () => {
    await expect(
      resolveInvocationAgentAuth({
        authMode: AGENT_AUTH_MODES.COMPOSE,
        payload: {
          command: 'compose-plan-start',
          requestedCli: 'kiro',
          credentialBinding: { provider: 'bedrock', source: 'platform' },
        },
        env: { AGENT_SETTINGS_SSM_PREFIX: '/app/dev' },
        broker: async () => ({ purpose: 'compose', credentials: [] }),
      }),
    ).rejects.toMatchObject({ code: 'credential_binding_mismatch' });
  });

  it('requires a signed grant when an invocation needs a credential', async () => {
    await expect(
      resolveInvocationAgentAuth({
        payload: { command: 'run-stage', executionId: 'e1', requestedCli: 'kiro' },
        store: {
          getExecution: async () => ({
            projectId: 'p-1',
            agentCli: 'kiro',
            credentialBinding: { provider: 'kiro', source: 'space' },
          }),
        },
        broker: async () => ({ purpose: 'execution', credentials: [] }),
      }),
    ).rejects.toMatchObject({ code: 'credential_grant_required' });
  });

  it('rejects a grant for a different binding', async () => {
    await expect(
      resolveInvocationAgentAuth({
        payload: {
          command: 'run-stage',
          executionId: 'e1',
          requestedCli: 'kiro',
          agentCredentialGrant: 'grant-other-user',
        },
        store: {
          getExecution: async () => ({
            projectId: 'p-1',
            agentCli: 'kiro',
            credentialBinding: { provider: 'kiro', source: 'user', userId: 'u-1' },
          }),
        },
        broker: async () => ({
          purpose: 'execution',
          projectId: 'p-1',
          executionId: 'e1',
          credentials: [
            {
              binding: { provider: 'kiro', source: 'user', userId: 'u-2' },
              value: 'wrong-user-key',
            },
          ],
        }),
      }),
    ).rejects.toMatchObject({ code: 'credential_grant_mismatch' });
  });

  it('rejects a grant for another project even when the space binding shape matches', async () => {
    await expect(
      resolveInvocationAgentAuth({
        payload: {
          command: 'run-stage',
          executionId: 'e1',
          requestedCli: 'kiro',
          agentCredentialGrant: 'grant-project-2',
        },
        store: {
          getExecution: async () => ({
            projectId: 'p-1',
            agentCli: 'kiro',
            credentialBinding: { provider: 'kiro', source: 'space' },
          }),
        },
        broker: async () => ({
          purpose: 'execution',
          projectId: 'p-2',
          executionId: 'e1',
          credentials: [
            {
              binding: { provider: 'kiro', source: 'space' },
              value: 'other-project-key',
            },
          ],
        }),
      }),
    ).rejects.toMatchObject({ code: 'credential_grant_mismatch' });
  });

  it('rejects duplicate credentials returned for one granted binding', async () => {
    await expect(
      resolveInvocationAgentAuth({
        payload: {
          command: 'run-stage',
          executionId: 'e1',
          requestedCli: 'kiro',
          agentCredentialGrant: 'grant-duplicate',
        },
        store: {
          getExecution: async () => ({
            projectId: 'p-1',
            agentCli: 'kiro',
            credentialBinding: { provider: 'kiro', source: 'user', userId: 'u-1' },
          }),
        },
        broker: async () => ({
          purpose: 'execution',
          projectId: 'p-1',
          executionId: 'e1',
          credentials: [
            {
              binding: { provider: 'kiro', source: 'user', userId: 'u-1' },
              value: 'first',
            },
            {
              binding: { provider: 'kiro', source: 'user', userId: 'u-1' },
              value: 'second',
            },
          ],
        }),
      }),
    ).rejects.toMatchObject({ code: 'credential_grant_mismatch' });
  });
});
