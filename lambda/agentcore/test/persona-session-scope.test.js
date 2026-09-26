// Regression coverage for persona policy scope, gate sensor outcomes, reviewer
// repair turns, and stage-failure logging.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { graphRows, logWarnings, graphFaults } = vi.hoisted(() => ({
  graphRows: [],
  logWarnings: [],
  graphFaults: { closeThrows: false },
}));

vi.mock('../mcp/graph-writer.js', () => ({
  createGraphWriter: () => ({
    createArtifact: async ({ artifactType, id, title, content, props }) => {
      graphRows.push({ id, artifact_type: artifactType, title, content, ...props });
      return { id };
    },
    lookupArtifacts: async ({ artifactType }) =>
      graphRows.filter((row) => row.artifact_type === artifactType),
    getTeamKnowledge: async () => [],
    getLearningRules: async () => [],
    getCoverage: async () => null,
    linkSteeringInfluences: async () => {},
  }),
  // Fails ONCE when armed, so a test can target a single pass without every later
  // graph close in the run inheriting the fault.
  closeGraphSource: async () => {
    if (!graphFaults.closeThrows) return;
    graphFaults.closeThrows = false;
    throw new Error('neptune connection reset');
  },
}));

// The ONE way to observe `fail()`'s operator line: run-stage builds its Logger at
// module scope, so the class itself is the seam.
vi.mock('@aws-lambda-powertools/logger', () => ({
  Logger: class {
    info() {}
    debug() {}
    error() {}
    warn(message, context) {
      logWarnings.push({ message, context });
    }
  },
}));

import { runStage } from '../commands/run-stage.js';
import { renderRulesDoc } from '../stage-materializer.js';
import { STAGE_BUDGET_MS } from '../ensemble-runner.js';
import { stageInstanceId as planStageInstanceId } from '../../shared/v2-execution-plan.js';

const RELEASE_PIN = {
  releaseId: 'aidlc:abc',
  sourceSha: 'a'.repeat(40),
  closureDigest: 'd'.repeat(64),
  importerRevision: 1,
  catalogKey: 'aidlc-releases/v1/catalog.json',
  manifestKey: 'aidlc-releases/v1/manifest.json',
};

const STAGE_INSTANCE_ID = planStageInstanceId('aidlc-v2@1', 'requirements-analysis');
const REVIEWER = 'aidlc-reviewer-agent';

const library = ({
  mode = 'inline',
  supportRefs = [],
  reviewer = null,
  reviewerMaxIterations = 1,
  sensors = [],
} = {}) => ({
  stagesById: {
    'requirements-analysis': {
      id: 'requirements-analysis',
      version: 1,
      phase: 'inception',
      mode,
      leadAgent: 'aidlc-product-agent',
      supportAgents: supportRefs,
      produces: ['requirements-analysis'],
      consumes: [],
      sensors: sensors.map((sensor) => sensor.id),
      ...(reviewer ? { reviewer, reviewerMaxIterations } : {}),
      humanValidation: 'required',
      bodyRef: { s3Key: 'blocks/bodies/sha256/stage' },
    },
  },
  agentsById: {
    'aidlc-product-agent': {
      id: 'aidlc-product-agent',
      modelOverride: null,
      bodyRef: { s3Key: 'blocks/bodies/sha256/agent' },
    },
    ...Object.fromEntries(
      [...supportRefs, ...(reviewer ? [reviewer] : [])].map((ref) => [
        ref,
        { id: ref, displayName: ref, bodyRef: { s3Key: `blocks/bodies/sha256/${ref}` } },
      ]),
    ),
  },
  sensorsById: Object.fromEntries(sensors.map((sensor) => [sensor.id, sensor])),
  rulesById: {},
  artifactsById: { 'requirements-analysis': { id: 'requirements-analysis', terminal: true } },
  knowledgeById: {},
  fromRelease: true,
  scopesById: { feature: { id: 'feature', sensorsPolicy: 'on', learnings: 'off' } },
});

const workflow = () => ({
  id: 'aidlc-v2',
  version: 1,
  placements: [
    { stageId: 'requirements-analysis', order: 0, scopeMembership: { feature: 'EXECUTE' } },
  ],
  ruleRefs: [],
  scopeRefs: [{ scopeId: 'feature' }],
});

