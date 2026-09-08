import { describe, expect, it, vi } from 'vitest';
import {
  createContainerCredentialsProvider,
  createInvocationContext,
  createServer,
} from '../http-server.js';
import { createRunStageStart } from '../commands/run-stage-start.js';

const listen = (server) =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

const close = (server) =>
  new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });

const createFakeClock = (initial) => {
  let current = Date.parse(initial);
  return {
    now: () => current,
    advance: (milliseconds) => {
      current += milliseconds;
    },
  };
};

describe('Bedrock role refresh during an active stage', () => {
  it('crosses multiple credential expirations through one loopback provider without replaying the stage', async () => {
    const clock = createFakeClock('2026-09-08T12:00:00.000Z');
    const issued = [];
    const broker = vi.fn(async () => {
      const sequence = issued.length + 1;
      const credentials = {
        AccessKeyId: `access-${sequence}`,
        SecretAccessKey: `secret-${sequence}`,
        SessionToken: `session-${sequence}`,
        Expiration: new Date(clock.now() + 10_000).toISOString(),
      };
      issued.push({
        accessKeyId: credentials.AccessKeyId,
        issuedAt: clock.now(),
        expiresAt: Date.parse(credentials.Expiration),
      });
      return { ok: true, credentials };
    });
    const containerCredentials = createContainerCredentialsProvider({ broker });
    await containerCredentials.listen();

    const resolveAuth = vi.fn(async () => ({
      env: {
        AWS_ACCESS_KEY_ID: 'initial-access',
        AWS_SECRET_ACCESS_KEY: 'initial-secret',
        AWS_SESSION_TOKEN: 'initial-session',
      },
      credentialKinds: { bedrock: 'role' },
      resolvedProviders: ['bedrock'],
    }));
    const prepareInvocation = createInvocationContext({
      store: {},
      installedClis: ['claude'],
      containerCredentials,
      resolveAuth,
      authenticatedClis: () => ['claude'],
    });

    let capturedProviderUrl;
    let capturedAuthorizationToken;
    let capturedStageEnv;
    const usedAccessKeys = [];
    const runStage = vi.fn(async (_payload, context) => {
      capturedStageEnv = context.env;
      capturedProviderUrl = context.env.AWS_CONTAINER_CREDENTIALS_FULL_URI;
      capturedAuthorizationToken = context.env.AWS_CONTAINER_AUTHORIZATION_TOKEN;

      expect(context.env.AWS_ACCESS_KEY_ID).toBeUndefined();
      expect(context.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
      expect(context.env.AWS_SESSION_TOKEN).toBeUndefined();

      let cachedCredentials = null;
      const credentialsForRequest = async () => {
        if (!cachedCredentials || Date.parse(cachedCredentials.Expiration) <= clock.now()) {
          const response = await fetch(capturedProviderUrl, {
            headers: { Authorization: capturedAuthorizationToken },
          });
          expect(response.status).toBe(200);
          cachedCredentials = await response.json();
        }
        return cachedCredentials;
      };

      usedAccessKeys.push((await credentialsForRequest()).AccessKeyId);
      clock.advance(11_000);
      usedAccessKeys.push((await credentialsForRequest()).AccessKeyId);
      clock.advance(11_000);
      usedAccessKeys.push((await credentialsForRequest()).AccessKeyId);

      return { ok: true, state: 'SUCCEEDED', stageInstanceId: 'si-active' };
    });

    let completeCallback;
    const callbackCompleted = new Promise((resolve) => {
      completeCallback = resolve;
    });
    const sendCallbackSuccess = vi.fn(async (callbackId, result) => {
      completeCallback({ callbackId, result });
      return { delivered: true };
    });
    const startStage = createRunStageStart({
      runStage: (payload) => runStage(payload, activeContext),
      sendCallbackSuccess,
      sendCallbackHeartbeat: vi.fn(async () => ({ delivered: true })),
      log: vi.fn(),
    });
    let activeContext;
    const handlers = {
      runStageStart: (payload, context) => {
        activeContext = context;
        return startStage(payload, context);
      },
    };
    const runtimeServer = createServer({ handlers, prepareInvocation });
    const runtimePort = await listen(runtimeServer);

    try {
      const response = await fetch(`http://127.0.0.1:${runtimePort}/invocations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          command: 'run-stage-start',
          projectId: 'p-active',
          executionId: 'e-active',
          stageId: 'implementation',
          stageInstanceId: 'si-active',
          stageCallbackId: 'cb-active',
          bedrockRoleRefreshGrant: 'signed-refresh-grant',
        }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: true, accepted: true });

      await expect(callbackCompleted).resolves.toEqual({
        callbackId: 'cb-active',
        result: { ok: true, state: 'SUCCEEDED', stageInstanceId: 'si-active' },
      });
      await vi.waitFor(() => expect(startStage.activeJobs.size).toBe(0));

      expect(resolveAuth).toHaveBeenCalledOnce();
      expect(runStage).toHaveBeenCalledOnce();
      expect(sendCallbackSuccess).toHaveBeenCalledOnce();
      expect(usedAccessKeys).toEqual(['access-1', 'access-2', 'access-3']);
      expect(issued).toHaveLength(3);
      expect(issued[0].expiresAt).toBeLessThanOrEqual(issued[1].issuedAt);
      expect(issued[1].expiresAt).toBeLessThanOrEqual(issued[2].issuedAt);
      expect(broker).toHaveBeenCalledTimes(3);
      expect(broker).toHaveBeenCalledWith({
        action: 'refresh-bedrock-role-credentials',
        grant: 'signed-refresh-grant',
      });

      expect(capturedStageEnv.AWS_CONTAINER_CREDENTIALS_FULL_URI).toBeUndefined();
      expect(capturedStageEnv.AWS_CONTAINER_AUTHORIZATION_TOKEN).toBeUndefined();
      const revoked = await fetch(capturedProviderUrl, {
        headers: { Authorization: capturedAuthorizationToken },
      });
      expect(revoked.status).toBe(404);
    } finally {
      await close(runtimeServer);
      await containerCredentials.close();
    }
  });
});
