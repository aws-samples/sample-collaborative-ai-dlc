import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNativeRuntimeProvisioner } from '../provisioner.js';
import { createNativeRuntimeWorker, nativeDiagnosticDdb } from '../worker.js';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { fileSystemPolicy } from '../policies.js';
import { createHash } from 'node:crypto';
import {
  DEPLOYMENT,
  IDENTITY,
  IMAGE,
  createInput,
  setup,
  resources,
  awsError,
} from './fixtures.js';

const deployment = {
  ...DEPLOYMENT,
  imageUri: IMAGE.uri,
  imageDigest: IMAGE.digest,
  ecrRepositoryArn: 'arn:aws:ecr:us-east-1:123456789012:repository/agentcore',
  permissionsBoundaryArn: 'arn:aws:iam::123456789012:policy/native-boundary',
  subnetIds: ['subnet-12345678'],
  securityGroupIds: ['sg-12345678'],
};

const roleValidationError = (roleArn) =>
  Object.assign(
    new Error(
      `Role validation failed for '${roleArn}'. Please verify that the role exists and its trust policy allows assumption by this service`,
    ),
    { name: 'ValidationException' },
  );

const fixture = async ({
  deployedImage,
  rowImage = IMAGE,
  logger = { info: vi.fn() },
  leaseMs = 120000,
} = {}) => {
  let time = 1000;
  const f = setup({ leaseMs, now: () => time });
  await f.store.create(createInput({ image: rowImage }));
  await f.store.prepare(IDENTITY);
  const allocated = resources(f.read());
  const state = { ap: null, role: null, policy: null, runtime: null, endpoint: null };
  const hooks = {};
  const operation = (name, fn) =>
    vi.fn(async (input, options) => {
      options?.abortSignal?.throwIfAborted();
      const result = await fn(input);
      await hooks[name]?.(input, result, options);
      options?.abortSignal?.throwIfAborted();
      return structuredClone(result);
    });
  const services = {
    efs: {
      describeFileSystems: operation('fs', () => ({
        FileSystems: [
          {
            FileSystemId: DEPLOYMENT.fileSystemId,
            OwnerId: DEPLOYMENT.accountId,
            Encrypted: true,
            LifeCycleState: 'available',
          },
        ],
      })),
      describeMountTargets: operation('mounts', () => ({
        MountTargets: [
          {
            FileSystemId: DEPLOYMENT.fileSystemId,
            OwnerId: DEPLOYMENT.accountId,
            SubnetId: deployment.subnetIds[0],
            LifeCycleState: 'available',
          },
        ],
      })),
      describeFileSystemPolicy: operation('fsPolicy', () => ({
        FileSystemId: DEPLOYMENT.fileSystemId,
        Policy: JSON.stringify(fileSystemPolicy(deployment)),
      })),
      createAccessPoint: operation('createAp', (input) => {
        if (state.ap)
          throw Object.assign(awsError('AccessPointAlreadyExists'), {
            AccessPointId: state.ap.AccessPointId,
          });
        state.ap = {
          ...input,
          AccessPointId: allocated.accessPointArn.split('/').at(-1),
          AccessPointArn: allocated.accessPointArn,
          OwnerId: DEPLOYMENT.accountId,
          LifeCycleState: 'available',
        };
        return state.ap;
      }),
      describeAccessPoints: operation('ap', () => ({ AccessPoints: [state.ap] })),
    },
    iam: {
      getRole: operation('role', () => {
        if (!state.role) throw awsError('NoSuchEntityException');
        return { Role: state.role };
      }),
      createRole: operation('createRole', (input) => {
        if (state.role) throw awsError('EntityAlreadyExists');
        state.role = {
          ...input,
          Arn: allocated.executionRoleArn,
          CreateDate: new Date(time),
          PermissionsBoundary: {
            PermissionsBoundaryArn: input.PermissionsBoundary,
            // IAM GetRole returns "Policy"; the SDK enum declares a different label.
            PermissionsBoundaryType: 'Policy',
          },
        };
        return { Role: state.role };
      }),
      listAttachedRolePolicies: operation('attached', () => ({ AttachedPolicies: [] })),
      listRolePolicies: operation('inline', () => ({
        PolicyNames: state.policy ? ['native-runtime'] : [],
      })),
      putRolePolicy: operation('putPolicy', (input) => {
        state.policy = input;
        return {};
      }),
      getRolePolicy: operation('policy', () => state.policy),
    },
    control: {
      createAgentRuntime: operation('createRuntime', (input) => {
        state.runtime ??= {
          ...input,
          agentRuntimeArn: allocated.runtimeArn,
          agentRuntimeId: allocated.runtimeId,
          agentRuntimeVersion: '1',
          status: 'READY',
        };
        return state.runtime;
      }),
      getAgentRuntime: operation('runtime', () => state.runtime),
      createAgentRuntimeEndpoint: operation('createEndpoint', (input) => {
        state.endpoint = {
          ...input,
          agentRuntimeArn: allocated.runtimeArn,
          agentRuntimeEndpointArn: allocated.runtimeEndpointArn,
          liveVersion: '1',
          status: 'READY',
        };
        return state.endpoint;
      }),
      getAgentRuntimeEndpoint: operation('endpoint', () => {
        if (!state.endpoint) throw awsError('ResourceNotFoundException');
        return state.endpoint;
      }),
    },
    runtime: {
      invokeAgentRuntime: operation('invoke', (input) => {
        const { command, ...identity } = JSON.parse(Buffer.from(input.payload).toString());
        const content = Buffer.from(`${JSON.stringify({ format: 1, ...identity })}\n`);
        return {
          statusCode: 200,
          contentType: 'application/json',
          response: Buffer.from(
            JSON.stringify({
              ok: true,
              command,
              ...identity,
              evidence: {
                mountPath: '/mnt/native',
                filesystemType: 'nfs4',
                uid: 1000,
                gid: 1000,
                bytes: content.length,
                sha256: createHash('sha256').update(content).digest('hex'),
                hardlinkSameInode: true,
                linkCount: 2,
                atomicRename: true,
                cleanupComplete: true,
              },
            }),
          ),
        };
      }),
      stopRuntimeSession: operation('stop', () => ({ statusCode: 200 })),
    },
  };
  const reconcile = createNativeRuntimeProvisioner({
    store: f.store,
    services,
    deployment: {
      ...deployment,
      ...(deployedImage ? { imageUri: deployedImage.uri, imageDigest: deployedImage.digest } : {}),
    },
    now: () => time,
    logger,
  });
  return {
    ...f,
    state,
    storageHooks: f.hooks,
    hooks,
    services,
    reconcile,
    logger,
    now: () => time,
    retry: (elapsedMs = 121000) => {
      time += elapsedMs;
    },
  };
};

