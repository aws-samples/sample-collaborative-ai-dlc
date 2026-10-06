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
      expect(materialized[0]).not.toHaveProperty('supportAgents');
      expect(res.ensembleEvidence).toBeUndefined();
      expect(res.findings).toBeUndefined();
      expect(eventTypes(store).some((type) => type.startsWith('v2.persona.'))).toBe(false);
      expect(store.receipts).toEqual([]);
    },
  );

  it('leaves an ensemble stage with no resolvable support on the inline path', async () => {
    const { deps, materialized, store } = harness({ mode: 'pipeline', supportRefs: [] });
    const res = await runStage({ ...baseArgs, methodologyRelease: RELEASE_PIN }, deps);
    expect(res).toMatchObject({ ok: true, state: 'SUCCEEDED' });
    expect(materialized[0]).not.toHaveProperty('supportAgents');
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
    expect(materialized[0]).not.toHaveProperty('supportAgents');
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
  it('never hands the support personas to the lead prompt', async () => {
    const { deps, materialized } = harness({ mode: 'pipeline' });
    await runStage({ ...baseArgs, methodologyRelease: RELEASE_PIN }, deps);
    expect(materialized[0]).not.toHaveProperty('supportAgents');
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

  // The ensemble files its receipts under the attempt this leg wrote on the stage
  // row, without a second read that could fail and fall back to attempt 0.
  it('files the ensemble receipts under the attempt of this leg', async () => {
    const { deps, store } = harness({ mode: 'pipeline', ...withGraph() });
    deps.spawnFn = outputWritingSpawn;
    let reads = 0;
    store.getStage = async () => {
      reads += 1;
      if (reads > 1) throw new Error('ThrottlingException');
      return { stageInstanceId: STAGE_INSTANCE_ID, attempt: 2 };
    };
    await runStage({ ...baseArgs, methodologyRelease: RELEASE_PIN }, deps);
    expect(store.receipts.map((row) => [row.kind, row.attempt])).toEqual([
      ['pipeline-link', 2],
      ['pipeline-link', 2],
    ]);
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
      'ensemble_integration_missing',
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
    expect(res.findings.map((item) => item.code)).toEqual([
      'persona_contribution_missing',
      'ensemble_integration_missing',
    ]);
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

// The leg budget restarts on every runStage call, but the runtime session is not
// stopped between serial stages, so a stage can start in a microVM that is
// already hours into its 8 h max_lifetime.
describe('runStage — the stage deadline is bounded by the container lifetime', () => {
  const T0 = Date.parse('2026-10-06T00:00:00.000Z');
  const HOUR = 60 * 60 * 1000;

  const uptimeHarness = (uptimeHours) => {
    const { deps, store, args } = harness({ mode: 'mob', ...withGraph() });
    const spawns = [];
    deps.nowMs = () => T0;
    deps.processUptimeMs = () => uptimeHours * HOUR;
    deps.spawnFn = (...spawnArgs) => {
      spawns.push(spawnArgs);
      return outputWritingSpawn();
    };
    return { deps, store, args, spawns };
  };

  it('starts no persona session in a container already past the usable lifetime', async () => {
    const { deps, store, args, spawns } = uptimeHarness(7);

    const result = await runStage(args, deps);

    // Only the lead ran: the ensemble found no room before the runtime kill.
    expect(spawns).toHaveLength(1);
    expect(result.findings.map((item) => item.code)).toContain('stage_budget_exhausted');
    expect(eventTypes(store).filter((type) => type === 'v2.persona.gap').length).toBeGreaterThan(0);
  });

  it('runs the whole topology in a freshly started container', async () => {
    const { deps, args, spawns } = uptimeHarness(0);

    await runStage(args, deps);

    expect(spawns.length).toBeGreaterThan(1);
  });
});

// The ensemble runs between the lead's exit and the engine commit, for up to
// MAX_SUPPORT_PERSONAS x 2 tries plus the integrator and the dissent rounds, on a
// 1 GiB session mount a persona session can fill. The lead's draft must not be
// the thing that is lost when it does.
describe('runStage — the lead draft is durable before any persona runs', () => {
  const commitTrackingHarness = ({ failAfterLeadDraft = false } = {}) => {
    const { deps, store, args } = harness({ mode: 'mob', ...withGraph() });
    const commits = [];
    deps.commitAndPushAll = async (commitArgs) => {
      commits.push(commitArgs.message);
      if (commits.length === 1) {
        return {
          ok: true,
          committed: true,
          results: [{ repo: 'r1', sha: 'lead1', committed: true, pushed: true }],
        };
      }
      if (failAfterLeadDraft) {
        return {
          ok: false,
          committed: false,
          results: [
            {
              repo: 'r1',
              committed: false,
              dirty: true,
              reason: 'git_commit_failed',
              detail: 'ENOSPC: no space left on device',
            },
          ],
        };
      }
      return {
        ok: true,
        committed: true,
        results: [{ repo: 'r1', sha: 'post1', committed: true, pushed: true }],
      };
    };
    return { deps, store, args, commits };
  };

  it('commits and pushes the lead tree before dispatching the personas, then again after', async () => {
    const { deps, store, args, commits } = commitTrackingHarness();
    const order = [];
    deps.commitAndPushAll = async (commitArgs) => {
      order.push(`commit:${commitArgs.message.includes('(lead draft)') ? 'lead-draft' : 'engine'}`);
      commits.push(commitArgs.message);
      return {
        ok: true,
        committed: true,
        results: [{ repo: 'r1', sha: 'abc', committed: true, pushed: true }],
      };
    };
    const spawns = [];
    deps.spawnFn = (...spawnArgs) => {
      order.push('spawn');
      spawns.push(spawnArgs);
      return outputWritingSpawn();
    };

    await runStage(args, deps);

    // Lead session, then the lead-draft commit, then every persona session, then
    // the engine commit.
    expect(order[0]).toBe('spawn');
    expect(order[1]).toBe('commit:lead-draft');
    expect(order.slice(2, -1).every((step) => step === 'spawn')).toBe(true);
    expect(order.at(-1)).toBe('commit:engine');
    expect(commits.filter((message) => message.includes('(lead draft)'))).toHaveLength(1);
    expect(eventTypes(store).filter((type) => type === 'v2.git.pushed').length).toBeGreaterThan(1);
  });

  it('leaves the lead commit pushed when the persona phase then fills the mount', async () => {
    const { deps, store, args, commits } = commitTrackingHarness({ failAfterLeadDraft: true });
    deps.spawnFn = outputWritingSpawn;

    const result = await runStage(args, deps);

    expect(commits[0]).toContain('(lead draft)');
    const pushed = store.calls
      .filter((call) => call[0] === 'appendEvent' && call[1].type === 'v2.git.pushed')
      .map((call) => call[1].summary);
    expect(pushed.some((summary) => summary.includes('(lead draft)'))).toBe(true);
    expect(result.ok).toBe(false);
    // The lead's commit is retained for traceability even though the stage then
    // failed on the engine commit, so a clean retry can still reconstruct it.
    const failedStage = store.calls
      .filter((call) => call[0] === 'updateStageState' && call[1].state === 'FAILED')
      .at(-1);
    expect(failedStage[1].pendingCodeCommitRefs).toContainEqual({ repo: 'r1', sha: 'lead1' });
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
    const { deps, materialized } = harness({ mode: 'inline', release: null });
    deps.loadLibrary = async () => ({
      workflow: workflow(),
      library: { ...library('inline'), fromRelease: false },
    });
    await runStage(baseArgs, deps);
    expect(materialized[0].stage.policy ?? null).toBeNull();
    expect(materialized[0].scope).not.toHaveProperty('agentRef');
  });
});

// A resume leg never materializes a prompt, so the lead's persona body for its
// integration session is re-read after the lead has run. For a pinned intent that
// read is release-backed and must fail closed like the fresh leg does; anything
// else keeps the lenient empty-persona fallback.
describe('runStage — native ensemble sessions: the lead persona on a resume leg', () => {
  const resumeHarness = (bodyError) => {
    const { deps, store } = harness({ mode: 'mob' });
    const humanTaskId = 'gate-resume-2';
    const spawned = [];
    const commits = [];
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
    const loadBody = deps.loadBlockBody;
    deps.loadBlockBody = async (block, options) => {
      if (block?.bodyRef?.s3Key === 'blocks/bodies/sha256/agent') throw bodyError;
      return loadBody(block, options);
    };
    deps.spawnFn = () => {
      spawned.push('spawn');
      return okSpawn();
    };
    deps.commitAndPushAll = async (args) => {
      commits.push(args);
      return { ok: true, committed: false, results: [] };
    };
    const run = () =>
      runStage({ ...baseArgs, methodologyRelease: RELEASE_PIN, resumeFrom: humanTaskId }, deps);
    return { run, store, spawned, commits };
  };

  it.each([
    ['a digest mismatch', 'ReleaseResolverError', 'release_digest_mismatch'],
    ['an unreadable release object', 'ReleaseResolverError', 'release_object_unreadable'],
  ])(
    'fails a pinned stage after committing when the lead persona has %s',
    async (_label, name, code) => {
      const { run, store, spawned, commits } = resumeHarness(
        Object.assign(new Error(`release body failed: ${code}`), { name, code }),
      );

      const result = await run();

      expect(result).toMatchObject({ ok: false, reason: 'methodology_body_unavailable' });
      // Only the lead's own resumed session ran; no persona was seated without
      // its pinned persona, and the lead's work was still made durable.
      expect(spawned).toHaveLength(1);
      expect(commits.length).toBeGreaterThan(0);
      expect(store.receipts).toEqual([]);
      expect(
        store.calls.some(
          ([name, event]) =>
            name === 'appendEvent' && event.detail?.reason === 'lead_persona_unavailable',
        ),
      ).toBe(true);
    },
  );

  it('keeps the empty-persona fallback for a lead persona error outside release resolution', async () => {
    const { run } = resumeHarness(new Error('transient read failure'));

    const result = await run();

    expect(result).toMatchObject({ ok: true, state: 'SUCCEEDED' });
  });
});

// A support persona's methodology knowledge is read inside the ensemble runner,
// which degrades every surprise to a gap. For a pinned intent a typed release
// failure on that read is a tampered or missing pinned body, so the persona must
// not be dispatched without it and the stage fails once the lead's work is durable.
describe('runStage — native ensemble sessions: support knowledge on a pinned run', () => {
  const knowledgeHarness = (bodyError) => {
    const { deps, store } = harness({ mode: 'mob' });
    const base = library('mob');
    deps.loadLibrary = async () => ({
      workflow: workflow(),
      library: {
        ...base,
        knowledgeById: {
          'architect-notes': {
            id: 'architect-notes',
            agentRef: 'aidlc-architect-agent',
            bodyRef: { s3Key: 'blocks/bodies/sha256/architect-notes' },
          },
        },
      },
    });
    const loadBody = deps.loadBlockBody;
    deps.loadBlockBody = async (block, options) => {
      if (block?.bodyRef?.s3Key === 'blocks/bodies/sha256/architect-notes') throw bodyError;
      return loadBody(block, options);
    };
    const spawned = [];
    deps.spawnFn = () => {
      spawned.push('spawn');
      return okSpawn();
    };
    const commits = [];
    deps.commitAndPushAll = async (args) => {
      commits.push(args);
      return { ok: true, committed: false, results: [] };
    };
    return { deps, store, spawned, commits };
  };

  it('fails the stage after committing instead of dispatching the support without its knowledge', async () => {
    const { deps, spawned, commits } = knowledgeHarness(
      Object.assign(new Error('release body failed: release_digest_mismatch'), {
        name: 'ReleaseResolverError',
        code: 'release_digest_mismatch',
      }),
    );

    const result = await runStage({ ...baseArgs, methodologyRelease: RELEASE_PIN }, deps);

    expect(result).toMatchObject({ ok: false, reason: 'methodology_body_unavailable' });
    expect(spawned).toHaveLength(1);
    expect(commits.length).toBeGreaterThan(0);
  });

  it('still dispatches the support on a knowledge error outside release resolution', async () => {
    const { deps, spawned } = knowledgeHarness(new Error('transient read failure'));

    const result = await runStage({ ...baseArgs, methodologyRelease: RELEASE_PIN }, deps);

    expect(result).toMatchObject({ ok: true, state: 'SUCCEEDED' });
    expect(spawned.length).toBeGreaterThan(1);
  });
});

// A validation "Request changes" is not a separate dispatch shape: it reaches the
// stage as a RESUME of the answered gate, so the feedback lives in that gate's
// answer and nowhere else. The ensemble's own unit tests inject `humanFeedback`
// directly, which cannot observe whether the STAGE RUNNER ever finds it — only a
// seam test that answers a real gate can.
describe('runStage — native ensemble sessions: the validation feedback the lead got', () => {
  const FEEDBACK = 'Tighten the acceptance criteria on the payment story.';
  const REVISION_HEADING = 'The human requested changes on the previous revision';
  const humanTaskId = 'gate-validation-1';

  const revisionHarness = () => {
    const prompts = [];
    const { deps, store } = harness({
      mode: 'mob',
      supportRefs: ['aidlc-design-agent'],
      ...withGraph(),
    });
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
      kind: 'validation',
      status: 'answered',
      answer: { decision: 'request-changes', feedback: FEEDBACK },
      createdAt: 'T',
    });
    deps.spawnFn = promptCapturingSpawn(prompts);
    return { deps, store, prompts };
  };

  it('reaches both a support brief and the integrator brief on a validation revision', async () => {
    const { deps, prompts } = revisionHarness();

    const result = await runStage(
      {
        ...baseArgs,
        methodologyRelease: RELEASE_PIN,
        resumeFrom: humanTaskId,
        validationRound: 1,
      },
      deps,
    );

    expect(result).toMatchObject({ ok: true, state: 'SUCCEEDED' });

    const supportBrief = prompts.find((text) => text.includes('You are aidlc-design-agent'));
    expect(supportBrief).toContain(`## ${REVISION_HEADING}`);
    // Quoted per line, so the human's words cannot read as a new brief heading.
    expect(supportBrief).toContain(`> ${FEEDBACK}`);

    const integratorBrief = prompts.find((text) =>
      text.includes('# Integration: requirements-analysis'),
    );
    expect(integratorBrief).toContain(`## ${REVISION_HEADING}`);
    expect(integratorBrief).toContain(`> ${FEEDBACK}`);
  });

  it('passes no feedback to any persona on a fresh run', async () => {
    const prompts = [];
    const { deps } = harness({
      mode: 'mob',
      supportRefs: ['aidlc-design-agent'],
      ...withGraph(),
    });
    deps.spawnFn = promptCapturingSpawn(prompts);

    const result = await runStage({ ...baseArgs, methodologyRelease: RELEASE_PIN }, deps);

    expect(result).toMatchObject({ ok: true, state: 'SUCCEEDED' });
    expect(prompts.some((text) => text.includes('You are aidlc-design-agent'))).toBe(true);
    expect(prompts.some((text) => text.includes('# Integration: requirements-analysis'))).toBe(
      true,
    );
    expect(prompts.some((text) => text.includes(REVISION_HEADING))).toBe(false);
  });

  // Validation round 0 is the first pass at the stage: an answered gate can still
  // be the resume that carries it (a checkpoint, a question), and that answer is
  // not rejected-draft feedback.
  it('passes no feedback on a resume at validation round 0', async () => {
    const { deps, prompts } = revisionHarness();

    const result = await runStage(
      { ...baseArgs, methodologyRelease: RELEASE_PIN, resumeFrom: humanTaskId },
      deps,
    );

    expect(result).toMatchObject({ ok: true, state: 'SUCCEEDED' });
    expect(prompts.some((text) => text.includes(REVISION_HEADING))).toBe(false);
  });
});
