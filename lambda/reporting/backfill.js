// One-off scan of v2-executions into the reporting lake, so the lake starts
// with every row that already exists. Each row is written as a SNAPSHOT change
// stamped with the time it was read.
//
// Run it after the Kinesis streaming destination is ACTIVE: a change streamed
// after the read then sorts after the snapshot, and one streamed before sorts
// before it, so the views still pick the newest state.
//
// The scan is resumable. The function stops a minute before its timeout and
// returns { done: false, startKey, runId }; invoke it again with that payload
// until it returns done: true.
import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { Logger } from '@aws-lambda-powertools/logger';
import { DynamoDBClient, ScanCommand } from '@aws-sdk/client-dynamodb';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { deserializeImage, lakeRow, toJsonLine } from './lib/rows.js';

const logger = new Logger();

const PAGE_SIZE = 500;
const STOP_BEFORE_TIMEOUT_MS = 60_000;

const nowMicros = () => Date.now() * 1000;

// Scan items -> Map of "recordType/dt" -> { recordType, dt, rows }.
export const groupPage = (items, tsUs, runId) => {
  const groups = new Map();
  items.forEach((raw, n) => {
    const result = lakeRow(
      `snapshot-${runId}-${tsUs}-${n}`,
      'SNAPSHOT',
      tsUs,
      deserializeImage(raw),
    );
    if (result === null) return;
    const { recordType, row } = result;
    const dt = row.event_time.slice(0, 10);
    const key = `${recordType}/${dt}`;
    if (!groups.has(key)) groups.set(key, { recordType, dt, rows: [] });
    groups.get(key).rows.push(row);
  });
  return groups;
};

export const createBackfill = ({
  ddb = new DynamoDBClient({}),
  s3 = new S3Client({}),
  tableName = process.env.TABLE_NAME,
  bucket = process.env.LAKE_BUCKET,
  clock = nowMicros,
} = {}) => {
  return async (event = {}, context) => {
    const runId = event.runId || randomUUID().slice(0, 12);
    let startKey = event.startKey;
    let pages = 0;
    let written = 0;

    do {
      const page = await ddb.send(
        new ScanCommand({
          TableName: tableName,
          ConsistentRead: true,
          Limit: PAGE_SIZE,
          ...(startKey ? { ExclusiveStartKey: startKey } : {}),
        }),
      );
      const tsUs = clock();
      for (const { recordType, dt, rows } of groupPage(page.Items ?? [], tsUs, runId).values()) {
        await s3.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: `executions/record_type=${recordType}/dt=${dt}/backfill-${runId}-${tsUs}.gz`,
            Body: gzipSync(rows.map(toJsonLine).join('')),
            ContentType: 'application/x-ndjson',
            ContentEncoding: 'gzip',
          }),
        );
        written += rows.length;
      }
      pages += 1;
      startKey = page.LastEvaluatedKey;
    } while (startKey && context.getRemainingTimeInMillis() >= STOP_BEFORE_TIMEOUT_MS);

    const result = { runId, pages, rowsWritten: written, done: !startKey, startKey };
    logger.info('Backfill pass finished', { ...result, startKey: undefined });
    return result;
  };
};

export const handler = createBackfill();
