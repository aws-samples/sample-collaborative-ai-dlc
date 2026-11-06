import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import {
  BatchWriteItemCommand,
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { marshall } from '@aws-sdk/util-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { buildExecutionMeta, buildStageRow, outputKey } from '../../shared/v2-process-keys.js';
import { createBackfill } from '../backfill.js';

const TABLE = `reporting-backfill-${randomUUID()}`;
const ddb = new DynamoDBClient({ endpoint: process.env.DYNAMODB_LOCAL_ENDPOINT });
const s3 = new S3Client({ region: 'us-east-1' });
const s3Mock = mockClient(s3);

const TS_US = 1_793_361_600_123_456; // 2026-10-30T12:00:00.123456Z
const context = (remainingMs = 900_000) => ({ getRemainingTimeInMillis: () => remainingMs });

const put = async (items) => {
  for (let i = 0; i < items.length; i += 25) {
    await ddb.send(
      new BatchWriteItemCommand({
        RequestItems: {
          [TABLE]: items.slice(i, i + 25).map((item) => ({
            PutRequest: { Item: marshall(item, { removeUndefinedValues: true }) },
          })),
        },
      }),
    );
  }
};

const written = () =>
  s3Mock.commandCalls(PutObjectCommand).map(({ args: [{ input }] }) => ({
    key: input.Key,
    rows: gunzipSync(input.Body)
      .toString('utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line)),
  }));

beforeAll(async () => {
  await ddb.send(
    new CreateTableCommand({
      TableName: TABLE,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [
        { AttributeName: 'pk', AttributeType: 'S' },
        { AttributeName: 'sk', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
    }),
  );
});

afterAll(async () => {
  await ddb.send(new DeleteTableCommand({ TableName: TABLE }));
});

beforeEach(() => {
  s3Mock.reset();
  s3Mock.on(PutObjectCommand).resolves({});
});

const backfill = () =>
  createBackfill({ ddb, s3, tableName: TABLE, bucket: 'lake', clock: () => TS_US });

describe('backfill', () => {
  it('writes every reported row as a SNAPSHOT, grouped by record type and day', async () => {
    await put([
      buildExecutionMeta({
        executionId: 'e1',
        projectId: 'p1',
        intentId: 'i1',
        workflowId: 'w1',
        workflowVersion: 1,
        startedAt: '2026-10-30T10:00:00.000Z',
        prompt: 'not for the lake',
      }),
      buildStageRow({
        executionId: 'e1',
        stageInstanceId: 'si1',
        stageId: 'requirements',
        phase: 'inception',
        state: 'SUCCEEDED',
      }),
      { ...outputKey('e1', 'si1', 1), text: 'transcript' },
    ]);

    const result = await backfill()({ runId: 'run1' }, context());

    expect(result).toMatchObject({ runId: 'run1', pages: 1, rowsWritten: 2, done: true });
    const objects = written().toSorted((a, b) => a.key.localeCompare(b.key));
    expect(objects.map((o) => o.key)).toEqual([
      `executions/record_type=meta/dt=2026-10-30/backfill-run1-${TS_US}.gz`,
      `executions/record_type=stage/dt=2026-10-30/backfill-run1-${TS_US}.gz`,
    ]);
    const [metaRow] = objects[0].rows;
    expect(metaRow).toMatchObject({ event_name: 'SNAPSHOT', execution_id: 'e1', sk: 'META' });
    expect(metaRow.event_id).toMatch(/^snapshot-run1-/);
    expect(JSON.parse(metaRow.item)).not.toHaveProperty('prompt');
  });

  it('stops when time runs short and resumes from the returned key', async () => {
    const steering = Array.from({ length: 600 }, (_, n) => ({
      pk: 'EXEC#e2',
      sk: `STEER#${String(n).padStart(4, '0')}`,
      type: 'Steering',
      kind: 'gate-steer',
    }));
    await put(steering);

    const first = await backfill()({ runId: 'run2' }, context(30_000));
    expect(first.done).toBe(false);
    expect(first.pages).toBe(1);
    expect(first.startKey).toBeDefined();

    let next = first;
    while (!next.done) next = await backfill()(next, context());
    expect(next.runId).toBe('run2');

    const steerRows = written()
      .flatMap((o) => o.rows)
      .filter((row) => row.sk.startsWith('STEER#'));
    expect(new Set(steerRows.map((row) => row.sk)).size).toBe(600);
  });
});
