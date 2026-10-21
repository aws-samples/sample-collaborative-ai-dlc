import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  settingsScopeFor,
  validateProposal,
  buildComposePrompt,
  COMPOSER_PERSONA_TRUNCATED,
  createComposePlanStart,
  buildScopeGrounding,
  scopeGridFor,
} from '../commands/compose-plan-start.js';
import { INVOKE_DIALECT_ANNEX, invokeDialectAnnex } from '../stage-materializer.js';
import { DEFAULT_ONE_SHOT_TIMEOUT_MS } from '../cli/one-shot.js';
import { COMPOSE_GRANT_TTL_SECONDS } from '../../shared/gateway-grant.js';

// The annex the COMPOSER receives: it registers no platform tools, so every
// answer whose channel is one is rewritten onto the proposal it returns.
const TOOLLESS_ANNEX = invokeDialectAnnex({ toolless: true });
import { PROPOSAL_CONTRACT } from '../../shared/compose-match.js';

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
    exitCode: oneShotOk ? 0 : 1,
    metrics: { tokensInput: 10, tokensOutput: 5 },
    reason: oneShotOk ? null : 'cli_failed',
    ...(oneShotOk ? {} : { sample: 'boom: model unavailable' }),
  })),
  loadLibraryFn: vi.fn(async () => ({ workflow: workflow(), library: library() })),
  loadBlockBodyFn: vi.fn(async (b) => (b?.bodyRef?.s3Key === 'persona' ? 'PERSONA' : 'KNOWLEDGE')),
  listMergedBlocksFn: vi.fn(async () => scopeBlocks),
  listReleaseBlocksFn: vi.fn(async () => scopeBlocks),
  mkdirFn: vi.fn(async () => undefined),
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

describe('compose-plan-start — release-pinned intents', () => {
  const releasePin = {
    releaseId: 'aidlc:abc',
    sourceSha: 'a'.repeat(40),
    importerRevision: 1,
    closureDigest: 'd'.repeat(64),
    catalogKey: `aidlc-releases/v1/${'a'.repeat(40)}/i1/catalog.json`,
    manifestKey: `aidlc-releases/v1/${'a'.repeat(40)}/i1/manifest.json`,
  };
  const matched =
    '```json\n{"mode":"matched","scope":"bugfix","rationale":["fits"],"confidence":0.8}\n```';

  beforeEach(() => vi.clearAllMocks());

  it('grounds on the release closure and never lists merged DynamoDB blocks', async () => {
    const deps = makeDeps({ oneShotText: matched });
    const start = createComposePlanStart(deps);

    await start({ ...basePayload, methodologyRelease: releasePin });
    const update = await waitForFinish(deps.store);

    expect(update.state).toBe('COMPLETED');
    expect(deps.loadLibraryFn).toHaveBeenCalledWith(
      expect.objectContaining({ methodologyRelease: releasePin }),
    );
    expect(deps.listReleaseBlocksFn).toHaveBeenCalledWith('SCOPE', releasePin, null);
    expect(deps.listMergedBlocksFn).not.toHaveBeenCalled();
  });

  it('fails the compose when the pinned closure cannot be resolved', async () => {
    const deps = makeDeps({ oneShotText: matched });
    deps.listReleaseBlocksFn = vi.fn(async () => {
      const error = new Error('release-resolver: no published release manifest');
      error.code = 'release_not_found';
      throw error;
    });
    const start = createComposePlanStart(deps);

    await start({ ...basePayload, methodologyRelease: releasePin });
    const update = await waitForFinish(deps.store);

    expect(update.state).toBe('FAILED');
    expect(update.fields.failureReason).toContain('no published release manifest');
  });

  it('keeps the merged DynamoDB catalog for an unpinned intent', async () => {
    const deps = makeDeps({ oneShotText: matched });
    const start = createComposePlanStart(deps);

    await start(basePayload);
    await waitForFinish(deps.store);

    expect(deps.loadLibraryFn).toHaveBeenCalledWith({ workflowId: 'aidlc-v2', workflowVersion: 4 });
    expect(deps.listMergedBlocksFn).toHaveBeenCalledWith('SCOPE');
    expect(deps.listReleaseBlocksFn).not.toHaveBeenCalled();
  });
});

