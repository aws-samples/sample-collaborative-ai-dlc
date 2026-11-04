import { describe, it, expect, vi } from 'vitest';
import {
  aggregatePendingQuestions,
  parsePendingQuestionsParams,
  encodeCursor,
  decodeCursor,
  PendingQuestionsError,
  AGGREGATION_DEADLINE_MS,
  MAX_SPACES,
  MAX_LIVE_INTENTS_PER_SPACE,
  MAX_PENDING_PER_INTENT,
  MAX_INTENT_READS,
} from '../pending-questions.js';

// ── Fake store ──
// spaces: { [projectId]: [meta…] }, tasks: { [executionId]: [task…] },
// stages: { [`${executionId}#${stageInstanceId}`]: stage }.
const fakeStore = ({ executions = [], tasks = {}, stages = {}, fail = {} } = {}) => {
  const calls = { executions: [], tasks: [], stages: [] };
  const store = {
    calls,
    listProjectExecutions: vi.fn(async (args) => {
      calls.executions.push(args);
      if (fail.executions?.(args))
        throw Object.assign(new Error('boom'), { name: 'ThrottlingError' });
      const rows = executions
        .filter((m) => m.projectId === args.projectId && m.status === args.status)
        .toSorted((a, b) => (a.startedAt < b.startedAt ? -1 : 1));
      return (args.oldestFirst ? rows : rows.toReversed()).slice(0, args.limit);
    }),
    listPendingHumanTasks: vi.fn(async (executionId, { limit }) => {
      calls.tasks.push(executionId);
      if (fail.tasks?.(executionId)) throw new Error('gsi2');
      return (tasks[executionId] ?? [])
        .filter((t) => t.status === 'pending')
        .toSorted((a, b) => (a.humanTaskId < b.humanTaskId ? -1 : 1))
        .slice(0, limit);
    }),
    getStage: vi.fn(async (executionId, stageInstanceId) => {
      calls.stages.push(`${executionId}#${stageInstanceId}`);
      if (fail.stages?.(executionId, stageInstanceId)) throw new Error('get');
      return stages[`${executionId}#${stageInstanceId}`] ?? null;
    }),
  };
  return store;
};
const space = (projectId, over = {}) => ({
  projectId,
  projectName: `Space ${projectId}`,
  kind: 'v2',
  role: 'member',
  ...over,
});
const meta = (executionId, projectId, over = {}) => ({
  executionId,
  projectId,
  status: 'WAITING',
  orchestratorRunId: 'run1',
  startedAt: '2026-01-01T00:00:00.000Z',
  title: `Intent ${executionId}`,
  ...over,
});
const task = (humanTaskId, createdAt, over = {}) => ({
  humanTaskId,
  kind: 'question',
  status: 'pending',
  orchestratorRunId: 'run1',
  stageInstanceId: null,
  unitSlug: null,
  sectionIndex: null,
  questions: JSON.stringify([{ text: `Q ${humanTaskId}` }]),
  prompt: null,
  createdAt,
  ...over,
});
const params = (over = {}) => ({ limit: 25, cursor: null, projectId: null, kinds: null, ...over });
const run = (over = {}) =>
  aggregatePendingQuestions({
    userId: 'u1',
    memberships: [space('p1')],
    params: params(),
    clock: () => 1000,
    startedAt: 1000,
    ...over,
  });
const ids = (res) => res.items.map((i) => i.humanTaskId);

