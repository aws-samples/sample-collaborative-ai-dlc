// Construction Autonomy Mode at the validation gate: which gates the grant
// waives, which it never does, and what it writes when it waives one.
//
// The first test is the byte-identity guarantee: an intent with no grant opens
// exactly the gates it opened before the mode existed.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __durableHandler } from '../index.js';

const makeCtx = (over = {}) => {
  const stageCallbacks = new Map();
  const ctx = {
    logger: { info() {}, debug() {}, error() {} },
    step: async (_name, fn) => fn(),
    createCallback: async (name) => {
      if (String(name).startsWith('stage-cb-')) {
        let resolve;
        const promise = new Promise((r) => {
          resolve = r;
        });
        const callbackId = `cb-${name}`;
        stageCallbacks.set(callbackId, resolve);
        return [promise, callbackId];
      }
      return [Promise.resolve({ answer: null }), `cb-${name}`];
    },
    wait: async () => undefined,
    promise: {
      race: async (_name, promises) => Promise.race(promises),
      allSettled: async (_name, promises) => Promise.allSettled(promises),
    },
    runInChildContext: (_name, fn) => Promise.resolve().then(() => fn(ctx)),
    stageCallbackResolvers: stageCallbacks,
    ...over,
  };
  return ctx;
};

const META = {
  executionId: 'i1',
  intentId: 'i1',
  projectId: 'p1',
  status: 'CREATED',
  workflowId: 'aidlc-v2',
  workflowVersion: 1,
  scope: 'feature',
  startedAt: 'T',
  startedBy: 'u1',
  repos: ['owner/repo'],
  branch: 'aidlc/i1',
  baseBranch: 'main',
  gitProvider: 'github',
  agentCli: 'kiro',
  parkReleaseSeconds: 300,
  environment: { runtimeArn: 'arn:runtime', runtimeEndpoint: 'revision_r_1' },
};

const POLICY = Object.freeze({
  sensorsEnabled: true,
  reviewClass: 'adversarial',
  reviewArtifact: null,
  summaryConfirmation: 'none',
  changeControl: null,
  learnings: 'off',
  skeleton: null,
  planApproval: null,
  loopBack: null,
  constructionAutonomy: 'native',
});

const constructionStage = (stageId, over = {}) => ({
  stageId,
  stageInstanceId: `si-${stageId}`,
  phase: 'construction',
  humanValidation: 'required',
  outputArtifacts: [{ artifact: `${stageId}-out` }],
  policy: POLICY,
  ...over,
});

// Two construction stages: the first always keeps its human gate, the second is
// the one the grant may waive.
const ANCHOR = constructionStage('functional-design');
const SECOND = constructionStage('build-and-test');

const BLOCKING_SENSOR = {
  sensorId: 'claim-sources',
  result: 'FAIL',
  severity: 'blocking',
  detail: { artifact: 'build-and-test-out.md', reason: 'unsourced claim' },
};

let deps;
let ctx;
let stageVerdicts;
let execution;

const makeRuntime = () =>
  vi.fn(async (payload) => {
    if (payload.command === 'create-workflow-checkpoint') return { ok: true, checkpointId: 'cp' };
    if (payload.command === 'init-ws') return { ok: true };
    if (payload.command === 'run-stage-start') {
      const resolve = ctx.stageCallbackResolvers.get(payload.stageCallbackId);
      resolve(stageVerdicts(payload.stageId));
      return { ok: true, accepted: true, stageId: payload.stageId };
    }
    return { ok: true };
  });

// Answer every gate this run opens with the first option that actually ENDS the
// walk — `approve` when it is offered, otherwise the override. A gate answered
// with an option it never offered degrades to `request-changes`, which re-runs
// the stage forever when the stage verdict is deterministic.
const answerWithOfferedOption = (decisionFor = null) => {
  const seen = new Set();
  return vi.fn(async (_executionId, humanTaskId) => {
    if (!seen.has(humanTaskId)) {
      seen.add(humanTaskId);
      return null;
    }
    const opened = deps.store.createHumanTask.mock.calls
      .map(([args]) => args)
      .find((args) => args.humanTaskId === humanTaskId);
    const options = opened?.options ?? ['approve'];
    const preferred = decisionFor?.(options) ?? null;
    const decision =
      preferred ??
      (options.includes('approve')
        ? 'approve'
        : options.includes('override-and-approve')
          ? 'override-and-approve'
          : 'approve');
    return {
      humanTaskId,
      status: decision === 'request-changes' ? 'rejected' : 'answered',
      answer: { decision, reason: 'Accepted for this gate test.' },
      answeredBy: 'u1',
      answeredByName: 'Ada',
    };
  });
};

