import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  capacityProviderName,
  ensureCapacityProvider,
} from '../runtime-backends/capacity-provider.js';

const INSTANCES_ENV = {
  MANAGED_INSTANCES_OPERATOR_ROLE_ARN: 'arn:aws:iam::123456789012:role/operator',
  MANAGED_INSTANCES_SUBNETS: '["subnet-1","subnet-2"]',
  MANAGED_INSTANCES_SECURITY_GROUPS: '["sg-1"]',
  MANAGED_INSTANCES_ALLOWED_TYPES: '["m6i.xlarge"]',
  MANAGED_INSTANCES_ALLOWED_TYPES_ARM64: '["m7g.xlarge"]',
  MANAGED_INSTANCES_CP_NAME_PREFIX: 'test_platform',
  CORE_IMAGE_URI_AMD64: '123456789012.dkr.ecr.us-east-1.amazonaws.com/core',
  CORE_IMAGE_DIGEST_AMD64: `sha256:${'a'.repeat(64)}`,
};

const saved = {};

beforeEach(() => {
  for (const [key, value] of Object.entries(INSTANCES_ENV)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
});

afterEach(() => {
  for (const key of Object.keys(INSTANCES_ENV)) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe('ensureCapacityProvider', () => {
  it('returns the ARN when the provider is READY', async () => {
    const controlClient = {
      send: vi.fn().mockResolvedValue({
        capacityProviders: [
          {
            name: capacityProviderName('x86_64'),
            status: 'READY',
            capacityProviderArn: 'arn:aws:bedrock-agentcore:us-east-1:1:capacity-provider/x',
          },
        ],
      }),
    };
    await expect(
      ensureCapacityProvider({ controlClient, architecture: 'x86_64' }),
    ).resolves.toEqual({
      capacityProviderArn: 'arn:aws:bedrock-agentcore:us-east-1:1:capacity-provider/x',
    });
    expect(controlClient.send).toHaveBeenCalledTimes(1);
  });

  it('reports pending while the provider is CREATING', async () => {
    const controlClient = {
      send: vi.fn().mockResolvedValue({
        capacityProviders: [{ name: capacityProviderName('x86_64'), status: 'CREATING' }],
      }),
    };
    await expect(
      ensureCapacityProvider({ controlClient, architecture: 'x86_64' }),
    ).resolves.toEqual({ pending: true });
  });

  it('creates the provider when absent and reports pending', async () => {
    const controlClient = {
      send: vi
        .fn()
        .mockResolvedValueOnce({ capacityProviders: [] })
        .mockResolvedValueOnce({ capacityProviderArn: 'arn:new', status: 'CREATING' }),
    };
    await expect(
      ensureCapacityProvider({ controlClient, architecture: 'x86_64' }),
    ).resolves.toEqual({ pending: true });

    const createInput = controlClient.send.mock.calls[1][0].input;
    expect(createInput.name).toBe(capacityProviderName('x86_64'));
    expect(createInput.permissionsConfiguration.capacityProviderOperatorRoleArn).toBe(
      INSTANCES_ENV.MANAGED_INSTANCES_OPERATOR_ROLE_ARN,
    );
    const launch =
      createInput.computeConfiguration.ec2Configuration.launchTemplateSource.launchParameters;
    expect(launch.operatingSystem).toBe('LINUX_X86_64');
    expect(launch.instanceRequirements.allowedInstanceTypes).toEqual(['m6i.xlarge']);
    expect(createInput.computeConfiguration.ec2Configuration.vpcConfiguration).toEqual({
      subnets: ['subnet-1', 'subnet-2'],
      securityGroups: ['sg-1'],
    });
    const volumes = createInput.computeConfiguration.ec2Configuration.volumes;
    expect(volumes[0].ebsConfiguration.name).toBe('workspace');
  });

  it('surfaces a failed provider as an error', async () => {
    const controlClient = {
      send: vi.fn().mockResolvedValue({
        capacityProviders: [
          {
            name: capacityProviderName('x86_64'),
            status: 'CREATE_FAILED',
            statusReason: 'bad subnet',
          },
        ],
      }),
    };
    await expect(ensureCapacityProvider({ controlClient, architecture: 'x86_64' })).rejects.toThrow(
      /bad subnet/,
    );
  });

  it('derives a new provider identity when the configuration changes', () => {
    const before = capacityProviderName('x86_64');
    process.env.MANAGED_INSTANCES_ALLOWED_TYPES = '["m6i.2xlarge"]';
    const after = capacityProviderName('x86_64');
    expect(after).not.toBe(before);
    // Same prefix and architecture tag — only the fingerprint differs.
    expect(before.startsWith('test_platform_x86_')).toBe(true);
    expect(after.startsWith('test_platform_x86_')).toBe(true);
    expect(before.length).toBeLessThanOrEqual(48);
  });

  it('creates a fresh provider after a failed configuration is corrected', async () => {
    const failedName = capacityProviderName('x86_64');
    // Correcting the configuration changes the fingerprint, so the failed
    // provider no longer occupies the lookup identity.
    process.env.MANAGED_INSTANCES_SUBNETS = '["subnet-fixed"]';
    const correctedName = capacityProviderName('x86_64');
    expect(correctedName).not.toBe(failedName);

    const controlClient = {
      send: vi
        .fn()
        .mockResolvedValueOnce({
          capacityProviders: [
            { name: failedName, status: 'CREATE_FAILED', statusReason: 'bad subnet' },
          ],
        })
        .mockResolvedValueOnce({ capacityProviderArn: 'arn:new', status: 'CREATING' }),
    };
    await expect(
      ensureCapacityProvider({ controlClient, architecture: 'x86_64' }),
    ).resolves.toEqual({ pending: true });
    const createInput = controlClient.send.mock.calls[1][0].input;
    expect(createInput.name).toBe(correctedName);
    expect(createInput.computeConfiguration.ec2Configuration.vpcConfiguration.subnets).toEqual([
      'subnet-fixed',
    ]);
  });
});

describe('capacity provider instance types per architecture', () => {
  it('launches the architecture-specific allowlist', async () => {
    const sends = [];
    const controlClient = {
      send: vi.fn().mockImplementation(async (command) => {
        sends.push(command);
        return command.constructor.name === 'ListCapacityProvidersCommand'
          ? { capacityProviders: [] }
          : {};
      }),
    };
    await ensureCapacityProvider({ controlClient, architecture: 'arm64' });
    await ensureCapacityProvider({ controlClient, architecture: 'x86_64' });
    const creates = sends.filter((c) => c.constructor.name === 'CreateCapacityProviderCommand');
    const launch = (c) =>
      c.input.computeConfiguration.ec2Configuration.launchTemplateSource.launchParameters;
    expect(launch(creates[0])).toMatchObject({
      operatingSystem: 'LINUX_ARM64',
      instanceRequirements: { allowedInstanceTypes: ['m7g.xlarge'] },
    });
    expect(launch(creates[1])).toMatchObject({
      operatingSystem: 'LINUX_X86_64',
      instanceRequirements: { allowedInstanceTypes: ['m6i.xlarge'] },
    });
  });

  it('refuses to provision an architecture whose allowlist is empty', async () => {
    process.env.MANAGED_INSTANCES_ALLOWED_TYPES = '[]';
    const controlClient = { send: vi.fn() };
    await expect(
      ensureCapacityProvider({ controlClient, architecture: 'x86_64' }),
    ).rejects.toMatchObject({ code: 'NO_INSTANCE_TYPES' });
    expect(controlClient.send).not.toHaveBeenCalled();
  });
});
