import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  initializeDeployedNativeSpaceInventory,
  prepareNativeSpaceInventoryApply,
} from '../initialize-native-space-inventory.mjs';
import { inventoryFixture } from './helpers/native-space-inventory.mjs';
import {
  nativeSpaceInventoryKey,
  nativeSpaceRetentionKey,
} from '../../lambda/shared/native-space-inventory.js';
import { nativeDependencyInventory, assertNativeRemoval } from '../lib/native-dependencies.mjs';

const ready = { ...nativeSpaceInventoryKey, version: 1 };
test('missing, unfenced, weighted or changing authorities and incomplete scans cannot certify absence', async () => {
  for (const fault of [
    'table',
    'read',
    'alias',
    'old-writer',
    'old-owner',
    'weighted',
    'changed',
    'partial',
  ]) {
    const f = inventoryFixture({ historical: true, fault });
    await assert.rejects(initializeDeployedNativeSpaceInventory(f.target), undefined, fault);
    assert.ok(!f.events.includes('ready'), fault);
  }
});

test('an acknowledged or ambiguous terminal receipt is reusable until the writer, owner or table changes', async () => {
  const state = { historical: true, fault: 'lost-ack' };
  const f = inventoryFixture(state);
  await assert.rejects(initializeDeployedNativeSpaceInventory(f.target), /lost acknowledgement/);
  assert.deepEqual(state.retained, nativeSpaceRetentionKey('legacy-space'));
  assert.deepEqual(state.receipt.coverage, {
    tableId: 'incarnation-1',
    commandsRevision: 'stable',
    projectsRevision: 'owner-1',
  });
  delete state.fault;
  for (const [field, value] of [
    ['alias', 're-promoted-7'],
    ['tableId', 'restored'],
  ]) {
    f.events.length = 0;
    await prepareNativeSpaceInventoryApply(f.target);
    assert.deepEqual(await initializeDeployedNativeSpaceInventory(f.target), {
      alreadyReady: true,
    });
    assert.ok(!f.events.some((event) => ['pending', 'drain', 'scan', 'ready'].includes(event)));
    state[field] = value;
    await prepareNativeSpaceInventoryApply(f.target);
    assert.equal(state.receipt.version, 0);
    state.fault = 'partial';
    await assert.rejects(initializeDeployedNativeSpaceInventory(f.target), /Incomplete/);
    assert.equal(state.receipt.version, 0);
    delete state.fault;
    assert.deepEqual(await initializeDeployedNativeSpaceInventory(f.target), { bindings: 1 });
    assert.equal(state.receipt.version, 1);
  }
});

test('an absent commands alias withdraws old coverage before restore; an access error stops the apply', async () => {
  const state = {};
  const f = inventoryFixture(state);
  await initializeDeployedNativeSpaceInventory(f.target);
  state.fault = 'alias';
  await assert.rejects(prepareNativeSpaceInventoryApply(f.target), /denied/);
  assert.equal(state.receipt.version, 1);
  state.fault = 'missing-alias';
  await prepareNativeSpaceInventoryApply(f.target);
  assert.equal(state.receipt.version, 0);
  await assert.rejects(initializeDeployedNativeSpaceInventory(f.target), /Missing alias/);
  delete state.fault;
  assert.deepEqual(await initializeDeployedNativeSpaceInventory(f.target), { bindings: 0 });
});

test('competing readiness publication requires an ordinary reread and preserves the pending receipt', async () => {
  const state = { receipt: { ...ready }, fault: 'competing-receipt' };
  const f = inventoryFixture(state);
  await assert.rejects(
    initializeDeployedNativeSpaceInventory(f.target),
    /ConditionalCheckFailedException/,
  );
  assert.equal(state.receipt.version, 0);
  delete state.fault;
  assert.deepEqual(await initializeDeployedNativeSpaceInventory(f.target), { bindings: 0 });
});

test('a Projects-only update drains prior handlers and preserves continuous writer coverage', async () => {
  const state = {};
  const f = inventoryFixture(state);
  await initializeDeployedNativeSpaceInventory(f.target);
  state.owner = 'updated-owner';
  f.events.length = 0;
  await prepareNativeSpaceInventoryApply(f.target);
  assert.deepEqual(await initializeDeployedNativeSpaceInventory(f.target), { alreadyReady: true });
  assert.ok(!f.events.some((event) => ['scan', 'pending'].includes(event)));
  assert.ok(f.events.includes('drain'));
  assert.equal(state.receipt.coverage.projectsRevision, state.owner);
});

test('legacy coverage is requalified once, unknown receipt data is preserved', async () => {
  const state = { receipt: { ...ready }, historical: true };
  const f = inventoryFixture(state);
  await prepareNativeSpaceInventoryApply(f.target);
  assert.equal(state.receipt.version, 0);
  await initializeDeployedNativeSpaceInventory(f.target);
  assert.deepEqual(state.retained, nativeSpaceRetentionKey('legacy-space'));
  state.receipt.extra = 'unknown';
  await assert.rejects(initializeDeployedNativeSpaceInventory(f.target), /Unrecognized/);
  assert.equal(state.receipt.extra, 'unknown');
  assert.equal(state.receipt.version, 0);
});

test('the exact empty-inventory receipt introduces no work dependency; retained and malformed records still protect storage', () => {
  const decommission = (rows) =>
    assertNativeRemoval(nativeDependencyInventory(rows), {
      admissionClosed: true,
      dependencies: [],
      entireService: true,
    });
  assert.equal(decommission([ready]), true);
  assert.equal(
    decommission([
      {
        ...ready,
        coverage: {
          tableId: 'incarnation-1',
          commandsRevision: 'stable',
          projectsRevision: 'owner-1',
        },
      },
    ]),
    true,
  );
  assert.equal(nativeDependencyInventory([ready]).records, 1);
  for (const row of [
    { ...ready, extra: 'history' },
    { ...ready, coverage: 'invalid' },
    { ...ready, version: 0 },
    { ...ready, version: 2 },
    nativeSpaceRetentionKey('fixture'),
  ])
    assert.throws(() => decommission([row]), /protected records/);
});
