// runStage × native ensemble sessions — the seam tests.
//
// The topology logic itself is covered in ensemble-runner.test.js. What matters
// HERE is the wiring: that release mode is the gate, that the escape hatch and the
// unpinned path leave the lead's prompt untouched, that the lead's prompt loses the
// single-session "play every persona" block exactly when real sessions take over,
// and that the stage result carries the gate's evidence.
//
// These are additions: nothing in run-stage.test.js is modified.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// The contribution vocabulary is the real one: run-stage reaches the graph through
// `createGraphWriter`, so the writer is mocked rather than the connection — that is
// what makes "the gap stub goes through create_artifact, not a private back door"
// an assertion instead of a claim.
const { graphRows } = vi.hoisted(() => ({ graphRows: [] }));

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
    linkSteeringInfluences: async () => {},
  }),
  closeGraphSource: async () => {},
}));

import { runStage } from '../commands/run-stage.js';
import { renderRulesDoc } from '../stage-materializer.js';
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

const library = (mode, supportRefs = ['aidlc-architect-agent']) => ({
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
      sensors: [],
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
      supportRefs.map((ref) => [
        ref,
        { id: ref, displayName: ref, bodyRef: { s3Key: `blocks/bodies/sha256/${ref}` } },
      ]),
    ),
  },
  sensorsById: {},
  rulesById: {},
  artifactsById: { 'requirements-analysis': { id: 'requirements-analysis', terminal: true } },
  knowledgeById: {},
  // A release-sourced library is what turns the per-scope policy on, and the
  // policy is what lets `evaluateGatePreconditions` speak at all — without it the
  // whole findings channel is inert, which is the 2.3.3 contract.
  fromRelease: true,
  scopesById: { feature: { id: 'feature', sensorsPolicy: 'on' } },
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

