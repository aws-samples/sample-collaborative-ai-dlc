// Gate preconditions at the validation gate: the findings
// channel into the gate prompt, the third `override-and-approve` option, and the
// receipt + audit event an override writes.
//
// The first test is the byte-identity guarantee: a stage with no resolved release
// policy opens the plain validation gate — the same prompt text and the same two
// options as a gate without findings.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@aws-lambda-powertools/logger';
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
  learnings: 'on',
  skeleton: null,
});

const GATED_STAGE = {
  stageId: 'requirements-analysis',
  stageInstanceId: 'si-1',
  humanValidation: 'required',
  outputArtifacts: [{ artifact: 'requirements' }],
};

const BLOCKING_SENSOR = {
  sensorId: 'claim-sources',
  result: 'FAIL',
  severity: 'blocking',
  detail: { artifact: 'requirements.md', reason: 'unsourced claim' },
};

let deps;
let ctx;
let invokes;
let stageVerdict;

const makeRuntime = () => {
  return vi.fn(async (payload) => {
    if (payload.command === 'create-workflow-checkpoint') return { ok: true, checkpointId: 'cp' };
    invokes.push(payload);
    if (payload.command === 'init-ws') return { ok: true };
    if (payload.command === 'run-stage-start') {
      const resolve = ctx.stageCallbackResolvers.get(payload.stageCallbackId);
      resolve(stageVerdict());
      return { ok: true, accepted: true, stageId: payload.stageId };
    }
    return { ok: true };
  });
};

// The gate is opened (gate-pre sees nothing) and then read back answered, which
// is what makes createHumanTask observable.
const answeredGate = (answer) => {
  const gate = {
    humanTaskId: 'eg-validation-si-1-0-run1',
    status: answer?.decision === 'request-changes' ? 'rejected' : 'answered',
    answer,
    answeredBy: 'u1',
    answeredByName: 'Ada',
    stageInstanceId: 'si-1',
  };
  let call = 0;
  return vi.fn(async () => {
    call += 1;
    return call === 1 ? null : gate;
  });
};

