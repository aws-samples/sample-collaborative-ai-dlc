import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { LambdaClient, SendDurableExecutionCallbackSuccessCommand } from '@aws-sdk/client-lambda';
import { createProcessStore } from '../../shared/v2-process-store.js';

// Exercise the real HTTP handler, answer CAS and callback delivery. Only graph
// authorization/mirroring and AWS transport are stubbed.
vi.mock('@aws-sdk/credential-providers', () => ({
  fromNodeProviderChain: () => async () => ({ accessKeyId: 'test', secretAccessKey: 'test' }),
}));
vi.mock('gremlin', async (original) => {
  const actual = await original();
  const g = {
    V: () => g,
    has: () => g,
    hasNext: async () => false,
    withRemote: () => g,
  };
  return {
    default: {
      ...actual.default,
      driver: {
        ...actual.default.driver,
        DriverRemoteConnection: class {
          async close() {}
        },
      },
      process: { ...actual.default.process, traversal: () => g },
    },
  };
});
vi.mock('../../shared/trackers.js', async (original) => ({
  ...(await original()),
  fetchMembershipRole: async () => 'MEMBER',
}));
vi.mock('../../shared/ws-fanout.js', () => ({ broadcastToIntentChannel: async () => {} }));

import { handler } from '../index.js';

const ddb = mockClient(DynamoDBDocumentClient);
const lambda = mockClient(LambdaClient);
const store = createProcessStore({
  ddb: DynamoDBDocumentClient.from({ config: {}, send: () => {} }),
});

describe('answer/bind interleaving', () => {
  beforeEach(() => {
    ddb.reset();
    lambda.reset();
    vi.stubEnv('NEPTUNE_ENDPOINT', 'localhost');
    vi.stubEnv('V2_PROCESS_TABLE', 'test-process');
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    [true, false, false],
    [false, false, false],
    [true, true, false],
    [false, true, false],
    [true, false, true],
    [false, false, true],
    [true, true, true],
    [false, true, true],
  ])(
    'wakes the callback from the committed answer (bind raced: %s, owned: %s, steering: %s)',
    async (bindRaced, owned, withSteering) => {
      let gate = {
        humanTaskId: 'h1',
        status: 'pending',
        callbackId: null,
        ...(owned ? { orchestratorRunId: 'run1' } : {}),
      };
      const order = [];
      ddb.on(GetCommand).callsFake(async ({ Key }) => {
        if (Key.sk === 'META') return { Item: { projectId: 'p1', status: 'WAITING' } };
        const snapshot = { ...gate };
        if (order.length === 0) {
          order.push('endpoint-read-unbound');
          if (bindRaced) {
            await store.setGateCallbackId({
              executionId: 'i1',
              humanTaskId: 'h1',
              callbackId: 'cb1',
              callbackOwner: 'engine:h1',
            });
            // The orchestrator's read sees pending and commits to waiting.
            expect((await store.getHumanTask('i1', 'h1', { consistentRead: true })).status).toBe(
              'pending',
            );
            order.push('orchestrator-read-pending');
          }
        }
        return { Item: snapshot };
      });
      ddb.on(QueryCommand).resolves({ Items: [] });
      const applyUpdate = ({ ExpressionAttributeValues: values }) => {
        if (values[':cb']) {
          gate = { ...gate, callbackId: values[':cb'], callbackOwner: values[':owner'] };
          order.push('bind');
        } else {
          gate = { ...gate, status: values[':status'], answer: values[':answer'] };
          order.push('answer-committed');
        }
        return { Attributes: { ...gate } };
      };
      ddb.on(UpdateCommand).callsFake(applyUpdate);
      ddb.on(TransactWriteCommand).callsFake(({ TransactItems }) => {
        for (const item of TransactItems) if (item.Update) applyUpdate(item.Update);
        return {};
      });
      lambda.on(SendDurableExecutionCallbackSuccessCommand).resolves({});
      const response = await handler({
        httpMethod: 'POST',
        path: '/projects/p1/intents/i1/gates/h1/answer',
        pathParameters: { projectId: 'p1', intentId: 'i1', humanTaskId: 'h1' },
        requestContext: { authorizer: { claims: { sub: 'u1' } } },
        body: JSON.stringify({
          answer: { decision: 'approve' },
          ...(withSteering ? { steering: 'Use the event bus.' } : {}),
        }),
      });
      expect(response.statusCode).toBe(200);
      const callbacks = lambda.commandCalls(SendDurableExecutionCallbackSuccessCommand);
      expect(callbacks).toHaveLength(bindRaced ? 1 : 0);
      if (bindRaced) {
        expect(order).toEqual([
          'endpoint-read-unbound',
          'bind',
          'orchestrator-read-pending',
          'answer-committed',
        ]);
        expect(callbacks[0].args[0].input.CallbackId).toBe('cb1');
      }
    },
  );
  it.each([false, true])(
    'does not answer or wake a gate after its run loses ownership (steering: %s)',
    async (withSteering) => {
      const gate = {
        humanTaskId: 'h1',
        status: 'pending',
        callbackId: 'old-cb',
        orchestratorRunId: 'old-run',
      };
      ddb.on(GetCommand).callsFake(({ Key }) => ({
        Item:
          Key.sk === 'META'
            ? { projectId: 'p1', orchestratorRunId: 'new-run', status: 'WAITING' }
            : gate,
      }));
      ddb.on(QueryCommand).resolves({ Items: [] });
      ddb.on(TransactWriteCommand).rejects(
        Object.assign(new Error('rewound'), {
          name: 'TransactionCanceledException',
          CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
        }),
      );
      const response = await handler({
        httpMethod: 'POST',
        path: '/projects/p1/intents/i1/gates/h1/answer',
        pathParameters: { projectId: 'p1', intentId: 'i1', humanTaskId: 'h1' },
        requestContext: { authorizer: { claims: { sub: 'u1' } } },
        body: JSON.stringify({
          answer: 'approve',
          ...(withSteering ? { steering: 'Use the event bus.' } : {}),
        }),
      });
      expect(response.statusCode).toBe(409);
      expect(gate.status).toBe('pending');
      expect(lambda.commandCalls(SendDurableExecutionCallbackSuccessCommand)).toHaveLength(0);
    },
  );
});
