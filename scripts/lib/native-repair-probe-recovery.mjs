import assert from 'node:assert/strict';
import { GetCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { nativeRuntimeBindingKey } from '../../lambda/shared/native-runtime-binding.js';
import { nativeRuntimeImageKey } from '../../lambda/native-runtime-control/runtime-images.js';

const executionIds = (start, length, step = 1) =>
  Array.from({ length: length / step }, (_, i) => `execution-${start + i * step}`);
const rowKey = ({ pk, sk }) => JSON.stringify([pk, sk]);

// Replace a slice of the ordinary probe's irrelevant rows. The oracle uses the
// fixture cohorts, independently of the production visitor or its scan order.
export function seedRecoveryRows(records, mix) {
  const cohortSize = mix.preparing;
  const pendingStart = records.length - mix.irrelevant;
  const expected = {
    execution: executionIds(0, 2 * cohortSize),
    preparation: executionIds(6 * cohortSize, cohortSize),
    cancellation: [
      ...executionIds(0, 4 * cohortSize, 2),
      ...executionIds(pendingStart, cohortSize),
    ],
    projection: [
      ...executionIds(0, 2 * cohortSize, 2),
      ...executionIds(4 * cohortSize, 2 * cohortSize, 2),
    ],
  };
  const revoked = `sha256:${'0'.repeat(64)}`;
  const unaffected = `sha256:${'1'.repeat(64)}`;
  const published = new Set(expected.projection);
  for (const row of records) {
    if (!published.has(row.scope?.executionId)) continue;
    // Scanner-visible committed publication pointer; no manifest or graph IO.
    const id = row.pk.slice('NATIVE#'.length);
    row.publication = {
      id,
      sequence: 1,
      outcome: row.status === 'STOPPED' ? 'STOPPED' : 'WAITING_FOR_INPUT',
      nativeSessionId: 'probe-session',
      filesCount: 0,
      question: null,
      manifest: { key: `probe/${id}`, versionId: 'probe-version', sha256: id, bytes: 1 },
    };
  }
  for (let i = pendingStart; i < pendingStart + cohortSize; i++) {
    const scope = { projectId: 'probe', executionId: `execution-${i}` };
    records[i] = {
      ...nativeRuntimeBindingKey(scope),
      sk: 'EXECUTION',
      scope,
      status: 'CANCEL_REQUESTED',
      cancelRequested: true,
      configuration: { image: { digest: unaffected } },
    };
  }
  records[pendingStart + cohortSize] = {
    ...nativeRuntimeImageKey(revoked),
    schemaVersion: 1,
    digest: revoked,
    revokedAt: 1,
    revokedBy: 'probe',
    reasonCode: 'probe_revocation',
  };
  mix.irrelevant -= cohortSize + 1;
  mix.pendingCancellation = cohortSize;
  mix.revocation = 1;
  return { expected, revoked, unaffected, publishedHeads: published.size };
}

// Compare exact pointer shape and address independently for each destination.
// A repeated receipt counts as a delivery even if its acknowledgement was lost.
export function queueReceipts(expected) {
  const targets = new Map(
    Object.keys(expected).map((target) => [target, { seen: new Set(), deliveries: 0 }]),
  );
  return {
    accept(target, body) {
      const receipts = targets.get(target);
      assert.ok(receipts, `Unknown probe queue ${target}`);
      const pointer = JSON.parse(body);
      const id = target === 'packages' ? pointer.jobId : pointer.executionId;
      assert.deepEqual(
        pointer,
        target === 'packages'
          ? { schemaVersion: 1, projectId: 'probe', jobId: id }
          : { projectId: 'probe', executionId: id },
      );
      const first = !receipts.seen.has(id);
      receipts.seen.add(id);
      receipts.deliveries++;
      return { id, first };
    },
    verify() {
      return Object.fromEntries(
        [...targets].map(([target, { seen, deliveries }]) => {
          assert.deepEqual(seen, new Set(expected[target]), `${target} pointer mismatch`);
          return [target, { unique: seen.size, deliveries }];
        }),
      );
    },
  };
}

export async function measureRecovery({
  raw,
  tableName,
  checkpointTable,
  rows,
  fixture,
  bridge,
  observe,
}) {
  // Use the scanner's real page limit to force multiple schedule entries without
  // making ability to reproduce a continuation depend on host elapsed time.
  const pageSize = Math.min(100, Math.floor(rows / 20));
  const maxPages = Math.max(1, Math.floor(rows / (pageSize * 8)));
  const bounds = { pageSize, maxPages };
  const cancelled = new Set(fixture.expected.cancellation);
  let loss, retry, healthyTail;
  const sweeps = [];
  for (const finalStatus of ['failed', 'complete']) {
    const receipts = queueReceipts(fixture.expected);
    const units = [];
    const warnings = [];
    let cursor = null;
    let firstScan;
    const ports = observe({
      recordLookups: true,
      onScan: (start) => {
        if (firstScan) assert.deepEqual(start ?? null, cursor, 'Scan did not use persisted cursor');
        firstScan = false;
      },
      deliver: (target, body) => {
        const { id, first } = receipts.accept(target, body);
        const invocation = units.length + 1;
        if (!loss && ['cancellation', 'projection'].includes(target)) {
          loss = { target, id, invocation };
          return {}; // The transport accepted the pointer, but returned no MessageId.
        }
        if (
          loss &&
          !healthyTail &&
          finalStatus === 'failed' &&
          invocation > loss.invocation &&
          first &&
          (target === 'preparation' || (target === 'execution' && !cancelled.has(id)))
        ) {
          healthyTail = { target, id, invocation };
        }
        if (finalStatus === 'complete' && loss.target === target && loss.id === id)
          retry ??= { invocation };
        return { MessageId: 'local-ack' };
      },
    });
    const reports = [];
    const run = bridge(
      {
        ...ports,
        logger: {
          info: (value) => reports.push(JSON.parse(value)),
          warn: (value) => warnings.push(JSON.parse(value)),
        },
      },
      bounds,
    );
    do {
      assert.ok(units.length < 1000, 'Recovery continuation bound exceeded');
      firstScan = true;
      const result = await run({ source: 'aws.events' });
      assert.equal(firstScan, false);
      const metric = reports.at(-1);
      assert.equal(metric.ScanCompleted, Number(result.repaired));
      assert.equal(metric.RepairErrors, result.errors);
      const { Item } = await raw.send(
        new GetCommand({
          TableName: checkpointTable,
          Key: { scope: 'runtime' },
          ConsistentRead: true,
        }),
      );
      assert.equal(Item.sourceTable, tableName);
      assert.equal(Item.owner, '');
      assert.equal(Item.leaseExpiresAt, 0);
      cursor = Item.cursor;
      units.push({
        status: result.status,
        pages: result.pages,
        scanned: metric.ScannedRows,
        scanCapacity: metric.ScanCapacityUnits,
        durationMs: metric.DurationMs,
        errors: metric.RepairErrors,
        sendsAcknowledged: result.sends,
        revocationLookups: result.revocationLookups,
      });
      if (result.status === 'continued') {
        assert.ok(cursor);
        if (finalStatus === 'failed' && loss && !loss.checkpoint) {
          assert.equal(Item.failures, 1);
          loss.checkpoint = { cursor, failures: Item.failures, released: true };
        }
      } else {
        assert.equal(result.status, finalStatus);
        assert.equal(result.repaired, finalStatus === 'complete');
        assert.equal(cursor, null);
        assert.equal(Item.failures, 0);
        assert.equal(Number.isSafeInteger(Item.lastCompletedAt), result.repaired);
      }
    } while (cursor);
    assert.ok(units.length > 1);
    assert.equal(reports.length, units.length);
    assert.deepEqual(
      warnings,
      finalStatus === 'failed'
        ? [
            {
              event: 'native_repair_row_failed',
              scope: 'runtime',
              key: {
                ...nativeRuntimeBindingKey({ projectId: 'probe', executionId: loss.id }),
                sk: 'EXECUTION',
              },
            },
          ]
        : [],
    );
    const targets = receipts.verify();
    const sum = (name) => units.reduce((total, unit) => total + unit[name], 0);
    assert.equal(sum('sendsAcknowledged') + warnings.length, ports.operations.SendMessageCommand);
    assert.equal(sum('errors'), warnings.length);
    const pages = sum('pages');
    assert.deepEqual(
      new Set(Object.keys(ports.lookups)),
      new Set([fixture.revoked, fixture.unaffected]),
    );
    for (const { reads } of Object.values(ports.lookups))
      assert.ok(reads > 0 && reads <= pages, 'Expected at most one lookup per digest per page');
    assert.equal(
      sum('revocationLookups'),
      Object.values(ports.lookups).reduce((n, v) => n + v.reads, 0),
    );
    sweeps.push({
      finalStatus,
      durationMs: sum('durationMs'),
      pages,
      scanned: sum('scanned'),
      invocations: units.length,
      revocationLookups: sum('revocationLookups'),
      sendsAcknowledged: sum('sendsAcknowledged'),
      operations: ports.operations,
      localCapacityUnits: ports.capacity,
      lookups: ports.lookups,
      maxOutstanding: ports.maxOutstanding,
      targets,
      units,
    });
  }
  assert.ok(
    loss.checkpoint && retry && healthyTail,
    'Missing pre-continuation loss, later healthy work or retry',
  );
  const { revoked, unaffected, publishedHeads } = fixture;
  return { ...bounds, revoked, unaffected, publishedHeads, loss, retry, healthyTail, sweeps };
}

export async function verifySourceRows(raw, tableName, records) {
  const remaining = new Map(records.map((row) => [rowKey(row), row]));
  let cursor;
  do {
    const page = await raw.send(
      new ScanCommand({ TableName: tableName, ConsistentRead: true, ExclusiveStartKey: cursor }),
    );
    for (const row of page.Items) {
      const key = rowKey(row);
      assert.deepEqual(row, remaining.get(key), 'Repair changed a source row');
      remaining.delete(key);
    }
    cursor = page.LastEvaluatedKey;
  } while (cursor);
  assert.equal(remaining.size, 0, 'Repair removed a source row');
  return records.length;
}
