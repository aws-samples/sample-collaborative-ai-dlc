// GET /users/me/pending-questions: the v2 human tasks waiting for an answer in
// every space the caller belongs to, oldest first (docs/concepts/data-model.md,
// "Indexes and access patterns"). DynamoDB is the only source of pending state:
// live executions per space via GSI1, their pending HUMAN rows via GSI2, and
// the STAGE row for the attempt check. Reads are bounded per request; a space
// that could not be fully read is reported in `unavailable`, never dropped.
import { mapWithConcurrency } from '../shared/concurrency.js';
import { HUMAN_TASK_KINDS, isHumanTaskAnswerable } from '../shared/v2-process-keys.js';
import { answerEligibility } from './answer-eligibility.js';

export const MAX_SPACES = 100;
export const MAX_LIVE_INTENTS_PER_SPACE = 50;
export const MAX_PENDING_PER_INTENT = 50;
export const MAX_INTENT_READS = 300;
export const READ_CONCURRENCY = 8;
export const AGGREGATION_DEADLINE_MS = 8000;
export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 50;
const MAX_CURSOR_LENGTH = 512;
const MAX_ID_LENGTH = 256;
const SUMMARY_LENGTH = 200;
const LIVE_STATUSES = ['WAITING', 'RUNNING'];

export class PendingQuestionsError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'PendingQuestionsError';
    this.status = status;
    this.code = code;
  }
}
const invalid = (code, message) => new PendingQuestionsError(400, code, message);

// UTF-16 code-unit order (not localeCompare, which follows runtime ICU
// collation). One comparator for both the sort and the cursor test.
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const compareKey = (x, y) => {
  for (let i = 0; i < 4; i += 1) {
    const c = cmp(x[i], y[i]);
    if (c) return c;
  }
  return 0;
};
const sortKey = (item) => [item.createdAt ?? '', item.projectId, item.intentId, item.humanTaskId];

export const encodeCursor = (key) =>
  Buffer.from(JSON.stringify({ v: 1, k: key })).toString('base64url');
export const decodeCursor = (str) => {
  const bad = () => invalid('INVALID_CURSOR', 'cursor is invalid');
  if (typeof str !== 'string' || !str || str.length > MAX_CURSOR_LENGTH) throw bad();
  if (!/^[A-Za-z0-9_-]+$/.test(str)) throw bad();
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(str, 'base64url').toString('utf8'));
  } catch {
    throw bad();
  }
  const k = parsed?.k;
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    parsed.v !== 1 ||
    !Array.isArray(k) ||
    k.length !== 4 ||
    !k.every((s) => typeof s === 'string' && s.length <= MAX_ID_LENGTH)
  )
    throw bad();
  return k;
};

// Validate the query string before any read. Unknown parameters are ignored.
export const parsePendingQuestionsParams = (qs) => {
  const q = qs ?? {};
  let limit = DEFAULT_LIMIT;
  if (q.limit != null) {
    const n = /^\d+$/.test(q.limit) ? Number(q.limit) : NaN;
    if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT)
      throw invalid('INVALID_LIMIT', `limit must be an integer from 1 to ${MAX_LIMIT}`);
    limit = n;
  }
  const cursor = q.cursor != null ? decodeCursor(q.cursor) : null;
  let projectId = null;
  if (q.projectId != null) {
    if (!q.projectId || q.projectId.length > MAX_ID_LENGTH)
      throw invalid('INVALID_PROJECT_ID', 'projectId is invalid');
    projectId = q.projectId;
  }
  let kinds = null;
  if (q.kind != null) {
    const parts = q.kind.split(',');
    if (!parts.every((k) => HUMAN_TASK_KINDS.includes(k)) || new Set(parts).size !== parts.length)
      throw invalid(
        'INVALID_KIND',
        `kind must be distinct values of ${HUMAN_TASK_KINDS.join(',')}`,
      );
    kinds = parts;
  }
  return { limit, cursor, projectId, kinds };
};

const collapse = (text) => {
  if (typeof text !== 'string') return null;
  const s = text.replace(/\s+/g, ' ').trim();
  if (!s) return null;
  return s.length > SUMMARY_LENGTH ? `${s.slice(0, SUMMARY_LENGTH - 1)}…` : s;
};
const parseQuestions = (json) => {
  if (typeof json !== 'string') return null;
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
};
const toItem = ({ space, meta, task, stage, eligibility }) => {
  const questions = task.kind === 'question' ? parseQuestions(task.questions) : null;
  return {
    id: `${meta.executionId}:${task.humanTaskId}`,
    type: 'question',
    kind: task.kind,
    projectId: space.projectId,
    projectName: space.projectName ?? null,
    intentId: meta.executionId,
    intentTitle: meta.title ?? null,
    humanTaskId: task.humanTaskId,
    stageInstanceId: task.stageInstanceId ?? null,
    stageId: stage?.stageId ?? null,
    phase: stage?.phase ?? null,
    unitSlug: task.unitSlug ?? null,
    sectionIndex: task.sectionIndex ?? null,
    summary: collapse(task.kind === 'question' ? questions?.[0]?.text : task.prompt),
    questionCount: questions ? questions.length : null,
    checkpoint: task.detail?.checkpoint ?? null,
    createdAt: task.createdAt ?? null,
    eligibility: { basis: eligibility.basis, assignment: eligibility.assignment },
    target: {
      view: task.kind === 'validation' ? 'review' : 'gate',
      projectId: space.projectId,
      intentId: meta.executionId,
      humanTaskId: task.humanTaskId,
    },
  };
};