describe('first workspace invocation budget', () => {
  afterEach(() => vi.restoreAllMocks());

  const controlledDeadlines = (f) => {
    const pending = [];
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      const controller = new AbortController();
      pending.push({ controller, deadline: f.now() + ms });
      return controller.signal;
    });
    return (elapsed) => {
      f.retry(elapsed);
      for (const { controller, deadline } of pending) {
        if (deadline <= f.now()) controller.abort(new DOMException('Deadline', 'TimeoutError'));
      }
    };
  };

  it('accepts the measured 52-second first invocation and still stops and verifies within the Lambda budget', async () => {
    const f = await fixture();
    const start = f.now();
    const advance = controlledDeadlines(f);
    f.hooks.invoke = () => advance(52000);
    f.hooks.stop = () => advance(2000);
    expect(await f.reconcile(IDENTITY, { remainingMs: () => 90000 - (f.now() - start) })).toEqual({
      status: 'READY',
    });
    expect(f.services.runtime.invokeAgentRuntime).toHaveBeenCalledTimes(1);
    expect(f.services.runtime.stopRuntimeSession).toHaveBeenCalledTimes(1);
    expect(f.now() - start).toBe(54000);
    expect(f.read()).not.toHaveProperty('leaseToken');
  });

  it('retains the conservative retry and stops after the extended deadline is exceeded', async () => {
    const f = await fixture();
    const start = f.now();
    const advance = controlledDeadlines(f);
    f.hooks.invoke = () => advance(80001);
    f.hooks.stop = () => advance(2000);
    expect(await f.reconcile(IDENTITY, { remainingMs: () => 90000 - (f.now() - start) })).toEqual({
      status: 'pending',
    });
    expect(f.services.runtime.stopRuntimeSession).toHaveBeenCalledTimes(1);
    expect(f.read().status).toBe('PREPARING');
    expect(f.read().leaseToken).toBeDefined();
    expect(f.read().leaseExpiresAt).toBeGreaterThan(f.now());
    expect(f.now() - start).toBe(82001);
  });

  it('still reserves cleanup time if an older 30-second worker is running during deployment', async () => {
    const f = await fixture();
    const start = f.now();
    const advance = controlledDeadlines(f);
    f.hooks.invoke = () => advance(22001);
    f.hooks.stop = () => advance(2000);
    expect(await f.reconcile(IDENTITY, { remainingMs: () => 30000 - (f.now() - start) })).toEqual({
      status: 'pending',
    });
    expect(f.services.runtime.stopRuntimeSession).toHaveBeenCalledTimes(1);
    expect(f.read().leaseToken).toBeDefined();
    expect(f.now() - start).toBe(24001);
  });

  it('shortens the invocation deadline when prior checks have consumed Lambda time', async () => {
    const f = await fixture();
    const start = f.now();
    const advance = controlledDeadlines(f);
    let firstRead = true;
    f.hooks.fs = () => {
      if (firstRead) {
        firstRead = false;
        advance(7000);
      }
    };
    // Only 15 seconds remain for invocation after reserving 8 for cleanup.
    f.hooks.invoke = () => advance(15001);
    f.hooks.stop = () => advance(2000);
    expect(await f.reconcile(IDENTITY, { remainingMs: () => 30000 - (f.now() - start) })).toEqual({
      status: 'pending',
    });
    expect(f.services.runtime.stopRuntimeSession).toHaveBeenCalledTimes(1);
    expect(f.now() - start).toBe(24001);
    expect(f.read().leaseToken).toBeDefined();
  });

  it('does not start a session when there is insufficient time left for cleanup', async () => {
    const f = await fixture();
    let remaining = 30000;
    f.hooks.endpoint = () => {
      remaining = 8500;
    };
    expect(await f.reconcile(IDENTITY, { remainingMs: () => remaining })).toEqual({
      status: 'pending',
    });
    expect(f.services.runtime.invokeAgentRuntime).not.toHaveBeenCalled();
    expect(f.services.runtime.stopRuntimeSession).not.toHaveBeenCalled();
    expect(f.read().leaseToken).toBeDefined();
  });

  it('reserves cleanup time under a shorter ownership lease as well as the Lambda deadline', async () => {
    const f = await fixture({ leaseMs: 15000 });
    const start = f.now();
    const advance = controlledDeadlines(f);
    f.hooks.invoke = () => advance(7001);
    f.hooks.stop = () => advance(2000);
    expect(await f.reconcile(IDENTITY, { remainingMs: () => 30000 - (f.now() - start) })).toEqual({
      status: 'pending',
    });
    expect(f.services.runtime.stopRuntimeSession).toHaveBeenCalledTimes(1);
    expect(f.read().leaseExpiresAt).toBeGreaterThan(f.now());
  });
});

