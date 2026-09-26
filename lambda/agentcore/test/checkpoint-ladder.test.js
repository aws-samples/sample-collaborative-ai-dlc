// The checkpoint completion ladder — the rung
// order that turns a missing authorization into exactly one of three outcomes:
// proceed, a human gate carrying an overridable blocking finding, or a
// rewind-eligible failure. Never a hang.
//
// These tests drive `runCheckpointLadder` directly with a fake store, because the
// rung order and the bound on the repair turn are the contract; the CLI re-entry
// is injected.

import { describe, it, expect } from 'vitest';
import { __test } from '../commands/run-stage.js';

const { runCheckpointLadder, formatResumeAnswer } = __test;

const POLICY = Object.freeze({
  sensorsEnabled: true,
  reviewClass: 'adversarial',
  reviewArtifact: null,
  summaryConfirmation: 'required',
  changeControl: null,
  learnings: 'on',
  skeleton: null,
  planApproval: null,
});

const STAGE = Object.freeze({
  stageId: 'business-logic',
  stageInstanceId: 'si-1',
  humanValidation: 'required',
  outputArtifacts: [{ artifact: 'business-logic-model' }],
});

// Only the store surface the ladder touches. `attempt` and the repair counters
// live on the STAGE# row exactly as they do in DynamoDB, so the persisted-bound
// rule is exercised rather than assumed.
const fakeStore = ({
  attempt = 0,
  receipts = [],
  events = [],
  counters = {},
  stageInstanceId = 'si-1',
} = {}) => ({
  events: [...events],
  receipts: [...receipts],
  counters: { ...counters },
  appended: [],
  async getStage() {
    return { attempt, stageInstanceId, ...this.counters };
  },
  async listReceipts(_executionId, { attempt: want } = {}) {
    return this.receipts.filter((row) => want == null || Number(row.attempt) === Number(want));
  },
  async listEvents() {
    return this.events;
  },
  async appendEvent(event) {
    this.appended.push(event);
    this.events.push({ ...event, eventType: event.type, timestamp: '2026-09-24T12:00:00.000Z' });
    return { ...event, eventId: `e${this.appended.length}` };
  },
  async bumpStageCounter({ field }) {
    this.counters[field] = Number(this.counters[field] ?? 0) + 1;
    return this.counters[field];
  },
});

const ladder = (store, overrides = {}) =>
  runCheckpointLadder({
    store,
    executionId: 'exec-1',
    stageInstanceId: 'si-1',
    unitSlug: null,
    sectionIndex: null,
    stage: STAGE,
    policy: POLICY,
    stageLabel: 'Business Logic',
    logger: { warn() {}, error() {} },
    ...overrides,
  });

const confirmationReceipt = (over = {}) => ({
  kind: 'summary-confirmation',
  sk: 'RECEIPT#summary-confirmation#si-1#0#-',
  stageInstanceId: 'si-1',
  attempt: 0,
  decidedAt: '2026-09-24T10:00:00.000Z',
  ...over,
});

const stamp = (over = {}) => ({
  eventType: 'v2.artifact.stamped',
  stageInstanceId: 'si-1',
  timestamp: '2026-09-24T11:00:00.000Z',
  detail: {
    artifactType: 'business-logic-model',
    authorizationId: 'RECEIPT#summary-confirmation#si-1#0#-',
    ...over,
  },
});

const types = (store) => store.appended.map((event) => event.type);

describe('the ladder is inert where it must be', () => {
  it('does nothing at all without a resolved release policy', async () => {
    const store = fakeStore();
    expect(await ladder(store, { policy: null })).toEqual({ findings: [] });
    expect(store.appended).toHaveLength(0);
  });

  it('proceeds when the confirmation exists and the outputs were saved after it', async () => {
    const store = fakeStore({ receipts: [confirmationReceipt()], events: [stamp()] });

    expect(await ladder(store)).toEqual({ findings: [] });
    expect(store.appended).toHaveLength(0);
  });

  it('is a no-op for if-present when the stage asked no question', async () => {
    const store = fakeStore();

    const result = await ladder(store, {
      policy: { ...POLICY, summaryConfirmation: 'if-present' },
    });

    expect(result).toEqual({ findings: [] });
    expect(store.appended).toHaveLength(0);
  });

  it('engages for if-present once the stage actually asked a question', async () => {
    const store = fakeStore({
      events: [{ eventType: 'v2.question.asked', stageInstanceId: 'si-1', attempt: 0 }],
    });

    const result = await ladder(store, {
      policy: { ...POLICY, summaryConfirmation: 'if-present' },
    });

    expect(result.findings.map((finding) => finding.code)).toEqual([
      'summary_confirmation_missing',
    ]);
  });
});

