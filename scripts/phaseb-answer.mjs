// Answer the pending HUMAN gate for a Phase B execution against the DEPLOYED v2
// table — what the future resume lambda will do. Reads the pending gate, writes
// a plausible answer per question so the blocked agent unblocks.
//
//   AWS_PROFILE=... AWS_REGION=... EXEC_ID=e-b3 TABLE=<v2-exec-table> \
//     node scripts/phaseb-answer.mjs "<free-text answer applied to all questions>"
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const TABLE = process.env.TABLE;
const EXEC_ID = process.env.EXEC_ID || 'e-b3';
const FREETEXT =
  process.argv[2] ||
  'Build a minimal URL shortener: anonymous shorten + fast redirect; signed-in users see click counts. MVP scope, ~1000 rps, p99<50ms.';

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION || 'us-east-1' }));

const { Items = [] } = await doc.send(
  new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'pk = :p AND begins_with(sk, :h)',
    ExpressionAttributeValues: { ':p': `EXEC#${EXEC_ID}`, ':h': 'HUMAN#' },
  }),
);
const gate = Items.find((i) => i.status === 'pending');
if (!gate) {
  console.log('no pending gate for', EXEC_ID);
  process.exit(0);
}
const questions = JSON.parse(gate.questions || '[]');
const answer = {
  perQuestion: questions.map((q) => ({
    text: q.text,
    // Pick the first concrete option when present, else the free-text.
    answer: q.options?.[0]?.label ? `${q.options[0].label} — ${FREETEXT}` : FREETEXT,
  })),
  freeText: FREETEXT,
};

await doc.send(
  new UpdateCommand({
    TableName: TABLE,
    Key: { pk: `EXEC#${EXEC_ID}`, sk: gate.sk },
    ConditionExpression: '#s = :pending',
    UpdateExpression: 'SET #s = :answered, answer = :a, answeredBy = :by, answeredAt = :ts',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: {
      ':pending': 'pending',
      ':answered': 'answered',
      ':a': answer,
      ':by': 'phaseb-operator',
      ':ts': new Date().toISOString(),
    },
  }),
);
console.log(`ANSWERED ${gate.sk} (${questions.length} questions) for ${EXEC_ID}`);
process.exit(0);