export const aggregatePendingQuestions = async ({
  userId,
  memberships,
  store,
  eligibility = answerEligibility,
  params,
  clock = Date.now,
  startedAt = clock(),
  logger = null,
}) => {
  const { limit, cursor, projectId, kinds } = params;
  const v2 = memberships.filter((m) => m.kind === 'v2');
  if (projectId && !v2.some((m) => m.projectId === projectId))
    throw new PendingQuestionsError(403, 'NOT_A_MEMBER', 'Not a project member');
  const spaces = (projectId ? v2.filter((m) => m.projectId === projectId) : v2).toSorted((a, b) =>
    cmp(a.projectId, b.projectId),
  );
  const unavailable = new Map();
  let limitExceeded = 0;
  let intentsRead = 0;
  const mark = (space, reason) => {
    if (reason === 'LIMIT_EXCEEDED') limitExceeded += 1;
    if (unavailable.get(space.projectId)?.reason === 'READ_FAILED') return;
    unavailable.set(space.projectId, {
      projectId: space.projectId,
      projectName: space.projectName ?? null,
      reason,
    });
  };
  const failed = (space, err, intentId) => {
    mark(space, 'READ_FAILED');
    logger?.warn('pending-questions read failed', {
      projectId: space.projectId,
      ...(intentId ? { intentId } : {}),
      errorName: err?.name ?? 'Error',
    });
  };
  const pastDeadline = () => clock() - startedAt >= AGGREGATION_DEADLINE_MS;

  for (const space of spaces.slice(MAX_SPACES)) mark(space, 'LIMIT_EXCEEDED');
  const read = spaces.slice(0, MAX_SPACES);

  // Phase 1: each space's live executions, WAITING then RUNNING, oldest first.
  const perSpace = await mapWithConcurrency(read, READ_CONCURRENCY, async (space) => {
    const seen = new Map();
    for (const status of LIVE_STATUSES) {
      if (pastDeadline()) {
        mark(space, 'LIMIT_EXCEEDED');
        break;
      }
      try {
        const rows = await store.listProjectExecutions({
          projectId: space.projectId,
          status,
          limit: MAX_LIVE_INTENTS_PER_SPACE + 1,
          oldestFirst: true,
        });
        // An execution changing status between the two queries can be in both.
        for (const row of rows) if (!seen.has(row.executionId)) seen.set(row.executionId, row);
      } catch (err) {
        failed(space, err);
      }
    }
    const executions = [...seen.values()];
    if (executions.length > MAX_LIVE_INTENTS_PER_SPACE) mark(space, 'LIMIT_EXCEEDED');
    return executions.slice(0, MAX_LIVE_INTENTS_PER_SPACE).map((meta) => ({ space, meta }));
  });

  const allIntents = perSpace.flat();
  for (const { space } of allIntents.slice(MAX_INTENT_READS)) mark(space, 'LIMIT_EXCEEDED');
  const intents = allIntents.slice(0, MAX_INTENT_READS);

  // Phase 2: each live execution's pending gates, filtered by the answer rule.
  const perIntent = await mapWithConcurrency(intents, READ_CONCURRENCY, async ({ space, meta }) => {
    const items = [];
    const intentId = meta.executionId;
    if (pastDeadline()) {
      mark(space, 'LIMIT_EXCEEDED');
      return items;
    }
    let tasks;
    intentsRead += 1;
    try {
      tasks = await store.listPendingHumanTasks(intentId, { limit: MAX_PENDING_PER_INTENT + 1 });
    } catch (err) {
      failed(space, err, intentId);
      return items;
    }
    if (tasks.length > MAX_PENDING_PER_INTENT) mark(space, 'LIMIT_EXCEEDED');
    const stages = new Map();
    for (const task of tasks.slice(0, MAX_PENDING_PER_INTENT)) {
      if (kinds && !kinds.includes(task.kind)) continue;
      try {
        let stage = null;
        if (task.stageInstanceId) {
          if (!stages.has(task.stageInstanceId)) {
            if (pastDeadline()) {
              mark(space, 'LIMIT_EXCEEDED');
              continue;
            }
            stages.set(task.stageInstanceId, await store.getStage(intentId, task.stageInstanceId));
          }
          stage = stages.get(task.stageInstanceId);
        }
        if (!isHumanTaskAnswerable({ task, meta, stage })) continue;
        const result = await eligibility({
          userId,
          membershipRole: space.role,
          projectId: space.projectId,
          task,
          meta,
        });
        if (!result?.eligible) continue;
        items.push(toItem({ space, meta, task, stage, eligibility: result }));
      } catch (err) {
        failed(space, err, intentId);
      }
    }
    return items;
  });

  const byId = new Map();
  for (const item of perIntent.flat()) if (!byId.has(item.id)) byId.set(item.id, item);
  const sorted = [...byId.values()]
    .map((item) => ({ item, key: sortKey(item) }))
    .toSorted((a, b) => compareKey(a.key, b.key));
  const after = cursor ? sorted.filter(({ key }) => compareKey(key, cursor) > 0) : sorted;
  const page = after.slice(0, limit);
  return {
    items: page.map(({ item }) => item),
    nextCursor: after.length > limit ? encodeCursor(page[page.length - 1].key) : null,
    unavailable: [...unavailable.values()].toSorted((a, b) => cmp(a.projectId, b.projectId)),
    generatedAt: new Date(clock()).toISOString(),
    stats: { spaces: read.length, intentsRead, limitExceeded },
  };
};
