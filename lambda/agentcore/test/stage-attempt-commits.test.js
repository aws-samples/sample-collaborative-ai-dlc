// Commits a stage makes across its whole attempt: the ordinary stage commit, the
// commits of the bounded repair turns, and the commits carried over from an
// earlier leg that parked. All of them must reach the same durability rule, the
// same commit references, and the write-plane sensor sweep.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runStage } from '../commands/run-stage.js';
import { renderRulesDoc } from '../stage-materializer.js';

const REPO = 'owner/repo';
const STAGE_ID = 'business-logic';

const library = ({ summaryConfirmation = null, sensors = [] } = {}) => ({
  fromRelease: true,
  stagesById: {
    [STAGE_ID]: {
      id: STAGE_ID,
      version: 1,
      phase: 'construction',
      mode: 'inline',
      leadAgent: 'aidlc-developer-agent',
      produces: ['business-logic-model'],
      consumes: [],
      sensors: sensors.map((sensor) => sensor.id),
      humanValidation: 'required',
      ...(summaryConfirmation ? { summaryConfirmation } : {}),
      bodyRef: { s3Key: 'blocks/bodies/sha256/stage' },
    },
  },
  agentsById: {
    'aidlc-developer-agent': { id: 'aidlc-developer-agent', modelOverride: null, bodyRef: null },
  },
  sensorsById: Object.fromEntries(sensors.map((sensor) => [sensor.id, sensor])),
  rulesById: {},
  artifactsById: { 'business-logic-model': { id: 'business-logic-model', terminal: true } },
  knowledgeById: {},
  scopesById: { feature: { id: 'feature', name: 'feature', version: 1, skeleton: 'on' } },
});

const workflow = () => ({
  id: 'aidlc-v2',
  version: 1,
  placements: [{ stageId: STAGE_ID, order: 0, scopeMembership: { feature: 'EXECUTE' } }],
  ruleRefs: [],
  scopeRefs: [{ scopeId: 'feature' }],
});

const recordingStore = ({ stageRow = { attempt: 0 } } = {}) => {
  const calls = [];
  const rec = (name) => async (args) => {
    calls.push([name, args]);
    return {};
  };
  return {
    calls,
    of: (name) => calls.filter(([n]) => n === name).map(([, args]) => args),
    putStage: rec('putStage'),
    updateExecution: rec('updateExecution'),
    updateStageState: rec('updateStageState'),
    resumeStageRow: rec('resumeStageRow'),
    appendEvent: rec('appendEvent'),
    recordSensorRun: rec('recordSensorRun'),
    async bumpStageCounter() {
      return 1;
    },
    async appendOutput() {
      return { seq: 1, timestamp: 'T' };
    },
    async recordMetric() {
      return { metricId: 'm' };
    },
    async getStage() {
      return stageRow;
    },
    async getHumanTask() {
      return null;
    },
    async getExecution() {
      return null;
    },
    async getUnitPlan() {
      return null;
    },
    async listEvents() {
      return [];
    },
    async listReceipts() {
      return [];
    },
  };
};

const okSpawn = () => ({
  on: (event, callback) => event === 'close' && setImmediate(() => callback(0)),
  stdout: { on() {} },
  stderr: { on() {} },
  stdin: { end() {}, write() {} },
});

let workspaceDir;
beforeEach(async () => {
  workspaceDir = await mkdtemp(nodePath.join(tmpdir(), 'stage-attempt-commits-'));
});
afterEach(async () => {
  await rm(workspaceDir, { recursive: true, force: true });
});

const deps = (store, { lib, ...overrides }) => ({
  store,
  loadLibrary: async () => ({ workflow: workflow(), library: lib }),
  loadBlockBody: async () => 'body',
  loadBlockScript: async () => 'console.log("{}")',
  materializeStage: async ({ stage }) => ({
    prompt: `PROMPT ${stage.stageId}`,
    mcpConfigPath: '/ws/.aidlc/mcp.json',
  }),
  materializeMcpConfig: async () => '/ws/.aidlc/mcp.json',
  materializeKiroAgent: async () => 'aidlc',
  materializeOpenCodeConfig: async () => '{}',
  materializeCodexHome: async () => '/ws/.aidlc/codex-home',
  renderRulesDoc,
  mcpEntry: '/opt/agentcore/mcp/index.js',
  availableClis: ['claude'],
  env: { BEDROCK_MODEL: 'us.anthropic.claude-sonnet-4-6' },
  clock: () => 'T',
  spawnFn: okSpawn,
  ensureWorkspaceSource: async () => ({ restored: false, repos: [], failed: [] }),
  redirectHeavyDirs: async () => ({ links: [] }),
  ...overrides,
});