// A clean stage result: the runner observed the stage's declared output. Without
// `producedHeads` the outputs were never observed, which must not read as clean.
const cleanVerdict = (stageId) => ({
  ok: true,
  state: 'SUCCEEDED',
  producedHeads: [
    { artifactType: `${stageId}-out`, logicalKey: `${stageId}-k`, snapshotHash: 'sha-1' },
  ],
});

beforeEach(() => {
  ctx = makeCtx();
  stageVerdicts = cleanVerdict;
  execution = { ...META };
  deps = {
    store: {
      getExecution: vi.fn(async () => execution),
      updateExecution: vi.fn(async (args) => {
        if (args.constructionGateAutonomy !== undefined) {
          execution = { ...execution, constructionGateAutonomy: args.constructionGateAutonomy };
        }
        return {};
      }),
      createHumanTask: vi.fn(async (args) => ({ ...args, status: 'pending' })),
      setGateCallbackId: vi.fn(async () => ({})),
      supersedeHumanTask: vi.fn(async () => ({})),
      getHumanTask: answerWithOfferedOption(),
      appendEvent: vi.fn(async () => ({})),
      putTrackerSync: vi.fn(async (args) => args),
      failRunningStageAttempt: vi.fn(async () => null),
      listUnits: vi.fn(async () => []),
      getUnit: vi.fn(async () => null),
      getStage: vi.fn(async (_e, stageInstanceId) => ({ stageInstanceId, attempt: 0 })),
      listReceipts: vi.fn(async () => []),
      listEvents: vi.fn(async () => []),
      putReceipt: vi.fn(async (args) => args),
      // The loop-back cap lives on META and is bumped by the TARGET row's reset,
      // so the fake has to bump it too — otherwise an autonomous run keeps
      // re-taking a jump that is never spent.
      resetStageRow: vi.fn(async (args) => {
        if (args.loopBackId) {
          execution = { ...execution, loopBackCount: Number(execution.loopBackCount ?? 0) + 1 };
        }
        return args;
      }),
      updateStageState: vi.fn(async (args) => args),
    },
    loadPlan: vi.fn(async () => ({ valid: true, plan: { stages: [ANCHOR, SECOND] } })),
    invokeRuntime: null,
    issueAgentCredentialGrant: vi.fn(async () => 'grant'),
    stopSession: vi.fn(async () => ({ stopped: true })),
    broadcast: vi.fn(async () => {}),
    openPr: vi.fn(async () => ({ skipped: true, reason: 'no_changes' })),
    comparePrBranches: vi.fn(async () => ({ status: 'unknown' })),
    applicationUrl: 'https://aidlc.example.test/',
  };
  deps.invokeRuntime = makeRuntime();
});

const run = () =>
  __durableHandler({ action: 'start', intentId: 'i1', executionId: 'i1' }, ctx, deps);
const openedGates = () => deps.store.createHumanTask.mock.calls.map(([args]) => args);
const gateFor = (stageInstanceId) =>
  openedGates().find((gate) => gate.stageInstanceId === stageInstanceId) ?? null;
const events = () => deps.store.appendEvent.mock.calls.map(([args]) => args);
const eventsOfType = (type) => events().filter((event) => event.type === type);
const receiptsFor = (stageInstanceId) =>
  deps.store.putReceipt.mock.calls
    .map(([args]) => args)
    .filter((receipt) => receipt.stageInstanceId === stageInstanceId);

describe('construction autonomy: a gated or absent grant changes nothing', () => {
  it.each([
    { name: 'no grant recorded at all', mode: undefined },
    { name: 'an explicit gated grant', mode: 'gated' },
    { name: 'a value that is not exactly autonomous', mode: 'Autonomous' },
  ])('$name opens a human gate at every construction stage', async ({ mode }) => {
    execution = mode === undefined ? { ...META } : { ...META, constructionGateAutonomy: mode };
    await run();
    expect(openedGates().map((gate) => gate.stageInstanceId)).toEqual([
      'si-functional-design',
      'si-build-and-test',
    ]);
    expect(eventsOfType('v2.gate.auto_approved')).toEqual([]);
  });

  it('offers grant-autonomy at the first construction gate and nowhere else', async () => {
    execution = { ...META, constructionGateAutonomy: 'gated' };
    await run();
    expect(gateFor('si-functional-design').options).toEqual([
      'approve',
      'request-changes',
      'grant-autonomy',
    ]);
    expect(gateFor('si-build-and-test').options).toEqual(['approve', 'request-changes']);
  });

  it('never offers grant-autonomy without a resolved construction-autonomy policy', async () => {
    execution = { ...META, constructionGateAutonomy: 'gated' };
    deps.loadPlan = vi.fn(async () => ({
      valid: true,
      plan: {
        stages: [
          { ...ANCHOR, policy: { ...POLICY, constructionAutonomy: null } },
          { ...SECOND, policy: { ...POLICY, constructionAutonomy: null } },
        ],
      },
    }));
    await run();
    for (const gate of openedGates()) {
      expect(gate.options).toEqual(['approve', 'request-changes']);
    }
  });
});

