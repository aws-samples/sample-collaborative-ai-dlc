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

const mapReq = (v) => ({
  id: v.get('id')?.[0] || '',
  title: v.get('title')?.[0] || '',
  description: v.get('description')?.[0] || '',
  acceptanceCriteria: v.get('acceptance_criteria')?.[0] || '',
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
    const { sprintId, requirementId } = pathParameters || {};

    switch (httpMethod) {
      case 'GET': {
        if (requirementId) {
          const r = await g.V().has('Requirement', 'id', requirementId).valueMap().next();
          if (!r.value) return res(404, { error: 'Requirement not found' });
          return res(200, mapReq(r.value));
        }
        const list = await g.V().has('Sprint', 'id', sprintId)
          .out('CONTAINS').hasLabel('Requirement').valueMap().toList();
        return res(200, list.map(mapReq));
      }

      case 'POST': {
        const data = JSON.parse(body);
        const id = randomUUID();

        await g.V().has('Sprint', 'id', sprintId).as('s')
          .addV('Requirement')
          .property('id', id)
          .property('title', data.title)
          .property('description', data.description || '')
          .property('acceptance_criteria', data.acceptanceCriteria || '')
          .property('sprint_id', sprintId)
          .as('r')
          .addE('CONTAINS').from_('s').to('r')
          .next();

        // CARRIED_FROM edge if carrying from another sprint
        if (data.carriedFromId) {
          await g.V().has('Requirement', 'id', id).as('new')
            .V().has('Requirement', 'id', data.carriedFromId).as('old')
            .addE('CARRIED_FROM').from_('new').to('old')
            .next();
        }

        return res(201, { id, title: data.title, description: data.description || '', acceptanceCriteria: data.acceptanceCriteria || '', sprintId });
      }

      case 'PUT': {
        const data = JSON.parse(body);
        const v = g.V().has('Requirement', 'id', requirementId);
        if (data.title) await v.property(cardinality.single, 'title', data.title).next();
        if (data.description !== undefined) await g.V().has('Requirement', 'id', requirementId).property(cardinality.single, 'description', data.description).next();
        if (data.acceptanceCriteria !== undefined) await g.V().has('Requirement', 'id', requirementId).property(cardinality.single, 'acceptance_criteria', data.acceptanceCriteria).next();
        const updated = await g.V().has('Requirement', 'id', requirementId).valueMap().next();
        return res(200, mapReq(updated.value));
      }

      case 'DELETE': {
        await g.V().has('Requirement', 'id', requirementId).drop().next();
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
