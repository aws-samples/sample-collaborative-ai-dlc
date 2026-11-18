import gremlin from 'gremlin';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { getUrlAndHeaders } from 'gremlin-aws-sigv4/lib/utils.js';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';

const traversal = gremlin.process.AnonymousTraversalSource.traversal;
const DriverRemoteConnection = gremlin.driver.DriverRemoteConnection;

const dynamoEndpoint = process.env.DYNAMODB_LOCAL_ENDPOINT || undefined;
export const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient(dynamoEndpoint ? { endpoint: dynamoEndpoint } : {}),
);

export const s3 = new S3Client({});

// Same contract as the runtime's and mcp-tools' openGraph: wss + SigV4 against
// Neptune, plain ws for the local gremlin-server used by tests. The caller
// owns and closes it.
export const openGraph = async () => {
  const endpoint = process.env.NEPTUNE_ENDPOINT;
  const port = process.env.GREMLIN_PORT ?? '8182';
  const protocol = process.env.GREMLIN_PROTOCOL ?? 'wss';
  if (protocol === 'ws') {
    return traversal().withRemote(new DriverRemoteConnection(`ws://${endpoint}:${port}/gremlin`));
  }
  const creds = await fromNodeProviderChain()();
  const info = getUrlAndHeaders(
    endpoint,
    port,
    {
      ...creds,
      accessKey: creds.accessKeyId,
      secretKey: creds.secretAccessKey,
      region: process.env.AWS_REGION || 'us-east-1',
    },
    '/gremlin',
    'wss',
  );
  return traversal().withRemote(new DriverRemoteConnection(info.url, { headers: info.headers }));
};
