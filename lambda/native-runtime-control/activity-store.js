// Trusted native adapter for the existing OUTPUT history schema. Only the
// controller writes this table; the runtime can only offer a scoped batch.
import { createHash } from 'node:crypto';
import { GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { buildOutputRow } from '../shared/v2-process-keys.js';
import {
  nativeExecutionKey,
  nativeTurnSequence,
  nativeWriterGeneration,
} from './execution-store.js';
import { canonicalJson } from '../shared/workflow-checkpoint.js';
import { nativePublicActivity, NATIVE_ACTIVITY_LIMITS } from '../shared/native-activity.js';
import { nativeHistoryView } from './execution-history.js';

const fail = () => {
  throw Object.assign(new Error('Native activity ownership or ordering changed'), {
    code: 'NATIVE_ACTIVITY_CONFLICT',
  });
};
const digest = (value) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const outputKey = (pk, seq) => ({ pk, sk: `OUTPUT#${String(seq).padStart(16, '0')}` });
const view = (row) => ({
  seq: row.seq,
  stageInstanceId: null,
  kind: row.kind,
  content: row.content,
  display: row.display,
  timestamp: row.timestamp,
});

export const createNativeActivityStore = ({
  ddb,
  tableName,
  now = Date.now,
  broadcast = async () => {},
}) => {
  const cursorKey = (scope) => ({ ...nativeExecutionKey(scope), sk: 'OUTPUT_CURSOR' });
  const get = async (Key) =>
    (await ddb.send(new GetCommand({ TableName: tableName, Key, ConsistentRead: true }))).Item;
  const cursor = async (row) => {
    const saved = await get(cursorKey(row.scope));
    return saved?.writerGeneration === nativeWriterGeneration(row) ? saved.index : 0;
  };
  const ingest = async (row, batch) => {
    const generation = nativeWriterGeneration(row);
    if (
      !row.leaseToken ||
      row.leaseExpiresAt <= now() ||
      row.cancelRequested ||
      batch?.writerGeneration !== generation ||
      !Array.isArray(batch.events) ||
      batch.events.length > NATIVE_ACTIVITY_LIMITS.batchEvents ||
      !Number.isSafeInteger(batch.after) ||
      batch.after < 0 ||
      ['projectId', 'executionId'].some((k) => batch[k] !== row.scope[k]) ||
      ['bindingId', 'attemptId', 'epoch', 'runtimeSessionId'].some((k) => batch[k] !== row[k])
    )
      fail();
    const key = cursorKey(row.scope);
    const previous = await get(key);
    const sameWriter = previous?.writerGeneration === generation;
    const index = sameWriter ? previous.index : 0;
    const base = sameWriter ? previous.seq - previous.index : (previous?.seq ?? 0);
    if (batch.after > index) fail();
    const rows = [];
    for (const [offset, event] of batch.events.entries()) {
      if (
        event.index !== batch.after + offset + 1 ||
        event.writerGeneration !== generation ||
        event.sequence !== nativeTurnSequence(row) ||
        !['stdout', 'lifecycle'].includes(event.kind) ||
        !Number.isSafeInteger(event.capturedAt) ||
        event.capturedAt < 0 ||
        event.capturedAt > now() + 60_000 ||
        typeof event.content !== 'string' ||
        Buffer.byteLength(JSON.stringify(event)) > 32 * 1024 ||
        Object.keys(event).some(
          (k) =>
            ![
              'index',
              'writerGeneration',
              'sequence',
              'kind',
              'capturedAt',
              'content',
              'display',
            ].includes(k),
        )
      )
        fail();
      const seq = base + event.index;
      if (!Number.isSafeInteger(seq)) fail();
      const publicEvent = nativePublicActivity(event);
      if (!publicEvent) fail();
      const hash = digest(event);
      if (event.index <= index) {
        const stored = await get(outputKey(key.pk, seq));
        if (stored?.eventSha256 !== hash) fail();
        continue;
      }
      rows.push({
        ...buildOutputRow({
          executionId: row.scope.executionId,
          seq,
          kind: event.kind,
          ...publicEvent,
          now: new Date(event.capturedAt).toISOString(),
        }),
        ...outputKey(key.pk, seq),
        projectId: row.scope.projectId,
        attemptId: row.attemptId,
        epoch: row.epoch,
        writerGeneration: generation,
        turnSequence: event.sequence,
        eventIndex: event.index,
        eventSha256: hash,
      });
    }
    if (!rows.length) {
      const latest = await get(nativeExecutionKey(row.scope));
      if (
        !latest ||
        [
          'version',
          'bindingId',
          'configurationSha256',
          'attemptId',
          'epoch',
          'runtimeSessionId',
          'leaseToken',
        ].some((k) => latest[k] !== row[k]) ||
        nativeWriterGeneration(latest) !== generation ||
        nativeTurnSequence(latest) !== nativeTurnSequence(row) ||
        latest.leaseExpiresAt <= now() ||
        latest.cancelRequested
      )
        fail();
      return index;
    }
    if (rows[0].eventIndex !== index + 1) fail();
    const fields = [
      'version',
      'bindingId',
      'attemptId',
      'epoch',
      'runtimeSessionId',
      'configurationSha256',
      'leaseToken',
      ...['writerGeneration', 'turnSequence'].filter((k) => row[k] !== undefined),
    ];
    const names = Object.fromEntries(fields.map((k) => [`#${k}`, k]));
    const values = Object.fromEntries(fields.map((k) => [`:${k}`, row[k]]));
    const next = {
      ...key,
      writerGeneration: generation,
      index: rows.at(-1).eventIndex,
      seq: rows.at(-1).seq,
    };
    // No acknowledgment on failure, including an ambiguous transaction response.
    // Retry compares the immutable event hashes before acknowledging a duplicate.
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            ConditionCheck: {
              TableName: tableName,
              Key: nativeExecutionKey(row.scope),
              ConditionExpression:
                fields.map((k) => `#${k} = :${k}`).join(' AND ') +
                ' AND leaseExpiresAt > :now AND cancelRequested = :false',
              ExpressionAttributeNames: names,
              ExpressionAttributeValues: { ...values, ':now': now(), ':false': false },
            },
          },
          {
            Put: {
              TableName: tableName,
              Item: next,
              ConditionExpression: previous
                ? '#seq = :seq AND writerGeneration = :generation AND #index = :index'
                : 'attribute_not_exists(pk)',
              ...(previous
                ? {
                    ExpressionAttributeNames: { '#seq': 'seq', '#index': 'index' },
                    ExpressionAttributeValues: {
                      ':seq': previous.seq,
                      ':generation': previous.writerGeneration,
                      ':index': previous.index,
                    },
                  }
                : {}),
            },
          },
          ...rows.map((Item) => ({
            Put: { TableName: tableName, Item, ConditionExpression: 'attribute_not_exists(pk)' },
          })),
        ],
      }),
    );
    // Native sockets receive content-free invalidations only. Token expiry is
    // not current membership; the authorized REST read supplies public fields.
    for (const output of rows) {
      try {
        await broadcast(row.scope, {
          action: 'agent.output',
          executionBackend: 'native',
          projectId: row.scope.projectId,
          intentId: row.scope.executionId,
          executionId: row.scope.executionId,
          seq: output.seq,
        });
      } catch {
        // Persistence is the acknowledgement boundary, including synchronous
        // broadcaster failures. Polling/reconnect reads repair lost hints.
      }
    }
    return next.index;
  };
  const page = async (scope, after, prefix, select, sequence) => {
    if (!Number.isSafeInteger(after) || after < 0) fail();
    const key = nativeExecutionKey(scope);
    const result = await ddb.send(
      new QueryCommand({
        TableName: tableName,
        ConsistentRead: true,
        KeyConditionExpression: 'pk = :pk AND sk BETWEEN :after AND :end',
        ExpressionAttributeValues: {
          ':pk': key.pk,
          ':after': `${prefix}#${String(after + 1).padStart(16, '0')}`,
          ':end': `${prefix}$`,
        },
        Limit: 64,
      }),
    );
    // An unavailable/partial read must not masquerade as an empty history.
    if (!Array.isArray(result.Items) || (result.LastEvaluatedKey && !result.Items.length)) fail();
    const rows = result.Items.map(select);
    return { rows, nextAfter: result.LastEvaluatedKey ? rows.at(-1)[sequence] : null };
  };
  const history = async (scope, after = 0) => {
    const result = await page(scope, after, 'OUTPUT', view, 'seq');
    return { outputs: result.rows, nextAfter: result.nextAfter };
  };
  const events = async (scope, after = 0) => {
    const result = await page(scope, after, 'EVENT', nativeHistoryView, 'revision');
    return { events: result.rows, nextEventAfter: result.nextAfter };
  };
  return { cursor, ingest, history, events };
};
