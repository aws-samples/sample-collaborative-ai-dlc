import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { nativeRuntimeImageKey } from './runtime-images.js';
import { nativeRuntimeBindingKey } from '../shared/native-runtime-binding.js';
import { createNativeRepairScan, nativeRepairClientOptions } from '../shared/native-repair-scan.js';

// Native control records contain JSON scalars, maps and lists only. Reject
// unsupported stream attributes rather than interpreting binary/sets as authority.
const attribute = (value) => {
  if (Object.hasOwn(value, 'S')) return value.S;
  if (Object.hasOwn(value, 'N')) return Number(value.N);
  if (Object.hasOwn(value, 'BOOL')) return value.BOOL;
  if (value.NULL === true) return null;
  if (value.L) return value.L.map(attribute);
  if (value.M) return unmarshall(value.M);
  throw new Error('Unsupported native stream attribute');
};
const unmarshall = (map) =>
  Object.fromEntries(Object.entries(map).map(([k, v]) => [k, attribute(v)]));

const ACTIVE = new Set(['REQUESTED', 'UPGRADING', 'DISPATCHING', 'RUNNING', 'RECOVERING']);
const identity = (row) => {
  const value = row.sk === 'EXECUTION' ? row.scope : row;
  const pointer = { projectId: value?.projectId, executionId: value?.executionId };
  if (row.pk !== nativeRuntimeBindingKey(pointer).pk)
    throw new Error('Native wakeup scope mismatch');
  return pointer;
};
const canCancel = (row) =>
  row.sk === 'EXECUTION' && !['STOPPED', 'FAILED', 'CANCELLED'].includes(row.status);

export const nativeWakeupTargets = (row, previous) => {
  if (!row) return [];
  if (row.sk === 'RUNTIME' && row.status === 'PREPARING')
    return previous?.status === 'PREPARING' ? [] : ['preparation'];
  if (row.sk !== 'EXECUTION') return [];
  const targets = [];
  if (row.status === 'CANCEL_REQUESTED' && previous?.status !== row.status)
    targets.push('cancellation');
  else if (
    ACTIVE.has(row.status) &&
    (!previous ||
      previous.status !== row.status ||
      previous.response?.commandId !== row.response?.commandId ||
      previous.recovery?.id !== row.recovery?.id)
  )
    targets.push('execution');
  if (row.publication && (!previous || previous.publication?.id !== row.publication.id))
    targets.push('projection');
  return targets;
};

// Stream notification reduces latency. A periodic consistent table scan repairs
// expired stream records, consumer restarts and lost normal polling messages.
// Pointers contain no authority. The consumer always reloads protected state.
export const createNativeWakeupBridge = ({
  ddb,
  sqs,
  tableName,
  checkpointTable,
  queues,
  logger = console,
  repairOptions = {},
}) => {
  const send = async (target, row, signal, stats) => {
    const result = await sqs.send(
      new SendMessageCommand({
        QueueUrl: queues[target],
        MessageBody: JSON.stringify(identity(row)),
      }),
      { abortSignal: signal },
    );
    if (!result?.MessageId) throw new Error('Native wakeup unacknowledged');
    if (stats) stats.sends++;
  };
  const repairRow = async (row, { signal, cache, stats }) => {
    identity(row);
    const targets = new Set(nativeWakeupTargets(row));
    let lookupFailed = false;
    // This page shares lookup work only for notification hints. Authorization
    // still re-reads absent revocations on every call. A revocation racing this
    // page is rediscovered by the next sweep, including for quiet waits.
    if (canCancel(row) && row.configuration?.image?.digest) {
      const digest = row.configuration.image.digest;
      if (!cache.has(digest)) {
        stats.revocationLookups++;
        cache.set(
          digest,
          ddb.send(
            new GetCommand({
              TableName: tableName,
              ConsistentRead: true,
              Key: nativeRuntimeImageKey(digest),
            }),
            { abortSignal: signal },
          ),
        );
      }
      try {
        const revoked = await cache.get(digest);
        if (revoked.Item) targets.add('cancellation');
      } catch {
        // A failed lookup is not proof of authorization. Consumers recheck it;
        // still deliver already-pending cancellation and other durable hints.
        lookupFailed = true;
      }
    }
    // A failed ordinary send must not prevent the independent cancellation or
    // projection hint. Report failure after all targets have been attempted.
    const sent = await Promise.allSettled(
      [...targets].map((target) => send(target, row, signal, stats)),
    );
    if (lookupFailed || sent.some((outcome) => outcome.status === 'rejected'))
      throw new Error('Native wakeup incomplete');
  };
  const repair = createNativeRepairScan({
    ...repairOptions,
    ddb,
    tableName,
    checkpointTable,
    scope: 'runtime',
    keyFields: ['pk', 'sk'],
    scanInput: {
      FilterExpression: '#sk IN (:runtime, :execution)',
      ExpressionAttributeNames: { '#sk': 'sk' },
      ExpressionAttributeValues: { ':runtime': 'RUNTIME', ':execution': 'EXECUTION' },
    },
    visit: repairRow,
    logger,
  });
  return async (event, context) => {
    if (event?.source === 'aws.events') {
      return repair(context);
    }
    const batchItemFailures = [];
    let revocationRepair;
    for (const record of event?.Records ?? []) {
      try {
        const row = record.dynamodb?.NewImage ? unmarshall(record.dynamodb.NewImage) : null;
        const prior = record.dynamodb?.OldImage ? unmarshall(record.dynamodb.OldImage) : null;
        if (row?.sk === 'REVOCATION' && row.pk?.startsWith('NATIVE_RUNTIME_IMAGE#')) {
          nativeRuntimeImageKey(row.pk.slice('NATIVE_RUNTIME_IMAGE#'.length));
          // Reuse the scoped resumable sweep. Concurrent revocations cannot
          // overwrite its cursor, and periodic sweeps outlive stream retention.
          // One sweep checks all pinned digests. A burst of revocation records
          // must not start fifty identical scans within one stream invocation.
          revocationRepair ??= repair(context);
          const result = await revocationRepair;
          if (result.status === 'failed') throw new Error('Native revocation repair incomplete');
        } else for (const target of nativeWakeupTargets(row, prior)) await send(target, row);
      } catch {
        logger.warn(JSON.stringify({ event: 'native_wakeup_retry' }));
        batchItemFailures.push({ itemIdentifier: record.dynamodb.SequenceNumber });
      }
    }
    return { batchItemFailures };
  };
};

export const handler = (event, context) =>
  createNativeWakeupBridge({
    ddb: DynamoDBDocumentClient.from(new DynamoDBClient(nativeRepairClientOptions)),
    sqs: new SQSClient(nativeRepairClientOptions),
    tableName: process.env.NATIVE_RUNTIME_BINDINGS_TABLE,
    checkpointTable: process.env.NATIVE_REPAIR_CHECKPOINT_TABLE,
    queues: {
      preparation: process.env.NATIVE_RUNTIME_QUEUE_URL,
      execution: process.env.NATIVE_EXECUTION_QUEUE_URL,
      cancellation: process.env.NATIVE_CANCELLATION_QUEUE_URL,
      projection: process.env.NATIVE_PROJECTION_QUEUE_URL,
    },
  })(event, context);
