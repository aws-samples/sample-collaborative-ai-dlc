const gremlin = require('gremlin');
const { randomUUID } = require('crypto');
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

const mapStory = (v) => ({
  id: v.get('id')?.[0] || '',
  title: v.get('title')?.[0] || '',
  description: v.get('description')?.[0] || '',
  storyPoints: v.get('story_points')?.[0] || 0,
  sprintId: v.get('sprint_id')?.[0] || '',
});

exports.handler = async (event) => {
  const res = buildResponse(event);
  if (event.httpMethod === 'OPTIONS') return res(200, {});

  let conn;
  try {
    conn = await getConnection();
    const g = traversal().withRemote(conn);
    const { httpMethod, pathParameters, body } = event;
    const { sprintId, storyId } = pathParameters || {};

    switch (httpMethod) {
      case 'GET': {
        if (storyId) {
          const r = await g.V().has('UserStory', 'id', storyId).valueMap().next();
          if (!r.value) return res(404, { error: 'User story not found' });
          return res(200, mapStory(r.value));
        }
        const list = await g.V().has('Sprint', 'id', sprintId)
          .out('CONTAINS').hasLabel('UserStory').valueMap().toList();
        return res(200, list.map(mapStory));
      }

      case 'POST': {
        const data = JSON.parse(body);
        const id = randomUUID();

        await g.V().has('Sprint', 'id', sprintId).as('s')
          .addV('UserStory')
          .property('id', id)
          .property('title', data.title)
          .property('description', data.description || '')
          .property('story_points', data.storyPoints || 0)
          .property('sprint_id', sprintId)
          .as('us')
          .addE('CONTAINS').from_('s').to('us')
          .next();

        // BREAKS_INTO from Requirement
        if (data.requirementId) {
          await g.V().has('Requirement', 'id', data.requirementId).as('r')
            .V().has('UserStory', 'id', id).as('us')
            .addE('BREAKS_INTO').from_('r').to('us')
            .next();
        }

        return res(201, { id, title: data.title, description: data.description || '', storyPoints: data.storyPoints || 0, sprintId });
      }

      case 'PUT': {
        const data = JSON.parse(body);
        if (data.title) await g.V().has('UserStory', 'id', storyId).property(cardinality.single, 'title', data.title).next();
        if (data.description !== undefined) await g.V().has('UserStory', 'id', storyId).property(cardinality.single, 'description', data.description).next();
        if (data.storyPoints !== undefined) await g.V().has('UserStory', 'id', storyId).property(cardinality.single, 'story_points', data.storyPoints).next();
        const updated = await g.V().has('UserStory', 'id', storyId).valueMap().next();
        return res(200, mapStory(updated.value));
      }

      case 'DELETE': {
        await g.V().has('UserStory', 'id', storyId).drop().next();
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
