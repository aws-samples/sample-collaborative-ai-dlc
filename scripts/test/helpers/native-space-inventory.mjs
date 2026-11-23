import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import timers from 'node:timers/promises';
import { DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  GetAliasCommand,
  GetFunctionConfigurationCommand,
  LambdaClient,
} from '@aws-sdk/client-lambda';
import { nativeRuntimeBindingKey } from '../../../lambda/shared/native-runtime-binding.js';
import {
  nativeSpaceInventoryKey,
  nativeSpaceRetentionKey,
} from '../../../lambda/shared/native-space-inventory.js';

export const environment = 'prod';
export const tableName = 'test-native-runs-prod';
const scope = { projectId: 'legacy-space', executionId: 'draft' };
const binding = { ...scope, ...nativeRuntimeBindingKey(scope) };

export function inventoryFixture(state = {}, record = () => {}, persist = () => {}) {
  const events = [];
  const log = (event) => {
    events.push(event);
    record(event);
  };
  const ddb = {
    send: async (cmd) => {
      assert.equal(cmd.input.TableName, tableName);
      if (cmd instanceof DescribeTableCommand) {
        log('table');
        if (state.fault === 'table') throw new Error('DescribeTable denied');
        return { Table: { TableStatus: 'ACTIVE', TableId: state.tableId ?? 'incarnation-1' } };
      }
      if (cmd instanceof GetCommand) {
        log('get');
        assert.equal(cmd.input.ConsistentRead, true);
        assert.deepEqual(cmd.input.Key, nativeSpaceInventoryKey);
        if (state.fault === 'read') throw new Error('GetItem denied');
        return { Item: state.receipt };
      }
      if (cmd instanceof UpdateCommand) {
        log('pending');
        assert.deepEqual(cmd.input.Key, nativeSpaceInventoryKey);
        assert.equal(state.receipt.version, 1);
        assert.deepEqual(state.receipt.coverage, cmd.input.ExpressionAttributeValues[':coverage']);
        state.receipt = { ...state.receipt, version: 0 };
        persist(state);
        return {};
      }
      if (cmd instanceof ScanCommand) {
        log('scan');
        assert.equal(cmd.input.ConsistentRead, true);
        if (!state.historical) return { Items: [] };
        if (!cmd.input.ExclusiveStartKey)
          return { Items: [], LastEvaluatedKey: { pk: 'first', sk: 'other' } };
        if (state.fault === 'partial') return {};
        return { Items: [binding] };
      }
      assert.ok(cmd instanceof PutCommand);
      if (cmd.input.Item.pk === nativeSpaceInventoryKey.pk) {
        if (state.receipt) {
          if (state.fault === 'competing-receipt')
            throw new Error('ConditionalCheckFailedException');
          assert.equal(cmd.input.ExpressionAttributeValues[':previous'], state.receipt.version);
          assert.deepEqual(
            cmd.input.ExpressionAttributeValues[':coverage'],
            state.receipt.coverage,
          );
        } else assert.equal(cmd.input.ConditionExpression, 'attribute_not_exists(pk)');
        log('ready');
        state.receipt = cmd.input.Item;
      } else {
        log('retain');
        assert.deepEqual(cmd.input.Item, nativeSpaceRetentionKey(scope.projectId));
        state.retained = cmd.input.Item;
      }
      persist(state);
      if (state.fault === 'lost-ack' && events.at(-1) === 'ready')
        throw new Error('lost acknowledgement');
      return {};
    },
  };
  const lambda = {
    send: async (cmd) => {
      if (cmd instanceof GetAliasCommand) {
        log('alias');
        assert.deepEqual(cmd.input, { FunctionName: `${tableName}-authority`, Name: 'commands' });
        if (state.fault === 'alias') throw new Error('GetAlias denied');
        if (state.fault === 'missing-alias')
          throw Object.assign(new Error('Missing alias'), { name: 'ResourceNotFoundException' });
        return {
          RevisionId:
            state.fault === 'changed' && events.includes('scan')
              ? 'changed'
              : (state.alias ?? 'stable'),
          FunctionVersion: '7',
          RoutingConfig: { AdditionalVersionWeights: state.fault === 'weighted' ? { 6: 0.1 } : {} },
        };
      }
      assert.ok(cmd instanceof GetFunctionConfigurationCommand);
      const owner = cmd.input.FunctionName === 'test-projects-prod';
      assert.deepEqual(
        cmd.input,
        owner
          ? { FunctionName: 'test-projects-prod' }
          : { FunctionName: `${tableName}-authority`, Qualifier: '7' },
      );
      log(owner ? 'owner' : 'writer');
      return {
        RevisionId: owner ? (state.owner ?? 'owner-1') : 'writer-7',
        State: 'Active',
        LastUpdateStatus: 'Successful',
        Handler: owner ? 'index.handler' : 'authority.handler',
        Environment: {
          Variables: {
            ENVIRONMENT: environment,
            NATIVE_RUNTIME_BINDINGS_TABLE: owner && state.fault === 'old-owner' ? '' : tableName,
            YJS_DOCUMENTS_TABLE: !owner && state.fault === 'old-writer' ? '' : 'documents',
          },
        },
      };
    },
  };
  const wait = async (ms) => {
    assert.equal(
      ms,
      state.receipt?.coverage?.projectsRevision === (state.owner ?? 'owner-1') ? 91000 : 301000,
    );
    log('drain');
  };
  return { events, target: { ddb, lambda, tableName, environment, wait } };
}

// Preload only in the disposable CLI fixture. All SDK calls terminate here.
if (process.env.NATIVE_FIXTURE_FILE) {
  const file = process.env.NATIVE_FIXTURE_FILE;
  const state = JSON.parse(readFileSync(file, 'utf8'));
  const { target } = inventoryFixture(
    state,
    (event) => appendFileSync(process.env.EVENTS, `native ${event}\n`),
    (value) => writeFileSync(file, JSON.stringify(value)),
  );
  for (const [Client, mock] of [
    [DynamoDBDocumentClient, target.ddb],
    [LambdaClient, target.lambda],
  ]) {
    Client.prototype.send = async function (cmd) {
      assert.equal(await this.config.region(), 'eu-central-1');
      return mock.send(cmd);
    };
  }
  timers.setTimeout = target.wait;
  syncBuiltinESMExports();
}
