import gremlin from 'gremlin';
import { PartitionStrategy } from 'gremlin/lib/process/traversal-strategy.js';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { getUrlAndHeaders } from 'gremlin-aws-sigv4/lib/utils.js';
import { buildResponse } from '../shared/response.js';

const DriverRemoteConnection = gremlin.driver.DriverRemoteConnection;
const traversal = gremlin.process.AnonymousTraversalSource.traversal;

const getConnection = async () => {
  const host = process.env.NEPTUNE_ENDPOINT;
  const port = process.env.GREMLIN_PORT ?? '8182';
  const protocol = process.env.GREMLIN_PROTOCOL ?? 'wss';

  const credentials = await fromNodeProviderChain()();
  credentials.region = process.env.AWS_REGION ?? 'us-east-1';
  const { url, headers } = getUrlAndHeaders(host, port, credentials, '/gremlin', protocol);
  return new DriverRemoteConnection(url, { headers });
};

const mapTask = (v) => ({
  id: v.get('id')?.[0] || '',
  title: v.get('title')?.[0] || '',
  description: v.get('description')?.[0] || '',
  status: v.get('status')?.[0] || 'todo',
  sprintId: v.get('sprint_id')?.[0] || '',
  dependencies: v.get('dependencies')?.[0] ? JSON.parse(v.get('dependencies')[0]) : [],
});

export const handler = async (event) => {
  const res = buildResponse(event);
  if (event.httpMethod === 'OPTIONS') return res(200, {});

  let conn;
  try {
    conn = await getConnection();
    let g = traversal().withRemote(conn);
    if (process.env.GREMLIN_PARTITION) {
      g = g.withStrategies(
        new PartitionStrategy({
          partitionKey: '_partition',
          writePartition: process.env.GREMLIN_PARTITION,
          readPartitions: [process.env.GREMLIN_PARTITION],
        }),
      );
    }

    const { httpMethod, pathParameters } = event;
    const { sprintId, taskId } = pathParameters || {};

    // Tasks belong to v1 sprints, which are read-only: task writes and the
    // task-level mcp-servers/steering-docs config (which fed the deleted v1
    // ECS runtime) were removed, so only the GET routes (list + single) remain.
    switch (httpMethod) {
      case 'GET': {
        if (taskId) {
          const r = await g.V().has('Task', 'id', taskId).valueMap().next();
          if (!r.value) return res(404, { error: 'Task not found' });
          return res(200, mapTask(r.value));
        }
        const list = await g
          .V()
          .has('Sprint', 'id', sprintId)
          .out('CONTAINS')
          .hasLabel('Task')
          .valueMap()
          .toList();
        return res(200, list.map(mapTask));
      }

      default:
        return res(405, { error: 'Method not allowed' });
    }
  } catch (err) {
    console.error('Error:', err);
    return res(500, { error: 'Internal server error' });
  } finally {
    if (conn)
      try {
        await conn.close();
      } catch {}
  }
};
