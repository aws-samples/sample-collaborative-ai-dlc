import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { buildDistributionArchive } from '../../shared/distribution-archive.js';
import { fetchRepoFiles } from '../../shared/repo-fetch.js';
import {
  alignProjectionToDistribution,
  buildZip,
  createNativeExport,
  detectConstructionCapabilities,
  detectWorkspaceLayout,
  loadDistribution,
  loadCustomRules,
  registerNativeScope,
  resolveRulesDir,
  safeArchivePath,
  shouldShowWorkspaceSetup,
  workspaceSyncCommand,
} from '../native-export.js';

vi.mock('../../shared/repo-fetch.js', () => ({
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
