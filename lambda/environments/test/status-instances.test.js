import { describe, expect, it, vi } from 'vitest';
import { createRuntimeForRevision } from '../status.js';

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
    const controlClient = {
      send: vi.fn().mockResolvedValue({
        capacityProviders: [{ name: 'test_platform_x86', status: 'CREATING' }],
      }),
    };
    const result = await withEnv(() =>
      createRuntimeForRevision({
        store: storeStub(),
        environment: instancesEnvironment,
        revision: scannedRevision,
        controlClient,
      }),
    );
    expect(result.pending).toBe(true);
    // Only the capacity provider lookup ran — no CreateAgentRuntime call.
    expect(controlClient.send).toHaveBeenCalledTimes(1);
  });

  it('creates the runtime from the capacity provider without networkConfiguration', async () => {
    const controlClient = {
      send: vi
        .fn()
        .mockResolvedValueOnce({
          capacityProviders: [
            {
              name: 'test_platform_x86',
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
    const store = storeStub();
    const result = await withEnv(() =>
      createRuntimeForRevision({
        store,
        environment: instancesEnvironment,
        revision: scannedRevision,
        controlClient,
      }),
    );
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
