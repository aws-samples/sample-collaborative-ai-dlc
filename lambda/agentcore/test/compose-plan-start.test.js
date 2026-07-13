import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createComposePlanStart,
  buildScopeGrounding,
  scopeGridFor,
} from '../commands/compose-plan-start.js';

// A minimal three-stage workflow: init (initialization) → analyze → build.
const stage = (id, extra = {}) => ({
  id,
  blockId: id,
  version: 1,
  phase: extra.phase ?? 'construction',
  mode: 'inline',
  leadAgent: 'orchestrator',
  produces: extra.produces ?? [],
  consumes: extra.consumes ?? [],
  sensors: [],
  humanValidation: extra.humanValidation ?? 'none',
  execution: extra.execution ?? 'ALWAYS',
});

const workflow = () => ({
  workflowId: 'aidlc-v2',
  workflowVersion: 4,
  placements: [
    {
      stageId: 'init',
      order: 0,
      scopeMembership: { feature: 'EXECUTE', bugfix: 'EXECUTE' },
    },
    {
      stageId: 'analyze',
      order: 1,
      scopeMembership: { feature: 'EXECUTE', bugfix: 'SKIP' },
    },
    {
      stageId: 'build',
      order: 2,
      scopeMembership: { feature: 'EXECUTE', bugfix: 'EXECUTE' },
    },
  ],
  ruleRefs: [],
  scopeRefs: [{ scopeId: 'feature' }, { scopeId: 'bugfix' }],
  phases: [],
});

const library = () => ({
  stagesById: {
    init: stage('init', { phase: 'initialization' }),
    analyze: stage('analyze', { produces: ['spec'] }),
    build: stage('build', { consumes: [{ artifact: 'spec', required: true }] }),
  },
  agentsById: {
    'aidlc-composer-agent': {
      id: 'aidlc-composer-agent',
      bodyRef: { s3Key: 'persona' },
    },
  },
  sensorsById: {},
  rulesById: {},
  artifactsById: {},
  knowledgeById: {
    'composer-agent-composing': {
      id: 'composer-agent-composing',
      agentRef: 'aidlc-composer-agent',
      bodyRef: { s3Key: 'knowledge' },
    },
  },
});

const scopeBlocks = [
  { id: 'feature', keywords: ['feature'], description: 'Full flow' },
  { id: 'bugfix', keywords: ['hotfix'], description: 'Fix and ship' },
];

const makeStore = () => ({
  rows: [],
  updateCompose: vi.fn(async (args) => {
    return { composeId: args.composeId, state: args.state, ...args.fields };
  }),
  appendEvent: vi.fn(async () => {}),
  recordMetric: vi.fn(async () => {}),
  getExecution: vi.fn(async () => ({ agentCli: 'claude', cliModels: { claude: 'model-x' } })),
});

const basePayload = {
  projectId: 'p1',
  intentId: 'i1',
  composeId: 'c1',
  mode: 'front',
  workflowId: 'aidlc-v2',
  workflowVersion: 4,
  prompt: 'Build the thing',
};

const makeDeps = ({ oneShotText, oneShotOk = true, store = makeStore() } = {}) => ({
  openGraph: vi.fn(async () => null),
  store,
  broadcast: vi.fn(async () => {}),
  availableClis: ['claude'],
  oneShot: vi.fn(async () => ({
    ok: oneShotOk,
    text: oneShotText ?? '',
    cli: 'claude',
    model: 'model-x',
    metrics: { tokensInput: 10, tokensOutput: 5 },
    reason: oneShotOk ? null : 'cli_unavailable',
  })),
  loadLibraryFn: vi.fn(async () => ({ workflow: workflow(), library: library() })),
  loadBlockBodyFn: vi.fn(async (b) => (b?.bodyRef?.s3Key === 'persona' ? 'PERSONA' : 'KNOWLEDGE')),
  listMergedBlocksFn: vi.fn(async () => scopeBlocks),
  log: vi.fn(),
});

