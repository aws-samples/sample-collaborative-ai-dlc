const gremlin = require('gremlin');
const { fromNodeProviderChain } = require('@aws-sdk/credential-providers');
const { getUrlAndHeaders } = require('gremlin-aws-sigv4/lib/utils');

const DriverRemoteConnection = gremlin.driver.DriverRemoteConnection;
const traversal = gremlin.process.AnonymousTraversalSource.traversal;

exports.handler = async () => {
  const host = process.env.NEPTUNE_ENDPOINT;
  const credentials = await fromNodeProviderChain()();
  credentials.region = process.env.AWS_REGION || 'us-east-1';
  const connInfo = getUrlAndHeaders(host, '8182', credentials, '/gremlin', 'wss');
  const conn = new DriverRemoteConnection(connInfo.url, { headers: connInfo.headers });

  try {
    const g = traversal().withRemote(conn);
    const count = await g.V().count().next();
    await g.V().drop().next();
    return { statusCode: 200, dropped: count.value };
  } finally {
    await conn.close();
  }
};
