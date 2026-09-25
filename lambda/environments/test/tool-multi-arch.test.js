import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SYSTEM_TOOL_TEMPLATES,
  generateToolBuildContext,
  normalizeToolVersionDefinition,
  recommendedVersionIdFor,
  resolveToolDependencies,
  systemTemplateVersions,
  toolArchitecture,
  toolVersionSnapshot,
} from '../tool-catalog.js';
import { createToolStore } from '../tool-store.js';
import {
  generateCatalogEnvironmentBuildContext,
  resolveCatalogEnvironmentRecipe,
} from '../catalog-recipe.js';
import { applyComputeBase } from '../compute.js';
import { createToolsHandler } from '../tools-index.js';

// x86_64 tool builds are additive: every arm64 behavior below is asserted to
// be byte-for-byte what it was before multi-architecture support.

const exec = promisify(execFile);
const temporaryDirectories = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const template = (toolId) => SYSTEM_TOOL_TEMPLATES.find((tool) => tool.toolId === toolId);
const x86 = (toolId) => systemTemplateVersions(template(toolId), ['x86_64'])[0];
const coreUri = '111111111111.dkr.ecr.us-east-1.amazonaws.com/core';

const published = (toolId, versionId, definition, extra = {}) => ({
  toolId,
  versionId,
  status: 'PUBLISHED',
  definition,
  imageUri: `111111111111.dkr.ecr.us-east-1.amazonaws.com/tools`,
  imageDigest: `sha256:${versionId.length.toString(16).padStart(64, '0')}`,
  ...extra,
});

describe('tool version architecture', () => {
  it('never writes arm64 into a definition, so existing records normalize unchanged', () => {
    const java = template('java').version;
    expect(java).not.toHaveProperty('architecture');
    expect(normalizeToolVersionDefinition(java)).not.toHaveProperty('architecture');
    expect(normalizeToolVersionDefinition({ ...java, architecture: 'arm64' })).toEqual(
      normalizeToolVersionDefinition(java),
    );
    expect(toolArchitecture(java)).toBe('arm64');
  });

  it('stores x86_64 explicitly and rejects unknown architectures', () => {
    expect(normalizeToolVersionDefinition(x86('go'))).toMatchObject({ architecture: 'x86_64' });
    expect(() =>
      normalizeToolVersionDefinition({ ...template('go').version, architecture: 'riscv64' }),
    ).toThrow(
      expect.objectContaining({
        statusCode: 400,
        issues: [expect.objectContaining({ path: 'architecture' })],
      }),
    );
  });

  it('keeps each architecture in its own recommendation slot', () => {
    const tool = { recommendedVersionId: 'tv-arm', recommendedX86_64VersionId: 'tv-x86' };
    expect(recommendedVersionIdFor(tool)).toBe('tv-arm');
    expect(recommendedVersionIdFor(tool, 'x86_64')).toBe('tv-x86');
    expect(recommendedVersionIdFor({ recommendedVersionId: 'tv-arm' }, 'x86_64')).toBeNull();
  });
});

describe('system templates', () => {
  it('seeds only the arm64 definitions unless x86_64 is requested', () => {
    for (const item of SYSTEM_TOOL_TEMPLATES) {
      expect(systemTemplateVersions(item)).toEqual([item.version]);
    }
  });

  it('pins x86_64 variants to the publishers official x86_64 artifacts', () => {
    expect(x86('java').source).toMatchObject({
      url: expect.stringContaining('OpenJDK21U-jdk_x64_linux_hotspot_21.0.8_9.tar.gz'),
      expectedChecksum: {
        algorithm: 'sha256',
        value: 'f2dc5418092c43003db8f9005c4a286e1c0104fea96ccdd49e8ebd037cac9219',
      },
    });
    expect(x86('go').source.url).toBe('https://go.dev/dl/go1.24.6.linux-amd64.tar.gz');
    expect(x86('rust').source.url).toContain('x86_64-unknown-linux-gnu');
    expect(x86('rust').installer.script).toContain('rust-std-x86_64-unknown-linux-gnu');
    expect(x86('rust').installer.script).not.toContain('aarch64');
    // Architecture-independent archives are reused as-is.
    expect(x86('maven').source).toEqual(template('maven').version.source);
    expect(x86('gradle').source).toEqual(template('gradle').version.source);
    for (const item of SYSTEM_TOOL_TEMPLATES) {
      const variant = x86(item.toolId);
      expect(variant.architecture).toBe('x86_64');
      expect(variant.version).toBe(item.version.version);
      expect(() => normalizeToolVersionDefinition(variant)).not.toThrow();
    }
  });

  it('keeps the arm64 Rust installer byte-identical', () => {
    expect(template('rust').version.installer.script).toContain(
      'rust-std-aarch64-unknown-linux-gnu',
    );
    expect(template('rust').version.installer.script).not.toContain('x86_64');
  });
});