describe('checkpoint repair when the agent never calls confirm_summary', () => {
  it('spends exactly one repair turn, then carries a blocking overridable finding', async () => {
    const store = fakeStore();
    const messages = [];

    const result = await ladder(store, { runRepairTurn: async (m) => messages.push(m) });

    expect(messages).toHaveLength(1);
    expect(store.counters.summaryRepairAttempts).toBe(1);
    // The message must name the tool and the re-save, or the one turn is wasted.
    expect(messages[0]).toContain('confirm_summary');
    expect(messages[0]).toContain('Re-save EVERY required output artifact');
    expect(result.failure).toBeUndefined();
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      code: 'summary_confirmation_missing',
      severity: 'blocking',
      overridable: true,
      receiptKind: 'stage-approval',
    });
    expect(types(store)).toEqual(['v2.checkpoint.repair_requested', 'v2.summary.noncompliant']);
  });

  it('never spends a second repair turn once the persisted counter is set', async () => {
    const store = fakeStore({ counters: { summaryRepairAttempts: 1 } });
    const messages = [];

    const result = await ladder(store, { runRepairTurn: async (m) => messages.push(m) });

    // An in-memory counter would have reset on this re-invocation and looped.
    expect(messages).toHaveLength(0);
    expect(result.findings.map((finding) => finding.code)).toEqual([
      'summary_confirmation_missing',
    ]);
    expect(types(store)).toEqual(['v2.summary.noncompliant']);
  });

  it('clears the finding when the repair turn actually fixes it', async () => {
    const store = fakeStore();

    const result = await ladder(store, {
      runRepairTurn: async () => {
        store.receipts.push(confirmationReceipt());
        store.events.push(stamp());
      },
    });

    expect(result).toEqual({ findings: [] });
    expect(types(store)).toEqual(['v2.checkpoint.repair_requested']);
  });

  it('fails with a rewind-eligible code when the stage has no human gate', async () => {
    const store = fakeStore();

    const result = await ladder(store, {
      stage: { ...STAGE, humanValidation: 'none' },
      runRepairTurn: async () => {},
    });

    expect(result.findings).toBeUndefined();
    expect(result.failure).toEqual({
      code: 'summary_confirmation_missing',
      detail: 'The consolidated confirmation checkpoint was never answered',
    });
  });

  it('still reaches the gate when the repair turn itself throws', async () => {
    const store = fakeStore();

    const result = await ladder(store, {
      runRepairTurn: async () => {
        throw new Error('cli exploded');
      },
    });

    // A crashed repair must not become a hang or an unhandled rejection.
    expect(result.findings.map((finding) => finding.code)).toEqual([
      'summary_confirmation_missing',
    ]);
  });

  it('skips the repair rung when no resumable session exists', async () => {
    const store = fakeStore();

    const result = await ladder(store, { runRepairTurn: null });

    expect(store.counters.summaryRepairAttempts).toBeUndefined();
    expect(types(store)).toEqual(['v2.summary.noncompliant']);
    expect(result.findings.map((finding) => finding.code)).toEqual([
      'summary_confirmation_missing',
    ]);
  });
});

describe('stale checkpoint authorization — a write stamped with a superseded authorization', () => {
  it('treats an output saved under a stale authorization as non-compliant', async () => {
    // The active confirmation has a different authorization from the one on the
    // only recorded write.
    const store = fakeStore({
      receipts: [confirmationReceipt({ sk: 'RECEIPT#summary-confirmation#si-1#0#-retry' })],
      events: [stamp({ authorizationId: 'RECEIPT#summary-confirmation#si-1#0#-' })],
    });

    const result = await ladder(store, { runRepairTurn: async () => {} });

    expect(result.findings.map((finding) => finding.code)).toEqual(['summary_confirmation_stale']);
    expect(result.findings[0]).toMatchObject({ severity: 'blocking', overridable: true });
    expect(result.findings[0].detail.artifacts).toEqual(['business-logic-model']);
  });

  it('treats an output saved BEFORE the confirmation as non-compliant', async () => {
    const store = fakeStore({
      receipts: [confirmationReceipt({ decidedAt: '2026-09-24T12:00:00.000Z' })],
      events: [stamp({})],
    });

    const result = await ladder(store, { runRepairTurn: async () => {} });

    expect(result.findings.map((finding) => finding.code)).toEqual(['summary_confirmation_stale']);
  });

  it('treats an output with NO recorded write as non-compliant', async () => {
    // Absence of evidence is non-compliance, not a pass — otherwise an agent that
    // simply never stamped would clear the checkpoint.
    const store = fakeStore({ receipts: [confirmationReceipt()], events: [] });

    const result = await ladder(store, { runRepairTurn: async () => {} });

    expect(result.findings.map((finding) => finding.code)).toEqual(['summary_confirmation_stale']);
  });
});

