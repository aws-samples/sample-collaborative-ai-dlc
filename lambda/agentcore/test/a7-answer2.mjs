// Answer the second A7 gate (5 clarifying questions) so the agent can finish and
// call create_artifact. One free-text answer per question.
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
const questions = JSON.parse(gate.questions || '[]');

// Map each clarifying question to a concrete answer (keyed by order).
const replies = [
  'Anyone can create short links anonymously; authenticated users (email + password) additionally get per-link analytics. No admin roles.',
  'Auto-generate a 7-char base62 code from a random source; on collision, retry. No custom aliases for the MVP.',
  'Yes — optional expiration date per link, and owners can delete their own links. Expired/deleted codes return 404.',
  'Authenticated owners see total click count and last-clicked timestamp per link. No geo/referrer breakdown in the MVP.',
  'Validate URL is http(s) and well-formed; reject private/localhost hosts; cap length at 2048 chars. No malware scanning in the MVP.',
];
const answer = {
  perQuestion: questions.map((q, i) => ({
    text: q.text,
    answer: replies[i] ?? 'Use your best judgment.',
  })),
};

const res = await store.answerHumanTask({
  executionId: 'a7-exec',
  humanTaskId,
  status: 'answered',
  answer,
  answeredBy: 'a7-operator',
});
console.log(res ? `ANSWERED gate ${humanTaskId} (${questions.length} questions)` : 'answer failed');
process.exit(0);