describe('aggregatePendingQuestions ordering and dedupe', () => {
  it('orders by createdAt then projectId, intentId, humanTaskId in code-unit order', async () => {
    const T = '2026-01-01T00:00:00.000Z';
    const store = fakeStore({
      executions: [meta('e1', 'a'), meta('e2', 'B'), meta('i', 'B')],
      tasks: {
        e1: [task('q_1', T), task('q-1', T), task('late', '2026-01-02T00:00:00.000Z')],
        e2: [task('x', T)],
        i: [task('early', '2025-12-31T00:00:00.000Z')],
      },
    });
    const res = await run({ store, memberships: [space('a'), space('B')] });
    // 'B' < 'a' and 'q-1' < 'q_1' in UTF-16 order.
    expect(ids(res)).toEqual(['early', 'x', 'q-1', 'q_1', 'late']);
    // The cursor comparison agrees with the sort: walking one by one yields the same order.
    const walked = [];
    let cursor = null;
    do {
      const page = await run({
        store,
        memberships: [space('a'), space('B')],
        params: params({ limit: 1, cursor }),
      });
      walked.push(...ids(page));
      cursor = page.nextCursor ? decodeCursor(page.nextCursor) : null;
    } while (cursor);
    expect(walked).toEqual(ids(res));
  });
  it('reads an execution seen in both WAITING and RUNNING once', async () => {
    const store = fakeStore({ tasks: { e1: [task('h1', 'T1')] } });
    store.listProjectExecutions.mockImplementation(async () => [meta('e1', 'p1')]);
    const res = await run({ store });
    expect(ids(res)).toEqual(['h1']);
    expect(store.calls.tasks).toEqual(['e1']);
  });
  it('reads live executions oldest first and keeps the oldest when over the cap', async () => {
    const executions = Array.from({ length: MAX_LIVE_INTENTS_PER_SPACE + 5 }, (_, i) =>
      meta(`e${String(i).padStart(3, '0')}`, 'p1', {
        startedAt: `2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
      }),
    );
    const store = fakeStore({ executions });
    const res = await run({ store });
    expect(store.calls.executions.every((c) => c.oldestFirst === true)).toBe(true);
    expect(store.calls.executions.map((c) => c.status)).toEqual(['WAITING', 'RUNNING']);
    expect(store.calls.tasks).toEqual(
      executions.slice(0, MAX_LIVE_INTENTS_PER_SPACE).map((e) => e.executionId),
    );
    expect(res.unavailable).toEqual([
      { projectId: 'p1', projectName: 'Space p1', reason: 'LIMIT_EXCEEDED' },
    ]);
  });
});

describe('aggregatePendingQuestions stage labels', () => {
  it('labels engine gates from the STAGE row and reads each stage once', async () => {
    const store = fakeStore({
      executions: [meta('e1', 'p1')],
      tasks: {
        e1: [
          task('v1', 'T1', { kind: 'validation', stageInstanceId: 's1', prompt: 'Review it' }),
          task('v2', 'T2', { kind: 'approval', stageInstanceId: 's1', prompt: 'Approve' }),
        ],
      },
      stages: { 'e1#s1': { stageId: 'functional-design', phase: 'construction' } },
    });
    const res = await run({ store });
    expect(res.items.map((i) => [i.stageId, i.phase])).toEqual([
      ['functional-design', 'construction'],
      ['functional-design', 'construction'],
    ]);
    expect(store.calls.stages).toEqual(['e1#s1']);
    expect(res.items[0].target).toEqual({
      view: 'review',
      projectId: 'p1',
      intentId: 'e1',
      humanTaskId: 'v1',
    });
    expect(res.items[1].target.view).toBe('gate');
  });
});

describe('aggregatePendingQuestions pagination', () => {
  const build = (n) =>
    fakeStore({
      executions: [meta('e1', 'p1')],
      tasks: { e1: Array.from({ length: n }, (_, i) => task(`h${i}`, `T${i}`)) },
    });
  it.each([
    [0, 0, false],
    [1, 1, false],
    [3, 3, false],
    [4, 3, true],
  ])('%i candidates with limit 3 → %i items, more=%s', async (n, count, more) => {
    const res = await run({ store: build(n), params: params({ limit: 3 }) });
    expect(res.items).toHaveLength(count);
    expect(Boolean(res.nextCursor)).toBe(more);
  });
  it('does not duplicate or skip when an item is answered between pages, and new items come last', async () => {
    const store = build(4);
    const first = await run({ store, params: params({ limit: 2 }) });
    expect(ids(first)).toEqual(['h0', 'h1']);
    const tasks = await store.listPendingHumanTasks('e1', { limit: 51 });
    tasks[0].status = 'answered';
    store.listPendingHumanTasks.mockImplementation(async () => [
      ...tasks.filter((t) => t.status === 'pending'),
      task('h9', 'T9'),
    ]);
    const second = await run({
      store,
      params: params({ limit: 2, cursor: decodeCursor(first.nextCursor) }),
    });
    expect(ids(second)).toEqual(['h2', 'h3']);
    const third = await run({
      store,
      params: params({ limit: 2, cursor: decodeCursor(second.nextCursor) }),
    });
    expect(ids(third)).toEqual(['h9']);
    expect(third.nextCursor).toBeNull();
  });
});

describe('parsePendingQuestionsParams', () => {
  const code = (qs) => {
    try {
      parsePendingQuestionsParams(qs);
      return null;
    } catch (err) {
      expect(err).toBeInstanceOf(PendingQuestionsError);
      expect(err.status).toBe(400);
      return err.code;
    }
  };
  it('defaults and parses valid input', () => {
    expect(parsePendingQuestionsParams(null)).toEqual({
      limit: 25,
      cursor: null,
      projectId: null,
      kinds: null,
    });
    const cursor = encodeCursor(['T', 'p', 'i', 'h']);
    expect(
      parsePendingQuestionsParams({
        limit: '50',
        cursor,
        projectId: 'p1',
        kind: 'approval,validation',
        other: 'ignored',
      }),
    ).toEqual({
      limit: 50,
      cursor: ['T', 'p', 'i', 'h'],
      projectId: 'p1',
      kinds: ['approval', 'validation'],
    });
  });
  it.each(['0', '51', 'abc', '1.5', '', '-1'])('rejects limit %j', (limit) => {
    expect(code({ limit })).toBe('INVALID_LIMIT');
  });
  const b64 = (v) => Buffer.from(JSON.stringify(v)).toString('base64url');
  it.each([
    ['garbage', 'not base64!'],
    ['non-JSON', Buffer.from('hello').toString('base64url')],
    ['wrong version', b64({ v: 2, k: ['a', 'b', 'c', 'd'] })],
    ['wrong arity', b64({ v: 1, k: ['a', 'b', 'c'] })],
    ['non-strings', b64({ v: 1, k: ['a', 'b', 'c', 4] })],
    ['over-long part', b64({ v: 1, k: ['a'.repeat(257), 'b', 'c', 'd'] })],
    ['over 512 chars', 'a'.repeat(513)],
    ['empty', ''],
  ])('rejects a %s cursor', (_, cursor) => {
    expect(code({ cursor })).toBe('INVALID_CURSOR');
  });
  it.each(['nope', 'question,question', 'question,', ''])('rejects kind %j', (kind) => {
    expect(code({ kind })).toBe('INVALID_KIND');
  });
  it('rejects an empty or over-long projectId', () => {
    expect(code({ projectId: '' })).toBe('INVALID_PROJECT_ID');
    expect(code({ projectId: 'p'.repeat(257) })).toBe('INVALID_PROJECT_ID');
  });
});

describe('aggregatePendingQuestions filters and authorization', () => {
  const store = () =>
    fakeStore({
      executions: [meta('e1', 'p1'), meta('e2', 'p2'), meta('e3', 'legacy')],
      tasks: {
        e1: [task('q1', 'T1'), task('a1', 'T2', { kind: 'approval', prompt: 'Approve' })],
        e2: [task('v2', 'T3', { kind: 'validation', prompt: 'Review' })],
        e3: [task('l3', 'T0')],
      },
    });
  const memberships = [space('p1'), space('p2'), space('legacy', { kind: 'v1' })];
  it('reads only the caller’s v2 spaces', async () => {
    const s = store();
    const res = await run({ store: s, memberships });
    expect(ids(res)).toEqual(['q1', 'a1', 'v2']);
    expect([...new Set(s.calls.executions.map((c) => c.projectId))]).toEqual(['p1', 'p2']);
    expect(res.items.every((i) => i.eligibility.assignment === 'open')).toBe(true);
    expect(res.items[0].eligibility).toEqual({ basis: 'space-member', assignment: 'open' });
  });
  it('filters by kind', async () => {
    expect(
      ids(await run({ store: store(), memberships, params: params({ kinds: ['question'] }) })),
    ).toEqual(['q1']);
    expect(
      ids(
        await run({
          store: store(),
          memberships,
          params: params({ kinds: ['approval', 'review-verdict', 'validation'] }),
        }),
      ),
    ).toEqual(['a1', 'v2']);
  });
  it('filters to one member space', async () => {
    const s = store();
    expect(ids(await run({ store: s, memberships, params: params({ projectId: 'p2' }) }))).toEqual([
      'v2',
    ]);
    expect(s.calls.executions.map((c) => c.projectId)).toEqual(['p2', 'p2']);
  });
  it.each(['p9', 'legacy'])(
    'refuses a projectId filter for %s before any read',
    async (projectId) => {
      const s = store();
      await expect(
        run({ store: s, memberships, params: params({ projectId }) }),
      ).rejects.toMatchObject({
        status: 403,
        code: 'NOT_A_MEMBER',
      });
      expect(s.calls.executions).toEqual([]);
    },
  );
  it('returns an empty result without reads when the caller has no memberships', async () => {
    const s = store();
    const res = await run({ store: s, memberships: [] });
    expect(res).toMatchObject({ items: [], nextCursor: null, unavailable: [] });
    expect(s.listProjectExecutions).not.toHaveBeenCalled();
  });
  it('omits tasks the policy rejects and awaits an async policy', async () => {
    const eligibility = vi.fn(async ({ task: t }) =>
      t.humanTaskId === 'a1'
        ? { eligible: false, reason: 'not-designated' }
        : { eligible: true, basis: 'space-member', assignment: 'open' },
    );
    const res = await run({ store: store(), memberships, eligibility });
    expect(ids(res)).toEqual(['q1', 'v2']);
    expect(eligibility).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', membershipRole: 'member', projectId: 'p1' }),
    );
  });
});

describe('aggregatePendingQuestions pending correctness', () => {
  it('lists only tasks the answer transaction would accept', async () => {
    const store = fakeStore({
      executions: [
        meta('live', 'p1'),
        meta('rewound', 'p1', { orchestratorRunId: 'run2' }),
        meta('failed', 'p1', { status: 'FAILED' }),
        meta('cancelled', 'p1', { status: 'CANCELLED' }),
      ],
      tasks: {
        live: [
          task('ok', 'T1'),
          task('answered', 'T2', { status: 'answered' }),
          task('superseded', 'T3', { status: 'superseded' }),
          task('stale-attempt', 'T4', { stageInstanceId: 's1', stageCallbackId: 'cb-old' }),
          task('lane-a', 'T5', {
            stageInstanceId: 's2',
            stageCallbackId: 'cb2',
            unitSlug: 'a',
            sectionIndex: 0,
          }),
          task('lane-b', 'T6', {
            stageInstanceId: 's3',
            stageCallbackId: 'cb3',
            unitSlug: 'b',
            sectionIndex: 1,
          }),
        ],
        rewound: [task('old-run', 'T7')],
        failed: [task('f', 'T8')],
        cancelled: [task('c', 'T9')],
      },
      stages: {
        'live#s1': { stageCallbackId: 'cb-new' },
        'live#s2': { stageCallbackId: 'cb2' },
        'live#s3': { stageCallbackId: 'cb3' },
      },
    });
    const res = await run({ store });
    expect(ids(res)).toEqual(['ok', 'lane-a', 'lane-b']);
    expect(res.items.slice(1).map((i) => [i.unitSlug, i.sectionIndex])).toEqual([
      ['a', 0],
      ['b', 1],
    ]);
    // FAILED / CANCELLED intents are not even read.
    expect(store.calls.tasks).not.toContain('failed');
  });
});

describe('aggregatePendingQuestions partial failure', () => {
  const twoSpaces = (fail) =>
    fakeStore({
      executions: [meta('e1', 'p1'), meta('e2', 'p1'), meta('e3', 'p2')],
      tasks: {
        e1: [task('h1', 'T1', { stageInstanceId: 's1' })],
        e2: [task('h2', 'T2')],
        e3: [task('h3', 'T3')],
      },
      fail,
    });
  const memberships = [space('p1'), space('p2')];
  it('reports a space whose GSI1 read fails and still returns the others', async () => {
    const warn = vi.fn();
    const res = await run({
      store: twoSpaces({ executions: (a) => a.projectId === 'p1' && a.status === 'RUNNING' }),
      memberships,
      logger: { warn },
    });
    expect(ids(res)).toEqual(['h1', 'h2', 'h3']);
    expect(res.unavailable).toEqual([
      { projectId: 'p1', projectName: 'Space p1', reason: 'READ_FAILED' },
    ]);
    expect(warn).toHaveBeenCalledWith('pending-questions read failed', {
      projectId: 'p1',
      errorName: 'ThrottlingError',
    });
  });
  it('reports a space whose GSI2 read fails and keeps sibling intents', async () => {
    const res = await run({ store: twoSpaces({ tasks: (e) => e === 'e2' }), memberships });
    expect(ids(res)).toEqual(['h1', 'h3']);
    expect(res.unavailable.map((u) => [u.projectId, u.reason])).toEqual([['p1', 'READ_FAILED']]);
  });
  it('reports a space whose STAGE read fails', async () => {
    const res = await run({ store: twoSpaces({ stages: () => true }), memberships });
    expect(ids(res)).toEqual(['h2', 'h3']);
    expect(res.unavailable.map((u) => [u.projectId, u.reason])).toEqual([['p1', 'READ_FAILED']]);
  });
  it('lists a space once, as READ_FAILED, when it also hit a bound', async () => {
    const executions = Array.from({ length: MAX_LIVE_INTENTS_PER_SPACE + 1 }, (_, i) =>
      meta(`e${i}`, 'p1', { startedAt: `T${String(i).padStart(3, '0')}` }),
    );
    const store = fakeStore({ executions, fail: { tasks: (e) => e === 'e0' } });
    const res = await run({ store });
    expect(res.unavailable).toEqual([
      { projectId: 'p1', projectName: 'Space p1', reason: 'READ_FAILED' },
    ]);
  });
});

describe('aggregatePendingQuestions bounds', () => {
  it('caps spaces at MAX_SPACES by projectId', async () => {
    const memberships = Array.from({ length: MAX_SPACES + 2 }, (_, i) =>
      space(`p${String(i).padStart(3, '0')}`),
    ).toReversed();
    const store = fakeStore();
    const res = await run({ store, memberships });
    expect(new Set(store.calls.executions.map((c) => c.projectId)).size).toBe(MAX_SPACES);
    expect(res.unavailable.map((u) => [u.projectId, u.reason])).toEqual([
      ['p100', 'LIMIT_EXCEEDED'],
      ['p101', 'LIMIT_EXCEEDED'],
    ]);
  });
  it('caps pending tasks per intent', async () => {
    const tasks = Array.from({ length: MAX_PENDING_PER_INTENT + 1 }, (_, i) =>
      task(`h${String(i).padStart(3, '0')}`, 'T'),
    );
    const res = await run({
      store: fakeStore({ executions: [meta('e1', 'p1')], tasks: { e1: tasks } }),
      params: params({ limit: 50 }),
    });
    expect(res.items).toHaveLength(MAX_PENDING_PER_INTENT);
    expect(res.items.at(-1).humanTaskId).toBe('h049');
    expect(res.unavailable.map((u) => u.reason)).toEqual(['LIMIT_EXCEEDED']);
  });
  it('caps intent reads across spaces at MAX_INTENT_READS', async () => {
    const memberships = Array.from({ length: 7 }, (_, i) => space(`p${i}`));
    const executions = memberships.flatMap((s) =>
      Array.from({ length: MAX_LIVE_INTENTS_PER_SPACE }, (_, i) =>
        meta(`${s.projectId}-e${String(i).padStart(2, '0')}`, s.projectId, {
          startedAt: `T${String(i).padStart(2, '0')}`,
        }),
      ),
    );
    const store = fakeStore({ executions });
    const res = await run({ store, memberships });
    expect(store.calls.tasks).toHaveLength(MAX_INTENT_READS);
    expect(store.calls.tasks.some((e) => e.startsWith('p6-'))).toBe(false);
    expect(res.unavailable.map((u) => [u.projectId, u.reason])).toEqual([['p6', 'LIMIT_EXCEEDED']]);
    expect(res.stats).toEqual({ spaces: 7, intentsRead: MAX_INTENT_READS, limitExceeded: 50 });
  });
  it('stops starting reads at the deadline', async () => {
    let now = 0;
    const store = fakeStore({
      executions: [meta('e1', 'p1'), meta('e2', 'p2')],
      tasks: { e1: [task('h1', 'T1')], e2: [task('h2', 'T2')] },
    });
    // The clock passes the deadline once p1's first GSI2 read has started.
    store.listPendingHumanTasks.mockImplementation(async (executionId) => {
      store.calls.tasks.push(executionId);
      now = AGGREGATION_DEADLINE_MS;
      return executionId === 'e1' ? [task('h1', 'T1')] : [task('h2', 'T2')];
    });
    const res = await run({
      store,
      memberships: [space('p1'), space('p2')],
      clock: () => now,
      startedAt: 0,
    });
    expect(ids(res)).toEqual(['h1']);
    expect(store.calls.tasks).toEqual(['e1']);
    expect(res.unavailable.map((u) => [u.projectId, u.reason])).toEqual([['p2', 'LIMIT_EXCEEDED']]);
  });
});

describe('aggregatePendingQuestions item shaping', () => {
  const one = async (t) =>
    (await run({ store: fakeStore({ executions: [meta('e1', 'p1')], tasks: { e1: [t] } }) }))
      .items[0];
  it('summarises the first question and counts questions', async () => {
    const item = await one(
      task('h1', 'T', {
        questions: JSON.stringify([{ text: '  Which\n rounding? ' }, { text: 'b' }]),
      }),
    );
    expect(item).toMatchObject({
      id: 'e1:h1',
      type: 'question',
      kind: 'question',
      projectName: 'Space p1',
      intentTitle: 'Intent e1',
      summary: 'Which rounding?',
      questionCount: 2,
      checkpoint: null,
      createdAt: 'T',
    });
    expect(item).not.toHaveProperty('questions');
    expect(item).not.toHaveProperty('options');
  });
  it('uses the prompt for other kinds, truncates at 200, and nulls unparseable questions', async () => {
    const approval = await one(task('h1', 'T', { kind: 'approval', prompt: 'x'.repeat(300) }));
    expect(approval.summary).toHaveLength(200);
    expect(approval.summary.endsWith('…')).toBe(true);
    expect(approval.questionCount).toBeNull();
    const broken = await one(task('h1', 'T', { questions: '{not json' }));
    expect(broken.summary).toBeNull();
    expect(broken.questionCount).toBeNull();
  });
  it('exposes the checkpoint and a null title', async () => {
    const store = fakeStore({
      executions: [meta('e1', 'p1', { title: undefined })],
      tasks: { e1: [task('h1', 'T', { detail: { checkpoint: 'units-plan', boundDigest: 'd' } })] },
    });
    const [item] = (await run({ store })).items;
    expect(item.checkpoint).toBe('units-plan');
    expect(item.intentTitle).toBeNull();
  });
});