const spyStore = ({ sensorRuns = [] } = {}) => {
  const calls = [];
  const receipts = [];
  const events = [];
  const rec = (name) => async (args) => {
    calls.push([name, args]);
    return {};
  };
  return {
    calls,
    receipts,
    events,
    sensorRuns,
    putStage: rec('putStage'),
    updateExecution: rec('updateExecution'),
    updateStageState: rec('updateStageState'),
    resumeStageRow: rec('resumeStageRow'),
    supersedeHumanTask: rec('supersedeHumanTask'),
    async appendEvent(args) {
      calls.push(['appendEvent', args]);
      const row = { ...args, eventType: args.type, timestamp: 'T' };
      events.push(row);
      return row;
    },
    async listEvents() {
      return events;
    },
    async listSensorRuns() {
      return sensorRuns;
    },
    async appendOutput() {
      return { seq: 1, timestamp: 'T' };
    },
    recordSensorRun: rec('recordSensorRun'),
    async recordMetric() {
      return { metricId: 'm' };
    },
    async getHumanTask() {
      return null;
    },
    async getStage() {
      return { stageInstanceId: STAGE_INSTANCE_ID, attempt: 0 };
    },
    async getExecution() {
      return null;
    },
    async getUnitPlan() {
      return null;
    },
    async listReceipts() {
      return receipts;
    },
    async putReceipt(row) {
      receipts.push(row);
      return row;
    },
  };
};

const baseArgs = {
  projectId: 'p1',
  intentId: 'i1',
  executionId: 'e1',
  stageId: 'requirements-analysis',
  workflowId: 'aidlc-v2',
  workflowVersion: 1,
  scope: 'feature',
  workspaceDir: '/ws',
};

const okSpawn = () => ({
  on: (event, callback) => event === 'close' && setImmediate(() => callback(0)),
  stdin: { end() {} },
});

const promptCapturingSpawn = (prompts) => () => ({
  on: (event, callback) => event === 'close' && setImmediate(() => callback(0)),
  stdin: {
    end(text) {
      prompts.push(String(text ?? ''));
    },
  },
});

const harness = ({
  libraryArgs = {},
  store = spyStore(),
  cli = 'claude',
  broadcast = null,
} = {}) => {
  const mcpScopes = [];
  const commits = [];
  const deps = {
    store,
    loadLibrary: async () => ({ workflow: workflow(), library: library(libraryArgs) }),
    loadBlockBody: async (b) => (b?.bodyRef?.s3Key ? `body:${b.bodyRef.s3Key}` : ''),
    materializeStage: async (args) => ({
      prompt: `PROMPT ${args.stage.stageId}`,
      mcpConfigPath: '/ws/.aidlc/mcp.json',
    }),
    materializeMcpConfig: async (args) => {
      mcpScopes.push(args.scope);
      return '/ws/.aidlc/mcp.json';
    },
    materializeKiroAgent: async () => 'aidlc',
    materializeOpenCodeConfig: async () => '{}',
    materializeCodexHome: async () => '/ws/.aidlc/codex-home',
    renderRulesDoc,
    mcpEntry: '/opt/agentcore/mcp/index.js',
    availableClis: [cli],
    env: { BEDROCK_MODEL: 'us.anthropic.claude-sonnet-4-6' },
    spawnFn: okSpawn,
    clock: () => 'T',
    openGraph: async () => ({}),
    commitAndPushAll: async (args) => {
      commits.push(args.message);
      return { ok: true, committed: false, results: [] };
    },
    ...(broadcast ? { broadcast } : {}),
  };
  return { deps, store, mcpScopes, commits };
};

const eventsOfType = (store, type) => store.events.filter((row) => row.type === type);

beforeEach(() => {
  graphRows.length = 0;
  logWarnings.length = 0;
  graphFaults.closeThrows = false;
});

