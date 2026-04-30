const gremlin = require('gremlin');
const { v4: uuidv4 } = require('uuid');
const { fromNodeProviderChain } = require('@aws-sdk/credential-providers');
const { getUrlAndHeaders } = require('gremlin-aws-sigv4/lib/utils');
const { buildResponse } = require('./shared/response');

const DriverRemoteConnection = gremlin.driver.DriverRemoteConnection;
const traversal = gremlin.process.AnonymousTraversalSource.traversal;
const order = gremlin.process.order;

const getConnection = async () => {
  const host = process.env.NEPTUNE_ENDPOINT;
  const credentials = await fromNodeProviderChain()();
  credentials.region = process.env.AWS_REGION || 'us-east-1';
  const connInfo = getUrlAndHeaders(host, '8182', credentials, '/gremlin', 'wss');
  return new DriverRemoteConnection(connInfo.url, { headers: connInfo.headers });
};

const mapEvent = (v) => ({
  id: v.get('id')?.[0] || '',
  type: v.get('type')?.[0] || '',
  title: v.get('title')?.[0] || '',
  detail: v.get('detail')?.[0] || '',
  userId: v.get('user_id')?.[0] || '',
  userName: v.get('user_name')?.[0] || '',
  timestamp: v.get('timestamp')?.[0] || '',
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
    const { sprintId } = pathParameters || {};

    switch (httpMethod) {
      case 'GET': {
        const list = await g.V().has('Sprint', 'id', sprintId)
          .out('HAS_TIMELINE_EVENT').hasLabel('TimelineEvent')
          .order().by('timestamp', order.desc)
          .valueMap().toList();
        return res(200, list.map(mapEvent));
      }

      case 'POST': {
        const data = JSON.parse(body);
        const id = uuidv4();
        const timestamp = data.timestamp || new Date().toISOString();

        await g.V().has('Sprint', 'id', sprintId).as('s')
          .addV('TimelineEvent')
          .property('id', id)
          .property('type', data.type)
          .property('title', data.title)
          .property('detail', data.detail || '')
          .property('user_id', data.userId || '')
          .property('user_name', data.userName || '')
          .property('timestamp', timestamp)
          .property('sprint_id', sprintId)
          .as('e')
          .addE('HAS_TIMELINE_EVENT').from_('s').to('e')
          .next();

        return res(201, {
          id,
          type: data.type,
          title: data.title,
          detail: data.detail || '',
          userId: data.userId || '',
          userName: data.userName || '',
          timestamp,
          sprintId,
        });
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
