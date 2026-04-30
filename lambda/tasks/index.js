const gremlin = require('gremlin');
const { v4: uuidv4 } = require('uuid');
const { fromNodeProviderChain } = require('@aws-sdk/credential-providers');
const { getUrlAndHeaders } = require('gremlin-aws-sigv4/lib/utils');
const { buildResponse } = require('./shared/response');

const DriverRemoteConnection = gremlin.driver.DriverRemoteConnection;
const traversal = gremlin.process.AnonymousTraversalSource.traversal;
const { cardinality } = gremlin.process;

const getConnection = async () => {
  const host = process.env.NEPTUNE_ENDPOINT;
  const credentials = await fromNodeProviderChain()();
  credentials.region = process.env.AWS_REGION || 'us-east-1';
  const connInfo = getUrlAndHeaders(host, '8182', credentials, '/gremlin', 'wss');
  return new DriverRemoteConnection(connInfo.url, { headers: connInfo.headers });
};

const mapTask = (v) => ({
  id: v.get('id')?.[0] || '',
  title: v.get('title')?.[0] || '',
  description: v.get('description')?.[0] || '',
  status: v.get('status')?.[0] || 'todo',
  sprintId: v.get('sprint_id')?.[0] || '',
  dependencies: v.get('dependencies')?.[0] ? JSON.parse(v.get('dependencies')[0]) : [],
});

exports.handler = async (event) => {
  const res = buildResponse(event);
  if (event.httpMethod === 'OPTIONS') return res(200, {});

  let conn;
  try {
    conn = await getConnection();
    const g = traversal().withRemote(conn);
    const { httpMethod, pathParameters, body } = event;
    const { sprintId, taskId } = pathParameters || {};

    switch (httpMethod) {
      case 'GET': {
        if (taskId) {
          const r = await g.V().has('Task', 'id', taskId).valueMap().next();
          if (!r.value) return res(404, { error: 'Task not found' });
          return res(200, mapTask(r.value));
        }
        const list = await g.V().has('Sprint', 'id', sprintId)
          .out('CONTAINS').hasLabel('Task').valueMap().toList();
        return res(200, list.map(mapTask));
      }

      case 'POST': {
        const data = JSON.parse(body);
        const id = uuidv4();
        const dependencies = data.dependencies || [];

        await g.V().has('Sprint', 'id', sprintId).as('s')
          .addV('Task')
          .property('id', id)
          .property('title', data.title)
          .property('description', data.description || '')
          .property('status', data.status || 'todo')
          .property('sprint_id', sprintId)
          .property('dependencies', JSON.stringify(dependencies))
          .as('t')
          .addE('CONTAINS').from_('s').to('t')
          .next();

        // BREAKS_INTO from Requirement and/or UserStory
        if (data.requirementId) {
          await g.V().has('Requirement', 'id', data.requirementId).as('r')
            .V().has('Task', 'id', id).as('t')
            .addE('BREAKS_INTO').from_('r').to('t')
            .next();
        }
        if (data.userStoryId) {
          await g.V().has('UserStory', 'id', data.userStoryId).as('us')
            .V().has('Task', 'id', id).as('t')
            .addE('BREAKS_INTO').from_('us').to('t')
            .next();
        }

        // DEPENDS_ON edges for task dependencies
        for (const depId of dependencies) {
          await g.V().has('Task', 'id', id).as('t')
            .V().has('Task', 'id', depId).as('dep')
            .addE('DEPENDS_ON').from_('t').to('dep')
            .next();
        }

        return res(201, { id, title: data.title, description: data.description || '', status: data.status || 'todo', sprintId, dependencies });
      }

      case 'PUT': {
        const data = JSON.parse(body);
        if (data.title) await g.V().has('Task', 'id', taskId).property(cardinality.single, 'title', data.title).next();
        if (data.description !== undefined) await g.V().has('Task', 'id', taskId).property(cardinality.single, 'description', data.description).next();
        if (data.status) {
          await g.V().has('Task', 'id', taskId).property(cardinality.single, 'status', data.status).next();
          
          // When resetting a task back to "todo", clear execution metadata so it can be re-dispatched cleanly.
          // This handles the case where a task was marked "done" or "failed" but the work was lost (e.g. push failed).
          if (data.status === 'todo') {
            await g.V().has('Task', 'id', taskId)
              .property(cardinality.single, 'task_execution_id', '')
              .property(cardinality.single, 'task_execution_arn', '')
              .property(cardinality.single, 'task_execution_status', 'reset')
              .next();
          }
        }
        
        // Update dependencies if provided
        if (data.dependencies !== undefined) {
          await g.V().has('Task', 'id', taskId).property(cardinality.single, 'dependencies', JSON.stringify(data.dependencies)).next();
          
          // Remove old DEPENDS_ON edges
          await g.V().has('Task', 'id', taskId).outE('DEPENDS_ON').drop().next();
          
          // Add new DEPENDS_ON edges
          for (const depId of data.dependencies) {
            await g.V().has('Task', 'id', taskId).as('t')
              .V().has('Task', 'id', depId).as('dep')
              .addE('DEPENDS_ON').from_('t').to('dep')
              .next();
          }
        }
        
        const updated = await g.V().has('Task', 'id', taskId).valueMap().next();
        return res(200, mapTask(updated.value));
      }

      case 'DELETE': {
        await g.V().has('Task', 'id', taskId).drop().next();
        return res(204, {});
      }

      default:
        return res(405, { error: 'Method not allowed' });
    }
  } catch (err) {
    console.error('Error:', err);
    return res(500, { error: 'Internal server error' });
  } finally {
    if (conn) try { await conn.close(); } catch (e) {}
  }
};