describe('dispatched persona sessions — policy in, checkpoint out', () => {
  it('forwards the injected OpenCode store wrapper to reviewer sessions', async () => {
    const { deps } = harness({ libraryArgs: { reviewer: REVIEWER }, cli: 'opencode' });
    const withOpenCodeStore = vi.fn(async ({ operation }) => operation());
    deps.withOpenCodeStore = withOpenCodeStore;

    const res = await runStage({ ...baseArgs, methodologyRelease: RELEASE_PIN }, deps);

    expect(res).toMatchObject({ ok: true, state: 'SUCCEEDED' });
    // The lead and the dispatched reviewer both use the injected store wrapper.
    expect(withOpenCodeStore).toHaveBeenCalledTimes(2);
  });

  it('gives every dispatched persona the resolved policy and withholds checkpoint ownership', async () => {
    const { deps, mcpScopes } = harness({
      libraryArgs: { mode: 'mob', supportRefs: ['aidlc-design-agent'] },
    });
    const res = await runStage({ ...baseArgs, methodologyRelease: RELEASE_PIN }, deps);
    expect(res).toMatchObject({ ok: true, state: 'SUCCEEDED' });

    // The lead's own session (materializeStage) is not in this list; every entry
    // here is a dispatched persona.
    expect(mcpScopes.length).toBeGreaterThan(0);
    for (const scope of mcpScopes) {
      expect(scope.policy).toMatchObject({ learnings: 'off' });
      expect(scope.checkpointOwner).toBe(false);
    }
    // And each one carries its OWN trusted author identity.
    expect(mcpScopes.map((scope) => scope.agentRef)).toContain('aidlc-design-agent');
    expect(mcpScopes.some((scope) => scope.agentRef === 'aidlc-product-agent')).toBe(true);
  });

  it('passes no policy at all outside release mode, so the persona path stays inert', async () => {
    const { deps, mcpScopes } = harness({
      libraryArgs: { mode: 'mob', supportRefs: ['aidlc-design-agent'] },
    });
    const res = await runStage(baseArgs, deps);
    expect(res).toMatchObject({ ok: true, state: 'SUCCEEDED' });
    // No release pin → no native sessions at all → no dispatched MCP scope.
    expect(mcpScopes).toEqual([]);
  });

  it('says the ensemble is deferred, not skipped, when the lead parked', async () => {
    const store = spyStore();
    // The lead asked a question: the stage row points at a pending gate it owns.
    store.getStage = async () => ({
      stageInstanceId: STAGE_INSTANCE_ID,
      attempt: 0,
      pendingHumanTaskId: 'ht-1',
    });
    store.getHumanTask = async () => ({
      humanTaskId: 'ht-1',
      status: 'pending',
      kind: 'question',
      stageInstanceId: STAGE_INSTANCE_ID,
      unitSlug: null,
    });
    const { deps } = harness({
      libraryArgs: { mode: 'mob', supportRefs: ['aidlc-design-agent'] },
      store,
    });
    await runStage({ ...baseArgs, methodologyRelease: RELEASE_PIN }, deps);
    const gap = eventsOfType(store, 'v2.persona.gap').at(0);
    expect(gap.summary).toContain('deferred until the lead resumes');
    expect(gap.summary).not.toContain('skipped');
    expect(gap.detail).toMatchObject({ reason: 'lead_parked' });
  });
});

// A real gate-plane sensor: `required-sections` is graph-kind (it reads the
// artifact's content out of the graph), advisory, and asks for the gate plane.
const GATE_SENSOR = {
  id: 'required-sections',
  severity: 'advisory',
  fireOn: 'gate',
  runtime: 'graph',
  command: 'required-sections',
};

