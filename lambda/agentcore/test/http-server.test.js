import { describe, it, expect, vi } from 'vitest';
import {
  createBusyTracker,
  createContainerCredentialsProvider,
  createInvocationContext,
  dispatchInvocation,
  createServer,
} from '../http-server.js';
import { AGENT_AUTH_MODES, COMMANDS, commandDefinition } from '../command-registry.js';

describe('createBusyTracker', () => {
  it('reports HealthyBusy while work is in flight, Healthy otherwise', () => {
    const b = createBusyTracker();
    expect(b.status).toBe('Healthy');
    b.enter();
    expect(b.status).toBe('HealthyBusy');
    b.enter();
    b.leave();
    expect(b.status).toBe('HealthyBusy');
    b.leave();
    expect(b.status).toBe('Healthy');
  });
});

describe('createInvocationContext', () => {
  const installedClis = ['claude', 'kiro'];
  const authenticatedClis = ({ installed, resolvedProviders }) =>
    installed.filter((cli) => resolvedProviders.includes(cli === 'claude' ? 'bedrock' : 'kiro'));

  it('registers a role-mode stage and installs only its loopback URI and token', async () => {
    const revoke = vi.fn();
    const registerInvocation = vi.fn(() => ({
      url: 'http://127.0.0.1:3210/v1/credentials/invocation',
      authorizationToken: 'invocation-token',
      revoke,
    }));
    const resolveAuth = vi.fn(async () => ({
      env: {
        AWS_ACCESS_KEY_ID: 'initial-key',
        AWS_SECRET_ACCESS_KEY: 'initial-secret',
        AWS_SESSION_TOKEN: 'initial-session',
      },
      credentialKinds: { bedrock: 'role' },
      resolvedProviders: ['bedrock'],
      credentialExpiresAt: '2026-09-08T12:00:10.000Z',
    }));
    const prepareInvocation = createInvocationContext({
      store: {},
      installedClis,
      containerCredentials: { registerInvocation },
      resolveAuth,
      authenticatedClis,
      env: { BASE: 'value' },
    });

    const result = await prepareInvocation(
      {
        command: 'run-stage-start',
        bedrockRoleRefreshGrant: 'signed-refresh-grant',
      },
      AGENT_AUTH_MODES.EXECUTION,
    );

    expect(registerInvocation).toHaveBeenCalledWith('signed-refresh-grant');
    expect(result.env).toMatchObject({
      AWS_CONTAINER_CREDENTIALS_FULL_URI: 'http://127.0.0.1:3210/v1/credentials/invocation',
      AWS_CONTAINER_AUTHORIZATION_TOKEN: 'invocation-token',
    });
    expect(result.env.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(result.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(result.env.AWS_SESSION_TOKEN).toBeUndefined();
    expect(result.credentialExpiresAt).toBeNull();
    expect(result.availableClis).toEqual(['claude']);
    expect(Object.keys(result)).not.toContain('cleanup');
    expect(Object.keys(result)).not.toContain('deferCleanup');

    result.cleanup();
    result.cleanup();
    expect(revoke).toHaveBeenCalledOnce();
    expect(result.env.AWS_CONTAINER_CREDENTIALS_FULL_URI).toBeUndefined();
    expect(result.env.AWS_CONTAINER_AUTHORIZATION_TOKEN).toBeUndefined();
    expect(result.env.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(result.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(result.env.AWS_SESSION_TOKEN).toBeUndefined();
  });

  it('does not register refresh authority for a bearer-mode stage', async () => {
    const registerInvocation = vi.fn();
    const prepareInvocation = createInvocationContext({
      store: {},
      installedClis,
      containerCredentials: { registerInvocation },
      resolveAuth: async () => ({
        env: { AWS_BEARER_TOKEN_BEDROCK: 'bearer' },
        credentialKinds: { bedrock: 'bearer' },
        resolvedProviders: ['bedrock'],
      }),
      authenticatedClis,
    });

    const result = await prepareInvocation(
      {
        command: 'run-stage-start',
        bedrockRoleRefreshGrant: 'unused-refresh-grant',
      },
      AGENT_AUTH_MODES.EXECUTION,
    );

    expect(registerInvocation).not.toHaveBeenCalled();
    expect(result.env.AWS_CONTAINER_CREDENTIALS_FULL_URI).toBeUndefined();
    expect(result.env.AWS_CONTAINER_AUTHORIZATION_TOKEN).toBeUndefined();
  });

  it('fails closed when a role-mode stage has no refresh grant', async () => {
    const prepareInvocation = createInvocationContext({
      store: {},
      installedClis,
      containerCredentials: { registerInvocation: vi.fn() },
      resolveAuth: async () => ({
        env: {},
        credentialKinds: { bedrock: 'role' },
        resolvedProviders: ['bedrock'],
      }),
      authenticatedClis,
    });

    await expect(
      prepareInvocation({ command: 'run-stage-start' }, AGENT_AUTH_MODES.EXECUTION),
    ).rejects.toMatchObject({ code: 'credential_grant_required' });
  });
});

describe('createContainerCredentialsProvider lifecycle', () => {
  const expectNoStore = (response) => {
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('pragma')).toBe('no-cache');
    expect(response.headers.get('content-type')).toMatch(/^application\/json/);
  };

  it('binds only to loopback and returns non-cacheable standard container credentials', async () => {
    const credentials = {
      AccessKeyId: 'access-key',
      SecretAccessKey: 'secret-key',
      SessionToken: 'session-token',
      Expiration: '2026-09-08T17:00:00.000Z',
    };
    const broker = vi.fn(async () => ({ ok: true, credentials }));
    const provider = createContainerCredentialsProvider({ broker });
    const address = await provider.listen();
    const registration = provider.registerInvocation('signed-refresh-grant');

    try {
      expect(address.address).toBe('127.0.0.1');
      const endpoint = new URL(registration.url);
      expect(endpoint.hostname).toBe('127.0.0.1');
      expect(Number(endpoint.port)).toBe(address.port);

      const response = await fetch(registration.url, {
        headers: { Authorization: registration.authorizationToken },
      });
      expect(response.status).toBe(200);
      expectNoStore(response);
      expect(await response.json()).toEqual({
        AccessKeyId: 'access-key',
        SecretAccessKey: 'secret-key',
        Token: 'session-token',
        Expiration: '2026-09-08T17:00:00.000Z',
      });
      expect(broker).toHaveBeenCalledWith({
        action: 'refresh-bedrock-role-credentials',
        grant: 'signed-refresh-grant',
      });
      expect(credentials).toEqual({});
    } finally {
      await provider.close();
    }
  });

  it.each([
    ['missing', null],
    ['incorrect', 'incorrect-invocation-token'],
  ])('rejects a %s authorization token without invoking the broker', async (_label, token) => {
    const broker = vi.fn();
    const provider = createContainerCredentialsProvider({ broker });
    await provider.listen();
    const registration = provider.registerInvocation('signed-refresh-grant');

    try {
      const response = await fetch(registration.url, {
        headers: token ? { Authorization: token } : {},
      });
      expect(response.status).toBe(401);
      expectNoStore(response);
      expect(await response.json()).toEqual({ error: 'unauthorized' });
      expect(broker).not.toHaveBeenCalled();
    } finally {
      await provider.close();
    }
  });

  it('redacts refresh grants, tokens, credentials, and broker errors from responses and logs', async () => {
    const credentialSecret = 'credential-secret-must-not-leak';
    let registration;
    const broker = vi.fn(async ({ grant }) => {
      throw new Error(
        `refresh failed grant=${grant} token=${registration.authorizationToken} secret=${credentialSecret}`,
      );
    });
    const logSpies = ['error', 'warn', 'info', 'log'].map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    );
    const provider = createContainerCredentialsProvider({ broker });
    await provider.listen();
    registration = provider.registerInvocation('signed-refresh-grant-must-not-leak');

    try {
      const response = await fetch(registration.url, {
        headers: { Authorization: registration.authorizationToken },
      });
      expect(response.status).toBe(503);
      expectNoStore(response);
      const responseBody = await response.text();
      expect(JSON.parse(responseBody)).toEqual({ error: 'credential refresh unavailable' });

      const capturedLogs = logSpies.flatMap((spy) => spy.mock.calls.flat()).join(' ');
      for (const secret of [
        'signed-refresh-grant-must-not-leak',
        registration.authorizationToken,
        credentialSecret,
      ]) {
        expect(responseBody).not.toContain(secret);
        expect(capturedLogs).not.toContain(secret);
      }
    } finally {
      await provider.close();
      for (const spy of logSpies) spy.mockRestore();
    }
  });

  it('revokes the endpoint and clears mutable token and credential references', async () => {
    const credentials = {
      AccessKeyId: 'access-key',
      SecretAccessKey: 'secret-key',
      SessionToken: 'session-token',
      Expiration: '2026-09-08T17:00:00.000Z',
    };
    const broker = vi.fn(async () => ({ ok: true, credentials }));
    const provider = createContainerCredentialsProvider({ broker });
    await provider.listen();
    const registration = provider.registerInvocation('signed-refresh-grant');
    const url = registration.url;
    const authorizationToken = registration.authorizationToken;

    try {
      const accepted = await fetch(url, {
        headers: { Authorization: authorizationToken },
      });
      expect(accepted.status).toBe(200);
      expect(await accepted.json()).toEqual({
        AccessKeyId: 'access-key',
        SecretAccessKey: 'secret-key',
        Token: 'session-token',
        Expiration: '2026-09-08T17:00:00.000Z',
      });
      expect(credentials).toEqual({});

      registration.revoke();
      registration.revoke();
      expect(registration.url).toBeNull();
      expect(registration.authorizationToken).toBeNull();

      const revoked = await fetch(url, {
        headers: { Authorization: authorizationToken },
      });
      expect(revoked.status).toBe(404);
      expectNoStore(revoked);
      expect(broker).toHaveBeenCalledOnce();
    } finally {
      await provider.close();
    }
  });

  it('does not release credentials from a broker call that loses a revocation race', async () => {
    let resolveBroker;
    const broker = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveBroker = resolve;
        }),
    );
    const provider = createContainerCredentialsProvider({ broker });
    await provider.listen();
    const registration = provider.registerInvocation('signed-refresh-grant');
    const url = registration.url;
    const authorizationToken = registration.authorizationToken;

    try {
      const responsePromise = fetch(url, {
        headers: { Authorization: authorizationToken },
      });
      await vi.waitFor(() => expect(broker).toHaveBeenCalledOnce());
      registration.revoke();
      resolveBroker({
        ok: true,
        credentials: {
          AccessKeyId: 'late-access-key',
          SecretAccessKey: 'late-secret-key',
          SessionToken: 'late-session-token',
          Expiration: '2026-09-08T17:00:00.000Z',
        },
      });

      const response = await responsePromise;
      expect(response.status).toBe(404);
      expect(JSON.stringify(await response.json())).not.toContain('late-');
    } finally {
      await provider.close();
    }
  });
});