beforeEach(() => {
  invokes = [];
  ctx = makeCtx();
  stageVerdict = () => ({ ok: true, state: 'SUCCEEDED' });
  deps = {
    store: {
      getExecution: vi.fn(async () => META),
      updateExecution: vi.fn(async () => ({})),
      createHumanTask: vi.fn(async (args) => ({ ...args, status: 'pending' })),
      setGateCallbackId: vi.fn(async () => ({})),
      supersedeHumanTask: vi.fn(async () => ({})),
      getHumanTask: answeredGate({ decision: 'approve' }),
      appendEvent: vi.fn(async () => ({})),
      putTrackerSync: vi.fn(async (args) => args),
      failRunningStageAttempt: vi.fn(async () => null),
      listUnits: vi.fn(async () => []),
      getUnit: vi.fn(async () => null),
      getStage: vi.fn(async () => ({ stageInstanceId: 'si-1', attempt: 0 })),
      listReceipts: vi.fn(async () => []),
      listEvents: vi.fn(async () => []),
      putReceipt: vi.fn(async (args) => args),
    },
    loadPlan: vi.fn(async () => ({ valid: true, plan: { stages: [GATED_STAGE] } })),
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
const openedGate = () => deps.store.createHumanTask.mock.calls.at(-1)[0];
const eventTypes = () => deps.store.appendEvent.mock.calls.map(([args]) => args.type);

describe('validation gate without a resolved release policy', () => {
  it('opens the byte-identical gate it opened before findings existed', async () => {
    await run();
    const gate = openedGate();
    expect(gate.options).toEqual(['approve', 'request-changes']);
    expect(gate.prompt).toBe(
      [
        'Review stage requirements-analysis.',
        '',
        'Produced artifacts: requirements.',
        '',
        'This is the final stage — choose approve to complete the workflow, or request-changes with feedback to send this stage back to the agent.',
      ].join('\n'),
    );
    expect(gate).not.toHaveProperty('findings');
    // No policy ⇒ the evaluator is never consulted, so no receipt/event read.
    expect(deps.store.listReceipts).not.toHaveBeenCalled();
    expect(deps.store.getStage).not.toHaveBeenCalled();
  });

  it('stays byte-identical even when the stage result carries sensor verdicts', async () => {
    stageVerdict = () => ({ ok: true, state: 'SUCCEEDED', gateSensorVerdicts: [BLOCKING_SENSOR] });
    await run();
    expect(openedGate().options).toEqual(['approve', 'request-changes']);
    expect(openedGate().prompt).not.toContain('Findings');
  });
});

describe('validation gate with findings', () => {
  beforeEach(() => {
    deps.loadPlan = vi.fn(async () => ({
      valid: true,
      plan: { stages: [{ ...GATED_STAGE, policy: POLICY }] },
    }));
  });

  it('renders advisory findings without changing the option list', async () => {
    stageVerdict = () => ({
      ok: true,
      state: 'SUCCEEDED',
      reviewAdvisory: { advisory: true, verdict: 'NOT-READY', reviewerAgent: 'arch-reviewer' },
    });
    await run();
    const gate = openedGate();
    expect(gate.options).toEqual(['approve', 'request-changes']);
    expect(gate.prompt).toContain('## Findings for your decision');
    expect(gate.prompt).toContain('⚠️ Advisory review (arch-reviewer): NOT-READY');
    expect(gate.findings).toHaveLength(1);
    expect(gate.findings[0].code).toBe('review_advisory_findings');
  });

  it('keeps a terminal adversarial NOT-READY advisory at a human gate', async () => {
    stageVerdict = () => ({
      ok: true,
      state: 'SUCCEEDED',
      reviewAdvisory: {
        advisory: false,
        verdict: 'NOT-READY',
        reviewerAgent: 'arch-reviewer',
        findings: 'the retry budget is still unbounded',
      },
    });
    await run();
    const gate = openedGate();
    // This intent never granted construction autonomy, so the pre-autonomy
    // contract holds: the verdict is surfaced, `approve` is still offered.
    expect(gate.options).toEqual(['approve', 'request-changes']);
    expect(gate.prompt).toContain('## Findings for your decision');
    expect(gate.findings).toHaveLength(1);
    expect(gate.findings[0]).toMatchObject({
      code: 'review_advisory_findings',
      severity: 'advisory',
      overridable: false,
    });
  });

  it('offers override-and-approve INSTEAD of plain approve for an overridable block', async () => {
    stageVerdict = () => ({ ok: true, state: 'SUCCEEDED', gateSensorVerdicts: [BLOCKING_SENSOR] });
    deps.store.getHumanTask = answeredGate({
      decision: 'override-and-approve',
      reason: 'Accepted for this gate test.',
    });
    await run();
    const gate = openedGate();
    // Plain `approve` is withheld: an approval that silently waived a
    // blocking finding would leave no record of what was accepted.
    expect(gate.options).toEqual(['request-changes', 'override-and-approve']);
    expect(gate.prompt).toContain('⛔ BLOCKING — Sensor claim-sources (gate) → FAIL');
    expect(gate.prompt).toContain('Choose override-and-approve to accept 1 blocking finding(s)');
  });

  it('offers ONLY request-changes when the block cannot be overridden', async () => {
    // The gate answer is a revision, so the stage re-runs; the second attempt is
    // clean and approves, which is how the run escapes without a stuck state.
    let round = 0;
    deps.store.getHumanTask = vi.fn(async () => {
      round += 1;
      if (round === 1) return null;
      if (round === 2) {
        return { humanTaskId: 'h1', status: 'rejected', answer: { decision: 'request-changes' } };
      }
      if (round === 3) return null;
      return { humanTaskId: 'h2', status: 'answered', answer: { decision: 'approve' } };
    });
    let attempt = 0;
    stageVerdict = () => {
      attempt += 1;
      return attempt === 1
        ? {
            ok: true,
            state: 'SUCCEEDED',
            findings: [
              {
                code: 'required_artifact_missing',
                severity: 'blocking',
                title: 'Required output "requirements" was not produced',
                detail: { artifact: 'requirements' },
                overridable: false,
                receiptKind: null,
                remediation: 'Send the stage back.',
              },
            ],
          }
        : { ok: true, state: 'SUCCEEDED' };
    };

    const res = await run();
    const firstGate = deps.store.createHumanTask.mock.calls[0][0];
    expect(firstGate.options).toEqual(['request-changes']);
    expect(firstGate.prompt).toContain('A blocking finding cannot be overridden here');
    // The revision re-ran the stage and the second gate approved: no stuck run.
    expect(res.ok).toBe(true);
    expect(invokes.filter((p) => p.command === 'run-stage-start')).toHaveLength(2);
  });

  it('writes a receipt and an audit event for an override, then proceeds as approve', async () => {
    stageVerdict = () => ({ ok: true, state: 'SUCCEEDED', gateSensorVerdicts: [BLOCKING_SENSOR] });
    deps.store.getHumanTask = answeredGate({
      decision: 'override-and-approve',
      reason: 'Accepted for this gate test.',
    });

    const res = await run();
    expect(res.ok).toBe(true);
    expect(deps.store.putReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        executionId: 'i1',
        kind: 'sensor-override',
        stageInstanceId: 'si-1',
        attempt: 0,
        choice: 'override-and-approve',
        decidedBy: 'u1',
        decidedByName: 'Ada',
        // Upstream's blocking-sensor audit row (§2.6): the sensors, their results
        // and their reasons, named on the receipt and on the event.
        detail: expect.objectContaining({
          findingCodes: ['sensor_gate_blocking'],
          blockingSensorOverride: true,
          sensorIds: ['claim-sources'],
        }),
      }),
    );
    const override = deps.store.appendEvent.mock.calls
      .map(([args]) => args)
      .find((args) => args.type === 'v2.gate.override');
    expect(override).toMatchObject({
      stageInstanceId: 'si-1',
      detail: {
        findingCodes: ['sensor_gate_blocking'],
        receiptKind: 'sensor-override',
        blockingSensorOverride: true,
        sensorIds: ['claim-sources'],
      },
    });
    expect(override.summary).toContain('Ada');
    // Overriding IS approving: the stage is validated and the run continues.
    expect(eventTypes()).toContain('v2.stage.validated');
  });

  it("keeps a SCRIPT sensor's per-file reason on the override audit row", async () => {
    // A script sensor reports once per matching file, so its reason lives inside
    // `detail.files[]`. Reading only the top level recorded `reason: null` — an
    // audit row that cannot say what the human waved through.
    stageVerdict = () => ({
      ok: true,
      state: 'SUCCEEDED',
      gateSensorVerdicts: [
        {
          sensorId: 'linter',
          result: 'FAIL',
          severity: 'blocking',
          detail: {
            files: [
              { file: 'src/ok.ts', result: 'PASS', detail: { pass: true } },
              { file: 'src/app.ts', result: 'FAIL', detail: { pass: false, reason: '2 problems' } },
            ],
          },
        },
      ],
    });
    deps.store.getHumanTask = answeredGate({
      decision: 'override-and-approve',
      reason: 'Accepted for this gate test.',
    });

    expect((await run()).ok).toBe(true);
    const override = deps.store.appendEvent.mock.calls
      .map(([args]) => args)
      .find((args) => args.type === 'v2.gate.override');
    expect(override.detail.sensors).toEqual([
      { sensorId: 'linter', result: 'FAIL', reason: 'src/app.ts: 2 problems' },
    ]);
  });

  it('records the reason of the file that failed, not of one that timed out silently', async () => {
    stageVerdict = () => ({
      ok: true,
      state: 'SUCCEEDED',
      gateSensorVerdicts: [
        {
          sensorId: 'linter',
          result: 'FAIL',
          severity: 'blocking',
          detail: {
            files: [
              { file: 'src/a.ts', result: 'INCONCLUSIVE', timedOut: true, detail: null },
              { file: 'src/b.ts', result: 'FAIL', timedOut: false, detail: { reason: '2 errors' } },
            ],
          },
        },
      ],
    });
    deps.store.getHumanTask = answeredGate({
      decision: 'override-and-approve',
      reason: 'Accepted for this gate test.',
    });

    expect((await run()).ok).toBe(true);
    const override = deps.store.appendEvent.mock.calls
      .map(([args]) => args)
      .find((args) => args.type === 'v2.gate.override');
    expect(override.detail.sensors).toEqual([
      { sensorId: 'linter', result: 'FAIL', reason: 'src/b.ts: 2 errors' },
    ]);
  });

  it('records the override reason on every receipt and on the audit event', async () => {
    stageVerdict = () => ({ ok: true, state: 'SUCCEEDED', gateSensorVerdicts: [BLOCKING_SENSOR] });
    deps.store.getHumanTask = answeredGate({
      decision: 'override-and-approve',
      reason: `  The claim is sourced in the linked ADR.${' x'.repeat(200)}`,
    });
    await run();
    const [receipt] = deps.store.putReceipt.mock.calls.map(([args]) => args);
    expect(receipt.detail.reason).toMatch(/^The claim is sourced in the linked ADR\./);
    expect(receipt.detail.reason).toHaveLength(300);
    const override = deps.store.appendEvent.mock.calls
      .map(([args]) => args)
      .find((args) => args.type === 'v2.gate.override');
    expect(override.detail.reason).toBe(receipt.detail.reason);
  });

  it('re-runs instead of approving a legacy override answer without a reason', async () => {
    let attempt = 0;
    stageVerdict = () => {
      attempt += 1;
      return attempt === 1
        ? { ok: true, state: 'SUCCEEDED', gateSensorVerdicts: [BLOCKING_SENSOR] }
        : { ok: true, state: 'SUCCEEDED' };
    };
    deps.store.getHumanTask = answeredGate({ decision: 'override-and-approve', reason: '   ' });

    const res = await run();
    expect(res.ok).toBe(true);
    expect(invokes.filter((payload) => payload.command === 'run-stage-start')).toHaveLength(2);
    expect(
      deps.store.putReceipt.mock.calls.filter(
        ([receipt]) => receipt.choice === 'override-and-approve' && receipt.attempt === 0,
      ),
    ).toHaveLength(0);
    expect(eventTypes()).toContain('v2.stage.revision_requested');
    expect(deps.store.createHumanTask.mock.calls[0][0].options).toEqual([
      'request-changes',
      'override-and-approve',
    ]);
  });

  it('re-reads the receipts at the gate instead of trusting the stage result', async () => {
    stageVerdict = () => ({ ok: true, state: 'SUCCEEDED', gateSensorVerdicts: [BLOCKING_SENSOR] });
    deps.store.getStage = vi.fn(async () => ({ stageInstanceId: 'si-1', attempt: 3 }));
    deps.store.listReceipts = vi.fn(async () => [
      {
        sk: 'RECEIPT#sensor-override#si-1#3#-',
        kind: 'sensor-override',
        attempt: 3,
        detail: { sensorIds: ['claim-sources'] },
      },
    ]);

    await run();
    expect(deps.store.listReceipts).toHaveBeenCalledWith('i1', {
      stageInstanceId: 'si-1',
      attempt: 3,
      consistentRead: true,
    });
    expect(deps.store.getStage).toHaveBeenCalledWith('i1', 'si-1', { consistentRead: true });
    // The durable override already on the record clears the block, so the gate
    // opens clean — proving the verdict comes from re-read state.
    expect(openedGate().options).toEqual(['approve', 'request-changes']);
    expect(openedGate()).not.toHaveProperty('findings');
  });

  it('never degrades an unparseable answer on a blocked gate into an approval', async () => {
    // The human's client sent `approved` with an answer the engine cannot parse.
    // The gate never offered `approve`, so the only safe reading is the re-run —
    // the second attempt is clean and approves, which is how the run escapes.
    stageVerdict = (() => {
      let attempt = 0;
      return () => {
        attempt += 1;
        return attempt === 1
          ? { ok: true, state: 'SUCCEEDED', gateSensorVerdicts: [BLOCKING_SENSOR] }
          : { ok: true, state: 'SUCCEEDED' };
      };
    })();
    let call = 0;
    deps.store.getHumanTask = vi.fn(async () => {
      call += 1;
      if (call === 1) return null;
      if (call === 2) {
        return {
          humanTaskId: 'h1',
          status: 'approved',
          answer: { decision: 'yes-go-ahead' },
          stageInstanceId: 'si-1',
        };
      }
      if (call === 3) return null;
      return { humanTaskId: 'h2', status: 'answered', answer: { decision: 'approve' } };
    });

    const res = await run();
    expect(res.ok).toBe(true);
    expect(deps.store.createHumanTask.mock.calls[0][0].options).toEqual([
      'request-changes',
      'override-and-approve',
    ]);
    // The blocked gate re-ran the stage; it did NOT write an override receipt or
    // validate the stage on that first, uninterpretable answer.
    expect(invokes.filter((p) => p.command === 'run-stage-start')).toHaveLength(2);
    expect(
      deps.store.putReceipt.mock.calls.filter(
        ([args]) => args.choice === 'override-and-approve' && args.attempt === 0,
      ),
    ).toHaveLength(0);
  });

  it('writes ONE override receipt PER receipt kind for a mixed override', async () => {
    // A summary waiver (`stage-approval`) AND a sensor override (`sensor-override`)
    // on the same gate. Collapsing them into one row lost the sensor receipt, and
    // `sensorGateFindings` reads exactly that row to stop re-blocking the gate.
    stageVerdict = () => ({
      ok: true,
      state: 'SUCCEEDED',
      gateSensorVerdicts: [BLOCKING_SENSOR],
    });
    deps.loadPlan = vi.fn(async () => ({
      valid: true,
      plan: {
        stages: [{ ...GATED_STAGE, policy: { ...POLICY, summaryConfirmation: 'required' } }],
      },
    }));
    deps.store.getHumanTask = answeredGate({
      decision: 'override-and-approve',
      reason: 'Accepted for this gate test.',
    });
    stageVerdict = () => ({
      ok: true,
      state: 'SUCCEEDED',
      gateSensorVerdicts: [BLOCKING_SENSOR],
      producedHeads: [{ logicalKey: 'k1', snapshotHash: 'sha-1' }],
    });
    const persistedReceipts = new Map();
    deps.store.putReceipt = vi.fn(async (receipt) => {
      const key = [
        receipt.executionId,
        receipt.kind,
        receipt.stageInstanceId,
        receipt.attempt,
        receipt.unitSlug ?? '-',
      ].join('|');
      if (!persistedReceipts.has(key)) persistedReceipts.set(key, receipt);
      return persistedReceipts.get(key);
    });

    await run();
    const storedReceipts = [...persistedReceipts.values()];
    expect(storedReceipts.map((r) => r.kind).toSorted()).toEqual([
      'sensor-override',
      'stage-approval',
    ]);
    const stageApproval = storedReceipts.find((r) => r.kind === 'stage-approval');
    expect(stageApproval).toMatchObject({
      choice: 'override-and-approve',
      detail: {
        reason: 'Accepted for this gate test.',
        approvedInputs: [{ logicalKey: 'k1', snapshotHash: 'sha-1' }],
      },
    });
    expect(stageApproval.detail.findingCodes).toContain('summary_confirmation_missing');
    const sensorReceipt = storedReceipts.find((r) => r.kind === 'sensor-override');
    expect(sensorReceipt.detail).toMatchObject({
      findingCodes: ['sensor_gate_blocking'],
      blockingSensorOverride: true,
      sensorIds: ['claim-sources'],
    });
    // The audit row names WHAT was overridden, not just that something was: the
    // sensor's own reason has to survive onto it (upstream §2.6).
    expect(sensorReceipt.detail.sensors).toEqual([
      { sensorId: 'claim-sources', result: 'FAIL', reason: 'unsourced claim' },
    ]);
    const override = deps.store.appendEvent.mock.calls
      .map(([args]) => args)
      .find((args) => args.type === 'v2.gate.override');
    expect(override.detail.receiptKinds.toSorted()).toEqual(['sensor-override', 'stage-approval']);
  });

  it('bounds oversized approval fingerprints below DynamoDB item limits and marks them incomplete', async () => {
    stageVerdict = () => ({
      ok: true,
      state: 'SUCCEEDED',
      producedHeads: Array.from({ length: 5_000 }, (_, index) => ({
        artifactType: 'requirements',
        logicalKey: `intent::requirements::artifact-${index.toString().padStart(6, '0')}`,
        snapshotHash: index.toString(16).padStart(64, '0'),
      })),
    });
    const persistedReceipts = [];
    deps.store.putReceipt = vi.fn(async (receipt) => {
      if (Buffer.byteLength(JSON.stringify(receipt), 'utf8') > 400 * 1024) {
        throw new Error('DynamoDB item exceeds the 400 KB limit');
      }
      persistedReceipts.push(receipt);
      return receipt;
    });

    const result = await run();

    expect(result.ok).toBe(true);
    const receipt = persistedReceipts.find((row) => row.kind === 'stage-approval');
    expect(receipt.detail.approvedInputsTruncated).toBe(true);
    expect(receipt.detail.approvedInputsOmitted).toBeGreaterThan(0);
    expect(receipt.detail.approvedInputs.length).toBeLessThan(5_000);
    expect(receipt.detail.approvedInputs[0]).toEqual({
      logicalKey: 'intent::requirements::artifact-000000',
      snapshotHash: '0'.repeat(64),
    });
    expect(Object.keys(receipt.detail.approvedInputs[0]).toSorted()).toEqual([
      'logicalKey',
      'snapshotHash',
    ]);
    expect(Buffer.byteLength(JSON.stringify(receipt), 'utf8')).toBeLessThanOrEqual(400 * 1024);
  });

  it('fails the durable approval step when the stage-approval receipt cannot be stored', async () => {
    deps.loadPlan = vi.fn(async () => ({
      valid: true,
      plan: { stages: [{ ...GATED_STAGE, policy: POLICY }] },
    }));
    deps.store.putReceipt = vi.fn(async () => {
      throw new Error('receipt storage unavailable');
    });

    const result = await run();
    expect(result.ok).toBe(false);
    expect(eventTypes()).toContain('v2.execution.failed');
  });

  it.each([
    ['stage', 'getStage'],
    ['receipt', 'listReceipts'],
    ['event', 'listEvents'],
  ])('retries gate evaluation when the %s evidence read fails', async (_label, method) => {
    deps.loadPlan = vi.fn(async () => ({
      valid: true,
      plan: { stages: [{ ...GATED_STAGE, policy: POLICY }] },
    }));
    deps.store[method] = vi.fn(async () => {
      throw new Error(`${method} unavailable`);
    });

    const result = await run();
    expect(result.ok).toBe(false);
    expect(deps.store.createHumanTask).not.toHaveBeenCalled();
  });

  it('quotes maintained dissent verbatim in the prompt and on the finding', async () => {
    stageVerdict = () => ({
      ok: true,
      state: 'SUCCEEDED',
      ensembleEvidence: {
        dissent: [
          {
            agentRef: 'aidlc-quality-agent',
            class: 'knowledge',
            position: 'OBJECT: the retry budget ignores the 429 path',
          },
        ],
      },
    });
    await run();
    const gate = openedGate();
    const dissent = gate.findings.find((f) => f.code === 'review_dissent_maintained');
    expect(dissent.quote).toBe('OBJECT: the retry budget ignores the 429 path');
    expect(gate.prompt).toContain('    > OBJECT: the retry budget ignores the 429 path');
  });

  it('reports a declared output the stage never produced, and stays inert without the observation', async () => {
    // First attempt produced the WRONG artifact type; the human sends it back and
    // the second attempt produces the declared one, so the run still completes.
    let attempt = 0;
    stageVerdict = () => {
      attempt += 1;
      return {
        ok: true,
        state: 'SUCCEEDED',
        producedHeads: [
          {
            artifactType: attempt === 1 ? 'something-else' : 'requirements',
            logicalKey: 'k',
            snapshotHash: 'h',
          },
        ],
      };
    };
    let call = 0;
    deps.store.getHumanTask = vi.fn(async () => {
      call += 1;
      if (call === 1) return null;
      if (call === 2) {
        return { humanTaskId: 'h1', status: 'rejected', answer: { decision: 'request-changes' } };
      }
      if (call === 3) return null;
      return { humanTaskId: 'h2', status: 'answered', answer: { decision: 'approve' } };
    });

    const res = await run();
    expect(res.ok).toBe(true);
    const firstGate = deps.store.createHumanTask.mock.calls[0][0];
    const missing = firstGate.findings.find((f) => f.code === 'required_artifact_missing');
    expect(missing).toMatchObject({
      severity: 'blocking',
      overridable: true,
      receiptKind: 'stage-approval',
      detail: { artifact: 'requirements' },
    });
    // Three-outcome rule: the human may override on the record, never only revise.
    expect(firstGate.options).toContain('override-and-approve');
    expect(firstGate.options).toContain('request-changes');
    expect(firstGate.options).not.toContain('approve');
    // The second attempt produced it: that gate is clean.
    expect(deps.store.createHumanTask.mock.calls.at(-1)[0]).not.toHaveProperty('findings');
  });

  it('never reports a missing output when the graph read produced no observation', async () => {
    stageVerdict = () => ({ ok: true, state: 'SUCCEEDED' });
    await run();
    expect(openedGate()).not.toHaveProperty('findings');
    expect(openedGate().options).toEqual(['approve', 'request-changes']);
  });

  it('scopes the re-read to THIS stage instance and this attempt', async () => {
    stageVerdict = () => ({ ok: true, state: 'SUCCEEDED', gateSensorVerdicts: [BLOCKING_SENSOR] });
    deps.store.getHumanTask = answeredGate({
      decision: 'override-and-approve',
      reason: 'Accepted for this gate test.',
    });
    deps.store.listEvents = vi.fn(async () => [
      { eventType: 'v2.question.asked', stageInstanceId: 'si-OTHER' },
    ]);
    await run();
    expect(deps.store.listEvents).toHaveBeenCalledWith('i1', { consistentRead: true });
    // The other instance's question must not turn on this stage's checks.
    expect(openedGate().findings.map((f) => f.code)).toEqual(['sensor_gate_blocking']);
  });
});

// A pinned sensor script that is missing or failed its digest check was never
// executed, so its verdict is not an ordinary advisory one: the gate must not
// offer approval over it, and must not offer an override even when another
// blocking finding on the same gate is overridable.
describe('validation gate with a release-integrity failure', () => {
  const INTEGRITY_VERDICT = {
    sensorId: 'linter',
    severity: 'advisory',
    result: 'BLOCKED',
    held: true,
    detail: {
      error: 'release script digest mismatch',
      code: 'release_closure_mismatch',
      releaseIntegrityFailure: true,
    },
  };

  const sendBackThenApprove = () => {
    let call = 0;
    deps.store.getHumanTask = vi.fn(async () => {
      call += 1;
      if (call === 1) return null;
      if (call === 2) {
        return { humanTaskId: 'h1', status: 'rejected', answer: { decision: 'request-changes' } };
      }
      if (call === 3) return null;
      return { humanTaskId: 'h2', status: 'answered', answer: { decision: 'approve' } };
    });
  };

  beforeEach(() => {
    deps.loadPlan = vi.fn(async () => ({
      valid: true,
      plan: { stages: [{ ...GATED_STAGE, policy: POLICY }] },
    }));
  });

  it('offers request-changes alone for an advisory sensor that could not be verified', async () => {
    let attempt = 0;
    stageVerdict = () => {
      attempt += 1;
      return attempt === 1
        ? { ok: true, state: 'SUCCEEDED', gateSensorVerdicts: [INTEGRITY_VERDICT] }
        : { ok: true, state: 'SUCCEEDED' };
    };
    sendBackThenApprove();

    const res = await run();

    const firstGate = deps.store.createHumanTask.mock.calls[0][0];
    expect(firstGate.options).toEqual(['request-changes']);
    expect(firstGate.findings.map((finding) => finding.code)).toEqual(['sensor_gate_blocking']);
    expect(firstGate.findings[0]).toMatchObject({
      overridable: false,
      detail: { releaseIntegrityFailure: true },
    });
    expect(firstGate.prompt).toContain('A blocking finding cannot be overridden here');
    // The re-run is clean, so the run still escapes: no stuck state.
    expect(res.ok).toBe(true);
    expect(
      deps.store.putReceipt.mock.calls.filter(
        ([receipt]) => receipt.choice === 'override-and-approve',
      ),
    ).toHaveLength(0);
  });

  it('withholds override-and-approve when mixed with an overridable block', async () => {
    let attempt = 0;
    stageVerdict = () => {
      attempt += 1;
      return attempt === 1
        ? {
            ok: true,
            state: 'SUCCEEDED',
            gateSensorVerdicts: [BLOCKING_SENSOR, INTEGRITY_VERDICT],
          }
        : { ok: true, state: 'SUCCEEDED' };
    };
    sendBackThenApprove();

    await run();

    const firstGate = deps.store.createHumanTask.mock.calls[0][0];
    expect(firstGate.options).toEqual(['request-changes']);
    expect(firstGate.findings.filter((finding) => finding.overridable)).toHaveLength(1);
    expect(firstGate.findings).toHaveLength(2);
  });

  it('keeps the gate byte-identical for an unpinned run', async () => {
    deps.loadPlan = vi.fn(async () => ({ valid: true, plan: { stages: [GATED_STAGE] } }));
    stageVerdict = () => ({
      ok: true,
      state: 'SUCCEEDED',
      gateSensorVerdicts: [INTEGRITY_VERDICT],
    });

    await run();

    expect(openedGate().options).toEqual(['approve', 'request-changes']);
    expect(openedGate()).not.toHaveProperty('findings');
  });
});

describe('operator logging at the gate', () => {
  it('logs each finding code, severity and the stage when a gate opens with findings', async () => {
    const info = vi.spyOn(Logger.prototype, 'info');
    deps.loadPlan = vi.fn(async () => ({
      valid: true,
      plan: { stages: [{ ...GATED_STAGE, policy: POLICY }] },
    }));
    stageVerdict = () => ({ ok: true, state: 'SUCCEEDED', gateSensorVerdicts: [BLOCKING_SENSOR] });
    deps.store.getHumanTask = answeredGate({
      decision: 'override-and-approve',
      reason: 'Accepted for this gate test.',
    });
    await run();
    const call = info.mock.calls.find(([message]) => message === 'gate opened with findings');
    expect(call?.[1]).toMatchObject({
      executionId: 'i1',
      stageId: 'requirements-analysis',
      findings: [{ code: 'sensor_gate_blocking', severity: 'blocking', overridable: true }],
    });
    info.mockRestore();
  });

  it('logs nothing for a gate with no findings', async () => {
    const info = vi.spyOn(Logger.prototype, 'info');
    await run();
    expect(info.mock.calls.some(([message]) => message === 'gate opened with findings')).toBe(
      false,
    );
    info.mockRestore();
  });
});

describe('checkpoint receipts across validation revisions', () => {
  it('asks for a new confirmation after the human requests changes', async () => {
    const stage = {
      ...GATED_STAGE,
      policy: { ...POLICY, summaryConfirmation: 'required' },
    };
    deps.loadPlan = vi.fn(async () => ({ valid: true, plan: { stages: [stage] } }));
    deps.store.listReceipts = vi.fn(async () => [
      {
        sk: 'RECEIPT#summary-confirmation#si-1#0#-',
        kind: 'summary-confirmation',
        stageInstanceId: 'si-1',
        attempt: 0,
        ordinal: null,
        decidedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    deps.store.listEvents = vi.fn(async () => [
      {
        eventType: 'v2.artifact.stamped',
        stageInstanceId: 'si-1',
        timestamp: '2026-01-01T00:00:05.000Z',
        detail: {
          artifactType: 'requirements',
          authorizationId: 'RECEIPT#summary-confirmation#si-1#0#-',
        },
      },
    ]);
    const seen = new Map();
    deps.store.getHumanTask = vi.fn(async (_executionId, humanTaskId) => {
      const calls = (seen.get(humanTaskId) ?? 0) + 1;
      seen.set(humanTaskId, calls);
      if (calls === 1) return null;
      const revision = humanTaskId.includes('-si-1-0-') ? 0 : 1;
      return {
        humanTaskId,
        status: revision === 0 ? 'rejected' : 'answered',
        answer:
          revision === 0
            ? { decision: 'request-changes', feedback: 'tighten the scope' }
            : { decision: 'override-and-approve', reason: 'Accepted for this test.' },
        answeredBy: 'u1',
        answeredByName: 'Ada',
        stageInstanceId: 'si-1',
      };
    });

    await run();

    const dispatches = invokes.filter((payload) => payload.command === 'run-stage-start');
    expect(dispatches[0]).not.toHaveProperty('validationRound');
    expect(dispatches[1]).toMatchObject({ validationRound: 1 });
    const gates = deps.store.createHumanTask.mock.calls.map(([gate]) => gate);
    expect(gates[0].findings ?? []).toEqual([]);
    expect(gates[1].findings.map((finding) => finding.code)).toEqual([
      'summary_confirmation_missing',
    ]);
  });
});

describe('validation gate durable history without a resolved release policy', () => {
  it('records no gate-precondition step', async () => {
    const names = [];
    const step = ctx.step;
    ctx.step = async (name, fn) => {
      names.push(name);
      return step(name, fn);
    };

    await run();

    expect(names.some((name) => name.startsWith('gate-preconditions-'))).toBe(false);
  });
});

describe('gate un-park', () => {
  it('clears any resume marker once the answer reaches the run', async () => {
    await run();

    const unparks = deps.store.updateExecution.mock.calls
      .map(([args]) => args)
      .filter((args) => args.status === 'RUNNING' && args.pendingHumanTaskId === null);
    expect(unparks.length).toBeGreaterThan(0);
    for (const unpark of unparks) expect(unpark).toHaveProperty('resumeRequired', null);
  });
});

describe('override audit writes', () => {
  const overrideAnswered = () => {
    stageVerdict = () => ({ ok: true, state: 'SUCCEEDED', gateSensorVerdicts: [BLOCKING_SENSOR] });
    deps.store.getHumanTask = answeredGate({
      decision: 'override-and-approve',
      reason: 'Accepted for this test.',
    });
    deps.loadPlan = vi.fn(async () => ({
      valid: true,
      plan: { stages: [{ ...GATED_STAGE, policy: POLICY }] },
    }));
  };

  it('retries the override step instead of filing the receipt under attempt 0', async () => {
    overrideAnswered();
    let reads = 0;
    deps.store.getStage = vi.fn(async () => {
      reads += 1;
      if (reads === 2) throw new Error('read failed');
      return { stageInstanceId: 'si-1', attempt: 2 };
    });
    const step = ctx.step;
    ctx.step = async (name, fn) => {
      try {
        return await step(name, fn);
      } catch (error) {
        if (!name.startsWith('gate-override-')) throw error;
        return step(name, fn);
      }
    };

    await run();

    const overrides = deps.store.putReceipt.mock.calls
      .map(([receipt]) => receipt)
      .filter((receipt) => receipt.kind === 'sensor-override');
    expect(overrides.map((receipt) => receipt.attempt)).toEqual([2]);
  });

  it('does not approve the stage when the override audit row cannot be written', async () => {
    overrideAnswered();
    deps.store.putReceipt = vi.fn(async (receipt) => {
      if (receipt.kind === 'sensor-override') throw new Error('receipt store unavailable');
      return receipt;
    });

    await run();

    expect(eventTypes()).not.toContain('v2.stage.validated');
  });
});

// What a stage approval COVERS. The container's `producedHeads` is an intent-wide
// observation; the human at this gate reviewed only the artifacts this stage
// produced, and the receipt must say exactly that — otherwise approving stage B
// records stage A's edited design as approved and the next consumer of that design
// never asks about the change.
describe('stage-approval receipt scope', () => {
  const STAGE_A_HEAD = {
    artifactType: 'application-design',
    logicalKey: 'i1::application-design::si-A',
    snapshotHash: 'sha-design-edited',
    stageInstanceId: 'si-A',
    sectionIndex: null,
    unitSlug: null,
  };
  const STAGE_B_HEAD = {
    artifactType: 'requirements',
    logicalKey: 'i1::requirements::si-1',
    snapshotHash: 'sha-requirements',
    stageInstanceId: 'si-1',
    sectionIndex: 2,
    unitSlug: 'lane/one',
  };

  beforeEach(() => {
    deps.loadPlan = vi.fn(async () => ({
      valid: true,
      plan: { stages: [{ ...GATED_STAGE, policy: POLICY }] },
    }));
    stageVerdict = () => ({
      ok: true,
      state: 'SUCCEEDED',
      producedHeads: [STAGE_A_HEAD, STAGE_B_HEAD],
    });
  });

  it('records only the artifacts this stage produced, with their attribution', async () => {
    await run();

    const receipt = deps.store.putReceipt.mock.calls
      .map(([args]) => args)
      .find((args) => args.kind === 'stage-approval');
    expect(receipt.detail.approvedInputs).toEqual([
      { logicalKey: STAGE_B_HEAD.logicalKey, snapshotHash: STAGE_B_HEAD.snapshotHash },
    ]);
    expect(receipt.detail.approvedInputsScope).toEqual({
      stageInstanceId: 'si-1',
      sectionIndex: 2,
      unitSlug: 'lane/one',
    });
    expect(receipt.detail.observedInputsOutOfScope).toBe(1);
  });

  // The provenance stamp writes '' for a dimension the scope did not have, and an
  // older row carries no property at all. Both mean "not recorded", so both stay in
  // scope: an unattributed artifact cannot be proven to belong to another stage.
  it.each([
    ['an absent producer', {}],
    ['an empty producer stamp', { stageInstanceId: '', sectionIndex: '', unitSlug: '' }],
  ])('still records a head with %s', async (_label, attribution) => {
    stageVerdict = () => ({
      ok: true,
      state: 'SUCCEEDED',
      producedHeads: [
        {
          artifactType: 'requirements',
          logicalKey: 'k-legacy',
          snapshotHash: 'sha-legacy',
          ...attribution,
        },
      ],
    });

    await run();

    const receipt = deps.store.putReceipt.mock.calls
      .map(([args]) => args)
      .find((args) => args.kind === 'stage-approval');
    expect(receipt.detail.approvedInputs).toEqual([
      { logicalKey: 'k-legacy', snapshotHash: 'sha-legacy' },
    ]);
    expect(receipt.detail).not.toHaveProperty('observedInputsOutOfScope');
  });

  it('still reports a required output the intent-wide observation never saw', async () => {
    // The required-output check reads the whole observation, not the approval
    // scope: narrowing the receipt must not narrow what the gate checks.
    let attempt = 0;
    stageVerdict = () => {
      attempt += 1;
      return {
        ok: true,
        state: 'SUCCEEDED',
        producedHeads: attempt === 1 ? [STAGE_A_HEAD] : [STAGE_A_HEAD, STAGE_B_HEAD],
      };
    };
    let call = 0;
    deps.store.getHumanTask = vi.fn(async () => {
      call += 1;
      if (call === 1) return null;
      if (call === 2) {
        return { humanTaskId: 'h1', status: 'rejected', answer: { decision: 'request-changes' } };
      }
      if (call === 3) return null;
      return { humanTaskId: 'h2', status: 'answered', answer: { decision: 'approve' } };
    });

    const res = await run();

    expect(res.ok).toBe(true);
    const firstGate = deps.store.createHumanTask.mock.calls[0][0];
    expect(firstGate.findings.map((finding) => finding.code)).toEqual([
      'required_artifact_missing',
    ]);
    // The second attempt produced it, so that gate is clean and the approval
    // covers only this stage's head.
    const receipt = deps.store.putReceipt.mock.calls
      .map(([args]) => args)
      .find((args) => args.kind === 'stage-approval');
    expect(receipt.detail.approvedInputs).toEqual([
      { logicalKey: STAGE_B_HEAD.logicalKey, snapshotHash: STAGE_B_HEAD.snapshotHash },
    ]);
  });
});

// The orchestrator's half of the same distinction: an EMPTY observation is the
// evidence that a required output is missing, while an unavailable one is not an
// observation at all and must stay inert.
describe('gate evaluation of an empty produced-head observation', () => {
  const sendBackThenProduce = () => {
    let call = 0;
    deps.store.getHumanTask = vi.fn(async () => {
      call += 1;
      if (call === 1) return null;
      if (call === 2) {
        return { humanTaskId: 'h1', status: 'rejected', answer: { decision: 'request-changes' } };
      }
      if (call === 3) return null;
      return { humanTaskId: 'h2', status: 'answered', answer: { decision: 'approve' } };
    });
  };

  beforeEach(() => {
    deps.loadPlan = vi.fn(async () => ({
      valid: true,
      plan: { stages: [{ ...GATED_STAGE, policy: POLICY }] },
    }));
  });

  it('reports required_artifact_missing when the stage produced nothing', async () => {
    let attempt = 0;
    stageVerdict = () => {
      attempt += 1;
      return {
        ok: true,
        state: 'SUCCEEDED',
        producedHeads:
          attempt === 1
            ? []
            : [{ artifactType: 'requirements', logicalKey: 'k1', snapshotHash: 'sha-1' }],
      };
    };
    sendBackThenProduce();

    const res = await run();

    expect(res.ok).toBe(true);
    const firstGate = deps.store.createHumanTask.mock.calls[0][0];
    expect(firstGate.findings.map((finding) => finding.code)).toEqual([
      'required_artifact_missing',
    ]);
    expect(firstGate.options).not.toContain('approve');
    expect(firstGate.options).toContain('override-and-approve');
    // The second attempt produced it, so that gate is clean.
    expect(deps.store.createHumanTask.mock.calls.at(-1)[0]).not.toHaveProperty('findings');
  });

  it('stays inert when the observation was unavailable', async () => {
    stageVerdict = () => ({ ok: true, state: 'SUCCEEDED', producedHeadsUnavailable: true });

    await run();

    expect(openedGate()).not.toHaveProperty('findings');
    expect(openedGate().options).toEqual(['approve', 'request-changes']);
  });
});
