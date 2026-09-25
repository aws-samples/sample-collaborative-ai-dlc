// The RECEIPT# item family: the attempt-scoped, content-
// bound authorization record every gate-precondition check consults.
//
// Two properties carry the whole design and are asserted here: a receipt write is
// IDEMPOTENT (a replayed gate answer must not double-count, and must return the
// row that already exists), and a receipt is INVISIBLE after the stage's attempt
// is bumped by a rewind — which is what makes "a rejection, jump or restart
// invalidates prior confirmations" true without deleting anything.

import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { RECEIPT_KINDS, buildReceiptRow, receiptKey } from '../v2-process-keys.js';
import { createProcessStore } from '../v2-process-store.js';
import { buildWorkflowCheckpoint, checkpointProjection } from '../workflow-checkpoint.js';

const ddbMock = mockClient(DynamoDBDocumentClient);
const store = () =>
  createProcessStore({
    ddb: ddbMock,
    tableName: 'v2-proc',
    clock: () => '2026-01-01T00:00:00.000Z',
    ids: () => 'fixed-id',
  });

const SELECTOR = Object.freeze({
  kind: 'summary-confirmation',
  stageInstanceId: 'si-1',
  attempt: 2,
  unitSlug: null,
});

beforeEach(() => {
  ddbMock.reset();
});

describe('receipt keys', () => {
  it('is deterministic and attempt-scoped, with a placeholder for the unit-free lane', () => {
    expect(receiptKey('e1', SELECTOR)).toEqual({
      pk: 'EXEC#e1',
      sk: 'RECEIPT#summary-confirmation#si-1#2#-',
    });
    expect(receiptKey('e1', { ...SELECTOR, attempt: 3 }).sk).toBe(
      'RECEIPT#summary-confirmation#si-1#3#-',
    );
    expect(receiptKey('e1', { ...SELECTOR, unitSlug: 'lane/one' }).sk).toBe(
      'RECEIPT#summary-confirmation#si-1#2#lane%2Fone',
    );
    expect(receiptKey('e1', { ...SELECTOR, kind: 'pipeline-link', ordinal: 2 }).sk).toBe(
      'RECEIPT#pipeline-link#si-1#2#-#2',
    );
  });

  it('projects GSI2 by kind so one query answers "every override on this run"', () => {
    const row = buildReceiptRow({
      executionId: 'e1',
      ...SELECTOR,
      kind: 'sensor-override',
      now: 'T',
    });
    expect(row).toMatchObject({
      type: 'Receipt',
      kind: 'sensor-override',
      attempt: 2,
      decidedAt: 'T',
      GSI2PK: 'EXEC#e1',
    });
    expect(row.GSI2SK).toContain('RECEIPT');
  });

  it('declares every kind the checkpoint family consumes', () => {
    expect(RECEIPT_KINDS).toContain('summary-confirmation');
    expect(RECEIPT_KINDS).toContain('sensor-override');
    expect(RECEIPT_KINDS).toContain('stage-approval');
    expect(new Set(RECEIPT_KINDS).size).toBe(RECEIPT_KINDS.length);
  });
});

describe('putReceipt', () => {
  it('writes conditionally and returns the row', async () => {
    ddbMock.on(PutCommand).resolves({});
    const written = await store().putReceipt({
      executionId: 'e1',
      ...SELECTOR,
      boundDigest: 'abc',
      choice: 'Looks correct',
      decidedBy: 'u1',
    });
    const call = ddbMock.commandCalls(PutCommand)[0].args[0].input;
    expect(call.ConditionExpression).toBe('attribute_not_exists(pk) AND attribute_not_exists(sk)');
    expect(written).toMatchObject({
      sk: 'RECEIPT#summary-confirmation#si-1#2#-',
      choice: 'Looks correct',
    });
  });

  it('is idempotent: a replay returns the EXISTING row and writes nothing new', async () => {
    const existing = {
      pk: 'EXEC#e1',
      sk: 'RECEIPT#summary-confirmation#si-1#2#-',
      choice: 'first',
    };
    ddbMock
      .on(PutCommand)
      .rejects(Object.assign(new Error('exists'), { name: 'ConditionalCheckFailedException' }));
    ddbMock.on(GetCommand).resolves({ Item: existing });
    const replayed = await store().putReceipt({
      executionId: 'e1',
      ...SELECTOR,
      choice: 'second',
    });
    expect(replayed).toEqual(existing);
    expect(replayed.choice).toBe('first');
  });

  it('refuses a kind outside the closed set rather than inventing an authorization', async () => {
    await expect(
      store().putReceipt({ executionId: 'e1', ...SELECTOR, kind: 'made-up' }),
    ).rejects.toThrow(/unknown receipt kind/);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });
});

