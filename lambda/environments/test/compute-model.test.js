import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyComputeBase,
  capabilities,
  environmentArchitecture,
  normalizeCompute,
  prepareRecipesForCompute,
} from '../compute-model.js';

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

  it('swaps the base image for the amd64 variant stored on the base revision', () => {
    const baseRevision = {
      revisionId: 'core-1',
      amd64Image: { imageUri: 'amd64-uri', imageDigest: 'sha256:amd' },
    };
    const swapped = applyComputeBase({
      recipe,
      compute: { type: 'instances', architecture: 'x86_64' },
      baseRevision,
    });
    expect(swapped.base.imageUri).toBe('amd64-uri');
    expect(swapped.base.imageDigest).toBe('sha256:amd');
    expect(swapped.architecture).toBe('x86_64');
    expect(swapped.base.environmentId).toBe('core');
  });

  it('uses the published revision variant even when a newer core is deployed (upgrade window)', () => {
    // Deployment env vars carry the NEW core; the published Standard revision
    // still points at the OLD one until publication. The x86 base must follow
    // the revision, not the deployment.
    process.env.CORE_IMAGE_URI_AMD64 = 'newer-deployment-uri';
    process.env.CORE_IMAGE_DIGEST_AMD64 = `sha256:${'f'.repeat(64)}`;
    const publishedRevision = {
      revisionId: 'core-old',
      amd64Image: { imageUri: 'published-amd64-uri', imageDigest: 'sha256:published-amd' },
    };
    const swapped = applyComputeBase({
      recipe,
      compute: { type: 'instances', architecture: 'x86_64' },
      baseRevision: publishedRevision,
    });
    expect(swapped.base.imageUri).toBe('published-amd64-uri');
    expect(swapped.base.imageDigest).toBe('sha256:published-amd');
  });

  it('rejects an x86_64 recipe when the base revision has no amd64 variant', () => {
    expect(() =>
      applyComputeBase({
        recipe,
        compute: { type: 'instances', architecture: 'x86_64' },
        baseRevision: { revisionId: 'core-1' },
      }),
    ).toThrow(/no x86_64 variant/);
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

describe('capabilities matrix', () => {
  it('lists every (type, architecture) cell with availability and the reason when unavailable', () => {
    const matrix = capabilities();
    expect(matrix.default).toEqual({ type: 'microvms', architecture: 'arm64' });
    expect(matrix.combinations).toEqual([
      { type: 'microvms', architecture: 'arm64', available: true },
      {
        type: 'microvms',
        architecture: 'x86_64',
        available: false,
        reason: 'MICROVMS_ARCHITECTURE_UNSUPPORTED',
      },
      {
        type: 'instances',
        architecture: 'arm64',
        available: true,
        allowedInstanceTypes: ['m7g.xlarge'],
      },
      {
        type: 'instances',
        architecture: 'x86_64',
        available: true,
        allowedInstanceTypes: ['m6i.xlarge'],
      },
    ]);
    expect(matrix.instancesCompute).toBe(true);
    expect(matrix.amd64CoreImage).toBe(true);
  });

  it('marks the Instances cells unavailable with the deployment-level reason', () => {
    delete process.env.CORE_IMAGE_URI_AMD64;
    let cells = Object.fromEntries(
      capabilities().combinations.map((c) => [`${c.type}/${c.architecture}`, c]),
    );
    expect(cells['instances/arm64'].available).toBe(true);
    expect(cells['instances/x86_64']).toMatchObject({
      available: false,
      reason: 'AMD64_CORE_IMAGE_MISSING',
    });
    delete process.env.MANAGED_INSTANCES_OPERATOR_ROLE_ARN;
    cells = Object.fromEntries(
      capabilities().combinations.map((c) => [`${c.type}/${c.architecture}`, c]),
    );
    expect(cells['instances/arm64']).toMatchObject({
      available: false,
      reason: 'INSTANCES_COMPUTE_NOT_CONFIGURED',
    });
    expect(cells['instances/x86_64']).toMatchObject({
      available: false,
      reason: 'INSTANCES_COMPUTE_NOT_CONFIGURED',
    });
  });

  it('reports the configured allowlist of each architecture, with no built-in default', () => {
    process.env.MANAGED_INSTANCES_ALLOWED_TYPES = '["c7i.large","m7i.large"]';
    process.env.MANAGED_INSTANCES_ALLOWED_TYPES_ARM64 = '["m8g.large"]';
    const cells = Object.fromEntries(
      capabilities().combinations.map((c) => [`${c.type}/${c.architecture}`, c]),
    );
    expect(cells['instances/x86_64'].allowedInstanceTypes).toEqual(['c7i.large', 'm7i.large']);
    expect(cells['instances/arm64'].allowedInstanceTypes).toEqual(['m8g.large']);

    // Unset is not "use a default": the architecture is simply not offered.
    delete process.env.MANAGED_INSTANCES_ALLOWED_TYPES;
    delete process.env.MANAGED_INSTANCES_ALLOWED_TYPES_ARM64;
    for (const cell of capabilities().combinations.filter((c) => c.type === 'instances')) {
      expect(cell).toMatchObject({ available: false, reason: 'NO_INSTANCE_TYPES' });
    }
  });

  it.each([
    ['x86_64', 'MANAGED_INSTANCES_ALLOWED_TYPES'],
    ['arm64', 'MANAGED_INSTANCES_ALLOWED_TYPES_ARM64'],
  ])('disables %s when its allowlist is empty, in the matrix and on creation', (arch, name) => {
    process.env[name] = '[]';
    const cells = Object.fromEntries(
      capabilities().combinations.map((c) => [`${c.type}/${c.architecture}`, c]),
    );
    expect(cells[`instances/${arch}`]).toMatchObject({
      available: false,
      reason: 'NO_INSTANCE_TYPES',
    });
    expect(cells[`instances/${arch}`].allowedInstanceTypes).toBeUndefined();
    const other = arch === 'x86_64' ? 'arm64' : 'x86_64';
    expect(cells[`instances/${other}`].available).toBe(true);
    expect(() => normalizeCompute({ type: 'instances', architecture: arch })).toThrow(
      new RegExp(`No ${arch} instance types`),
    );
  });

  it('normalizeCompute agrees with the matrix', () => {
    for (const cell of capabilities().combinations) {
      const attempt = () => normalizeCompute({ type: cell.type, architecture: cell.architecture });
      if (cell.available) expect(attempt).not.toThrow();
      else expect(attempt).toThrow();
    }
  });
});

describe('prepareRecipesForCompute', () => {
  const baseRevision = {
    recipe: { architecture: 'arm64' },
    amd64Image: { imageUri: 'core-amd64', imageDigest: `sha256:${'b'.repeat(64)}` },
  };
  const recipe = { base: { environmentId: 'standard', imageUri: 'core', imageDigest: 'sha256:x' } };

  it('returns both recipes untouched for the default compute', () => {
    expect(
      prepareRecipesForCompute({
        compute: null,
        baseRevision,
        baseEnvironmentId: 'standard',
        recipe,
        flattenedRecipe: recipe,
      }),
    ).toEqual({ recipe, flattenedRecipe: recipe });
  });

  it('applies the amd64 base swap to BOTH the recipe and the flattened recipe', () => {
    const out = prepareRecipesForCompute({
      compute: { type: 'instances', architecture: 'x86_64' },
      baseRevision,
      baseEnvironmentId: 'standard',
      recipe,
      flattenedRecipe: { ...recipe, flattened: true },
    });
    expect(out.recipe.architecture).toBe('x86_64');
    expect(out.flattenedRecipe.architecture).toBe('x86_64');
    expect(out.recipe.base.imageUri).toBe('core-amd64');
    expect(out.flattenedRecipe.base.imageUri).toBe('core-amd64');
  });

  it('rejects an arm64 environment on an x86_64 base before touching the recipes', () => {
    expect(() =>
      prepareRecipesForCompute({
        compute: null,
        baseRevision: { recipe: { architecture: 'x86_64' } },
        baseEnvironmentId: 'x86-parent',
        recipe,
        flattenedRecipe: recipe,
      }),
    ).toThrow(/x86_64/);
  });
});
