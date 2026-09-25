// The consolidated-confirmation checkpoint family:
// the bridge handlers that raise it, the receipt that records the authorization,
// the write stamps that make output lineage checkable, the tool surface the policy
// decides, and the error cases that verify the authorization boundary.
//
// The load-bearing invariant every test here defends: ONLY the exact positive
// label creates authority, and that authority lives in a DURABLE receipt rather
// than in the bridge's memory — because a parked checkpoint is answered in a
// different container than the one that raised it.

import { describe, it, expect } from 'vitest';
import { createProcessBridge } from '../mcp/process-bridge.js';
import {
  AUTHOR_TOOLS,
  buildToolHandlers,
  registerTools,
  toolsForRole,
  toolSchemas,
} from '../mcp/server.js';

// In-memory fake of the process store — only the methods the checkpoint path uses.
// Receipts are keyed by the deterministic SK the real store builds, so the
// idempotency the bridge relies on is actually exercised rather than assumed.
const fakeStore = ({ receipts = new Map(), humanTasks = new Map() } = {}) => {
  const events = [];
  const stagePatches = [];
  const counters = new Map();
  const stageRow = { attempt: 0 };
  let receiptSeq = 0;
  const receiptSk = ({ kind, stageInstanceId, attempt, unitSlug }) =>
    `RECEIPT#${kind}#${stageInstanceId}#${attempt}#${unitSlug ?? '-'}`;
  return {
    events,
    humanTasks,
    receipts,
    stagePatches,
    counters,
    stageRow,
    async createHumanTask(args) {
      if (humanTasks.has(args.humanTaskId)) {
        const error = new Error('ConditionalCheckFailedException');
        error.name = 'ConditionalCheckFailedException';
        throw error;
      }
      humanTasks.set(args.humanTaskId, { ...args, status: 'pending', answer: null });
      return humanTasks.get(args.humanTaskId);
    },
    async getHumanTask(_executionId, humanTaskId) {
      return humanTasks.get(humanTaskId) ?? null;
    },
    async updateExecution() {},
    async updateStageState(patch) {
      stagePatches.push(patch);
    },
    async resumeStageRow() {},
    async appendEvent(event) {
      receiptSeq += 1;
      const row = {
        ...event,
        eventType: event.type,
        eventId: `e${receiptSeq}`,
        timestamp: `2026-09-24T10:00:${String(receiptSeq).padStart(2, '0')}.000Z`,
      };
      events.push(row);
      return row;
    },
    async putReceipt(args) {
      const sk = receiptSk(args);
      if (receipts.has(sk)) return receipts.get(sk);
      const row = { ...args, sk, decidedAt: '2026-09-24T10:00:00.000Z' };
      receipts.set(sk, row);
      return row;
    },
    async getReceipt(_executionId, selector) {
      return receipts.get(receiptSk(selector)) ?? null;
    },
    async listReceipts(_executionId, { stageInstanceId, attempt } = {}) {
      return [...receipts.values()].filter(
        (row) =>
          (stageInstanceId == null || row.stageInstanceId === stageInstanceId) &&
          (attempt == null || Number(row.attempt) === Number(attempt)),
      );
    },
    async listEvents() {
      return events;
    },
    async getStage() {
      return { ...stageRow, ...Object.fromEntries(counters) };
    },
    async bumpStageCounter({ field }) {
      const next = Number(counters.get(field) ?? 0) + 1;
      counters.set(field, next);
      return next;
    },
    async appendOutput() {
      return { seq: 1, timestamp: 'now' };
    },
    async recordMetric() {
      return { metricId: 'm1' };
    },
  };
};

const SCOPE = {
  executionId: 'exec-1',
  intentId: 'intent-1',
  stageInstanceId: 'si-1',
  stageAttempt: 0,
  policy: { summaryConfirmation: 'required', learnings: 'on' },
};

