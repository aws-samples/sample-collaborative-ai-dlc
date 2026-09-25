// `SCOPE.change_control` — the pre-agent comparison.
//
// The semantic under test is upstream's: a stage must not silently run against an
// input whose bytes moved since a human approved it. `relaxed` records the change
// and continues; `strict` asks first, and the "stop" answer is a REWIND-ELIGIBLE
// failure rather than a dead end. The anti-stuck contract (§8.1 rule 1) is the
// thing these tests actually protect: every path below ends in proceed, a gate
// with two real options, or a recoverable FAILED.

import { describe, it, expect } from 'vitest';
import { runStage, __test } from '../commands/run-stage.js';
import { renderRulesDoc } from '../stage-materializer.js';
import { stageInstanceId as planStageInstanceId } from '../../shared/v2-execution-plan.js';

const { changedApprovedInputs, changeControlChoice, changeControlGateId, isChangeControlGate } =
  __test;

describe('changedApprovedInputs', () => {
  const head = (overrides) => ({
    artifactId: 'a1',
    artifactType: 'requirements-analysis',
    logicalKey: 'i1::requirements-analysis::producer',
    snapshotHash: 'new',
    ...overrides,
  });
  const approval = (inputs, decidedAt = '2026-01-01T00:00:00.000Z') => ({
    kind: 'stage-approval',
    decidedAt,
    detail: { approvedInputs: inputs },
  });

  it('reports a required input whose fingerprint moved since the approval', () => {
    expect(
      changedApprovedInputs({
        requiredInputs: ['requirements-analysis'],
        heads: [head()],
        approvals: [approval([{ logicalKey: head().logicalKey, snapshotHash: 'old' }])],
      }),
    ).toEqual([
      {
        artifactId: 'a1',
        artifactType: 'requirements-analysis',
        logicalKey: 'i1::requirements-analysis::producer',
        fromHash: 'old',
        toHash: 'new',
        approvedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
  });

  it('says nothing when the fingerprint is unchanged', () => {
    expect(
      changedApprovedInputs({
        requiredInputs: ['requirements-analysis'],
        heads: [head()],
        approvals: [approval([{ logicalKey: head().logicalKey, snapshotHash: 'new' }])],
      }),
    ).toEqual([]);
  });

  // An input no approval ever recorded has no fingerprint to have moved FROM.
  // Reporting it would fire change control on the first stage of every run.
  it('ignores an input no approval ever recorded', () => {
    expect(
      changedApprovedInputs({
        requiredInputs: ['requirements-analysis'],
        heads: [head()],
        approvals: [],
      }),
    ).toEqual([]);
  });

  it('ignores an artifact this stage does not declare as an input', () => {
    expect(
      changedApprovedInputs({
        requiredInputs: ['design'],
        heads: [head()],
        approvals: [approval([{ logicalKey: head().logicalKey, snapshotHash: 'old' }])],
      }),
    ).toEqual([]);
  });

  // Identity is the LOGICAL key: two artifacts of the same type must not be
  // compared against each other's fingerprint.
  it('compares per logical key, not per artifact type', () => {
    const changed = changedApprovedInputs({
      requiredInputs: ['requirements-analysis'],
      heads: [
        head({ artifactId: 'a1', logicalKey: 'k1', snapshotHash: 'x' }),
        head({ artifactId: 'a2', logicalKey: 'k2', snapshotHash: 'y' }),
      ],
      approvals: [
        approval([
          { logicalKey: 'k1', snapshotHash: 'x' },
          { logicalKey: 'k2', snapshotHash: 'old-y' },
        ]),
      ],
    });
    expect(changed.map((item) => item.artifactId)).toEqual(['a2']);
  });

  it('takes the LATEST approval of a key when several recorded it', () => {
    const changed = changedApprovedInputs({
      requiredInputs: ['requirements-analysis'],
      heads: [head({ snapshotHash: 'v3' })],
      approvals: [
        approval([{ logicalKey: head().logicalKey, snapshotHash: 'v1' }], '2026-01-01T00:00:00Z'),
        approval([{ logicalKey: head().logicalKey, snapshotHash: 'v2' }], '2026-02-01T00:00:00Z'),
      ],
    });
    expect(changed[0].fromHash).toBe('v2');
  });
});

describe('changeControlChoice', () => {
  it('reads the option out of every answer shape the answer endpoint writes', () => {
    expect(
      changeControlChoice({ answer: { perQuestion: [{ answer: 'Reconfirm and continue' }] } }),
    ).toBe('reconfirm');
    expect(changeControlChoice({ answer: 'Stop here so I can rewind' })).toBe('stop');
    expect(changeControlChoice({ answer: { freeText: 'stop here' } })).toBe('stop');
  });

  // A garbled answer names no option; the caller treats that as NOT a
  // reconfirmation and halts (recoverable via rewind).
  it('returns null for an answer that names neither option', () => {
    expect(changeControlChoice({ answer: { freeText: 'maybe?' } })).toBeNull();
    expect(changeControlChoice(null)).toBeNull();
  });
});

describe('change-control gate identity', () => {
  // The prefix is load-bearing: the resume leg uses it to recognize a gate with
  // no parked conversation behind it.
  it('is recognizable, deterministic per attempt, and distinct across attempts', () => {
    expect(isChangeControlGate({ humanTaskId: changeControlGateId('si-1', 0) })).toBe(true);
    expect(isChangeControlGate({ humanTaskId: 'q-abc' })).toBe(false);
    expect(changeControlGateId('si-1', 0)).toBe(changeControlGateId('si-1', 0));
    expect(changeControlGateId('si-1', 1)).not.toBe(changeControlGateId('si-1', 0));
  });
});

// ── Integration: the pre-agent ladder inside runStage ────────────────────────

const PRODUCER = 'requirements-analysis';
const CONSUMER = 'application-design';
const CONSUMER_INSTANCE = planStageInstanceId('aidlc-v2@1', CONSUMER);

const libraryWith = (scopeFm) => ({
  fromRelease: true,
  stagesById: {
    [PRODUCER]: {
      id: PRODUCER,
      version: 1,
      phase: 'inception',
      mode: 'inline',
      leadAgent: 'aidlc-product-agent',
      produces: [PRODUCER],
      consumes: [],
      sensors: [],
      humanValidation: 'required',
      bodyRef: { s3Key: 'blocks/bodies/sha256/producer' },
    },
    [CONSUMER]: {
      id: CONSUMER,
      version: 1,
      phase: 'inception',
      mode: 'inline',
      leadAgent: 'aidlc-product-agent',
      produces: [CONSUMER],
      consumes: [PRODUCER],
      requires: [PRODUCER],
      sensors: [],
      humanValidation: 'required',
      bodyRef: { s3Key: 'blocks/bodies/sha256/consumer' },
    },
  },
  agentsById: {
    'aidlc-product-agent': { id: 'aidlc-product-agent', modelOverride: null, bodyRef: null },
  },
  sensorsById: {},
  rulesById: {},
  artifactsById: {
    [PRODUCER]: { id: PRODUCER, terminal: false },
    [CONSUMER]: { id: CONSUMER, terminal: true },
  },
  knowledgeById: {},
  scopesById: {
    feature: { id: 'feature', name: 'feature', depth: 'standard', version: 1, ...scopeFm },
  },
});

const workflow = () => ({
  id: 'aidlc-v2',
  version: 1,
  placements: [
    { stageId: PRODUCER, order: 0, scopeMembership: { feature: 'EXECUTE' } },
    { stageId: CONSUMER, order: 1, scopeMembership: { feature: 'EXECUTE' } },
  ],
  ruleRefs: [],
  scopeRefs: [{ scopeId: 'feature' }],
});

const HEAD = Object.freeze({
  artifactId: 'a-req',
  artifactType: PRODUCER,
  logicalKey: `i1::${PRODUCER}::${planStageInstanceId('aidlc-v2@1', PRODUCER)}`,
  snapshotHash: 'sha-new',
});

// A store that records every write and answers the reads the ladder performs.
const harnessStore = ({ receipts = [], events = [], humanTask = null, attempt = 0 } = {}) => {
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
    createHumanTask: rec('createHumanTask'),
    putReceipt: rec('putReceipt'),
    recordSensorRun: rec('recordSensorRun'),
    async appendOutput(args) {
      calls.push(['appendOutput', args]);
      return { seq: 1, timestamp: 'T' };
    },
    async recordMetric(args) {
      calls.push(['recordMetric', args]);
      return { metricId: 'm' };
    },
    async getStage() {
      return { stageInstanceId: CONSUMER_INSTANCE, attempt };
    },
    async getHumanTask(_e, id) {
      calls.push(['getHumanTask', id]);
      return humanTask && humanTask.humanTaskId === id ? humanTask : null;
    },
    async getExecution() {
      return null;
    },
    async getUnitPlan() {
      return null;
    },
    async listEvents() {
      return events;
    },
    async listReceipts(_e, { kind, attempt: wanted } = {}) {
      return receipts
        .filter((row) => kind == null || row.kind === kind)
        .filter((row) => wanted == null || Number(row.attempt) === Number(wanted));
    },
  };
};

const deps = (store, overrides = {}) => ({
  store,
  loadLibrary: async () => ({
    workflow: workflow(),
    library: libraryWith(overrides.scopeFm ?? {}),
  }),
  loadBlockBody: async () => 'body',
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
  commitAndPushAll: async () => ({ ok: true, committed: false, results: [] }),
  openGraph: async () => ({}),
  readArtifactHeadHashes: async () => [HEAD],
  spawnFn: () => ({
    on: (event, callback) => event === 'close' && setImmediate(() => callback(0)),
    stdin: { end() {} },
  }),
  ...overrides.deps,
});

// The change-control section is prepended AFTER materializeStage returns, so the
// only place to observe the final prompt is the argv/stdin the CLI was spawned
// with. Claude takes the prompt on stdin.
const promptCapture = () => {
  const seen = { prompt: '' };
  return {
    seen,
    spawnFn: () => ({
      on: (event, callback) => event === 'close' && setImmediate(() => callback(0)),
      stdin: {
        end(chunk) {
          if (chunk) seen.prompt += String(chunk);
        },
      },
    }),
  };
};

const args = {
  projectId: 'p1',
  intentId: 'i1',
  executionId: 'e1',
  stageId: CONSUMER,
  workflowId: 'aidlc-v2',
  workflowVersion: 1,
  scope: 'feature',
  workspaceDir: '/ws',
};

const APPROVAL = Object.freeze({
  kind: 'stage-approval',
  attempt: 0,
  decidedAt: '2026-01-01T00:00:00.000Z',
  detail: { approvedInputs: [{ logicalKey: HEAD.logicalKey, snapshotHash: 'sha-old' }] },
});

describe('runStage — change_control: absent (the inert path)', () => {
  it('performs no comparison and adds nothing to the prompt', async () => {
    const store = harnessStore({ receipts: [APPROVAL] });
    const capture = promptCapture();
    const res = await runStage(args, deps(store, { deps: { spawnFn: capture.spawnFn } }));
    expect(res.ok).toBe(true);
    expect(capture.seen.prompt).not.toContain('Inputs that changed');
    expect(store.of('appendEvent').map((e) => e.type)).not.toContain('v2.change.accepted');
    expect(store.of('createHumanTask')).toEqual([]);
  });
});

describe('runStage — change_control: relaxed', () => {
  it('records ONE deduplicated v2.change.accepted and continues', async () => {
    const store = harnessStore({
      receipts: [APPROVAL],
      events: [
        {
          type: 'v2.change.accepted',
          detail: { artifactId: HEAD.artifactId, fromHash: 'sha-old', toHash: 'sha-new' },
        },
      ],
    });
    const res = await runStage(args, deps(store, { scopeFm: { changeControl: 'relaxed' } }));
    expect(res.ok).toBe(true);
    expect(res.state).toBe('SUCCEEDED');
    // The identical change was already accepted by an earlier stage: one change,
    // one record.
    expect(store.of('appendEvent').filter((e) => e.type === 'v2.change.accepted')).toEqual([]);
    expect(res.changedInputs).toHaveLength(1);
    expect(res.findings?.[0]).toMatchObject({
      code: 'change_control_input_changed',
      severity: 'advisory',
      overridable: false,
    });
  });

  it('records the change the first time it is seen', async () => {
    const store = harnessStore({ receipts: [APPROVAL] });
    await runStage(args, deps(store, { scopeFm: { changeControl: 'relaxed' } }));
    const accepted = store.of('appendEvent').filter((e) => e.type === 'v2.change.accepted');
    expect(accepted).toHaveLength(1);
    expect(accepted[0].detail).toMatchObject({ fromHash: 'sha-old', toHash: 'sha-new' });
  });

  it('records unreadable artifact history and proceeds', async () => {
    const store = harnessStore({ receipts: [APPROVAL] });
    let spawned = false;
    const res = await runStage(
      args,
      deps(store, {
        scopeFm: { changeControl: 'relaxed' },
        deps: {
          openGraph: async () => {
            throw new Error('graph unavailable');
          },
          spawnFn: () => {
            spawned = true;
            return {
              on: (event, callback) => event === 'close' && setImmediate(() => callback(0)),
              stdin: { end() {} },
            };
          },
        },
      }),
    );

    expect(res).toMatchObject({ ok: true, state: 'SUCCEEDED' });
    expect(spawned).toBe(true);
    expect(store.of('appendEvent')).toContainEqual(
      expect.objectContaining({
        type: 'v2.change.accepted',
        detail: expect.objectContaining({
          artifactType: PRODUCER,
          artifactHistoryReadFailed: true,
        }),
      }),
    );
  });

  it('records incomplete approval history and proceeds in relaxed mode', async () => {
    const store = harnessStore({
      receipts: [
        {
          ...APPROVAL,
          detail: { approvedInputs: [], approvedInputsTruncated: true, approvedInputsOmitted: 1 },
        },
      ],
    });
    const res = await runStage(args, deps(store, { scopeFm: { changeControl: 'relaxed' } }));

    expect(res).toMatchObject({ ok: true, state: 'SUCCEEDED' });
    expect(store.of('createHumanTask')).toEqual([]);
    expect(store.of('appendEvent')).toContainEqual(
      expect.objectContaining({
        type: 'v2.change.accepted',
        detail: expect.objectContaining({ approvalHistoryUnknown: true }),
      }),
    );
  });
});

describe('runStage — change_control: strict', () => {
  it('opens a two-option question gate BEFORE the agent and parks', async () => {
    const store = harnessStore({ receipts: [APPROVAL] });
    let spawned = false;
    const res = await runStage(
      args,
      deps(store, {
        scopeFm: { changeControl: 'strict' },
        deps: {
          spawnFn: () => {
            spawned = true;
            return {
              on: (event, callback) => event === 'close' && setImmediate(() => callback(0)),
              stdin: { end() {} },
            };
          },
        },
      }),
    );
    expect(res).toMatchObject({
      ok: true,
      state: 'WAITING_FOR_HUMAN',
      humanTaskId: changeControlGateId(CONSUMER_INSTANCE, 0),
    });
    // BEFORE the agent is the whole point: no CLI session was started.
    expect(spawned).toBe(false);
    const [gate] = store.of('createHumanTask');
    expect(gate.kind).toBe('question');
    const [question] = JSON.parse(gate.questions);
    expect(question.options.map((o) => o.label)).toEqual([
      'Reconfirm and continue',
      'Stop here so I can rewind',
    ]);
    // `v2.question.asked` would arm the summary_confirmation `if-present` rule;
    // an engine-opened gate is not the agent asking.
    const types = store.of('appendEvent').map((e) => e.type);
    expect(types).toContain('v2.change.review_requested');
    expect(types).not.toContain('v2.question.asked');
  });

  it('reconfirms unreadable artifact history before spawning the agent', async () => {
    const store = harnessStore({ receipts: [APPROVAL] });
    let spawned = false;
    const res = await runStage(
      args,
      deps(store, {
        scopeFm: { changeControl: 'strict' },
        deps: {
          openGraph: async () => {
            throw new Error('graph unavailable');
          },
          spawnFn: () => {
            spawned = true;
            return {
              on: (event, callback) => event === 'close' && setImmediate(() => callback(0)),
              stdin: { end() {} },
            };
          },
        },
      }),
    );

    expect(res).toMatchObject({
      ok: true,
      state: 'WAITING_FOR_HUMAN',
      humanTaskId: changeControlGateId(CONSUMER_INSTANCE, 0),
    });
    expect(spawned).toBe(false);
    const [gate] = store.of('createHumanTask');
    const [question] = JSON.parse(gate.questions);
    expect(question.text).toContain('could not be read');
  });

  it('reconfirm writes the receipt, tells the agent, and runs the stage', async () => {
    const store = harnessStore({
      receipts: [APPROVAL],
      humanTask: {
        humanTaskId: changeControlGateId(CONSUMER_INSTANCE, 0),
        status: 'answered',
        answeredBy: 'u1',
        answeredByName: 'Ada',
        answer: { perQuestion: [{ answer: 'Reconfirm and continue' }] },
      },
    });
    const capture = promptCapture();
    const res = await runStage(
      args,
      deps(store, {
        scopeFm: { changeControl: 'strict' },
        deps: { spawnFn: capture.spawnFn },
      }),
    );
    expect(res.state).toBe('SUCCEEDED');
    expect(store.of('putReceipt')[0]).toMatchObject({
      kind: 'change-reconfirm',
      attempt: 0,
      choice: 'reconfirm',
      decidedByName: 'Ada',
    });
    expect(store.of('appendEvent').map((e) => e.type)).toContain('v2.change.reconfirmed');
    expect(capture.seen.prompt).toContain('Inputs that changed since they were approved');
    expect(capture.seen.prompt).toContain('reconfirmed');
  });

  it('fails rewindably before the agent when the reconfirmation receipt cannot be persisted', async () => {
    const store = harnessStore({
      receipts: [APPROVAL],
      humanTask: {
        humanTaskId: changeControlGateId(CONSUMER_INSTANCE, 0),
        status: 'answered',
        answer: { perQuestion: [{ answer: 'Reconfirm and continue' }] },
      },
    });
    store.putReceipt = async () => {
      throw new Error('receipt store unavailable');
    };
    let spawned = false;

    const result = await runStage(
      args,
      deps(store, {
        scopeFm: { changeControl: 'strict' },
        deps: {
          spawnFn: () => {
            spawned = true;
            return {
              on: (event, callback) => event === 'close' && setImmediate(() => callback(0)),
              stdin: { end() {} },
            };
          },
        },
      }),
    );

    expect(result).toMatchObject({ ok: false, reason: 'change_control_receipt_failed' });
    expect(spawned).toBe(false);
    expect(store.of('updateStageState').at(-1)).toMatchObject({
      state: 'FAILED',
      runtimeError: 'change_control_receipt_failed',
    });
  });

  // "Stop here" is a recoverable FAILED that
  // names the producing stage, so the existing rewind API can act on it. It is
  // never a hang and never a silent refusal.
  it('stop halts with change_control_halt and names the producer to rewind to', async () => {
    const store = harnessStore({
      receipts: [APPROVAL],
      humanTask: {
        humanTaskId: changeControlGateId(CONSUMER_INSTANCE, 0),
        status: 'answered',
        answeredByName: 'Ada',
        answer: { perQuestion: [{ answer: 'Stop here so I can rewind' }] },
      },
    });
    const res = await runStage(args, deps(store, { scopeFm: { changeControl: 'strict' } }));
    expect(res).toMatchObject({ ok: false, reason: 'change_control_halt' });
    // A recoverable FAILED, not a hang: the STAGE row is FAILED and the pending
    // gate pointer is cleared so the rewind API can act.
    expect(store.of('updateStageState').at(-1)).toMatchObject({
      state: 'FAILED',
      runtimeError: 'change_control_halt',
      pendingHumanTaskId: null,
    });
    expect(res.detail).toContain(PRODUCER);
    const halted = store.of('appendEvent').find((e) => e.type === 'v2.change.halted');
    expect(halted.detail.producers).toContain(PRODUCER);
  });

  // Strict change control runs a stage against moved inputs only on an explicit
  // yes. An answer naming neither option is not one: it halts exactly like
  // "Stop here" (a recoverable FAILED the rewind API can act on) and records no
  // reconfirmation receipt, so nothing downstream can read it as consent.
  it('an answer naming neither option halts instead of inferring a reconfirmation', async () => {
    const store = harnessStore({
      receipts: [APPROVAL],
      humanTask: {
        humanTaskId: changeControlGateId(CONSUMER_INSTANCE, 0),
        status: 'answered',
        answer: { freeText: 'hmm' },
      },
    });
    const res = await runStage(args, deps(store, { scopeFm: { changeControl: 'strict' } }));
    expect(res).toMatchObject({ ok: false, reason: 'change_control_halt' });
    expect(store.of('updateStageState').at(-1)).toMatchObject({
      state: 'FAILED',
      runtimeError: 'change_control_halt',
      pendingHumanTaskId: null,
    });
    expect(store.of('putReceipt').filter((row) => row.kind === 'change-reconfirm')).toEqual([]);
    const halted = store.of('appendEvent').find((e) => e.type === 'v2.change.halted');
    expect(halted.detail).toMatchObject({ unparsed: true });
    expect(halted.detail.producers).toContain(PRODUCER);
  });

  it('an explicit reconfirmation records the choice verbatim, never as an inference', async () => {
    const store = harnessStore({
      receipts: [APPROVAL],
      humanTask: {
        humanTaskId: changeControlGateId(CONSUMER_INSTANCE, 0),
        status: 'answered',
        answer: { perQuestion: [{ answer: 'Reconfirm and continue' }] },
      },
    });
    const res = await runStage(args, deps(store, { scopeFm: { changeControl: 'strict' } }));
    expect(res.state).toBe('SUCCEEDED');
    const [receipt] = store.of('putReceipt').filter((row) => row.kind === 'change-reconfirm');
    expect(receipt.choice).toBe('reconfirm');
    expect(receipt.detail).not.toHaveProperty('inferred');
  });

  it('does not re-ask once a reconfirmation receipt exists for THIS attempt', async () => {
    const store = harnessStore({
      receipts: [APPROVAL, { kind: 'change-reconfirm', attempt: 0, detail: {} }],
    });
    const res = await runStage(args, deps(store, { scopeFm: { changeControl: 'strict' } }));
    expect(res.state).toBe('SUCCEEDED');
    expect(store.of('createHumanTask')).toEqual([]);
  });

  // A rewind bumps `attempt`, which makes every
  // prior receipt unreachable — so the checkpoint is asked again rather than
  // silently inheriting a decision taken about different bytes.
  it('re-asks after a rewind, because the prior attempt receipt is out of scope', async () => {
    const store = harnessStore({
      attempt: 1,
      receipts: [APPROVAL, { kind: 'change-reconfirm', attempt: 0, detail: {} }],
    });
    const res = await runStage(args, deps(store, { scopeFm: { changeControl: 'strict' } }));
    expect(res.state).toBe('WAITING_FOR_HUMAN');
    expect(store.of('createHumanTask')[0].humanTaskId).toBe(
      changeControlGateId(CONSUMER_INSTANCE, 1),
    );
  });
});
