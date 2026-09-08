import { describe, it, expect, vi } from 'vitest';
import { authenticatedClisForProviders, resolveInvocationAgentAuth } from '../auth-resolver.js';
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
        credentials: [{ binding: pinnedBinding, kind: 'bearer', value: 'starter-key' }],
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
            kind: 'bearer',
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
    expect(
      authenticatedClisForProviders({
        installed: ['kiro', 'claude'],
        resolvedProviders: one.resolvedProviders,
      }),
    ).toEqual(['kiro']);
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
            kind: 'bearer',
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
            kind: 'bearer',
            value: values.get('/app/dev/bedrock-bearer-token'),
          },
          {
            binding: { provider: 'kiro', source: 'platform' },
            kind: 'bearer',
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
            kind: 'bearer',
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
            kind: 'bearer',
            value: 'draft-user-key',
          },
        ],
      }),
    });

    expect(result.env.KIRO_API_KEY).toBe('draft-user-key');
    expect(
      authenticatedClisForProviders({
        installed: ['kiro', 'claude'],
        resolvedProviders: result.resolvedProviders,
      }),
    ).toEqual(['kiro']);
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
            kind: 'bearer',
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
              kind: 'bearer',
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
              kind: 'bearer',
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
              kind: 'bearer',
              value: 'first',
            },
            {
              binding: { provider: 'kiro', source: 'user', userId: 'u-1' },
              kind: 'bearer',
              value: 'second',
            },
          ],
        }),
      }),
    ).rejects.toMatchObject({ code: 'credential_grant_mismatch' });
  });
});

