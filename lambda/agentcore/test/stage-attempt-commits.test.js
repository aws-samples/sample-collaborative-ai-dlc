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
    async raiseStageCounter() {
      return true;
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

// The plan-approval lineage rule reads `v2.git.pushed` to decide whether a stage's
// code predates its approval. A repair commit that published nothing left that rule
// judging the stage on its pre-approval commit, so a repair that DID obtain the
// approval and commit afterwards still reported plan_approval_missing.
describe('repair-turn commit evidence', () => {
  const repairPush = (sha) => ({
    ok: true,
    committed: true,
    results: [{ repo: REPO, committed: true, pushed: true, sha, files: ['src/repair.ts'] }],
  });

  const gitEvents = (store) =>
    store.of('appendEvent').filter((event) => String(event.type).startsWith('v2.git.'));

  it('publishes v2.git.pushed for the repair commit, naming the repo and the repair', async () => {
    const repairSha = 'd'.repeat(40);
    const commitAndPushAll = vi
      .fn()
      .mockResolvedValueOnce(clean)
      .mockResolvedValueOnce(repairPush(repairSha));
    const store = recordingStore();

    const res = await runStage(
      args(),
      deps(store, { lib: library({ summaryConfirmation: 'required' }), commitAndPushAll }),
    );

    expect(res.state).toBe('SUCCEEDED');
    const pushed = gitEvents(store).filter((event) => event.type === 'v2.git.pushed');
    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toMatchObject({ stageInstanceId: res.stageInstanceId });
    // The orchestrator's per-repo read matches on the repo id in the summary.
    expect(pushed[0].summary).toContain(REPO);
    expect(pushed[0].summary).toContain(repairSha.slice(0, 8));
    expect(pushed[0].summary).toContain('checkpoint repair');
  });

  it('publishes one event per commit when the stage commit landed too', async () => {
    const stageSha = 'e'.repeat(40);
    const repairSha = 'f'.repeat(40);
    const commitAndPushAll = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        committed: true,
        results: [
          { repo: REPO, committed: true, pushed: true, sha: stageSha, files: ['src/stage.ts'] },
        ],
      })
      .mockResolvedValueOnce(repairPush(repairSha));
    const store = recordingStore();

    await runStage(
      args(),
      deps(store, { lib: library({ summaryConfirmation: 'required' }), commitAndPushAll }),
    );

    const summaries = gitEvents(store).map((event) => event.summary);
    expect(summaries).toHaveLength(2);
    expect(summaries[0]).toContain(stageSha.slice(0, 8));
    expect(summaries[1]).toContain(repairSha.slice(0, 8));
  });

  it('keeps reporting a failed repair push as v2.git.push_failed', async () => {
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

    expect(res).toMatchObject({ ok: false, reason: 'push_failed' });
    expect(gitEvents(store).map((event) => event.type)).toEqual(['v2.git.push_failed']);
  });

  it('publishes nothing when the repair turn changed nothing', async () => {
    const commitAndPushAll = vi.fn().mockResolvedValue(clean);
    const store = recordingStore();

    await runStage(
      args(),
      deps(store, { lib: library({ summaryConfirmation: 'required' }), commitAndPushAll }),
    );

    expect(gitEvents(store)).toEqual([]);
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
      { ...args(), methodologyRelease: { releaseId: 'release-a' } },
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
