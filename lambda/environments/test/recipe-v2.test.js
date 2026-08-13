import { describe, expect, it, vi } from 'vitest';
import {
  generateEnvironmentBuildContextV2,
  generateEnvironmentDockerfileV2,
  projectedEnvironmentImageSize,
  resolveEnvironmentRecipe,
} from '../recipe-v2.js';

const digest = (character) => `sha256:${character.repeat(64)}`;
const baseRevision = {
  revisionId: 'core-1',
  imageUri: '111111111111.dkr.ecr.us-east-1.amazonaws.com/core',
  imageDigest: digest('a'),
  imageSizeBytes: 900 * 1024 * 1024,
  flattenedRecipe: {
    schemaVersion: 1,
    aptPackages: [],
    environmentVariables: {},
    resolvedTools: [],
  },
};

const tool = (toolId, recommendedVersionId) => ({
  toolId,
  name: toolId.toUpperCase(),
  category: 'language-sdk',
  publisher: 'Publisher',
  recommendedVersionId,
});

const version = ({
  toolId,
  versionId,
  number,
  dependencies = [],
  executables = [{ name: toolId, path: `bin/${toolId}` }],
  aptPackages = [],
  environmentVariables = {},
  imageSizeBytes = 100 * 1024 * 1024,
}) => ({
  toolId,
  versionId,
  status: 'PUBLISHED',
  imageUri: '111111111111.dkr.ecr.us-east-1.amazonaws.com/tools',
  imageDigest: digest(toolId === 'java' ? 'b' : 'c'),
  imageSizeBytes,
  source: {
    requestedUrl: `https://example.test/${toolId}.tar.gz`,
    resolvedUrl: `https://example.test/${toolId}.tar.gz`,
    sha256: 'd'.repeat(64),
    sizeBytes: 10,
    trustLevel: 'PLATFORM_PINNED',
  },
  definition: {
    schemaVersion: 1,
    version: number,
    source: { type: 'https', url: `https://example.test/${toolId}.tar.gz` },
    installer: { mode: 'generated', stripComponents: 1 },
    executables,
    dependencies,
    aptPackages,
    environmentVariables,
    verification: {
      preset: 'generic',
      versionCommand: { argv: [toolId, '--version'], expected: number },
      script: '',
      files: [],
    },
  },
});

const createToolStore = (tools, versions) => ({
  listTools: vi.fn().mockResolvedValue(tools),
  listAllVersions: vi.fn().mockResolvedValue(versions),
});

