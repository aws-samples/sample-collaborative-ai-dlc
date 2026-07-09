import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  runStage,
  resetKiroCreditRateCache,
  withPlatformSensors,
  __test,
} from '../commands/run-stage.js';
import { renderRulesDoc } from '../stage-materializer.js';
import {
  buildExecutionPlan,
  stageInstanceId as planStageInstanceId,
} from '../../shared/v2-execution-plan.js';

// A flat-frontmatter STAGE block + a minimal library/workflow that resolves to a
// single in-scope stage.
const library = () => ({
  stagesById: {
    'requirements-analysis': {
      id: 'requirements-analysis',
      version: 1,
      phase: 'inception',
      mode: 'inline',
      leadAgent: 'aidlc-product-agent',
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
  },
  sensorsById: {},
  rulesById: {},
  artifactsById: { 'requirements-analysis': { id: 'requirements-analysis', terminal: true } },
  knowledgeById: {},
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

// Fan-out fixture (docs/v2-parallel.md WP4): a DAG producer + a per-unit stage.
const unitLibrary = () => {
  const lib = library();
  lib.stagesById['units-generation'] = {
    id: 'units-generation',
    version: 1,
    phase: 'inception',
    mode: 'inline',
    leadAgent: 'aidlc-product-agent',
    produces: ['unit-of-work-dependency'],
    consumes: [],
    sensors: [],
    humanValidation: 'required',
    bodyRef: { s3Key: 'blocks/bodies/sha256/units-gen' },
  };
  lib.stagesById['code-generation'] = {
    id: 'code-generation',
    version: 1,
    phase: 'construction',
    mode: 'inline',
    leadAgent: 'aidlc-product-agent',
    forEach: 'unit-of-work',
    execution: 'ALWAYS',
    produces: [],
    consumes: [],
    requires: ['units-generation'],
    sensors: [],
    humanValidation: 'none',
    bodyRef: { s3Key: 'blocks/bodies/sha256/code-gen' },
  };
  lib.artifactsById['unit-of-work-dependency'] = {
    id: 'unit-of-work-dependency',
    terminal: false,
  };
  return lib;
};

const unitWorkflow = () => ({
  id: 'aidlc-v2',
  version: 1,
  placements: [
    { stageId: 'units-generation', order: 0, scopeMembership: { feature: 'EXECUTE' } },
    { stageId: 'code-generation', order: 1, scopeMembership: { feature: 'EXECUTE' } },
  ],
  ruleRefs: [],
  scopeRefs: [{ scopeId: 'feature' }],
});

// A spy process store recording the calls run-stage makes. `seed` pre-loads the
// gate / stage / execution rows the resume + park paths read back.
const spyStore = (seed = {}) => {
  const calls = [];
  const rec = (name) => async (args) => {
    calls.push([name, args]);
    return {};
  };
  return {
    calls,
    putStage: rec('putStage'),
    updateExecution: rec('updateExecution'),
    updateStageState: rec('updateStageState'),
    resumeStageRow: rec('resumeStageRow'),
    appendEvent: rec('appendEvent'),
    async appendOutput(args) {
      calls.push(['appendOutput', args]);
      return { seq: calls.filter((c) => c[0] === 'appendOutput').length };
    },
    recordSensorRun: rec('recordSensorRun'),
    async recordMetric(args) {
      calls.push(['recordMetric', args]);
      return { metricId: 'm-test' };
    },
    async getHumanTask(_e, id) {
      calls.push(['getHumanTask', id]);
      return seed.humanTask ?? null;
    },
    async getStage(_e, id) {
      calls.push(['getStage', id]);
      return seed.stage ?? null;
    },
    async getExecution(_e) {
      calls.push(['getExecution']);
      return seed.execution ?? null;
    },
    async getUnitPlan(_e) {
      calls.push(['getUnitPlan']);
      return seed.unitPlan ?? null;
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

const baseDeps = (overrides = {}) => ({
  store: spyStore(),
  loadLibrary: async () => ({ workflow: workflow(), library: library() }),
  loadBlockBody: async (b) => (b?.bodyRef?.s3Key ? `body:${b.bodyRef.s3Key}` : ''),
  materializeStage: async ({ stage, scope }) => ({
    prompt: `PROMPT ${stage.stageId}`,
    mcpConfigPath: '/ws/.aidlc/mcp.json',
    _scope: scope,
  }),
  materializeMcpConfig: async () => '/ws/.aidlc/mcp.json',
  materializeKiroAgent: async () => 'aidlc',
  renderRulesDoc,
  mcpEntry: '/opt/agentcore/mcp/index.js',
  availableClis: ['claude'],
  env: { BEDROCK_MODEL: 'us.anthropic.claude-sonnet-4-6' },
  spawnFn: () => {
    throw new Error('spawn should be stubbed via runChild path');
  },
  clock: () => 'T',
  // WP2 engine git: hermetic default — no repos in the fake payload means the
  // real hook would no-op anyway, but keep tests off real git entirely.
  commitAndPushAll: async () => ({ ok: true, committed: false, results: [] }),
  ...overrides,
});

describe('runStage — happy path', () => {
  let captured;
  beforeEach(() => {
    captured = null;
  });

  it('marks RUNNING, materializes, spawns the CLI, and records SUCCEEDED', async () => {
    const deps = baseDeps({
      // Stub the child to exit 0 and capture the argv it was given.
      spawnFn: (command, args) => {
        captured = { command, args };
        const child = {
          on: (ev, cb) => ev === 'close' && setImmediate(() => cb(0)),
          stdin: { end() {} },
        };
        return child;
      },
    });
    const res = await runStage(baseArgs, deps);
    expect(res).toMatchObject({ ok: true, state: 'SUCCEEDED', cli: 'claude' });

    const names = deps.store.calls.map((c) => c[0]);
    expect(names).toContain('putStage');
    expect(names).toContain('updateExecution');
    expect(names.filter((n) => n === 'updateStageState')).toHaveLength(1);
    // Final state write is SUCCEEDED.
    const finalState = deps.store.calls.find((c) => c[0] === 'updateStageState')[1];
    expect(finalState).toMatchObject({ state: 'SUCCEEDED' });
    // CLI was claude with the materialized prompt + mcp-config.
    expect(captured.command).toBe('claude');
    expect(captured.args).toContain('--mcp-config');
    expect(captured.args).toContain('/ws/.aidlc/mcp.json');
    // current phase/stage advanced.
    const execUpdate = deps.store.calls.find((c) => c[0] === 'updateExecution')[1];
    expect(execUpdate).toMatchObject({
      status: 'RUNNING',
      currentStage: 'requirements-analysis',
      currentPhase: 'inception',
    });
  });
});

describe('runStage — knowledge injection (both tiers reach the prompt)', () => {
  // Capture the `knowledge` string run-stage composes and hands to the materializer.
  const captureKnowledge = () => {
    let knowledge = null;
    const materializeStage = async ({ stage, ...rest }) => {
      knowledge = rest.knowledge;
      return { prompt: `PROMPT ${stage.stageId}`, mcpConfigPath: '/ws/.aidlc/mcp.json' };
    };
    return { materializeStage, get: () => knowledge };
  };

  const okSpawn = () => ({
    on: (ev, cb) => ev === 'close' && setImmediate(() => cb(0)),
    stdin: { end() {} },
  });

  it('selects the agent + shared methodology blocks (not other agents) for the prompt', async () => {
    const cap = captureKnowledge();
    const lib = library();
    lib.knowledgeById = {
      'product-guide': {
        id: 'product-guide',
        agentRef: 'aidlc-product-agent',
        bodyRef: { s3Key: 'k/guide' },
      },
      'shared-style': { id: 'shared-style', agentRef: 'shared', bodyRef: { s3Key: 'k/style' } },
      'other-agent': {
        id: 'other-agent',
        agentRef: 'aidlc-arch-agent',
        bodyRef: { s3Key: 'k/other' },
      },
    };
    await runStage(
      baseArgs,
      baseDeps({
        spawnFn: okSpawn,
        materializeStage: cap.materializeStage,
        loadLibrary: async () => ({ workflow: workflow(), library: lib }),
        loadBlockBody: async (b) => (b?.bodyRef?.s3Key ? `BODY:${b.bodyRef.s3Key}` : ''),
        // A graph whose writer returns one team-knowledge row.
        openGraph: async () => ({}),
      }),
    );
    const k = cap.get();
    // Methodology: the agent's own + shared, never another agent's.
    expect(k).toContain('BODY:k/guide');
    expect(k).toContain('BODY:k/style');
    expect(k).not.toContain('BODY:k/other');
  });

  it('degrades to methodology-only when the graph is unreachable', async () => {
    const cap = captureKnowledge();
    const lib = library();
    lib.knowledgeById = {
      'shared-style': { id: 'shared-style', agentRef: 'shared', bodyRef: { s3Key: 'k/style' } },
    };
    const res = await runStage(
      baseArgs,
      baseDeps({
        spawnFn: okSpawn,
        materializeStage: cap.materializeStage,
        loadLibrary: async () => ({ workflow: workflow(), library: lib }),
        loadBlockBody: async (b) => (b?.bodyRef?.s3Key ? `BODY:${b.bodyRef.s3Key}` : ''),
        openGraph: async () => {
          throw new Error('neptune down');
        },
      }),
    );
    // The stage still succeeds; knowledge falls back to the methodology tier.
    expect(res).toMatchObject({ ok: true });
    expect(cap.get()).toContain('BODY:k/style');
  });
});

describe('runStage — realtime broadcasts (state mirrors DynamoDB writes)', () => {
  const okSpawn = () => ({
    on: (ev, cb) => ev === 'close' && setImmediate(() => cb(0)),
    stdin: { end() {} },
  });

  it('publishes stage RUNNING + execution advance, then stage SUCCEEDED', async () => {
    const sent = [];
    await runStage(baseArgs, baseDeps({ spawnFn: okSpawn, broadcast: async (p) => sent.push(p) }));
    const actions = sent.map((p) => p.action);
    expect(actions).toContain('agent.stage');
    expect(actions).toContain('agent.execution');

    const running = sent.find((p) => p.action === 'agent.stage' && p.state === 'RUNNING');
    expect(running).toMatchObject({
      executionId: 'e1',
      intentId: 'i1',
      projectId: 'p1',
      stageId: 'requirements-analysis',
      phase: 'inception',
    });
    const exec = sent.find((p) => p.action === 'agent.execution');
    expect(exec).toMatchObject({
      status: 'RUNNING',
      currentStage: 'requirements-analysis',
      currentPhase: 'inception',
    });
    // Terminal success is broadcast last.
    expect(sent.at(-1)).toMatchObject({ action: 'agent.stage', state: 'SUCCEEDED' });
  });

  it('persists and broadcasts live Claude stdout as agent.output', async () => {
    const sent = [];
    const store = spyStore();
    await runStage(
      baseArgs,
      baseDeps({
        store,
        broadcast: async (p) => sent.push(p),
        spawnFn: () => {
          const child = new EventEmitter();
          child.stdin = { end() {} };
          child.stdout = new EventEmitter();
          setImmediate(() => {
            child.stdout.emit(
              'data',
              Buffer.from(
                `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'live text' }] } })}\n`,
              ),
            );
            child.emit('close', 0);
          });
          return child;
        },
      }),
    );

    expect(store.calls).toContainEqual([
      'appendOutput',
      expect.objectContaining({ kind: 'stdout', content: 'live text' }),
    ]);
    expect(sent).toContainEqual(
      expect.objectContaining({ action: 'agent.output', kind: 'stdout', content: 'live text' }),
    );
  });

  it('publishes stage FAILED on a non-zero CLI exit', async () => {
    const sent = [];
    const res = await runStage(
      baseArgs,
      baseDeps({
        broadcast: async (p) => sent.push(p),
        spawnFn: () => ({
          on: (ev, cb) => ev === 'close' && setImmediate(() => cb(2)),
          stdin: { end() {} },
        }),
      }),
    );
    expect(res).toMatchObject({ ok: false, reason: 'cli_nonzero_exit' });
    expect(sent.at(-1)).toMatchObject({
      action: 'agent.stage',
      state: 'FAILED',
      reason: 'cli_nonzero_exit',
    });
  });

  it('never lets a broadcast failure break the stage', async () => {
    const res = await runStage(
      baseArgs,
      baseDeps({
        spawnFn: okSpawn,
        broadcast: async () => {
          throw new Error('ws down');
        },
      }),
    );
    expect(res).toMatchObject({ ok: true, state: 'SUCCEEDED' });
  });
});

describe('mergeLearningRules — feeds the existing resolver at the right precedence', () => {
  const { mergeLearningRules } = __test;

  it('returns the inputs unchanged when there are no learning rules', () => {
    const wf = workflow();
    const lib = library();
    const out = mergeLearningRules({ workflow: wf, library: lib, learningRules: [] });
    expect(out.workflow).toBe(wf);
    expect(out.library).toBe(lib);
  });

  it('adds a RULE block + ruleRef so the plan resolver interleaves it at layer precedence', () => {
    const learningRules = [
      {
        id: 'no-secrets',
        title: 'No plaintext secrets',
        content: 'NEVER store secrets in plaintext',
        layer: 'project-learnings',
        pairing: 'feedforward-only',
      },
    ];
    const { workflow: wf, library: lib } = mergeLearningRules({
      workflow: workflow(),
      library: library(),
      learningRules,
    });
    // The merged rule is a RULE block carrying its Neptune content inline as body.
    expect(lib.rulesById['no-secrets']).toMatchObject({
      type: 'RULE',
      layer: 'project-learnings',
      body: 'NEVER store secrets in plaintext',
    });
    expect(wf.ruleRefs).toContainEqual({ layer: 'project-learnings', ruleId: 'no-secrets' });

    // The REAL resolver places it in the stage's universal stack (proves the
    // pre-wired team-learnings/project-learnings precedence is what carries it).
    const { valid, plan } = buildExecutionPlan({ workflow: wf, scope: 'feature', library: lib });
    expect(valid).toBe(true);
    const stage = plan.stages.find((s) => s.stageId === 'requirements-analysis');
    expect(stage.rules.universal).toContain('no-secrets');
  });

  it('does not clone-mutate the caller library (pure)', () => {
    const lib = library();
    mergeLearningRules({
      workflow: workflow(),
      library: lib,
      learningRules: [{ id: 'r', content: 'c', layer: 'team-learnings' }],
    });
    expect(lib.rulesById.r).toBeUndefined();
  });

  it('never overrides an authored library rule of the same id', () => {
    const lib = library();
    lib.rulesById['no-secrets'] = {
      id: 'no-secrets',
      type: 'RULE',
      layer: 'org',
      body: 'authored',
    };
    const wf0 = workflow();
    wf0.ruleRefs = [{ layer: 'org', ruleId: 'no-secrets' }];
    const { workflow: wf, library: out } = mergeLearningRules({
      workflow: wf0,
      library: lib,
      learningRules: [{ id: 'no-secrets', content: 'accrued', layer: 'project-learnings' }],
    });
    // Authored rule wins; no duplicate ruleRef added.
    expect(out.rulesById['no-secrets'].body).toBe('authored');
    expect(wf.ruleRefs.filter((r) => r.ruleId === 'no-secrets')).toHaveLength(1);
  });
});

describe('CLI output sink — UI-safe stdout', () => {
  const { createCliOutputSink, stripTerminalControls } = __test;
  const esc = String.fromCharCode(27);

  it('strips ANSI and orphaned color fragments before emitting UI output', () => {
    expect(stripTerminalControls(`${esc}[38;5;141mtool${esc}[0m [38;5;244mmeta[0m`)).toBe(
      'tool meta',
    );
  });

  it('suppresses raw Kiro send_output terminal blocks to avoid duplicate final output', () => {
    const emitted = [];
    const sink = createCliOutputSink({ cli: 'kiro', emit: (text) => emitted.push(text) });
    sink.write('Before\n');
    sink.write(`Running tool  ${esc}[38;5;141msend_output${esc}[0m with the param\n`);
    sink.write(' ⋮  { "content": "Clean final" }\n');
    sink.write(`${esc}[0m# Clean final\n`);
    sink.write(` ${esc}[38;5;244m - Completed in 0.45s${esc}[0m\n`);
    sink.write('After\n');
    sink.flush();

    expect(emitted.join('')).toBe('Before\nAfter\n');
  });
});

describe('runStage — model resolution precedence', () => {
  // Capture the --model value the selected driver was invoked with.
  const captureModel = () => {
    let model = null;
    const spawnFn = (command, args) => {
      const i = args.indexOf('--model');
      model = i >= 0 ? args[i + 1] : null;
      return { on: (ev, cb) => ev === 'close' && setImmediate(() => cb(0)), stdin: { end() {} } };
    };
    return { spawnFn, get: () => model };
  };

  it('uses the project cliModels[cli] over the env default', async () => {
    const cap = captureModel();
    await runStage(
      { ...baseArgs, cliModels: { claude: 'us.anthropic.claude-opus-4-8' } },
      baseDeps({ spawnFn: cap.spawnFn }),
    );
    expect(cap.get()).toBe('us.anthropic.claude-opus-4-8');
  });

  it('falls back to the env default when no cliModels entry for the selected CLI', async () => {
    const cap = captureModel();
    await runStage(
      { ...baseArgs, cliModels: { kiro: 'some-kiro-model' } }, // no claude key
      baseDeps({ spawnFn: cap.spawnFn }),
    );
    expect(cap.get()).toBe('us.anthropic.claude-sonnet-4-6'); // env BEDROCK_MODEL
  });

  it('lets the project cliModels WIN over a stage/agent modelOverride', async () => {
    const cap = captureModel();
    const lib = library();
    lib.agentsById['aidlc-product-agent'].modelOverride = 'opus';
    await runStage(
      { ...baseArgs, cliModels: { claude: 'us.anthropic.claude-sonnet-4-6' } },
      baseDeps({
        spawnFn: cap.spawnFn,
        loadLibrary: async () => ({ workflow: workflow(), library: lib }),
      }),
    );
    // Project selection wins — not the agent's opus override.
    expect(cap.get()).toBe('us.anthropic.claude-sonnet-4-6');
  });

  it('resolves a bare agent alias (opus) to a full region-prefixed id when no project model', async () => {
    const cap = captureModel();
    const lib = library();
    lib.agentsById['aidlc-product-agent'].modelOverride = 'opus';
    await runStage(
      baseArgs, // no cliModels
      baseDeps({
        spawnFn: cap.spawnFn,
        loadLibrary: async () => ({ workflow: workflow(), library: lib }),
        env: { BEDROCK_MODEL: 'unused', AWS_REGION: 'us-east-1' },
      }),
    );
    expect(cap.get()).toBe('us.anthropic.claude-opus-4-6-v1');
  });
});

describe('runStage — failure paths (always records terminal state)', () => {
  it('fails when no CLI is installed', async () => {
    const deps = baseDeps({ availableClis: [] });
    const res = await runStage(baseArgs, deps);
    expect(res).toMatchObject({ ok: false, reason: 'no_cli' });
    expect(
      deps.store.calls.some((c) => c[0] === 'updateStageState' && c[1].state === 'FAILED'),
    ).toBe(true);
  });

  it('fails when the workflow is not found', async () => {
    const deps = baseDeps({ loadLibrary: async () => ({ workflow: null, library: null }) });
    const res = await runStage(baseArgs, deps);
    expect(res).toMatchObject({ ok: false, reason: 'workflow_not_found' });
  });

  it('fails when the stage is not in scope', async () => {
    const res = await runStage({ ...baseArgs, stageId: 'ghost' }, baseDeps());
    expect(res).toMatchObject({ ok: false, reason: 'stage_not_in_scope' });
  });

  it('records FAILED on a non-zero CLI exit', async () => {
    const deps = baseDeps({
      spawnFn: () => ({
        on: (ev, cb) => ev === 'close' && setImmediate(() => cb(2)),
        stdin: { end() {} },
      }),
    });
    const res = await runStage(baseArgs, deps);
    expect(res).toMatchObject({ ok: false, reason: 'cli_nonzero_exit', detail: '2' });
    expect(
      deps.store.calls.some((c) => c[0] === 'updateStageState' && c[1].state === 'FAILED'),
    ).toBe(true);
  });

  it('fails fast on a not-implemented (agent-team) stage without spawning', async () => {
    const lib = library();
    lib.stagesById['requirements-analysis'].mode = 'agent-team';
    let spawned = false;
    const deps = baseDeps({
      loadLibrary: async () => ({ workflow: workflow(), library: lib }),
      spawnFn: () => (spawned = true),
    });
    const res = await runStage(baseArgs, deps);
    expect(res).toMatchObject({ ok: false, reason: 'not_implemented' });
    expect(spawned).toBe(false);
  });
});

describe('withPlatformSensors — runtime-injected graph-coverage', () => {
  it('appends the advisory graph-coverage sensor when a registered type is produced', () => {
    const merged = withPlatformSensors({
      sensors: [{ sensorId: 'required-sections', severity: 'blocking' }],
      outputArtifacts: [{ artifact: 'stories' }],
    });
    expect(merged).toHaveLength(2);
    expect(merged[1]).toEqual({ sensorId: 'graph-coverage', severity: 'advisory' });
  });

  it('injects nothing for unregistered outputs (no sensor pass on plain stages)', () => {
    expect(
      withPlatformSensors({ sensors: [], outputArtifacts: [{ artifact: 'code-summary' }] }),
    ).toEqual([]);
    expect(withPlatformSensors({ sensors: [], outputArtifacts: [] })).toEqual([]);
    expect(withPlatformSensors({})).toEqual([]);
  });

  it('an authored graph-coverage binding wins (severity/strictness stay authoritative)', () => {
    const authored = [{ sensorId: 'graph-coverage', severity: 'blocking' }];
    const merged = withPlatformSensors({
      sensors: authored,
      outputArtifacts: [{ artifact: 'requirements' }],
    });
    expect(merged).toEqual(authored);
  });
});

describe('runStage — deterministic sensors', () => {
  const okSpawn = () => ({
    on: (ev, cb) => ev === 'close' && setImmediate(() => cb(0)),
    stdin: { end() {} },
  });
  // A library whose stage declares a graph sensor + the SENSOR block it resolves.
  const libWithSensor = (severity) => {
    const lib = library();
    lib.stagesById['requirements-analysis'].sensors = ['required-sections'];
    lib.sensorsById = {
      'required-sections': {
        id: 'required-sections',
        command: 'bun <runtime-managed>/tools/aidlc-sensor-required-sections.ts',
        runtime: 'bun',
        severity,
        matches: '**/aidlc-docs/**',
      },
    };
    return lib;
  };

  // A graph whose lookupArtifacts traversal returns one row with the given
  // content. A chainable proxy absorbs any gremlin step and yields the row at
  // toList()/next() — robust to the exact traversal shape.
  const graphReturning = (content) => async () => {
    const rows = [{ id: ['a1'], content: [content], artifact_type: ['requirements-analysis'] }];
    const proxy = new Proxy(
      {},
      {
        get(_t, prop) {
          // Must NOT be thenable — `await openGraph()` would hang otherwise.
          if (prop === 'then' || typeof prop === 'symbol') return undefined;
          if (prop === 'toList') return async () => rows;
          if (prop === 'next') return async () => ({ value: rows[0] });
          if (prop === 'hasNext') return async () => true;
          return () => proxy;
        },
      },
    );
    return proxy;
  };

  it('an advisory sensor that does not PASS records a verdict but never fails the stage', async () => {
    const deps = baseDeps({
      spawnFn: okSpawn,
      loadLibrary: async () => ({ workflow: workflow(), library: libWithSensor('advisory') }),
      // No openGraph → graph sensor BLOCKED, but advisory never holds.
    });
    const res = await runStage(baseArgs, deps);
    expect(res).toMatchObject({ ok: true, state: 'SUCCEEDED' });
    expect(deps.store.calls.some((c) => c[0] === 'recordSensorRun')).toBe(true);
  });

  it('surfaces a NON-PASS advisory verdict as a v2.sensor.flagged event (does not hold)', async () => {
    const deps = baseDeps({
      spawnFn: okSpawn,
      loadLibrary: async () => ({ workflow: workflow(), library: libWithSensor('advisory') }),
      // Graph returns content missing the required artifact → non-PASS verdict.
      openGraph: graphReturning('## only one heading\n\nbody'),
    });
    const res = await runStage(baseArgs, deps);
    expect(res).toMatchObject({ ok: true, state: 'SUCCEEDED' });
    expect(
      deps.store.calls.some((c) => c[0] === 'appendEvent' && c[1].type === 'v2.sensor.flagged'),
    ).toBe(true);
  });

  it('does NOT emit a v2.sensor.flagged event when the sensor PASSES', async () => {
    const deps = baseDeps({
      spawnFn: okSpawn,
      loadLibrary: async () => ({ workflow: workflow(), library: libWithSensor('advisory') }),
      openGraph: graphReturning('## A\n\nx\n\n## B\n\ny'),
    });
    const res = await runStage(baseArgs, deps);
    expect(res).toMatchObject({ ok: true, state: 'SUCCEEDED' });
    expect(
      deps.store.calls.some((c) => c[0] === 'appendEvent' && c[1].type === 'v2.sensor.flagged'),
    ).toBe(false);
  });

  it('a blocking sensor that FAILS holds the stage (sensor_blocked, FAILED)', async () => {
    const deps = baseDeps({
      spawnFn: okSpawn,
      loadLibrary: async () => ({ workflow: workflow(), library: libWithSensor('blocking') }),
      // Graph returns content with < 2 H2 headings → required-sections FAIL.
      openGraph: graphReturning('## only one heading\n\nbody'),
    });
    const res = await runStage(baseArgs, deps);
    expect(res).toMatchObject({ ok: false, reason: 'sensor_blocked' });
    expect(
      deps.store.calls.some((c) => c[0] === 'updateStageState' && c[1].state === 'FAILED'),
    ).toBe(true);
  });

  it('a blocking sensor that PASSES lets the stage succeed', async () => {
    const deps = baseDeps({
      spawnFn: okSpawn,
      loadLibrary: async () => ({ workflow: workflow(), library: libWithSensor('blocking') }),
      openGraph: graphReturning('## A\n\nx\n\n## B\n\ny'),
    });
    const res = await runStage(baseArgs, deps);
    expect(res).toMatchObject({ ok: true, state: 'SUCCEEDED' });
  });

  // Regression: the session process is long-lived and reused across every stage.
  // Each openGraph() opens a WebSocket (a socket fd); if run-stage doesn't close
  // it, fds accumulate stage-over-stage until the process hits EMFILE ("too many
  // open files") and the NEXT stage crashes on startup (the real requirements-
  // analysis crash). Assert every graph connection run-stage opens is closed.
  it('closes every graph connection it opens (no fd leak across stages)', async () => {
    let opened = 0;
    let closed = 0;
    // A traversal-source proxy that also carries a spy `remoteConnection.close`
    // (where gremlin puts the closable connection), so we can count closes.
    const countingGraph = async () => {
      opened += 1;
      const rows = [
        {
          id: ['a1'],
          content: ['## A\n\nx\n\n## B\n\ny'],
          artifact_type: ['requirements-analysis'],
        },
      ];
      const proxy = new Proxy(
        { remoteConnection: { close: async () => ((closed += 1), undefined) } },
        {
          get(target, prop) {
            if (prop === 'remoteConnection') return target.remoteConnection;
            if (prop === 'then' || typeof prop === 'symbol') return undefined;
            if (prop === 'toList') return async () => rows;
            if (prop === 'next') return async () => ({ value: rows[0] });
            if (prop === 'hasNext') return async () => true;
            return () => proxy;
          },
        },
      );
      return proxy;
    };
    const deps = baseDeps({
      spawnFn: okSpawn,
      loadLibrary: async () => ({ workflow: workflow(), library: libWithSensor('advisory') }),
      openGraph: countingGraph,
    });
    const res = await runStage(baseArgs, deps);
    expect(res).toMatchObject({ ok: true, state: 'SUCCEEDED' });
    // At least one connection was opened (readProjectMemory + the sensor pass),
    // and every one was closed.
    expect(opened).toBeGreaterThan(0);
    expect(closed).toBe(opened);
  });
});

describe('runStage — LLM reviewer axis', () => {
  const okSpawn = () => ({
    on: (ev, cb) => ev === 'close' && setImmediate(() => cb(0)),
    stdin: { end() {} },
  });

  const libWithReviewer = ({ humanValidation = 'required', reviewerMaxIterations = 1 } = {}) => {
    const lib = library();
    lib.stagesById['requirements-analysis'].reviewer = 'aidlc-reviewer-agent';
    lib.stagesById['requirements-analysis'].reviewerMaxIterations = reviewerMaxIterations;
    lib.stagesById['requirements-analysis'].humanValidation = humanValidation;
    lib.agentsById['aidlc-reviewer-agent'] = {
      id: 'aidlc-reviewer-agent',
      modelOverride: null,
      bodyRef: { s3Key: 'blocks/bodies/sha256/reviewer' },
    };
    return lib;
  };

  const storeWithVerdict = (verdict, findings = 'needs work') => {
    const store = spyStore();
    store.listSensorRuns = async () => [
      {
        sensorRunId: 'review-1',
        stageInstanceId: 'si-f952091522a81cfb',
        sensorId: 'reviewer:aidlc-reviewer-agent',
        kind: 'reviewer',
        result: verdict === 'READY' ? 'PASS' : 'FAIL',
        detail: { verdict, findings },
      },
    ];
    return store;
  };

  const reviewerRow = (verdict, findings = 'needs work') => ({
    sensorRunId: `review-${verdict}`,
    stageInstanceId: 'si-f952091522a81cfb',
    sensorId: 'reviewer:aidlc-reviewer-agent',
    kind: 'reviewer',
    result: verdict === 'READY' ? 'PASS' : 'FAIL',
    detail: { verdict, findings },
  });

  const storeWithVerdictSequence = (verdicts) => {
    const store = spyStore();
    let ix = 0;
    store.listSensorRuns = vi.fn(async () => [
      reviewerRow(verdicts[Math.min(ix++, verdicts.length - 1)]),
    ]);
    return store;
  };

  it('fails a reviewer-only stage when the reviewer returns NOT-READY', async () => {
    const deps = baseDeps({
      store: storeWithVerdict('NOT-READY', 'missing acceptance criteria'),
      spawnFn: okSpawn,
      loadLibrary: async () => ({
        workflow: workflow(),
        library: libWithReviewer({ humanValidation: 'none' }),
      }),
    });
    const res = await runStage(baseArgs, deps);
    expect(res).toMatchObject({ ok: false, reason: 'reviewer_not_ready' });
  });

  it('lets a NOT-READY reviewer verdict proceed when human validation follows', async () => {
    const deps = baseDeps({
      store: storeWithVerdict('NOT-READY', 'human should decide'),
      spawnFn: okSpawn,
      loadLibrary: async () => ({
        workflow: workflow(),
        library: libWithReviewer({ humanValidation: 'required' }),
      }),
    });
    const res = await runStage(baseArgs, deps);
    expect(res).toMatchObject({ ok: true, state: 'SUCCEEDED' });
  });

  it('retries a NOT-READY reviewer verdict up to reviewerMaxIterations before failing', async () => {
    const store = storeWithVerdictSequence(['NOT-READY', 'NOT-READY', 'NOT-READY']);
    const spawnFn = vi.fn(okSpawn);
    const deps = baseDeps({
      store,
      spawnFn,
      loadLibrary: async () => ({
        workflow: workflow(),
        library: libWithReviewer({ humanValidation: 'none', reviewerMaxIterations: 3 }),
      }),
    });

    const res = await runStage(baseArgs, deps);

    expect(res).toMatchObject({ ok: false, reason: 'reviewer_not_ready' });
    expect(store.listSensorRuns).toHaveBeenCalledTimes(3);
    // One builder invocation plus three clean-room reviewer invocations.
    expect(spawnFn).toHaveBeenCalledTimes(4);
  });

  it('stops reviewer retries early once a READY verdict lands', async () => {
    const store = storeWithVerdictSequence(['NOT-READY', 'READY', 'READY']);
    const spawnFn = vi.fn(okSpawn);
    const deps = baseDeps({
      store,
      spawnFn,
      loadLibrary: async () => ({
        workflow: workflow(),
        library: libWithReviewer({ humanValidation: 'none', reviewerMaxIterations: 3 }),
      }),
    });

    const res = await runStage(baseArgs, deps);

    expect(res).toMatchObject({ ok: true, state: 'SUCCEEDED' });
    expect(store.listSensorRuns).toHaveBeenCalledTimes(2);
    // One builder invocation plus two clean-room reviewer invocations.
    expect(spawnFn).toHaveBeenCalledTimes(3);
  });
});

describe('runStage — fresh run persists the CLI session + parks on a pending gate', () => {
  const okSpawn = () => ({
    on: (ev, cb) => ev === 'close' && setImmediate(() => cb(0)),
    stdin: { end() {} },
  });

  it('forces a Claude session id up front and persists it on the stage row', async () => {
    const deps = baseDeps({ spawnFn: okSpawn, ids: () => 'forced-uuid' });
    const res = await runStage(baseArgs, deps);
    expect(res).toMatchObject({ ok: true, state: 'SUCCEEDED', cli: 'claude' });
    // putStage carried the minted session id + cli.
    const putStage = deps.store.calls.find((c) => c[0] === 'putStage')[1];
    expect(putStage).toMatchObject({ cli: 'claude', cliSessionId: 'forced-uuid' });
  });

  it('parks WAITING_FOR_HUMAN (no SUCCEEDED) when a gate is still pending at exit', async () => {
    const deps = baseDeps({
      spawnFn: okSpawn,
      ids: () => 'forced-uuid',
      store: spyStore({
        execution: { pendingHumanTaskId: 'q-1' },
        humanTask: { humanTaskId: 'q-1', status: 'pending' },
      }),
    });
    const res = await runStage(baseArgs, deps);
    expect(res).toMatchObject({
      ok: true,
      state: 'WAITING_FOR_HUMAN',
      humanTaskId: 'q-1',
      cli: 'claude',
      cliSessionId: 'forced-uuid',
    });
    // The parked stage write is WAITING_FOR_HUMAN — never SUCCEEDED.
    const states = deps.store.calls
      .filter((c) => c[0] === 'updateStageState')
      .map((c) => c[1].state);
    expect(states).toContain('WAITING_FOR_HUMAN');
    expect(states).not.toContain('SUCCEEDED');
    // The park stamps parkedAt (wait accounting) — `true` when the gate row
    // carries no createdAt (the store stamps "now").
    const parkPatch = deps.store.calls.find(
      (c) => c[0] === 'updateStageState' && c[1].state === 'WAITING_FOR_HUMAN',
    )[1];
    expect(parkPatch.parkedAt).toBe(true);
    expect(
      deps.store.calls.some((c) => c[0] === 'appendEvent' && c[1].type === 'v2.stage.parked'),
    ).toBe(true);
  });

  it('re-stamps parkedAt with the gate ASK time so the exit-time write never shortens the wait', async () => {
    const deps = baseDeps({
      spawnFn: okSpawn,
      ids: () => 'forced-uuid',
      store: spyStore({
        execution: { pendingHumanTaskId: 'q-1' },
        humanTask: {
          humanTaskId: 'q-1',
          status: 'pending',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      }),
    });
    await runStage(baseArgs, deps);
    const parkPatch = deps.store.calls.find(
      (c) => c[0] === 'updateStageState' && c[1].state === 'WAITING_FOR_HUMAN',
    )[1];
    expect(parkPatch.parkedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('records agentLaunchMs (cold start) as a metric sample when the dispatcher measured one', async () => {
    const deps = baseDeps({ spawnFn: okSpawn });
    const res = await runStage({ ...baseArgs, agentLaunchMs: 3400 }, deps);
    expect(res).toMatchObject({ ok: true, state: 'SUCCEEDED' });
    const metric = deps.store.calls.find(
      (c) => c[0] === 'recordMetric' && c[1].metrics?.agentLaunchMs !== undefined,
    );
    expect(metric[1].metrics.agentLaunchMs).toBe(3400);
  });

  it('records no launch metric without the measurement (legacy sync path)', async () => {
    const deps = baseDeps({ spawnFn: okSpawn });
    await runStage(baseArgs, deps);
    expect(
      deps.store.calls.some(
        (c) => c[0] === 'recordMetric' && c[1].metrics?.agentLaunchMs !== undefined,
      ),
    ).toBe(false);
  });

  it('parks (not fails) on a NON-ZERO exit when a gate is pending — the gate is the truth', async () => {
    // A Kiro-style run that parks a question then errors on its next model turn:
    // CLI exits non-zero, but the durable pending gate means the stage is parked.
    const crashAfterPark = () => ({
      on: (ev, cb) => ev === 'close' && setImmediate(() => cb(1)),
      stdin: { end() {} },
    });
    const deps = baseDeps({
      spawnFn: crashAfterPark,
      ids: () => 'forced-uuid',
      store: spyStore({
        execution: { pendingHumanTaskId: 'q-9' },
        humanTask: { humanTaskId: 'q-9', status: 'pending' },
      }),
    });
    const res = await runStage(baseArgs, deps);
    expect(res).toMatchObject({ ok: true, state: 'WAITING_FOR_HUMAN', humanTaskId: 'q-9' });
    // Did NOT mark the stage FAILED / report cli_nonzero_exit.
    expect(res.reason).toBeUndefined();
    const states = deps.store.calls
      .filter((c) => c[0] === 'updateStageState')
      .map((c) => c[1].state);
    expect(states).not.toContain('FAILED');
  });

  it('still fails cli_nonzero_exit on a non-zero exit with NO pending gate', async () => {
    const deps = baseDeps({
      spawnFn: () => ({
        on: (ev, cb) => ev === 'close' && setImmediate(() => cb(2)),
        stdin: { end() {} },
      }),
      // default spyStore → getExecution returns null → no pending gate
    });
    const res = await runStage(baseArgs, deps);
    expect(res).toMatchObject({ ok: false, reason: 'cli_nonzero_exit', detail: '2' });
  });

  it('treats a Kiro empty-final-completion crash as success (work already done)', async () => {
    // kiro-cli exits non-zero after the turn's work because it ended with an
    // empty final message; its ACP reports "Kiro failed to generate a response".
    // A kiro run emits that on stderr; runChild tees it into stderrTail.
    const kiroCrash = () => ({
      on: (ev, cb) => ev === 'close' && setImmediate(() => cb(1)),
      stderr: {
        on: (ev, cb) => {
          if (ev === 'data') {
            cb(
              Buffer.from(
                'Kiro is having trouble responding right now:\n  0: Failed to receive the next message: request_id: abc, error: Kiro failed to generate a response\n',
              ),
            );
          }
        },
      },
      stdin: { end() {} },
    });
    const deps = baseDeps({
      spawnFn: kiroCrash,
      availableClis: ['kiro'],
      env: { BEDROCK_MODEL: 'us.anthropic.claude-sonnet-4-6' },
    });
    const res = await runStage({ ...baseArgs, cliModels: { kiro: 'claude-opus-4.6' } }, deps);
    expect(res).toMatchObject({ ok: true, state: 'SUCCEEDED', cli: 'kiro' });
    // Recorded a note explaining the benign exit.
    expect(
      deps.store.calls.some(
        (c) => c[0] === 'appendEvent' && /empty final message/.test(c[1].summary ?? ''),
      ),
    ).toBe(true);
  });

  it('does NOT swallow a Kiro backend transport error (dispatch failure) — still fails', async () => {
    const kiroTransport = () => ({
      on: (ev, cb) => ev === 'close' && setImmediate(() => cb(1)),
      stderr: {
        on: (ev, cb) => {
          if (ev === 'data') {
            cb(
              Buffer.from(
                'Failed to receive the next message: request_id: abc, error: dispatch failure (io error): request or response body error\n',
              ),
            );
          }
        },
      },
      stdin: { end() {} },
    });
    const deps = baseDeps({
      spawnFn: kiroTransport,
      availableClis: ['kiro'],
      env: { BEDROCK_MODEL: 'us.anthropic.claude-sonnet-4-6' },
    });
    const res = await runStage({ ...baseArgs, cliModels: { kiro: 'claude-opus-4.6' } }, deps);
    expect(res).toMatchObject({ ok: false, reason: 'cli_nonzero_exit' });
  });
});

describe('isBenignKiroEmptyCompletion', () => {
  const { isBenignKiroEmptyCompletion } = __test;

  it('matches the empty-completion ACP signature', () => {
    expect(
      isBenignKiroEmptyCompletion(
        '0: Failed to receive the next message: request_id: x, error: Kiro failed to generate a response',
      ),
    ).toBe(true);
  });

  it('does not match real transport/backend errors', () => {
    for (const cause of [
      'error: dispatch failure (io error): request or response body error',
      'error: InternalServerError: Encountered an unexpected error',
      'error: ThrottlingException: slow down',
      'error: EOF while parsing a string at line 1 column 5214',
    ]) {
      expect(isBenignKiroEmptyCompletion(`Failed to receive the next message: ${cause}`)).toBe(
        false,
      );
    }
  });

  it('does not match when the signature phrase is absent', () => {
    expect(isBenignKiroEmptyCompletion('')).toBe(false);
    expect(isBenignKiroEmptyCompletion('some unrelated stderr noise')).toBe(false);
  });

  it('a transport cause alongside the phrase still fails closed (does not swallow)', () => {
    // Defensive: if both strings appear, prefer NOT to swallow.
    expect(
      isBenignKiroEmptyCompletion(
        'Kiro failed to generate a response ... dispatch failure (io error)',
      ),
    ).toBe(false);
  });
});

describe('runStage — resume mode', () => {
  const okSpawn = () => ({
    on: (ev, cb) => ev === 'close' && setImmediate(() => cb(0)),
    stdin: { end() {} },
  });

  // Capture the argv the resume invocation produced.
  const captureArgv = () => {
    let captured = null;
    const spawnFn = (command, args) => {
      captured = { command, args };
      return { on: (ev, cb) => ev === 'close' && setImmediate(() => cb(0)), stdin: { end() {} } };
    };
    return { spawnFn, get: () => captured };
  };

  it('resumes the persisted Claude conversation with --resume + the answer, reaches SUCCEEDED', async () => {
    const cap = captureArgv();
    const deps = baseDeps({
      spawnFn: cap.spawnFn,
      store: spyStore({
        humanTask: {
          humanTaskId: 'q-1',
          status: 'answered',
          answer: { perQuestion: [{ text: 'Scope?', answer: 'MVP' }] },
        },
        stage: { cli: 'claude', cliSessionId: 'sess-7' },
      }),
    });
    const res = await runStage({ ...baseArgs, resumeFrom: 'q-1' }, deps);
    expect(res).toMatchObject({ ok: true, state: 'SUCCEEDED', cli: 'claude' });
    // Built a --resume invocation targeting the persisted session id.
    expect(cap.get().command).toBe('claude');
    expect(cap.get().args).toContain('--resume');
    expect(cap.get().args).toContain('sess-7');
    // The answer text reached the prompt (-p arg).
    const pi = cap.get().args.indexOf('-p');
    expect(cap.get().args[pi + 1]).toMatch(/MVP/);
    // A resumed event was recorded.
    expect(
      deps.store.calls.some((c) => c[0] === 'appendEvent' && c[1].type === 'v2.stage.resumed'),
    ).toBe(true);
    // The RUNNING flip is a PATCH (resumeStageRow) — never a full-row putStage,
    // which would re-stamp startedAt (the "duration resets on answer" bug).
    expect(deps.store.calls.some((c) => c[0] === 'resumeStageRow')).toBe(true);
    expect(deps.store.calls.some((c) => c[0] === 'putStage')).toBe(false);
  });

  it('a fresh run carries the existing row attempt forward (rewind reset sets attempt+1)', async () => {
    const deps = baseDeps({
      spawnFn: okSpawn,
      store: spyStore({ stage: { state: 'PENDING', attempt: 2 } }),
    });
    const res = await runStage(baseArgs, deps);
    expect(res).toMatchObject({ ok: true, state: 'SUCCEEDED' });
    const put = deps.store.calls.find((c) => c[0] === 'putStage')[1];
    expect(put).toMatchObject({ state: 'RUNNING', attempt: 2 });
  });

  it('fails gate_not_answered when the gate is still pending', async () => {
    const deps = baseDeps({
      spawnFn: okSpawn,
      store: spyStore({
        humanTask: { humanTaskId: 'q-1', status: 'pending' },
        stage: { cli: 'claude', cliSessionId: 'sess-7' },
      }),
    });
    const res = await runStage({ ...baseArgs, resumeFrom: 'q-1' }, deps);
    expect(res).toMatchObject({ ok: false, reason: 'gate_not_answered' });
  });

  it('fails resume_no_session when the stage has no persisted CLI session', async () => {
    const deps = baseDeps({
      spawnFn: okSpawn,
      store: spyStore({
        humanTask: { humanTaskId: 'q-1', status: 'answered', answer: { freeText: 'go' } },
        stage: { cli: null, cliSessionId: null },
      }),
    });
    const res = await runStage({ ...baseArgs, resumeFrom: 'q-1' }, deps);
    expect(res).toMatchObject({ ok: false, reason: 'resume_no_session' });
  });
});

describe('runStage — Kiro SQLite store sync (restore before spawn, persist after)', () => {
  const okSpawn = () => ({
    on: (ev, cb) => ev === 'close' && setImmediate(() => cb(0)),
    stdin: { end() {} },
  });
  // Kiro library so selectCli picks kiro; capture sync ordering relative to spawn.
  it('restores before the CLI spawns and persists after it exits', async () => {
    const order = [];
    const deps = baseDeps({
      availableClis: ['kiro'],
      // Kiro id capture (--list-sessions) + the run share spawnFn; both exit 0.
      spawnFn: (command, args) => {
        if (args.includes('--list-sessions')) {
          order.push('capture');
          return {
            on: (ev, cb) => ev === 'close' && setImmediate(() => cb(0)),
            stdout: {
              on: (ev, cb) =>
                ev === 'data' &&
                cb(
                  Buffer.from(
                    JSON.stringify([
                      {
                        cwd: '/ws',
                        sessions: [{ sessionId: 'kiro-7', updatedAt: '2026-06-29T12:00:00Z' }],
                      },
                    ]),
                  ),
                ),
            },
            stdin: { end() {} },
          };
        }
        order.push('spawn');
        return okSpawn();
      },
      restoreKiroStore: async () => {
        order.push('restore');
        return true;
      },
      persistKiroStore: async () => {
        order.push('persist');
        return true;
      },
    });
    const res = await runStage({ ...baseArgs, requestedCli: 'kiro' }, deps);
    expect(res).toMatchObject({ ok: true, state: 'SUCCEEDED', cli: 'kiro' });
    // restore precedes the run spawn; persist follows it.
    expect(order.indexOf('restore')).toBeLessThan(order.indexOf('spawn'));
    expect(order.indexOf('persist')).toBeGreaterThan(order.indexOf('spawn'));
    // Kiro session id captured post-run and persisted on the stage row.
    const csid = deps.store.calls
      .filter((c) => c[0] === 'updateStageState')
      .map((c) => c[1].cliSessionId)
      .filter(Boolean);
    expect(csid).toContain('kiro-7');
  });

  it('does not sync the Kiro store for a Claude stage', async () => {
    let touched = false;
    const deps = baseDeps({
      spawnFn: okSpawn,
      restoreKiroStore: async () => ((touched = true), false),
      persistKiroStore: async () => ((touched = true), false),
    });
    const res = await runStage(baseArgs, deps); // claude (default)
    expect(res).toMatchObject({ ok: true, cli: 'claude' });
    expect(touched).toBe(false);
  });

  // Env that makes resolveKiroStore() non-null (a real managed mount is
  // configured), so the resume amnesia guard is armed.
  const kiroStoreEnv = {
    BEDROCK_MODEL: 'us.anthropic.claude-sonnet-4-6',
    XDG_DATA_HOME: '/home/node/.kiro-data',
    V2_KIRO_STORE_DIR: '/mnt/workspace/.kiro-data',
  };

  it('recovers a resume with a lost Kiro store by re-running fresh (recent gate)', async () => {
    // D2 recoverable path: mount wiped (restore fails, mount configured) but the
    // gate is recent → re-run the stage FRESH with the answer injected, not a blind
    // fail. A fresh Kiro run captures a new session id via --list-sessions.
    const deps = baseDeps({
      availableClis: ['kiro'],
      env: kiroStoreEnv,
      spawnFn: (command, args) =>
        args.includes('--list-sessions')
          ? {
              on: (ev, cb) => ev === 'close' && setImmediate(() => cb(0)),
              stdout: {
                on: (ev, cb) =>
                  ev === 'data' &&
                  cb(
                    Buffer.from(
                      JSON.stringify([
                        { cwd: '/ws', sessions: [{ sessionId: 'kiro-new', updatedAt: 'T' }] },
                      ]),
                    ),
                  ),
              },
              stdin: { end() {} },
            }
          : okSpawn(),
      restoreKiroStore: async () => false, // mount wiped
      store: spyStore({
        // No createdAt → age unknown → treated as recent → recoverable.
        humanTask: { humanTaskId: 'q-1', status: 'answered', answer: { freeText: 'go' } },
        stage: { cli: 'kiro', cliSessionId: 'kiro-7' },
      }),
    });
    const res = await runStage({ ...baseArgs, requestedCli: 'kiro', resumeFrom: 'q-1' }, deps);
    expect(res).toMatchObject({ ok: true, state: 'SUCCEEDED', cli: 'kiro' });
    // A recovery note is recorded and a NEW session id is captured (fresh run).
    expect(
      deps.store.calls.some((c) => c[0] === 'appendEvent' && c[1].type === 'v2.stage.recovered'),
    ).toBe(true);
  });

  it('fails resume_store_expired when the lost conversation is over 14 days old', async () => {
    let spawned = false;
    const deps = baseDeps({
      availableClis: ['kiro'],
      env: kiroStoreEnv,
      spawnFn: () => ((spawned = true), okSpawn()),
      restoreKiroStore: async () => false, // mount wiped / expired
      clock: () => '2026-07-01T00:00:00Z',
      store: spyStore({
        // Gate asked 15 days before the clock → past the 14-day storage window.
        humanTask: {
          humanTaskId: 'q-1',
          status: 'answered',
          answer: { freeText: 'go' },
          createdAt: '2026-06-16T00:00:00Z',
        },
        stage: { cli: 'kiro', cliSessionId: 'kiro-7' },
      }),
    });
    const res = await runStage({ ...baseArgs, requestedCli: 'kiro', resumeFrom: 'q-1' }, deps);
    expect(res).toMatchObject({ ok: false, reason: 'resume_store_expired' });
    // Must fail BEFORE spawning a blank conversation.
    expect(spawned).toBe(false);
    expect(
      deps.store.calls.some((c) => c[0] === 'updateStageState' && c[1].state === 'FAILED'),
    ).toBe(true);
  });

  it('resumes normally when no store mount is configured (local/test run)', async () => {
    // resolveKiroStore() is null without the store env — a local run keeps its
    // best-effort resume behavior (no wiped-mount recovery kicks in).
    const deps = baseDeps({
      availableClis: ['kiro'],
      env: { BEDROCK_MODEL: 'us.anthropic.claude-sonnet-4-6' },
      spawnFn: okSpawn,
      restoreKiroStore: async () => false,
      store: spyStore({
        humanTask: { humanTaskId: 'q-1', status: 'answered', answer: { freeText: 'go' } },
        stage: { cli: 'kiro', cliSessionId: 'kiro-7' },
      }),
    });
    const res = await runStage({ ...baseArgs, requestedCli: 'kiro', resumeFrom: 'q-1' }, deps);
    expect(res.ok).toBe(true);
    // Not demoted → resumes the SAME conversation, no recovery note.
    expect(
      deps.store.calls.some((c) => c[0] === 'appendEvent' && c[1].type === 'v2.stage.recovered'),
    ).toBe(false);
  });

  it('does NOT fail a FRESH kiro run when the store is absent (mount configured)', async () => {
    // A fresh run legitimately has no store to restore — start-fresh is correct.
    const deps = baseDeps({
      availableClis: ['kiro'],
      env: kiroStoreEnv,
      spawnFn: (command, args) =>
        args.includes('--list-sessions')
          ? {
              on: (ev, cb) => ev === 'close' && setImmediate(() => cb(0)),
              stdout: { on: (ev, cb) => ev === 'data' && cb(Buffer.from('[]')) },
              stdin: { end() {} },
            }
          : okSpawn(),
      restoreKiroStore: async () => false,
    });
    const res = await runStage({ ...baseArgs, requestedCli: 'kiro' }, deps);
    expect(res.reason).not.toBe('resume_store_lost');
    expect(res.ok).toBe(true);
  });
});

describe('runStage — Kiro credit capture (per-turn footer → credits metric)', () => {
  beforeEach(() => resetKiroCreditRateCache());

  // A spawn dispatcher covering the three Kiro child processes of a fresh run:
  // the run itself (emits the credits footer on stderr — runChild tees it into
  // stderrTail), the post-run --list-sessions capture, and the /usage rate
  // capture (its report is on stderr too).
  const kiroSpawn =
    ({ footer = ' ▸ Credits: 0.42 • Time: 2s\n', usage = 'billed at $0.04 per credit\n' } = {}) =>
    (command, args) => {
      if (args.includes('--list-sessions')) {
        return {
          on: (ev, cb) => ev === 'close' && setImmediate(() => cb(0)),
          stdout: { on: (ev, cb) => ev === 'data' && cb(Buffer.from('[]')) },
          stdin: { end() {} },
        };
      }
      if (args.includes('/usage')) {
        return {
          on: (ev, cb) => ev === 'close' && setImmediate(() => cb(0)),
          stdout: { on: () => {} },
          stderr: { on: (ev, cb) => ev === 'data' && cb(Buffer.from(usage)) },
          stdin: { end() {} },
        };
      }
      return {
        on: (ev, cb) => ev === 'close' && setImmediate(() => cb(0)),
        stderr: { on: (ev, cb) => ev === 'data' && footer && cb(Buffer.from(footer)) },
        stdin: { end() {} },
      };
    };

  it('records a credits metric stamped with the model and the $/credit rate', async () => {
    const sent = [];
    const deps = baseDeps({
      availableClis: ['kiro'],
      env: { BEDROCK_MODEL: 'us.anthropic.claude-sonnet-4-6' },
      spawnFn: kiroSpawn(),
      broadcast: async (p) => sent.push(p),
    });
    const res = await runStage({ ...baseArgs, cliModels: { kiro: 'claude-opus-4.6' } }, deps);
    expect(res).toMatchObject({ ok: true, cli: 'kiro' });
    // Several metric samples land per run (prompt bytes, credits); pick the
    // credits one explicitly.
    const metric = deps.store.calls.find(
      (c) => c[0] === 'recordMetric' && c[1].metrics?.credits !== undefined,
    );
    expect(metric).toBeTruthy();
    expect(metric[1]).toMatchObject({
      executionId: 'e1',
      metrics: { credits: 0.42 },
      resolvedModel: 'claude-opus-4.6',
      creditRate: 0.04,
    });
    // Live-parity broadcast so the UI refreshes usage without a full refetch.
    expect(sent.some((p) => p.action === 'agent.metric' && p.metrics?.credits === 0.42)).toBe(true);
  });

  it('records credits unpriced (rate null) when /usage yields no rate', async () => {
    const deps = baseDeps({
      availableClis: ['kiro'],
      env: { BEDROCK_MODEL: 'us.anthropic.claude-sonnet-4-6' },
      spawnFn: kiroSpawn({ usage: 'Credits (0.00 of 50 covered in plan)\n' }),
    });
    const res = await runStage({ ...baseArgs, cliModels: { kiro: 'claude-opus-4.6' } }, deps);
    expect(res.ok).toBe(true);
    const metric = deps.store.calls.find(
      (c) => c[0] === 'recordMetric' && c[1].metrics?.credits !== undefined,
    );
    expect(metric[1]).toMatchObject({ metrics: { credits: 0.42 }, creditRate: null });
  });

  it('records no credits metric when the footer is absent (prompt-size sample still lands)', async () => {
    const deps = baseDeps({
      availableClis: ['kiro'],
      env: { BEDROCK_MODEL: 'us.anthropic.claude-sonnet-4-6' },
      spawnFn: kiroSpawn({ footer: '' }),
    });
    const res = await runStage({ ...baseArgs, cliModels: { kiro: 'claude-opus-4.6' } }, deps);
    expect(res.ok).toBe(true);
    expect(
      deps.store.calls.some((c) => c[0] === 'recordMetric' && c[1].metrics?.credits !== undefined),
    ).toBe(false);
    // The write-side context ledger records prompt size on every fresh run.
    const promptMetric = deps.store.calls.find(
      (c) => c[0] === 'recordMetric' && c[1].metrics?.promptBytes !== undefined,
    );
    expect(promptMetric[1].metrics.promptBytes).toBeGreaterThan(0);
    expect(promptMetric[1].metrics.compiledContextBytes).toBeGreaterThanOrEqual(0);
  });

  it('caches the /usage rate for the container life (one capture, many stages)', async () => {
    let usageSpawns = 0;
    const spawn = kiroSpawn();
    const counting = (command, args) => {
      if (args.includes('/usage')) usageSpawns += 1;
      return spawn(command, args);
    };
    const mkDeps = () =>
      baseDeps({
        availableClis: ['kiro'],
        env: { BEDROCK_MODEL: 'us.anthropic.claude-sonnet-4-6' },
        spawnFn: counting,
      });
    await runStage({ ...baseArgs, cliModels: { kiro: 'claude-opus-4.6' } }, mkDeps());
    await runStage({ ...baseArgs, cliModels: { kiro: 'claude-opus-4.6' } }, mkDeps());
    expect(usageSpawns).toBe(1);
  });
});

describe('runStage — source self-heal (wiped /mnt/workspace)', () => {
  const okSpawn = () => ({
    on: (ev, cb) => ev === 'close' && setImmediate(() => cb(0)),
    stdin: { end() {} },
  });

  it('re-clones a wiped checkout, emits v2.workspace.restored, then runs', async () => {
    let spawned = false;
    const deps = baseDeps({
      spawnFn: () => ((spawned = true), okSpawn()),
      ensureWorkspaceSource: async ({ repos }) => ({ restored: true, repos, failed: [] }),
    });
    const res = await runStage({ ...baseArgs, repos: ['acme/api'] }, deps);
    expect(res).toMatchObject({ ok: true, state: 'SUCCEEDED' });
    expect(spawned).toBe(true);
    expect(
      deps.store.calls.some((c) => c[0] === 'appendEvent' && c[1].type === 'v2.workspace.restored'),
    ).toBe(true);
  });

  it('fails workspace_restore_failed and does NOT spawn when a repo cannot be re-cloned', async () => {
    let spawned = false;
    const deps = baseDeps({
      spawnFn: () => ((spawned = true), okSpawn()),
      ensureWorkspaceSource: async () => ({ restored: true, repos: [], failed: ['acme/api'] }),
    });
    const res = await runStage({ ...baseArgs, repos: ['acme/api'] }, deps);
    expect(res).toMatchObject({ ok: false, reason: 'workspace_restore_failed' });
    expect(spawned).toBe(false);
  });

  it('does not emit a restored event for a repo-less project (no-op heal)', async () => {
    const deps = baseDeps({
      spawnFn: okSpawn,
      ensureWorkspaceSource: async () => ({ restored: false, repos: [], failed: [] }),
    });
    const res = await runStage({ ...baseArgs, repos: [] }, deps);
    expect(res.ok).toBe(true);
    expect(
      deps.store.calls.some((c) => c[0] === 'appendEvent' && c[1].type === 'v2.workspace.restored'),
    ).toBe(false);
  });

  it('demotes a Claude resume to a fresh run when the wiped mount lost the conversation', async () => {
    // Source re-cloned on a resume ⇒ the co-located Claude JSONL store is gone too.
    // Recent gate ⇒ re-run fresh with the answer injected (not resume_store_expired).
    let promptSeen = null;
    const deps = baseDeps({
      availableClis: ['claude'],
      ensureWorkspaceSource: async ({ repos }) => ({ restored: true, repos, failed: [] }),
      spawnFn: (command, args) => {
        promptSeen = args.join(' ');
        return okSpawn();
      },
      ids: () => 'fresh-uuid',
      store: spyStore({
        humanTask: { humanTaskId: 'q-1', status: 'answered', answer: { freeText: 'blue' } },
        stage: { cli: 'claude', cliSessionId: 'old-uuid' },
      }),
    });
    const res = await runStage({ ...baseArgs, repos: ['acme/api'], resumeFrom: 'q-1' }, deps);
    expect(res).toMatchObject({ ok: true, state: 'SUCCEEDED', cli: 'claude' });
    // Fresh invocation (new --session-id), not a --resume of the lost conversation.
    expect(promptSeen).toContain('--session-id fresh-uuid');
    expect(promptSeen).not.toContain('--resume');
    expect(
      deps.store.calls.some((c) => c[0] === 'appendEvent' && c[1].type === 'v2.stage.recovered'),
    ).toBe(true);
  });
});

// ── Steering injection (docs/v2-steering.md) ──

describe('renderSteering — the course-correction block', () => {
  const { renderSteering } = __test;

  it('renders nothing for no rows', () => {
    expect(renderSteering([])).toBe('');
    expect(renderSteering()).toBe('');
  });

  it('renders an imperative override block with per-kind labels + attribution', () => {
    const block = renderSteering([
      { kind: 'gate-steer', message: 'use the event bus', createdByName: 'Ada' },
      { kind: 'revision', message: 'answer was wrong', createdByName: null },
      { kind: 'rewind', message: 'redo event-driven', targetStageId: 'design' },
    ]);
    expect(block).toContain('COURSE CORRECTION from the human team');
    expect(block).toContain('OVERRIDES your current plan');
    expect(block).toContain('use the event bus');
    expect(block).toContain('from Ada');
    expect(block).toContain('a previously given answer was CORRECTED');
    expect(block).toContain('rewind guidance — this stage is re-running from scratch');
    // The agent is told to fix conflicting prior work by editing FILES — git
    // is engine-owned (WP2), so the steering block must not ask for git ops.
    expect(block).toContain('do NOT run git');
    expect(block).not.toContain('revert/redo the commits');
  });
});

describe('consumePendingSteering — CAS delivery at the injection point', () => {
  const { consumePendingSteering } = __test;

  it('consumes pending rows in order, records the event + broadcast', async () => {
    const events = [];
    const published = [];
    const consumed = [];
    const store = {
      listPendingSteering: async () => [
        { steerId: 'st-1', createdAt: 'T1', message: 'a' },
        { steerId: 'st-2', createdAt: 'T2', message: 'b' },
      ],
      markSteeringConsumed: async (args) => {
        consumed.push(args);
        return { status: 'consumed' };
      },
      appendEvent: async (e) => events.push(e),
    };
    const rows = await consumePendingSteering({
      store,
      executionId: 'e1',
      stageInstanceId: 'si-1',
      publish: async (p) => published.push(p),
    });
    expect(rows.map((r) => r.steerId)).toEqual(['st-1', 'st-2']);
    expect(consumed[0]).toMatchObject({
      steerId: 'st-1',
      createdAt: 'T1',
      stageInstanceId: 'si-1',
    });
    expect(events[0].type).toBe('v2.steering.consumed');
    expect(published[0]).toMatchObject({ action: 'agent.steering', steerIds: ['st-1', 'st-2'] });
  });

  it('skips a row another entry consumed concurrently (CAS lost)', async () => {
    const store = {
      listPendingSteering: async () => [
        { steerId: 'st-1', createdAt: 'T1' },
        { steerId: 'st-2', createdAt: 'T2' },
      ],
      markSteeringConsumed: async ({ steerId }) =>
        steerId === 'st-2' ? { status: 'consumed' } : null,
      appendEvent: async () => ({}),
    };
    const rows = await consumePendingSteering({
      store,
      executionId: 'e1',
      stageInstanceId: 'si-1',
      publish: async () => {},
    });
    expect(rows.map((r) => r.steerId)).toEqual(['st-2']);
  });

  it('tolerates a store without steering support (returns [])', async () => {
    const rows = await consumePendingSteering({
      store: {},
      executionId: 'e1',
      stageInstanceId: 'si-1',
      publish: async () => {},
    });
    expect(rows).toEqual([]);
  });
});

describe('runStage — steering reaches the agent conversation', () => {
  const okSpawn = () => ({
    on: (ev, cb) => ev === 'close' && setImmediate(() => cb(0)),
    stdin: { end() {} },
  });

  // spyStore + the steering surface: pending rows are handed out once, then
  // consumed (mirrors the CAS).
  const steeringStore = (seed = {}, pending = []) => {
    const store = spyStore(seed);
    let rows = [...pending];
    store.listPendingSteering = async () => {
      store.calls.push(['listPendingSteering']);
      return rows;
    };
    store.markSteeringConsumed = async (args) => {
      store.calls.push(['markSteeringConsumed', args]);
      rows = rows.filter((r) => r.steerId !== args.steerId);
      return { status: 'consumed' };
    };
    return store;
  };

  it('prepends the correction block to a FRESH stage prompt and marks it consumed', async () => {
    let argv = null;
    const store = steeringStore({}, [
      {
        steerId: 'st-1',
        createdAt: 'T1',
        kind: 'rewind',
        message: 'redo event-driven',
        targetStageId: 'requirements-analysis',
        createdByName: 'Ada',
      },
    ]);
    const deps = baseDeps({
      store,
      spawnFn: (command, args) => {
        argv = args;
        return okSpawn();
      },
    });
    const res = await runStage(baseArgs, deps);
    expect(res).toMatchObject({ ok: true, state: 'SUCCEEDED' });
    const prompt = argv[argv.indexOf('-p') + 1];
    // The correction LEADS the prompt, ahead of the materialized stage body.
    expect(prompt.indexOf('COURSE CORRECTION')).toBeGreaterThanOrEqual(0);
    expect(prompt.indexOf('COURSE CORRECTION')).toBeLessThan(
      prompt.indexOf('PROMPT requirements-analysis'),
    );
    expect(prompt).toContain('redo event-driven');
    // Consumed exactly once, attributed to this stage instance.
    const consumed = store.calls.filter((c) => c[0] === 'markSteeringConsumed');
    expect(consumed).toHaveLength(1);
    expect(consumed[0][1]).toMatchObject({ steerId: 'st-1' });
    expect(
      store.calls.some((c) => c[0] === 'appendEvent' && c[1].type === 'v2.steering.consumed'),
    ).toBe(true);
  });

  it('appends the correction to the RESUME answer message', async () => {
    let argv = null;
    const store = steeringStore(
      {
        humanTask: {
          humanTaskId: 'q-1',
          status: 'answered',
          answer: { perQuestion: [{ text: 'Scope?', answer: 'MVP' }] },
        },
        stage: { cli: 'claude', cliSessionId: 'sess-7' },
      },
      [
        {
          steerId: 'st-9',
          createdAt: 'T1',
          kind: 'gate-steer',
          message: 'also drop the REST layer',
          createdByName: 'Ada',
        },
      ],
    );
    const deps = baseDeps({
      store,
      spawnFn: (command, args) => {
        argv = args;
        return okSpawn();
      },
    });
    const res = await runStage({ ...baseArgs, resumeFrom: 'q-1' }, deps);
    expect(res).toMatchObject({ ok: true, state: 'SUCCEEDED' });
    const message = argv[argv.indexOf('-p') + 1];
    // Answer first, then the override block.
    expect(message).toMatch(/MVP/);
    expect(message).toContain('COURSE CORRECTION');
    expect(message).toContain('also drop the REST layer');
    expect(message.indexOf('MVP')).toBeLessThan(message.indexOf('COURSE CORRECTION'));
  });

  it('a run with no pending steering injects nothing', async () => {
    let argv = null;
    const store = steeringStore({}, []);
    const deps = baseDeps({
      store,
      spawnFn: (command, args) => {
        argv = args;
        return okSpawn();
      },
    });
    await runStage(baseArgs, deps);
    const prompt = argv[argv.indexOf('-p') + 1];
    expect(prompt).not.toContain('COURSE CORRECTION');
    expect(store.calls.filter((c) => c[0] === 'markSteeringConsumed')).toHaveLength(0);
  });
});

// ── WP2: engine-owned git — commit + push on every stage exit ──

describe('runStage — engine git hook (docs/v2-parallel.md WP2)', () => {
  const okSpawn = () => ({
    on: (ev, cb) => ev === 'close' && setImmediate(() => cb(0)),
    stdin: { end() {} },
  });
  const gitArgs = {
    ...baseArgs,
    repos: ['owner/repo'],
    branch: 'ai-dlc/i1',
    baseBranch: 'main',
    gitToken: 'tok',
    gitProvider: 'github',
  };
  // With repos present the real source self-heal would try to git-clone the
  // fake repo; stub it as "checkout present".
  const sourcePresent = {
    ensureWorkspaceSource: async () => ({ restored: false, repos: [], failed: [] }),
  };

  // ── node_modules off-mount redirect (2026-07 ENOSPC incident #2) ──────────

  it('redirects node_modules off the mount BEFORE the CLI spawns (repos present)', async () => {
    const order = [];
    const deps = baseDeps({
      ...sourcePresent,
      spawnFn: () => {
        order.push('spawn');
        return okSpawn();
      },
      redirectHeavyDirs: async ({ workspaceDir }) => {
        order.push(`redirect:${workspaceDir}`);
        return { links: [{ dir: workspaceDir, action: 'created' }] };
      },
    });
    const res = await runStage(gitArgs, deps);
    expect(res).toMatchObject({ ok: true, state: 'SUCCEEDED' });
    expect(order).toEqual(['redirect:/ws', 'spawn']);
  });

  it('skips the redirect for a repo-less project (nothing to install into)', async () => {
    const redirect = [];
    const deps = baseDeps({
      spawnFn: okSpawn,
      redirectHeavyDirs: async (args) => {
        redirect.push(args);
        return { links: [] };
      },
    });
    const res = await runStage(baseArgs, deps); // baseArgs has no repos
    expect(res).toMatchObject({ ok: true, state: 'SUCCEEDED' });
    expect(redirect).toHaveLength(0);
  });

  it('a redirect failure records v2.workspace.redirect_failed but never blocks the stage', async () => {
    const deps = baseDeps({
      ...sourcePresent,
      spawnFn: okSpawn,
      redirectHeavyDirs: async () => ({
        links: [
          { dir: '/ws', action: 'kept' },
          { dir: '/ws/frontend', action: 'failed', detail: 'EACCES boom' },
        ],
      }),
    });
    const res = await runStage(gitArgs, deps);
    expect(res).toMatchObject({ ok: true, state: 'SUCCEEDED' });
    const ev = deps.store.calls.find(
      (c) => c[0] === 'appendEvent' && c[1].type === 'v2.workspace.redirect_failed',
    );
    expect(ev).toBeTruthy();
    expect(ev[1].summary).toContain('EACCES boom');
    expect(ev[1].summary).toContain('1 GiB mount');
  });

  it('invokes the hook once after the CLI exits, with the clone inputs and a deterministic message', async () => {
    const calls = [];
    const deps = baseDeps({
      ...sourcePresent,
      spawnFn: okSpawn,
      commitAndPushAll: async (input) => {
        calls.push(input);
        return { ok: true, committed: false, results: [] };
      },
    });
    const res = await runStage(gitArgs, deps);
    expect(res).toMatchObject({ ok: true, state: 'SUCCEEDED' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      repos: ['owner/repo'],
      workspaceDir: '/ws',
      branch: 'ai-dlc/i1',
      gitToken: 'tok',
      gitProvider: 'github',
      message: 'aidlc(requirements-analysis): e1',
    });
  });

  it('records a v2.git.pushed event when the engine committed work', async () => {
    const deps = baseDeps({
      ...sourcePresent,
      spawnFn: okSpawn,
      commitAndPushAll: async () => ({
        ok: true,
        committed: true,
        results: [{ repo: 'owner/repo', committed: true, sha: 'abc1234567890', pushed: true }],
      }),
    });
    const res = await runStage(gitArgs, deps);
    expect(res).toMatchObject({ ok: true, state: 'SUCCEEDED' });
    const ev = deps.store.calls.find(
      (c) => c[0] === 'appendEvent' && c[1].type === 'v2.git.pushed',
    );
    expect(ev).toBeTruthy();
    expect(ev[1].summary).toContain('owner/repo@abc12345');
  });

  it('no event when nothing was committed and pushes were clean (quiet feed)', async () => {
    const deps = baseDeps({
      ...sourcePresent,
      spawnFn: okSpawn,
      commitAndPushAll: async () => ({
        ok: true,
        committed: false,
        results: [{ repo: 'owner/repo', committed: false, reason: 'clean', pushed: 'up_to_date' }],
      }),
    });
    await runStage(gitArgs, deps);
    const gitEvents = deps.store.calls.filter(
      (c) => c[0] === 'appendEvent' && String(c[1].type).startsWith('v2.git.'),
    );
    expect(gitEvents).toHaveLength(0);
  });

  it('FAILS the stage (push_failed) when THIS run committed work that did not reach the remote', async () => {
    const deps = baseDeps({
      ...sourcePresent,
      spawnFn: okSpawn,
      commitAndPushAll: async () => ({
        ok: false,
        committed: true,
        results: [
          {
            repo: 'owner/repo',
            committed: true,
            sha: 'abc',
            pushed: false,
            reason: 'push_failed',
            detail: 'remote rejected',
          },
        ],
      }),
    });
    const res = await runStage(gitArgs, deps);
    expect(res).toMatchObject({ ok: false, reason: 'push_failed' });
    expect(res.detail).toContain('owner/repo');
    expect(res.detail).toContain('remote rejected');
    // Both the failure event and the push_failed git event are recorded.
    const evTypes = deps.store.calls.filter((c) => c[0] === 'appendEvent').map((c) => c[1].type);
    expect(evTypes).toContain('v2.git.push_failed');
    expect(evTypes).toContain('v2.stage.failed');
    // Stage row FAILED.
    const states = deps.store.calls
      .filter((c) => c[0] === 'updateStageState')
      .map((c) => c[1].state);
    expect(states).toContain('FAILED');
    expect(states).not.toContain('SUCCEEDED');
  });

  it('does NOT fail the stage on a push failure without new commits (records the event only)', async () => {
    const deps = baseDeps({
      ...sourcePresent,
      spawnFn: okSpawn,
      commitAndPushAll: async () => ({
        ok: false,
        committed: false,
        results: [
          {
            repo: 'owner/repo',
            committed: false,
            reason: 'clean',
            pushed: false,
            detail: 'no auth',
          },
        ],
      }),
    });
    const res = await runStage(gitArgs, deps);
    expect(res).toMatchObject({ ok: true, state: 'SUCCEEDED' });
    const evTypes = deps.store.calls.filter((c) => c[0] === 'appendEvent').map((c) => c[1].type);
    expect(evTypes).toContain('v2.git.push_failed');
  });

  // ── durability hardening (the 2026-07 "no changes" incident: commit_failed
  // with a dirty tree sailed through and the run succeeded with zero durable
  // work) ────────────────────────────────────────────────────────────────────

  it('FAILS the stage (git_commit_failed) when the tree is dirty and the engine could not commit', async () => {
    const deps = baseDeps({
      ...sourcePresent,
      spawnFn: okSpawn,
      commitAndPushAll: async () => ({
        ok: false,
        committed: false,
        results: [
          {
            repo: 'owner/repo',
            committed: false,
            reason: 'commit_failed',
            detail: 'fatal: unable to write loose object: No space left on device',
            dirty: true,
            pushed: false,
          },
        ],
      }),
    });
    const res = await runStage(gitArgs, deps);
    expect(res).toMatchObject({ ok: false, reason: 'git_commit_failed' });
    expect(res.detail).toContain('No space left on device');
    const evTypes = deps.store.calls.filter((c) => c[0] === 'appendEvent').map((c) => c[1].type);
    expect(evTypes).toContain('v2.git.push_failed');
    expect(evTypes).toContain('v2.stage.failed');
    // The git stderr rides in the event summary — the ENOSPC root cause was
    // invisible in the incident because only the reason label was recorded.
    const gitEv = deps.store.calls.find(
      (c) => c[0] === 'appendEvent' && c[1].type === 'v2.git.push_failed',
    );
    expect(gitEv[1].summary).toContain('No space left on device');
    const states = deps.store.calls
      .filter((c) => c[0] === 'updateStageState')
      .map((c) => c[1].state);
    expect(states).toContain('FAILED');
    expect(states).not.toContain('SUCCEEDED');
  });

  it('FAILS the stage when the git engine crashed (unknown durability must be loud)', async () => {
    const deps = baseDeps({
      ...sourcePresent,
      spawnFn: okSpawn,
      commitAndPushAll: async () => ({
        ok: false,
        committed: false,
        results: [
          {
            repo: 'owner/repo',
            committed: false,
            pushed: false,
            reason: 'engine_crashed',
            detail: 'boom',
          },
        ],
      }),
    });
    const res = await runStage(gitArgs, deps);
    expect(res).toMatchObject({ ok: false, reason: 'git_commit_failed' });
    expect(res.detail).toContain('engine_crashed');
  });

  it('a commit failure with a CLEAN tree does not fail the stage (no work at risk)', async () => {
    const deps = baseDeps({
      ...sourcePresent,
      spawnFn: okSpawn,
      commitAndPushAll: async () => ({
        ok: false,
        committed: false,
        results: [
          {
            repo: 'owner/repo',
            committed: false,
            reason: 'commit_failed',
            detail: 'transient index lock',
            dirty: false,
            pushed: false,
          },
        ],
      }),
    });
    const res = await runStage(gitArgs, deps);
    expect(res).toMatchObject({ ok: true, state: 'SUCCEEDED' });
    // Still visible for ops.
    const evTypes = deps.store.calls.filter((c) => c[0] === 'appendEvent').map((c) => c[1].type);
    expect(evTypes).toContain('v2.git.push_failed');
  });

  it('broadcasts a live agent.note on push failure (the user sees git trouble mid-run)', async () => {
    const broadcasts = [];
    const deps = baseDeps({
      ...sourcePresent,
      spawnFn: okSpawn,
      broadcast: async (payload) => {
        broadcasts.push(payload);
      },
      commitAndPushAll: async () => ({
        ok: false,
        committed: false,
        results: [
          {
            repo: 'owner/repo',
            committed: false,
            reason: 'commit_failed',
            detail: 'No space left on device',
            dirty: true,
            pushed: false,
          },
        ],
      }),
    });
    await runStage(gitArgs, deps);
    const note = broadcasts.find((b) => b.noteType === 'v2.git.push_failed');
    expect(note).toBeTruthy();
    expect(note.action).toBe('agent.note');
    expect(note.summary).toContain('No space left on device');
  });

  it('a parked stage still parks when the push failed — the human loop is never blocked', async () => {
    const deps = baseDeps({
      ...sourcePresent,
      spawnFn: okSpawn,
      ids: () => 'sid-1',
      store: spyStore({
        execution: { pendingHumanTaskId: 'q-1' },
        humanTask: { humanTaskId: 'q-1', status: 'pending' },
      }),
      commitAndPushAll: async () => ({
        ok: false,
        committed: true,
        results: [
          { repo: 'owner/repo', committed: true, sha: 'abc', pushed: false, reason: 'push_failed' },
        ],
      }),
    });
    const res = await runStage(gitArgs, deps);
    expect(res).toMatchObject({ ok: true, state: 'WAITING_FOR_HUMAN', humanTaskId: 'q-1' });
    // The failed push is still visible in the feed for ops.
    const evTypes = deps.store.calls.filter((c) => c[0] === 'appendEvent').map((c) => c[1].type);
    expect(evTypes).toContain('v2.git.push_failed');
  });

  it('the hook runs (and pushes) even when the CLI exits non-zero — failed work is preserved', async () => {
    const crash = () => ({
      on: (ev, cb) => ev === 'close' && setImmediate(() => cb(1)),
      stdin: { end() {} },
    });
    const calls = [];
    const deps = baseDeps({
      ...sourcePresent,
      spawnFn: crash,
      commitAndPushAll: async (input) => {
        calls.push(input);
        return {
          ok: true,
          committed: true,
          results: [{ repo: 'owner/repo', committed: true, sha: 'abc', pushed: true }],
        };
      },
    });
    const res = await runStage(gitArgs, deps);
    expect(res).toMatchObject({ ok: false, reason: 'cli_nonzero_exit' });
    expect(calls).toHaveLength(1); // work committed+pushed BEFORE the failure verdict
  });
});

describe('runStage — unit lanes (docs/v2-parallel.md WP4)', () => {
  const okSpawn = () => ({
    on: (ev, cb) => ev === 'close' && setImmediate(() => cb(0)),
    stdin: { end() {} },
  });
  const UNIT_PLAN = {
    units: [
      { slug: 'auth', dependsOn: [] },
      { slug: 'billing', dependsOn: ['auth'] },
    ],
  };
  const unitDeps = (overrides = {}) =>
    baseDeps({
      store: spyStore({ unitPlan: UNIT_PLAN }),
      loadLibrary: async () => ({ workflow: unitWorkflow(), library: unitLibrary() }),
      spawnFn: okSpawn,
      ...overrides,
    });
  const unitArgs = { ...baseArgs, stageId: 'code-generation', unitSlug: 'billing' };

  it('runs a per-unit stage under its unit-dimension instance id and stamps unitSlug on every write', async () => {
    const deps = unitDeps();
    const sent = [];
    deps.broadcast = async (p) => sent.push(p);
    const res = await runStage(unitArgs, deps);
    const expectedId = planStageInstanceId('aidlc-v2@1', 'code-generation', 'billing');
    expect(res).toMatchObject({
      ok: true,
      state: 'SUCCEEDED',
      stageInstanceId: expectedId,
      unitSlug: 'billing',
    });
    // The unit instance id differs from the unitless one.
    expect(expectedId).not.toBe(planStageInstanceId('aidlc-v2@1', 'code-generation'));
    // STAGE row carries the lane.
    const put = deps.store.calls.find((c) => c[0] === 'putStage')[1];
    expect(put).toMatchObject({
      stageInstanceId: expectedId,
      stageId: 'code-generation',
      unitSlug: 'billing',
    });
    // Every EVENT row carries the lane.
    const events = deps.store.calls.filter((c) => c[0] === 'appendEvent').map((c) => c[1]);
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) expect(e.unitSlug).toBe('billing');
    // agent.stage broadcasts carry the lane.
    const stageBroadcasts = sent.filter((p) => p.action === 'agent.stage');
    expect(stageBroadcasts.length).toBeGreaterThan(0);
    for (const b of stageBroadcasts) expect(b.unitSlug).toBe('billing');
  });

  it('threads the unit (slug + dependsOn from the UNITPLAN) and unitSlug scope into the materializer', async () => {
    let seen = null;
    const deps = unitDeps({
      materializeStage: async ({ stage, unit, scope }) => {
        seen = { unit, scope, stageId: stage.stageId };
        return { prompt: 'P', mcpConfigPath: '/ws/.aidlc/mcp.json' };
      },
    });
    await runStage(unitArgs, deps);
    expect(seen.unit).toEqual({ slug: 'billing', dependsOn: ['auth'] });
    expect(seen.scope).toMatchObject({ unitSlug: 'billing' });
  });

  it('carries the unit dimension in the engine commit message', async () => {
    const messages = [];
    const deps = unitDeps({
      ensureWorkspaceSource: async () => ({ restored: false, repos: [], failed: [] }),
      commitAndPushAll: async ({ message }) => {
        messages.push(message);
        return { ok: true, committed: false, results: [] };
      },
    });
    await runStage(
      { ...unitArgs, repos: [{ cloneUrl: 'https://x/r.git' }], branch: 'aidlc/i1' },
      deps,
    );
    expect(messages).toEqual(['aidlc(code-generation): billing — e1']);
  });

  it('fails unit_required when a forEach stage is dispatched without a unit', async () => {
    const deps = unitDeps();
    const res = await runStage({ ...unitArgs, unitSlug: null }, deps);
    expect(res).toMatchObject({ ok: false, reason: 'unit_required' });
  });

  it('fails unit_not_applicable when a once-per-workflow stage gets a unit', async () => {
    const deps = unitDeps();
    const res = await runStage(
      { ...unitArgs, stageId: 'units-generation', unitSlug: 'auth' },
      deps,
    );
    expect(res).toMatchObject({ ok: false, reason: 'unit_not_applicable' });
  });

  it('fails unit_not_found when the slug is not in the promoted UNITPLAN', async () => {
    const deps = unitDeps({ store: spyStore({ unitPlan: UNIT_PLAN }) });
    const res = await runStage({ ...unitArgs, unitSlug: 'ghost' }, deps);
    expect(res).toMatchObject({ ok: false, reason: 'unit_not_found' });
    // The failure is attributed to the per-unit instance id.
    const failedState = deps.store.calls.find((c) => c[0] === 'updateStageState')[1];
    expect(failedState).toMatchObject({
      stageInstanceId: planStageInstanceId('aidlc-v2@1', 'code-generation', 'ghost'),
      state: 'FAILED',
    });
  });

  it('fails unit_not_found when no UNITPLAN was promoted at all', async () => {
    const deps = unitDeps({ store: spyStore({}) });
    const res = await runStage(unitArgs, deps);
    expect(res).toMatchObject({ ok: false, reason: 'unit_not_found' });
  });

  it('a non-forEach stage without a unit still runs with the plain instance id and null unitSlug', async () => {
    const deps = unitDeps();
    const res = await runStage({ ...baseArgs, stageId: 'units-generation' }, deps);
    expect(res).toMatchObject({
      ok: true,
      state: 'SUCCEEDED',
      stageInstanceId: planStageInstanceId('aidlc-v2@1', 'units-generation'),
      unitSlug: null,
    });
    const put = deps.store.calls.find((c) => c[0] === 'putStage')[1];
    expect(put.unitSlug).toBeNull();
  });

  // "Required when in scope" (lean scopes): the DAG producer exists in the
  // workflow but is SKIP for the selected scope, so the plan resolver degrades
  // the forEach stage to once-per-workflow (forEachDegraded). Dispatching it
  // without a unit must run, not fail unit_required.
  const leanWorkflow = () => ({
    id: 'aidlc-v2',
    version: 1,
    placements: [
      { stageId: 'units-generation', order: 0, scopeMembership: { feature: 'EXECUTE' } },
      {
        stageId: 'code-generation',
        order: 1,
        scopeMembership: { feature: 'EXECUTE', bugfix: 'EXECUTE' },
      },
    ],
    ruleRefs: [],
    scopeRefs: [{ scopeId: 'feature' }, { scopeId: 'bugfix' }],
  });
  const leanDeps = (overrides = {}) =>
    baseDeps({
      store: spyStore({}),
      loadLibrary: async () => ({ workflow: leanWorkflow(), library: unitLibrary() }),
      spawnFn: okSpawn,
      ...overrides,
    });

  it('runs a DEGRADED forEach stage once per workflow without a unit (lean scope)', async () => {
    const deps = leanDeps();
    const res = await runStage({ ...baseArgs, stageId: 'code-generation', scope: 'bugfix' }, deps);
    expect(res).toMatchObject({
      ok: true,
      state: 'SUCCEEDED',
      stageInstanceId: planStageInstanceId('aidlc-v2@1', 'code-generation'),
      unitSlug: null,
    });
  });

  it('rejects a unit dispatch onto a DEGRADED forEach stage (unit_not_applicable)', async () => {
    const deps = leanDeps();
    const res = await runStage(
      { ...baseArgs, stageId: 'code-generation', scope: 'bugfix', unitSlug: 'auth' },
      deps,
    );
    expect(res).toMatchObject({ ok: false, reason: 'unit_not_applicable' });
  });
});

// ── run-stage delivers the intent from META to the prompt ────────────────────

describe('runStage — intent delivery', () => {
  const okSpawn = () => ({
    on: (ev, cb) => ev === 'close' && setImmediate(() => cb(0)),
    stdin: { end() {} },
  });

  it('passes the META title/prompt + run scope into the materializer on a fresh run', async () => {
    let seen = null;
    const deps = baseDeps({
      spawnFn: okSpawn,
      store: spyStore({
        execution: {
          executionId: 'e1',
          title: 'Bookstore API',
          prompt: 'Build a REST API for a bookstore.',
        },
      }),
      materializeStage: async ({ intent }) => {
        seen = intent;
        return { prompt: 'P', mcpConfigPath: '/ws/.aidlc/mcp.json' };
      },
    });
    const res = await runStage(baseArgs, deps);
    expect(res.ok).toBe(true);
    expect(seen).toEqual({
      title: 'Bookstore API',
      prompt: 'Build a REST API for a bookstore.',
      scope: 'feature',
    });
  });

  it('an unreadable META degrades to scope-only (never blocks the stage)', async () => {
    let seen = 'unset';
    const store = spyStore();
    store.getExecution = async () => {
      throw new Error('ddb down');
    };
    const deps = baseDeps({
      spawnFn: okSpawn,
      store,
      materializeStage: async ({ intent }) => {
        seen = intent;
        return { prompt: 'P', mcpConfigPath: '/ws/.aidlc/mcp.json' };
      },
    });
    const res = await runStage(baseArgs, deps);
    expect(res.ok).toBe(true);
    expect(seen).toEqual({ scope: 'feature' });
  });
});
