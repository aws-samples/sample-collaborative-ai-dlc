import gremlin from 'gremlin';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { getUrlAndHeaders } from 'gremlin-aws-sigv4/lib/utils.js';
import { buildResponse } from '../shared/response.js';
import { authorizeLegacySprintRead } from '../shared/legacy-authz.js';

const DriverRemoteConnection = gremlin.driver.DriverRemoteConnection;
const traversal = gremlin.process.AnonymousTraversalSource.traversal;

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

export const handler = async (event) => {
  const res = buildResponse(event);
  if (event.httpMethod === 'OPTIONS') return res(200, {});

  let conn;
  try {
    conn = await getConnection();
    const g = traversal().withRemote(conn);
    const { httpMethod, pathParameters } = event;
    const { sprintId, infoId } = pathParameters || {};

    // v1 projects are read-only: general-info writes were removed together with
    // the v1 execution engine, so only the GET routes remain.
    switch (httpMethod) {
      case 'GET': {
        const auth = await authorizeLegacySprintRead(g, event, sprintId);
        if (auth.denied) return res(auth.statusCode, { error: auth.error });
        if (infoId) {
          const r = await g
            .V()
            .has('Sprint', 'id', sprintId)
            .out('CONTAINS')
            .has('GeneralInfo', 'id', infoId)
            .valueMap()
            .next();
          if (!r.value) return res(404, { error: 'GeneralInfo not found' });
          return res(200, mapInfo(r.value));
        }
        const list = await g
          .V()
          .has('Sprint', 'id', sprintId)
          .out('CONTAINS')
          .hasLabel('GeneralInfo')
          .valueMap()
          .toList();
        return res(200, list.map(mapInfo));
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