// The compose grant is bounded by the job instead of being retired when it
// ends, so the job's one CLI call must stay within that bound with room for
// the reads and writes around it.
describe('compose-plan-start — grant lifetime', () => {
  it('runs one composer CLI call under the default one-shot timeout', async () => {
    const deps = makeDeps({
      oneShotText:
        '```json\n{"mode":"matched","scope":"bugfix","rationale":["fits"],"confidence":0.8}\n```',
    });
    await createComposePlanStart(deps)(basePayload);
    await waitForFinish(deps.store);
    expect(deps.oneShot).toHaveBeenCalledTimes(1);
    expect(deps.oneShot.mock.calls[0][0]).not.toHaveProperty('timeoutMs');
    expect(DEFAULT_ONE_SHOT_TIMEOUT_MS / 1000).toBeLessThanOrEqual(COMPOSE_GRANT_TTL_SECONDS / 4);
  });
});

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

describe('buildComposePrompt', () => {
  const build = (overrides = {}) =>
    buildComposePrompt({
      mode: 'front',
      persona: 'Run `bun {{HARNESS_DIR}}/tools/aidlc-utility.ts detect --json`.',
      knowledge: 'See {{HARNESS_DIR}}/tools/data/stage-graph.json.',
      grounding: 'GROUNDING',
      intentPrompt: 'Build the thing',
      ...overrides,
    });

  it('neutralizes the harness token in the upstream persona and knowledge', () => {
    const prompt = build();
    expect(prompt).not.toContain('{{HARNESS_DIR}}');
    expect(prompt).toContain('bun <runtime-managed>/tools/aidlc-utility.ts detect --json');
  });

  it('overrides the harness procedure after the persona and before the grounding', () => {
    const prompt = build();
    const persona = prompt.indexOf('aidlc-utility.ts detect --json');
    const environment = prompt.indexOf('Execution environment (overrides the procedure above)');
    const grounding = prompt.indexOf('GROUNDING');
    const contract = prompt.indexOf('Respond with EXACTLY ONE fenced JSON block');
    expect(persona).toBeGreaterThanOrEqual(0);
    expect(environment).toBeGreaterThan(persona);
    expect(grounding).toBeGreaterThan(environment);
    expect(contract).toBeGreaterThan(grounding);
    expect(prompt).toContain(
      'Unavailable harness tools are never a reason to answer with mode "failed"',
    );
  });

  it('tolerates a missing persona or knowledge body', () => {
    const prompt = build({ persona: null, knowledge: null });
    expect(prompt).toContain('You are the AI-DLC composer agent');
    expect(prompt).toContain('Execution environment');
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

  // From 2.8.2 the composer persona tells the agent to run `{{INVOKE}} engine
  // graph ars` and `graph validate-grid`. No engine exists here, so the compose
  // prompt neutralizes the token and carries the annex that says what to do
  // instead, exactly like a stage prompt.
  it('neutralizes engine commands in the composer persona and appends the annex', async () => {
    const deps = makeDeps({
      oneShotText:
        '```json\n{"mode":"matched","scope":"bugfix","rationale":["fits"],"confidence":0.8}\n```',
    });
    deps.loadBlockBodyFn = vi.fn(async (b) =>
      b?.bodyRef?.s3Key === 'persona'
        ? 'Run {{INVOKE}} engine graph ars --iae <s> and copy its numbers.'
        : 'Then {{INVOKE}} engine graph validate-grid --proposal <path>.',
    );
    const start = createComposePlanStart(deps);
    await start(basePayload);
    await waitForFinish(deps.store);

    const prompt = deps.oneShot.mock.calls[0][0].prompt;
    expect(prompt).not.toContain('{{INVOKE}}');
    expect(prompt).toContain('<runtime-managed-engine> engine graph ars --iae <s>');
    expect(prompt).toContain('<runtime-managed-engine> engine graph validate-grid');
    expect(prompt).toContain(TOOLLESS_ANNEX);
  });

  // The composer's one-shot invocation supplies NO MCP configuration, so every
  // answer that names a platform tool names one it cannot call. Carrying the
  // annex is not the same as being able to perform it: a promoted fork whose
  // composer invokes an audit or a checkpoint command must get the form this
  // session can actually use — its own proposal — and must not be told to call
  // `emit_stage_note`, `ask_question` or `confirm_summary`.
  it('answers a tool-less composer in the only channel it has', async () => {
    const deps = makeDeps({
      oneShotText:
        '```json\n{"mode":"matched","scope":"bugfix","rationale":["fits"],"confidence":0.8}\n```',
    });
    deps.loadBlockBodyFn = vi.fn(async (b) =>
      b?.bodyRef?.s3Key === 'persona'
        ? 'Record it: {{INVOKE}} engine audit append-raw --text <t>.'
        : 'And log it: {{INVOKE}} engine log decision --summary <s>.',
    );
    const start = createComposePlanStart(deps);
    await start(basePayload);
    await waitForFinish(deps.store);

    const prompt = deps.oneShot.mock.calls[0][0].prompt;
    expect(prompt).toContain('**You have no platform tools in this session.**');
    expect(prompt).toContain('`rationale`');
    expect(prompt).not.toContain('`emit_stage_note`');
    expect(prompt).not.toContain('Ask with `ask_question`');
    expect(prompt).not.toContain('confirm with `confirm_summary`');
    expect(prompt).toContain('raise no checkpoint');
  });

  // A stage session keeps the tool-bearing answers: the redirect is a property
  // of the receiving session, not of the release.
  it('keeps the tool-bearing answers for a session that has the tools', () => {
    expect(
      invokeDialectAnnex({
        checkpointLogInvoked: true,
        policy: { summaryConfirmation: 'required' },
      }),
    ).toContain('`emit_stage_note`');
  });

  // The release guard answers a command in the composer's knowledge as it does in
  // its persona, so the compose prompt carries the annex for either.
  it('appends the annex when only the composer knowledge names an engine command', () => {
    const prompt = buildComposePrompt({
      mode: 'front',
      persona: 'PERSONA',
      knowledge: 'Then {{INVOKE}} engine graph validate-grid --proposal <path>.',
      intentPrompt: 'i',
    });

    expect(prompt).not.toContain('{{INVOKE}}');
    expect(prompt).toContain('<runtime-managed-engine> engine graph validate-grid');
    expect(prompt).toContain(TOOLLESS_ANNEX);
  });

  // The 2.6.18+ composer persona alone is ~46-48 KB, the whole compose budget.
  it('keeps the task, the intent and the output contract when the persona fills the budget', async () => {
    const deps = makeDeps({
      oneShotText:
        '```json\n{"mode":"matched","scope":"bugfix","rationale":["fits"],"confidence":0.8}\n```',
    });
    deps.loadBlockBodyFn = vi.fn(async (b) =>
      b?.bodyRef?.s3Key === 'persona'
        ? `{{INVOKE}} engine graph ars\n${'p'.repeat(48 * 1024)}`
        : 'KNOWLEDGE',
    );
    const start = createComposePlanStart(deps);
    await start(basePayload);
    await waitForFinish(deps.store);

    const prompt = deps.oneShot.mock.calls[0][0].prompt;
    expect(prompt.length).toBeLessThanOrEqual(48 * 1024);
    expect(prompt).toContain(TOOLLESS_ANNEX);
    expect(prompt).toContain('Intent:\n');
    expect(prompt).toContain('bugfix: runs 2 of 3 stages');
    expect(prompt).toContain('Respond with EXACTLY ONE fenced JSON block');
    expect(prompt).toContain(`${'p'.repeat(64)}\n${COMPOSER_PERSONA_TRUNCATED}\n\n`);
  });

  // A replan can carry a 24 KB report excerpt and a long grounding on top of the
  // annex, so the part after the persona can fill the budget on its own.
  it('keeps the mode task and ends with the output contract when the rest fills the budget', () => {
    const prompt = buildComposePrompt({
      mode: 'front',
      persona: `{{INVOKE}} engine graph ars\n${'P'.repeat(46000)}`,
      knowledge: 'K'.repeat(2000),
      intentPrompt: 'i',
      reportExcerpt: 'r'.repeat(24576),
      grounding: 'g'.repeat(26624),
      progressContext: 'x',
    });

    expect(prompt.length).toBeLessThanOrEqual(48 * 1024);
    expect(prompt).toContain('Task: propose the workflow projection that fits this intent.');
    expect(prompt).toContain(COMPOSER_PERSONA_TRUNCATED);
    expect(prompt.endsWith(`\n\n${PROPOSAL_CONTRACT}`)).toBe(true);
  });

  it('marks no truncation when the whole prompt fits', async () => {
    const deps = makeDeps({
      oneShotText:
        '```json\n{"mode":"matched","scope":"bugfix","rationale":["fits"],"confidence":0.8}\n```',
    });
    const start = createComposePlanStart(deps);
    await start(basePayload);
    await waitForFinish(deps.store);

    expect(deps.oneShot.mock.calls[0][0].prompt).not.toContain(COMPOSER_PERSONA_TRUNCATED);
  });

  it('adds no annex to a composer persona that names no engine command', async () => {
    const deps = makeDeps({
      oneShotText:
        '```json\n{"mode":"matched","scope":"bugfix","rationale":["fits"],"confidence":0.8}\n```',
    });
    const start = createComposePlanStart(deps);
    await start(basePayload);
    await waitForFinish(deps.store);

    expect(deps.oneShot.mock.calls[0][0].prompt).not.toContain(INVOKE_DIALECT_ANNEX);
  });

  it('loads scope, persona, and knowledge from the intent release and user pins', async () => {
    const deps = makeDeps({
      oneShotText: '{"mode":"matched","scope":"feature"}',
    });
    const methodologyRelease = {
      releaseId: 'aidlc:release-sha',
      sourceSha: 'release-sha',
      importerRevision: 2,
      closureDigest: 'closure-digest',
      catalogKey: 'catalog.json',
      manifestKey: 'manifest.json',
    };
    const methodologyPins = {
      AGENT: { 'aidlc-composer-agent': { tenantId: 'default', version: 7 } },
    };

    await createComposePlanStart(deps)({ ...basePayload, methodologyRelease, methodologyPins });
    await waitForFinish(deps.store);

    expect(deps.loadLibraryFn).toHaveBeenCalledWith({
      workflowId: basePayload.workflowId,
      workflowVersion: basePayload.workflowVersion,
      methodologyRelease,
      methodologyPins,
    });
    expect(deps.listReleaseBlocksFn).toHaveBeenCalledWith(
      'SCOPE',
      methodologyRelease,
      methodologyPins,
    );
    expect(deps.listMergedBlocksFn).not.toHaveBeenCalled();
    expect(deps.loadBlockBodyFn).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ id: 'aidlc-composer-agent' }),
      { methodologyRelease },
    );
    expect(deps.loadBlockBodyFn).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ id: 'composer-agent-composing' }),
      { methodologyRelease },
    );
  });

  it('ignores historical methodology pins when no release is pinned', async () => {
    const deps = makeDeps({
      oneShotText: '{"mode":"matched","scope":"feature"}',
    });
    const methodologyPins = {
      AGENT: { 'aidlc-composer-agent': { tenantId: 'default', version: 7 } },
    };

    await createComposePlanStart(deps)({ ...basePayload, methodologyPins });
    await waitForFinish(deps.store);

    expect(deps.loadLibraryFn).toHaveBeenCalledWith({
      workflowId: basePayload.workflowId,
      workflowVersion: basePayload.workflowVersion,
    });
    expect(deps.listMergedBlocksFn).toHaveBeenCalledWith('SCOPE');
    expect(deps.listReleaseBlocksFn).not.toHaveBeenCalled();
    expect(deps.loadBlockBodyFn).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ id: 'aidlc-composer-agent' }),
    );
    expect(deps.loadBlockBodyFn).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ id: 'composer-agent-composing' }),
    );
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
    // The one-shot's diagnostics ride the row — reason alone is undebuggable.
    expect(update.fields.failureReason).toMatch(/exit=1/);
    expect(update.fields.failureReason).toMatch(/boom: model unavailable/);
  });

  it('creates the throwaway working directory before spawning the CLI', async () => {
    const deps = makeDeps({ oneShotText: '{"mode":"matched","scope":"feature"}' });
    await createComposePlanStart(deps)(basePayload);
    await waitForFinish(deps.store);
    expect(deps.mkdirFn).toHaveBeenCalledWith(expect.stringContaining('/tmp/compose/i1'), {
      recursive: true,
    });
    // Ordering: the directory exists before the spawn uses it as cwd.
    expect(deps.mkdirFn.mock.invocationCallOrder[0]).toBeLessThan(
      deps.oneShot.mock.invocationCallOrder[0],
    );
    expect(deps.oneShot.mock.calls[0][0].cwd).toContain('/tmp/compose/i1');
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

// The compatibility property the gating exists for, asserted on the REAL compose
// job rather than on the contract string: a release whose scopes author no
// per-intent setting is asked for none and grounded in none, so its whole
// compose prompt is the one it was before this PR. A release that authors them
// gets both, and the effective values it is grounded in name nobody.
describe('compose-plan-start — the settings proposal is gated on the catalog', () => {
  beforeEach(() => vi.clearAllMocks());

  const settingsScopeBlocks = [
    { id: 'feature', keywords: ['feature'], description: 'Full flow', guardPolicy: 'off' },
    {
      id: 'bugfix',
      keywords: ['hotfix'],
      description: 'Fix and ship',
      guardPolicy: 'off',
      planApproval: 'on',
      collaborators: 'off',
    },
  ];

  const promptFor = async ({ blocks, payload = {} }) => {
    const deps = makeDeps({
      oneShotText:
        '```json\n{"mode":"matched","scope":"bugfix","rationale":["fits"],"confidence":0.8}\n```',
    });
    deps.listMergedBlocksFn = vi.fn(async (type) => (type === 'SCOPE' ? blocks : []));
    const start = createComposePlanStart(deps);
    await start({ ...basePayload, ...payload });
    await waitForFinish(deps.store);
    return deps.oneShot.mock.calls[0][0].prompt;
  };

  it('asks a release without the settings for none of them', async () => {
    const prompt = await promptFor({ blocks: scopeBlocks });

    expect(prompt).toContain(PROPOSAL_CONTRACT);
    expect(prompt).not.toContain('"guardPolicy"');
    expect(prompt).not.toContain('"scopeSettings"');
    expect(prompt).not.toContain('Do NOT return "settingsChanges"');
    expect(prompt).not.toContain('AI-DLC settings in force for this intent');
    expect(prompt).not.toContain('Settings:');
  });

  it('asks a settings-bearing release for them and grounds it in the effective values', async () => {
    const prompt = await promptFor({
      blocks: settingsScopeBlocks,
      payload: {
        policyScope: 'bugfix',
        aidlcSettings: { guardPolicy: 'strict' },
      },
    });

    expect(prompt).toContain('"scopeSettings"');
    expect(prompt).toContain('Do NOT return "settingsChanges"');
    expect(prompt).toContain('## AI-DLC settings in force for this intent');
    expect(prompt).toContain('Resolved for the selected scope "bugfix".');
    expect(prompt).toContain('- guard_policy: strict (changed for this intent)');
    expect(prompt).toContain('- plan_approval: on (scope default)');
    expect(prompt).toContain('- collaborators: off (scope default)');
    expect(prompt).not.toMatch(/chosen by/i);
  });

  // An intent that changed nothing still gets the whole section: rendering only
  // the overrides left the composer to conclude the release has no settings.
  it('grounds an intent that changed nothing in every authored value', async () => {
    const prompt = await promptFor({
      blocks: settingsScopeBlocks,
      payload: { policyScope: 'bugfix' },
    });

    expect(prompt).toContain('## AI-DLC settings in force for this intent');
    expect(prompt).toContain('- guard_policy: off (scope default)');
    expect(prompt).toContain('- plan_approval: on (scope default)');
  });

  // No selected settings scope: the section is withheld rather than guessed,
  // and the annex tells the composer to say the values are unavailable here.
  it('withholds the section when no settings scope is in force', async () => {
    const prompt = await promptFor({ blocks: settingsScopeBlocks });

    expect(prompt).toContain('"scopeSettings"');
    expect(prompt).not.toContain('AI-DLC settings in force for this intent');
  });
});

// A proposal must not offer a setting the selection does not author: Apply
// would silently prune it under a card that says Applied. The settings scope
// therefore has to be resolved for ALL THREE shapes a proposal takes, not only
// for the one that happens to carry an optional base scope.
describe('validateProposal — the settings scope of every proposal mode', () => {
  const SCOPE_BLOCKS = [
    { id: 'bugfix', keywords: ['hotfix'], planApproval: 'on' },
    { id: 'feature', keywords: ['feature'], guardPolicy: 'strict', planApproval: 'on' },
  ];
  const OFFERED = ['bugfix', 'feature'];

  const validate = (proposal, { policyScope = null, settingsAware = true } = {}) =>
    validateProposal({
      proposal,
      workflow: workflow(),
      library: library(),
      scopeBlocks: SCOPE_BLOCKS,
      offeredScopeIds: OFFERED,
      policyScope,
      settingsAware,
    });

  const matched = (extra = {}) => ({
    mode: 'matched',
    scope: 'bugfix',
    grid: null,
    rationale: [],
    confidence: null,
    ...extra,
  });
  const custom = (extra = {}) => ({
    mode: 'custom',
    scope: 'bugfix-custom',
    grid: { init: 'EXECUTE', analyze: 'SKIP', build: 'EXECUTE' },
    rationale: [],
    confidence: null,
    ...extra,
  });

  it('resolves the matched scope as the settings scope and refuses what it does not author', () => {
    expect(settingsScopeFor({ proposal: matched() })).toBe('bugfix');
    expect(validate(matched({ scopeSettings: { plan_approval: 'on' } })).error).toBeUndefined();

    const refused = validate(matched({ guardPolicy: 'strict' }));
    expect(refused.error).toMatch(/guardPolicy/);
    expect(refused.error).toMatch(/not authored by scope "bugfix"/);
  });

  it('accepts a matched proposal whose settings the matched scope does author', () => {
    const ok = validate({ ...matched({ scope: 'feature' }), guardPolicy: 'relaxed' });

    expect(ok.error).toBeUndefined();
    expect(ok.settingsScope).toBe('feature');
  });

  // Apply normalises the accepted values against the defaults the validation
  // used, so the validation returns them beside the scope it read them from.
  it('returns the settings defaults of the scope a proposal was validated against', () => {
    const ok = validate({ ...matched({ scope: 'feature' }), guardPolicy: 'relaxed' });

    expect(ok.settingsAuthored).toEqual({ guardPolicy: 'strict', planApproval: 'on' });
  });

  it('resolves an explicit base scope for a custom proposal', () => {
    expect(settingsScopeFor({ proposal: custom({ baseScope: 'feature' }) })).toBe('feature');

    const ok = validate(custom({ baseScope: 'feature', guardPolicy: 'relaxed' }));
    expect(ok.error).toBeUndefined();
    expect(ok.settingsScope).toBe('feature');

    const refused = validate(custom({ baseScope: 'bugfix', guardPolicy: 'relaxed' }));
    expect(refused.error).toMatch(/not authored by scope "bugfix"/);
  });

  // The omitted-base case: the proposal inherits the scope the selection
  // already runs on, which is exactly the scope Apply will keep.
  it('falls back to the selection’s own scope when the proposal omits the base', () => {
    expect(settingsScopeFor({ proposal: custom(), policyScope: 'feature' })).toBe('feature');

    const ok = validate(custom({ guardPolicy: 'relaxed' }), { policyScope: 'feature' });
    expect(ok.error).toBeUndefined();
    expect(ok.settingsScope).toBe('feature');

    const refused = validate(custom({ guardPolicy: 'relaxed' }), { policyScope: 'bugfix' });
    expect(refused.error).toMatch(/not authored by scope "bugfix"/);
  });

  // No base and no current scope: there is no authored map at all, so a
  // proposal that still offers a setting is refused by name rather than
  // completing with values nothing can carry.
  it('refuses proposed settings when no scope resolves to author them', () => {
    const refused = validate(custom({ guardPolicy: 'relaxed' }));

    expect(refused.error).toMatch(/have no scope to be authored by/);
  });

  it('leaves a proposal that offers no per-intent setting alone in every mode', () => {
    expect(validate(matched()).error).toBeUndefined();
    expect(validate(custom()).error).toBeUndefined();
    expect(validate(custom({ baseScope: 'bugfix' })).settingsScope).toBe('bugfix');
  });

  it('still refuses a base scope this workflow does not offer', () => {
    expect(validate(custom({ baseScope: 'not-a-scope' })).error).toMatch(/is not offered/);
  });

  // A catalog that authors none of these settings is never asked for one, so a
  // value a model volunteers there is ignored exactly as the parser contract
  // says: the verdict, the recorded fields and therefore the compose DTO of an
  // unpinned, 2.3.3, 2.8.2 or 2.9.0 compose are what they were before the
  // settings existed.
  it('ignores volunteered settings on a catalog that authors none', () => {
    const notAware = { settingsAware: false };

    const matchedOk = validate(matched({ guardPolicy: 'strict' }), notAware);
    expect(matchedOk.error).toBeUndefined();
    expect(matchedOk.settingsScope).toBeNull();
    expect(matchedOk).not.toHaveProperty('settingsAuthored');

    const customOk = validate(custom({ guardPolicy: 'relaxed' }), notAware);
    expect(customOk.error).toBeUndefined();
    expect(customOk.settingsScope).toBeNull();

    // Even a base scope the workflow does not offer is left alone: nothing
    // reads it, so refusing the whole proposal over it would turn a compose
    // that used to COMPLETE into a FAILED one.
    expect(validate(custom({ baseScope: 'not-a-scope' }), notAware).error).toBeUndefined();
    expect(validate(custom({ baseScope: 'feature' }), notAware).settingsScope).toBeNull();
  });

  // The settings a proposal carries that have no per-intent surface here are
  // NOT part of the authored check: they are reported to the member and keep
  // following the scope, so they can never be refused for being unauthored.
  it('ignores the proposed settings this platform does not make per-intent', () => {
    expect(
      validate(matched({ scopeSettings: { sensors: 'off', review_cap: 'advisory' } })).error,
    ).toBeUndefined();
  });
});

// The same rule on the real compose job: a proposal whose settings the resolved
// settings scope does not author must finish FAILED, not COMPLETED.
describe('compose-plan-start — a proposal is refused for an unauthored setting', () => {
  beforeEach(() => vi.clearAllMocks());

  const SCOPE_BLOCKS = [
    { id: 'feature', keywords: ['feature'], description: 'Full flow', planApproval: 'on' },
    { id: 'bugfix', keywords: ['hotfix'], description: 'Fix and ship', planApproval: 'on' },
  ];

  const runJob = async (proposalJson, payload = {}) => {
    const deps = makeDeps({ oneShotText: `\`\`\`json\n${proposalJson}\n\`\`\`` });
    deps.listMergedBlocksFn = vi.fn(async (type) => (type === 'SCOPE' ? SCOPE_BLOCKS : []));
    const start = createComposePlanStart(deps);
    await start({ ...basePayload, ...payload });
    return waitForFinish(deps.store);
  };

  it('fails a matched proposal that offers a setting the matched scope lacks', async () => {
    const update = await runJob('{"mode":"matched","scope":"bugfix","guardPolicy":"strict"}');

    expect(update.state).toBe('FAILED');
    expect(update.fields.failureReason).toMatch(/guardPolicy/);
    expect(update.fields.failureReason).toMatch(/not authored by scope "bugfix"/);
  });

  it('fails a custom proposal with an omitted base for the same reason', async () => {
    const update = await runJob(
      '{"mode":"custom","scope":"bugfix-custom","grid":{"init":"EXECUTE","analyze":"SKIP","build":"EXECUTE"},"guardPolicy":"strict"}',
      { policyScope: 'bugfix' },
    );

    expect(update.state).toBe('FAILED');
    expect(update.fields.failureReason).toMatch(/not authored by scope "bugfix"/);
  });

  it('completes and records the settings scope a proposal was validated against', async () => {
    const update = await runJob(
      '{"mode":"custom","scope":"bugfix-custom","grid":{"init":"EXECUTE","analyze":"SKIP","build":"EXECUTE"},"baseScope":"bugfix","scopeSettings":{"plan_approval":"on"}}',
    );

    expect(update.state).toBe('COMPLETED');
    expect(update.fields.settingsScope).toBe('bugfix');
    expect(update.fields.settingsAuthored).toEqual({ planApproval: 'on' });
    expect(update.fields.proposal.scopeSettings).toEqual({ plan_approval: 'on' });
  });
});
