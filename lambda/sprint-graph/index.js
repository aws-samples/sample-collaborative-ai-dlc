import gremlin from 'gremlin';
import { PartitionStrategy } from 'gremlin/lib/process/traversal-strategy.js';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { getUrlAndHeaders } from 'gremlin-aws-sigv4/lib/utils.js';
import { buildResponse } from '../shared/response.js';

const DriverRemoteConnection = gremlin.driver.DriverRemoteConnection;
const traversal = gremlin.process.AnonymousTraversalSource.traversal;
const __ = gremlin.process.statics;
const { t: T, P } = gremlin.process;

const getConnection = async () => {
  const host = process.env.NEPTUNE_ENDPOINT;
  const port = process.env.GREMLIN_PORT ?? '8182';
  const protocol = process.env.GREMLIN_PROTOCOL ?? 'wss';

  const credentials = await fromNodeProviderChain()();
  credentials.region = process.env.AWS_REGION ?? 'us-east-1';
  const { url, headers } = getUrlAndHeaders(host, port, credentials, '/gremlin', protocol);
  return new DriverRemoteConnection(url, { headers });
};

export const handler = async (event) => {
  const res = buildResponse(event, { methods: 'GET,OPTIONS' });
  if (event.httpMethod === 'OPTIONS') return res(200, {});

  let conn;
  try {
    conn = await getConnection();
    let g = traversal().withRemote(conn);
    if (process.env.GREMLIN_PARTITION) {
      g = g.withStrategies(
        new PartitionStrategy({
          partitionKey: '_partition',
          writePartition: process.env.GREMLIN_PARTITION,
          readPartitions: [process.env.GREMLIN_PARTITION],
        }),
      );
    }
    const { sprintId } = event.pathParameters || {};

    // Get all vertices contained in this sprint (CONTAINS + HAS_REVIEW + HAS_PR
    // + HAS_AGENT_RUN + HAS_DISCUSSION). Discussion threads are shown (linked
    // to their anchors by DISCUSSES); DiscussionMessage vertices are excluded —
    // clutter (plan §5).
    const vertices = await g
      .V()
      .has('Sprint', 'id', sprintId)
      .union(
        __.out('CONTAINS'),
        __.out('HAS_REVIEW'),
        __.out('HAS_PR'),
        __.out('HAS_AGENT_RUN'),
        __.out('HAS_DISCUSSION'),
      )
      .project('id', 'type', 'label', 'props')
      .by('id')
      .by(T.label)
      .by(
        __.coalesce(
          __.values('title'),
          __.values('entity_title'),
          __.values('file_path'),
          __.values('agent_type'),
          __.values('status'),
          __.constant('(unnamed)'),
        ),
      )
      .by(__.valueMap())
      .toList();

    const nodeIds = new Set(vertices.map((v) => v.get('id')));

    // Get all edges between these vertices
    const edges = await g
      .V()
      .has('Sprint', 'id', sprintId)
      .union(
        __.out('CONTAINS'),
        __.out('HAS_REVIEW'),
        __.out('HAS_PR'),
        __.out('HAS_AGENT_RUN'),
        __.out('HAS_DISCUSSION'),
      )
      .bothE()
      .where(__.otherV().has('id', P.within(...nodeIds)))
      .project('source', 'target', 'label')
      .by(__.outV().values('id'))
      .by(__.inV().values('id'))
      .by(T.label)
      .dedup()
      .toList();

    const nodes = vertices.map((v) => {
      const props = v.get('props');
      const data = {};
      if (props)
        props.forEach((val, key) => {
          data[key] = Array.isArray(val) ? val[0] : val;
        });
      return { id: v.get('id'), type: v.get('type'), label: v.get('label'), ...data };
    });

    const edgeList = edges
      .filter(
        (e) =>
          e.get('label') !== 'CONTAINS' &&
          e.get('label') !== 'HAS_REVIEW' &&
          e.get('label') !== 'HAS_PR' &&
          e.get('label') !== 'HAS_AGENT_RUN' &&
          e.get('label') !== 'HAS_DISCUSSION' &&
          e.get('label') !== 'HAS_MESSAGE',
      )
      .map((e) => ({
        source: e.get('source'),
        target: e.get('target'),
        label: e.get('label'),
      }));

    return res(200, { nodes, edges: edgeList });
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
