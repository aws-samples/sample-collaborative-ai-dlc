import { create } from 'neptune-lambda-client';
import { buildResponse } from '../shared/response.js';
import { authorizeLegacySprintRead } from '../shared/legacy-authz.js';

// Tests point GREMLIN_PROTOCOL at a plain ws:// gremlin-server (no IAM); Neptune
// in production is wss:// + SigV4. Tying useIam to the protocol keeps the test
// seam to a single env var that globalSetup already sets.
const protocol = process.env.GREMLIN_PROTOCOL ?? 'wss';

// Created once per container and reused across warm invocations: the client
// connects lazily, reconnects on socket drop, and retries transient Neptune
// errors. Closing per request would defeat all of that.
const { query, close } = create(process.env.NEPTUNE_ENDPOINT, process.env.GREMLIN_PORT ?? '8182', {
  useIam: protocol === 'wss',
  protocol,
  partition: process.env.GREMLIN_PARTITION
    ? {
        partitionKey: '_partition',
        writePartition: process.env.GREMLIN_PARTITION,
        readPartitions: [process.env.GREMLIN_PARTITION],
      }
    : undefined,
});

// Exported for test teardown only — production reuses the connection.
export { close };

const mapQuestion = (v) => {
  const questionsRaw = v.get('questions')?.[0] || '[]';
  const structuredAnswerRaw = v.get('structured_answer')?.[0] || '';
  const draftAnswerRaw = v.get('draft_answer')?.[0] || '';

  let questions;
  try {
    questions = JSON.parse(questionsRaw);
  } catch {
    questions = [];
  }

  let structuredAnswer;
  try {
    structuredAnswer = structuredAnswerRaw ? JSON.parse(structuredAnswerRaw) : undefined;
  } catch {
    structuredAnswer = undefined;
  }

  let draftAnswer;
  try {
    draftAnswer = draftAnswerRaw ? JSON.parse(draftAnswerRaw) : undefined;
  } catch {
    draftAnswer = undefined;
  }

  return {
    id: v.get('id')?.[0] || '',
    agent: v.get('agent')?.[0] || '',
    questions,
    structuredAnswer,
    draftAnswer,
    sprintId: v.get('sprint_id')?.[0] || '',
    createdAt: v.get('created_at')?.[0] || '',
    answeredBy: v.get('answered_by')?.[0] || '',
    answeredByName: v.get('answered_by_name')?.[0] || '',
    answeredAt: v.get('answered_at')?.[0] || '',
  };
};

export const handler = async (event) => {
  const res = buildResponse(event);
  if (event.httpMethod === 'OPTIONS') return res(200, {});

  try {
    const { httpMethod, pathParameters } = event;
    const { sprintId, questionId } = pathParameters || {};

    // Questions belong to v1 sprints, which are read-only: the create/answer
    // write paths were removed together with the v1 execution engine, so only
    // the GET routes (list + single) remain.
    switch (httpMethod) {
      case 'GET': {
        const auth = await query((g) => authorizeLegacySprintRead(g, event, sprintId));
        if (auth.denied) return res(auth.statusCode, { error: auth.error });
        if (questionId) {
          const r = await query((g) =>
            g
              .V()
              .has('Sprint', 'id', sprintId)
              .out('CONTAINS')
              .has('Question', 'id', questionId)
              .valueMap()
              .next(),
          );
          if (!r.value) return res(404, { error: 'Question not found' });
          return res(200, mapQuestion(r.value));
        }
        const list = await query((g) =>
          g
            .V()
            .has('Sprint', 'id', sprintId)
            .out('CONTAINS')
            .hasLabel('Question')
            .valueMap()
            .toList(),
        );
        return res(200, list.map(mapQuestion));
      }

      default:
        return res(405, { error: 'Method not allowed' });
    }
  } catch (err) {
    console.error('Error:', err);
    return res(500, { error: 'Internal server error' });
  }
};
