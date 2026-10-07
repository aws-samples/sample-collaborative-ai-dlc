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
// The release's loop-back recommender: identified by its authored results output.
const BUILD_AND_TEST = constructionStage('build-and-test', {
  outputArtifacts: [{ artifact: 'build-test-results' }],
  policy: { ...POLICY, loopBack: 'human-offered' },
});

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
let recommendations;
// Every gate row the run wrote, keyed by id, as the store would hold it.
let storedGates;

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
const cleanVerdict = (stageId, artifactType = `${stageId}-out`) => ({
  ok: true,
  state: 'SUCCEEDED',
  producedHeads: [{ artifactType, logicalKey: `${stageId}-k`, snapshotHash: 'sha-1' }],
});

beforeEach(() => {
  ctx = makeCtx();
  stageVerdicts = cleanVerdict;
  execution = { ...META };
  recommendations = new Map();
  storedGates = new Map();
  deps = {
    store: {
      getExecution: vi.fn(async () => execution),
      updateExecution: vi.fn(async (args) => {
        if (args.constructionGateAutonomy !== undefined) {
          execution = { ...execution, constructionGateAutonomy: args.constructionGateAutonomy };
        }
        return {};
      }),
      createHumanTask: vi.fn(async (args) => {
        const row = { ...args, status: 'pending' };
        storedGates.set(args.humanTaskId, row);
        return row;
      }),
      // Same CAS as the real store: only a pending row can be answered.
      answerHumanTask: vi.fn(async ({ humanTaskId, ...answer }) => {
        const row = storedGates.get(humanTaskId);
        if (!row || row.status !== 'pending') return null;
        const answered = { ...row, ...answer };
        storedGates.set(humanTaskId, answered);
        return answered;
      }),
      setGateCallbackId: vi.fn(async () => ({})),
      supersedeHumanTask: vi.fn(async () => ({})),
      getHumanTask: answerWithOfferedOption(),
      appendEvent: vi.fn(async () => ({})),
      putTrackerSync: vi.fn(async (args) => args),
      failRunningStageAttempt: vi.fn(async () => null),
      listUnits: vi.fn(async () => []),
      getUnit: vi.fn(async () => null),
      // Upstream keeps the loop-back recommendation on the STAGE ROW and clears it
      // in its own step after the gate; the offer step itself is read-only.
      getStage: vi.fn(async (_e, stageInstanceId) => ({
        stageInstanceId,
        attempt: 0,
        ...(recommendations.has(stageInstanceId)
          ? { loopBackRecommendation: recommendations.get(stageInstanceId) }
          : {}),
      })),
      setLoopBackRecommendation: vi.fn(async ({ stageInstanceId, reason }) => {
        if (reason) recommendations.set(stageInstanceId, reason);
        else recommendations.delete(stageInstanceId);
      }),
      listReceipts: vi.fn(async () => []),
      listEvents: vi.fn(async () => []),
      putReceipt: vi.fn(async (args) => args),
      // The loop-back cap lives on META and is bumped by the TARGET row's reset,
      // so the fake has to bump it too — otherwise an autonomous run keeps
      // re-taking a jump that is never spent.
      resetStageRow: vi.fn(async (args) => {
        // Matches the real store: `loopBackId` supplies the guards for EITHER row,
        // and `countsAgainstCap` is what spends the bound. The cap counts
        // decisions, not rows, so a double that tallied both resets of one jump
        // would report two.
        if (args.loopBackId && (args.countsAgainstCap ?? true)) {
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

  it('never offers grant-autonomy at a first construction gate with a blocking finding', async () => {
    execution = { ...META, constructionGateAutonomy: 'gated' };
    stageVerdicts = (stageId) =>
      stageId === 'functional-design'
        ? { ...cleanVerdict(stageId), gateSensorVerdicts: [BLOCKING_SENSOR] }
        : cleanVerdict(stageId);
    await run();
    expect(gateFor('si-functional-design').options).toEqual([
      'request-changes',
      'override-and-approve',
    ]);
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

  it('does not waive a gate that has learning candidates to put to the human', async () => {
    deps.loadPlan = vi.fn(async () => ({
      valid: true,
      plan: {
        stages: [ANCHOR, { ...SECOND, policy: { ...POLICY, learnings: 'on' } }],
      },
    }));
    deps.store.listEvents = vi.fn(async () => [
      {
        type: 'v2.learning.candidate',
        stageInstanceId: 'si-build-and-test',
        summary: 'retry the flaky integration suite once before failing',
      },
    ]);
    await run();
    expect(gateFor('si-build-and-test')).toMatchObject({ learningsRitual: true });
    expect(eventsOfType('v2.gate.auto_approved')).toEqual([]);
  });

  it.each([
    {
      // An offered loop-back is taken autonomously instead (see the loop-back
      // tests below); only the recommendations it cannot act on open the gate.
      name: 'a loop-back recommendation at the cap',
      stages: () => [
        ANCHOR,
        constructionStage('code-generation', {
          outputArtifacts: [{ artifact: 'code-generation-plan' }],
        }),
        BUILD_AND_TEST,
      ],
      loopBackCount: 3,
      options: ['approve', 'request-changes'],
      status: 'at-cap',
    },
    {
      name: 'a loop-back recommendation with no code generation to go back to',
      stages: () => [ANCHOR, BUILD_AND_TEST],
      loopBackCount: 0,
      options: ['approve', 'request-changes'],
      status: 'unavailable',
    },
  ])('opens the human gate on $name', async ({ stages, loopBackCount, options, status }) => {
    execution = { ...execution, loopBackCount };
    // The agent's "this code must be revised" is not a finding, so without this
    // rule the gate would be waived and the recommendation cleared unseen.
    deps.loadPlan = vi.fn(async () => ({ valid: true, plan: { stages: stages() } }));
    const declared = {
      'code-generation': 'code-generation-plan',
      'build-and-test': 'build-test-results',
    };
    stageVerdicts = (stageId) => ({
      ...cleanVerdict(stageId),
      producedHeads: [
        {
          artifactType: declared[stageId] ?? `${stageId}-out`,
          logicalKey: `${stageId}-k`,
          snapshotHash: 'sha-1',
        },
      ],
    });
    const recommendations = new Map([
      [
        'si-build-and-test',
        'unit tests fail in the payment module; the generated code must be revised',
      ],
    ]);
    deps.store.getStage = vi.fn(async (_e, stageInstanceId) => ({
      stageInstanceId,
      attempt: 0,
      ...(recommendations.has(stageInstanceId)
        ? { loopBackRecommendation: recommendations.get(stageInstanceId) }
        : {}),
    }));
    deps.store.setLoopBackRecommendation = vi.fn(async ({ stageInstanceId, reason }) => {
      if (reason === null) recommendations.delete(stageInstanceId);
      return {};
    });
    await run();
    const gate = gateFor('si-build-and-test');
    expect(gate).not.toBeNull();
    expect(gate.options).toEqual(options);
    expect(gate).toMatchObject({
      loopBackReason: 'unit tests fail in the payment module; the generated code must be revised',
      loopBackStatus: status,
    });
    expect(
      eventsOfType('v2.gate.auto_approved').map((event) => event.detail.stageId),
    ).not.toContain('build-and-test');
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
    // A waived gate opens no gate row, so the parked-gate ownership test never
    // runs for it. This re-read is what stops the walk.
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
    // The run-start snapshot reads the grant; every read at a gate fails.
    let reads = 0;
    deps.store.getExecution = vi.fn(async () => ({
      ...execution,
      get constructionGateAutonomy() {
        reads += 1;
        if (reads === 1) return 'autonomous';
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
    // A slow row write, so a second clock read after it would differ.
    const write = deps.store.updateExecution.getMockImplementation();
    deps.store.updateExecution = vi.fn(async (args) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return write(args);
    });
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
    // One grant, one timestamp: the event repeats what the row recorded.
    const recorded = deps.store.updateExecution.mock.calls
      .map(([args]) => args.constructionGateAutonomyGrant)
      .find(Boolean);
    expect(set[0].detail.grantedAt).toBe(recorded.grantedAt);
    // Only the anchor gate was ever opened; the grant waived the one after it.
    expect(openedGates().map((gate) => gate.stageInstanceId)).toEqual(['si-functional-design']);
    expect(eventsOfType('v2.gate.auto_approved')).toHaveLength(1);
  });

  it('writes no grant when the intent is cancelled between the answer and the resume', async () => {
    // Cancel is accepted while META still reads WAITING, after the answer was
    // recorded. It ends the run (`completedAt`) and finds no grant to withdraw.
    const answer = deps.store.getHumanTask;
    deps.store.getHumanTask = vi.fn(async (...args) => {
      const gate = await answer(...args);
      if (gate?.answer?.decision === 'grant-autonomy') {
        execution = { ...execution, status: 'CANCELLED', completedAt: 'T-cancel' };
      }
      return gate;
    });
    const write = deps.store.updateExecution.getMockImplementation();
    deps.store.updateExecution = vi.fn(async (args) => {
      if (args.ifNotCompleted && execution.completedAt) {
        throw Object.assign(new Error('conditional'), { name: 'ConditionalCheckFailedException' });
      }
      return write(args);
    });

    const result = await run();

    expect(result).toMatchObject({ ok: false, reason: 'retired' });
    expect(execution.constructionGateAutonomy).toBe('gated');
    expect(eventsOfType('v2.autonomy.mode_set')).toEqual([]);
    expect(
      receiptsFor('si-functional-design').filter((receipt) => receipt.kind === 'stage-approval'),
    ).toEqual([]);
  });

  it('writes no grant for a grant-autonomy answer on a gate that did not offer it', async () => {
    // The answer endpoint refuses this answer; a row carrying it anyway parses to
    // nothing against the gate's options and takes the ordinary fallback.
    deps.store.getHumanTask = answerWithOfferedOption((options) =>
      options.includes('grant-autonomy') ? 'approve' : 'grant-autonomy',
    );
    await run();
    expect(
      deps.store.updateExecution.mock.calls.filter(
        ([args]) => args.constructionGateAutonomy !== undefined,
      ),
    ).toEqual([]);
    expect(eventsOfType('v2.autonomy.mode_set')).toEqual([]);
  });

  it('records the grant and its event once across a durable replay', async () => {
    // Same memoization as the create-time replay test: only the steps this
    // feature adds replay their recorded result.
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

    const grants = deps.store.updateExecution.mock.calls.filter(
      ([args]) => args.constructionGateAutonomy !== undefined,
    );
    expect(grants).toHaveLength(1);
    expect(grants[0][0]).toMatchObject({ constructionGateAutonomy: 'autonomous' });
    expect(eventsOfType('v2.autonomy.mode_set')).toHaveLength(1);
    expect(eventsOfType('v2.gate.auto_approved')).toHaveLength(1);
    expect(
      receiptsFor('si-functional-design').filter((receipt) => receipt.kind === 'stage-approval'),
    ).toHaveLength(1);
  });
});

describe('construction autonomy: the grant read is a durable step only where a grant can apply', () => {
  const INCEPTION = constructionStage('requirements-analysis', { phase: 'inception' });
  const stepNames = [];
  const autonomyReads = () => stepNames.filter((name) => name.startsWith('autonomy-mode-'));

  beforeEach(() => {
    stepNames.length = 0;
    ctx = makeCtx({
      step: async (name, fn) => {
        stepNames.push(name);
        return fn();
      },
    });
    deps.loadPlan = vi.fn(async () => ({
      valid: true,
      plan: { stages: [INCEPTION, ANCHOR, SECOND] },
    }));
  });

  it('records no autonomy read on an intent that has no grant', async () => {
    execution = { ...META, constructionGateAutonomy: 'gated' };
    await run();
    expect(autonomyReads()).toEqual([]);
    expect(gateFor('si-functional-design').options).toContain('grant-autonomy');
  });

  it('reads the grant at construction gates only on an intent granted at create', async () => {
    execution = { ...META, constructionGateAutonomy: 'autonomous' };
    await run();
    expect(autonomyReads()).toEqual([
      'autonomy-mode-si-functional-design-0',
      'autonomy-mode-si-build-and-test-0',
    ]);
    expect(eventsOfType('v2.gate.auto_approved')).toHaveLength(1);
  });

  it('starts reading the grant after a grant-autonomy answer in the same run', async () => {
    execution = { ...META, constructionGateAutonomy: 'gated' };
    deps.store.getHumanTask = answerWithOfferedOption((options) =>
      options.includes('grant-autonomy') ? 'grant-autonomy' : null,
    );
    await run();
    expect(autonomyReads()).toEqual(['autonomy-mode-si-build-and-test-0']);
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

describe('construction autonomy: the build-and-test loop-back', () => {
  // `build-test-results` is the authored output that declares which stage may
  // recommend the jump, so the fixture carries it for the same reason a real plan
  // does: the offer is withheld from any stage that does not author it.
  const LOOPBACK_PLAN = () => ({
    valid: true,
    plan: {
      stages: [
        ANCHOR,
        constructionStage('code-generation', {
          outputArtifacts: [{ artifact: 'code-generation-plan' }],
        }),
        constructionStage('build-and-test', {
          outputArtifacts: [{ artifact: 'build-test-results' }],
          policy: { ...POLICY, loopBack: 'human-offered' },
        }),
      ],
    },
  });

  // Each stage reports the output its plan entry declares, so the gate checks
  // real, observed outputs.
  const DECLARED = {
    'functional-design': 'functional-design-out',
    'code-generation': 'code-generation-plan',
    'build-and-test': 'build-test-results',
  };
  const observed = (stageId, extra = {}) => ({
    ...cleanVerdict(stageId, DECLARED[stageId]),
    ...extra,
  });

  beforeEach(() => {
    execution = { ...META, constructionGateAutonomy: 'autonomous', loopBackCount: 0 };
    deps.loadPlan = vi.fn(async () => LOOPBACK_PLAN());
    stageVerdicts = (stageId) => observed(stageId);
    // The agent recorded a recommendation on build-and-test's row. The engine
    // clears it in its own step after the gate, so it is offered exactly once —
    // which is also what keeps this fixture from looping to the cap.
    recommendations.set('si-build-and-test', 'three suites fail');
  });

  it('takes the jump itself, with the protocol marker as the recorded answer', async () => {
    await run();
    const recorded = eventsOfType('v2.loopback.recorded');
    expect(recorded).toHaveLength(1);
    expect(recorded[0].summary).toContain(
      'Autonomous loop-back 1 per construction protocol module',
    );
    expect(execution.loopBackCount).toBe(1);
    // The jump was taken without parking on build-and-test's gate: its row was
    // written already answered, and no callback ever waited on it.
    const row = storedGates.get(gateFor('si-build-and-test').humanTaskId);
    expect(row.status).toBe('rejected');
    expect(deps.store.setGateCallbackId).not.toHaveBeenCalledWith(
      expect.objectContaining({ humanTaskId: row.humanTaskId }),
    );
  });

  const dispatchedResumes = () =>
    deps.invokeRuntime.mock.calls
      .map(([payload]) => payload)
      .filter((payload) => payload.command === 'run-stage-start' && payload.resumeFrom)
      .map((payload) => [payload.stageId, payload.resumeFrom]);
  const runIdOf = (call = 0) =>
    deps.store.updateExecution.mock.calls.map(([args]) => args.orchestratorRunId).filter(Boolean)[
      call
    ];

  // The container re-reads the gate it resumes from. A jump whose gate exists
  // only in the orchestrator's memory fails the target's re-run with
  // gate_not_found, and loses the archive and the reason that hang off the row.
  // A recorded recommendation keeps a waivable gate from being approved. The
  // jump is the one answer to it that does not open a human gate, and it is
  // never an approval: build-and-test is approved only on the re-run, which has
  // no recommendation left.
  it('answers the recommendation with the jump, never with an approval', async () => {
    await run();
    const [first] = openedGates().filter((gate) => gate.stageInstanceId === 'si-build-and-test');
    expect(first.options).toEqual(['loop-back']);
    expect(storedGates.get(first.humanTaskId)).toMatchObject({
      status: 'rejected',
      answer: { decision: 'loop-back' },
    });
    const types = events().map((event) => event.type);
    const jumped = types.indexOf('v2.loopback.recorded');
    const approved = events().findIndex(
      (event) =>
        event.type === 'v2.gate.auto_approved' && event.detail?.stageId === 'build-and-test',
    );
    expect(jumped).toBeGreaterThanOrEqual(0);
    expect(approved).toBeGreaterThan(jumped);
  });

  it('names a stored, answered gate row in every resumeFrom it dispatches', async () => {
    await run();
    const resumes = dispatchedResumes();
    expect(resumes.map(([stageId]) => stageId)).toEqual(['code-generation']);
    for (const [, resumeFrom] of resumes) {
      expect(storedGates.get(resumeFrom)).toMatchObject({
        stageInstanceId: 'si-build-and-test',
        kind: 'validation',
        status: 'rejected',
        answer: {
          decision: 'loop-back',
          userInput: 'Autonomous loop-back 1 per construction protocol module',
        },
        answeredBy: null,
        loopBackTarget: 'code-generation',
        loopBackReason: 'three suites fail',
      });
    }
  });

  it('retires instead of jumping when a cancel superseded the row first', async () => {
    const create = deps.store.createHumanTask.getMockImplementation();
    deps.store.createHumanTask = vi.fn(async (args) => {
      const row = await create(args);
      if (args.options?.length === 1 && args.options[0] === 'loop-back') {
        storedGates.set(args.humanTaskId, { ...row, status: 'superseded' });
      }
      return row;
    });
    deps.store.getHumanTask = vi.fn(async (_e, id) => storedGates.get(id) ?? null);
    const out = await run();
    expect(out).toMatchObject({ ok: false, reason: 'retired' });
    expect(deps.store.resetStageRow).not.toHaveBeenCalled();
  });

  // Run-scoped like every engine gate id, so a relaunch that reaches the same
  // stage and round takes a NEW decision: both rows reset again and the cap is
  // spent again, instead of the store reading the earlier jump as already done.
  it('takes a distinct, run-scoped decision on a relaunch', async () => {
    await run();
    const [, first] = dispatchedResumes()[0];
    recommendations.set('si-build-and-test', 'three suites fail');
    deps.invokeRuntime.mockClear();
    ctx = makeCtx();
    await run();
    const [, second] = dispatchedResumes()[0];
    expect(first).toContain(runIdOf(0));
    expect(second).toContain(runIdOf(1));
    expect(second).not.toBe(first);
    expect(execution.loopBackCount).toBe(2);
  });

  it.each([
    {
      name: 'a blocking gate sensor',
      verdict: { gateSensorVerdicts: [BLOCKING_SENSOR] },
      code: 'sensor_gate_blocking',
    },
    {
      name: 'an INCONCLUSIVE blocking sensor',
      verdict: { gateSensorVerdicts: [{ ...BLOCKING_SENSOR, result: 'INCONCLUSIVE' }] },
      code: 'sensor_gate_blocking',
    },
    {
      name: 'a terminal adversarial NOT-READY',
      verdict: {
        reviewAdvisory: { advisory: false, verdict: 'NOT-READY', reviewerAgent: 'arch-reviewer' },
      },
      code: 'review_not_ready',
    },
  ])(
    'refuses to auto-rewind on $name and opens the human gate instead',
    async ({ verdict, code }) => {
      // The jump answers failing tests, never a blocking finding: rewinding here
      // would discard the finding and silently re-run the work.
      stageVerdicts = (stageId) => observed(stageId, stageId === 'build-and-test' ? verdict : {});
      await run();
      expect(deps.store.resetStageRow).not.toHaveBeenCalled();
      const gate = gateFor('si-build-and-test');
      expect(gate).not.toBeNull();
      expect(gate.findings.map((item) => item.code)).toContain(code);
      expect(eventsOfType('v2.loopback.recorded')).toEqual([]);
      // code-generation is legitimately waived; build-and-test must NOT be.
      expect(
        eventsOfType('v2.gate.auto_approved').map((event) => event.detail.stageId),
      ).not.toContain('build-and-test');
    },
  );

  it('still takes the jump when only ADVISORY findings accompany the failure', async () => {
    stageVerdicts = (stageId) =>
      observed(
        stageId,
        stageId === 'build-and-test'
          ? { reviewAdvisory: { advisory: true, verdict: 'NOT-READY', reviewerAgent: 'r' } }
          : {},
      );
    await run();
    // The jump is taken on the advisory evidence. (The later re-run then parks on
    // its own gate, because `autoApprove` needs ZERO findings — advisory included.)
    expect(eventsOfType('v2.loopback.recorded')).toHaveLength(1);
    expect(deps.store.resetStageRow).toHaveBeenCalled();
    expect(eventsOfType('v2.loopback.recorded')[0].summary).toContain(
      'Autonomous loop-back 1 per construction protocol module',
    );
  });

  it('halts at the cap instead of approving', async () => {
    execution = { ...execution, loopBackCount: 3 };
    await run();
    expect(deps.store.resetStageRow).not.toHaveBeenCalled();
    const gate = gateFor('si-build-and-test');
    expect(gate).not.toBeNull();
    expect(
      eventsOfType('v2.gate.auto_approved').map((event) => event.detail.stageId),
    ).not.toContain('build-and-test');
  });

  // The autonomous path shares ONE offer resolution with the gated path, so the
  // recommender rule holds here too: a stage that does not author
  // `build-test-results` is not the stage the release lets recommend the jump, and
  // no autonomy grant may promote its position in the plan into a jump.
  it('refuses the autonomous jump from a stage the release never declared', async () => {
    deps.loadPlan = vi.fn(async () => ({
      valid: true,
      plan: {
        stages: [
          ANCHOR,
          constructionStage('code-generation', {
            outputArtifacts: [{ artifact: 'code-generation-plan' }],
          }),
          constructionStage('build-and-test', {
            outputArtifacts: [{ artifact: 'build-and-test-out' }],
            policy: { ...POLICY, loopBack: 'human-offered' },
          }),
        ],
      },
    }));
    stageVerdicts = (stageId) =>
      stageId === 'build-and-test' ? cleanVerdict(stageId) : observed(stageId);

    await run();

    expect(eventsOfType('v2.loopback.recorded')).toEqual([]);
    expect(deps.store.resetStageRow).not.toHaveBeenCalled();
    expect(Number(execution.loopBackCount ?? 0)).toBe(0);
  });

  // A waived jump invalidates the same two rows under the same guards a human
  // decision uses, and names the target it resolved. Both resets carry the one
  // decision id; only the target's spends the bound, because the cap counts
  // decisions rather than rows.
  it('resets both rows with the guards a human jump uses, and tallies once', async () => {
    await run();

    const [[recommender], [target]] = deps.store.resetStageRow.mock.calls;
    expect(recommender).toMatchObject({
      stageInstanceId: 'si-build-and-test',
      countsAgainstCap: false,
    });
    expect(recommender.loopBackId).toMatch(/^eg-validation-si-build-and-test-/);
    expect(target).toMatchObject({
      stageInstanceId: 'si-code-generation',
      loopBackId: recommender.loopBackId,
    });
    expect(target.countsAgainstCap ?? true).toBe(true);
    expect(deps.store.resetStageRow).toHaveBeenCalledTimes(2);
    expect(Number(execution.loopBackCount ?? 0)).toBe(1);
  });
});