describe('plan approval rides the same ladder on commit lineage', () => {
  const PLAN_POLICY = { ...POLICY, summaryConfirmation: 'none', planApproval: 'required' };
  const planReceipt = (over = {}) => ({
    kind: 'plan-approval',
    sk: 'RECEIPT#plan-approval#si-1#0#-',
    stageInstanceId: 'si-1',
    attempt: 0,
    decidedAt: '2026-09-24T10:00:00.000Z',
    ...over,
  });
  const commit = (timestamp) => ({
    eventType: 'v2.git.pushed',
    stageInstanceId: 'si-1',
    timestamp,
  });

  it('proceeds when the commit came after the approval', async () => {
    const store = fakeStore({
      receipts: [planReceipt()],
      events: [commit('2026-09-24T11:00:00.000Z')],
    });

    expect(await ladder(store, { policy: PLAN_POLICY })).toEqual({ findings: [] });
  });

  it('proceeds on the approval alone when the stage committed nothing', async () => {
    // No commit means no code was written, so there is nothing unauthorized.
    const store = fakeStore({ receipts: [planReceipt()], events: [] });

    expect(await ladder(store, { policy: PLAN_POLICY })).toEqual({ findings: [] });
  });

  it('rejects a commit that predates the approval, through the same rungs', async () => {
    const store = fakeStore({
      receipts: [planReceipt({ decidedAt: '2026-09-24T12:00:00.000Z' })],
      events: [commit('2026-09-24T11:00:00.000Z')],
    });
    const messages = [];

    const result = await ladder(store, {
      policy: PLAN_POLICY,
      runRepairTurn: async (m) => messages.push(m),
    });

    expect(messages[0]).toContain('request_plan_approval');
    expect(store.counters.planApprovalRepairAttempts).toBe(1);
    expect(result.findings.map((finding) => finding.code)).toEqual(['plan_approval_missing']);
    expect(types(store)).toEqual(['v2.checkpoint.repair_requested', 'v2.plan.noncompliant']);
  });

  it('reports a missing approval and fails a gateless stage', async () => {
    const store = fakeStore();

    const result = await ladder(store, {
      policy: PLAN_POLICY,
      stage: { ...STAGE, humanValidation: 'none' },
    });

    expect(result.failure.code).toBe('plan_approval_missing');
  });

  it('bounds the summary and plan repair turns independently', async () => {
    const store = fakeStore({ counters: { summaryRepairAttempts: 1 } });
    const messages = [];

    await ladder(store, {
      policy: { ...POLICY, planApproval: 'required' },
      runRepairTurn: async (m) => messages.push(m),
    });

    // The summary counter is spent, so no repair is granted even though the plan
    // finding is new — one re-entry per attempt, not one per finding.
    expect(messages).toHaveLength(0);
  });
});

describe('a prior attempt cannot authorize this one', () => {
  it('ignores receipts and stamps from an earlier attempt after a rewind', async () => {
    const store = fakeStore({
      attempt: 1,
      receipts: [confirmationReceipt({ attempt: 0 })],
      events: [stamp()],
    });

    const result = await ladder(store, { runRepairTurn: async () => {} });

    expect(result.findings.map((finding) => finding.code)).toEqual([
      'summary_confirmation_missing',
    ]);
    expect(store.appended.at(-1).detail).toMatchObject({ attempt: 1 });
  });
});

describe('a parked checkpoint is delivered to the agent as a decision, not a Q&A', () => {
  const gate = (checkpoint, answer) => ({
    kind: 'question',
    detail: { checkpoint, boundDigest: 'abc' },
    answer,
  });

  it('tells the agent the summary is authorized and that it must now save outputs', () => {
    const message = formatResumeAnswer(
      gate('summary-confirmation', { perQuestion: [{ answer: 'Looks correct' }] }),
    );

    expect(message).toContain('summary-confirmation');
    expect(message).toContain('Looks correct');
    // The receipt exists now, so the outputs must be (re)written AFTER it — that
    // ordering is exactly what the lineage check verifies.
    expect(message).toContain('create_artifact');
    expect(message).toContain('authorization is recorded');
  });

  it('tells the agent to revise and re-raise on Request changes', () => {
    const message = formatResumeAnswer(
      gate('summary-confirmation', {
        perQuestion: [{ answer: 'Request changes' }],
        freeText: 'split the aggregate',
      }),
    );

    expect(message).toContain('nothing is authorized yet');
    expect(message).toContain('split the aggregate');
    expect(message).toContain('`confirm_summary`');
  });

  it('routes a plan-approval decision to the plan tool and the implement instruction', () => {
    expect(
      formatResumeAnswer(gate('plan-approval', { perQuestion: [{ answer: 'Approve plan' }] })),
    ).toContain('Implement it now');
    expect(
      formatResumeAnswer(gate('plan-approval', { perQuestion: [{ answer: 'Request changes' }] })),
    ).toContain('`request_plan_approval`');
  });

  it('leaves an ordinary question and a validation gate exactly as before', () => {
    // The checkpoint branch must not capture the two shapes that already worked.
    expect(
      formatResumeAnswer({
        kind: 'question',
        answer: { perQuestion: [{ text: 'Scope?', answer: 'MVP' }] },
      }),
    ).toContain('The human answered your question(s):');
    expect(
      formatResumeAnswer({ kind: 'validation', answer: { feedback: 'tighten it' } }),
    ).toContain('requested changes');
  });
});