describe('gate sensor plane — the verdict summary and the INCONCLUSIVE floor', () => {
  it('records a durable summary of the gate pass, PASS counts included', async () => {
    graphRows.push({
      id: 'requirements-analysis',
      artifact_type: 'requirements-analysis',
      content: '## Anything\n',
    });
    const { deps, store } = harness({ libraryArgs: { sensors: [GATE_SENSOR] } });
    const res = await runStage({ ...baseArgs, methodologyRelease: RELEASE_PIN }, deps);
    expect(res).toMatchObject({ ok: true, state: 'SUCCEEDED' });
    const [summary] = eventsOfType(store, 'v2.sensor.gate');
    expect(summary.summary).toMatch(/^Gate sensors: \d+ passed, \d+ flagged$/);
    expect(summary.detail.sensorIds).toContain('required-sections');
  });

  it('turns an orchestration failure into an INCONCLUSIVE advisory, never a silent null', async () => {
    const store = spyStore();
    // The plane opens its own graph connection and closes it in a `finally`. Arm
    // the close failure the moment the GATE sensor's note goes out, so the fault
    // lands on the gate pass only: that pass then returned `null` and the gate
    // opened with the sensor axis silently absent.
    const { deps } = harness({
      libraryArgs: { sensors: [GATE_SENSOR] },
      store,
      broadcast: async (payload) => {
        if (String(payload?.note ?? '').includes('required-sections')) {
          graphFaults.closeThrows = true;
        }
      },
    });
    const res = await runStage({ ...baseArgs, methodologyRelease: RELEASE_PIN }, deps);
    expect(res).toMatchObject({ ok: true, state: 'SUCCEEDED' });
    const advisory = res.findings.find((item) => item.detail?.sensorId === 'gate-sensor-plane');
    expect(advisory).toMatchObject({
      code: 'sensor_gate_advisory',
      severity: 'advisory',
      detail: { result: 'INCONCLUSIVE', reason: 'neptune connection reset' },
    });
    const [summary] = eventsOfType(store, 'v2.sensor.gate');
    expect(summary.summary).toContain('(plane INCONCLUSIVE)');
    expect(summary.detail.error).toBe('neptune connection reset');
  });
});

const notReadyRun = (findings) => ({
  kind: 'reviewer',
  sensorId: `reviewer:${REVIEWER}`,
  result: 'FAIL',
  detail: { verdict: 'NOT-READY', findings },
});

