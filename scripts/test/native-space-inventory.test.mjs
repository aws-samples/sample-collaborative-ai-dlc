import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GetAliasCommand } from '@aws-sdk/client-lambda';
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { initializeDeployedNativeSpaceInventory } from '../initialize-native-space-inventory.mjs';
import {
  nativeSpaceInventoryKey,
  nativeSpaceRetentionKey,
} from '../../lambda/shared/native-space-inventory.js';
import { nativeDependencyInventory, assertNativeRemoval } from '../lib/native-dependencies.mjs';

const ready = { ...nativeSpaceInventoryKey, version: 1 };
const fixture = ({ weighted, legacy, changedAfterScan, partial } = {}) => {
  const tableName = 'isolated-bindings';
  const events = [];
  const lambda = {
    send: async (cmd) => {
      if (cmd instanceof GetAliasCommand) {
        events.push('alias');
        return {
          RevisionId: changedAfterScan && events.includes('scan') ? 'changed' : 'stable',
          FunctionVersion: '7',
          RoutingConfig: { AdditionalVersionWeights: weighted ? { 6: 0.1 } : {} },
        };
      }
      assert.equal(cmd.input.Qualifier, '7');
      return {
        Environment: {
          Variables: {
            NATIVE_RUNTIME_BINDINGS_TABLE: tableName,
            YJS_DOCUMENTS_TABLE: legacy ? '' : 'documents',
          },
        },
      };
    },
  };
  const ddb = {
    send: async (cmd) => {
      if (cmd instanceof ScanCommand) {
        events.push('scan');
        return partial ? {} : { Items: [] };
      }
      assert.deepEqual(cmd.input.Item, ready);
      events.push('ready');
      return {};
    },
  };
  const wait = async (ms) => {
    assert.equal(ms, 91000);
    events.push('drain');
  };
  return {
    initialize: () => initializeDeployedNativeSpaceInventory({ ddb, lambda, tableName, wait }),
    events,
  };
};

test('legacy writers, weighted or changed aliases and incomplete scans cannot certify absence', async () => {
  for (const options of [
    { weighted: true },
    { legacy: true },
    { changedAfterScan: true },
    { partial: true },
  ]) {
    const f = fixture(options);
    await assert.rejects(f.initialize());
    assert.ok(!f.events.includes('ready'));
  }
  const f = fixture();
  assert.deepEqual(await f.initialize(), { bindings: 0 });
  assert.deepEqual(f.events, ['alias', 'drain', 'alias', 'scan', 'alias', 'ready']);
});

test('the exact empty-inventory receipt introduces no work dependency; retained and malformed records still protect storage', () => {
  const decommission = (rows) =>
    assertNativeRemoval(nativeDependencyInventory(rows), {
      admissionClosed: true,
      dependencies: [],
      entireService: true,
    });
  assert.equal(decommission([ready]), true);
  assert.equal(nativeDependencyInventory([ready]).records, 1);
  for (const row of [
    { ...ready, extra: 'history' },
    { ...ready, version: 2 },
    nativeSpaceRetentionKey('fixture'),
  ])
    assert.throws(() => decommission([row]), /protected records/);
});