describe('construction autonomy: an autonomous grant', () => {
  beforeEach(() => {
    execution = { ...META, constructionGateAutonomy: 'autonomous' };
  });

  it('keeps the first construction gate human and waives the next one', async () => {
    await run();
    expect(openedGates().map((gate) => gate.stageInstanceId)).toEqual(['si-functional-design']);
    const auto = eventsOfType('v2.gate.auto_approved');
    expect(auto).toHaveLength(1);
    expect(auto[0].detail).toMatchObject({ mode: 'autonomous', stageId: 'build-and-test' });
    expect(auto[0].detail.userInput).toBe(
      'Autonomous construction gate per construction protocol module',
    );
  });

  it('writes one real approval receipt carrying the protocol marker', async () => {
    await run();
    const approvals = receiptsFor('si-build-and-test').filter(
      (receipt) => receipt.kind === 'stage-approval',
    );
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ choice: 'approve', attempt: 0, decidedBy: null });
    expect(approvals[0].detail).toMatchObject({
      autonomous: true,
      userInput: 'Autonomous construction gate per construction protocol module',
    });
  });

  it('still emits the ordinary stage-validated event for the waived gate', async () => {
    await run();
    expect(eventsOfType('v2.stage.validated').length).toBeGreaterThanOrEqual(2);
  });

  it.each([
    {
      name: 'a blocking gate sensor',
      verdict: { ok: true, state: 'SUCCEEDED', gateSensorVerdicts: [BLOCKING_SENSOR] },
      codes: ['sensor_gate_blocking'],
    },
    {
      name: 'a terminal adversarial NOT-READY',
      verdict: {
        ok: true,
        state: 'SUCCEEDED',
        reviewAdvisory: { advisory: false, verdict: 'NOT-READY', reviewerAgent: 'arch-reviewer' },
      },
      codes: ['review_not_ready'],
    },
    {
      name: 'an advisory finding',
      verdict: {
        ok: true,
        state: 'SUCCEEDED',
        reviewAdvisory: { advisory: true, verdict: 'NOT-READY', reviewerAgent: 'arch-reviewer' },
      },
      codes: ['review_advisory_findings'],
    },
  ])('halts and asks on $name', async ({ verdict, codes }) => {
    stageVerdicts = (stageId) => (stageId === 'build-and-test' ? verdict : cleanVerdict(stageId));
    await run();
    const gate = gateFor('si-build-and-test');
    expect(gate).not.toBeNull();
    expect(gate.findings.map((finding) => finding.code)).toEqual(codes);
    expect(eventsOfType('v2.gate.auto_approved')).toEqual([]);
  });

  it.each([
    {
      name: 'its produced outputs could not be observed',
      verdict: { ...cleanVerdict('build-and-test'), producedHeadsUnavailable: true },
    },
    {
      name: 'the runner reported no produced outputs at all',
      verdict: { ok: true, state: 'SUCCEEDED' },
    },
  ])('does not waive a gate when $name', async ({ verdict }) => {
    stageVerdicts = (stageId) => (stageId === 'build-and-test' ? verdict : cleanVerdict(stageId));
    await run();
    expect(gateFor('si-build-and-test')).not.toBeNull();
    expect(eventsOfType('v2.gate.auto_approved')).toEqual([]);
  });

  it('does not waive a gate whose adversarial reviewer recorded no verdict', async () => {
    stageVerdicts = (stageId) =>
      stageId === 'build-and-test'
        ? {
            ...cleanVerdict(stageId),
            reviewAdvisory: {
              advisory: false,
              verdict: 'INCONCLUSIVE',
              reviewerAgent: 'arch-reviewer',
              findings: 'arch-reviewer recorded no verdict',
            },
          }
        : cleanVerdict(stageId);
    await run();
    const gate = gateFor('si-build-and-test');
    expect(gate.findings.map((finding) => finding.code)).toEqual(['review_not_ready']);
    expect(gate.options).toEqual(['request-changes', 'override-and-approve']);
    expect(eventsOfType('v2.gate.auto_approved')).toEqual([]);
  });

  it('never waives a Plan Approval stage', async () => {
    deps.loadPlan = vi.fn(async () => ({
      valid: true,
      plan: {
        stages: [ANCHOR, { ...SECOND, policy: { ...POLICY, planApproval: 'required' } }],
      },
    }));
    await run();
    expect(gateFor('si-build-and-test')).not.toBeNull();
    expect(eventsOfType('v2.gate.auto_approved')).toEqual([]);
  });

  it.each([
    { name: 'the run was cancelled', over: { status: 'CANCELLED' } },
    { name: 'another orchestrator took the run over', over: { orchestratorRunId: 'someone-else' } },
    { name: 'the intent was deleted', over: null },
  ])('stops instead of auto-approving once $name', async ({ over }) => {
    // A waived gate opens no gate row, so cancel's `supersedeHumanTask` cannot
    // reach it. This re-read is the only thing that stops the walk.
    let reads = 0;
    deps.store.getExecution = vi.fn(async () => {
      reads += 1;
      if (reads <= 2) return execution;
      return over === null ? null : { ...execution, ...over };
    });
    const out = await run();
    expect(out).toMatchObject({ ok: false, reason: 'retired' });
    expect(eventsOfType('v2.gate.auto_approved')).toEqual([]);
  });

  it('opens the human gate when the autonomy read fails (fail closed)', async () => {
    deps.store.getExecution = vi.fn(async () => ({
      ...execution,
      get constructionGateAutonomy() {
        throw new Error('ddb attribute unreadable');
      },
    }));
    await run();
    expect(gateFor('si-build-and-test')).not.toBeNull();
    expect(eventsOfType('v2.gate.auto_approved')).toEqual([]);
  });

  it('writes the receipt and the event once across a durable replay', async () => {
    // A durable replay re-enters the handler with every completed step's result
    // already recorded, so the side effects inside those steps must not repeat.
    // Only the steps this feature adds are memoized — memoizing the stage
    // dispatch too would leave its callback promise with nobody to resolve it.
    const REPLAYED =
      /^(autonomy-mode-|autonomy-grant-|gate-auto-approved-|stage-approval-receipt-)/;
    const results = new Map();
    const replayCtx = () =>
      makeCtx({
        step: async (name, fn) => {
          if (!REPLAYED.test(name)) return fn();
          if (results.has(name)) return results.get(name);
          const value = await fn();
          results.set(name, value);
          return value;
        },
      });

    ctx = replayCtx();
    await run();
    ctx = replayCtx();
    await run();

    const approvals = receiptsFor('si-build-and-test').filter(
      (receipt) => receipt.kind === 'stage-approval',
    );
    expect(approvals).toHaveLength(1);
    expect(eventsOfType('v2.gate.auto_approved')).toHaveLength(1);
  });
});

