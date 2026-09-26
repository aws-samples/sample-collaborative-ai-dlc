import { describe, expect, it, vi } from 'vitest';
import { createRuntimeForRevision, retrySessionCleanups, verifyRuntime } from '../status.js';
import { capacityProviderName } from '../compute.js';

const INSTANCES_ENV = {
  MANAGED_INSTANCES_OPERATOR_ROLE_ARN: 'arn:aws:iam::123456789012:role/operator',
  MANAGED_INSTANCES_SUBNETS: '["subnet-1"]',
  MANAGED_INSTANCES_SECURITY_GROUPS: '["sg-1"]',
  MANAGED_INSTANCES_CP_NAME_PREFIX: 'test_platform',
  MANAGED_RUNTIME_ROLE_ARN: 'arn:aws:iam::123456789012:role/runtime',
};

const withEnv = async (fn) => {
  const saved = {};
  for (const [key, value] of Object.entries(INSTANCES_ENV)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(INSTANCES_ENV)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
};

const instancesEnvironment = {
  environmentId: 'x86-build',
  status: 'SCANNING',
  compute: { type: 'instances', architecture: 'x86_64' },
};

const scannedRevision = {
  environmentId: 'x86-build',
  revisionId: 'r-1',
  status: 'SCANNING',
  runtimeCompatibilityVersion: '1',
  imageUri: 'uri',
  imageDigest: `sha256:${'c'.repeat(64)}`,
};

const storeStub = () => ({
  updateRevision: vi.fn().mockImplementation(async (_e, _r, patch) => ({
    ...scannedRevision,
    ...patch,
  })),
  updateEnvironment: vi.fn().mockResolvedValue(instancesEnvironment),
  getRevision: vi.fn().mockResolvedValue(scannedRevision),
});

describe('createRuntimeForRevision on the Instances compute type', () => {
  it('waits for the capacity provider before creating the runtime', async () => {
    const result = await withEnv(() => {
      const controlClient = {
        send: vi.fn().mockResolvedValue({
          capacityProviders: [{ name: capacityProviderName('x86_64'), status: 'CREATING' }],
        }),
      };
      return createRuntimeForRevision({
        store: storeStub(),
        environment: instancesEnvironment,
        revision: scannedRevision,
        controlClient,
      }).then((outcome) => ({ outcome, controlClient }));
    });
    expect(result.outcome.pending).toBe(true);
    // Only the capacity provider lookup ran — no CreateAgentRuntime call.
    expect(result.controlClient.send).toHaveBeenCalledTimes(1);
  });

  it('creates the runtime from the capacity provider without networkConfiguration', async () => {
    const store = storeStub();
    const { result, controlClient } = await withEnv(async () => {
      const client = {
        send: vi
          .fn()
          .mockResolvedValueOnce({
            capacityProviders: [
              {
                name: capacityProviderName('x86_64'),
                status: 'READY',
                capacityProviderArn: 'arn:cp',
              },
            ],
          })
          .mockResolvedValueOnce({
            agentRuntimeArn: 'arn:runtime',
            agentRuntimeId: 'rt-1',
            agentRuntimeVersion: '1',
          }),
      };
      const outcome = await createRuntimeForRevision({
        store,
        environment: instancesEnvironment,
        revision: scannedRevision,
        controlClient: client,
      });
      return { result: outcome, controlClient: client };
    });
    expect(result.revision.status).toBe('VERIFYING');

    const createInput = controlClient.send.mock.calls[1][0].input;
    expect(createInput.capacityProviderConfiguration).toEqual({
      capacityProviderArn: 'arn:cp',
    });
    // Instances runtimes inherit networking from the capacity provider.
    expect(createInput.networkConfiguration).toBeUndefined();
    expect(createInput.filesystemConfigurations).toEqual([
      { capacityProviderVolume: { volumeName: 'workspace', mountPath: '/mnt/workspace' } },
    ]);
    // The capacity provider is retained on the revision for session cleanup.
    expect(store.updateRevision.mock.calls[0][2].capacityProviderArn).toBe('arn:cp');
  });

  it('keeps the microVMs path unchanged for default environments', async () => {
    const controlClient = {
      send: vi.fn().mockResolvedValueOnce({
        agentRuntimeArn: 'arn:runtime',
        agentRuntimeId: 'rt-1',
        agentRuntimeVersion: '1',
      }),
    };
    const store = storeStub();
    const result = await withEnv(() =>
      createRuntimeForRevision({
        store,
        environment: { environmentId: 'plain', status: 'SCANNING' },
        revision: scannedRevision,
        controlClient,
      }),
    );
    expect(result.revision.status).toBe('VERIFYING');

    const createInput = controlClient.send.mock.calls[0][0].input;
    expect(createInput.capacityProviderConfiguration).toBeUndefined();
    expect(createInput.networkConfiguration).toBeDefined();
    expect(createInput.filesystemConfigurations).toEqual([
      { sessionStorage: { mountPath: '/mnt/workspace' } },
    ]);
  });
});

const verifyingRevision = {
  environmentId: 'x86-build',
  revisionId: 'r-1',
  status: 'VERIFYING',
  runtimeCompatibilityVersion: '1',
  imageUri: 'uri',
  imageDigest: `sha256:${'c'.repeat(64)}`,
  runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:111111111111:runtime/x86',
  runtimeId: 'runtime-1',
  runtimeVersion: '1',
  runtimeEndpoint: 'revision_r_1',
  runtimeEndpointArn: 'arn:aws:bedrock-agentcore:us-east-1:111111111111:runtime-endpoint/x86',
  capacityProviderArn: 'arn:aws:bedrock-agentcore:us-east-1:111111111111:capacity-provider/cp-1',
};

const mutableStore = (initialRevision) => {
  let current = initialRevision;
  return {
    get current() {
      return current;
    },
    getRevision: vi.fn().mockImplementation(async () => current),
    updateRevision: vi.fn().mockImplementation(async (_e, _r, patch) => {
      current = { ...current, ...patch };
      return current;
    }),
    updateEnvironment: vi.fn().mockResolvedValue(instancesEnvironment),
    putSessionCleanup: vi.fn().mockResolvedValue({}),
  };
};

const validationOk = () => [
  {
    response: {
      transformToString: async () => JSON.stringify({ ok: true, clis: ['claude'] }),
    },
  },
  {
    response: {
      transformToString: async () =>
        JSON.stringify({
          ok: true,
          nonce: 'check-r-1',
          compatibilityVersion: '1',
          nonRoot: true,
          workspaceWritable: true,
          protectedRuntime: true,
        }),
    },
  },
];

const transientError = () => Object.assign(new Error('socket timed out'), { name: 'TimeoutError' });

describe('verifyRuntime validation session reuse on the Instances compute type', () => {
  it('reuses the same validation session across polls during a cold start', async () => {
    const store = mutableStore({ ...verifyingRevision });
    const controlClient = { send: vi.fn().mockResolvedValue({ status: 'READY' }) };

    // Poll 1: the first invocation is still provisioning the EC2 instance.
    const failingRuntime = { send: vi.fn().mockRejectedValue(transientError()) };
    const first = await withEnv(() =>
      verifyRuntime({
        store,
        environment: instancesEnvironment,
        revision: store.current,
        controlClient,
        runtimeClient: failingRuntime,
      }),
    );
    expect(first.pending).toBe(true);
    // The provisioning session was NOT stopped — the only runtime call is the invoke.
    expect(failingRuntime.send).toHaveBeenCalledTimes(1);
    expect(failingRuntime.send.mock.calls[0][0].constructor.name).toBe('InvokeAgentRuntimeCommand');
    const sessionId = failingRuntime.send.mock.calls[0][0].input.runtimeSessionId;
    expect(store.current.validationSessionId).toBe(sessionId);
    expect(store.current.validationAttempts).toBe(1);

    // Poll 2: the instance is up — the SAME session completes validation.
    const [capabilities, deterministic] = validationOk();
    const healthyRuntime = {
      send: vi
        .fn()
        .mockResolvedValueOnce(capabilities)
        .mockResolvedValueOnce(deterministic)
        .mockResolvedValueOnce({}),
    };
    const second = await withEnv(() =>
      verifyRuntime({
        store,
        environment: instancesEnvironment,
        revision: store.current,
        controlClient,
        runtimeClient: healthyRuntime,
      }),
    );
    expect(second.revision.status).toBe('READY');
    expect(healthyRuntime.send.mock.calls[0][0].input.runtimeSessionId).toBe(sessionId);
    expect(healthyRuntime.send.mock.calls[2][0].constructor.name).toBe('StopRuntimeSessionCommand');
    expect(healthyRuntime.send.mock.calls[2][0].input.runtimeSessionId).toBe(sessionId);
    // Disposable validation session: deleted on the terminal outcome so its
    // EBS volume is released.
    expect(healthyRuntime.send.mock.calls[3][0].constructor.name).toBe(
      'DeleteCapacityProviderSessionCommand',
    );
    expect(healthyRuntime.send.mock.calls[3][0].input).toEqual({
      capacityProviderId: 'cp-1',
      sessionId,
    });
    expect(store.current.validationSessionId).toBeNull();
  });

  it('fails the revision and stops the session when the retry budget is exhausted', async () => {
    const store = mutableStore({
      ...verifyingRevision,
      validationSessionId: 'managed-environment-r-1-persisted-session',
      validationAttempts: 30,
    });
    const controlClient = { send: vi.fn().mockResolvedValue({ status: 'READY' }) };
    const runtimeClient = {
      send: vi.fn().mockImplementation(async (command) => {
        if (command.constructor.name === 'StopRuntimeSessionCommand') return {};
        throw transientError();
      }),
    };
    const result = await withEnv(() =>
      verifyRuntime({
        store,
        environment: instancesEnvironment,
        revision: store.current,
        controlClient,
        runtimeClient,
      }),
    );
    expect(result.revision.status).toBe('FAILED');
    expect(result.revision.failure.reason).toBe('runtime_validation_failed');
    expect(result.revision.failure.detail).toContain('did not complete within');
    const stop = runtimeClient.send.mock.calls.find(
      (call) => call[0].constructor.name === 'StopRuntimeSessionCommand',
    );
    expect(stop[0].input.runtimeSessionId).toBe('managed-environment-r-1-persisted-session');
    const deletion = runtimeClient.send.mock.calls.find(
      (call) => call[0].constructor.name === 'DeleteCapacityProviderSessionCommand',
    );
    expect(deletion[0].input.sessionId).toBe('managed-environment-r-1-persisted-session');
    expect(store.current.validationSessionId).toBeNull();
  });

  it('keeps stopping the per-poll session for microVM environments (unchanged behavior)', async () => {
    const store = mutableStore({ ...verifyingRevision, environmentId: 'plain' });
    const controlClient = { send: vi.fn().mockResolvedValue({ status: 'READY' }) };
    const runtimeClient = {
      send: vi.fn().mockImplementation(async (command) => {
        if (command.constructor.name === 'StopRuntimeSessionCommand') return {};
        throw transientError();
      }),
    };
    const result = await withEnv(() =>
      verifyRuntime({
        store,
        environment: { environmentId: 'plain', status: 'VERIFYING' },
        revision: store.current,
        controlClient,
        runtimeClient,
      }),
    );
    // TimeoutError is not retryable on microVMs — permanent failure, session stopped.
    expect(result.revision.status).toBe('FAILED');
    const stop = runtimeClient.send.mock.calls.find(
      (call) => call[0].constructor.name === 'StopRuntimeSessionCommand',
    );
    expect(stop).toBeDefined();
    expect(store.current.validationSessionId).toBeNull();
  });
});

const deleteFailure = () =>
  Object.assign(new Error('internal error'), { name: 'InternalServerException' });

describe('validation-session cleanup retention and retry', () => {
  const runtimeFailingDeletes = (validationCalls) => {
    let call = 0;
    return {
      send: vi.fn().mockImplementation(async (command) => {
        if (command.constructor.name === 'DeleteCapacityProviderSessionCommand') {
          throw deleteFailure();
        }
        if (command.constructor.name === 'StopRuntimeSessionCommand') return {};
        if (command.constructor.name === 'InvokeAgentRuntimeCommand') {
          const behavior = validationCalls[call];
          call += 1;
          if (behavior instanceof Error) throw behavior;
          return behavior;
        }
        return {};
      }),
    };
  };

  it('persists cleanup work when the delete fails after SUCCESSFUL validation (READY)', async () => {
    const store = mutableStore({ ...verifyingRevision });
    const controlClient = { send: vi.fn().mockResolvedValue({ status: 'READY' }) };
    const runtimeClient = runtimeFailingDeletes(validationOk());

    const result = await withEnv(() =>
      verifyRuntime({
        store,
        environment: instancesEnvironment,
        revision: store.current,
        controlClient,
        runtimeClient,
      }),
    );
    // The revision still reaches READY — cleanup is retried out of band.
    expect(result.revision.status).toBe('READY');
    expect(store.current.validationSessionId).toBeNull();
    // …but the provider/session identity survived as durable cleanup work.
    const sessionId = runtimeClient.send.mock.calls.find(
      (call) => call[0].constructor.name === 'InvokeAgentRuntimeCommand',
    )[0].input.runtimeSessionId;
    expect(store.putSessionCleanup).toHaveBeenCalledWith({
      sessionId,
      capacityProviderArn: verifyingRevision.capacityProviderArn,
      environmentId: instancesEnvironment.environmentId,
      revisionId: verifyingRevision.revisionId,
      reason: 'internal error',
    });
  });

  it('persists cleanup work when the delete fails after FAILED validation', async () => {
    const store = mutableStore({
      ...verifyingRevision,
      validationSessionId: 'managed-environment-r-1-persisted-session',
      validationAttempts: 30,
    });
    const controlClient = { send: vi.fn().mockResolvedValue({ status: 'READY' }) };
    const runtimeClient = runtimeFailingDeletes([transientError()]);

    const result = await withEnv(() =>
      verifyRuntime({
        store,
        environment: instancesEnvironment,
        revision: store.current,
        controlClient,
        runtimeClient,
      }),
    );
    expect(result.revision.status).toBe('FAILED');
    expect(store.putSessionCleanup).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'managed-environment-r-1-persisted-session',
        capacityProviderArn: verifyingRevision.capacityProviderArn,
      }),
    );
  });

  it('does not persist cleanup work when the session is already absent', async () => {
    const store = mutableStore({ ...verifyingRevision });
    const controlClient = { send: vi.fn().mockResolvedValue({ status: 'READY' }) };
    const [capabilities, deterministic] = validationOk();
    const runtimeClient = {
      send: vi.fn().mockImplementation(async (command) => {
        if (command.constructor.name === 'DeleteCapacityProviderSessionCommand') {
          throw Object.assign(new Error('no such session'), {
            name: 'ResourceNotFoundException',
          });
        }
        if (command.constructor.name === 'InvokeAgentRuntimeCommand') {
          return runtimeClient.send.mock.calls.filter(
            (call) => call[0].constructor.name === 'InvokeAgentRuntimeCommand',
          ).length <= 1
            ? capabilities
            : deterministic;
        }
        return {};
      }),
    };
    const result = await withEnv(() =>
      verifyRuntime({
        store,
        environment: instancesEnvironment,
        revision: store.current,
        controlClient,
        runtimeClient,
      }),
    );
    expect(result.revision.status).toBe('READY');
    expect(store.putSessionCleanup).not.toHaveBeenCalled();
  });

  it('poller retries the SAME session id and clears the record only after success', async () => {
    const record = {
      sessionId: 'managed-environment-r-1-persisted-session',
      capacityProviderArn: verifyingRevision.capacityProviderArn,
      environmentId: 'x86-build',
      revisionId: 'r-1',
      attempts: 0,
    };
    const store = {
      listSessionCleanups: vi.fn().mockResolvedValue([record]),
      deleteSessionCleanup: vi.fn().mockResolvedValue(undefined),
      recordSessionCleanupAttempt: vi.fn().mockResolvedValue({ ...record, attempts: 1 }),
    };

    // First retry still fails — the record survives, attempts are bumped.
    const failing = { send: vi.fn().mockRejectedValue(deleteFailure()) };
    const firstPass = await retrySessionCleanups({ store, runtimeClient: failing });
    expect(firstPass).toEqual([{ sessionId: record.sessionId, cleaned: false }]);
    expect(store.deleteSessionCleanup).not.toHaveBeenCalled();
    expect(store.recordSessionCleanupAttempt).toHaveBeenCalledWith(
      record.sessionId,
      'internal error',
    );

    // A later poll succeeds — SAME session id, record cleared only now.
    const healthy = { send: vi.fn().mockResolvedValue({}) };
    const secondPass = await retrySessionCleanups({ store, runtimeClient: healthy });
    expect(secondPass).toEqual([{ sessionId: record.sessionId, cleaned: true }]);
    expect(healthy.send.mock.calls[0][0].constructor.name).toBe(
      'DeleteCapacityProviderSessionCommand',
    );
    expect(healthy.send.mock.calls[0][0].input).toEqual({
      capacityProviderId: 'cp-1',
      sessionId: record.sessionId,
    });
    expect(store.deleteSessionCleanup).toHaveBeenCalledWith(record.sessionId);
  });

  it('poller clears the record when the session is confirmed absent', async () => {
    const record = {
      sessionId: 'managed-environment-r-1-persisted-session',
      capacityProviderArn: verifyingRevision.capacityProviderArn,
      attempts: 3,
    };
    const store = {
      listSessionCleanups: vi.fn().mockResolvedValue([record]),
      deleteSessionCleanup: vi.fn().mockResolvedValue(undefined),
      recordSessionCleanupAttempt: vi.fn(),
    };
    const runtimeClient = {
      send: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('gone'), { name: 'ResourceNotFoundException' })),
    };
    const results = await retrySessionCleanups({ store, runtimeClient });
    expect(results).toEqual([{ sessionId: record.sessionId, cleaned: true, absent: true }]);
    expect(store.deleteSessionCleanup).toHaveBeenCalledWith(record.sessionId);
    expect(store.recordSessionCleanupAttempt).not.toHaveBeenCalled();
  });
});
