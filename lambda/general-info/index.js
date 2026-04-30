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

const mapInfo = (v) => ({
  id: v.get('id')?.[0] || '',
  type: v.get('type')?.[0] || '',
  title: v.get('title')?.[0] || '',
  content: v.get('content')?.[0] || '',
  sprintId: v.get('sprint_id')?.[0] || '',
  createdAt: v.get('createdAt')?.[0] || '',
});

exports.handler = async (event) => {
  const res = buildResponse(event);
  if (event.httpMethod === 'OPTIONS') return res(200, {});

  let conn;
  try {
    conn = await getConnection();
    const g = traversal().withRemote(conn);
    const { httpMethod, pathParameters, body } = event;
    const { sprintId, infoId } = pathParameters || {};

    switch (httpMethod) {
      case 'GET': {
        if (infoId) {
          const r = await g.V().has('GeneralInfo', 'id', infoId).valueMap().next();
          if (!r.value) return res(404, { error: 'GeneralInfo not found' });
          return res(200, mapInfo(r.value));
        }
        const list = await g.V().has('Sprint', 'id', sprintId)
          .out('CONTAINS').hasLabel('GeneralInfo').valueMap().toList();
        return res(200, list.map(mapInfo));
      }

      case 'POST': {
        const data = JSON.parse(body);
        const id = uuidv4();
        const now = new Date().toISOString();

        await g.V().has('Sprint', 'id', sprintId).as('s')
          .addV('GeneralInfo')
          .property('id', id)
          .property('type', data.type)
          .property('title', data.title)
          .property('content', data.content || '')
          .property('sprint_id', sprintId)
          .property('createdAt', now)
          .as('gi')
          .addE('CONTAINS').from_('s').to('gi')
          .next();

        return res(201, { id, type: data.type, title: data.title, content: data.content || '', sprintId, createdAt: now });
      }

      case 'PUT': {
        const data = JSON.parse(body);
        if (data.type) await g.V().has('GeneralInfo', 'id', infoId).property(cardinality.single, 'type', data.type).next();
        if (data.title) await g.V().has('GeneralInfo', 'id', infoId).property(cardinality.single, 'title', data.title).next();
        if (data.content !== undefined) await g.V().has('GeneralInfo', 'id', infoId).property(cardinality.single, 'content', data.content).next();
        const updated = await g.V().has('GeneralInfo', 'id', infoId).valueMap().next();
        return res(200, mapInfo(updated.value));
      }

      case 'DELETE': {
        await g.V().has('GeneralInfo', 'id', infoId).drop().next();
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