// specs/bedrock-iam-role-credential-mode — req-credential-delivery-env,
// req-broker-credential-resolution, req-execution-role-no-bedrock.
describe('resolveInvocationAgentAuth on the Bedrock role path', () => {
  const bedrockBinding = { provider: 'bedrock', source: 'platform' };
  const stsCredentials = {
    AccessKeyId: 'ASIAEXAMPLEEXAMPLE',
    SecretAccessKey: 'secret-access-key',
    SessionToken: 'session-token',
    Expiration: '2026-09-06T09:53:40.000Z',
  };
  const execution = {
    getExecution: async () => ({
      projectId: 'p-1',
      agentCli: 'claude',
      credentialBinding: bedrockBinding,
    }),
  };
  const rolePayload = {
    command: 'run-stage',
    executionId: 'e1',
    requestedCli: 'claude',
    agentCredentialGrant: 'grant-role',
  };
  const roleBroker = (entry) => async () => ({
    purpose: 'execution',
    projectId: 'p-1',
    executionId: 'e1',
    credentials: [{ binding: bedrockBinding, ...entry }],
  });

  it('sets the three AWS variables and no bearer token, only in the invocation clone', async () => {
    const baseEnv = {
      AGENT_SETTINGS_SSM_PREFIX: '/app/dev',
      // Left over from an earlier invocation: cleanBaseEnv must scrub all of it.
      AWS_BEARER_TOKEN_BEDROCK: 'must-not-leak',
      AWS_ACCESS_KEY_ID: 'stale-key',
      AWS_SECRET_ACCESS_KEY: 'stale-secret',
      AWS_SESSION_TOKEN: 'stale-session',
    };
    const result = await resolveInvocationAgentAuth({
      payload: rolePayload,
      store: execution,
      env: baseEnv,
      broker: roleBroker({ kind: 'role', credentials: stsCredentials }),
    });

    expect(result.env.AWS_ACCESS_KEY_ID).toBe('ASIAEXAMPLEEXAMPLE');
    expect(result.env.AWS_SECRET_ACCESS_KEY).toBe('secret-access-key');
    expect(result.env.AWS_SESSION_TOKEN).toBe('session-token');
    // req-expiry-tripwire: the deadline is carried out of the resolver so a stage
    // failure can be attributed to expiry by arithmetic rather than by matching a
    // CLI's stderr wording.
    expect(result.credentialExpiresAt).toBe('2026-09-06T09:53:40.000Z');
    // req-credential-safety: the bearer variable is never set on the role path.
    expect(result.env.AWS_BEARER_TOKEN_BEDROCK).toBeUndefined();
    expect(result.resolvedProviders).toEqual(['bedrock']);
    expect(result.missingProviders).toEqual([]);
    // The base environment — and therefore process.env in production — is untouched.
    expect(baseEnv.AWS_ACCESS_KEY_ID).toBe('stale-key');
    expect(baseEnv.AWS_BEARER_TOKEN_BEDROCK).toBe('must-not-leak');
    expect(
      authenticatedClisForProviders({
        installed: ['claude', 'opencode', 'codex', 'kiro'],
        resolvedProviders: result.resolvedProviders,
      }),
    ).toEqual(['claude', 'opencode', 'codex']);
  });

  it('treats a role entry with no credentials as missing so the stage fails closed', async () => {
    const result = await resolveInvocationAgentAuth({
      payload: rolePayload,
      store: execution,
      env: { AGENT_SETTINGS_SSM_PREFIX: '/app/dev' },
      broker: roleBroker({ kind: 'role' }),
    });
    expect(result.resolvedProviders).toEqual([]);
    expect(result.missingProviders).toEqual(['bedrock']);
    expect(result.env.AWS_ACCESS_KEY_ID).toBeUndefined();
  });

  it('never infers the shape from field presence: an entry with no kind is missing', async () => {
    const result = await resolveInvocationAgentAuth({
      payload: rolePayload,
      store: execution,
      env: { AGENT_SETTINGS_SSM_PREFIX: '/app/dev' },
      // A valueless entry is exactly what con-missing-value-is-missing describes;
      // an unknown kind must not be guessed either.
      broker: roleBroker({ credentials: stsCredentials }),
    });
    expect(result.resolvedProviders).toEqual([]);
    expect(result.missingProviders).toEqual(['bedrock']);
    expect(result.env.AWS_ACCESS_KEY_ID).toBeUndefined();
  });

  it('reports a broker refusal as credential_resolution_failed, carrying only the allowlisted code', async () => {
    await expect(
      resolveInvocationAgentAuth({
        payload: rolePayload,
        store: execution,
        env: { AGENT_SETTINGS_SSM_PREFIX: '/app/dev' },
        broker: async () => ({ ok: false, code: 'BEDROCK_ROLE_ASSUME_DENIED' }),
      }),
    ).rejects.toMatchObject({
      code: 'credential_resolution_failed',
      brokerCode: 'BEDROCK_ROLE_ASSUME_DENIED',
    });
  });

  it('answers capabilities from a usable role binding without any minted credential', async () => {
    const result = await resolveInvocationAgentAuth({
      payload: {
        command: 'capabilities',
        projectId: 'p-1',
        credentialBindings: { bedrock: bedrockBinding },
        agentCredentialGrant: 'grant-capabilities',
      },
      authMode: AGENT_AUTH_MODES.CAPABILITIES,
      env: { AGENT_SETTINGS_SSM_PREFIX: '/app/dev' },
      broker: async () => ({
        purpose: 'capabilities',
        projectId: 'p-1',
        executionId: null,
        credentials: [{ binding: bedrockBinding, kind: 'role', usable: true }],
      }),
    });
    expect(result.resolvedProviders).toEqual(['bedrock']);
    // No credential material is minted or delivered to answer a settings render.
    expect(result.env.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(result.env.AWS_SESSION_TOKEN).toBeUndefined();
    expect(result.env.AWS_BEARER_TOKEN_BEDROCK).toBeUndefined();
  });

  it('does not treat an unusable role binding as authed for capabilities', async () => {
    const result = await resolveInvocationAgentAuth({
      payload: {
        command: 'capabilities',
        projectId: 'p-1',
        credentialBindings: { bedrock: bedrockBinding },
        agentCredentialGrant: 'grant-capabilities',
      },
      authMode: AGENT_AUTH_MODES.CAPABILITIES,
      env: { AGENT_SETTINGS_SSM_PREFIX: '/app/dev' },
      broker: async () => ({
        purpose: 'capabilities',
        projectId: 'p-1',
        executionId: null,
        credentials: [{ binding: bedrockBinding, kind: 'role', usable: false }],
      }),
    });
    expect(result.resolvedProviders).toEqual([]);
    expect(result.missingProviders).toEqual(['bedrock']);
  });

  it('leaves the bearer path byte-identical: value set, no AWS credential variables', async () => {
    const result = await resolveInvocationAgentAuth({
      payload: rolePayload,
      store: execution,
      env: { AGENT_SETTINGS_SSM_PREFIX: '/app/dev' },
      broker: roleBroker({ kind: 'bearer', value: 'bearer-token' }),
    });
    expect(result.env.AWS_BEARER_TOKEN_BEDROCK).toBe('bearer-token');
    expect(result.env.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(result.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(result.env.AWS_SESSION_TOKEN).toBeUndefined();
    expect(result.resolvedProviders).toEqual(['bedrock']);
  });
});

// specs/bedrock-iam-role-credential-mode — req-credential-safety.
//
// A live scan of the runtime, broker and metadata log groups after a real stage run
// found zero credential material, but that is a point-in-time observation of one
// deployment. This asserts the property at the source: nothing the resolver writes
// to a log stream may carry a credential value, whatever the broker returns.
describe('role-path resolution logs no credential material', () => {
  const bedrockBinding = { provider: 'bedrock', source: 'platform' };
  const SECRETS = {
    AccessKeyId: 'ASIALOGPROBEEXAMPLE',
    SecretAccessKey: 'secret-log-probe-value',
    SessionToken: 'session-log-probe-value',
    Expiration: '2026-09-06T09:53:40.000Z',
  };

  it('writes names, never values, on every console channel', async () => {
    const written = [];
    const capture = (...args) => written.push(args.map((a) => String(a)).join(' '));
    const spies = ['log', 'info', 'warn', 'error', 'debug'].map((level) =>
      vi.spyOn(console, level).mockImplementation(capture),
    );
    try {
      const result = await resolveInvocationAgentAuth({
        payload: {
          command: 'run-stage',
          executionId: 'e1',
          requestedCli: 'claude',
          agentCredentialGrant: 'grant-role',
        },
        store: {
          getExecution: async () => ({
            projectId: 'p-1',
            agentCli: 'claude',
            credentialBinding: bedrockBinding,
          }),
        },
        env: { AGENT_SETTINGS_SSM_PREFIX: '/app/dev' },
        broker: async () => ({
          purpose: 'execution',
          projectId: 'p-1',
          executionId: 'e1',
          credentials: [{ binding: bedrockBinding, kind: 'role', credentials: SECRETS }],
        }),
      });
      // The credentials really were resolved, so this is not passing vacuously.
      expect(result.env.AWS_SESSION_TOKEN).toBe(SECRETS.SessionToken);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }

    const transcript = written.join('\n');
    for (const value of [SECRETS.AccessKeyId, SECRETS.SecretAccessKey, SECRETS.SessionToken]) {
      expect(transcript).not.toContain(value);
    }
  });

  it('leaves the reserved MCP bridge with no Bedrock credentials when resolution produced nothing', async () => {
    // The reserved `aidlc` bridge is the ONLY child meant to see the credential
    // chain, and it inherits it from the CLI process environment. So when
    // resolution produced nothing, the child must find nothing — there is no
    // second path by which it could reach Bedrock, and the container's own
    // execution role deliberately holds no bedrock permission.
    const result = await resolveInvocationAgentAuth({
      payload: {
        command: 'run-stage',
        executionId: 'e1',
        requestedCli: 'claude',
        agentCredentialGrant: 'grant-role',
      },
      store: {
        getExecution: async () => ({
          projectId: 'p-1',
          agentCli: 'claude',
          credentialBinding: bedrockBinding,
        }),
      },
      // Stale values from a previous invocation must be scrubbed, or the child
      // would inherit a credential this invocation was never granted.
      env: {
        AGENT_SETTINGS_SSM_PREFIX: '/app/dev',
        AWS_ACCESS_KEY_ID: 'ASIASTALEFROMPRIOR',
        AWS_SECRET_ACCESS_KEY: 'stale-secret',
        AWS_SESSION_TOKEN: 'stale-session',
        AWS_BEARER_TOKEN_BEDROCK: 'stale-bearer',
      },
      broker: async () => ({
        purpose: 'execution',
        projectId: 'p-1',
        executionId: 'e1',
        credentials: [{ binding: bedrockBinding, kind: null, value: null }],
      }),
    });

    expect(result.missingProviders).toEqual(['bedrock']);
    for (const name of [
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'AWS_SESSION_TOKEN',
      'AWS_BEARER_TOKEN_BEDROCK',
    ]) {
      expect(result.env[name]).toBeUndefined();
    }
  });
});