const spyStore = () => {
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
      return [];
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

// `openGraph` only has to resolve: every call the runner makes goes through the
// mocked writer above.
const withGraph = () => ({ openGraph: async () => ({}) });

const harness = ({ mode, supportRefs, env = {}, release = RELEASE_PIN, openGraph = null } = {}) => {
  const materialized = [];
  const mcpScopes = [];
  const store = spyStore();
  const deps = {
    store,
    loadLibrary: async () => ({ workflow: workflow(), library: library(mode, supportRefs) }),
    loadBlockBody: async (b) => (b?.bodyRef?.s3Key ? `body:${b.bodyRef.s3Key}` : ''),
    materializeStage: async (args) => {
      materialized.push(args);
      return { prompt: `PROMPT ${args.stage.stageId}`, mcpConfigPath: '/ws/.aidlc/mcp.json' };
    },
    materializeMcpConfig: async ({ scope }) => {
      mcpScopes.push(scope);
      return '/ws/.aidlc/mcp.json';
    },
    materializeKiroAgent: async () => 'aidlc',
    materializeOpenCodeConfig: async () => '{}',
    materializeCodexHome: async () => '/ws/.aidlc/codex-home',
    renderRulesDoc,
    mcpEntry: '/opt/agentcore/mcp/index.js',
    availableClis: ['claude'],
    env: { BEDROCK_MODEL: 'us.anthropic.claude-sonnet-4-6', ...env },
    spawnFn: okSpawn,
    clock: () => 'T',
    commitAndPushAll: async () => ({ ok: true, committed: false, results: [] }),
    ...(openGraph ? { openGraph } : {}),
  };
  const args = { ...baseArgs, ...(release ? { methodologyRelease: release } : {}) };
  return { deps, store, materialized, mcpScopes, args };
};

const eventTypes = (store) =>
  store.calls.filter((call) => call[0] === 'appendEvent').map((call) => call[1].type);

beforeEach(() => {
  graphRows.length = 0;
});

describe('runStage — native ensemble sessions: the release gate', () => {
  it.each(['pipeline', 'mob'])(
    'does not load support personas for a %s stage outside release mode',
    async (mode) => {
      const { deps, materialized, store } = harness({ mode, release: null });
      const res = await runStage(baseArgs, deps);
      expect(res).toMatchObject({ ok: true, state: 'SUCCEEDED' });
      expect(materialized[0].supportAgents).toEqual([]);
      expect(res.ensembleEvidence).toBeUndefined();
      expect(res.findings).toBeUndefined();
      expect(eventTypes(store).some((type) => type.startsWith('v2.persona.'))).toBe(false);
      expect(store.receipts).toEqual([]);
    },
  );

  it('keeps the single-session ensemble prompt under V2_ENSEMBLE_SESSIONS=off', async () => {
    const { deps, materialized, store } = harness({
      mode: 'pipeline',
      env: { V2_ENSEMBLE_SESSIONS: 'off' },
    });
    const res = await runStage({ ...baseArgs, methodologyRelease: RELEASE_PIN }, deps);
    expect(res).toMatchObject({ ok: true, state: 'SUCCEEDED' });
    expect(materialized[0].supportAgents).toHaveLength(1);
    expect(res.ensembleEvidence).toBeUndefined();
    expect(eventTypes(store).some((type) => type.startsWith('v2.persona.'))).toBe(false);
  });

  it('loads support personas only for a pinned plan when native sessions are disabled', async () => {
    const pinned = harness({ mode: 'mob', env: { V2_ENSEMBLE_SESSIONS: 'off' } });
    await runStage({ ...baseArgs, methodologyRelease: RELEASE_PIN }, pinned.deps);
    const unpinned = harness({ mode: 'mob', release: null });
    await runStage(baseArgs, unpinned.deps);
    expect(pinned.materialized[0].supportAgents).toHaveLength(1);
    expect(unpinned.materialized[0].supportAgents).toEqual([]);
    expect(pinned.materialized[0].stage.mode).toBe(unpinned.materialized[0].stage.mode);
  });

  it('leaves an ensemble stage with no resolvable support on the inline path', async () => {
    const { deps, materialized, store } = harness({ mode: 'pipeline', supportRefs: [] });
    const res = await runStage({ ...baseArgs, methodologyRelease: RELEASE_PIN }, deps);
    expect(res).toMatchObject({ ok: true, state: 'SUCCEEDED' });
    expect(materialized[0].supportAgents).toEqual([]);
    expect(res.ensembleEvidence).toBeUndefined();
    expect(store.receipts).toEqual([]);
  });

  it('fails a pinned run before dispatch when its declared persona topology cannot resolve', async () => {
    const { deps, store } = harness({ mode: 'pipeline' });
    const humanTaskId = 'gate-resume-1';
    let spawnCount = 0;
    store.getStage = async () => ({
      stageInstanceId: STAGE_INSTANCE_ID,
      state: 'WAITING_FOR_HUMAN',
      pendingHumanTaskId: humanTaskId,
      cli: 'claude',
      cliSessionId: 'session-1',
      attempt: 0,
    });
    store.getHumanTask = async () => ({
      humanTaskId,
      status: 'answered',
      answer: 'Continue with the approved scope.',
      createdAt: 'T',
    });
    deps.resolveEnsembleTopology = async () => {
      throw new Error('persona topology unavailable');
    };
    deps.spawnFn = () => {
      spawnCount += 1;
      return okSpawn();
    };

    const result = await runStage(
      { ...baseArgs, methodologyRelease: RELEASE_PIN, resumeFrom: humanTaskId },
      deps,
    );

    expect(result).toMatchObject({ ok: false, reason: 'ensemble_topology_unresolved' });
    expect(spawnCount).toBe(0);
    expect(
      store.calls.some((call) => call[0] === 'updateStageState' && call[1].state === 'FAILED'),
    ).toBe(true);
  });

  it('leaves a lead-only subagent stage exactly as it is today', async () => {
    const { deps, materialized, store } = harness({ mode: 'subagent', supportRefs: [] });
    const res = await runStage({ ...baseArgs, methodologyRelease: RELEASE_PIN }, deps);
    expect(res).toMatchObject({ ok: true, state: 'SUCCEEDED' });
    expect(materialized[0].supportAgents).toEqual([]);
    expect(res.ensembleEvidence).toBeUndefined();
    expect(eventTypes(store).some((type) => type.startsWith('v2.persona.'))).toBe(false);
  });
});

// Captures every prompt actually piped to a spawned CLI, in spawn order: the
// prompt reaches the child on stdin (never argv — E2BIG), so this is the only
// place the rendered text is observable.
const promptCapturingSpawn = (prompts) => () => ({
  on: (event, callback) => event === 'close' && setImmediate(() => callback(0)),
  stdin: {
    end(text) {
      prompts.push(String(text ?? ''));
    },
  },
});

describe('runStage — native ensemble sessions: the lead prompt hand-off', () => {
  it('withholds the support personas from the single-session ensemble block', async () => {
    const { deps, materialized } = harness({ mode: 'pipeline' });
    await runStage({ ...baseArgs, methodologyRelease: RELEASE_PIN }, deps);
    // `renderEnsembleProtocol` is driven off `supportAgents`; empty means the
    // "you play every persona yourself" block renders nothing at all.
    expect(materialized[0].supportAgents).toEqual([]);
  });

  it('tells the lead it is link 1 of a real pipeline, not the whole ensemble', async () => {
    const prompts = [];
    const { deps } = harness({ mode: 'pipeline' });
    deps.spawnFn = promptCapturingSpawn(prompts);
    await runStage({ ...baseArgs, methodologyRelease: RELEASE_PIN }, deps);
    const [leadPrompt] = prompts;
    expect(leadPrompt).toContain('PROMPT requirements-analysis');
    expect(leadPrompt).toContain('Ensemble topology (stage mode: pipeline, separate sessions)');
    expect(leadPrompt).toContain('You are link 1 of an ordered pipeline');
    expect(leadPrompt).toContain('Do NOT role-play the other personas');
  });

  it('tells a mob lead to draft now and expect a separate integration session', async () => {
    const prompts = [];
    const { deps } = harness({ mode: 'mob' });
    deps.spawnFn = promptCapturingSpawn(prompts);
    await runStage({ ...baseArgs, methodologyRelease: RELEASE_PIN }, deps);
    expect(prompts[0]).toContain('Ensemble topology (stage mode: mob, separate sessions)');
    expect(prompts[0]).toContain('re-invoked in a separate integration session');
  });

  it('leaves the lead prompt free of any topology block on the off path', async () => {
    const prompts = [];
    const { deps } = harness({ mode: 'mob', env: { V2_ENSEMBLE_SESSIONS: 'off' } });
    deps.spawnFn = promptCapturingSpawn(prompts);
    await runStage({ ...baseArgs, methodologyRelease: RELEASE_PIN }, deps);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toBe('PROMPT requirements-analysis');
  });

  it('gives each support its own brief, naming no sibling', async () => {
    const prompts = [];
    const { deps } = harness({
      mode: 'mob',
      supportRefs: ['aidlc-design-agent', 'aidlc-quality-agent'],
      ...withGraph(),
    });
    deps.spawnFn = promptCapturingSpawn(prompts);
    await runStage({ ...baseArgs, methodologyRelease: RELEASE_PIN }, deps);
    const designBrief = prompts.find((text) => text.includes('You are aidlc-design-agent'));
    expect(designBrief).toContain('contribution-requirements-analysis-aidlc-design-agent');
    expect(designBrief).not.toContain('aidlc-quality-agent');
    expect(designBrief).toContain('MUST NOT look at their work');
  });
});

describe('runStage — native ensemble sessions: trusted dispatch scope', () => {
  it('threads the stage id and current attempt into a support MCP scope', async () => {
    const { deps, store, mcpScopes } = harness({ mode: 'mob', openGraph: async () => ({}) });
    store.getStage = async () => ({ stageInstanceId: STAGE_INSTANCE_ID, attempt: 2 });

    const result = await runStage({ ...baseArgs, methodologyRelease: RELEASE_PIN }, deps);

    expect(result).toMatchObject({ ok: true, state: 'SUCCEEDED' });
    expect(mcpScopes).toContainEqual(
      expect.objectContaining({
        role: 'author',
        agentRef: 'aidlc-architect-agent',
        stageId: 'requirements-analysis',
        stageAttempt: 2,
      }),
    );
  });
});

// A spawned session that actually REWRITES the stage's declared output artifact,
// which is the only evidence a pipeline link / integrator has. Mirrors what
// `create_artifact` records: the row's generation moves, so the runner's
// pre/post-dispatch fingerprint differs.
const outputWritingSpawn = () => {
  const row = graphRows.find((candidate) => candidate.artifact_type === 'requirements-analysis');
  if (row) row.generation = Number(row.generation ?? 1) + 1;
  else
    graphRows.push({
      id: 'requirements-analysis',
      artifact_type: 'requirements-analysis',
      generation: 1,
    });
  return okSpawn();
};

describe('runStage — native ensemble sessions: evidence reaches the gate', () => {
  it('runs the pipeline links, receipts them and returns the gate evidence', async () => {
    const { deps, store } = harness({ mode: 'pipeline', ...withGraph() });
    deps.spawnFn = outputWritingSpawn;
    const res = await runStage({ ...baseArgs, methodologyRelease: RELEASE_PIN }, deps);

    expect(res).toMatchObject({ ok: true, state: 'SUCCEEDED' });
    expect(res.ensembleEvidence).toMatchObject({
      mode: 'pipeline',
      links: ['aidlc-product-agent', 'aidlc-architect-agent'],
      supports: [],
    });
    expect(store.receipts.map((row) => [row.kind, row.ordinal])).toEqual([
      ['pipeline-link', 1],
      ['pipeline-link', 2],
    ]);
    expect(eventTypes(store).filter((type) => type === 'v2.persona.link_completed')).toHaveLength(
      2,
    );
    // A complete pipeline is not a finding.
    expect(res.findings).toBeUndefined();
  });

  // The same pipeline whose link sessions write NOTHING: a clean exit is not
  // evidence, so the link GAPs and the incomplete chain reaches the human.
  it('gaps a pipeline link whose session never touched the stage outputs', async () => {
    const { deps, store } = harness({ mode: 'pipeline', ...withGraph() });
    const res = await runStage({ ...baseArgs, methodologyRelease: RELEASE_PIN }, deps);

    expect(res).toMatchObject({ ok: true, state: 'SUCCEEDED' });
    expect(store.receipts.map((row) => [row.kind, row.ordinal, row.choice])).toEqual([
      ['pipeline-link', 1, 'completed'],
      ['pipeline-link', 2, 'gap'],
    ]);
    expect(res.findings.map((item) => item.code)).toContain('pipeline_link_incomplete');
    expect(eventTypes(store)).toContain('v2.persona.gap');
  });

  it('carries a missing contribution to the gate as an advisory finding', async () => {
    const { deps, store } = harness({
      mode: 'mob',
      supportRefs: ['aidlc-design-agent', 'aidlc-quality-agent'],
      ...withGraph(),
    });
    const res = await runStage({ ...baseArgs, methodologyRelease: RELEASE_PIN }, deps);

    expect(res).toMatchObject({ ok: true, state: 'SUCCEEDED' });
    expect(res.ensembleEvidence.supports).toEqual(['aidlc-design-agent', 'aidlc-quality-agent']);
    // Nothing wrote a contribution (the stub spawn does no MCP work), so both
    // supports GAP — and the stage still SUCCEEDS.
    expect(res.findings.map((item) => item.code)).toEqual([
      'persona_contribution_missing',
      'persona_contribution_missing',
    ]);
    expect(res.findings.every((item) => item.severity === 'advisory')).toBe(true);
    // Two support gaps plus the integrator's: its session rewrote nothing either,
    // so the integration produced no evidence.
    expect(eventTypes(store).filter((type) => type === 'v2.persona.gap')).toHaveLength(3);
    // The gap stubs were recorded through the SAME create_artifact vocabulary.
    expect(graphRows.map((row) => [row.id, row.artifact_type, row.status])).toEqual([
      ['contribution-requirements-analysis-aidlc-design-agent', 'contribution', 'gap'],
      ['contribution-requirements-analysis-aidlc-quality-agent', 'contribution', 'gap'],
    ]);
  });

  it('degrades to a gap, never a failure, when there is no graph to observe', async () => {
    const { deps, store } = harness({ mode: 'subagent', supportRefs: ['aidlc-design-agent'] });
    const res = await runStage({ ...baseArgs, methodologyRelease: RELEASE_PIN }, deps);
    expect(res).toMatchObject({ ok: true, state: 'SUCCEEDED' });
    expect(res.findings.map((item) => item.code)).toEqual(['persona_contribution_missing']);
    expect(eventTypes(store)).toContain('v2.persona.gap');
  });

  it('skips the ensemble and says why when the lead session crashes', async () => {
    const { deps, store } = harness({ mode: 'mob' });
    deps.spawnFn = () => ({
      on: (event, callback) => event === 'close' && setImmediate(() => callback(7)),
      stdin: { end() {} },
    });
    const res = await runStage({ ...baseArgs, methodologyRelease: RELEASE_PIN }, deps);
    expect(res).toMatchObject({ ok: false, reason: 'cli_nonzero_exit' });
    const gap = store.calls.find(
      (call) => call[0] === 'appendEvent' && call[1].type === 'v2.persona.gap',
    );
    expect(gap[1].summary).toContain('exited 7');
    expect(gap[1].detail).toMatchObject({ reason: 'lead_incomplete' });
    expect(store.receipts).toEqual([]);
  });

  it('still refuses agent-team, which needs concurrent sessions we do not run', async () => {
    const { deps } = harness({ mode: 'agent-team' });
    await expect(
      runStage({ ...baseArgs, methodologyRelease: RELEASE_PIN }, deps),
    ).resolves.toMatchObject({ ok: false, reason: 'not_implemented' });
  });

  it('spawns one session per persona, sequentially, on the lead plus supports', async () => {
    const { deps } = harness({
      mode: 'mob',
      supportRefs: ['aidlc-design-agent', 'aidlc-quality-agent'],
      ...withGraph(),
    });
    const spawns = vi.fn(okSpawn);
    deps.spawnFn = spawns;
    await runStage({ ...baseArgs, methodologyRelease: RELEASE_PIN }, deps);
    // lead + 2 supports (each retried once after producing nothing) + integrator,
    // itself retried once because it rewrote no stage output.
    expect(spawns.mock.calls.length).toBe(7);
  });
  // No support, and no integrator without a judgment call to raise, can ask the
  // human: nothing threads an answer back into those sessions, so a park there
  // would orphan a gate and re-ask on every resume.
  it('materializes every persona session without ask_question', async () => {
    const { deps } = harness({
      mode: 'mob',
      supportRefs: ['aidlc-design-agent', 'aidlc-quality-agent'],
      ...withGraph(),
    });
    const scopes = [];
    deps.materializeMcpConfig = async ({ scope }) => {
      scopes.push(scope);
      return '/ws/.aidlc/mcp.json';
    };
    await runStage({ ...baseArgs, methodologyRelease: RELEASE_PIN }, deps);
    expect(scopes.length).toBeGreaterThan(0);
    expect(scopes.every((scope) => scope.canAsk === false)).toBe(true);
    expect(scopes.every((scope) => scope.checkpointOwner === false)).toBe(true);
  });
});

describe('runStage — the lead session carries its own trusted identity', () => {
  it('pins the lead agentRef on its MCP scope when the plan resolved a policy', async () => {
    const { deps, materialized, args } = harness({ mode: 'mob', ...withGraph() });
    await runStage(args, deps);
    const lead = materialized[0];
    expect(lead.stage.policy).toBeTruthy();
    expect(lead.scope.agentRef).toBe('aidlc-product-agent');
  });

  it('leaves the lead scope without an identity on an unpinned run', async () => {
    const { deps, materialized } = harness({ mode: 'mob', release: null });
    deps.loadLibrary = async () => ({
      workflow: workflow(),
      library: { ...library('mob'), fromRelease: false },
    });
    await runStage(baseArgs, deps);
    expect(materialized[0].stage.policy ?? null).toBeNull();
    expect(materialized[0].scope).not.toHaveProperty('agentRef');
  });
});