describe('dispatchInvocation', () => {
  const handlers = {
    initWs: async (p) => ({ ok: true, intentId: p.intentId }),
    runStage: async (p) => ({ ok: true, stageId: p.stageId, state: 'SUCCEEDED' }),
    inspect: async (p) => ({ ok: true, intentId: p.intentId, artifactCount: 0 }),
  };

  it('rejects a missing command', async () => {
    const r = await dispatchInvocation({ payload: {}, handlers });
    expect(r.statusCode).toBe(400);
  });

  it('rejects an unknown command', async () => {
    const r = await dispatchInvocation({ payload: { command: 'nope' }, handlers });
    expect(r.statusCode).toBe(400);
  });

  it('keeps routing and authentication metadata in one command registry', () => {
    expect(COMMANDS['init-ws']).toEqual({ handler: 'initWs', agentAuth: false });
    expect(COMMANDS['run-stage']).toEqual({
      handler: 'runStage',
      agentAuth: AGENT_AUTH_MODES.EXECUTION,
    });
    expect(COMMANDS['compose-plan-start'].agentAuth).toBe(AGENT_AUTH_MODES.COMPOSE);
    expect(COMMANDS['discussion-assist-start'].agentAuth).toBe(AGENT_AUTH_MODES.DISCUSSION);
    expect(COMMANDS.capabilities.agentAuth).toBe(AGENT_AUTH_MODES.CAPABILITIES);
    expect(commandDefinition('toString')).toBeNull();
  });

  it('routes init-ws and run-stage', async () => {
    const a = await dispatchInvocation({
      payload: { command: 'init-ws', intentId: 'i1' },
      handlers,
      now: () => '2026-01-01T00:00:00.000Z',
    });
    expect(a).toMatchObject({
      statusCode: 200,
      body: { ok: true, intentId: 'i1', command: 'init-ws' },
    });
    const b = await dispatchInvocation({
      payload: { command: 'run-stage', stageId: 's1' },
      handlers,
    });
    expect(b).toMatchObject({ statusCode: 200, body: { ok: true, stageId: 's1' } });
    const c = await dispatchInvocation({
      payload: { command: 'inspect', intentId: 'i1' },
      handlers,
    });
    expect(c).toMatchObject({
      statusCode: 200,
      body: { ok: true, intentId: 'i1', command: 'inspect' },
    });
  });

  it('does not prepare agent credentials for engine-only commands', async () => {
    const prepareInvocation = vi.fn(async () => {
      throw new Error('SSM unavailable');
    });
    const result = await dispatchInvocation({
      payload: { command: 'init-ws', intentId: 'i1' },
      handlers,
      prepareInvocation,
    });

    expect(result).toMatchObject({
      statusCode: 200,
      body: { ok: true, intentId: 'i1', command: 'init-ws' },
    });
    expect(prepareInvocation).not.toHaveBeenCalled();
  });

  it('prepares agent credentials for CLI-consuming commands', async () => {
    const prepareInvocation = vi.fn(async () => ({ availableClis: ['kiro'] }));
    const runStage = vi.fn(async (_payload, context) => ({
      ok: true,
      availableClis: context.availableClis,
    }));
    const result = await dispatchInvocation({
      payload: {
        command: 'run-stage',
        stageId: 's1',
        agentCredentialGrant: 'signed-grant',
        bedrockRoleRefreshGrant: 'signed-refresh-grant',
      },
      handlers: { runStage },
      prepareInvocation,
    });

    expect(result).toMatchObject({
      statusCode: 200,
      body: { ok: true, availableClis: ['kiro'], command: 'run-stage' },
    });
    expect(prepareInvocation).toHaveBeenCalledWith(
      {
        command: 'run-stage',
        stageId: 's1',
        agentCredentialGrant: 'signed-grant',
        bedrockRoleRefreshGrant: 'signed-refresh-grant',
      },
      AGENT_AUTH_MODES.EXECUTION,
    );
    expect(runStage).toHaveBeenCalledWith(
      { command: 'run-stage', stageId: 's1' },
      { availableClis: ['kiro'] },
    );
  });

  it('routes promote-units (WP3 unit DAG promotion)', async () => {
    const r = await dispatchInvocation({
      payload: { command: 'promote-units', intentId: 'i1', executionId: 'e1' },
      handlers: {
        promoteUnits: async (p) => ({ ok: true, unitCount: 3, executionId: p.executionId }),
      },
    });
    expect(r).toMatchObject({
      statusCode: 200,
      body: { ok: true, unitCount: 3, executionId: 'e1', command: 'promote-units' },
    });
  });

  it('routes derive-artifacts for fine-grained graph projection', async () => {
    const r = await dispatchInvocation({
      payload: { command: 'derive-artifacts', intentId: 'i1', executionId: 'e1' },
      handlers: {
        deriveArtifacts: async (p) => ({ ok: true, artifacts: ['a1'], executionId: p.executionId }),
      },
    });
    expect(r).toMatchObject({
      statusCode: 200,
      body: { ok: true, artifacts: ['a1'], executionId: 'e1', command: 'derive-artifacts' },
    });
  });

  it('routes discussion-assist-start for Quorum discussion jobs', async () => {
    const r = await dispatchInvocation({
      payload: {
        command: 'discussion-assist-start',
        intentId: 'i1',
        discussionId: 'd1',
        requestId: 'r1',
      },
      handlers: {
        discussionAssistStart: async (p) => ({
          ok: true,
          accepted: true,
          requestId: p.requestId,
        }),
      },
    });
    expect(r).toMatchObject({
      statusCode: 200,
      body: {
        ok: true,
        accepted: true,
        requestId: 'r1',
        command: 'discussion-assist-start',
      },
    });
  });

  it('routes record-pr (fan-in PR graph record)', async () => {
    const r = await dispatchInvocation({
      payload: {
        command: 'record-pr',
        intentId: 'i1',
        executionId: 'e1',
        prs: [{ repoId: 'o/r' }],
      },
      handlers: {
        recordPr: async (p) => ({ ok: true, recorded: p.prs, executionId: p.executionId }),
      },
    });
    expect(r).toMatchObject({
      statusCode: 200,
      body: { ok: true, executionId: 'e1', command: 'record-pr' },
    });
  });

  it('routes record-unit-pr without using the final PR handler', async () => {
    const recordPr = vi.fn();
    const recordUnitPr = vi.fn(async (payload) => ({
      ok: true,
      recorded: payload.unitPrs,
    }));
    const result = await dispatchInvocation({
      payload: {
        command: 'record-unit-pr',
        intentId: 'i1',
        executionId: 'e1',
        unitPrs: [{ unitSlug: 'auth', prNumber: 7 }],
      },
      handlers: { recordPr, recordUnitPr },
    });
    expect(result).toMatchObject({
      statusCode: 200,
      body: { ok: true, command: 'record-unit-pr' },
    });
    expect(recordUnitPr).toHaveBeenCalledOnce();
    expect(recordPr).not.toHaveBeenCalled();
  });

  it('routes init-lane and merge-lane (WP5 unit lanes)', async () => {
    const laneHandlers = {
      initLane: async (p) => ({ ok: true, unitSlug: p.unitSlug }),
      mergeLane: async (p) => ({ ok: false, reason: 'merge_conflict', unitSlug: p.unitSlug }),
    };
    const a = await dispatchInvocation({
      payload: { command: 'init-lane', unitSlug: 'auth' },
      handlers: laneHandlers,
    });
    expect(a).toMatchObject({
      statusCode: 200,
      body: { ok: true, unitSlug: 'auth', command: 'init-lane' },
    });
    // A merge conflict is an ok:false VALUE, not an HTTP transport failure.
    const b = await dispatchInvocation({
      payload: { command: 'merge-lane', unitSlug: 'auth' },
      handlers: laneHandlers,
    });
    expect(b).toMatchObject({
      statusCode: 200,
      body: { ok: false, reason: 'merge_conflict', command: 'merge-lane' },
    });
  });

  it('keeps a handler ok:false on 200 so callers receive the failure body', async () => {
    const r = await dispatchInvocation({
      payload: { command: 'run-stage' },
      handlers: { runStage: async () => ({ ok: false, reason: 'no_cli' }) },
    });
    expect(r.statusCode).toBe(200);
    expect(r.body.reason).toBe('no_cli');
  });

  it.each([
    'credential_binding_mismatch',
    'credential_grant_mismatch',
    'credential_grant_required',
    'credential_resolution_failed',
  ])('returns allowlisted application failure %s on HTTP 200', async (reason) => {
    const prepareInvocation = vi.fn(async () => {
      throw Object.assign(new Error('sensitive credential provider detail'), { code: reason });
    });
    const runStage = vi.fn();
    const result = await dispatchInvocation({
      payload: { command: 'run-stage' },
      handlers: { runStage },
      prepareInvocation,
      now: () => '2026-01-01T00:00:00.000Z',
    });

    expect(result).toEqual({
      statusCode: 200,
      body: {
        ok: false,
        reason,
        command: 'run-stage',
        at: '2026-01-01T00:00:00.000Z',
      },
    });
    expect(JSON.stringify(result.body)).not.toContain('sensitive credential provider detail');
    expect(runStage).not.toHaveBeenCalled();
  });

  it.each([
    ['an unknown lower-snake-case code', 'database_timeout'],
    ['an SDK-style code', 'ThrottlingException'],
    ['an operating-system code', 'ENOENT'],
  ])('keeps %s on sanitized HTTP 500', async (_label, code) => {
    const result = await dispatchInvocation({
      payload: { command: 'init-ws' },
      handlers: {
        initWs: async () => {
          throw Object.assign(new Error('sensitive runtime detail'), { code });
        },
      },
    });

    expect(result).toEqual({
      statusCode: 500,
      body: { error: 'Internal server error', command: 'init-ws' },
    });
    expect(JSON.stringify(result.body)).not.toContain('sensitive runtime detail');
    expect(result.body).not.toHaveProperty('reason');
  });

  it('maps an uncoded thrown handler to sanitized HTTP 500', async () => {
    const r = await dispatchInvocation({
      payload: { command: 'init-ws' },
      handlers: {
        initWs: async () => {
          throw new Error('boom');
        },
      },
    });
    expect(r).toEqual({
      statusCode: 500,
      body: { error: 'Internal server error', command: 'init-ws' },
    });
    expect(JSON.stringify(r.body)).not.toContain('boom');
  });

  it('returns to Healthy after a parked run-stage dispatch (no longer pinned busy)', async () => {
    const busy = createBusyTracker();
    // ask_question now parks, so run-stage returns promptly with WAITING_FOR_HUMAN
    // instead of blocking — busy.leave() fires and /ping can report Healthy.
    await dispatchInvocation({
      payload: { command: 'run-stage' },
      handlers: {
        runStage: async () => ({ ok: true, state: 'WAITING_FOR_HUMAN', humanTaskId: 'q-1' }),
      },
      busy,
    });
    expect(busy.status).toBe('Healthy');
  });

  it('flips busy during the handler', async () => {
    const busy = createBusyTracker();
    let statusDuring;
    await dispatchInvocation({
      payload: { command: 'run-stage' },
      handlers: {
        runStage: async () => {
          statusDuring = busy.status;
          return { ok: true };
        },
      },
      busy,
    });
    expect(statusDuring).toBe('HealthyBusy');
    expect(busy.status).toBe('Healthy');
  });
});

// End-to-end over a real socket: /ping and /invocations.
describe('createServer (http)', () => {
  const handlers = {
    initWs: async () => ({ ok: true }),
    runStage: async () => ({ ok: true, state: 'SUCCEEDED' }),
  };

  const listen = (server) =>
    new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

  it('serves /ping with a status', async () => {
    const server = createServer({ handlers });
    const port = await listen(server);
    const res = await fetch(`http://127.0.0.1:${port}/ping`);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.status).toBe('Healthy');
    server.close();
  });

  it('serves POST /invocations', async () => {
    const server = createServer({ handlers });
    const port = await listen(server);
    const res = await fetch(`http://127.0.0.1:${port}/invocations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'run-stage', stageId: 's1' }),
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, command: 'run-stage' });
    server.close();
  });

  it('404s an unknown route', async () => {
    const server = createServer({ handlers });
    const port = await listen(server);
    const res = await fetch(`http://127.0.0.1:${port}/nope`);
    expect(res.status).toBe(404);
    server.close();
  });
});
