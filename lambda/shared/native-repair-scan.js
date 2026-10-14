// Checkpoints are scheduling hints in a separate table, never execution/job
// authority. Only the scoped repair role may write its checkpoint. A failed
// batch is revisited next sweep; a crashed batch is replayed after lease expiry.
import { randomUUID } from 'node:crypto';
import { GetCommand, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';

const invalid = () => {
  throw new Error('Native repair checkpoint invalid or ownership lost');
};
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const keyFor = (row, fields) => {
  const key = Object.fromEntries(fields.map((field) => [field, row[field]]));
  if (Object.values(key).some((value) => typeof value !== 'string' || !value.length)) invalid();
  return key;
};
const validCursor = (cursor, fields) =>
  cursor === null ||
  (cursor &&
    Object.keys(cursor).length === fields.length &&
    fields.every((field) => typeof cursor[field] === 'string' && cursor[field].length > 0));

export const nativeRepairClientOptions = {
  maxAttempts: 1,
  requestHandler: { connectionTimeout: 2000, requestTimeout: 5000, throwOnRequestTimeout: true },
};

const checkpointStore = ({ ddb, checkpointTable, tableName, scope, keyFields, now }) => {
  const validate = (row) => {
    if (
      row?.schemaVersion !== 1 ||
      row.scope !== scope ||
      row.sourceTable !== tableName ||
      typeof row.revision !== 'string' ||
      typeof row.owner !== 'string' ||
      !integer(row.leaseExpiresAt, 0, Number.MAX_SAFE_INTEGER) ||
      !integer(row.cycleStartedAt, 0, Number.MAX_SAFE_INTEGER) ||
      !integer(row.failures, 0, Number.MAX_SAFE_INTEGER) ||
      !validCursor(row.cursor, keyFields)
    )
      invalid();
    return row;
  };
  const save = async (previous, next, signal, owned = true) => {
    const time = now();
    if (owned && previous.leaseExpiresAt <= time) invalid();
    next.revision = randomUUID();
    await ddb.send(
      new PutCommand({
        TableName: checkpointTable,
        Item: validate(next),
        ConditionExpression: previous
          ? `#revision = :revision${owned ? ' AND #owner = :owner AND leaseExpiresAt > :now' : ''}`
          : 'attribute_not_exists(#scope)',
        ExpressionAttributeNames: previous
          ? { '#revision': 'revision', ...(owned ? { '#owner': 'owner' } : {}) }
          : { '#scope': 'scope' },
        ...(previous
          ? {
              ExpressionAttributeValues: {
                ':revision': previous.revision,
                ...(owned ? { ':owner': previous.owner, ':now': time } : {}),
              },
            }
          : {}),
      }),
      { abortSignal: signal },
    );
    // An unacknowledged write leaves the lease intact. A later schedule reads
    // the committed checkpoint; it never guesses whether progress was saved.
    return next;
  };
  return {
    save,
    async claim(signal) {
      const { Item } = await ddb.send(
        new GetCommand({
          TableName: checkpointTable,
          Key: { scope },
          ConsistentRead: true,
        }),
        { abortSignal: signal },
      );
      const previous = Item ? validate(Item) : null;
      const time = now();
      if (previous?.leaseExpiresAt > time) return null;
      const next = {
        schemaVersion: 1,
        scope,
        sourceTable: tableName,
        cursor: null,
        cycleStartedAt: time,
        failures: 0,
        ...previous,
        owner: randomUUID(),
        // Exceeds the deployed Lambda's maximum lifetime (900 seconds).
        leaseExpiresAt: time + 960_000,
      };
      try {
        return await save(previous, next, signal, false);
      } catch (error) {
        if (error?.name === 'ConditionalCheckFailedException') return null;
        throw error;
      }
    },
  };
};

const report = (logger, scope, tableName, stats, started, now) => {
  const metrics = {
    ScanCompleted: stats.repaired ? 1 : 0,
    RepairErrors: stats.errors,
    DurationMs: Math.max(0, now() - started),
    ScannedRows: stats.scanned,
    ScanCapacityUnits: stats.scanCapacity,
  };
  logger.info(
    JSON.stringify({
      _aws: {
        Timestamp: now(),
        CloudWatchMetrics: [
          {
            Namespace: 'NativeRepair',
            Dimensions: [['Scope', 'SourceTable']],
            Metrics: Object.keys(metrics).map((Name) => ({ Name })),
          },
        ],
      },
      event: 'native_repair_scan',
      Scope: scope,
      SourceTable: tableName,
      ...stats,
      ...metrics,
    }),
  );
};

export const createNativeRepairScan = ({
  ddb,
  tableName,
  checkpointTable,
  scope,
  keyFields,
  scanInput = {},
  visit,
  now = Date.now,
  logger = console,
  pageSize = 100,
  concurrency = 4,
  budgetMs = 240_000,
  maxPages = 1000,
}) => {
  if (
    !checkpointTable ||
    !['runtime', 'packages'].includes(scope) ||
    !integer(pageSize, 1, 1000) ||
    !integer(concurrency, 1, 16) ||
    !integer(budgetMs, 1, 840_000) ||
    !integer(maxPages, 1, 10_000)
  )
    invalid();
  const store = checkpointStore({ ddb, checkpointTable, tableName, scope, keyFields, now });
  return async (context) => {
    const started = now();
    const remaining = context?.getRemainingTimeInMillis?.() ?? 900_000;
    if (!Number.isFinite(remaining) || remaining <= 30_000) invalid();
    const budget = Math.min(budgetMs, remaining - 30_000);
    const signal = AbortSignal.timeout(Math.min(budget + 10_000, remaining - 10_000));
    const deadline = started + budget;
    const stats = {
      status: 'continued',
      repaired: false,
      pages: 0,
      scanned: 0,
      scanCapacity: 0,
      errors: 0,
      sends: 0,
      revocationLookups: 0,
      jobReads: 0,
    };
    let state;
    const checkpoint = async (fields) => {
      state = await store.save(state, { ...state, ...fields }, signal);
    };
    const processPage = async (page) => {
      // Cache lifetime is exactly this page. It is never authorization and does
      // not survive a continuation, next sweep, or new stream invocation.
      const cache = new Map();
      const items = page.Items ?? [];
      for (let offset = 0; offset < items.length; offset += concurrency) {
        if (now() >= deadline || signal.aborted) return false;
        const batch = items.slice(offset, offset + concurrency);
        const outcomes = await Promise.allSettled(
          batch.map((row) => visit(row, { signal, cache, stats })),
        );
        if (signal.aborted || now() >= deadline) return false;
        outcomes.forEach((outcome, index) => {
          if (outcome.status === 'rejected') {
            stats.errors++;
            logger.warn(
              JSON.stringify({
                event: 'native_repair_row_failed',
                scope,
                key: keyFor(batch[index], keyFields),
              }),
            );
          }
        });
        await checkpoint({
          cursor: keyFor(batch.at(-1), keyFields),
          failures: state.failures + outcomes.filter((o) => o.status === 'rejected').length,
        });
      }
      return true;
    };
    try {
      state = await store.claim(signal);
      if (!state) {
        stats.status = 'busy';
        return stats;
      }
      while (now() < deadline && !signal.aborted && stats.pages < maxPages) {
        const page = await ddb.send(
          new ScanCommand({
            ...scanInput,
            TableName: tableName,
            ConsistentRead: true,
            Limit: pageSize,
            ReturnConsumedCapacity: 'TOTAL',
            ...(state.cursor ? { ExclusiveStartKey: state.cursor } : {}),
          }),
          { abortSignal: signal },
        );
        stats.pages++;
        stats.scanned += page.ScannedCount ?? page.Items?.length ?? 0;
        stats.scanCapacity += page.ConsumedCapacity?.CapacityUnits ?? 0;
        if (!(await processPage(page))) break;
        if (!page.LastEvaluatedKey) {
          stats.repaired = state.failures === 0;
          stats.status = stats.repaired ? 'complete' : 'failed';
          await checkpoint({
            cursor: null,
            failures: 0,
            cycleStartedAt: now(),
            ...(stats.repaired ? { lastCompletedAt: now() } : {}),
          });
          break;
        }
        await checkpoint({ cursor: keyFor(page.LastEvaluatedKey, keyFields) });
      }
      // Release only acknowledged progress. Hard timeout or lost release
      // acknowledgement leaves a lease that the next schedule can take over.
      await checkpoint({ owner: '', leaseExpiresAt: 0 });
      return stats;
    } catch (error) {
      stats.errors++;
      stats.status = 'failed';
      stats.repaired = false;
      throw error;
    } finally {
      report(logger, scope, tableName, stats, started, now);
    }
  };
};