describe('cooperative readiness retries', () => {
  it('progresses through all four AWS waits without expiring a 120-second lease', async () => {
    const f = await fixture();
    const initial = f.read();
    f.hooks.createAp = (_input, ap) => {
      ap.LifeCycleState = 'creating';
    };
    f.services.control.createAgentRuntime.mockRejectedValueOnce(
      roleValidationError(resources(initial).executionRoleArn),
    );
    f.hooks.createRuntime = (_input, runtime) => {
      runtime.status = 'CREATING';
    };
    f.hooks.createEndpoint = (_input, endpoint) => {
      endpoint.status = 'CREATING';
    };
    const phases = ['access_point', 'iam_propagation', 'runtime', 'endpoint'];
    for (const [index, phase] of phases.entries()) {
      expect(await f.reconcile(IDENTITY)).toEqual({ status: 'waiting', phase });
      const row = f.read();
      expect(row).toMatchObject({
        status: 'PREPARING',
        bindingId: initial.bindingId,
        fence: index + 1,
      });
      expect(row).not.toHaveProperty('leaseToken');
      expect(row).not.toHaveProperty('leaseExpiresAt');
      expect(f.services.runtime.invokeAgentRuntime).not.toHaveBeenCalled();
      f.retry([5000, 10000, 20000, 30000][index]);
      if (phase === 'access_point') f.state.ap.LifeCycleState = 'available';
      if (phase === 'runtime') f.state.runtime.status = 'READY';
      if (phase === 'endpoint') f.state.endpoint.status = 'READY';
    }
    expect(await f.reconcile(IDENTITY)).toEqual({ status: 'READY' });
    expect(f.now()).toBe(66000);
    expect(f.read()).toMatchObject({ bindingId: initial.bindingId, fence: 5 });
    expect(f.services.efs.createAccessPoint).toHaveBeenCalledTimes(1);
    expect(f.services.iam.createRole).toHaveBeenCalledTimes(1);
    expect(f.services.control.createAgentRuntime).toHaveBeenCalledTimes(2);
    expect(f.services.control.createAgentRuntimeEndpoint).toHaveBeenCalledTimes(1);
    expect(f.services.runtime.invokeAgentRuntime).toHaveBeenCalledTimes(1);
    expect(f.services.runtime.stopRuntimeSession).toHaveBeenCalledTimes(1);
    const waits = f.logger.info.mock.calls
      .map(([text]) => JSON.parse(text))
      .filter((record) => record.status === 'waiting');
    expect(waits.map((record) => record.phase)).toEqual(phases);
  });

  it('requires a confirmed lease release before returning a fast retry result', async () => {
    const f = await fixture();
    f.hooks.createAp = (_input, ap) => {
      ap.LifeCycleState = 'creating';
    };
    f.storageHooks.before = (command) => {
      if (
        command instanceof PutCommand &&
        command.input.Item.status === 'PREPARING' &&
        command.input.Item.fence > 0 &&
        !command.input.Item.leaseToken
      )
        throw awsError('ServiceUnavailableException');
    };
    expect(await f.reconcile(IDENTITY)).toEqual({ status: 'pending' });
    expect(f.read().leaseToken).toBeDefined();
    expect(f.read().accessPointArn).toBeDefined();
    expect(f.services.iam.createRole).not.toHaveBeenCalled();
    // An immediate duplicate cannot bypass the retained lease.
    expect(await f.reconcile(IDENTITY)).toEqual({ status: 'pending' });
    expect(f.services.efs.describeAccessPoints).toHaveBeenCalledTimes(1);
  });

  it('does not release another owner after a delayed readiness response', async () => {
    const f = await fixture();
    let replacement;
    f.hooks.ap = (_input, response) => {
      response.AccessPoints[0].LifeCycleState = 'creating';
      replacement = {
        ...f.read(),
        version: f.read().version + 1,
        fence: f.read().fence + 1,
        leaseToken: '60000000-0000-4000-8000-000000000001',
      };
      f.write(replacement);
    };
    expect(await f.reconcile(IDENTITY)).toEqual({ status: 'pending' });
    expect(f.read()).toEqual(replacement);
    expect(f.services.iam.createRole).not.toHaveBeenCalled();
  });

  it.each(['invoke_timeout', 'stop_timeout', 'stop_not_confirmed', 'readiness_after_invoke'])(
    'retains conservative ownership when a diagnostic has started: %s',
    async (failure) => {
      const f = await fixture();
      if (failure === 'invoke_timeout')
        f.services.runtime.invokeAgentRuntime.mockRejectedValue(awsError('TimeoutError'));
      if (failure === 'stop_timeout')
        f.services.runtime.stopRuntimeSession.mockRejectedValue(awsError('TimeoutError'));
      if (failure === 'stop_not_confirmed')
        f.services.runtime.stopRuntimeSession.mockResolvedValue({ statusCode: 202 });
      if (failure === 'readiness_after_invoke')
        f.hooks.invoke = () => {
          f.state.endpoint.status = 'CREATING';
        };
      expect(await f.reconcile(IDENTITY)).toEqual({ status: 'pending' });
      const row = f.read();
      expect(row.leaseToken).toBeDefined();
      expect(f.services.runtime.stopRuntimeSession).toHaveBeenCalledTimes(1);
      expect(await f.reconcile(IDENTITY)).toEqual({ status: 'pending' });
      expect(f.read()).toEqual(row);
      expect(f.services.runtime.invokeAgentRuntime).toHaveBeenCalledTimes(1);
    },
  );

  it('retains conservative retries for unknown lifecycle states and ambiguous create errors', async () => {
    const f = await fixture();
    f.hooks.createAp = (_input, ap) => {
      ap.LifeCycleState = 'unknown';
    };
    expect(await f.reconcile(IDENTITY)).toEqual({ status: 'pending' });
    expect(f.read().leaseToken).toBeDefined();
    f.retry();
    f.state.ap.LifeCycleState = 'available';
    f.services.control.createAgentRuntime.mockRejectedValue(awsError('TimeoutError'));
    expect(await f.reconcile(IDENTITY)).toEqual({ status: 'pending' });
    expect(f.read().leaseToken).toBeDefined();
  });
});