// Answer the single gate the bridge just opened, then let the grace poll see it.
const answerLatestGate = (store, answer, { by = 'alice', byName = 'Alice' } = {}) => {
  const [latest] = [...store.humanTasks.values()].filter((task) => task.status === 'pending');
  if (!latest) throw new Error('no pending gate to answer');
  latest.status = 'answered';
  latest.answer = answer;
  latest.answeredBy = by;
  latest.answeredByName = byName;
  return latest;
};

// A bridge whose grace poll answers on the first tick, so the inline path runs
// without real timers.
const inlineBridge = (store, { scope = SCOPE, answer } = {}) =>
  createProcessBridge({
    store,
    scope,
    pollIntervalMs: 1,
    parkGraceMs: 10,
    sleep: async () => {
      if (answer !== undefined) answerLatestGate(store, answer);
    },
  });

// A bridge whose grace window never sees an answer, so it parks.
const parkingBridge = (store, { scope = SCOPE } = {}) =>
  createProcessBridge({
    store,
    scope,
    pollIntervalMs: 1,
    parkGraceMs: 2,
    sleep: async () => {},
  });

const eventTypes = (store) => store.events.map((event) => event.type);

describe('confirm_summary — the authorization it does and does not create', () => {
  it('records a receipt bound to the content the human saw on the exact positive label', async () => {
    const store = fakeStore();
    const bridge = inlineBridge(store, { answer: { perQuestion: [{ answer: 'Looks correct' }] } });

    const result = await bridge.confirmSummary({
      summary: 'I will model the order lifecycle',
      decisions: ['use an event log', 'no soft deletes'],
    });

    expect(result.decision).toBe('approved');
    expect(result.authorizationId).toMatch(/^RECEIPT#summary-confirmation#si-1#0#-$/);
    expect(eventTypes(store)).toEqual(['v2.summary.requested', 'v2.summary.confirmed']);
    const [receipt] = [...store.receipts.values()];
    expect(receipt).toMatchObject({
      kind: 'summary-confirmation',
      choice: 'Looks correct',
      decidedBy: 'alice',
      attempt: 0,
    });
    // The gate carries the digest of exactly what was shown, and the receipt
    // carries the same one — that pairing is what makes a later edit detectable.
    const [gate] = [...store.humanTasks.values()];
    expect(gate.detail.checkpoint).toBe('summary-confirmation');
    expect(receipt.boundDigest).toBe(gate.detail.boundDigest);
    expect(receipt.boundDigest).toMatch(/^[0-9a-f]{64}$/);
    // The checkpoint must NOT masquerade as an ordinary question: `if-present`
    // keys off v2.question.asked, so emitting it here would make every
    // confirmation self-triggering.
    expect(eventTypes(store)).not.toContain('v2.question.asked');
  });

  it('offers exactly two options, both owned by the platform', async () => {
    const store = fakeStore();
    const bridge = inlineBridge(store, { answer: { perQuestion: [{ answer: 'Looks correct' }] } });
    await bridge.confirmSummary({ summary: 'a summary' });

    const [gate] = [...store.humanTasks.values()];
    const [question] = JSON.parse(gate.questions);
    expect(question.type).toBe('single');
    expect(question.options.map((option) => option.label)).toEqual([
      'Looks correct',
      'Request changes',
    ]);
    // Reusing the closed `question` kind is what keeps the frontend union closed.
    expect(gate.kind).toBe('question');
  });

  // An answer outside the configured choices cannot authorize writes.
  it('creates NO authority for any answer other than the two labels, and asks again', async () => {
    const store = fakeStore();
    const bridge = inlineBridge(store, { answer: { freeText: 'Other' } });

    const result = await bridge.confirmSummary({ summary: 'a summary' });

    expect(result.decision).toBe('re-ask');
    expect(result.authorizationId).toBeNull();
    expect(store.receipts.size).toBe(0);
    expect(result.message).toMatch(/Looks correct/);
    expect(eventTypes(store)).toEqual(['v2.summary.requested']);
  });

  it('loops on Request changes without creating authority, then succeeds on the retry', async () => {
    const store = fakeStore();
    const rejecting = inlineBridge(store, {
      answer: { perQuestion: [{ answer: 'Request changes' }], freeText: 'model refunds too' },
    });

    const first = await rejecting.confirmSummary({ summary: 'v1' });
    expect(first.decision).toBe('changes-requested');
    expect(first.feedback).toBe('model refunds too');
    expect(store.receipts.size).toBe(0);
    expect(eventTypes(store)).toEqual(['v2.summary.requested', 'v2.summary.changes_requested']);

    // The revision is a SECOND gate, not a re-answer of the first: the first is
    // already answered, so the derived id advances a round.
    const accepting = inlineBridge(store, {
      answer: { perQuestion: [{ answer: 'Looks correct' }] },
    });
    const second = await accepting.confirmSummary({ summary: 'v2 with refunds' });
    expect(second.decision).toBe('approved');
    expect(store.humanTasks.size).toBe(2);
    expect(store.receipts.size).toBe(1);
  });

  it('refuses to raise the checkpoint forever', async () => {
    const store = fakeStore();
    // Pre-fill every round slot as answered-but-rejected.
    for (let round = 0; round < 12; round += 1) {
      store.humanTasks.set(`chk-summary-confirmation-si-1-0---${round}`, {
        humanTaskId: `chk-summary-confirmation-si-1-0---${round}`,
        status: 'answered',
        answer: { perQuestion: [{ answer: 'Request changes' }] },
      });
    }
    const bridge = parkingBridge(store);
    await expect(bridge.confirmSummary({ summary: 'again' })).rejects.toThrow(/12 times/);
  });

  it('reuses an existing pending checkpoint instead of creating another round', async () => {
    const store = fakeStore();
    const bridge = parkingBridge(store);

    const first = await bridge.confirmSummary({ summary: 'same summary' });
    const second = await bridge.confirmSummary({ summary: 'same summary' });

    expect(first).toMatchObject({
      parked: true,
      humanTaskId: 'chk-summary-confirmation-si-1-0---0',
    });
    expect(second).toEqual(first);
    expect(store.humanTasks.size).toBe(1);
    expect(eventTypes(store).filter((type) => type === 'v2.summary.requested')).toHaveLength(1);
  });

  it('does not reuse a pending checkpoint for different content', async () => {
    const store = fakeStore();
    const bridge = parkingBridge(store);
    await bridge.confirmSummary({ summary: 'first summary' });

    await expect(bridge.confirmSummary({ summary: 'revised summary' })).rejects.toThrow(
      /different content/,
    );

    expect(store.humanTasks.size).toBe(1);
    expect(eventTypes(store).filter((type) => type === 'v2.summary.requested')).toHaveLength(1);
    expect(store.receipts.size).toBe(0);
  });

  it('reuses a checkpoint when concurrent confirmations race to create it', async () => {
    const store = fakeStore();
    const bridge = parkingBridge(store);
    await bridge.rehydrateAuthorizations();

    const humanTaskId = 'chk-summary-confirmation-si-1-0---0';
    const getHumanTask = store.getHumanTask.bind(store);
    let initialReads = 0;
    let releaseReads;
    const bothReadsComplete = new Promise((resolve) => {
      releaseReads = resolve;
    });
    store.getHumanTask = async (executionId, id) => {
      if (id === humanTaskId && !store.humanTasks.has(id) && initialReads < 2) {
        initialReads += 1;
        if (initialReads === 2) releaseReads();
        await bothReadsComplete;
        return null;
      }
      return getHumanTask(executionId, id);
    };

    const results = await Promise.all([
      bridge.confirmSummary({ summary: 'same summary' }),
      bridge.confirmSummary({ summary: 'same summary' }),
    ]);

    expect(results.map((result) => result.humanTaskId)).toEqual([humanTaskId, humanTaskId]);
    expect(results.every((result) => result.parked)).toBe(true);
    expect(store.humanTasks.size).toBe(1);
    expect(eventTypes(store).filter((type) => type === 'v2.summary.requested')).toHaveLength(1);
  });
});

describe('park / resume across a confirmation', () => {
  it('parks with a stop instruction and leaves the gate pending', async () => {
    const store = fakeStore();
    const bridge = parkingBridge(store);

    const parked = await bridge.confirmSummary({ summary: 'please confirm' });

    expect(parked.parked).toBe(true);
    expect(parked.message).toMatch(/STOP NOW/);
    expect(store.receipts.size).toBe(0);
    expect(store.stagePatches.at(-1)).toMatchObject({ state: 'WAITING_FOR_HUMAN' });
  });

  it('parks an inline answer if the stage cannot clear its durable park marker', async () => {
    const store = fakeStore();
    store.resumeStageRow = async () => {
      throw new Error('stage update unavailable');
    };
    const bridge = inlineBridge(store, {
      answer: { perQuestion: [{ answer: 'Looks correct' }] },
    });

    const outcome = await bridge.confirmSummary({ summary: 'please confirm' });

    expect(outcome).toMatchObject({
      parked: true,
      humanTaskId: 'chk-summary-confirmation-si-1-0---0',
      message: expect.stringMatching(/STOP NOW/),
    });
    expect([...store.humanTasks.values()][0].status).toBe('answered');
    expect(store.stagePatches.at(-1)).toMatchObject({ state: 'WAITING_FOR_HUMAN' });
    expect(store.receipts.size).toBe(0);
  });

  it('mints the receipt on the resume leg from the answered gate, not from memory', async () => {
    const store = fakeStore();
    // The container that raised the checkpoint parked and is gone.
    await parkingBridge(store).confirmSummary({ summary: 'please confirm' });
    answerLatestGate(store, { perQuestion: [{ answer: 'Looks correct' }] });

    // A FRESH bridge — as the resume leg builds — must recover the authorization.
    const resumed = createProcessBridge({ store, scope: SCOPE });
    const authorizationId = await resumed.rehydrateAuthorizations();

    expect(authorizationId).toMatch(/^RECEIPT#summary-confirmation#si-1#0#-$/);
    expect(store.receipts.size).toBe(1);
    expect(eventTypes(store)).toContain('v2.summary.confirmed');
    // A write made after the resume carries the recovered authorization.
    await resumed.stampArtifact({
      artifactId: 'a1',
      artifactType: 'business-logic-model',
      contentHash: 'deadbeef',
    });
    expect(store.events.at(-1).detail).toMatchObject({
      artifactType: 'business-logic-model',
      authorizationId,
    });
  });

  it('does not invent an authorization from a parked or rejected gate', async () => {
    const pending = fakeStore();
    await parkingBridge(pending).confirmSummary({ summary: 's' });
    expect(
      await createProcessBridge({ store: pending, scope: SCOPE }).rehydrateAuthorizations(),
    ).toBeNull();
    expect(pending.receipts.size).toBe(0);

    const rejected = fakeStore();
    await parkingBridge(rejected).confirmSummary({ summary: 's' });
    answerLatestGate(rejected, { perQuestion: [{ answer: 'Request changes' }] });
    expect(
      await createProcessBridge({ store: rejected, scope: SCOPE }).rehydrateAuthorizations(),
    ).toBeNull();
    expect(rejected.receipts.size).toBe(0);
  });

  // Rehydrating after a receipt write is idempotent and does not duplicate authority.
  it('replays a putReceipt that already landed without double-counting', async () => {
    const store = fakeStore();
    await parkingBridge(store).confirmSummary({ summary: 's' });
    answerLatestGate(store, { perQuestion: [{ answer: 'Looks correct' }] });

    const first = await createProcessBridge({ store, scope: SCOPE }).rehydrateAuthorizations();
    const second = await createProcessBridge({ store, scope: SCOPE }).rehydrateAuthorizations();

    expect(second).toBe(first);
    expect(store.receipts.size).toBe(1);
  });

  it('makes a prior attempt\u2019s authorization invisible after a rewind bumps the attempt', async () => {
    const store = fakeStore();
    await inlineBridge(store, {
      answer: { perQuestion: [{ answer: 'Looks correct' }] },
    }).confirmSummary({ summary: 's' });
    expect(store.receipts.size).toBe(1);

    // resetStageForRewind bumps `attempt`; the next attempt resolves a different
    // receipt space, so nothing prior can authorize its writes.
    const nextAttempt = createProcessBridge({
      store,
      scope: { ...SCOPE, stageAttempt: 1 },
    });
    expect(await nextAttempt.rehydrateAuthorizations()).toBeNull();
    await nextAttempt.stampArtifact({ artifactId: 'a1', artifactType: 'x', contentHash: 'h' });
    expect(store.events.at(-1).detail.authorizationId).toBeNull();
  });
});

// Rehydration must not mint or adopt an authorization from ANY
// answered row carrying the positive label — it never checked that a human was
// recorded on it, and the comments claimed a digest comparison that did not exist.
// Refusing is safe: the completion ladder then reports the authorization as
// missing, which the human can waive or override at the gate.
describe('rehydrateAuthorizations — what is NOT a human decision', () => {
  const answeredGateWith = async (patch) => {
    const store = fakeStore();
    await parkingBridge(store).confirmSummary({ summary: 's' });
    const [gate] = [...store.humanTasks.values()];
    gate.status = 'answered';
    gate.answer = { perQuestion: [{ answer: 'Looks correct' }] };
    gate.answeredBy = 'alice';
    gate.answeredByName = 'Alice';
    Object.assign(gate, patch);
    return { store, gate };
  };

  it('refuses a gate answered by nobody', async () => {
    const { store } = await answeredGateWith({ answeredBy: null, answeredByName: null });
    const bridge = createProcessBridge({ store, scope: SCOPE });
    expect(await bridge.rehydrateAuthorizations()).toBeNull();
    expect(store.receipts.size).toBe(0);
    expect(store.events.at(-1)).toMatchObject({
      type: 'v2.checkpoint.authorization_refused',
      detail: { reason: 'the answered gate records no answeredBy' },
    });
  });

  it('refuses a gate with no recorded digest provenance', async () => {
    const { store, gate } = await answeredGateWith({});
    delete gate.detail.boundDigest;
    const bridge = createProcessBridge({ store, scope: SCOPE });
    expect(await bridge.rehydrateAuthorizations()).toBeNull();
    expect(store.receipts.size).toBe(0);
    expect(store.events.at(-1).detail.reason).toBe('the answered gate carries no boundDigest');
  });

  it('withholds an EXISTING receipt whose digest no longer matches its gate', async () => {
    const store = fakeStore();
    await inlineBridge(store, {
      answer: { perQuestion: [{ answer: 'Looks correct' }] },
    }).confirmSummary({ summary: 's' });
    const [receipt] = [...store.receipts.values()];
    // The receipt now points at a decision other than the one on the gate row.
    receipt.boundDigest = 'f'.repeat(64);

    const resumed = createProcessBridge({ store, scope: SCOPE });
    expect(await resumed.rehydrateAuthorizations()).toBeNull();
    await resumed.stampArtifact({ artifactId: 'a1', artifactType: 'x', contentHash: 'h' });
    expect(store.events.at(-1).detail.authorizationId).toBeNull();
    expect(
      store.events.some(
        (event) =>
          event.type === 'v2.checkpoint.authorization_refused' &&
          String(event.detail.reason).includes('boundDigest does not match'),
      ),
    ).toBe(true);
  });

  it('withholds an EXISTING receipt whose gate row can no longer be read', async () => {
    const store = fakeStore();
    await inlineBridge(store, {
      answer: { perQuestion: [{ answer: 'Looks correct' }] },
    }).confirmSummary({ summary: 's' });
    store.humanTasks.clear();

    const resumed = createProcessBridge({ store, scope: SCOPE });
    expect(await resumed.rehydrateAuthorizations()).toBeNull();
    expect(store.events.at(-1).detail.reason).toMatch(/names no readable gate row/);
  });

  it('still adopts a receipt that matches its gate and its human', async () => {
    const store = fakeStore();
    await inlineBridge(store, {
      answer: { perQuestion: [{ answer: 'Looks correct' }] },
    }).confirmSummary({ summary: 's' });
    const resumed = createProcessBridge({ store, scope: SCOPE });
    expect(await resumed.rehydrateAuthorizations()).toMatch(/^RECEIPT#summary-confirmation#/);
    expect(store.events.some((event) => event.type === 'v2.checkpoint.authorization_refused')).toBe(
      false,
    );
  });
});

describe('request_plan_approval', () => {
  const PLAN_SCOPE = {
    ...SCOPE,
    policy: { summaryConfirmation: 'none', planApproval: 'required', learnings: 'on' },
  };

  it('records a plan-approval receipt on Approve plan, with its own event names', async () => {
    const store = fakeStore();
    const bridge = inlineBridge(store, {
      scope: PLAN_SCOPE,
      answer: { perQuestion: [{ answer: 'Approve plan' }] },
    });

    const result = await bridge.requestPlanApproval({
      plan: 'add an OrderService',
      testInstructions: 'run npm test',
    });

    expect(result.decision).toBe('approved');
    expect(eventTypes(store)).toEqual(['v2.plan.requested', 'v2.plan.approved']);
    const [receipt] = [...store.receipts.values()];
    expect(receipt.kind).toBe('plan-approval');
    const [gate] = [...store.humanTasks.values()];
    expect(JSON.parse(gate.questions)[0].options.map((option) => option.label)).toEqual([
      'Approve plan',
      'Request changes',
    ]);
  });

  it('does not let a plan approval authorize artifact writes', async () => {
    const store = fakeStore();
    const bridge = inlineBridge(store, {
      scope: PLAN_SCOPE,
      answer: { perQuestion: [{ answer: 'Approve plan' }] },
    });
    await bridge.requestPlanApproval({ plan: 'p', testInstructions: 't' });

    await bridge.stampArtifact({
      artifactId: 'a1',
      artifactType: 'code-summary',
      contentHash: 'h',
    });

    // Only a summary confirmation authorizes writes; conflating the two would let
    // an approved plan silently satisfy the summary checkpoint.
    expect(store.events.at(-1).detail.authorizationId).toBeNull();
  });
});

describe('write stamps', () => {
  it('records the artifact, its bytes and the held authorization', async () => {
    const store = fakeStore();
    const bridge = inlineBridge(store, { answer: { perQuestion: [{ answer: 'Looks correct' }] } });
    const { authorizationId } = await bridge.confirmSummary({ summary: 's' });

    await bridge.stampArtifact({
      artifactId: 'blm-1',
      artifactType: 'business-logic-model',
      contentHash: 'abc123',
    });

    expect(store.events.at(-1)).toMatchObject({
      type: 'v2.artifact.stamped',
      detail: {
        artifactId: 'blm-1',
        artifactType: 'business-logic-model',
        contentHash: 'abc123',
        authorizationId,
      },
    });
  });

  it('records an UNAUTHORIZED write rather than suppressing it', async () => {
    const store = fakeStore();
    const bridge = inlineBridge(store);

    await bridge.stampArtifact({ artifactId: 'a1', artifactType: 'design', contentHash: 'h' });

    // The null authorization is the evidence the completion ladder acts on; a
    // suppressed stamp would be indistinguishable from a compliant write.
    expect(store.events.at(-1).detail.authorizationId).toBeNull();
  });

  it('emits nothing at all without a resolved release policy', async () => {
    const store = fakeStore();
    const bridge = createProcessBridge({ store, scope: { ...SCOPE, policy: null } });

    expect(
      await bridge.stampArtifact({ artifactId: 'a1', artifactType: 'x', contentHash: 'h' }),
    ).toBeNull();
    expect(store.events).toHaveLength(0);
  });
});

describe('the tool surface the policy decides', () => {
  const author = (policy) => toolsForRole('author', 'business-logic', policy);

  it('never registers a checkpoint tool for a 2.3.3-era or unpinned run', () => {
    expect(author(null)).toEqual(AUTHOR_TOOLS);
    expect(author(null)).not.toContain('confirm_summary');
    expect(author(null)).not.toContain('request_plan_approval');
  });

  it('registers confirm_summary only when the policy needs it', () => {
    expect(author({ summaryConfirmation: 'none' })).not.toContain('confirm_summary');
    expect(author({ summaryConfirmation: 'required' })).toContain('confirm_summary');
    expect(author({ summaryConfirmation: 'if-present' })).toContain('confirm_summary');
  });

  it('registers request_plan_approval only where plan approval applies', () => {
    expect(author({ planApproval: null })).not.toContain('request_plan_approval');
    expect(author({ planApproval: 'required' })).toContain('request_plan_approval');
  });

  it('withdraws both learning writers when the scope turns learnings off', () => {
    const off = author({ learnings: 'off' });
    expect(off).not.toContain('record_team_knowledge');
    expect(off).not.toContain('record_learning_rule');
    // Withdrawal is surgical: nothing else the agent needs disappears with them.
    expect(off).toContain('create_artifact');
    expect(off).toContain('ask_question');
    expect(author({ learnings: 'on' })).toContain('record_team_knowledge');
  });

  it('keeps the reviewer and reader surfaces untouched by any policy', () => {
    const policy = { summaryConfirmation: 'required', planApproval: 'required', learnings: 'off' };
    expect(toolsForRole('reviewer', null, policy)).toEqual(toolsForRole('reviewer'));
    expect(toolsForRole('reader', null, policy)).toEqual(toolsForRole('reader'));
  });

  it('registers every policy-added tool with a real schema and handler', () => {
    const registered = [];
    // The same minimal zod stand-in mcp-server.test.js uses: registerTools only
    // needs the schema-shape values to exist, it never invokes zod.
    const zod = {
      string: () => ({ optional: () => ({}) }),
      number: () => ({
        optional: () => ({}),
        int: () => ({ min: () => ({ max: () => ({ optional: () => ({}) }) }) }),
      }),
      enum: () => ({ optional: () => ({}) }),
      object: () => ({ optional: () => ({}) }),
      array: () => ({ optional: () => ({}) }),
      record: () => ({ optional: () => ({}) }),
    };
    const handlers = buildToolHandlers({ bridge: {}, graph: null, writer: {} });
    const names = registerTools({
      server: { tool: (name) => registered.push(name) },
      handlers,
      role: 'author',
      stageId: 'business-logic',
      policy: { summaryConfirmation: 'required', planApproval: 'required' },
      z: zod,
      env: { V2_MCP_TRACE: 'off' },
    });

    expect(registered).toContain('confirm_summary');
    expect(registered).toContain('request_plan_approval');
    expect(names).toEqual(registered);
    for (const name of ['confirm_summary', 'request_plan_approval']) {
      expect(typeof handlers[name]).toBe('function');
      expect(toolSchemas(zod)[name].description).toMatch(/STOP IMMEDIATELY/);
    }
  });
});
