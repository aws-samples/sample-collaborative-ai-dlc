import assert from 'node:assert/strict';
import test from 'node:test';
import { queueReceipts, seedRecoveryRows } from '../lib/native-repair-probe-recovery.mjs';

const pointer = (executionId) => JSON.stringify({ projectId: 'probe', executionId });

test('rejects two swapped queues even when their counts are correct', () => {
  const receipts = queueReceipts({ cancellation: ['cancelled'], projection: ['published'] });
  receipts.accept('cancellation', pointer('published'));
  receipts.accept('projection', pointer('cancelled'));
  assert.throws(() => receipts.verify(), /cancellation pointer mismatch/);
});

test('counts replay separately and still requires each expected pointer', () => {
  const receipts = queueReceipts({ execution: ['running', 'recovering'] });
  receipts.accept('execution', pointer('running'));
  receipts.accept('execution', pointer('running'));
  assert.throws(() => receipts.verify(), /execution pointer mismatch/);
  receipts.accept('execution', pointer('recovering'));
  assert.deepEqual(receipts.verify(), { execution: { unique: 2, deliveries: 3 } });
});

test('requires the expected project and package pointer shape', () => {
  const receipts = queueReceipts({ packages: ['queued-job'] });
  const job = { schemaVersion: 1, projectId: 'probe', jobId: 'queued-job' };
  assert.throws(() => receipts.accept('packages', pointer('queued-job')));
  assert.throws(() => receipts.accept('packages', JSON.stringify({ ...job, projectId: 'other' })));
  receipts.accept('packages', JSON.stringify(job));
  assert.deepEqual(receipts.verify(), { packages: { unique: 1, deliveries: 1 } });
});

// Execution 2 and 3 are the quiet waits in the minimum recovery fixture.
test('both waiting publications are projected, only the revoked wait is cancelled', () => {
  const records = Array.from({ length: 100 }, () => ({}));
  for (const i of [2, 3]) {
    records[i] = {
      pk: `NATIVE#${String(i).repeat(64)}`,
      sk: 'EXECUTION',
      scope: { projectId: 'probe', executionId: `execution-${i}` },
      status: 'AWAITING_USER',
    };
  }
  const { expected } = seedRecoveryRows(records, { preparing: 1, irrelevant: 13 });
  for (const row of records.slice(2, 4)) {
    assert.equal(row.projectionStatus, 'pending');
    assert.ok(row.publication.question);
    assert.ok(expected.projection.includes(row.scope.executionId));
    assert.equal(expected.execution.includes(row.scope.executionId), false);
  }
  assert.ok(expected.cancellation.includes('execution-2'));
  assert.equal(expected.cancellation.includes('execution-3'), false);
});
