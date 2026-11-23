import assert from 'node:assert/strict';
import test from 'node:test';
import { queueReceipts } from '../lib/native-repair-probe-recovery.mjs';

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
