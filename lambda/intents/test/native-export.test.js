import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { buildDistributionArchive } from '../../shared/distribution-archive.js';
import { fetchReleaseRuntimeFiles, fetchRepoFiles } from '../../shared/repo-fetch.js';
import {
  alignProjectionToDistribution,
  buildZip,
  createNativeExport,
  detectConstructionCapabilities,
  detectWorkspaceLayout,
  loadDistribution,
  loadReleaseDistribution,
  loadCustomRules,
  registerNativeScope,
  resolveRulesDir,
  safeArchivePath,
  shouldShowWorkspaceSetup,
  workspaceSyncCommand,
} from '../native-export.js';

import { publishReleaseDistributions } from '../../shared/release-distributions.js';
import { AIDLC_COMPATIBILITY_PROFILES } from '../../shared/aidlc-compatibility-profiles.js';
vi.mock('../../shared/repo-fetch.js', () => ({
  fetchReleaseRuntimeFiles: vi.fn(),
  fetchRepoFiles: vi.fn(),
}));

const hash = (body) => createHash('sha256').update(body).digest('hex');
const REF = '1111111111111111111111111111111111111111';

const distribution = async () => {
  const body = Buffer.from('# Native harness\n');
  const activeSpace = Buffer.from('default\n');
  const harnessMetadata = Buffer.from(
    JSON.stringify({ harnessDir: '.codex', rulesSubdir: 'aidlc-rules' }),
  );
  const stageFile = Buffer.from(`---
slug: intent-capture
number: "1.1"
name: Intent Capture
phase: ideation
execution: ALWAYS
condition: Always
lead_agent: aidlc-product-agent
support_agents: []
mode: inline
produces:
  - intent-statement
consumes: []
requires_stage: []
sensors: []
scopes:
  - feature
  - mvp
inputs: task
outputs: intent
---

# Intent Capture
`);
  const featureScope = Buffer.from(`---
name: feature
depth: Standard
keywords: []
description: Feature
---

# feature scope
`);
  const scopeGrid = Buffer.from(
    `${JSON.stringify(
      {
        feature: { stages: { 'intent-capture': 'EXECUTE' } },
        mvp: { stages: { 'intent-capture': 'EXECUTE' } },
      },
      null,
      2,
    )}\n`,
  );
  const graph = Buffer.from(
    `${JSON.stringify(
      [
        {
          slug: 'intent-capture',
          number: '1.1',
          phase: 'ideation',
          lead_agent: 'aidlc-product-agent',
          produces: ['intent-statement'],
          scopes: ['feature', 'mvp'],
        },
      ],
      null,
      2,
    )}\n`,
  );
  const distributionFiles = new Map([
    ['AGENTS.md', body],
    ['aidlc/active-space', activeSpace],
    ['.codex/aidlc-common/stages/ideation/intent-capture.md', stageFile],
    ['.codex/scopes/aidlc-feature.md', featureScope],
    ['.codex/tools/data/harness.json', harnessMetadata],
    ['.codex/tools/data/scope-grid.json', scopeGrid],
    ['.codex/tools/data/stage-graph.json', graph],
  ]);
  const archive = await buildDistributionArchive(distributionFiles);
  const files = [...distributionFiles].map(([path, value]) => ({
    path,
    bytes: value.length,
    sha256: hash(value),
  }));
  const manifest = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      ref: REF,
      harness: 'codex',
      workspaceLayout: 'spaces',
      archive: 'codex.tar.gz',
      archiveBytes: archive.length,
      archiveSha256: hash(archive),
      files,
    }),
  );
  return {
    activeSpace,
    archive,
    body,
    distributionFiles,
    graph,
    harnessMetadata,
    manifest,
  };
};