const args = () => ({
  projectId: 'p1',
  intentId: 'i1',
  executionId: 'e1',
  stageId: STAGE_ID,
  workflowId: 'aidlc-v2',
  workflowVersion: 1,
  scope: 'feature',
  workspaceDir,
  repos: [REPO],
});

const clean = { ok: true, committed: false, results: [{ repo: REPO, reason: 'clean', files: [] }] };

describe('repair-turn commits', () => {
  it('fails the stage when the repair turn commit could not be pushed', async () => {
    const commitAndPushAll = vi
      .fn()
      .mockResolvedValueOnce(clean)
      .mockResolvedValueOnce({
        ok: false,
        committed: true,
        results: [
          {
            repo: REPO,
            committed: true,
            pushed: false,
            reason: 'push_failed',
            sha: 'b'.repeat(40),
          },
        ],
      });
    const store = recordingStore();

    const res = await runStage(
      args(),
      deps(store, { lib: library({ summaryConfirmation: 'required' }), commitAndPushAll }),
    );

    expect(commitAndPushAll).toHaveBeenCalledTimes(2);
    expect(res).toMatchObject({ ok: false, reason: 'push_failed' });
  });

  it('reports the repair commit as part of the stage result', async () => {
    const repairSha = 'c'.repeat(40);
    const commitAndPushAll = vi
      .fn()
      .mockResolvedValueOnce(clean)
      .mockResolvedValueOnce({
        ok: true,
        committed: true,
        results: [
          { repo: REPO, committed: true, pushed: true, sha: repairSha, files: ['src/repair.ts'] },
        ],
      });
    const gitResultForCommitRefs = vi.fn(async ({ commitRefs }) => ({
      ok: true,
      committed: true,
      results: commitRefs.map((ref) => ({
        repo: ref.repo,
        committed: true,
        pushed: true,
        sha: ref.sha,
        files: ['src/repair.ts'],
      })),
    }));
    const store = recordingStore();

    const res = await runStage(
      args(),
      deps(store, {
        lib: library({ summaryConfirmation: 'required' }),
        commitAndPushAll,
        gitResultForCommitRefs,
      }),
    );

    expect(res.state).toBe('SUCCEEDED');
    expect(gitResultForCommitRefs).toHaveBeenCalledWith(
      expect.objectContaining({ commitRefs: [{ repo: REPO, sha: repairSha }] }),
    );
    expect(res).toMatchObject({ commitSha: repairSha, changedFiles: ['src/repair.ts'] });
  });
});

describe('write-plane sweep over the whole attempt', () => {
  const lint = {
    id: 'lint',
    command: 'bun <runtime-managed>/tools/aidlc-sensor-linter.ts',
    runtime: 'bun',
    severity: 'advisory',
    matches: '**/*.ts',
    fireOn: 'write',
    timeoutSeconds: 5,
    scriptRef: { s3Key: 'blocks/scripts/sha256/lint' },
  };

  it('includes files committed by an earlier leg of the attempt', async () => {
    const carriedSha = 'd'.repeat(40);
    const store = recordingStore({
      stageRow: { attempt: 0, pendingCodeCommitRefs: [{ repo: REPO, sha: carriedSha }] },
    });
    const gitResultForCommitRefs = vi.fn(async () => ({
      ok: true,
      committed: true,
      results: [
        { repo: REPO, committed: true, pushed: true, sha: carriedSha, files: ['src/a.ts'] },
      ],
    }));

    await runStage(
      args(),
      deps(store, {
        lib: library({ sensors: [lint] }),
        commitAndPushAll: async () => clean,
        gitResultForCommitRefs,
      }),
    );

    const [run] = store.of('recordSensorRun').filter((row) => row.sensorId === 'lint');
    expect(run.detail?.reason).not.toBe('no files match');
    expect(run.detail.files.map((file) => file.file)).toEqual(['src/a.ts']);
  });
});
