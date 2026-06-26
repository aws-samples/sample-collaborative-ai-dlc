import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import { runStage, __test } from '../commands/run-stage.js';
import { renderRulesDoc } from '../stage-materializer.js';

const require = createRequire(import.meta.url);
const { buildExecutionPlan } = require('../../shared/v2-execution-plan.js');

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

// A spy process store recording the calls run-stage makes.
const spyStore = () => {
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
    appendEvent: rec('appendEvent'),
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
  renderRulesDoc,
  mcpEntry: '/opt/agentcore/mcp/index.js',
  availableClis: ['claude'],
  env: { BEDROCK_MODEL: 'us.anthropic.claude-sonnet-4-6' },
  spawnFn: () => {
    throw new Error('spawn should be stubbed via runChild path');
  },
  clock: () => 'T',
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
