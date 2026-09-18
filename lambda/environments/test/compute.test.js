import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyComputeBase,
  capacityProviderName,
  ensureCapacityProvider,
  environmentArchitecture,
  normalizeCompute,
} from '../compute.js';

const INSTANCES_ENV = {
  MANAGED_INSTANCES_OPERATOR_ROLE_ARN: 'arn:aws:iam::123456789012:role/operator',
  MANAGED_INSTANCES_SUBNETS: '["subnet-1","subnet-2"]',
  MANAGED_INSTANCES_SECURITY_GROUPS: '["sg-1"]',
  MANAGED_INSTANCES_ALLOWED_TYPES: '["t3.large"]',
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

describe('normalizeCompute', () => {
  it('returns null for the default microVMs compute', () => {
    expect(normalizeCompute(undefined)).toBeNull();
    expect(normalizeCompute(null)).toBeNull();
    expect(normalizeCompute({ type: 'microvms' })).toBeNull();
    expect(normalizeCompute({ type: 'microvms', architecture: 'arm64' })).toBeNull();
  });

  it('rejects unknown types and architectures', () => {
    expect(() => normalizeCompute({ type: 'bare-metal' })).toThrow(/compute\.type/);
    expect(() => normalizeCompute({ type: 'instances', architecture: 'riscv' })).toThrow(
      /compute\.architecture/,
    );
    expect(() => normalizeCompute('instances')).toThrow(/must be an object/);
  });

  it('rejects x86_64 on microVMs (arm64-only compute type)', () => {
    expect(() => normalizeCompute({ type: 'microvms', architecture: 'x86_64' })).toThrow(/arm64/);
  });

  it('accepts instances and defaults the architecture to x86_64', () => {
    expect(normalizeCompute({ type: 'instances' })).toEqual({
      type: 'instances',
      architecture: 'x86_64',
    });
    expect(normalizeCompute({ type: 'instances', architecture: 'arm64' })).toEqual({
      type: 'instances',
      architecture: 'arm64',
    });
  });

  it('rejects instances when the deployment is not configured for it', () => {
    delete process.env.MANAGED_INSTANCES_OPERATOR_ROLE_ARN;
    expect(() => normalizeCompute({ type: 'instances' })).toThrow(/not configured/);
  });

  it('rejects x86_64 when no amd64 core image is published', () => {
    delete process.env.CORE_IMAGE_URI_AMD64;
    expect(() => normalizeCompute({ type: 'instances', architecture: 'x86_64' })).toThrow(
      /x86_64 core image/,
    );
  });
});

describe('environmentArchitecture', () => {
  it('defaults to arm64 and honors the compute field', () => {
    expect(environmentArchitecture({})).toBe('arm64');
    expect(environmentArchitecture(null)).toBe('arm64');
    expect(
      environmentArchitecture({ compute: { type: 'instances', architecture: 'x86_64' } }),
    ).toBe('x86_64');
  });
});

describe('applyComputeBase', () => {
  const recipe = {
    schemaVersion: 'catalog-1',
    toolVersionIds: [],
    base: {
      environmentId: 'core',
      revisionId: 'core-1',
      imageUri: 'arm64-uri',
      imageDigest: 'sha256:arm',
    },
  };

  it('leaves arm64 recipes untouched', () => {
    expect(
      applyComputeBase({ recipe, compute: { type: 'instances', architecture: 'arm64' } }),
    ).toBe(recipe);
  });

  it('swaps the base image for the amd64 core on x86_64', () => {
    const swapped = applyComputeBase({
      recipe,
      compute: { type: 'instances', architecture: 'x86_64' },
    });
    expect(swapped.base.imageUri).toBe(INSTANCES_ENV.CORE_IMAGE_URI_AMD64);
    expect(swapped.base.imageDigest).toBe(INSTANCES_ENV.CORE_IMAGE_DIGEST_AMD64);
    expect(swapped.architecture).toBe('x86_64');
    expect(swapped.base.environmentId).toBe('core');
  });

  it('rejects x86_64 recipes that select catalog tools', () => {
    expect(() =>
      applyComputeBase({
        recipe: { ...recipe, toolVersionIds: ['tool@1'] },
        compute: { type: 'instances', architecture: 'x86_64' },
      }),
    ).toThrow(/arm64-only/);
  });

  it('rejects x86_64 environments derived from non-standard bases', () => {
    expect(() =>
      applyComputeBase({
        recipe: { ...recipe, base: { ...recipe.base, environmentId: 'custom-base' } },
        compute: { type: 'instances', architecture: 'x86_64' },
      }),
    ).toThrow(/Standard environment/);
  });
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
    expect(launch.instanceRequirements.allowedInstanceTypes).toEqual(['t3.large']);
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
    process.env.MANAGED_INSTANCES_ALLOWED_TYPES = '["m6i.xlarge"]';
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
