// Answer the pending A7 question gate so the blocked agent unblocks and proceeds
// to create_artifact. Mirrors what the future resume lambda will do (B7 method).
import { createRequire } from 'node:module';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

const require = createRequire(import.meta.url);
const { createProcessStore } = require('../../shared/v2-process-store.js');

const client = new DynamoDBClient({
  endpoint: 'http://localhost:8000',
  region: 'us-east-1',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
});
const store = createProcessStore({
  ddb: DynamoDBDocumentClient.from(client),
  tableName: 'a7-v2-executions',
});

const recs = await store.getExecutionRecords('a7-exec');
const gate = recs.humanTasks.find((h) => h.status === 'pending');
if (!gate) {
  console.log('no pending gate');
  process.exit(0);
}
const humanTaskId = gate.sk.replace('HUMAN#', '');
const answer = {
  selections: ["I'll describe it now"],
  text:
    'Build a URL shortener web service. Users paste a long URL and get a short code; ' +
    'visiting the short code redirects to the original. Authenticated users see click ' +
    'counts per link. Keep it minimal: one API service + small web UI, Postgres for ' +
    'storage. Target ~1000 redirects/sec, p99 < 50ms on redirect.',
};
const res = await store.answerHumanTask({
  executionId: 'a7-exec',
  humanTaskId,
  status: 'answered',
  answer,
  answeredBy: 'a7-operator',
});
console.log(res ? `ANSWERED gate ${humanTaskId}` : 'answer failed (not pending?)');
process.exit(0);
