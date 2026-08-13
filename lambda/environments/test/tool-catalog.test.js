import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SYSTEM_TOOL_TEMPLATES,
  generateToolBuildContext,
  normalizeToolId,
  normalizeToolVersionDefinition,
  resolveToolDependencies,
} from '../tool-catalog.js';

const exec = promisify(execFile);
const temporaryDirectories = [];

const javaTemplate = SYSTEM_TOOL_TEMPLATES.find((tool) => tool.toolId === 'java');
const mavenTemplate = SYSTEM_TOOL_TEMPLATES.find((tool) => tool.toolId === 'maven');

const publishedVersion = (toolId, versionId, dependencies = []) => ({
  toolId,
  versionId,
  status: 'PUBLISHED',
  definition: {
    ...javaTemplate.version,
    version: versionId.slice(3),
    dependencies,
  },
});

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('managed tool catalog', () => {
  it('ships tool definitions instead of predefined custom environments', () => {
    expect(SYSTEM_TOOL_TEMPLATES.map((tool) => tool.toolId)).toEqual([
      'java',
      'go',
      'rust',
      'maven',
      'gradle',
    ]);
    expect(SYSTEM_TOOL_TEMPLATES.map((tool) => tool.version.version)).toEqual([
      '21.0.8',
      '1.24.6',
      '1.89.0',
      '3.9.11',
      '9.0.0',
    ]);
    expect(javaTemplate.version.source.expectedChecksum).toMatchObject({
      algorithm: 'sha256',
      evidenceUrl: expect.stringMatching(/^https:/),
    });
  });

  it('normalizes administrator tool ids without ambiguous boundary matching', () => {
    expect(normalizeToolId(`---Dot${'-'.repeat(100_000)}Net SDK---`)).toBe('dot-net-sdk');
  });

  it('rejects credential-bearing and mutable source URLs', () => {
    expect(() =>
      normalizeToolVersionDefinition({
        ...javaTemplate.version,
        source: {
          type: 'https',
          url: 'https://user:password@example.test/sdk.tar.gz?token=value',
        },
      }),
    ).toThrow('Invalid tool version definition');
  });

  it('generates a credentialless sandbox, archive inspection, SBOM, and networkless verifier', async () => {
    const context = generateToolBuildContext({
      tool: javaTemplate,
      version: {
        versionId: 'tv-java-21',
        definition: javaTemplate.version,
        source: {
          requestedUrl: javaTemplate.version.source.url,
          resolvedUrl: javaTemplate.version.source.url,
          sha256: 'b'.repeat(64),
          sizeBytes: 1024,
          trustLevel: 'PUBLISHER_VERIFIED',
        },
      },
      coreImageUri: '111111111111.dkr.ecr.us-east-1.amazonaws.com/core',
      coreImageDigest: `sha256:${'a'.repeat(64)}`,
      generatedAt: '2026-08-13T00:00:00.000Z',
    });

    expect(Object.keys(context.files)).toEqual(
      expect.arrayContaining([
        'fetch-source.mjs',
        'inspect-archive.py',
        'generate-sbom.mjs',
        'build-tool.sh',
        'Dockerfile.tool',
        'Dockerfile.validation',
        'checksums.sha256',
      ]),
    );
    expect(context.files['build-tool.sh']).toContain('--cap-drop ALL');
    expect(context.files['build-tool.sh']).toContain('--security-opt no-new-privileges');
    expect(context.files['build-tool.sh']).toContain('--sysctl net.ipv6.conf.all.disable_ipv6=1');
    expect(context.files['build-tool.sh']).toContain('--network none');
    expect(context.files['build-tool.sh']).not.toContain('--env AWS_ACCESS_KEY_ID');
    expect(context.files['build-tool.sh']).toContain('--user 65534:65534');
    expect(context.files['build-tool.sh']).toContain('"$core_ref" /workspace/fetch-source.mjs');
    expect(context.files['build-tool.sh']).not.toContain('\n  node fetch-source.mjs\n');
    expect(context.files['build-tool.sh']).toContain('normalized tool output exceeds 1536 MiB');
    expect(context.files['build-tool.sh']).toContain('managed-tools/sources/${retained_sha}');
    expect(context.files['fetch-source.mjs']).toContain(
      'publisher checksum evidence exceeds 1 MiB',
    );
    expect(context.files['Dockerfile.tool']).toContain('/opt/tool-metadata/sbom.spdx.json');
    expect(context.manifest).toMatchObject({
      coreImageDigest: `sha256:${'a'.repeat(64)}`,
      runtimeCompatibilityVersion: '1',
      retainedSource: {
        sha256: 'b'.repeat(64),
        trustLevel: 'PUBLISHER_VERIFIED',
      },
    });

    const directory = await mkdtemp(join(tmpdir(), 'managed-tool-context-'));
    temporaryDirectories.push(directory);
    for (const name of ['install.sh', 'verify.sh', 'build-tool.sh']) {
      const path = join(directory, name);
      await writeFile(path, context.files[name]);
      await expect(exec('bash', ['-n', path])).resolves.toBeDefined();
    }
  });

  it('validates dependent tools against exact published dependency artifacts', () => {
    const java = {
      toolId: 'java',
      name: 'Java JDK',
      category: 'language-sdk',
      publisher: 'Eclipse Temurin',
      versionId: 'tv-java-21',
      version: '21.0.8',
      imageUri: '111111111111.dkr.ecr.us-east-1.amazonaws.com/tools',
      imageDigest: `sha256:${'c'.repeat(64)}`,
      imageSizeBytes: 200,
      executables: javaTemplate.version.executables,
      dependencies: [],
      aptPackages: [],
      environmentVariables: javaTemplate.version.environmentVariables,
      verification: javaTemplate.version.verification,
    };
    const context = generateToolBuildContext({
      tool: mavenTemplate,
      version: {
        versionId: 'tv-maven-3',
        definition: mavenTemplate.version,
      },
      dependencies: [java],
      coreImageUri: '111111111111.dkr.ecr.us-east-1.amazonaws.com/core',
      coreImageDigest: `sha256:${'a'.repeat(64)}`,
    });

    expect(context.manifest.dependencies).toEqual([java]);
    expect(context.files['Dockerfile.validation']).toContain(
      `FROM ${java.imageUri}@${java.imageDigest} AS managed_dependency_0`,
    );
    expect(context.files['Dockerfile.validation']).toContain(
      'COPY --from=managed_dependency_0 /opt/tool/ /opt/managed/tools/java/21.0.8/',
    );
    expect(context.files['Dockerfile.validation']).toContain(
      'ENV JAVA_HOME="/opt/managed/tools/java/21.0.8"',
    );
  });

  it('rejects dependency artifacts that collide with the tool being built', () => {
    const conflicting = {
      toolId: 'other-build-tool',
      version: '1',
      imageUri: '111111111111.dkr.ecr.us-east-1.amazonaws.com/tools',
      imageDigest: `sha256:${'d'.repeat(64)}`,
      executables: [{ name: 'mvn', path: 'bin/other' }],
      dependencies: [],
      aptPackages: [],
      environmentVariables: {},
    };

    expect(() =>
      generateToolBuildContext({
        tool: mavenTemplate,
        version: {
          versionId: 'tv-maven-3',
          definition: mavenTemplate.version,
        },
        dependencies: [conflicting],
        coreImageUri: '111111111111.dkr.ecr.us-east-1.amazonaws.com/core',
        coreImageDigest: `sha256:${'a'.repeat(64)}`,
      }),
    ).toThrow('Executable mvn is provided by both other-build-tool and maven');
  });

  it('rejects archive entries that escape the extraction root', async () => {
    const context = generateToolBuildContext({
      tool: javaTemplate,
      version: { versionId: 'tv-java-21', definition: javaTemplate.version },
      coreImageUri: 'core',
      coreImageDigest: `sha256:${'a'.repeat(64)}`,
    });
    const directory = await mkdtemp(join(tmpdir(), 'managed-tool-archive-'));
    temporaryDirectories.push(directory);
    const inspector = join(directory, 'inspect-archive.py');
    const archive = join(directory, 'unsafe.zip');
    await writeFile(inspector, context.files['inspect-archive.py']);
    await exec('python3', [
      '-c',
      'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1],"w"); z.writestr("../escape","bad"); z.close()',
      archive,
    ]);

    await expect(exec('python3', [inspector, archive, 'zip'])).rejects.toMatchObject({
      stderr: expect.stringContaining('unsafe archive path'),
    });
  });

  it('adds recommended dependency versions and rejects dependency cycles', () => {
    const tools = [
      { toolId: 'java', recommendedVersionId: 'tv-21' },
      { toolId: 'maven', recommendedVersionId: 'tv-3' },
    ];
    const java = publishedVersion('java', 'tv-21');
    const maven = publishedVersion('maven', 'tv-3', ['java']);

    expect(
      resolveToolDependencies({
        selectedVersionIds: ['tv-3'],
        tools,
        versions: [java, maven],
      }).map((version) => version.toolId),
    ).toEqual(['java', 'maven']);

    const cyclicJava = publishedVersion('java', 'tv-21', ['maven']);
    expect(() =>
      resolveToolDependencies({
        selectedVersionIds: ['tv-3'],
        tools,
        versions: [cyclicJava, maven],
      }),
    ).toThrow('Tool dependency cycle detected');
  });
});