describe('bounded AgentCore role propagation', () => {
  it('retries through SQS and reaches READY with the same AP, role and runtime client token', async () => {
    const f = await fixture();
    const roleArn = resources(f.read()).executionRoleArn;
    f.services.control.createAgentRuntime.mockRejectedValueOnce(roleValidationError(roleArn));
    const worker = createNativeRuntimeWorker({
      reconcile: f.reconcile,
      env: {
        NATIVE_PREPARATION_ENABLED: 'true',
        NATIVE_PREPARATION_PROJECT_IDS: JSON.stringify([IDENTITY.projectId]),
      },
    });
    const event = {
      Records: [
        { messageId: 'propagating-role', eventSource: 'aws:sqs', body: JSON.stringify(IDENTITY) },
      ],
    };

    expect(await worker(event)).toEqual({
      batchItemFailures: [{ itemIdentifier: 'propagating-role' }],
    });
    const pendingRow = f.read();
    const originalAp = structuredClone(f.state.ap);
    const originalRole = structuredClone(f.state.role);
    expect(pendingRow.status).toBe('PREPARING');
    expect(pendingRow.executionRoleArn).toBe(roleArn);
    expect(f.state.runtime).toBeNull();
    expect(f.services.control.createAgentRuntime).toHaveBeenCalledTimes(1);
    expect(f.services.runtime.invokeAgentRuntime).not.toHaveBeenCalled();

    expect(pendingRow).not.toHaveProperty('leaseToken');
    f.retry(5000);
    expect(await worker(event)).toEqual({ batchItemFailures: [] });
    expect(f.read()).toMatchObject({
      status: 'READY',
      bindingId: pendingRow.bindingId,
      accessPointArn: pendingRow.accessPointArn,
      executionRoleArn: pendingRow.executionRoleArn,
    });
    expect(f.state.ap).toEqual(originalAp);
    expect(f.state.role).toEqual(originalRole);
    expect(f.services.efs.createAccessPoint).toHaveBeenCalledTimes(1);
    expect(f.services.iam.createRole).toHaveBeenCalledTimes(1);
    expect(f.services.iam.putRolePolicy).toHaveBeenCalledTimes(1);
    expect(f.services.control.createAgentRuntime).toHaveBeenCalledTimes(2);
    const [first, second] = f.services.control.createAgentRuntime.mock.calls.map(
      ([input]) => input,
    );
    expect(first.clientToken).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toEqual(first);
    expect(f.services.runtime.invokeAgentRuntime).toHaveBeenCalledTimes(1);
    expect(f.services.runtime.stopRuntimeSession).toHaveBeenCalledTimes(1);
  });

  it('stops persistent propagation failures at ten minutes without resetting role age on retry', async () => {
    const f = await fixture();
    f.services.control.createAgentRuntime.mockRejectedValue(
      roleValidationError(resources(f.read()).executionRoleArn),
    );
    for (const roleAge of [0, 200000, 400000]) {
      expect(await f.reconcile(IDENTITY)).toEqual({
        status: 'waiting',
        phase: 'iam_propagation',
      });
      expect(f.read().status).toBe('PREPARING');
      expect(f.now() - f.state.role.CreateDate.getTime()).toBe(roleAge);
      // Role age advances independently of the cooperatively released lease.
      f.retry(200000);
    }
    expect(f.now() - f.state.role.CreateDate.getTime()).toBe(600000);
    expect(await f.reconcile(IDENTITY)).toEqual({
      status: 'FAILED',
      code: 'native_provisioning_failed',
    });
    expect(f.read().status).toBe('FAILED');
    expect(f.services.control.createAgentRuntime).toHaveBeenCalledTimes(4);
    expect(
      new Set(f.services.control.createAgentRuntime.mock.calls.map(([input]) => input.clientToken))
        .size,
    ).toBe(1);
    expect(f.services.efs.createAccessPoint).toHaveBeenCalledTimes(1);
    expect(f.services.iam.createRole).toHaveBeenCalledTimes(1);
    expect(f.services.iam.putRolePolicy).toHaveBeenCalledTimes(1);
    expect(f.services.runtime.invokeAgentRuntime).not.toHaveBeenCalled();
    f.retry(180000);
    expect(await f.reconcile(IDENTITY)).toEqual({ status: 'terminal' });
    expect(f.services.control.createAgentRuntime).toHaveBeenCalledTimes(4);
  });

  it.each([
    [599999, 'waiting'],
    [600000, 'FAILED'],
    [600001, 'FAILED'],
  ])('handles an IAM role age of %i ms as %s', async (roleAge, status) => {
    const f = await fixture();
    f.hooks.role = (_input, { Role }) => {
      Role.CreateDate = new Date(f.now() - roleAge);
    };
    f.services.control.createAgentRuntime.mockRejectedValue(
      roleValidationError(resources(f.read()).executionRoleArn),
    );
    expect(await f.reconcile(IDENTITY)).toEqual(
      status === 'waiting'
        ? { status, phase: 'iam_propagation' }
        : { status, code: 'native_provisioning_failed' },
    );
    expect(f.read().status).toBe(status === 'waiting' ? 'PREPARING' : 'FAILED');
    expect(f.services.control.createAgentRuntime).toHaveBeenCalledTimes(1);
    expect(f.services.runtime.invokeAgentRuntime).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', () => undefined],
    ['null', () => null],
    ['invalid Date', () => new Date(NaN)],
    ['serialized Date', (time) => new Date(time).toISOString()],
    ['numeric timestamp', (time) => time],
    ['future Date', (time) => new Date(time + 1)],
  ])('does not retry exact validation failure with a %s CreateDate', async (_label, date) => {
    const f = await fixture();
    f.hooks.role = (_input, { Role }) => {
      const value = date(f.now());
      if (value === undefined) delete Role.CreateDate;
      else Role.CreateDate = value;
    };
    f.services.control.createAgentRuntime.mockRejectedValue(
      roleValidationError(resources(f.read()).executionRoleArn),
    );
    expect(await f.reconcile(IDENTITY)).toEqual({
      status: 'FAILED',
      code: 'native_provisioning_failed',
    });
    expect(f.read().status).toBe('FAILED');
    expect(f.services.control.createAgentRuntime).toHaveBeenCalledTimes(1);
    expect(f.services.runtime.invokeAgentRuntime).not.toHaveBeenCalled();
  });

  it.each([
    [
      'another role ARN',
      (error, roleArn) => {
        error.message = roleValidationError(`${roleArn}-other`).message;
      },
    ],
    [
      'another message',
      (error) => {
        error.message = 'The runtime configuration is invalid';
      },
    ],
    [
      'a message prefix',
      (error) => {
        error.message = `Service error: ${error.message}`;
      },
    ],
    [
      'a message suffix',
      (error) => {
        error.message += '.';
      },
    ],
    [
      'another error name',
      (error) => {
        error.name = 'ValidationError';
      },
    ],
  ])('keeps %s terminal for a newly verified role', async (_label, mutate) => {
    const f = await fixture();
    const roleArn = resources(f.read()).executionRoleArn;
    const error = roleValidationError(roleArn);
    mutate(error, roleArn);
    f.services.control.createAgentRuntime.mockRejectedValue(error);
    expect(await f.reconcile(IDENTITY)).toEqual({
      status: 'FAILED',
      code: 'native_provisioning_failed',
    });
    expect(f.read().status).toBe('FAILED');
    expect(f.services.control.createAgentRuntime).toHaveBeenCalledTimes(1);
    expect(f.services.runtime.invokeAgentRuntime).not.toHaveBeenCalled();
  });

  it('keeps AccessDeniedException terminal even with the exact same-role message', async () => {
    const f = await fixture();
    const error = roleValidationError(resources(f.read()).executionRoleArn);
    error.name = 'AccessDeniedException';
    f.services.control.createAgentRuntime.mockRejectedValue(error);
    expect(await f.reconcile(IDENTITY)).toEqual({
      status: 'FAILED',
      code: 'native_provisioning_access_denied',
    });
    expect(f.read().status).toBe('FAILED');
  });

  it.each([
    ['control', 'getAgentRuntime'],
    ['runtime', 'invokeAgentRuntime'],
  ])('does not retry the exact role-validation message from %s.%s', async (service, method) => {
    const f = await fixture();
    f.services[service][method].mockRejectedValue(
      roleValidationError(resources(f.read()).executionRoleArn),
    );
    expect(await f.reconcile(IDENTITY)).toEqual({
      status: 'FAILED',
      code: 'native_provisioning_failed',
    });
    expect(f.read().status).toBe('FAILED');
    if (method === 'invokeAgentRuntime')
      expect(f.services.runtime.stopRuntimeSession).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    'rejects mismatched trust before runtime creation, after propagation retry: %s',
    async (afterRetry) => {
      const f = await fixture();
      f.services.control.createAgentRuntime.mockRejectedValue(
        roleValidationError(resources(f.read()).executionRoleArn),
      );
      if (afterRetry) {
        expect(await f.reconcile(IDENTITY)).toEqual({
          status: 'waiting',
          phase: 'iam_propagation',
        });
        f.retry(5000);
      }
      f.hooks.role = (_input, { Role }) => {
        const trust = JSON.parse(Role.AssumeRolePolicyDocument);
        trust.Statement[0].Condition.ArnLike['aws:SourceArn'] =
          'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/another-run-*';
        Role.AssumeRolePolicyDocument = JSON.stringify(trust);
      };
      expect(await f.reconcile(IDENTITY)).toEqual({
        status: 'FAILED',
        code: 'native_provisioning_resource_mismatch',
      });
      expect(f.read().status).toBe('FAILED');
      expect(f.services.control.createAgentRuntime).toHaveBeenCalledTimes(afterRetry ? 1 : 0);
      expect(f.services.iam.putRolePolicy).toHaveBeenCalledTimes(afterRetry ? 1 : 0);
      expect(f.services.runtime.invokeAgentRuntime).not.toHaveBeenCalled();
    },
  );
});

describe('native per-run reconciliation', () => {
  it.each(['Policy', 'PermissionsBoundaryPolicy'])(
    'accepts IAM permissions boundary type %s only with the configured boundary',
    async (type) => {
      const f = await fixture();
      f.hooks.role = (_input, response) => {
        response.Role.PermissionsBoundary.PermissionsBoundaryType = type;
      };
      expect(await f.reconcile(IDENTITY)).toEqual({ status: 'READY' });
      expect(f.services.runtime.invokeAgentRuntime).toHaveBeenCalledTimes(1);
    },
  );
  it.each([undefined, null, '', 'ManagedPolicy', 'policy'])(
    'rejects missing or unknown IAM permissions boundary type %s before policy installation',
    async (type) => {
      const f = await fixture();
      f.hooks.role = (_input, response) => {
        response.Role.PermissionsBoundary.PermissionsBoundaryType = type;
      };
      expect(await f.reconcile(IDENTITY)).toMatchObject({
        status: 'FAILED',
        code: 'native_provisioning_resource_mismatch',
      });
      expect(f.services.iam.putRolePolicy).not.toHaveBeenCalled();
      expect(f.services.control.createAgentRuntime).not.toHaveBeenCalled();
      expect(f.services.runtime.invokeAgentRuntime).not.toHaveBeenCalled();
    },
  );
  it.each(['Policy', 'PermissionsBoundaryPolicy'])(
    'rejects a different boundary ARN even with recognized type %s',
    async (type) => {
      const f = await fixture();
      f.hooks.role = (_input, response) => {
        response.Role.PermissionsBoundary = {
          PermissionsBoundaryType: type,
          PermissionsBoundaryArn: 'arn:aws:iam::123456789012:policy/other',
        };
      };
      expect(await f.reconcile(IDENTITY)).toMatchObject({
        status: 'FAILED',
        code: 'native_provisioning_resource_mismatch',
      });
      expect(f.services.iam.putRolePolicy).not.toHaveBeenCalled();
      expect(f.services.control.createAgentRuntime).not.toHaveBeenCalled();
      expect(f.services.runtime.invokeAgentRuntime).not.toHaveBeenCalled();
    },
  );
  it.each(['700', '0700'])(
    'accepts EFS mode %s as the same private POSIX permissions',
    async (mode) => {
      const f = await fixture();
      f.hooks.ap = (_input, response) => {
        response.AccessPoints[0].RootDirectory.CreationInfo.Permissions = mode;
      };
      expect(await f.reconcile(IDENTITY)).toEqual({ status: 'READY' });
    },
  );
  it.each(['777', '0707', '00700', 'garbage'])(
    'rejects broadened or invalid EFS permissions %s',
    async (mode) => {
      const f = await fixture();
      f.hooks.ap = (_input, response) => {
        response.AccessPoints[0].RootDirectory.CreationInfo.Permissions = mode;
      };
      expect(await f.reconcile(IDENTITY)).toMatchObject({ status: 'FAILED' });
      expect(f.services.runtime.invokeAgentRuntime).not.toHaveBeenCalled();
    },
  );
  it('waits for eventual role visibility without creating a runtime prematurely', async () => {
    const f = await fixture();
    f.hooks.role = () => {
      throw awsError('NoSuchEntityException');
    };
    expect(await f.reconcile(IDENTITY)).toEqual({ status: 'pending' });
    expect(f.services.control.createAgentRuntime).not.toHaveBeenCalled();
    delete f.hooks.role;
    f.retry();
    expect(await f.reconcile(IDENTITY)).toEqual({ status: 'READY' });
    expect(f.services.iam.createRole).toHaveBeenCalledTimes(1);
  });
  it('keeps the protected older image pin after a deployment changes the default', async () => {
    const f = await fixture({
      deployedImage: {
        uri: IMAGE.uri.replaceAll('a'.repeat(64), 'b'.repeat(64)),
        digest: `sha256:${'b'.repeat(64)}`,
      },
    });
    expect(await f.reconcile(IDENTITY)).toEqual({ status: 'READY' });
    expect(f.state.runtime.agentRuntimeArtifact.containerConfiguration.containerUri).toBe(
      IMAGE.uri,
    );
    expect(f.read().imageDigest).toBe(IMAGE.digest);
  });
  it('refuses a protected pin outside the deployment-owned repository', async () => {
    const f = await fixture({
      rowImage: { ...IMAGE, uri: IMAGE.uri.replace('/agentcore@', '/foreign@') },
    });
    expect(await f.reconcile(IDENTITY)).toMatchObject({
      status: 'FAILED',
      code: 'native_provisioning_source_changed',
    });
    expect(f.services.efs.createAccessPoint).not.toHaveBeenCalled();
  });
  it('publishes READY only after AWS tuple readback plus bound filesystem proof, stopping the diagnostic', async () => {
    const f = await fixture();
    expect(await f.reconcile(IDENTITY)).toEqual({ status: 'READY' });
    expect(f.read().status).toBe('READY');
    expect(f.services.runtime.invokeAgentRuntime).toHaveBeenCalledTimes(1);
    expect(f.services.runtime.stopRuntimeSession).toHaveBeenCalledTimes(1);
    const input = f.services.control.createAgentRuntime.mock.calls[0][0];
    expect(input.environmentVariables).toMatchObject({
      NATIVE_RUNTIME_MODE: 'isolated',
      NATIVE_RUNTIME_PROJECT_ID: IDENTITY.projectId,
    });
    expect(Object.keys(input.environmentVariables)).toHaveLength(5);
    expect(input.filesystemConfigurations).toEqual([
      { efsAccessPoint: { accessPointArn: f.read().accessPointArn, mountPath: '/mnt/native' } },
    ]);
    expect(input.agentRuntimeArtifact.containerConfiguration.containerUri).toBe(IMAGE.uri);
    expect(f.services.control.getAgentRuntime.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(await f.reconcile(IDENTITY)).toEqual({ status: 'terminal' });
    expect(f.services.runtime.invokeAgentRuntime).toHaveBeenCalledTimes(1);
  });
  it.each([
    [
      'ap',
      (_input, response) => {
        response.AccessPoints[0].RootDirectory.Path = '/runs/another-run';
      },
    ],
    [
      'ap',
      (_input, response) => {
        response.AccessPoints[0].FileSystemId = 'fs-aaaaaaaaaaaaaaaaa';
      },
    ],
    [
      'role',
      (_input, response) => {
        response.Role.PermissionsBoundary.PermissionsBoundaryArn =
          'arn:aws:iam::123456789012:policy/other';
      },
    ],
    [
      'attached',
      (_input, response) => {
        response.AttachedPolicies = [{ PolicyArn: 'arn:aws:iam::aws:policy/AdministratorAccess' }];
      },
    ],
    [
      'policy',
      (_input, response) => {
        response.PolicyDocument =
          '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"*","Resource":"*"}]}';
      },
    ],
    [
      'runtime',
      (_input, response) => {
        response.environmentVariables.AWS_ACCESS_KEY_ID = 'nonsecret-canary';
      },
    ],
    [
      'runtime',
      (_input, response) => {
        response.roleArn = 'arn:aws:iam::123456789012:role/native-runs/wrong-run';
      },
    ],
    [
      'runtime',
      (_input, response) => {
        response.agentRuntimeArtifact.containerConfiguration.containerUri = IMAGE.uri.replace(
          /a$/,
          'b',
        );
      },
    ],
    [
      'endpoint',
      (_input, response) => {
        response.liveVersion = '2';
      },
    ],
    [
      'endpoint',
      (_input, response) => {
        response.agentRuntimeArn += 'wrong-run';
      },
    ],
    [
      'fsPolicy',
      (_input, response) => {
        const policy = JSON.parse(response.Policy);
        policy.Statement.push({ Effect: 'Allow', Principal: '*', Action: '*', Resource: '*' });
        response.Policy = JSON.stringify(policy);
      },
    ],
  ])(
    'rejects borrowed or widened authority at %s before runtime invocation',
    async (hook, mutate) => {
      const f = await fixture();
      f.hooks[hook] = mutate;
      expect(await f.reconcile(IDENTITY)).toMatchObject({
        status: 'FAILED',
        code: 'native_provisioning_resource_mismatch',
      });
      expect(f.services.runtime.invokeAgentRuntime).not.toHaveBeenCalled();
      expect(f.read().status).toBe('FAILED');
      expect(f.state.ap || hook === 'fsPolicy').toBeTruthy();
    },
  );
  it('does not overwrite a mismatched preexisting inline policy', async () => {
    const f = await fixture();
    f.hooks.createRole = () => {
      throw awsError('ServiceUnavailableException');
    };
    expect(await f.reconcile(IDENTITY)).toEqual({ status: 'pending' });
    f.state.policy = {
      RoleName: f.state.role.RoleName,
      PolicyName: 'native-runtime',
      PolicyDocument: JSON.stringify({
        Version: '2012-10-17',
        Statement: [{ Effect: 'Allow', Action: '*', Resource: '*' }],
      }),
    };
    f.retry();
    expect(await f.reconcile(IDENTITY)).toMatchObject({ status: 'FAILED' });
    expect(f.services.iam.putRolePolicy).not.toHaveBeenCalled();
  });
  it.each(['createAp', 'createRole', 'createRuntime', 'createEndpoint'])(
    'recovers interrupted %s without allocating another scope',
    async (step) => {
      const f = await fixture();
      f.hooks[step] = () => {
        delete f.hooks[step];
        throw awsError('ServiceUnavailableException');
      };
      expect(await f.reconcile(IDENTITY)).toEqual({ status: 'pending' });
      f.retry();
      expect(await f.reconcile(IDENTITY)).toEqual({ status: 'READY' });
      expect(f.read().runtimeArn).toBe(f.state.runtime.agentRuntimeArn);
      expect(f.services.iam.createRole).toHaveBeenCalledTimes(1);
    },
  );
  it('releases ownership after verified asynchronous creation, with no poll loop', async () => {
    const f = await fixture();
    f.hooks.createAp = (_i, ap) => {
      ap.LifeCycleState = 'creating';
    };
    expect(await f.reconcile(IDENTITY)).toEqual({ status: 'waiting', phase: 'access_point' });
    expect(f.services.efs.describeAccessPoints).toHaveBeenCalledTimes(1);
    expect(f.services.iam.createRole).not.toHaveBeenCalled();
    expect(f.read().accessPointArn).toBe(f.state.ap.AccessPointArn);
    expect(f.read()).not.toHaveProperty('leaseToken');
  });
  it('loses authority immediately when another lease owner wins', async () => {
    const f = await fixture();
    f.hooks.createRole = () => {
      f.write({
        ...f.read(),
        version: f.read().version + 1,
        fence: f.read().fence + 1,
        leaseToken: '60000000-0000-4000-8000-000000000001',
      });
    };
    expect(await f.reconcile(IDENTITY)).toEqual({ status: 'pending' });
    expect(f.services.iam.putRolePolicy).not.toHaveBeenCalled();
    expect(f.services.runtime.invokeAgentRuntime).not.toHaveBeenCalled();
    expect(f.read().status).toBe('PREPARING');
  });
  it('requires readback bytes, identity and cleanup evidence despite an ok report', async () => {
    const f = await fixture();
    f.hooks.invoke = (_i, response) => {
      const proof = JSON.parse(Buffer.from(response.response).toString());
      proof.evidence.sha256 = 'a'.repeat(64);
      response.response = Buffer.from(JSON.stringify(proof));
    };
    expect(await f.reconcile(IDENTITY)).toMatchObject({
      status: 'FAILED',
      code: 'native_provisioning_verification_failed',
    });
    expect(f.services.runtime.stopRuntimeSession).toHaveBeenCalledTimes(1);
  });
  it('refuses oversized reports and still stops the synthetic session', async () => {
    const f = await fixture();
    f.hooks.invoke = (_i, response) => {
      response.response = Buffer.alloc(8193, 32);
    };
    expect(await f.reconcile(IDENTITY)).toMatchObject({ status: 'FAILED' });
    expect(f.services.runtime.stopRuntimeSession).toHaveBeenCalledTimes(1);
  });
  it('checks AWS authority again after proof and before READY', async () => {
    const f = await fixture();
    f.hooks.invoke = () => {
      f.state.endpoint.liveVersion = '2';
    };
    expect(await f.reconcile(IDENTITY)).toMatchObject({ status: 'FAILED' });
    expect(f.read().status).toBe('FAILED');
  });
  it('does not start a mutation when Lambda budget is exhausted', async () => {
    const f = await fixture();
    expect(await f.reconcile(IDENTITY, { remainingMs: () => 2000 })).toEqual({ status: 'pending' });
    expect(f.services.efs.createAccessPoint).not.toHaveBeenCalled();
  });
});

describe('bounded native provisioning diagnostics', () => {
  const requestId = '736b25e1-e38f-4ef5-9f57-dbe1868f271c';
  const sensitive = 'private-canary payload credentials policy and environment';
  const awsFailure = () =>
    Object.assign(new Error(sensitive), {
      name: 'AccessDeniedException',
      code: 'AccessDeniedException',
      $metadata: { httpStatusCode: 403, requestId, credentials: sensitive },
      payload: sensitive,
      policies: sensitive,
      env: sensitive,
    });
  const records = (logger) =>
    logger.info.mock.calls.map(([text]) => {
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(1024);
      expect(text).not.toContain(sensitive);
      expect(text).not.toContain(IDENTITY.projectId);
      expect(text).not.toContain(IDENTITY.executionId);
      return JSON.parse(text);
    });
  it('records the failing API and committed FAILED outcome, excluding raw sensitive properties', async () => {
    const f = await fixture();
    f.services.efs.describeFileSystems.mockRejectedValue(awsFailure());
    expect(await f.reconcile(IDENTITY)).toMatchObject({ status: 'FAILED' });
    const logged = records(f.logger);
    expect(logged).toHaveLength(2);
    expect(logged[0]).toEqual({
      event: 'native_runtime_service_failure',
      scopeHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      service: 'efs',
      operation: 'describeFileSystems',
      errorName: 'AccessDeniedException',
      errorCode: 'AccessDeniedException',
      httpStatus: 403,
      requestId,
    });
    expect(logged[1]).toMatchObject({
      event: 'native_runtime_reconciliation_outcome',
      status: 'FAILED',
      code: 'native_provisioning_access_denied',
      service: 'efs',
      operation: 'describeFileSystems',
    });
  });
  it('covers runtime invoke failures while preserving the cleanup call', async () => {
    const f = await fixture();
    f.services.runtime.invokeAgentRuntime.mockRejectedValue(awsFailure());
    expect(await f.reconcile(IDENTITY)).toMatchObject({ status: 'FAILED' });
    expect(records(f.logger)).toContainEqual(
      expect.objectContaining({
        event: 'native_runtime_service_failure',
        service: 'runtime',
        operation: 'invokeAgentRuntime',
        requestId,
        httpStatus: 403,
      }),
    );
    expect(f.services.runtime.stopRuntimeSession).toHaveBeenCalledTimes(1);
  });
  it('does not echo arbitrary error names, codes, request IDs or oversized metadata', async () => {
    const f = await fixture();
    f.services.efs.describeFileSystems.mockRejectedValue(
      Object.assign(new Error(sensitive), {
        name: sensitive.repeat(1000),
        code: sensitive,
        $metadata: { httpStatusCode: sensitive, requestId: sensitive },
      }),
    );
    expect(await f.reconcile(IDENTITY)).toMatchObject({ status: 'FAILED' });
    const logged = records(f.logger);
    expect(logged[0]).toMatchObject({ errorName: 'UnknownError', errorCode: 'UnknownErrorCode' });
    expect(logged[0]).not.toHaveProperty('httpStatus');
    expect(logged[0]).not.toHaveProperty('requestId');
  });
  it.each(['throw', 'reject'])(
    'does not change provisioning when the logger sink fails: %s',
    async (mode) => {
      const logger = {
        info: vi.fn(() => {
          if (mode === 'throw') throw new Error(sensitive);
          return Promise.reject(new Error(sensitive));
        }),
      };
      const f = await fixture({ logger });
      expect(await f.reconcile(IDENTITY)).toEqual({ status: 'READY' });
      await Promise.resolve();
      expect(f.read().status).toBe('READY');
    },
  );
  it('records READY only after the protected-store commit', async () => {
    const f = await fixture();
    f.logger.info.mockImplementation((text) => {
      if (JSON.parse(text).status === 'READY') expect(f.read().status).toBe('READY');
    });
    expect(await f.reconcile(IDENTITY)).toEqual({ status: 'READY' });
    expect(records(f.logger).at(-1)).toMatchObject({
      event: 'native_runtime_reconciliation_outcome',
      status: 'READY',
    });
  });
  it.each(['get', 'put'])(
    'captures original DynamoDB metadata for %s before store sanitization, without command content',
    async (operation) => {
      const logger = { info: vi.fn() };
      const error = awsFailure();
      const ddb = {
        send: vi.fn(async () => {
          throw error;
        }),
      };
      const pk = `NATIVE#${'c'.repeat(64)}`;
      const command =
        operation === 'get'
          ? new GetCommand({ TableName: sensitive, Key: { pk, sk: 'RUNTIME' } })
          : new PutCommand({
              TableName: sensitive,
              Item: { pk, sk: 'RUNTIME', credentials: sensitive, policies: sensitive },
            });
      await expect(nativeDiagnosticDdb(ddb, logger).send(command)).rejects.toBe(error);
      expect(records(logger)).toEqual([
        {
          event: 'native_runtime_service_failure',
          service: 'dynamodb',
          operation: operation === 'get' ? 'GetCommand' : 'PutCommand',
          scopeHash: 'c'.repeat(64),
          errorName: 'AccessDeniedException',
          errorCode: 'AccessDeniedException',
          httpStatus: 403,
          requestId,
        },
      ]);
    },
  );
});

describe('native SQS pointer boundary', () => {
  const env = {
    NATIVE_PREPARATION_ENABLED: 'true',
    NATIVE_PREPARATION_PROJECT_IDS: JSON.stringify([IDENTITY.projectId]),
  };
  const record = (body = IDENTITY) => ({
    messageId: 'one',
    eventSource: 'aws:sqs',
    body: JSON.stringify(body),
  });
  it('passes only the protected-row pointer and retries pending reconciliation', async () => {
    const reconcile = vi.fn(async () => ({ status: 'pending' }));
    const handler = createNativeRuntimeWorker({ reconcile, env });
    expect(await handler({ Records: [record()] })).toEqual({
      batchItemFailures: [{ itemIdentifier: 'one' }],
    });
    expect(reconcile.mock.calls[0][0]).toEqual(IDENTITY);
  });
  it.each([
    { ...IDENTITY, runtimeArn: 'caller-controlled' },
    { ...IDENTITY, imageUri: IMAGE.uri },
    { ...IDENTITY, bindingId: 'caller-controlled' },
    { ...IDENTITY, projectId: 'another-project' },
  ])('rejects configuration or another project in queue body', async (body) => {
    const reconcile = vi.fn();
    const handler = createNativeRuntimeWorker({ reconcile, env });
    expect(await handler({ Records: [record(body)] })).toEqual({
      batchItemFailures: [{ itemIdentifier: 'one' }],
    });
    expect(reconcile).not.toHaveBeenCalled();
  });
});
