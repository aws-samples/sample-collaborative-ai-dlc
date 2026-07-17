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

const mapCodeFile = (v) => ({
  id: v.get('id')?.[0] || '',
  filePath: v.get('file_path')?.[0] || '',
  repository: v.get('repository')?.[0] || '',
  commitRef: v.get('commit_ref')?.[0] || '',
  summary: v.get('summary')?.[0] || '',
  sprintId: v.get('sprint_id')?.[0] || '',
});

export const handler = async (event) => {
  const res = buildResponse(event);
  if (event.httpMethod === 'OPTIONS') return res(200, {});

  let conn;
  try {
    conn = await getConnection();
    const g = traversal().withRemote(conn);
    const { httpMethod, pathParameters } = event;
    const { sprintId, codeFileId } = pathParameters || {};

    // v1 projects are read-only: code-file writes were removed together with
    // the v1 execution engine, so only the GET routes remain.
    switch (httpMethod) {
      case 'GET': {
        const auth = await authorizeLegacySprintRead(g, event, sprintId);
        if (auth.denied) return res(auth.statusCode, { error: auth.error });
        if (codeFileId) {
          const r = await g
            .V()
            .has('Sprint', 'id', sprintId)
            .out('CONTAINS')
            .has('CodeFile', 'id', codeFileId)
            .valueMap()
            .next();
          if (!r.value) return res(404, { error: 'Code file not found' });
          return res(200, mapCodeFile(r.value));
        }
        const list = await g
          .V()
          .has('Sprint', 'id', sprintId)
          .out('CONTAINS')
          .hasLabel('CodeFile')
          .valueMap()
          .toList();
        return res(200, list.map(mapCodeFile));
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
