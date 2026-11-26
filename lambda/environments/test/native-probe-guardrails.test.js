import { describe, expect, it } from 'vitest';
import { flattenRecipe, generateDockerfile, validateRecipe } from '../fixed-tool-recipe.js';
import {
  generateCatalogEnvironmentDockerfile,
  normalizeCatalogRecipeInput,
  rebuildCatalogEnvironmentRecipe,
  resolveCatalogEnvironmentRecipe,
} from '../catalog-recipe.js';
import { SYSTEM_TOOL_TEMPLATES, normalizeToolVersionDefinition } from '../tool-catalog.js';

const FLAG = 'NATIVE_INTERACTION_PROBE_ENABLED';
const base = {
  environmentId: 'standard',
  revisionId: 'core-1',
  imageUri: '111111111111.dkr.ecr.us-east-1.amazonaws.com/core',
  imageDigest: `sha256:${'a'.repeat(64)}`,
};
const fixedRecipe = (environmentVariables = {}) => ({
  schemaVersion: 1,
  base,
  tools: {},
  buildTools: {},
  aptPackages: [],
  environmentVariables,
  buildCommands: [],
});
const catalogRecipe = (environmentVariables = {}) => ({
  ...normalizeCatalogRecipeInput({ environmentVariables }),
  base,
  tools: [],
});
const baseRevision = (overrides = {}) => ({
  ...base,
  flattenedRecipe: {
    schemaVersion: 2,
    resolvedTools: [],
    aptPackages: [],
    environmentVariables: {},
    ...overrides,
  },
});
const tool = (environmentVariables = {}) => ({
  toolId: 'go',
  versionId: 'tv-go-1',
  version: '1.24.6',
  imageUri: '111111111111.dkr.ecr.us-east-1.amazonaws.com/tools',
  imageDigest: `sha256:${'b'.repeat(64)}`,
  executables: [{ name: 'go', path: 'bin/go' }],
  aptPackages: [],
  environmentVariables,
  verification: { files: [] },
});
const emptyToolStore = {
  listTools: async () => [],
  listAllVersions: async () => [],
};
const protectedVariableError = {
  statusCode: 409,
  code: 'PROTECTED_RUNTIME_VARIABLE',
};

describe('native probe flag in managed environments', () => {
  it.each([
    ['NATIVE_INTERACTION_WORKSPACE_DIR', '/mnt/native'],
    ['NATIVE_INTERACTION_REQUIRE_EFS', 'false'],
  ])('reserves the native storage setting %s in recipes and published tools', (name, value) => {
    const variables = { [name]: value };
    expect(validateRecipe(fixedRecipe(variables)).valid).toBe(false);
    expect(() => normalizeCatalogRecipeInput({ environmentVariables: variables })).toThrow(
      'Invalid environment recipe',
    );
    const template = SYSTEM_TOOL_TEMPLATES.find((entry) => entry.toolId === 'go');
    expect(() =>
      normalizeToolVersionDefinition({
        ...template.version,
        environmentVariables: variables,
      }),
    ).toThrow('Invalid tool version definition');
  });

  it.each(['true', 'false'])(
    'reserves the flag in both recipe inputs and tool definitions (%s)',
    (value) => {
      const variables = { [FLAG]: value };
      const fixed = validateRecipe(fixedRecipe(variables));
      expect(fixed.valid).toBe(false);
      expect(fixed.issues).toContainEqual({
        path: `environmentVariables.${FLAG}`,
        message: 'platform runtime variables cannot be overridden',
      });
      expect(() => normalizeCatalogRecipeInput({ environmentVariables: variables })).toThrow(
        'Invalid environment recipe',
      );
      const template = SYSTEM_TOOL_TEMPLATES.find((entry) => entry.toolId === 'go');
      expect(() =>
        normalizeToolVersionDefinition({ ...template.version, environmentVariables: variables }),
      ).toThrow('Invalid tool version definition');
    },
  );

  it('rejects a flag inherited by a fixed-tool recipe before generating a build', () => {
    const flattened = flattenRecipe(fixedRecipe(), fixedRecipe({ [FLAG]: 'true' }));
    expect(() => generateDockerfile(flattened)).toThrow('Invalid environment recipe');
  });

  it.each(['base environment', 'inherited tool'])(
    'rejects a previously saved flag from a %s during catalog resolve and rebuild',
    async (source) => {
      const revision = baseRevision(
        source === 'base environment'
          ? { environmentVariables: { [FLAG]: 'true' } }
          : { resolvedTools: [tool({ [FLAG]: 'true' })] },
      );
      await expect(
        resolveCatalogEnvironmentRecipe({
          input: {},
          baseEnvironmentId: 'standard',
          baseRevision: revision,
          toolStore: emptyToolStore,
        }),
      ).rejects.toMatchObject(protectedVariableError);
      expect(() =>
        rebuildCatalogEnvironmentRecipe({
          sourceRecipe: catalogRecipe(),
          baseEnvironmentId: 'standard',
          baseRevision: revision,
        }),
      ).toThrow(expect.objectContaining(protectedVariableError));
    },
  );

  it('rejects a previously published tool flag when selecting it for a new environment', async () => {
    const snapshot = tool({ [FLAG]: 'true' });
    await expect(
      resolveCatalogEnvironmentRecipe({
        input: { toolVersionIds: [snapshot.versionId] },
        baseEnvironmentId: 'standard',
        baseRevision: baseRevision(),
        toolStore: {
          listTools: async () => [{ toolId: snapshot.toolId }],
          listAllVersions: async () => [
            {
              ...snapshot,
              status: 'PUBLISHED',
              definition: { ...snapshot, dependencies: [] },
            },
          ],
        },
      }),
    ).rejects.toMatchObject(protectedVariableError);
  });

  it.each(['recipe', 'tool'])(
    'rejects a saved %s flag during rebuild and direct Dockerfile generation',
    (source) => {
      const recipe = {
        ...catalogRecipe(),
        ...(source === 'recipe'
          ? { environmentVariables: { [FLAG]: 'true' } }
          : { tools: [tool({ [FLAG]: 'true' })] }),
      };
      expect(() =>
        rebuildCatalogEnvironmentRecipe({
          sourceRecipe: recipe,
          baseEnvironmentId: 'standard',
          baseRevision: baseRevision(),
        }),
      ).toThrow(expect.objectContaining(protectedVariableError));
      expect(() => generateCatalogEnvironmentDockerfile(recipe)).toThrow(
        expect.objectContaining(protectedVariableError),
      );
    },
  );

  it('preserves ordinary variables inherited and supplied by managed recipes', async () => {
    const resolved = await resolveCatalogEnvironmentRecipe({
      input: { environmentVariables: { BUILD_MODE: 'strict' } },
      baseEnvironmentId: 'standard',
      baseRevision: baseRevision({ environmentVariables: { PARENT_MODE: 'enabled' } }),
      toolStore: emptyToolStore,
    });
    expect(resolved.flattenedRecipe.environmentVariables).toEqual({
      PARENT_MODE: 'enabled',
      BUILD_MODE: 'strict',
    });
    expect(generateCatalogEnvironmentDockerfile(resolved.recipe)).toContain(
      'ENV BUILD_MODE="strict"',
    );
    expect(validateRecipe(fixedRecipe({ BUILD_MODE: 'strict' })).valid).toBe(true);
  });
});
