import gremlin from 'gremlin';
import { create } from 'neptune-lambda-client';
import { buildResponse } from '../shared/response.js';

const order = gremlin.process.order;

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

const mapEvent = (v) => ({
  id: v.get('id')?.[0] || '',
  type: v.get('type')?.[0] || '',
  title: v.get('title')?.[0] || '',
  detail: v.get('detail')?.[0] || '',
  userId: v.get('user_id')?.[0] || '',
  userName: v.get('user_name')?.[0] || '',
  timestamp: v.get('timestamp')?.[0] || '',
  sprintId: v.get('sprint_id')?.[0] || '',
  questionId: v.get('question_id')?.[0] || '',
});

export const handler = async (event) => {
  const res = buildResponse(event);
  if (event.httpMethod === 'OPTIONS') return res(200, {});

  try {
    const { httpMethod, pathParameters } = event;
    const { sprintId } = pathParameters || {};

    // Timeline events belong to v1 sprints, which are read-only: the POST
    // write path was removed together with the v1 execution engine.
    switch (httpMethod) {
      case 'GET': {
        const list = await query((g) =>
          g
            .V()
            .has('Sprint', 'id', sprintId)
            .out('HAS_TIMELINE_EVENT')
            .hasLabel('TimelineEvent')
            .order()
            .by('timestamp', order.desc)
            .valueMap()
            .toList(),
        );
        return res(200, list.map(mapEvent));
      }

      default:
        return res(405, { error: 'Method not allowed' });
    }
  } catch (err) {
    console.error('Error:', err);
    return res(500, { error: 'Internal server error' });
  }
};