// The accept returns immediately; the background job is what we assert on —
// poll the store mock until the terminal update lands.
const waitForFinish = async (store) => {
  for (let i = 0; i < 100; i += 1) {
    if (store.updateCompose.mock.calls.length > 0) return store.updateCompose.mock.calls[0][0];
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('compose job never finished');
};

describe('scopeGridFor / buildScopeGrounding', () => {
  it('projects a scope grid off placements', () => {
    expect(scopeGridFor(workflow(), 'bugfix')).toEqual({
      init: 'EXECUTE',
      analyze: 'SKIP',
      build: 'EXECUTE',
    });
  });

  it('grounds every offered scope with an authoritative summary', () => {
    const { summaries, offeredScopeIds } = buildScopeGrounding({
      workflow: workflow(),
      library: library(),
      scopeBlocks,
    });
    expect(offeredScopeIds.toSorted()).toEqual(['bugfix', 'feature']);
    expect(summaries.feature.executedStages).toBe(3);
    // bugfix starves build's spec (lenient warning) but still summarizes.
    expect(summaries.bugfix.executedStages).toBe(2);
  });
});

describe('compose-plan-start', () => {
  beforeEach(() => vi.clearAllMocks());

  it('refuses missing identity and unknown modes', async () => {
    const deps = makeDeps();
    const start = createComposePlanStart(deps);
    expect((await start({})).reason).toBe('missing_compose_identity');
    expect((await start({ ...basePayload, mode: 'wild' })).reason).toBe('invalid_compose_mode');
  });

  it('completes a valid matched proposal with the resolver-authoritative validation', async () => {
    const deps = makeDeps({
      oneShotText:
        '```json\n{"mode":"matched","scope":"bugfix","rationale":["fits"],"confidence":0.8}\n```',
    });
    const start = createComposePlanStart(deps);
    const accept = await start(basePayload);
    expect(accept.accepted).toBe(true);
    const update = await waitForFinish(deps.store);
    expect(update.state).toBe('COMPLETED');
    expect(update.fromStates).toEqual(['PENDING']);
    expect(update.fields.proposal.scope).toBe('bugfix');
    // Authoritative summary is recomputed, never taken from the model.
    expect(update.fields.validation.summary.executedStages).toBe(2);
    expect(deps.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'compose.updated', intentId: 'i1' }),
    );
    // The prompt grounded the model: persona + knowledge + compiled shapes.
    const prompt = deps.oneShot.mock.calls[0][0].prompt;
    expect(prompt).toContain('PERSONA');
    expect(prompt).toContain('KNOWLEDGE');
    expect(prompt).toContain('bugfix: runs 2 of 3 stages');
  });

  it('completes a valid custom grid proposal', async () => {
    const deps = makeDeps({
      oneShotText:
        '{"mode":"custom","scope":"lean-fix","grid":{"init":"EXECUTE","analyze":"EXECUTE","build":"SKIP"},"rationale":["skip build"]}',
    });
    const start = createComposePlanStart(deps);
    await start(basePayload);
    const update = await waitForFinish(deps.store);
    expect(update.state).toBe('COMPLETED');
    expect(update.fields.proposal.grid).toEqual({
      init: 'EXECUTE',
      analyze: 'EXECUTE',
      build: 'SKIP',
    });
    expect(update.fields.validation.valid).toBe(true);
  });

  it('FAILS a proposal whose grid violates the initialization floor', async () => {
    const deps = makeDeps({
      oneShotText:
        '{"mode":"custom","scope":"bad","grid":{"init":"SKIP","analyze":"EXECUTE","build":"EXECUTE"}}',
    });
    const start = createComposePlanStart(deps);
    await start(basePayload);
    const update = await waitForFinish(deps.store);
    expect(update.state).toBe('FAILED');
    expect(update.fields.failureReason).toMatch(/grid does not resolve/);
    expect(update.fields.validation.errors.map((e) => e.code)).toContain(
      'composed_grid_initialization_skip',
    );
  });

  it('FAILS a matched proposal naming an unoffered scope', async () => {
    const deps = makeDeps({ oneShotText: '{"mode":"matched","scope":"enterprise"}' });
    const start = createComposePlanStart(deps);
    await start(basePayload);
    const update = await waitForFinish(deps.store);
    expect(update.state).toBe('FAILED');
    expect(update.fields.failureReason).toMatch(/not offered/);
  });

  it('FAILS on unparseable output and on CLI failure — never a guessed grid', async () => {
    const bad = makeDeps({ oneShotText: 'I think you should maybe skip some stages?' });
    await createComposePlanStart(bad)(basePayload);
    expect((await waitForFinish(bad.store)).state).toBe('FAILED');

    const cli = makeDeps({ oneShotOk: false });
    await createComposePlanStart(cli)(basePayload);
    const update = await waitForFinish(cli.store);
    expect(update.state).toBe('FAILED');
    expect(update.fields.failureReason).toMatch(/composer CLI failed/);
  });

  it('inflight mode enforces frozen stages and strict starvation', async () => {
    // The model proposes flipping the frozen (completed) analyze stage.
    const flip = makeDeps({
      oneShotText:
        '{"mode":"custom","scope":"reshape","grid":{"init":"EXECUTE","analyze":"SKIP","build":"EXECUTE"}}',
    });
    await createComposePlanStart(flip)({
      ...basePayload,
      mode: 'inflight',
      frozenGrid: { init: 'EXECUTE', analyze: 'EXECUTE' },
      progressContext: 'analyze: [x] completed',
    });
    const flipped = await waitForFinish(flip.store);
    expect(flipped.state).toBe('FAILED');
    expect(flipped.fields.failureReason).toMatch(/frozen stage "analyze"/);

    // Strict mode: a pending-stage SKIP that starves build hard-fails.
    const starve = makeDeps({
      oneShotText:
        '{"mode":"custom","scope":"reshape","grid":{"init":"EXECUTE","analyze":"SKIP","build":"EXECUTE"}}',
    });
    await createComposePlanStart(starve)({
      ...basePayload,
      mode: 'inflight',
      frozenGrid: { init: 'EXECUTE' },
    });
    const starved = await waitForFinish(starve.store);
    expect(starved.state).toBe('FAILED');
    expect(starved.fields.validation.errors.map((e) => e.code)).toContain('starved_consume');
  });

  it('records the one-shot metrics against the intent', async () => {
    const deps = makeDeps({ oneShotText: '{"mode":"matched","scope":"feature"}' });
    await createComposePlanStart(deps)(basePayload);
    await waitForFinish(deps.store);
    expect(deps.store.recordMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        executionId: 'i1',
        metrics: expect.objectContaining({ composeCalls: 1 }),
      }),
    );
  });

  it('dedupes an already-running compose job', async () => {
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    const deps = makeDeps();
    deps.oneShot = vi.fn(async () => {
      await gate;
      return { ok: true, text: '{"mode":"matched","scope":"feature"}', metrics: null };
    });
    const start = createComposePlanStart(deps);
    const first = await start(basePayload);
    const second = await start(basePayload);
    expect(first.accepted).toBe(true);
    expect(second.alreadyRunning).toBe(true);
    release();
    await waitForFinish(deps.store);
  });
});
