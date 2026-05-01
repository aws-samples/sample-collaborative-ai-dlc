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

const mapCodeFile = (v) => ({
  id: v.get('id')?.[0] || '',
  filePath: v.get('file_path')?.[0] || '',
  commitRef: v.get('commit_ref')?.[0] || '',
  summary: v.get('summary')?.[0] || '',
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
    const { sprintId, codeFileId } = pathParameters || {};

    switch (httpMethod) {
      case 'GET': {
        if (codeFileId) {
          const r = await g.V().has('CodeFile', 'id', codeFileId).valueMap().next();
          if (!r.value) return res(404, { error: 'Code file not found' });
          return res(200, mapCodeFile(r.value));
        }
        const list = await g.V().has('Sprint', 'id', sprintId)
          .out('CONTAINS').hasLabel('CodeFile').valueMap().toList();
        return res(200, list.map(mapCodeFile));
      }

      case 'POST': {
        const data = JSON.parse(body);
        const id = randomUUID();

        await g.V().has('Sprint', 'id', sprintId).as('s')
          .addV('CodeFile')
          .property('id', id)
          .property('file_path', data.filePath)
          .property('commit_ref', data.commitRef || '')
          .property('summary', data.summary || '')
          .property('sprint_id', sprintId)
          .as('cf')
          .addE('CONTAINS').from_('s').to('cf')
          .next();

        // IMPLEMENTED_BY from Task
        if (data.taskId) {
          await g.V().has('Task', 'id', data.taskId).as('t')
            .V().has('CodeFile', 'id', id).as('cf')
            .addE('IMPLEMENTED_BY').from_('t').to('cf')
            .next();
        }
        // IMPLEMENTED_BY shortcut from UserStory
        if (data.userStoryId) {
          await g.V().has('UserStory', 'id', data.userStoryId).as('us')
            .V().has('CodeFile', 'id', id).as('cf')
            .addE('IMPLEMENTED_BY').from_('us').to('cf')
            .next();
        }

        return res(201, { id, filePath: data.filePath, commitRef: data.commitRef || '', summary: data.summary || '', sprintId });
      }

      case 'PUT': {
        const data = JSON.parse(body);
        if (data.filePath) await g.V().has('CodeFile', 'id', codeFileId).property(cardinality.single, 'file_path', data.filePath).next();
        if (data.commitRef !== undefined) await g.V().has('CodeFile', 'id', codeFileId).property(cardinality.single, 'commit_ref', data.commitRef).next();
        if (data.summary !== undefined) await g.V().has('CodeFile', 'id', codeFileId).property(cardinality.single, 'summary', data.summary).next();
        const updated = await g.V().has('CodeFile', 'id', codeFileId).valueMap().next();
        return res(200, mapCodeFile(updated.value));
      }

      case 'DELETE': {
        await g.V().has('CodeFile', 'id', codeFileId).drop().next();
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