describe('tool build context', () => {
  const context = (definition, dependencies = []) =>
    generateToolBuildContext({
      tool: { toolId: 'go' },
      version: { versionId: 'tv-go', definition },
      dependencies,
      coreImageUri: coreUri,
      coreImageDigest: `sha256:${'a'.repeat(64)}`,
      generatedAt: '2026-09-25T00:00:00.000Z',
    });

  it('targets the architecture recorded in the checksummed manifest', async () => {
    const arm = context(template('go').version);
    expect(arm.manifest).toMatchObject({
      architecture: 'arm64',
      platform: 'linux/arm64',
      dockerArchitecture: 'arm64',
    });
    const amd = context(x86('go'));
    expect(amd.manifest).toMatchObject({
      architecture: 'x86_64',
      platform: 'linux/amd64',
      dockerArchitecture: 'amd64',
    });
    const script = amd.files['build-tool.sh'];
    expect(script).toContain('tool_platform="$(jq -r .platform manifest.json)"');
    expect(script).toContain('--platform "$tool_platform"');
    expect(script).not.toContain('--platform linux/arm64');
    expect(script).toContain('--arg architecture "$(jq -r .architecture manifest.json)"');
    expect(script).toContain('architecture: $architecture');
    expect(JSON.parse(amd.files['tool-metadata.json']).architecture).toBe('x86_64');
    expect(JSON.parse(arm.files['tool-metadata.json'])).not.toHaveProperty('architecture');

    const directory = await mkdtemp(join(tmpdir(), 'managed-tool-multiarch-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'build-tool.sh');
    await writeFile(path, script);
    await expect(exec('bash', ['-n', path])).resolves.toBeDefined();
  });

  it('refuses a dependency built for another architecture', () => {
    const armJava = toolVersionSnapshot(
      published('java', 'tv-java-arm', template('java').version),
      template('java'),
    );
    expect(() =>
      generateToolBuildContext({
        tool: { toolId: 'maven' },
        version: { versionId: 'tv-maven-x86', definition: x86('maven') },
        dependencies: [armJava],
        coreImageUri: coreUri,
        coreImageDigest: `sha256:${'a'.repeat(64)}`,
      }),
    ).toThrow(expect.objectContaining({ code: 'TOOL_ARCHITECTURE_MISMATCH' }));
  });
});

describe('environment tool resolution', () => {
  const javaArm = published('java', 'tv-java-arm', template('java').version);
  const javaX86 = published('java', 'tv-java-x86', x86('java'));
  const mavenX86 = published('maven', 'tv-maven-x86', x86('maven'));
  const tools = [
    {
      toolId: 'java',
      recommendedVersionId: 'tv-java-arm',
      recommendedX86_64VersionId: 'tv-java-x86',
    },
    { toolId: 'maven' },
  ];
  const versions = [javaArm, javaX86, mavenX86];

  it('rejects selecting a tool build of another architecture (both directions)', () => {
    expect(() =>
      resolveToolDependencies({
        selectedVersionIds: ['tv-java-arm'],
        tools,
        versions,
        architecture: 'x86_64',
      }),
    ).toThrow(expect.objectContaining({ code: 'TOOL_ARCHITECTURE_MISMATCH' }));
    expect(() =>
      resolveToolDependencies({ selectedVersionIds: ['tv-java-x86'], tools, versions }),
    ).toThrow(expect.objectContaining({ code: 'TOOL_ARCHITECTURE_MISMATCH' }));
  });

  it('pulls in the dependency recommended for the same architecture', () => {
    const resolved = resolveToolDependencies({
      selectedVersionIds: ['tv-maven-x86'],
      tools,
      versions,
      architecture: 'x86_64',
    });
    expect(resolved.map((version) => version.versionId)).toEqual(['tv-java-x86', 'tv-maven-x86']);
  });

  it('fails when the dependency has no recommended x86_64 version', () => {
    expect(() =>
      resolveToolDependencies({
        selectedVersionIds: ['tv-maven-x86'],
        tools: [{ toolId: 'java', recommendedVersionId: 'tv-java-arm' }, { toolId: 'maven' }],
        versions,
        architecture: 'x86_64',
      }),
    ).toThrow(/recommended x86_64 java version/);
  });

  it('marks x86_64 snapshots and leaves arm64 snapshots unchanged', () => {
    expect(toolVersionSnapshot(javaX86)).toMatchObject({ architecture: 'x86_64' });
    expect(toolVersionSnapshot(javaArm)).not.toHaveProperty('architecture');
  });
});

describe('tool store', () => {
  const store = (ddb) =>
    createToolStore({
      ddb,
      tableName: 'registry',
      clock: () => '2026-09-25T00:00:00.000Z',
      ids: () => 'x',
    });

  it('keys the x86_64 version name separately and keeps the arm64 alias key', async () => {
    const ddb = { send: vi.fn().mockResolvedValue({}) };
    await store(ddb).createVersion({
      tool: { toolId: 'java' },
      definition: x86('java'),
      createdBy: 'a',
    });
    await store(ddb).createVersion({
      tool: { toolId: 'java' },
      definition: template('java').version,
      createdBy: 'a',
    });
    const aliasOf = (call) => ddb.send.mock.calls[call][0].input.TransactItems[1].Put.Item.sk;
    expect(aliasOf(0)).toBe('VERSION_NAME#21.0.8#x86_64');
    expect(aliasOf(1)).toBe('VERSION_NAME#21.0.8');
  });

  it('writes the x86_64 recommendation to its own attribute', async () => {
    const ddb = {
      send: vi
        .fn()
        .mockImplementation(async (command) =>
          command.constructor.name === 'GetCommand' ? { Item: { toolId: 'java' } } : {},
        ),
    };
    await store(ddb).setRecommendedVersion({
      toolId: 'java',
      versionId: 'tv-java-x86',
      actor: 'admin',
      architecture: 'x86_64',
    });
    const update = ddb.send.mock.calls[0][0].input.TransactItems[1].Update;
    expect(update.ExpressionAttributeNames).toEqual({
      '#recommended': 'recommendedX86_64VersionId',
      '#recommendedAt': 'recommendedX86_64At',
      '#recommendedBy': 'recommendedX86_64By',
    });
    await store(ddb).setRecommendedVersion({
      toolId: 'java',
      versionId: 'tv-java-arm',
      actor: 'admin',
    });
    expect(
      ddb.send.mock.calls.at(-2)[0].input.TransactItems[1].Update.ExpressionAttributeNames,
    ).toEqual({
      '#recommended': 'recommendedVersionId',
      '#recommendedAt': 'recommendedAt',
      '#recommendedBy': 'recommendedBy',
    });
  });

  it('refuses to change a draft version architecture in place', async () => {
    const ddb = {
      send: vi.fn().mockResolvedValue({
        Item: {
          toolId: 'go',
          versionId: 'tv-go',
          status: 'DRAFT',
          definition: template('go').version,
        },
      }),
    };
    await expect(
      store(ddb).updateVersion('go', 'tv-go', { definition: x86('go') }),
    ).rejects.toMatchObject({ code: 'TOOL_ARCHITECTURE_IMMUTABLE' });
  });

  it('seeds x86_64 system variants only when requested', async () => {
    const created = [];
    const ddb = {
      send: vi.fn().mockImplementation(async (command) => {
        const name = command.constructor.name;
        if (name === 'GetCommand') {
          return command.input.Key.sk === 'META'
            ? { Item: { toolId: command.input.Key.pk.slice(5) } }
            : {};
        }
        if (name === 'TransactWriteCommand') {
          created.push(command.input.TransactItems[1].Put?.Item?.sk);
        }
        return {};
      }),
    };
    await store(ddb).seedSystemTools();
    expect(created.every((sk) => !sk.endsWith('#x86_64'))).toBe(true);
    const armCount = created.length;
    created.length = 0;
    await store(ddb).seedSystemTools({ architectures: ['arm64', 'x86_64'] });
    expect(created.filter((sk) => sk.endsWith('#x86_64'))).toHaveLength(armCount);
  });
});

describe('tool build start', () => {
  const amdDigest = `sha256:${'b'.repeat(64)}`;
  beforeEach(() => {
    vi.stubEnv('BUILD_CONTEXT_BUCKET', 'contexts');
    vi.stubEnv('TOOL_CODEBUILD_PROJECT', 'tool-build');
    vi.stubEnv('TOOL_ECR_REPOSITORY_URI', '111111111111.dkr.ecr.us-east-1.amazonaws.com/tools');
    vi.stubEnv('CORE_IMAGE_URI', coreUri);
    vi.stubEnv('CORE_IMAGE_DIGEST', `sha256:${'a'.repeat(64)}`);
  });
  afterEach(() => vi.unstubAllEnvs());

  const run = async (definition) => {
    const draft = {
      toolId: 'go',
      versionId: 'tv-go',
      status: 'DRAFT',
      autoBuild: true,
      buildAttempt: 0,
      definition,
    };
    const store = {
      seedSystemTools: vi.fn().mockResolvedValue([]),
      listTools: vi.fn().mockResolvedValue([]),
      listAllVersions: vi.fn().mockResolvedValue([]),
      listVersionsByStatus: vi
        .fn()
        .mockImplementation(async (status) => (status === 'DRAFT' ? [draft] : [])),
      getTool: vi.fn().mockResolvedValue(template('go')),
      updateVersion: vi.fn().mockImplementation(async (_t, _v, patch) => ({ ...draft, ...patch })),
    };
    const codebuildClient = { send: vi.fn().mockResolvedValue({ build: { id: 'b:1' } }) };
    const handler = createToolsHandler({
      store,
      s3Client: { send: vi.fn().mockResolvedValue({}) },
      codebuildClient,
    });
    await handler({ action: 'bootstrap' });
    return { store, codebuildClient };
  };

  it('builds arm64 tools on the default fleet against the arm64 core, as before', async () => {
    const { store, codebuildClient } = await run(template('go').version);
    expect(store.seedSystemTools).toHaveBeenCalledWith({ architectures: ['arm64'] });
    const input = codebuildClient.send.mock.calls[0][0].input;
    expect(input).not.toHaveProperty('environmentTypeOverride');
    expect(input).not.toHaveProperty('imageOverride');
    expect(input.environmentVariablesOverride).toEqual(
      expect.arrayContaining([
        { name: 'CORE_IMAGE_URI', value: coreUri, type: 'PLAINTEXT' },
        { name: 'CORE_IMAGE_DIGEST', value: `sha256:${'a'.repeat(64)}`, type: 'PLAINTEXT' },
      ]),
    );
  });

  it('builds x86_64 tools natively on an x86 fleet against the amd64 core', async () => {
    vi.stubEnv('CORE_IMAGE_URI_AMD64', coreUri);
    vi.stubEnv('CORE_IMAGE_DIGEST_AMD64', amdDigest);
    const { store, codebuildClient } = await run(x86('go'));
    expect(store.seedSystemTools).toHaveBeenCalledWith({ architectures: ['arm64', 'x86_64'] });
    const input = codebuildClient.send.mock.calls[0][0].input;
    expect(input).toMatchObject({
      environmentTypeOverride: 'LINUX_CONTAINER',
      imageOverride: 'aws/codebuild/amazonlinux-x86_64-standard:5.0',
    });
    expect(input.environmentVariablesOverride).toEqual(
      expect.arrayContaining([{ name: 'CORE_IMAGE_DIGEST', value: amdDigest, type: 'PLAINTEXT' }]),
    );
  });

  it('does not start x86_64 builds when the deployment has no amd64 core', async () => {
    const { store, codebuildClient } = await run(x86('go'));
    expect(codebuildClient.send).not.toHaveBeenCalled();
    expect(store.updateVersion).not.toHaveBeenCalled();
  });
});

// Consumption: an x86_64 tool image composed into an x86_64 environment, and
// an x86_64 child environment that inherits tools from an x86_64 parent.
describe('consuming x86_64 tools in environments', () => {
  const compute = { type: 'instances', architecture: 'x86_64' };
  const amdDigest = `sha256:${'b'.repeat(64)}`;
  const toolImage = (versionId) => ({
    imageUri: '111111111111.dkr.ecr.us-east-1.amazonaws.com/tools',
    imageSizeBytes: 100,
    imageDigest: `sha256:${{ 'tv-java-x86': '1', 'tv-go-x86': '2', 'tv-go-arm': '3' }[
      versionId
    ].repeat(64)}`,
  });
  const javaX86 = published('java', 'tv-java-x86', x86('java'), toolImage('tv-java-x86'));
  const goX86 = published('go', 'tv-go-x86', x86('go'), toolImage('tv-go-x86'));
  const goArm = published('go', 'tv-go-arm', template('go').version, toolImage('tv-go-arm'));
  const toolStore = {
    listTools: async () => [
      { toolId: 'java', name: 'Java JDK' },
      { toolId: 'go', name: 'Go SDK' },
    ],
    listAllVersions: async () => [javaX86, goX86, goArm],
  };
  const standardRevision = {
    revisionId: 'core-1',
    imageUri: coreUri,
    imageDigest: `sha256:${'a'.repeat(64)}`,
    imageSizeBytes: 1000,
    flattenedRecipe: null,
    amd64Image: { imageUri: coreUri, imageDigest: amdDigest },
  };

  const compose = async ({ baseEnvironmentId, baseRevision, toolVersionIds }) => {
    const resolved = await resolveCatalogEnvironmentRecipe({
      input: { toolVersionIds },
      baseEnvironmentId,
      baseRevision,
      toolStore,
      architecture: 'x86_64',
    });
    return {
      recipe: applyComputeBase({ recipe: resolved.recipe, compute, baseRevision }),
      flattenedRecipe: applyComputeBase({
        recipe: resolved.flattenedRecipe,
        compute,
        baseRevision,
      }),
    };
  };

  it('composes the x86_64 tool image FROM the amd64 core and verifies amd64', async () => {
    const { recipe, flattenedRecipe } = await compose({
      baseEnvironmentId: 'standard',
      baseRevision: standardRevision,
      toolVersionIds: ['tv-java-x86'],
    });
    const { files } = generateCatalogEnvironmentBuildContext({
      environment: { environmentId: 'java-x86' },
      revision: { revisionId: 'r-java-x86' },
      recipe,
      flattenedRecipe,
    });
    const dockerfile = files.Dockerfile;
    expect(dockerfile).toContain(
      `FROM ${javaX86.imageUri}@${javaX86.imageDigest} AS managed_tool_0`,
    );
    expect(dockerfile).toContain(`FROM ${coreUri}@${amdDigest}`);
    expect(dockerfile).not.toContain(`@sha256:${'a'.repeat(64)}`);
    expect(dockerfile).toContain(
      'COPY --from=managed_tool_0 /opt/tool/ /opt/managed/tools/java/21.0.8/',
    );
    expect(files['verification.sh']).toContain('"amd64"');
  });

  it('lets an x86_64 child inherit x86_64 tools and add another', async () => {
    const parent = await compose({
      baseEnvironmentId: 'standard',
      baseRevision: standardRevision,
      toolVersionIds: ['tv-java-x86'],
    });
    // The published parent revision: its image is the amd64 build carrying Java.
    const parentRevision = {
      revisionId: 'r-java-x86',
      imageUri: '111111111111.dkr.ecr.us-east-1.amazonaws.com/environments',
      imageDigest: `sha256:${'c'.repeat(64)}`,
      imageSizeBytes: 1200,
      recipe: parent.recipe,
      flattenedRecipe: parent.flattenedRecipe,
    };
    const child = await compose({
      baseEnvironmentId: 'java-x86',
      baseRevision: parentRevision,
      toolVersionIds: ['tv-go-x86'],
    });
    expect(child.recipe.base).toMatchObject({
      environmentId: 'java-x86',
      imageDigest: parentRevision.imageDigest,
    });
    expect(child.flattenedRecipe.resolvedTools.map((tool) => tool.versionId)).toEqual([
      'tv-go-x86',
      'tv-java-x86',
    ]);
    const { files } = generateCatalogEnvironmentBuildContext({
      environment: { environmentId: 'go-java-x86' },
      revision: { revisionId: 'r-child' },
      recipe: child.recipe,
      flattenedRecipe: child.flattenedRecipe,
    });
    expect(files.Dockerfile).toContain(
      `FROM ${parentRevision.imageUri}@${parentRevision.imageDigest}`,
    );
    // Only the directly added tool is copied; Java comes with the parent image.
    expect(files.Dockerfile).toContain(`@${goX86.imageDigest} AS managed_tool_0`);
    expect(files.Dockerfile).not.toContain(javaX86.imageDigest);
    // Both inherited and added tools are verified in the composed image.
    expect(files['verification.sh']).toContain("run_tool_check 'java'");
    expect(files['verification.sh']).toContain("run_tool_check 'go'");
  });

  it('refuses an arm64 tool build anywhere in the x86_64 chain', async () => {
    await expect(
      compose({
        baseEnvironmentId: 'standard',
        baseRevision: standardRevision,
        toolVersionIds: ['tv-go-arm'],
      }),
    ).rejects.toMatchObject({ code: 'TOOL_ARCHITECTURE_MISMATCH' });
  });
});
