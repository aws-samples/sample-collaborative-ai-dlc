import { describe, it, expect, beforeEach } from 'vitest';
import { runStage } from '../commands/run-stage.js';
import { renderRulesDoc } from '../stage-materializer.js';

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

  it('lets a stage/agent modelOverride win over project cliModels', async () => {
    const cap = captureModel();
    const lib = library();
    lib.agentsById['aidlc-product-agent'].modelOverride = 'agent-pinned-model';
    await runStage(
      { ...baseArgs, cliModels: { claude: 'project-model' } },
      baseDeps({
        spawnFn: cap.spawnFn,
        loadLibrary: async () => ({ workflow: workflow(), library: lib }),
      }),
    );
    expect(cap.get()).toBe('agent-pinned-model');
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
