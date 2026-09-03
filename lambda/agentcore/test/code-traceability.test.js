import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  classifyFileKind,
  collectCodeTraceabilityBatches,
  ingestStageCodeTraceability,
  isConcurrentModification,
  normalizeWorkspacePath,
  validateTraceabilityDocument,
} from '../code-traceability.js';

const roots = [];
const workspace = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aidlc-traceability-'));
  roots.push(root);
  return root;
};
const put = async (root, file, content = '') => {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), content, 'utf8');
};
const gitResult = (files, sha = 'a'.repeat(40)) => ({
  ok: true,
  committed: true,
  results: [{ repo: 'owner/repo', committed: true, pushed: true, sha, files }],
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('traceability document validation', () => {
  it('accepts a stage/unit-scoped coverage document and normalizes targets', () => {
    const result = validateTraceabilityDocument(
      {
        stage: 'code-generation',
        unit: 'u1-auth',
        coverage: [{ id: 'AC1.1.1', status: 'ok', target: './src/auth/login.ts' }],
      },
      { expectedStage: 'code-generation', expectedUnit: 'u1-auth' },
    );
    expect(result).toEqual({
      valid: true,
      document: {
        stage: 'code-generation',
        unit: 'u1-auth',
        coverage: [{ id: 'AC1.1.1', status: 'OK', target: 'src/auth/login.ts' }],
      },
    });
  });

  it('rejects absolute/traversing targets and stale stage capabilities', () => {
    expect(normalizeWorkspacePath('../outside.ts')).toBeNull();
    expect(normalizeWorkspacePath('/tmp/outside.ts')).toBeNull();
    expect(
      validateTraceabilityDocument(
        { stage: 'other', unit: 'u1', coverage: [] },
        { expectedStage: 'code-generation', expectedUnit: 'u1' },
      ),
    ).toMatchObject({ valid: false, reason: expect.stringContaining('stage mismatch') });
  });
});

describe('collectCodeTraceabilityBatches', () => {
  it('uses valid traceability as authoritative evidence for OK changed-file targets', async () => {
    const root = await workspace();
    await put(root, 'src/auth/login.ts', 'export const login = true;\n');
    await put(root, 'test/auth/login.test.ts', 'test("login", () => {});\n');
    await put(
      root,
      'traceability.json',
      JSON.stringify({
        stage: 'code-generation',
        unit: 'u1-auth',
        coverage: [
          { id: 'AC1.1.1', status: 'OK', target: 'src/auth/login.ts' },
          { id: 'NFR1.1', status: 'OK', target: 'test/auth/login.test.ts' },
          { id: 'BR1.1', status: 'GAP', target: 'src/auth/login.ts' },
          { id: 'FR-stale', status: 'OK', target: 'src/not-changed.ts' },
        ],
      }),
    );

    const [batch] = await collectCodeTraceabilityBatches({
      gitResult: gitResult(['src/auth/login.ts', 'test/auth/login.test.ts', 'traceability.json']),
      repos: ['owner/repo'],
      workspaceDir: root,
      stageId: 'code-generation',
      stageInstanceId: 'si-code-u1',
      unitSlug: 'u1-auth',
    });

    expect(batch).toMatchObject({
      repository: 'owner/repo',
      commitRef: 'a'.repeat(40),
      unitSlug: 'u1-auth',
      traceabilityStatus: 'valid',
    });
    expect(batch.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          filePath: 'src/auth/login.ts',
          fileKind: 'implementation',
          traceabilitySource: 'aidlc-traceability',
          evidenceIds: ['AC1.1.1'],
        }),
        expect.objectContaining({
          filePath: 'test/auth/login.test.ts',
          fileKind: 'test',
          traceabilitySource: 'aidlc-traceability',
          evidenceIds: ['NFR1.1'],
        }),
        expect.objectContaining({
          filePath: 'traceability.json',
          fileKind: 'configuration',
          traceabilitySource: 'git',
          evidenceIds: [],
        }),
      ]),
    );
  });

  it('keeps Git topology in legacy mode when traceability.json is absent', async () => {
    const root = await workspace();
    await put(root, 'src/legacy.js', 'export default true;\n');
    const [batch] = await collectCodeTraceabilityBatches({
      gitResult: gitResult(['src/legacy.js']),
      repos: ['owner/repo'],
      workspaceDir: root,
      stageId: 'legacy-code-stage',
      stageInstanceId: 'si-legacy',
      unitSlug: 'u-legacy',
    });
    expect(batch.traceabilityStatus).toBe('missing');
    expect(batch.files).toEqual([
      expect.objectContaining({
        filePath: 'src/legacy.js',
        traceabilitySource: 'git',
        evidenceIds: [],
      }),
    ]);
  });

  it('degrades invalid JSON without throwing and excludes deleted paths', async () => {
    const root = await workspace();
    await put(root, 'src/kept.ts', 'export {};\n');
    await put(root, 'traceability.json', '{not-json');
    const [batch] = await collectCodeTraceabilityBatches({
      gitResult: gitResult(['src/kept.ts', 'src/deleted.ts', 'traceability.json']),
      repos: ['owner/repo'],
      workspaceDir: root,
      stageId: 'code-generation',
      stageInstanceId: 'si-code',
      unitSlug: 'u1',
    });
    expect(batch.traceabilityStatus).toBe('invalid');
    expect(batch.files.map((file) => file.filePath)).toEqual(['src/kept.ts', 'traceability.json']);
    expect(batch.files.every((file) => file.traceabilitySource === 'git')).toBe(true);
  });
});