describe('catalog-backed environment recipes', () => {
  it('snapshots exact tool artifacts and adds recommended dependencies', async () => {
    const java = version({ toolId: 'java', versionId: 'tv-java-21', number: '21.0.8' });
    const maven = version({
      toolId: 'maven',
      versionId: 'tv-maven-3',
      number: '3.9.11',
      dependencies: ['java'],
      executables: [{ name: 'mvn', path: 'bin/mvn' }],
    });
    const resolved = await resolveEnvironmentRecipe({
      input: {
        schemaVersion: 2,
        toolVersionIds: [maven.versionId],
        aptPackages: [],
        environmentVariables: {},
        buildCommands: [],
      },
      baseEnvironmentId: 'standard',
      baseRevision,
      toolStore: createToolStore(
        [tool('java', java.versionId), tool('maven', maven.versionId)],
        [java, maven],
      ),
    });

    expect(resolved.recipe.toolVersionIds).toEqual([java.versionId, maven.versionId]);
    expect(resolved.recipe.tools).toEqual([
      expect.objectContaining({
        toolId: 'java',
        versionId: java.versionId,
        imageDigest: java.imageDigest,
      }),
      expect.objectContaining({
        toolId: 'maven',
        versionId: maven.versionId,
        imageDigest: maven.imageDigest,
      }),
    ]);
    expect(resolved.flattenedRecipe.resolvedTools).toHaveLength(2);
  });

  it('rejects executable, package, and variable conflicts', async () => {
    const first = version({
      toolId: 'first',
      versionId: 'tv-first-1',
      number: '1',
      executables: [{ name: 'shared', path: 'bin/first' }],
      aptPackages: [{ name: 'compiler', version: '1' }],
      environmentVariables: { TOOL_MODE: 'first' },
    });
    const second = version({
      toolId: 'second',
      versionId: 'tv-second-1',
      number: '1',
      executables: [{ name: 'shared', path: 'bin/second' }],
      aptPackages: [{ name: 'compiler', version: '2' }],
      environmentVariables: { TOOL_MODE: 'second' },
    });
    const input = {
      schemaVersion: 2,
      toolVersionIds: [first.versionId, second.versionId],
      aptPackages: [],
      environmentVariables: {},
      buildCommands: [],
    };
    const store = createToolStore(
      [tool('first', first.versionId), tool('second', second.versionId)],
      [first, second],
    );

    await expect(
      resolveEnvironmentRecipe({
        input,
        baseEnvironmentId: 'standard',
        baseRevision,
        toolStore: store,
      }),
    ).rejects.toMatchObject({ code: 'TOOL_EXECUTABLE_CONFLICT' });
  });

  it('rejects legacy custom base environments while allowing Standard', async () => {
    const go = version({
      toolId: 'go',
      versionId: 'tv-go-1',
      number: '1.24.6',
    });
    const input = {
      schemaVersion: 2,
      toolVersionIds: [go.versionId],
      aptPackages: [],
      environmentVariables: {},
      buildCommands: [],
    };
    const store = createToolStore([tool('go', go.versionId)], [go]);

    await expect(
      resolveEnvironmentRecipe({
        input,
        baseEnvironmentId: 'legacy-go',
        baseRevision,
        toolStore: store,
      }),
    ).rejects.toMatchObject({ code: 'LEGACY_BASE_REQUIRES_RECREATION' });

    await expect(
      resolveEnvironmentRecipe({
        input,
        baseEnvironmentId: 'standard',
        baseRevision,
        toolStore: store,
      }),
    ).resolves.toMatchObject({
      recipe: { base: { environmentId: 'standard' } },
    });
  });

  it('uses exact OCI digests and preserves the protected runtime contract', async () => {
    const go = version({
      toolId: 'go',
      versionId: 'tv-go-1',
      number: '1.24.6',
      imageSizeBytes: 120 * 1024 * 1024,
    });
    const { recipe, flattenedRecipe } = await resolveEnvironmentRecipe({
      input: {
        schemaVersion: 2,
        toolVersionIds: [go.versionId],
        aptPackages: [],
        environmentVariables: { BUILD_MODE: 'strict' },
        buildCommands: [],
      },
      baseEnvironmentId: 'standard',
      baseRevision,
      toolStore: createToolStore([tool('go', go.versionId)], [go]),
    });
    const dockerfile = generateEnvironmentDockerfileV2(recipe);

    expect(dockerfile).toContain(`FROM ${go.imageUri}@${go.imageDigest} AS managed_tool_0`);
    expect(dockerfile).toContain(`FROM ${baseRevision.imageUri}@${baseRevision.imageDigest}`);
    expect(dockerfile).toContain('USER node');
    expect(dockerfile).toContain('ENTRYPOINT ["node", "/opt/agentcore/http-server.js"]');
    expect(dockerfile).toContain('RUN sha256sum -c /opt/managed/protected-runtime.sha256');
    expect(projectedEnvironmentImageSize(recipe)).toBe(1020 * 1024 * 1024);

    const context = generateEnvironmentBuildContextV2({
      environment: { environmentId: 'go-build' },
      revision: { revisionId: 'r-1', runtimeCompatibilityVersion: '1' },
      recipe,
      flattenedRecipe,
      generatedAt: '2026-08-13T00:00:00.000Z',
    });
    expect(context.files['sbom.spdx.json']).toContain('"SPDXRef-Tool-go"');
    expect(context.files['verification.sh']).toContain('docker network disconnect bridge');
    expect(context.files['checksums.sha256']).toContain('sbom.spdx.json');
  });

  it('carries custom verification fixtures into composed images', async () => {
    const dotnet = version({
      toolId: 'dotnet-sdk',
      versionId: 'tv-dotnet-8',
      number: '8.0.408',
      executables: [{ name: 'dotnet', path: 'dotnet' }],
    });
    dotnet.definition.verification.files = [
      { path: 'project/expected.txt', content: 'verified\n' },
    ];
    dotnet.definition.verification.script =
      'test "$(cat "$TOOL_FIXTURES/project/expected.txt")" = verified';
    const { recipe, flattenedRecipe } = await resolveEnvironmentRecipe({
      input: {
        schemaVersion: 2,
        toolVersionIds: [dotnet.versionId],
        aptPackages: [],
        environmentVariables: {},
        buildCommands: [],
      },
      baseEnvironmentId: 'standard',
      baseRevision,
      toolStore: createToolStore([tool('dotnet-sdk', dotnet.versionId)], [dotnet]),
    });

    const context = generateEnvironmentBuildContextV2({
      environment: { environmentId: 'dotnet-build' },
      revision: { revisionId: 'r-1', runtimeCompatibilityVersion: '1' },
      recipe,
      flattenedRecipe,
    });

    expect(context.files.Dockerfile).toContain(
      'COPY verification-fixtures/ /opt/managed/verification-fixtures/',
    );
    expect(context.files['verification-fixtures/dotnet-sdk/project/expected.txt']).toBe(
      'verified\n',
    );
    const encodedVerifier = context.files['verification.sh'].match(
      /run_tool_check 'dotnet-sdk' '([^']+)'/,
    )?.[1];
    expect(Buffer.from(encodedVerifier, 'base64').toString('utf8')).toContain(
      '/opt/managed/verification-fixtures/dotnet-sdk',
    );
    expect(context.files['checksums.sha256']).toContain(
      'verification-fixtures/dotnet-sdk/project/expected.txt',
    );
  });
});