describe('adversarial reviewer loop — a lead repair turn between rounds', () => {
  const reviewerLibrary = { reviewer: REVIEWER, reviewerMaxIterations: 2 };

  it('resumes the lead with the findings, commits, then re-reviews', async () => {
    const prompts = [];
    const store = spyStore({
      sensorRuns: [
        notReadyRun(
          '**Reviewer:** x\nSection 3 contradicts the input. Run {{INVOKE}} engine verify under {{HARNESS_DIR}}',
        ),
      ],
    });
    const { deps, commits } = harness({ libraryArgs: reviewerLibrary, store });
    deps.spawnFn = promptCapturingSpawn(prompts);
    const res = await runStage({ ...baseArgs, methodologyRelease: RELEASE_PIN }, deps);

    // humanValidation: required, so a terminal NOT-READY goes to the human rather
    // than failing the stage.
    expect(res).toMatchObject({ ok: true });
    const repair = prompts.find((text) => text.includes('REVIEW ROUND 1'));
    expect(repair).toBeTruthy();
    expect(repair).toContain('Section 3 contradicts the input');
    expect(repair).toContain('Address every finding NOW');
    // The findings are another agent's text reaching this session's prompt, so the
    // runtime-managed template tokens are neutralized on the way in.
    expect(repair).not.toContain('{{INVOKE}}');
    expect(repair).not.toContain('{{HARNESS_DIR}}');
    expect(repair).toContain('<runtime-managed-engine>');
    // The repair rewrote artifacts, so the tree was committed before round 2.
    expect(commits.some((message) => message.includes('review repair r1'))).toBe(true);
    expect(eventsOfType(store, 'v2.review.repair_requested')).toHaveLength(1);
    // Bounded by maxIterations: two rounds, ONE repair between them.
    expect(eventsOfType(store, 'v2.review.running')).toHaveLength(2);
  });

  it('never repairs after the final round', async () => {
    const store = spyStore({ sensorRuns: [notReadyRun('still not ready')] });
    const { deps } = harness({
      libraryArgs: { reviewer: REVIEWER, reviewerMaxIterations: 1 },
      store,
    });
    await runStage({ ...baseArgs, methodologyRelease: RELEASE_PIN }, deps);
    expect(eventsOfType(store, 'v2.review.running')).toHaveLength(1);
    expect(eventsOfType(store, 'v2.review.repair_requested')).toEqual([]);
  });

  it('leaves the unpinned loop exactly as it was — re-review, no repair', async () => {
    const store = spyStore({ sensorRuns: [notReadyRun('not ready')] });
    const { deps, commits } = harness({ libraryArgs: reviewerLibrary, store });
    await runStage(baseArgs, deps);
    expect(eventsOfType(store, 'v2.review.running')).toHaveLength(2);
    expect(eventsOfType(store, 'v2.review.repair_requested')).toEqual([]);
    expect(commits.some((message) => message.includes('review repair'))).toBe(false);
  });

  // F-4: a lead repair turn has no timeout of its own, so it is not started once
  // less than a persona session's worth of the stage budget remains. The loop ends
  // on this round's verdict (re-reviewing unrepaired bytes repeats it) with a note.
  it('skips the repair and ends the loop when the stage budget is spent', async () => {
    const store = spyStore({ sensorRuns: [notReadyRun('not ready')] });
    const { deps, commits } = harness({ libraryArgs: reviewerLibrary, store });
    const t0 = Date.parse('2026-09-24T00:00:00.000Z');
    deps.nowMs = () => t0;
    // Only 10 minutes of stage budget: less than one persona session's worth.
    deps.stageBudgetMs = 10 * 60 * 1000;
    const res = await runStage({ ...baseArgs, methodologyRelease: RELEASE_PIN }, deps);
    expect(res).toMatchObject({ ok: true });
    expect(eventsOfType(store, 'v2.review.repair_requested')).toEqual([]);
    expect(eventsOfType(store, 'v2.review.running')).toHaveLength(1);
    const [skipped] = eventsOfType(store, 'v2.stage.repair_skipped');
    expect(skipped.detail).toMatchObject({ reason: 'stage_budget_exhausted', round: 1 });
    expect(commits.some((message) => message.includes('review repair'))).toBe(false);
  });

  it('still repairs when the budget has room for another session', async () => {
    const store = spyStore({ sensorRuns: [notReadyRun('not ready')] });
    const { deps } = harness({ libraryArgs: reviewerLibrary, store });
    const t0 = Date.parse('2026-09-24T00:00:00.000Z');
    deps.nowMs = () => t0;
    await runStage({ ...baseArgs, methodologyRelease: RELEASE_PIN }, deps);
    expect(eventsOfType(store, 'v2.review.repair_requested')).toHaveLength(1);
    expect(eventsOfType(store, 'v2.stage.repair_skipped')).toEqual([]);
  });

  // The budget starts with the stage attempt, even when its container is older
  // than the full stage budget.
  it('anchors the budget on the stage attempt, not on how old the container is', async () => {
    const store = spyStore({ sensorRuns: [notReadyRun('not ready')] });
    const { deps } = harness({ libraryArgs: reviewerLibrary, store });
    const t0 = Date.parse('2026-09-24T00:00:00.000Z');
    deps.nowMs = () => t0;
    // A container that has been alive for longer than the whole stage budget.
    deps.sessionStartedAtMs = t0 - (STAGE_BUDGET_MS + 60 * 60 * 1000);
    await runStage({ ...baseArgs, methodologyRelease: RELEASE_PIN }, deps);
    expect(eventsOfType(store, 'v2.review.repair_requested')).toHaveLength(1);
    expect(eventsOfType(store, 'v2.stage.repair_skipped')).toEqual([]);
  });

  it('skips the repair for codex, which has no session to re-enter here', async () => {
    const store = spyStore({ sensorRuns: [notReadyRun('not ready')] });
    const { deps } = harness({ libraryArgs: reviewerLibrary, store, cli: 'codex' });
    await runStage({ ...baseArgs, methodologyRelease: RELEASE_PIN }, deps);
    expect(eventsOfType(store, 'v2.review.repair_requested')).toEqual([]);
    expect(eventsOfType(store, 'v2.review.running')).toHaveLength(2);
  });
});

describe('every stage failure warns with its code', () => {
  it('logs {code, stageId, executionId} when the stage fails', async () => {
    const { deps } = harness({});
    deps.spawnFn = () => ({
      on: (event, callback) => event === 'close' && setImmediate(() => callback(7)),
      stdin: { end() {} },
    });
    const res = await runStage({ ...baseArgs, methodologyRelease: RELEASE_PIN }, deps);
    expect(res).toMatchObject({ ok: false, reason: 'cli_nonzero_exit' });
    const warned = logWarnings.find((row) => row.message === 'stage failed');
    expect(warned.context).toMatchObject({
      code: 'cli_nonzero_exit',
      stageId: 'requirements-analysis',
      executionId: 'e1',
      stageInstanceId: STAGE_INSTANCE_ID,
    });
  });
});