describe('native workflow export', () => {
  it('rejects unsafe archive paths', () => {
    expect(() => safeArchivePath('../secret')).toThrow(/unsafe distribution path/);
    expect(() => safeArchivePath('/absolute')).toThrow(/unsafe distribution path/);
  });

  it('loads only checksum-valid distribution files', async () => {
    const { archive, body, manifest } = await distribution();
    const s3 = {
      send: vi.fn(async (command) => {
        expect(command).toBeInstanceOf(GetObjectCommand);
        return {
          Body: command.input.Key.endsWith('codex.manifest.json') ? manifest : archive,
        };
      }),
    };
    const result = await loadDistribution({
      s3,
      bucket: 'artifacts',
      upstreamRef: REF,
      harness: 'codex',
    });
    expect(result.files.get('AGENTS.md')).toEqual(body);
    expect(result.workspaceLayout).toBe('spaces');
    expect(s3.send).toHaveBeenCalledTimes(2);
  });

  // A custom fork release's own distribution, captured at import.
  const FORK_KEY_ARGS = {
    sha: '3333333333333333333333333333333333333333',
    importerRevision: 3,
    custom: true,
    sourceRepository: 'acme/aidlc-fork',
  };
  const memoryS3 = () => {
    const objects = new Map();
    return {
      objects,
      send: vi.fn(async (command) => {
        const { Key, Body } = command.input;
        if (command instanceof PutObjectCommand) {
          objects.set(Key, Buffer.isBuffer(Body) ? Body : Buffer.from(Body));
          return {};
        }
        if (!objects.has(Key)) {
          // As in production: GetObject without ListBucket masks a miss as 403.
          throw Object.assign(new Error('AccessDenied'), { $metadata: { httpStatusCode: 403 } });
        }
        const body = objects.get(Key);
        return {
          Body: Object.assign(body, { transformToString: async () => body.toString('utf8') }),
        };
      }),
    };
  };

  it("loads a custom release's own distribution from release storage", async () => {
    fetchRepoFiles.mockClear();
    const { body, distributionFiles } = await distribution();
    const s3 = memoryS3();
    await publishReleaseDistributions({
      s3,
      bucket: 'artifacts',
      keyArgs: FORK_KEY_ARGS,
      distributions: new Map([['codex', distributionFiles]]),
    });
    const loaded = await loadReleaseDistribution({
      s3,
      bucket: 'artifacts',
      keyArgs: FORK_KEY_ARGS,
      harness: 'codex',
    });
    expect(loaded.files.get('AGENTS.md')).toEqual(body);
    expect(loaded.workspaceLayout).toBe('spaces');
    expect(fetchRepoFiles).not.toHaveBeenCalled();
  });

  it('returns null when the release ships no distribution for the harness', async () => {
    const s3 = memoryS3();
    await expect(
      loadReleaseDistribution({ s3, bucket: 'artifacts', keyArgs: FORK_KEY_ARGS, harness: 'kiro' }),
    ).resolves.toBeNull();
    await expect(
      loadReleaseDistribution({ s3, bucket: 'artifacts', keyArgs: FORK_KEY_ARGS, harness: 'vim' }),
    ).rejects.toThrow('unsupported harness vim');
  });

  it("refuses a release distribution whose archive doesn't match its manifest", async () => {
    const { distributionFiles } = await distribution();
    const s3 = memoryS3();
    await publishReleaseDistributions({
      s3,
      bucket: 'artifacts',
      keyArgs: FORK_KEY_ARGS,
      distributions: new Map([['codex', distributionFiles]]),
    });
    const archiveKey = [...s3.objects.keys()].find((key) => key.endsWith('/dist/codex.tar.gz'));
    s3.objects.set(archiveKey, Buffer.from('tampered'));
    await expect(
      loadReleaseDistribution({
        s3,
        bucket: 'artifacts',
        keyArgs: FORK_KEY_ARGS,
        harness: 'codex',
      }),
    ).rejects.toThrow('checksum mismatch');
  });

  it('detects legacy workspaces from the scaffold graph when aidlc/ is absent', () => {
    const graph = Buffer.from(
      JSON.stringify([
        {
          slug: 'workspace-scaffold',
          name: 'Workspace Scaffold',
          outputs: 'aidlc-docs/ directory tree',
        },
      ]),
    );
    expect(
      detectWorkspaceLayout({
        harness: 'codex',
        files: new Map([['.codex/tools/data/stage-graph.json', graph]]),
      }),
    ).toBe('flat');
  });

  it('detects deterministic per-unit iteration from the harness implementation', () => {
    const metadata = Buffer.from(
      JSON.stringify({ harnessDir: '.codex', rulesSubdir: 'aidlc-rules' }),
    );
    expect(
      detectConstructionCapabilities({
        harness: 'codex',
        distributionFiles: new Map([
          ['.codex/tools/data/harness.json', metadata],
          ['.codex/tools/aidlc-orchestrate.ts', Buffer.from('function emitPerUnitRunStage() {}')],
        ]),
      }),
    ).toEqual({ perUnitIteration: true });
    expect(
      detectConstructionCapabilities({
        harness: 'codex',
        distributionFiles: new Map([
          ['.codex/tools/data/harness.json', metadata],
          ['.codex/tools/aidlc-orchestrate.ts', Buffer.from('function emitRunStage() {}')],
        ]),
      }),
    ).toEqual({ perUnitIteration: false });
  });

  it('detects workspace sync only when the selected harness ships the tool', () => {
    expect(
      workspaceSyncCommand({
        harness: 'codex',
        distributionFiles: new Map(),
      }),
    ).toBeNull();
    expect(
      workspaceSyncCommand({
        harness: 'codex',
        distributionFiles: new Map([['.codex/tools/aidlc-workspace-sync.ts', Buffer.alloc(0)]]),
      }),
    ).toBe('bun .codex/tools/aidlc-workspace-sync.ts');
  });

  it('identifies the final Inception checkpoint and later workspace setup boundaries', () => {
    expect(
      shouldShowWorkspaceSetup([
        { phase: 'inception', marker: '-' },
        { phase: 'construction', marker: ' ' },
      ]),
    ).toBe(true);
    expect(
      shouldShowWorkspaceSetup([
        { phase: 'inception', marker: '-' },
        { phase: 'inception', marker: ' ' },
        { phase: 'construction', marker: ' ' },
      ]),
    ).toBe(false);
    expect(shouldShowWorkspaceSetup([{ phase: 'construction', marker: '-' }])).toBe(true);
    expect(shouldShowWorkspaceSetup([{ phase: 'operation', marker: '-' }])).toBe(true);
    expect(
      shouldShowWorkspaceSetup([
        { phase: 'construction', marker: 'x' },
        { phase: 'operation', marker: 'x' },
      ]),
    ).toBe(true);
  });

  it.each([
    ['NoSuchKey', { name: 'NoSuchKey' }],
    ['a masked 403', { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } }],
  ])('downloads and caches a harness after %s cache misses', async (_name, errorFields) => {
    const { distributionFiles } = await distribution();
    fetchRepoFiles.mockResolvedValueOnce(
      new Map([...distributionFiles].map(([path, value]) => [`dist/codex/${path}`, value])),
    );
    const puts = [];
    const s3 = {
      send: vi.fn(async (command) => {
        if (command instanceof PutObjectCommand) {
          puts.push(command.input);
          return {};
        }
        const error = new Error('missing');
        Object.assign(error, errorFields);
        throw error;
      }),
    };
    const result = await loadDistribution({
      s3,
      bucket: 'artifacts',
      upstreamRef: REF,
      harness: 'codex',
    });
    expect(fetchRepoFiles).toHaveBeenCalledWith(REF, {
      prefixes: ['dist/codex/'],
      maxFiles: 1_000,
      maxRetainedBytes: 20 * 1024 * 1024,
    });
    expect(result.workspaceLayout).toBe('spaces');
    expect(puts.map((put) => put.Key)).toEqual([
      `aidlc-distributions/${REF}/codex.tar.gz`,
      `aidlc-distributions/${REF}/codex.manifest.json`,
    ]);
  });

  it('refetches when a current cache manifest exists without its archive', async () => {
    fetchRepoFiles.mockClear();
    const { distributionFiles, manifest } = await distribution();
    fetchRepoFiles.mockResolvedValueOnce(
      new Map([...distributionFiles].map(([path, value]) => [`dist/codex/${path}`, value])),
    );
    const s3 = {
      send: vi.fn(async (command) => {
        if (command instanceof PutObjectCommand) return {};
        if (command.input.Key.endsWith('codex.manifest.json')) return { Body: manifest };
        const error = new Error('missing');
        error.name = 'NoSuchKey';
        throw error;
      }),
    };

    const result = await loadDistribution({
      s3,
      bucket: 'artifacts',
      upstreamRef: REF,
      harness: 'codex',
    });

    expect(result.workspaceLayout).toBe('spaces');
    expect(fetchRepoFiles).toHaveBeenCalledOnce();
  });

  // repo-fetch rejects (it never returns unmatched/empty results), so
  // loadDistribution classifies its rejection into retryable vs deterministic.
  const cacheMissS3 = () => ({
    send: vi.fn(async () => {
      const error = new Error('missing');
      error.name = 'NoSuchKey';
      throw error;
    }),
  });
  const loadRejection = (s3) =>
    loadDistribution({ s3, bucket: 'artifacts', upstreamRef: REF, harness: 'codex' }).then(
      () => null,
      (error) => error,
    );

  it('tags an upstream 5xx distribution-fetch failure as retryable (502)', async () => {
    fetchRepoFiles.mockClear();
    fetchRepoFiles.mockRejectedValueOnce(
      new Error(`repo-fetch: https://codeload.github.com/x returned 503 Service Unavailable`),
    );

    await expect(loadRejection(cacheMissS3())).resolves.toMatchObject({
      code: 'export_source_unavailable',
    });
  });

  it('tags a raw network distribution-fetch failure as retryable (502)', async () => {
    fetchRepoFiles.mockClear();
    fetchRepoFiles.mockRejectedValueOnce(new Error('fetch failed'));

    await expect(loadRejection(cacheMissS3())).resolves.toMatchObject({
      code: 'export_source_unavailable',
    });
  });

  it('treats a missing distribution (no matching files) as deterministic', async () => {
    fetchRepoFiles.mockClear();
    fetchRepoFiles.mockRejectedValueOnce(
      new Error(`repo-fetch: no files found for prefixes dist/codex/ in tarball for ref ${REF}`),
    );

    const rejection = await loadRejection(cacheMissS3());
    expect(rejection).toBeInstanceOf(Error);
    expect(rejection.code).toBeUndefined();
    expect(rejection.message).toContain('could not be loaded');
  });

  it('treats a distribution size-limit breach as deterministic', async () => {
    fetchRepoFiles.mockClear();
    fetchRepoFiles.mockRejectedValueOnce(
      new Error('repo-fetch: matching files exceed 20971520 bytes'),
    );

    const rejection = await loadRejection(cacheMissS3());
    expect(rejection).toBeInstanceOf(Error);
    expect(rejection.code).toBeUndefined();
  });

  // Releases from 2.8.2 ship their harnesses only in a release runtime asset.
  describe('a release that ships its harnesses as a runtime asset', () => {
    // 2.11.3's runtime is in the preview release built from its commit; the
    // v2.11.3 tag names a later commit.
    const PROFILE = AIDLC_COMPATIBILITY_PROFILES['v2.11.3'];
    const TAG = 'v2.11.3-preview.20261103.1';
    const RUNTIME_REF = PROFILE.upstreamRef;
    const noDist = (ref) =>
      new Error(`repo-fetch: no files found for prefixes dist/codex/ in tarball for ref ${ref}`);
    const loadRuntime = (s3) =>
      loadDistribution({ s3, bucket: 'artifacts', upstreamRef: RUNTIME_REF, harness: 'codex' });
    const rejectionOf = (promise) =>
      promise.then(
        () => null,
        (error) => error,
      );

    it("loads the profile's release runtime when the commit has no dist/, then reuses the cache", async () => {
      fetchRepoFiles.mockReset();
      fetchReleaseRuntimeFiles.mockReset();
      const { body, distributionFiles } = await distribution();
      fetchRepoFiles.mockRejectedValueOnce(noDist(RUNTIME_REF));
      fetchReleaseRuntimeFiles.mockResolvedValueOnce(
        new Map([...distributionFiles].map(([path, value]) => [`runtime/codex/${path}`, value])),
      );
      const s3 = memoryS3();

      const result = await loadRuntime(s3);

      expect(fetchReleaseRuntimeFiles).toHaveBeenCalledWith(TAG, {
        commit: RUNTIME_REF,
        prefixes: ['runtime/codex/'],
        maxFiles: 1_000,
        maxRetainedBytes: 20 * 1024 * 1024,
      });
      expect(result.files.get('AGENTS.md')).toEqual(body);
      expect(result.workspaceLayout).toBe('spaces');
      const manifest = JSON.parse(
        s3.objects.get(`aidlc-distributions/${RUNTIME_REF}/codex.manifest.json`).toString('utf8'),
      );
      expect(manifest).toMatchObject({
        ref: RUNTIME_REF,
        harness: 'codex',
        source: { releaseTag: TAG, path: 'runtime/codex/' },
      });
      expect(manifest.files.map((file) => file.path)).toContain('AGENTS.md');

      const cached = await loadRuntime(s3);
      expect(cached.files.get('AGENTS.md')).toEqual(body);
      expect(fetchRepoFiles).toHaveBeenCalledOnce();
      expect(fetchReleaseRuntimeFiles).toHaveBeenCalledOnce();
    });

    it('keeps reading dist/ when the commit has it', async () => {
      fetchRepoFiles.mockReset();
      fetchReleaseRuntimeFiles.mockReset();
      const { distributionFiles } = await distribution();
      fetchRepoFiles.mockResolvedValueOnce(
        new Map([...distributionFiles].map(([path, value]) => [`dist/codex/${path}`, value])),
      );
      const s3 = memoryS3();

      await loadRuntime(s3);

      expect(fetchReleaseRuntimeFiles).not.toHaveBeenCalled();
      expect(
        JSON.parse(
          s3.objects.get(`aidlc-distributions/${RUNTIME_REF}/codex.manifest.json`).toString(),
        ).source,
      ).toEqual({ path: 'dist/codex/' });
    });

    it('refuses a commit with no dist/ and no known release runtime (409)', async () => {
      fetchRepoFiles.mockReset();
      fetchReleaseRuntimeFiles.mockReset();
      fetchRepoFiles.mockRejectedValueOnce(noDist(REF));

      const rejection = await loadRejection(cacheMissS3());

      expect(rejection.code).toBeUndefined();
      expect(rejection.message).toMatch(/^native-export: codex distribution could not be loaded/);
      expect(rejection.message).toContain('no AI-DLC release runtime is known for this commit');
      expect(fetchReleaseRuntimeFiles).not.toHaveBeenCalled();
    });

    it.each([
      ['an identity mismatch', `repo-fetch: release v2.11.4 was built from ${REF}, not x`],
      [
        'a checksum mismatch',
        'repo-fetch: aidlc-runtime-2.11.4.tar.gz does not match its checksum',
      ],
      ['a missing release', 'repo-fetch: https://github.com/x/version.json returned 404 Not Found'],
      ['a missing harness', 'repo-fetch: no files found for prefixes runtime/codex/ in x'],
    ])('refuses a release runtime with %s as deterministic (409)', async (_label, message) => {
      fetchRepoFiles.mockReset();
      fetchReleaseRuntimeFiles.mockReset();
      fetchRepoFiles.mockRejectedValueOnce(noDist(RUNTIME_REF));
      fetchReleaseRuntimeFiles.mockRejectedValueOnce(new Error(message));
      const s3 = memoryS3();

      const rejection = await rejectionOf(loadRuntime(s3));

      expect(rejection.code).toBeUndefined();
      expect(rejection.message).toBe(
        `native-export: codex distribution could not be loaded for ${RUNTIME_REF}: ${message}`,
      );
      expect(s3.objects.size).toBe(0);
    });

    it.each([
      ['a 5xx', 'repo-fetch: https://github.com/x/aidlc-runtime-2.11.4.tar.gz returned 502 Bad'],
      ['a 429', 'repo-fetch: https://github.com/x/version.json returned 429 Too Many Requests'],
      ['a network failure', 'fetch failed'],
    ])('tags %s fetching the release runtime as retryable (502)', async (_label, message) => {
      fetchRepoFiles.mockReset();
      fetchReleaseRuntimeFiles.mockReset();
      fetchRepoFiles.mockRejectedValueOnce(noDist(RUNTIME_REF));
      fetchReleaseRuntimeFiles.mockRejectedValueOnce(new Error(message));

      await expect(rejectionOf(loadRuntime(memoryS3()))).resolves.toMatchObject({
        code: 'export_source_unavailable',
      });
    });

    it('does not fall back to the release runtime when dist/ is only temporarily unavailable', async () => {
      fetchRepoFiles.mockReset();
      fetchReleaseRuntimeFiles.mockReset();
      fetchRepoFiles.mockRejectedValueOnce(
        new Error('repo-fetch: https://codeload.github.com/x returned 503 Service Unavailable'),
      );

      await expect(rejectionOf(loadRuntime(memoryS3()))).resolves.toMatchObject({
        code: 'export_source_unavailable',
      });
      expect(fetchReleaseRuntimeFiles).not.toHaveBeenCalled();
    });

    // 2.11.3 and 2.11.4 ship requirements-analysis with an `outputs` value whose
    // embedded `Step 10: ` is not valid YAML. Exporting a scope the distribution
    // lacks rewrites that stage's scopes, so its frontmatter must be parsed with
    // the import's normalization.
    const RA_OUTPUTS =
      "outputs: requirements.md, requirements-analysis-questions.md, traceability.json (Step 10: an `ids` list with one entry per FR and NFR ID, spelled exactly as requirements.md spells it, each with `kind` functional or non-functional and, for a sub-requirement, `of` its requirement) (under this stage's record dir, engine-resolved)";
    const RA_PATH = '.codex/aidlc-common/stages/inception/requirements-analysis.md';
    const withRequirementsAnalysis = (distributionFiles) => {
      const files = new Map(distributionFiles);
      files.set(
        RA_PATH,
        Buffer.from(`---
slug: requirements-analysis
number: "2.2"
name: Requirements Analysis
phase: inception
execution: ALWAYS
lead_agent: aidlc-product-agent
produces:
  - requirements
scopes:
  - feature
inputs: intent-statement.md
${RA_OUTPUTS}
---

# Requirements Analysis
`),
      );
      const graph = JSON.parse(files.get('.codex/tools/data/stage-graph.json').toString());
      graph.push({
        slug: 'requirements-analysis',
        number: '2.2',
        phase: 'inception',
        lead_agent: 'aidlc-product-agent',
        produces: ['requirements'],
        scopes: ['feature'],
      });
      files.set('.codex/tools/data/stage-graph.json', Buffer.from(JSON.stringify(graph)));
      const grid = JSON.parse(files.get('.codex/tools/data/scope-grid.json').toString());
      grid.feature.stages['requirements-analysis'] = 'EXECUTE';
      grid.mvp.stages['requirements-analysis'] = 'SKIP';
      files.set('.codex/tools/data/scope-grid.json', Buffer.from(JSON.stringify(grid)));
      return files;
    };
    const customScopeExport = (overrides) =>
      createNativeExport({
        bucket: 'artifacts',
        harness: 'codex',
        now: '2026-08-11T12:00:00.000Z',
        presign: vi.fn().mockResolvedValue('https://download.example/export.zip'),
        projection: {
          intent: {
            projectId: 'project-1',
            intentId: 'intent-1',
            title: 'Payment service',
            prompt: 'Add payments',
            scope: 'feature-custom',
            workflowId: 'aidlc-v2',
            workflowVersion: 4,
            createdAt: '2026-08-11T10:00:00.000Z',
          },
          stages: [
            { stageId: 'intent-capture', phase: 'ideation' },
            { stageId: 'requirements-analysis', phase: 'inception' },
          ],
          stageRows: [],
          artifacts: [],
          humanTasks: [],
          repositories: [],
        },
        ...overrides,
      });
    // Reads the export ZIP through its central directory.
    const unzip = (zip) => {
      const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
      const entries = new Map();
      let offset = zip.readUInt32LE(eocd + 16);
      for (let count = zip.readUInt16LE(eocd + 10); count > 0; count -= 1) {
        const method = zip.readUInt16LE(offset + 10);
        const size = zip.readUInt32LE(offset + 20);
        const nameLength = zip.readUInt16LE(offset + 28);
        const local = zip.readUInt32LE(offset + 42);
        const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
        const data = zip.subarray(start, start + size);
        entries.set(
          zip.toString('utf8', offset + 46, offset + 46 + nameLength),
          method === 8 ? inflateRawSync(data) : data,
        );
        offset += 46 + nameLength + zip.readUInt16LE(offset + 30) + zip.readUInt16LE(offset + 32);
      }
      return entries;
    };
    const exportedFiles = (s3) =>
      unzip(
        [...s3.objects].find(([key]) => key.startsWith('workflow-exports/'))?.[1] ??
          Buffer.alloc(0),
      );

    it.each(['v2.11.3', 'v2.11.4'])(
      'exports a custom scope from the %s release runtime',
      async (profileId) => {
        fetchRepoFiles.mockReset();
        fetchReleaseRuntimeFiles.mockReset();
        const profile = AIDLC_COMPATIBILITY_PROFILES[profileId];
        const { distributionFiles } = await distribution();
        fetchRepoFiles.mockRejectedValueOnce(noDist(profile.upstreamRef));
        fetchReleaseRuntimeFiles.mockResolvedValueOnce(
          new Map(
            [...withRequirementsAnalysis(distributionFiles)].map(([path, value]) => [
              `runtime/codex/${path}`,
              value,
            ]),
          ),
        );
        const s3 = memoryS3();

        const result = await customScopeExport({ s3, upstreamRef: profile.upstreamRef });

        expect(result.downloadUrl).toBe('https://download.example/export.zip');
        const stage = exportedFiles(s3).get(RA_PATH).toString();
        expect(stage).toContain('scopes:\n  - feature\n  - feature-custom\n');
        // Only the scopes block changes: the file keeps upstream's own text.
        expect(stage).toContain(`\n${RA_OUTPUTS}\n`);
      },
    );

    it("exports a custom scope from a custom release's own distribution in its base dialect", async () => {
      fetchRepoFiles.mockReset();
      const { distributionFiles } = await distribution();
      const s3 = memoryS3();

      await customScopeExport({
        s3,
        upstreamRef: '3333333333333333333333333333333333333333',
        preloadedDistribution: {
          files: withRequirementsAnalysis(distributionFiles),
          workspaceLayout: 'spaces',
        },
        frontmatterProfile: AIDLC_COMPATIBILITY_PROFILES['v2.11.4'],
      });

      expect(exportedFiles(s3).get(RA_PATH).toString()).toContain('  - feature-custom\n');
      expect(fetchRepoFiles).not.toHaveBeenCalled();
    });

    it('refuses frontmatter no known dialect parses as deterministic (409), not a crash', async () => {
      const { distributionFiles } = await distribution();

      const rejection = await rejectionOf(
        customScopeExport({
          s3: memoryS3(),
          upstreamRef: '3333333333333333333333333333333333333333',
          preloadedDistribution: {
            files: withRequirementsAnalysis(distributionFiles),
            workspaceLayout: 'spaces',
          },
        }),
      );

      expect(rejection.code).toBeUndefined();
      expect(rejection.message).toBe(
        `native-export: stage file has invalid frontmatter: ${RA_PATH}`,
      );
    });
  });

  it('creates a zip buffer', async () => {
    const zip = await buildZip(new Map([['AGENTS.md', Buffer.from('# Agent\n')]]));
    expect(zip.subarray(0, 2).toString()).toBe('PK');
  });

  it('marks every native stage omitted by the cloud plan as skipped', () => {
    const graph = Buffer.from(
      JSON.stringify([
        { slug: 'intent-capture', phase: 'ideation', scopes: ['feature'] },
        { slug: 'requirements-analysis', phase: 'inception', scopes: ['feature'] },
      ]),
    );
    const aligned = alignProjectionToDistribution({
      harness: 'codex',
      distributionFiles: new Map([['.codex/tools/data/stage-graph.json', graph]]),
      projection: {
        intent: { scope: 'feature' },
        stages: [{ stageId: 'requirements-analysis', phase: 'inception' }],
      },
    });
    expect(aligned.stages).toEqual([
      expect.objectContaining({ stageId: 'intent-capture', excluded: true }),
      expect.objectContaining({ stageId: 'requirements-analysis', excluded: false }),
    ]);
  });

  it('rejects a stage the native harness lacks unless omission is allowed', () => {
    const graph = Buffer.from(
      JSON.stringify([{ slug: 'requirements-analysis', phase: 'inception', scopes: ['feature'] }]),
    );
    const distributionFiles = new Map([['.codex/tools/data/stage-graph.json', graph]]);
    const projection = {
      intent: { scope: 'feature' },
      stages: [
        { stageId: 'requirements-analysis', phase: 'inception' },
        { stageId: 'fork-handoff', phase: 'operation' },
      ],
      stageRows: [{ stageId: 'requirements-analysis', state: 'SUCCEEDED' }],
    };
    expect(() =>
      alignProjectionToDistribution({ harness: 'codex', distributionFiles, projection }),
    ).toThrow('stages are not present in the native harness: fork-handoff');
    const aligned = alignProjectionToDistribution({
      harness: 'codex',
      distributionFiles,
      projection,
      omitStagesNotInDistribution: true,
    });
    expect(aligned.stages.map((stage) => stage.stageId)).toEqual(['requirements-analysis']);
    expect(aligned.omittedStages).toEqual(['fork-handoff']);
  });
  it('still rejects an omitted stage that has recorded work', () => {
    const graph = Buffer.from(
      JSON.stringify([{ slug: 'requirements-analysis', phase: 'inception', scopes: ['feature'] }]),
    );
    expect(() =>
      alignProjectionToDistribution({
        harness: 'codex',
        distributionFiles: new Map([['.codex/tools/data/stage-graph.json', graph]]),
        omitStagesNotInDistribution: true,
        projection: {
          intent: { scope: 'feature' },
          stages: [
            { stageId: 'requirements-analysis', phase: 'inception' },
            { stageId: 'fork-handoff', phase: 'operation' },
          ],
          stageRows: [{ stageId: 'fork-handoff', state: 'RUNNING' }],
        },
      }),
    ).toThrow('stages with recorded work are not present in the native harness: fork-handoff');
  });
  it('registers an arbitrary custom scope in stage metadata and compiled data', async () => {
    const { distributionFiles } = await distribution();
    const result = registerNativeScope({
      distributionFiles,
      harness: 'codex',
      scope: 'payments-critical-path',
      stages: [{ stageId: 'intent-capture', excluded: false }],
    });
    expect(result.scope).toBe('payments-critical-path');
    expect(result.registered).toBe(true);
    expect(result.files.get('.codex/scopes/aidlc-payments-critical-path.md').toString()).toContain(
      'name: payments-critical-path',
    );
    expect(
      result.files.get('.codex/aidlc-common/stages/ideation/intent-capture.md').toString(),
    ).toContain('- payments-critical-path');
    expect(
      JSON.parse(result.files.get('.codex/tools/data/scope-grid.json').toString())[
        'payments-critical-path'
      ].stages,
    ).toEqual({ 'intent-capture': 'EXECUTE' });
    expect(
      JSON.parse(result.files.get('.codex/tools/data/stage-graph.json').toString())[0].scopes,
    ).toContain('payments-critical-path');
  });

  it('leaves an existing matching native scope unchanged', async () => {
    const { distributionFiles } = await distribution();
    const result = registerNativeScope({
      distributionFiles,
      harness: 'codex',
      scope: 'feature',
      stages: [{ stageId: 'intent-capture', excluded: false }],
    });
    expect(result.registered).toBe(false);
    expect(result.files).toBe(distributionFiles);
  });

  it('resolves the native rules directory from harness metadata', () => {
    expect(
      resolveRulesDir({
        harness: 'codex',
        distributionFiles: new Map([
          [
            '.codex/tools/data/harness.json',
            Buffer.from(JSON.stringify({ harnessDir: '.codex', rulesSubdir: 'aidlc-rules' })),
          ],
        ]),
      }),
    ).toBe('.codex/aidlc-rules');
  });

  it('copies project rules into the selected harness native rules directory', async () => {
    const s3 = {
      send: vi.fn(async (command) => {
        expect(command.input.VersionId).toBe('rule-version-1');
        return { Body: Buffer.from('Always test.\n') };
      }),
    };
    const files = await loadCustomRules({
      s3,
      bucket: 'artifacts',
      harness: 'codex',
      distributionFiles: new Map([
        [
          '.codex/tools/data/harness.json',
          Buffer.from(JSON.stringify({ harnessDir: '.codex', rulesSubdir: 'aidlc-rules' })),
        ],
      ]),
      projectId: 'p1',
      customRules: [
        {
          filename: 'standards.md',
          s3Key: 'custom-rules/p1/standards.md',
          versionId: 'rule-version-1',
        },
      ],
    });
    expect(files.get('.codex/aidlc-rules/custom--standards.md').toString()).toBe('Always test.\n');
  });

  it.each([
    [
      'another project key',
      { filename: 'standards.md', s3Key: 'custom-rules/p2/standards.md', versionId: 'v-1' },
    ],
    [
      'a nested key',
      { filename: 'standards.md', s3Key: 'custom-rules/p1/x/standards.md', versionId: 'v-1' },
    ],
    [
      'a mismatched filename',
      { filename: 'other.md', s3Key: 'custom-rules/p1/standards.md', versionId: 'v-1' },
    ],
    ['no versionId', { filename: 'standards.md', s3Key: 'custom-rules/p1/standards.md' }],
    [
      'an empty versionId',
      { filename: 'standards.md', s3Key: 'custom-rules/p1/standards.md', versionId: '' },
    ],
  ])('refuses a custom rule ref with %s before reading S3', async (_label, rule) => {
    const s3 = { send: vi.fn(async () => ({ Body: Buffer.from('foreign\n') })) };
    await expect(
      loadCustomRules({
        s3,
        bucket: 'artifacts',
        harness: 'codex',
        distributionFiles: new Map([
          [
            '.codex/tools/data/harness.json',
            Buffer.from(JSON.stringify({ harnessDir: '.codex', rulesSubdir: 'aidlc-rules' })),
          ],
        ]),
        projectId: 'p1',
        customRules: [rule],
      }),
    ).rejects.toThrow(/^native-export: /);
    expect(s3.send).not.toHaveBeenCalled();
  });

  it('fails an export whose checkpoint pins another project rule', async () => {
    const { archive, manifest } = await distribution();
    const ruleReads = [];
    const s3 = {
      send: vi.fn(async (command) => {
        if (command instanceof PutObjectCommand) return {};
        if (command.input.Key.startsWith('custom-rules/')) {
          ruleReads.push(command.input.Key);
          return { Body: Buffer.from('foreign\n') };
        }
        return {
          Body: command.input.Key.endsWith('codex.manifest.json') ? manifest : archive,
        };
      }),
    };
    await expect(
      createNativeExport({
        s3,
        bucket: 'artifacts',
        upstreamRef: REF,
        harness: 'codex',
        now: '2026-08-11T12:00:00.000Z',
        presign: vi.fn().mockResolvedValue('https://download.example/export.zip'),
        projection: {
          intent: {
            projectId: 'project-1',
            intentId: 'intent-1',
            title: 'Payment service',
            prompt: 'Add payments',
            scope: 'feature',
            workflowId: 'aidlc-v2',
            workflowVersion: 4,
            createdAt: '2026-08-11T10:00:00.000Z',
            customRules: [
              {
                filename: 'secrets.md',
                s3Key: 'custom-rules/project-2/secrets.md',
                versionId: 'v-1',
              },
            ],
          },
          stages: [{ stageId: 'intent-capture', phase: 'ideation' }],
          stageRows: [],
          artifacts: [],
          humanTasks: [],
          repositories: [],
        },
      }),
    ).rejects.toThrow(/^native-export: invalid custom rule reference custom-rules\/project-2\//);
    expect(ruleReads).toEqual([]);
  });

  it('stores a projected native workspace and returns a signed download', async () => {
    const { archive, manifest } = await distribution();
    const puts = [];
    const s3 = {
      send: vi.fn(async (command) => {
        if (command instanceof PutObjectCommand) {
          puts.push(command.input);
          return {};
        }
        return {
          Body: command.input.Key.endsWith('codex.manifest.json') ? manifest : archive,
        };
      }),
    };
    const presign = vi.fn().mockResolvedValue('https://download.example/export.zip');
    const sourceCheckpoint = {
      checkpointId: 'checkpoint-abc',
      createdAt: '2026-08-11T11:30:00.000Z',
      sourceStageInstanceId: 'intent-capture',
    };
    const result = await createNativeExport({
      s3,
      bucket: 'artifacts',
      upstreamRef: REF,
      harness: 'codex',
      now: '2026-08-11T12:00:00.000Z',
      presign,
      sourceCheckpoint,
      warnings: ['Existing warning.'],
      projection: {
        intent: {
          projectId: 'project-1',
          intentId: 'intent-1',
          title: 'Payment service',
          prompt: 'Add payments',
          scope: 'feature',
          workflowId: 'aidlc-v2',
          workflowVersion: 4,
          createdAt: '2026-08-11T10:00:00.000Z',
        },
        stages: [{ stageId: 'intent-capture', phase: 'ideation' }],
        stageRows: [],
        artifacts: [],
        humanTasks: [
          {
            humanTaskId: 'approval-1',
            kind: 'approval',
            status: 'answered',
          },
        ],
        repositories: [
          {
            id: 'example/api',
            directory: 'api',
            url: 'git@github.com:example/api.git',
            branch: 'aidlc/payment-service',
          },
          {
            id: 'example/web',
            directory: 'web',
            url: 'git@github.com:example/web.git',
            branch: 'aidlc/payment-service',
          },
        ],
      },
    });
    expect(result.downloadUrl).toBe('https://download.example/export.zip');
    expect(result.filename).toBe('260811-payment-service-codex.zip');
    expect(result.checkpoint).toEqual(sourceCheckpoint);
    expect(result.warnings).toEqual([
      'Existing warning.',
      'Non-question workflow gates are not represented as native question artifacts: approval.',
    ]);
    expect(result.setup).toEqual({
      workspaceLayout: 'spaces',
      mode: 'manual-workspace',
      harnessDir: '.codex',
      launchCommand: 'codex',
      continueCommand: '$aidlc',
      showWorkspaceSetup: false,
      repositories: [
        {
          id: 'example/api',
          directory: 'api',
          url: 'git@github.com:example/api.git',
          branch: 'aidlc/payment-service',
        },
        {
          id: 'example/web',
          directory: 'web',
          url: 'git@github.com:example/web.git',
          branch: 'aidlc/payment-service',
        },
      ],
    });
    expect(puts).toHaveLength(1);
    expect(puts[0].Key).toMatch(/^workflow-exports\/intent-1\/.+\.zip$/);
    expect(puts[0].Body.subarray(0, 2).toString()).toBe('PK');
  });

  it('exports a preloaded distribution without reading or fetching an official one', async () => {
    fetchRepoFiles.mockClear();
    const { distributionFiles } = await distribution();
    const reads = [];
    const s3 = {
      send: vi.fn(async (command) => {
        if (command instanceof PutObjectCommand) return {};
        reads.push(command.input.Key);
        throw new Error(`unexpected read ${command.input.Key}`);
      }),
    };
    const result = await createNativeExport({
      s3,
      bucket: 'artifacts',
      upstreamRef: '3333333333333333333333333333333333333333',
      harness: 'codex',
      now: '2026-08-11T12:00:00.000Z',
      presign: vi.fn().mockResolvedValue('https://download.example/export.zip'),
      preloadedDistribution: { files: distributionFiles, workspaceLayout: 'spaces' },
      projection: {
        intent: {
          projectId: 'project-1',
          intentId: 'intent-1',
          title: 'Payment service',
          prompt: 'Add payments',
          scope: 'feature',
          workflowId: 'aidlc-v2',
          workflowVersion: 4,
          createdAt: '2026-08-11T10:00:00.000Z',
        },
        stages: [{ stageId: 'intent-capture', phase: 'ideation' }],
        stageRows: [],
        artifacts: [],
        humanTasks: [],
        repositories: [],
      },
    });
    expect(result.downloadUrl).toBe('https://download.example/export.zip');
    expect(reads).toEqual([]);
    expect(fetchRepoFiles).not.toHaveBeenCalled();
  });

  it('does not upload a legacy live snapshot that changed during ZIP generation', async () => {
    const { archive, manifest } = await distribution();
    const s3 = {
      send: vi.fn(async (command) => {
        if (command instanceof PutObjectCommand) return {};
        return {
          Body: command.input.Key.endsWith('codex.manifest.json') ? manifest : archive,
        };
      }),
    };
    await expect(
      createNativeExport({
        s3,
        bucket: 'artifacts',
        upstreamRef: REF,
        harness: 'codex',
        validateSnapshot: vi.fn().mockResolvedValue(false),
        projection: {
          intent: {
            projectId: 'project-1',
            intentId: 'intent-1',
            title: 'Payment service',
            scope: 'feature',
            workflowId: 'aidlc-v2',
            workflowVersion: 4,
            createdAt: '2026-08-11T10:00:00.000Z',
          },
          stages: [{ stageId: 'intent-capture', phase: 'ideation' }],
          stageRows: [],
          artifacts: [],
          repositories: [],
        },
      }),
    ).rejects.toMatchObject({ code: 'export_snapshot_changed' });
    expect(s3.send.mock.calls.some(([command]) => command instanceof PutObjectCommand)).toBe(false);
  });

  it('returns the next unfinished unit and documents legacy iteration limits', async () => {
    const { archive, manifest } = await distribution();
    const s3 = {
      send: vi.fn(async (command) => {
        if (command instanceof PutObjectCommand) return {};
        return {
          Body: command.input.Key.endsWith('codex.manifest.json') ? manifest : archive,
        };
      }),
    };
    const result = await createNativeExport({
      s3,
      bucket: 'artifacts',
      upstreamRef: REF,
      harness: 'codex',
      now: '2026-08-11T12:00:00.000Z',
      presign: vi.fn().mockResolvedValue('https://download.example/export.zip'),
      projection: {
        intent: {
          projectId: 'project-1',
          intentId: 'intent-1',
          title: 'Payment service',
          scope: 'feature',
          workflowId: 'aidlc-v2',
          workflowVersion: 4,
          createdAt: '2026-08-11T10:00:00.000Z',
        },
        stages: [{ stageId: 'intent-capture', phase: 'ideation' }],
        stageRows: [],
        artifacts: [],
        repositories: [],
        unitPlan: {
          units: [
            { slug: 'upload-image', dependsOn: [] },
            { slug: 'identify-plant', dependsOn: ['upload-image'] },
          ],
          batches: [['upload-image'], ['identify-plant']],
        },
        unitRows: [
          { slug: 'upload-image', state: 'MERGED' },
          { slug: 'identify-plant', state: 'PENDING' },
        ],
      },
    });
    expect(result.setup.construction).toEqual({
      nextUnit: 'identify-plant',
      completedUnits: ['upload-image'],
      readyUnits: ['identify-plant'],
      perUnitIteration: false,
    });
    expect(result.warnings).toContainEqual(
      expect.stringMatching(/predates deterministic per-unit/),
    );
  });
});