describe('listReceipts', () => {
  const rows = [
    {
      sk: 'RECEIPT#summary-confirmation#si-1#1#-',
      kind: 'summary-confirmation',
      stageInstanceId: 'si-1',
      attempt: 1,
    },
    {
      sk: 'RECEIPT#summary-confirmation#si-1#2#-',
      kind: 'summary-confirmation',
      stageInstanceId: 'si-1',
      attempt: 2,
    },
    {
      sk: 'RECEIPT#sensor-override#si-1#2#-',
      kind: 'sensor-override',
      stageInstanceId: 'si-1',
      attempt: 2,
    },
    {
      sk: 'RECEIPT#summary-confirmation#si-2#2#-',
      kind: 'summary-confirmation',
      stageInstanceId: 'si-2',
      attempt: 2,
    },
  ];

  beforeEach(() => {
    ddbMock.on(QueryCommand).resolves({ Items: rows });
  });

  it('queries the RECEIPT# prefix only', async () => {
    await store().listReceipts('e1');
    expect(ddbMock.commandCalls(QueryCommand)[0].args[0].input.ExpressionAttributeValues).toEqual({
      ':pk': 'EXEC#e1',
      ':p': 'RECEIPT#',
    });
  });

  it('makes a PRIOR attempt invisible — the rewind invalidation, for free', async () => {
    const current = await store().listReceipts('e1', { stageInstanceId: 'si-1', attempt: 2 });
    expect(current.map((r) => r.sk)).toEqual([
      'RECEIPT#sensor-override#si-1#2#-',
      'RECEIPT#summary-confirmation#si-1#2#-',
    ]);

    // resetStageForRewind bumps the STAGE# attempt to 3; nothing is deleted, yet
    // every earlier authorization is now unreachable.
    const afterRewind = await store().listReceipts('e1', { stageInstanceId: 'si-1', attempt: 3 });
    expect(afterRewind).toEqual([]);
  });

  it('narrows by kind and by stage instance', async () => {
    expect(
      (await store().listReceipts('e1', { kind: 'sensor-override' })).map((r) => r.attempt),
    ).toEqual([2]);
    expect(
      (await store().listReceipts('e1', { stageInstanceId: 'si-2' })).map((r) => r.sk),
    ).toEqual(['RECEIPT#summary-confirmation#si-2#2#-']);
  });
});

describe('receipt lifecycle integration', () => {
  it('a rewind bumps the attempt the next receipt binds to', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { sk: 'STAGE#si-1', state: 'SUCCEEDED', attempt: 2, startedAt: 'T' },
    });
    ddbMock.on(UpdateCommand).resolves({ Attributes: { attempt: 3, state: 'PENDING' } });
    const reset = await store().resetStageRow({ executionId: 'e1', stageInstanceId: 'si-1' });
    expect(reset.attempt).toBe(3);
    expect(
      ddbMock.commandCalls(UpdateCommand)[0].args[0].input.ExpressionAttributeValues[':attempt'],
    ).toBe(3);
  });

  it('surfaces receipts in the execution record set so a re-read sees them', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        { sk: 'META' },
        { sk: 'STAGE#si-1' },
        { sk: 'RECEIPT#summary-confirmation#si-1#0#-', kind: 'summary-confirmation' },
      ],
    });
    const records = await store().getExecutionRecords('e1');
    expect(records.receipts.map((r) => r.kind)).toEqual(['summary-confirmation']);
  });
});

describe('workflow checkpoint receipt projection', () => {
  const records = {
    meta: { executionId: 'e1', projectId: 'p1' },
    stages: [],
    humanTasks: [],
    units: [],
  };

  it('carries receipts so a restored run resolves the same authorization space', () => {
    const checkpoint = buildWorkflowCheckpoint({
      executionId: 'e1',
      createdAt: 'T',
      records: {
        ...records,
        receipts: [
          {
            pk: 'EXEC#e1',
            sk: 'RECEIPT#summary-confirmation#si-1#0#-',
            executionId: 'e1',
            kind: 'summary-confirmation',
            stageInstanceId: 'si-1',
            attempt: 0,
            boundDigest: 'abc',
            decidedAt: 'T',
          },
        ],
      },
    });
    expect(checkpoint.process.receipts).toEqual([
      expect.objectContaining({ kind: 'summary-confirmation', attempt: 0, boundDigest: 'abc' }),
    ]);
    // Infrastructure keys never enter a checkpoint.
    expect(checkpoint.process.receipts[0]).not.toHaveProperty('pk');
    expect(checkpointProjection(checkpoint).receipts).toHaveLength(1);
  });

  it('omits the field entirely for an execution with no receipts', () => {
    const checkpoint = buildWorkflowCheckpoint({ executionId: 'e1', createdAt: 'T', records });
    expect(checkpoint.process).not.toHaveProperty('receipts');
    expect(checkpointProjection(checkpoint)).not.toHaveProperty('receipts');
  });
});