describe('construction autonomy: a terminal adversarial NOT-READY at the gate', () => {
  const NOT_READY = {
    advisory: false,
    verdict: 'NOT-READY',
    reviewerAgent: 'arch-reviewer',
    findings: 'the retry budget is still unbounded',
  };
  const notReadyAt = (target) => (stageId) =>
    stageId === target
      ? { ...cleanVerdict(stageId), reviewAdvisory: NOT_READY }
      : cleanVerdict(stageId);

  it('blocks a gate the grant would waive and records the human override', async () => {
    execution = { ...META, constructionGateAutonomy: 'autonomous' };
    stageVerdicts = notReadyAt('build-and-test');
    await run();
    const gate = gateFor('si-build-and-test');
    expect(gate.options).toEqual(['request-changes', 'override-and-approve']);
    expect(gate.findings).toEqual([
      expect.objectContaining({
        code: 'review_not_ready',
        severity: 'blocking',
        overridable: true,
        receiptKind: 'stage-approval',
      }),
    ]);
    const approvals = receiptsFor('si-build-and-test').filter(
      (receipt) => receipt.kind === 'stage-approval',
    );
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ choice: 'override-and-approve', decidedBy: 'u1' });
    expect(approvals[0].detail).toMatchObject({
      findingCodes: ['review_not_ready'],
      reason: 'Accepted for this gate test.',
    });
    expect(approvals[0].detail.autonomous).toBeUndefined();
    expect(eventsOfType('v2.gate.auto_approved')).toEqual([]);
  });

  it.each([
    {
      name: 'on a gated intent',
      mode: 'gated',
      target: 'build-and-test',
      options: ['approve', 'request-changes'],
    },
    {
      name: 'at the anchor gate the grant never waives',
      mode: 'autonomous',
      target: 'functional-design',
      options: ['approve', 'request-changes'],
    },
  ])('stays advisory, with approve on offer, $name', async ({ mode, target, options }) => {
    execution = { ...META, constructionGateAutonomy: mode };
    stageVerdicts = notReadyAt(target);
    await run();
    const gate = gateFor(`si-${target}`);
    expect(gate.options).toEqual(options);
    expect(gate.findings).toEqual([
      expect.objectContaining({ code: 'review_advisory_findings', severity: 'advisory' }),
    ]);
  });
});

