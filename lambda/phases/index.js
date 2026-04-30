const gremlin = require('gremlin');
const { fromNodeProviderChain } = require('@aws-sdk/credential-providers');
const { getUrlAndHeaders } = require('gremlin-aws-sigv4/lib/utils');
const { buildResponse } = require('./shared/response');

const DriverRemoteConnection = gremlin.driver.DriverRemoteConnection;
const traversal = gremlin.process.AnonymousTraversalSource.traversal;

const getConnection = async () => {
  const host = process.env.NEPTUNE_ENDPOINT;
  const credentials = await fromNodeProviderChain()();
  credentials.region = process.env.AWS_REGION || 'us-east-1';
  const connInfo = getUrlAndHeaders(host, '8182', credentials, '/gremlin', 'wss');
  return new DriverRemoteConnection(connInfo.url, { headers: connInfo.headers });
};

exports.handler = async (event) => {
  const response = buildResponse(event);
  if (event.httpMethod === 'OPTIONS') return response(200, {});

  let conn;
  try {
    conn = await getConnection();
    const g = traversal().withRemote(conn);
    const { httpMethod, pathParameters, body } = event;
    const { projectId, phaseId } = pathParameters || {};

    switch (httpMethod) {
      case 'GET':
        if (phaseId) {
          const phase = await g.V().has('Phase', 'id', phaseId).valueMap(true).next();
          if (!phase.value) return response(404, { error: 'Phase not found' });
          return response(200, phase.value);
        }
        const phases = await g.V().has('Project', 'id', projectId)
          .out('HAS_PHASE').valueMap(true).toList();
        return response(200, phases);

      case 'PUT': {
        const data = JSON.parse(body);
        
        if (data.status === 'completed') {
          const pendingQuestions = await g.V().has('Phase', 'id', phaseId)
            .in('CREATED_IN').hasLabel('Artifact')
            .in('ASKED_BY').has('AgentQuestion', 'status', 'pending')
            .count().next();
          
          if (pendingQuestions.value > 0) {
            return response(400, { error: 'Cannot complete phase: pending agent questions' });
          }
          
          const staleArtifacts = await g.V().has('Phase', 'id', phaseId)
            .in('CREATED_IN').has('Artifact', 'stale', true)
            .count().next();
          
          if (staleArtifacts.value > 0) {
            return response(400, { error: 'Cannot complete phase: stale artifacts exist' });
          }
        }
        
        await g.V().has('Phase', 'id', phaseId)
          .property('status', data.status)
          .next();
        
        return response(200, { id: phaseId, status: data.status });
      }

      default:
        return response(405, { error: 'Method not allowed' });
    }
  } catch (err) {
    console.error(err);
    return response(500, { error: 'Internal server error' });
  } finally {
    if (conn) try { await conn.close(); } catch (e) {}
  }
};
