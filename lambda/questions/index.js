import gremlin from 'gremlin';
import { randomUUID } from 'node:crypto';
import { create } from 'neptune-lambda-client';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { buildResponse } from '../shared/response.js';

const { cardinality } = gremlin.process;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

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

// Responder identity comes from the Cognito User Pools authorizer so it is
// authoritative — clients cannot spoof who answered a question.
const getResponder = (event) => {
  const claims = event?.requestContext?.authorizer?.claims || {};
  const sub = claims.sub || '';
  const displayName = claims['custom:display_name'] || claims.email || '';
  return { sub, displayName };
};

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
    const { httpMethod, pathParameters, body } = event;
    const { sprintId, questionId } = pathParameters || {};

    switch (httpMethod) {
      case 'GET': {
        if (questionId) {
          const r = await query((g) => g.V().has('Question', 'id', questionId).valueMap().next());
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

      case 'POST': {
        const data = JSON.parse(body);
        const id = randomUUID();
        const createdAt = new Date().toISOString();
        const questionsJson = JSON.stringify(data.questions);

        await query((g) =>
          g
            .V()
            .has('Sprint', 'id', sprintId)
            .as('s')
            .addV('Question')
            .property('id', id)
            .property('agent', data.agent || '')
            .property('questions', questionsJson)
            .property('structured_answer', '')
            .property('draft_answer', '')
            .property('sprint_id', sprintId)
            .property('created_at', createdAt)
            .as('q')
            .addE('CONTAINS')
            .from_('s')
            .to('q')
            .next(),
        );

        return res(201, {
          id,
          agent: data.agent || '',
          questions: data.questions,
          sprintId,
          createdAt,
        });
      }

      case 'PUT': {
        const data = JSON.parse(body);

        // Submit structured answer
        if (data.structuredAnswer !== undefined) {
          const answerJson = JSON.stringify(data.structuredAnswer);
          const responder = getResponder(event);
          const answeredAt = new Date().toISOString();
          await query((g) =>
            g
              .V()
              .has('Question', 'id', questionId)
              .property(cardinality.single, 'structured_answer', answerJson)
              .property(cardinality.single, 'answered_by', responder.sub)
              .property(cardinality.single, 'answered_by_name', responder.displayName)
              .property(cardinality.single, 'answered_at', answeredAt)
              .next(),
          );

          // Sync answer to DynamoDB so the agent's ask_question poll sees it
          if (process.env.AGENT_QUESTIONS_TABLE) {
            await ddb
              .send(
                new UpdateCommand({
                  TableName: process.env.AGENT_QUESTIONS_TABLE,
                  Key: { questionId },
                  UpdateExpression:
                    'SET #s = :s, structuredAnswer = :a, answeredAt = :t, answeredBy = :u, answeredByName = :n',
                  ExpressionAttributeNames: { '#s': 'status' },
                  ExpressionAttributeValues: {
                    ':s': 'answered',
                    ':a': answerJson,
                    ':t': Date.now(),
                    ':u': responder.sub,
                    ':n': responder.displayName,
                  },
                }),
              )
              .catch((e) => console.error('DynamoDB sync failed:', e.message));
          }
        }

        // Save draft answer — persists collaborative draft WITHOUT triggering
        // the agent's question-answered flow (status stays 'pending').
        if (data.draftAnswer !== undefined && data.structuredAnswer === undefined) {
          const draftJson = JSON.stringify(data.draftAnswer);
          await query((g) =>
            g
              .V()
              .has('Question', 'id', questionId)
              .property(cardinality.single, 'draft_answer', draftJson)
              .next(),
          );

          // Sync draft to DynamoDB (does NOT change status)
          if (process.env.AGENT_QUESTIONS_TABLE) {
            await ddb
              .send(
                new UpdateCommand({
                  TableName: process.env.AGENT_QUESTIONS_TABLE,
                  Key: { questionId },
                  UpdateExpression: 'SET draftAnswer = :d',
                  ExpressionAttributeValues: { ':d': draftJson },
                }),
              )
              .catch((e) => console.error('DynamoDB draft sync failed:', e.message));
          }
        }

        // Add INFLUENCES edges when answer is recorded
        if (data.influencesRequirementIds) {
          for (const rId of data.influencesRequirementIds) {
            await query((g) =>
              g
                .V()
                .has('Question', 'id', questionId)
                .as('q')
                .V()
                .has('Requirement', 'id', rId)
                .as('r')
                .addE('INFLUENCES')
                .from_('q')
                .to('r')
                .next(),
            );
          }
        }
        if (data.influencesUserStoryIds) {
          for (const usId of data.influencesUserStoryIds) {
            await query((g) =>
              g
                .V()
                .has('Question', 'id', questionId)
                .as('q')
                .V()
                .has('UserStory', 'id', usId)
                .as('us')
                .addE('INFLUENCES')
                .from_('q')
                .to('us')
                .next(),
            );
          }
        }
        if (data.influencesTaskIds) {
          for (const tId of data.influencesTaskIds) {
            await query((g) =>
              g
                .V()
                .has('Question', 'id', questionId)
                .as('q')
                .V()
                .has('Task', 'id', tId)
                .as('t')
                .addE('INFLUENCES')
                .from_('q')
                .to('t')
                .next(),
            );
          }
        }

        const updated = await query((g) =>
          g.V().has('Question', 'id', questionId).valueMap().next(),
        );
        return res(200, mapQuestion(updated.value));
      }

      default:
        return res(405, { error: 'Method not allowed' });
    }
  } catch (err) {
    console.error('Error:', err);
    return res(500, { error: 'Internal server error' });
  }
};