describe('construction autonomy: the grant-autonomy escalation', () => {
  beforeEach(() => {
    execution = { ...META, constructionGateAutonomy: 'gated' };
    const seen = new Set();
    deps.store.getHumanTask = vi.fn(async (_executionId, humanTaskId) => {
      if (!seen.has(humanTaskId)) {
        seen.add(humanTaskId);
        return null;
      }
      const opened = deps.store.createHumanTask.mock.calls
        .map(([args]) => args)
        .find((args) => args.humanTaskId === humanTaskId);
      const decision = (opened?.options ?? []).includes('grant-autonomy')
        ? 'grant-autonomy'
        : 'approve';
      return {
        humanTaskId,
        status: 'answered',
        answer: { decision },
        answeredBy: 'u1',
        answeredByName: 'Ada',
      };
    });
  });

  it('records the grant, approves the stage, and waives the next gate', async () => {
    await run();
    expect(deps.store.updateExecution).toHaveBeenCalledWith(
      expect.objectContaining({ constructionGateAutonomy: 'autonomous' }),
    );
    const set = eventsOfType('v2.autonomy.mode_set');
    expect(set).toHaveLength(1);
    expect(set[0].detail).toMatchObject({
      mode: 'autonomous',
      grantedBy: 'u1',
      grantedByName: 'Ada',
      stageId: 'functional-design',
    });
    expect(set[0].detail.grantedAt).toEqual(expect.any(String));
    // Durable attribution on the execution row, not only on the best-effort event.
    expect(deps.store.updateExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        constructionGateAutonomy: 'autonomous',
        constructionGateAutonomyGrant: expect.objectContaining({
          source: 'gate',
          stageId: 'functional-design',
          grantedBy: 'u1',
          grantedByName: 'Ada',
          grantedAt: expect.any(String),
        }),
      }),
    );
    // Only the anchor gate was ever opened; the grant waived the one after it.
    expect(openedGates().map((gate) => gate.stageInstanceId)).toEqual(['si-functional-design']);
    expect(eventsOfType('v2.gate.auto_approved')).toHaveLength(1);
  });
});

describe('construction autonomy: the lane ladder must not confer the sequential grant', () => {
  // Regression guard for a real coupling bug: the per-section unit-lane ladder
  // (section.js) mirrors its own answer onto `META.constructionAutonomyMode`.
  // Reading THAT field for sequential construction gates waived gates the human
  // was only ever asked about for parallel lanes — and would also have disabled
  // recompose for the intent's whole life (intents/index.js:3473, :4774).
  it.each([
    { name: 'an autonomous lane ladder answer', mode: 'autonomous' },
    { name: 'a gated lane ladder answer', mode: 'gated' },
  ])('$name leaves every sequential construction gate human', async ({ mode }) => {
    execution = { ...META, constructionAutonomyMode: mode };
    await run();
    expect(openedGates().map((gate) => gate.stageInstanceId)).toEqual([
      'si-functional-design',
      'si-build-and-test',
    ]);
    expect(eventsOfType('v2.gate.auto_approved')).toEqual([]);
  });

  it('keeps the two fields independent when the sequential grant is given', async () => {
    execution = {
      ...META,
      constructionAutonomyMode: 'gated',
      constructionGateAutonomy: 'autonomous',
    };
    await run();
    expect(openedGates().map((gate) => gate.stageInstanceId)).toEqual(['si-functional-design']);
    expect(eventsOfType('v2.gate.auto_approved')).toHaveLength(1);
    // The lane field was never touched by the sequential walk.
    expect(execution.constructionAutonomyMode).toBe('gated');
  });
});