describe('classifyFileKind', () => {
  it.each([
    ['src/service.ts', 'implementation'],
    ['src/service.spec.ts', 'test'],
    ['tests/service.ts', 'test'],
    ['terraform/main.tf', 'configuration'],
    ['docs/guide.md', 'documentation'],
  ])('classifies %s as %s', (file, expected) => {
    expect(classifyFileKind(file)).toBe(expected);
  });
});

describe('collectCodeTraceabilityBatches — multi-repo layout', () => {
  // Layout MUST match workspace.js#repoTargetDir: multi-repo lays each repo out
  // under <workspaceDir>/<owner>/<repo> (the full "owner/repo" url), single-repo
  // clones straight into <workspaceDir>. Proven by init-ws.test.js:743.
  it('resolves files under <ws>/<owner>/<repo> for each repo in a multi-repo run', async () => {
    const root = await workspace();
    await put(root, 'acme/api/src/handler.ts', 'export const h = 1;\n');
    await put(root, 'acme/web/src/App.tsx', 'export const App = () => null;\n');
    const multiGit = {
      ok: true,
      committed: true,
      results: [
        {
          repo: 'acme/api',
          committed: true,
          pushed: true,
          sha: 'a'.repeat(40),
          files: ['src/handler.ts'],
        },
        {
          repo: 'acme/web',
          committed: true,
          pushed: true,
          sha: 'b'.repeat(40),
          files: ['src/App.tsx'],
        },
      ],
    };
    const batches = await collectCodeTraceabilityBatches({
      gitResult: multiGit,
      repos: ['acme/api', 'acme/web'],
      workspaceDir: root,
      stageId: 'code-generation',
      stageInstanceId: 'si-code',
      unitSlug: 'u1',
    });
    expect(batches.map((b) => b.repository).toSorted()).toEqual(['acme/api', 'acme/web']);
    const api = batches.find((b) => b.repository === 'acme/api');
    const web = batches.find((b) => b.repository === 'acme/web');
    expect(api.files.map((f) => f.filePath)).toEqual(['src/handler.ts']);
    expect(web.files.map((f) => f.filePath)).toEqual(['src/App.tsx']);
    // Wrong layout (bare name) would resolve zero files — guard against regression.
    expect(api.files.length + web.files.length).toBe(2);
  });
});

describe('loadProducedTraceability — size cap', () => {
  it('treats an oversized traceability.json as degraded (no OOM, no throw)', async () => {
    const root = await workspace();
    await put(root, 'src/kept.ts', 'export {};\n');
    // > 5 MiB of valid JSON; must be skipped and degrade to invalid.
    const huge = `{"stage":"code-generation","unit":"u1","coverage":[],"pad":"${'x'.repeat(6 * 1024 * 1024)}"}`;
    await put(root, 'traceability.json', huge);
    const [batch] = await collectCodeTraceabilityBatches({
      gitResult: gitResult(['src/kept.ts', 'traceability.json']),
      repos: ['owner/repo'],
      workspaceDir: root,
      stageId: 'code-generation',
      stageInstanceId: 'si-code',
      unitSlug: 'u1',
    });
    expect(batch.traceabilityStatus).toBe('invalid');
    expect(batch.files.every((file) => file.traceabilitySource === 'git')).toBe(true);
  });
});

describe('ingestStageCodeTraceability — concurrent-modification retry', () => {
  it('recognizes a Neptune ConcurrentModificationException', () => {
    expect(isConcurrentModification({ name: 'ConcurrentModificationException' })).toBe(true);
    expect(isConcurrentModification(new Error('concurrently modified'))).toBe(true);
    expect(isConcurrentModification(new Error('bad edge'))).toBe(false);
  });

  it('retries a transient CME and then succeeds (no topology loss)', async () => {
    const root = await workspace();
    await put(root, 'src/handler.ts', 'export const h = 1;\n');
    let calls = 0;
    const ingestCodeFiles = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        throw Object.assign(new Error('cme'), { name: 'ConcurrentModificationException' });
      }
      return { codeFiles: 1, evidenceEdges: 0 };
    });
    let closed = false;
    const sleeps = [];
    const result = await ingestStageCodeTraceability({
      openGraph: async () => ({
        remoteConnection: {
          close: async () => {
            closed = true;
          },
        },
      }),
      createWriter: () => ({ ingestCodeFiles }),
      scope: { intentId: 'i1', projectId: 'p1', executionId: 'e1' },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      gitResult: gitResult(['src/handler.ts']),
      repos: ['owner/repo'],
      workspaceDir: root,
      stageId: 'code-generation',
      stageInstanceId: 'si-code',
      unitSlug: 'u1',
    });
    expect(ingestCodeFiles).toHaveBeenCalledTimes(2); // one CME, one success
    expect(sleeps).toEqual([100]); // first linear-backoff delay before retry
    expect(result).toMatchObject({ codeFiles: 1, evidenceEdges: 0 });
    expect(closed).toBe(true); // graph source always released
  });

  it('propagates a persistent CME after exhausting retries (caller degrades)', async () => {
    const root = await workspace();
    await put(root, 'src/handler.ts', 'export const h = 1;\n');
    const ingestCodeFiles = vi.fn(async () => {
      throw Object.assign(new Error('cme'), { name: 'ConcurrentModificationException' });
    });
    await expect(
      ingestStageCodeTraceability({
        openGraph: async () => ({ remoteConnection: { close: async () => {} } }),
        createWriter: () => ({ ingestCodeFiles }),
        scope: { intentId: 'i1' },
        sleep: async () => {},
        gitResult: gitResult(['src/handler.ts']),
        repos: ['owner/repo'],
        workspaceDir: root,
        stageId: 'code-generation',
        stageInstanceId: 'si-code',
        unitSlug: 'u1',
      }),
    ).rejects.toThrow(/cme/);
    expect(ingestCodeFiles).toHaveBeenCalledTimes(4); // initial + 3 retries
  });
});
