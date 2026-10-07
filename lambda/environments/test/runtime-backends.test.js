import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runtimeBackendFor } from '../runtime-backends/index.js';
import { INSTANCES_TRANSIENT_ERRORS } from '../runtime-backends/instances.js';

const ENV = {
  MANAGED_INSTANCES_OPERATOR_ROLE_ARN: 'arn:aws:iam::123456789012:role/operator',
  MANAGED_INSTANCES_SUBNETS: '["subnet-1"]',
  MANAGED_INSTANCES_SECURITY_GROUPS: '["sg-1"]',
  MANAGED_INSTANCES_CP_NAME_PREFIX: 'test_platform',
  MANAGED_RUNTIME_NETWORK_MODE: 'VPC',
  MANAGED_RUNTIME_SUBNETS: '["subnet-rt"]',
  MANAGED_RUNTIME_SECURITY_GROUPS: '["sg-rt"]',
};
const saved = {};
beforeEach(() => {
  for (const [k, v] of Object.entries(ENV)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
});
afterEach(() => {
  for (const k of Object.keys(ENV)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const revision = {
  revisionId: 'r-1',
  runtimeArn: 'arn:rt',
  runtimeEndpoint: 'revision_r_1',
  capacityProviderArn: 'arn:aws:bedrock-agentcore:us-east-1:1:capacity-provider/cp-1',
};
const named = (name) => Object.assign(new Error(name), { name });

describe('runtimeBackendFor', () => {
  it('resolves the default environment to the arm64 microVMs backend', () => {
    const backend = runtimeBackendFor({ environmentId: 'plain' });
    expect(backend).toMatchObject({ type: 'microvms', architecture: 'arm64' });
    expect(backend.build).toEqual({ platform: 'linux/arm64', codeBuildOverrides: {} });
    expect(backend.validation).toMatchObject({ reuseSession: false, maxAttempts: 1 });
    expect(backend.validation.isTransientInvokeError(named('TimeoutError'))).toBe(false);
  });

  it('resolves Instances environments per architecture', () => {
    const x86 = runtimeBackendFor({ compute: { type: 'instances', architecture: 'x86_64' } });
    expect(x86).toMatchObject({ type: 'instances', architecture: 'x86_64' });
    expect(x86.build).toEqual({
      platform: 'linux/amd64',
      codeBuildOverrides: {
        environmentTypeOverride: 'LINUX_CONTAINER',
        imageOverride: 'aws/codebuild/amazonlinux-x86_64-standard:5.0',
      },
    });
    const arm = runtimeBackendFor({ compute: { type: 'instances', architecture: 'arm64' } });
    expect(arm.build).toEqual({ platform: 'linux/arm64', codeBuildOverrides: {} });
    expect(arm.validation.reuseSession).toBe(true);
    for (const name of INSTANCES_TRANSIENT_ERRORS) {
      expect(arm.validation.isTransientInvokeError(named(name))).toBe(true);
    }
    expect(arm.validation.isTransientInvokeError(named('ValidationException'))).toBe(false);
  });

  it('rejects an unknown compute type', () => {
    expect(() => runtimeBackendFor({ compute: { type: 'bare-metal' } })).toThrow(
      /Unknown compute type/,
    );
  });
});

describe('microVMs backend', () => {
  it('prepares network + session storage runtime params without a provider', async () => {
    const prepared = await runtimeBackendFor({}).prepareRuntime({
      controlClient: { send: vi.fn() },
    });
    expect(prepared).toEqual({
      pending: false,
      capacityProviderArn: null,
      runtimeParams: {
        networkConfiguration: {
          networkMode: 'VPC',
          networkModeConfig: { subnets: ['subnet-rt'], securityGroups: ['sg-rt'] },
        },
        filesystemConfigurations: [{ sessionStorage: { mountPath: '/mnt/workspace' } }],
      },
    });
  });

  it('releaseValidationSession only stops (service-managed storage)', async () => {
    const runtimeClient = { send: vi.fn().mockResolvedValue({}) };
    const out = await runtimeBackendFor({}).releaseValidationSession({
      runtimeClient,
      revision,
      sessionId: 's-1',
    });
    expect(out).toEqual({ released: true });
    expect(runtimeClient.send).toHaveBeenCalledTimes(1);
    expect(runtimeClient.send.mock.calls[0][0].constructor.name).toBe('StopRuntimeSessionCommand');
  });
});

describe('Instances backend', () => {
  const backend = () =>
    runtimeBackendFor({ compute: { type: 'instances', architecture: 'x86_64' } });

  it('reports pending while the capacity provider is CREATING', async () => {
    const controlClient = {
      send: vi.fn().mockResolvedValue({
        capacityProviders: [{ name: 'other', status: 'READY' }],
      }),
    };
    // No matching provider → create → pending.
    expect(await backend().prepareRuntime({ controlClient })).toEqual({ pending: true });
    expect(controlClient.send.mock.calls.at(-1)[0].constructor.name).toBe(
      'CreateCapacityProviderCommand',
    );
  });

  it('prepares capacity-provider runtime params (no networkConfiguration) when READY', async () => {
    const controlClient = {
      send: vi.fn().mockImplementation(async (command) => {
        if (command.constructor.name === 'ListCapacityProvidersCommand') {
          return {
            capacityProviders: [
              { name: command.input.nextToken ? 'x' : undefined, status: 'READY' },
            ],
          };
        }
        return {};
      }),
    };
    // Make the list return the deterministic name for this configuration.
    const { capacityProviderName } = await import('../runtime-backends/capacity-provider.js');
    controlClient.send.mockResolvedValue({
      capacityProviders: [
        { name: capacityProviderName('x86_64'), status: 'READY', capacityProviderArn: 'arn:cp' },
      ],
    });
    const prepared = await backend().prepareRuntime({ controlClient });
    expect(prepared.pending).toBe(false);
    expect(prepared.capacityProviderArn).toBe('arn:cp');
    expect(prepared.runtimeParams).toEqual({
      capacityProviderConfiguration: { capacityProviderArn: 'arn:cp' },
      filesystemConfigurations: [
        { capacityProviderVolume: { volumeName: 'workspace', mountPath: '/mnt/workspace' } },
      ],
    });
    expect(prepared.runtimeParams).not.toHaveProperty('networkConfiguration');
  });

  it('releaseValidationSession stops then deletes the session, queueing a failed delete', async () => {
    const runtimeClient = {
      send: vi.fn().mockImplementation(async (command) => {
        if (command.constructor.name === 'DeleteCapacityProviderSessionCommand') {
          throw named('InternalServerException');
        }
        return {};
      }),
    };
    const cleanupStore = { enqueue: vi.fn().mockResolvedValue({}) };
    const out = await backend().releaseValidationSession({
      runtimeClient,
      revision,
      sessionId: 's-1',
      cleanupStore,
      environmentId: 'x86-build',
    });
    expect(out).toMatchObject({ released: false, queued: true });
    expect(runtimeClient.send.mock.calls.map((c) => c[0].constructor.name)).toEqual([
      'StopRuntimeSessionCommand',
      'DeleteCapacityProviderSessionCommand',
    ]);
    expect(cleanupStore.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 's-1',
        capacityProviderArn: revision.capacityProviderArn,
        source: 'environment-validation',
        context: { environmentId: 'x86-build', revisionId: 'r-1' },
      }),
    );
  });
});
