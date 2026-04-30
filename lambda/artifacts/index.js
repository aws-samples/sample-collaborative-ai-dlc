const gremlin = require('gremlin');
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { v4: uuidv4 } = require('uuid');
const { fromNodeProviderChain } = require('@aws-sdk/credential-providers');
const { getUrlAndHeaders } = require('gremlin-aws-sigv4/lib/utils');
const { buildResponse } = require('./shared/response');

const DriverRemoteConnection = gremlin.driver.DriverRemoteConnection;
const traversal = gremlin.process.AnonymousTraversalSource.traversal;
const s3 = new S3Client({});

const getConnection = async () => {
  const host = process.env.NEPTUNE_ENDPOINT;
  const port = '8182';
  const region = process.env.AWS_REGION || 'us-east-1';
  
  const credentials = await fromNodeProviderChain()();
  credentials.region = region;
  
  const connInfo = getUrlAndHeaders(host, port, credentials, '/gremlin', 'wss');
  
  return new DriverRemoteConnection(connInfo.url, { headers: connInfo.headers });
};

exports.handler = async (event) => {
  const response = buildResponse(event);
  console.log('Request:', JSON.stringify({ httpMethod: event.httpMethod, path: event.path, pathParameters: event.pathParameters }));
  
  if (event.httpMethod === 'OPTIONS') {
    return response(200, {});
  }

  let conn;
  try {
    conn = await getConnection();
    const g = traversal().withRemote(conn);
    
    const { httpMethod, pathParameters, body } = event;
    const { projectId, artifactId } = pathParameters || {};

    switch (httpMethod) {
      case 'GET':
        if (artifactId) {
          const artifact = await g.V().has('Artifact', 'id', artifactId).valueMap(true).next();
          if (!artifact.value) return response(404, { error: 'Artifact not found' });
          const val = artifact.value;
          return response(200, {
            id: val.id[0],
            type: val.type[0],
            contentS3Key: val.content_s3_key[0],
            stale: val.stale[0],
            createdAt: val.created_at[0],
            updatedAt: val.updated_at[0]
          });
        }
        const artifacts = await g.V().has('Project', 'id', projectId)
          .out('HAS_ARTIFACT').valueMap(true).toList();
        return response(200, artifacts.map(a => ({
          id: a.id[0],
          type: a.type[0],
          contentS3Key: a.content_s3_key[0],
          stale: a.stale[0],
          createdAt: a.created_at[0],
          updatedAt: a.updated_at[0]
        })));

      case 'POST': {
        const data = JSON.parse(body);
        const id = uuidv4();
        const s3Key = `${projectId}/${id}`;
        
        if (data.content) {
          await s3.send(new PutObjectCommand({
            Bucket: process.env.ARTIFACTS_BUCKET,
            Key: s3Key,
            Body: data.content,
          }));
        }
        
        const now = new Date().toISOString();
        await g.addV('Artifact')
          .property('id', id)
          .property('type', data.type)
          .property('content_s3_key', s3Key)
          .property('stale', false)
          .property('created_at', now)
          .property('updated_at', now)
          .next();
        
        await g.V().has('Project', 'id', projectId)
          .addE('HAS_ARTIFACT')
          .to(g.V().has('Artifact', 'id', id))
          .next();
        
        return response(201, { id, type: data.type, contentS3Key: s3Key, stale: false, createdAt: now, updatedAt: now });
      }

      case 'PUT': {
        const data = JSON.parse(body);
        const artifact = await g.V().has('Artifact', 'id', artifactId).valueMap(true).next();
        if (!artifact.value) return response(404, { error: 'Artifact not found' });
        
        if (data.content) {
          await s3.send(new PutObjectCommand({
            Bucket: process.env.ARTIFACTS_BUCKET,
            Key: artifact.value.content_s3_key[0],
            Body: data.content,
          }));
        }
        
        await g.V().has('Artifact', 'id', artifactId)
          .property('updated_at', new Date().toISOString())
          .next();
        
        return response(200, { id: artifactId });
      }

      case 'DELETE': {
        const artifact = await g.V().has('Artifact', 'id', artifactId).valueMap(true).next();
        if (artifact.value?.content_s3_key) {
          await s3.send(new DeleteObjectCommand({
            Bucket: process.env.ARTIFACTS_BUCKET,
            Key: artifact.value.content_s3_key[0],
          }));
        }
        await g.V().has('Artifact', 'id', artifactId).drop().next();
        return response(204, null);
      }

      default:
        return response(405, { error: 'Method not allowed' });
    }
  } catch (err) {
    console.error('Error:', err);
    return response(500, { error: 'Internal server error' });
  } finally {
    if (conn) {
      try { await conn.close(); } catch (e) { console.error('Error closing connection:', e); }
    }
  }
};
