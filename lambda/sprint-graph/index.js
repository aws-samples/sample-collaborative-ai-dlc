const gremlin = require('gremlin');
const { fromNodeProviderChain } = require('@aws-sdk/credential-providers');
const { getUrlAndHeaders } = require('gremlin-aws-sigv4/lib/utils');
const { buildResponse } = require('./shared/response');

const DriverRemoteConnection = gremlin.driver.DriverRemoteConnection;
const traversal = gremlin.process.AnonymousTraversalSource.traversal;
const { t: T } = gremlin.process;

const getConnection = async () => {
  const host = process.env.NEPTUNE_ENDPOINT;
  const credentials = await fromNodeProviderChain()();
  credentials.region = process.env.AWS_REGION || 'us-east-1';
  const connInfo = getUrlAndHeaders(host, '8182', credentials, '/gremlin', 'wss');
  return new DriverRemoteConnection(connInfo.url, { headers: connInfo.headers });
};

exports.handler = async (event) => {
  const res = buildResponse(event, { methods: 'GET,OPTIONS' });
  if (event.httpMethod === 'OPTIONS') return res(200, {});

  let conn;
  try {
    conn = await getConnection();
    const g = traversal().withRemote(conn);
    const { sprintId } = event.pathParameters || {};

    // Get all vertices contained in this sprint (CONTAINS + HAS_REVIEW + HAS_PR + HAS_AGENT_RUN)
    const vertices = await g.V().has('Sprint', 'id', sprintId)
      .union(
        gremlin.process.statics.out('CONTAINS'),
        gremlin.process.statics.out('HAS_REVIEW'),
        gremlin.process.statics.out('HAS_PR'),
        gremlin.process.statics.out('HAS_AGENT_RUN')
      )
      .project('id', 'type', 'label', 'props')
      .by('id')
      .by(T.label)
      .by(gremlin.process.statics.coalesce(
        gremlin.process.statics.values('title'),
        gremlin.process.statics.values('file_path'),
        gremlin.process.statics.values('agent_type'),
        gremlin.process.statics.values('status'),
        gremlin.process.statics.constant('(unnamed)')
      ))
      .by(gremlin.process.statics.valueMap())
      .toList();

    const nodeIds = new Set(vertices.map(v => v.get('id')));

    // Get all edges between these vertices
    const edges = await g.V().has('Sprint', 'id', sprintId)
      .union(
        gremlin.process.statics.out('CONTAINS'),
        gremlin.process.statics.out('HAS_REVIEW'),
        gremlin.process.statics.out('HAS_PR'),
        gremlin.process.statics.out('HAS_AGENT_RUN')
      )
      .bothE()
      .where(gremlin.process.statics.otherV().has('id', gremlin.process.P.within(...nodeIds)))
      .project('source', 'target', 'label')
      .by(gremlin.process.statics.outV().values('id'))
      .by(gremlin.process.statics.inV().values('id'))
      .by(T.label)
      .dedup()
      .toList();

    const nodes = vertices.map(v => {
      const props = v.get('props');
      const data = {};
      if (props) props.forEach((val, key) => { data[key] = Array.isArray(val) ? val[0] : val; });
      return { id: v.get('id'), type: v.get('type'), label: v.get('label'), ...data };
    });

    const edgeList = edges
      .filter(e => e.get('label') !== 'CONTAINS' && e.get('label') !== 'HAS_REVIEW' && e.get('label') !== 'HAS_PR' && e.get('label') !== 'HAS_AGENT_RUN')
      .map(e => ({
        source: e.get('source'),
        target: e.get('target'),
        label: e.get('label'),
      }));

    return res(200, { nodes, edges: edgeList });
  } catch (err) {
    console.error('Error:', err);
    return res(500, { error: 'Internal server error' });
  } finally {
    if (conn) try { await conn.close(); } catch (e) {}
  }
};
