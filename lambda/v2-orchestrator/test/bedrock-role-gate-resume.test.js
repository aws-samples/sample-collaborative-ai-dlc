import { describe, expect, it, vi } from 'vitest';
import {
  createContainerCredentialsProvider,
  createInvocationContext,
  createServer,
} from '../../agentcore/http-server.js';
import { createRunStageStart } from '../../agentcore/commands/run-stage-start.js';
import { __durableHandler } from '../index.js';

const listen = (server) =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

const close = (server) =>
  new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });

const credentialEnvironmentNames = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN',
];

const expectCredentialsScrubbed = (env) => {
  for (const name of credentialEnvironmentNames) expect(env).not.toHaveProperty(name);
};

describe('Bedrock role credentials across a durable gate', () => {
  it('persists no temporary credentials while waiting for hours and assumes a fresh role for the next stage', async () => {
    const startedAt = Date.parse('2026-09-08T08:00:00.000Z');
    let logicalNow = startedAt;
    const fourHours = 4 * 60 * 60 * 1000;
    const stageCallbacks = new Map();
    const durableWrites = [];
    const stageContexts = [];
    const providerRequests = [];
    const roleSessions = [];
    const refreshGrantClaims = [];
    let waitingSnapshot = null;
    let execution = {
      executionId: 'e-gate',
      intentId: 'e-gate',
      projectId: 'p-gate',
      status: 'CREATED',
      workflowId: 'aidlc-v2',
      workflowVersion: 1,
      scope: 'feature',
      startedAt: new Date(startedAt).toISOString(),
      startedBy: 'u-gate',
      repos: ['owner/repo'],
      branch: 'aidlc/e-gate',
      baseBranch: 'main',
      gitProvider: 'github',
      agentCli: 'claude',
      credentialBinding: { provider: 'bedrock', source: 'platform' },
      parkReleaseSeconds: null,
    };
    let humanTask = null;

    const store = {
      getExecution: vi.fn(async () => ({ ...execution })),
      updateExecution: vi.fn(async (input) => {
        durableWrites.push({ type: 'execution', value: structuredClone(input) });
        execution = { ...execution, ...input };
        return { ...execution };
      }),
      createHumanTask: vi.fn(async (input) => {
        humanTask = { ...input, status: 'pending', answer: null };
        durableWrites.push({ type: 'human-task', value: structuredClone(humanTask) });
        return { ...humanTask };
      }),
      getHumanTask: vi.fn(async () => (humanTask ? { ...humanTask } : null)),
      setGateCallbackId: vi.fn(async (input) => {
        humanTask = { ...humanTask, callbackId: input.callbackId };
        durableWrites.push({ type: 'gate-callback', value: structuredClone(input) });
        return { ...humanTask };
      }),
      appendEvent: vi.fn(async (input) => {
        durableWrites.push({ type: 'event', value: structuredClone(input) });
        return input;
      }),
      listUnits: vi.fn(async () => []),
      getUnit: vi.fn(async () => null),
      putTrackerSync: vi.fn(async (input) => input),
      failRunningStageAttempt: vi.fn(async () => null),
    };

    const ctx = {
      logger: { info() {}, debug() {}, error() {} },
      step: async (_name, fn) => fn(),
      createCallback: async (name) => {
        if (String(name).startsWith('stage-cb-')) {
          let resolve;
          const promise = new Promise((done) => {
            resolve = done;
          });
          const callbackId = `cb-${name}`;
          stageCallbacks.set(callbackId, resolve);
          return [promise, callbackId];
        }

        expect(String(name)).toMatch(/^await-eg-validation-si-review-0-/);
        expect(execution.status).toBe('WAITING');
        expect(humanTask).toMatchObject({
          kind: 'validation',
          stageInstanceId: 'si-review',
          status: 'pending',
        });
        expect(stageContexts).toHaveLength(1);
        expectCredentialsScrubbed(stageContexts[0].env);

        const revoked = await fetch(providerRequests[0].url, {
          headers: { Authorization: providerRequests[0].authorizationToken },
        });
        expect(revoked.status).toBe(404);

        waitingSnapshot = JSON.stringify({ execution, humanTask, durableWrites });
        const forbiddenPersistedValues = [
          ...roleSessions.flatMap((session) => [
            session.AccessKeyId,
            session.SecretAccessKey,
            session.SessionToken,
          ]),
          'bootstrap-access-1',
          'bootstrap-secret-1',
          'bootstrap-session-1',
          providerRequests[0].url,
          providerRequests[0].authorizationToken,
        ];
        for (const value of forbiddenPersistedValues) {
          expect(waitingSnapshot).not.toContain(value);
        }
        for (const environmentName of credentialEnvironmentNames) {
          expect(waitingSnapshot).not.toContain(environmentName);
        }

        logicalNow += fourHours;
        humanTask = {
          ...humanTask,
          status: 'approved',
          answer: { decision: 'approve' },
          answeredAt: new Date(logicalNow).toISOString(),
        };
        return [Promise.resolve({ answer: { decision: 'approve' } }), `cb-${name}`];
      },
      wait: async () => undefined,
      promise: {
        race: async (_name, promises) => Promise.race(promises),
        allSettled: async (_name, promises) => Promise.allSettled(promises),
      },
      runInChildContext: (_name, fn) => Promise.resolve().then(() => fn(ctx)),
    };

    const broker = vi.fn(async ({ grant }) => {
      const sequence = roleSessions.length + 1;
      const credentials = {
        AccessKeyId: `ASIA-GATE-${sequence}`,
        SecretAccessKey: `gate-secret-${sequence}`,
        SessionToken: `gate-session-${sequence}`,
        Expiration: new Date(logicalNow + 60 * 60 * 1000).toISOString(),
      };
      roleSessions.push({ ...credentials, grant, issuedAt: logicalNow });
      return { ok: true, credentials };
    });
    const containerCredentials = createContainerCredentialsProvider({ broker });
    await containerCredentials.listen();

    let bootstrapSequence = 0;
    const resolveAuth = vi.fn(async () => {
      bootstrapSequence += 1;
      return {
        env: {
          AWS_ACCESS_KEY_ID: `bootstrap-access-${bootstrapSequence}`,
          AWS_SECRET_ACCESS_KEY: `bootstrap-secret-${bootstrapSequence}`,
          AWS_SESSION_TOKEN: `bootstrap-session-${bootstrapSequence}`,
        },
        credentialKinds: { bedrock: 'role' },
        resolvedProviders: ['bedrock'],
      };
    });
    const prepareInvocation = createInvocationContext({
      store,
      installedClis: ['claude'],
      containerCredentials,
      resolveAuth,
      authenticatedClis: () => ['claude'],
    });

    let activeContext;
    const runStage = vi.fn(async (payload, context) => {
      stageContexts.push(context);
      expect(context.env.AWS_ACCESS_KEY_ID).toBeUndefined();
      expect(context.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
      expect(context.env.AWS_SESSION_TOKEN).toBeUndefined();

      const request = {
        stageInstanceId: payload.stageInstanceId,
        url: context.env.AWS_CONTAINER_CREDENTIALS_FULL_URI,
        authorizationToken: context.env.AWS_CONTAINER_AUTHORIZATION_TOKEN,
        requestedAt: logicalNow,
      };
      providerRequests.push(request);
      const response = await fetch(request.url, {
        headers: { Authorization: request.authorizationToken },
      });
      expect(response.status).toBe(200);
      const credentials = await response.json();
      expect(credentials.AccessKeyId).toBe(`ASIA-GATE-${stageContexts.length}`);
      return { ok: true, state: 'SUCCEEDED', stageInstanceId: payload.stageInstanceId };
    });

    const sendCallbackSuccess = vi.fn(async (callbackId, result) => {
      const resolve = stageCallbacks.get(callbackId);
      if (!resolve) return { delivered: false, error: 'callback not found' };
      setTimeout(() => resolve(result), 0);
      return { delivered: true };
    });
    const startStage = createRunStageStart({
      runStage: (payload) => runStage(payload, activeContext),
      sendCallbackSuccess,
      sendCallbackHeartbeat: vi.fn(async () => ({ delivered: true })),
      heartbeatIntervalMs: 24 * 60 * 60 * 1000,
      log: vi.fn(),
    });
    const handlers = {
      initWs: vi.fn(async () => ({ ok: true })),
      runStageStart: (payload, context) => {
        activeContext = context;
        return startStage(payload, context);
      },
    };
    const runtimeServer = createServer({ handlers, prepareInvocation });
    const runtimePort = await listen(runtimeServer);

    const invokeRuntime = vi.fn(async (payload) => {
      const response = await fetch(`http://127.0.0.1:${runtimePort}/invocations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      return response.json();
    });
    const issueBedrockRoleRefreshGrant = vi.fn(async (claims) => {
      const grant = `refresh-${claims.stageInstanceId}-${claims.stageCallbackId}`;
      refreshGrantClaims.push({ ...claims, grant, issuedAt: logicalNow });
      return grant;
    });
    const deps = {
      store,
      loadPlan: vi.fn(async () => ({
        valid: true,
        plan: {
          stages: [
            {
              stageId: 'review',
              stageInstanceId: 'si-review',
              humanValidation: 'required',
              outputArtifacts: [],
            },
            { stageId: 'implement', stageInstanceId: 'si-implement', outputArtifacts: [] },
          ],
        },
      })),
      invokeRuntime,
      issueAgentCredentialGrant: vi.fn(async () => 'short-lived-agent-grant'),
      issueBedrockRoleRefreshGrant,
      stopSession: vi.fn(async () => ({ stopped: true })),
      broadcast: vi.fn(async () => {}),
      openPr: vi.fn(async () => ({ skipped: true, reason: 'no_changes' })),
      comparePrBranches: vi.fn(async () => ({ status: 'unknown' })),
      applicationUrl: 'https://aidlc.example.test/',
    };

    try {
      const result = await __durableHandler(
        { action: 'start', intentId: 'e-gate', executionId: 'e-gate' },
        ctx,
        deps,
      );

      expect(result).toEqual({ ok: true, intentId: 'e-gate', stages: 2 });
      expect(waitingSnapshot).not.toBeNull();
      expect(refreshGrantClaims).toHaveLength(2);
      expect(refreshGrantClaims.map((claim) => claim.stageInstanceId)).toEqual([
        'si-review',
        'si-implement',
      ]);
      expect(refreshGrantClaims[1].issuedAt - refreshGrantClaims[0].issuedAt).toBe(fourHours);
      expect(new Set(refreshGrantClaims.map((claim) => claim.grant)).size).toBe(2);

      expect(roleSessions).toHaveLength(2);
      expect(roleSessions.map((session) => session.AccessKeyId)).toEqual([
        'ASIA-GATE-1',
        'ASIA-GATE-2',
      ]);
      expect(roleSessions[1].issuedAt - roleSessions[0].issuedAt).toBe(fourHours);
      expect(roleSessions.map((session) => session.grant)).toEqual(
        refreshGrantClaims.map((claim) => claim.grant),
      );
      expect(providerRequests.map((request) => request.stageInstanceId)).toEqual([
        'si-review',
        'si-implement',
      ]);
      expect(providerRequests[1].url).not.toBe(providerRequests[0].url);
      expect(providerRequests[1].authorizationToken).not.toBe(
        providerRequests[0].authorizationToken,
      );
      expect(resolveAuth).toHaveBeenCalledTimes(2);
      expect(broker).toHaveBeenCalledTimes(2);
      expect(stageContexts).toHaveLength(2);
      for (const context of stageContexts) expectCredentialsScrubbed(context.env);
      await vi.waitFor(() => expect(startStage.activeJobs.size).toBe(0));
    } finally {
      await close(runtimeServer);
      await containerCredentials.close();
    }
  });
});
