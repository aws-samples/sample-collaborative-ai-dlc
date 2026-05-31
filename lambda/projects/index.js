import gremlin from 'gremlin';
import { PartitionStrategy } from 'gremlin/lib/process/traversal-strategy.js';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { getUrlAndHeaders } from 'gremlin-aws-sigv4/lib/utils.js';
import { buildResponse } from '../shared/response.js';
import { validateMcpServersJson } from '../shared/mcp-validator.js';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';


const DriverRemoteConnection = gremlin.driver.DriverRemoteConnection;
const traversal = gremlin.process.AnonymousTraversalSource.traversal;
const __ = gremlin.process.statics;
const { cardinality } = gremlin.process;

// Extract a property value from a Neptune valueMap result (handles both Map and plain object)
const getVal = (obj, key) => {
  if (!obj) return '';
  const raw = obj instanceof Map ? obj.get(key) : obj[key];
  if (Array.isArray(raw)) return raw[0] ?? '';
  return raw ?? '';
};

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
  const response = buildResponse(event);
  console.log(
    'Request:',
    JSON.stringify({
      httpMethod: event.httpMethod,
      path: event.path,
      pathParameters: event.pathParameters,
    }),
  );

  // Handle OPTIONS for CORS
  if (event.httpMethod === 'OPTIONS') {
    return response(200, {});
  }

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

    const { httpMethod, pathParameters, body } = event;
    const projectId = pathParameters?.projectId;
    const userId = event.requestContext?.authorizer?.claims?.sub;
    const userEmail = event.requestContext?.authorizer?.claims?.email || '';

    // ---------------------------------------------------------------------------
    // Sub-resource routing: /projects/{projectId}/mcp-servers
    //                       /projects/{projectId}/steering-docs
    // Detected by examining event.path since each sub-resource has its own
    // API Gateway resource that maps to this Lambda.
    // ---------------------------------------------------------------------------
    const requestPath = event.path || '';
    if (projectId && requestPath.endsWith('/mcp-servers')) {
      return await handleProjectMcpServers(g, response, httpMethod, projectId, userId, body);
    }
    if (projectId && requestPath.endsWith('/steering-docs')) {
      return await handleProjectSteeringDocs(g, response, httpMethod, projectId, userId, body);
    }

    switch (httpMethod) {
      case 'GET':
        if (projectId) {
          // Single project lookup - verify user is a member and return their role
          if (!userId) return response(401, { error: 'Unauthorized' });

          const memberEdges = await g
            .V()
            .has('Project', 'id', projectId)
            .outE('HAS_MEMBER')
            .as('e')
            .inV()
            .has('User', 'id', userId)
            .select('e')
            .by(__.valueMap())
            .toList();
          if (memberEdges.length === 0) return response(403, { error: 'Access denied' });

          const userRole = getVal(memberEdges[0], 'role') || 'member';

          const result = await g.V().has('Project', 'id', projectId).valueMap().next();
          if (!result.value) return response(404, { error: 'Project not found' });

          const v = result.value;
          const project = {
            id: getVal(v, 'id') || projectId,
            name: getVal(v, 'name'),
            gitProvider: getVal(v, 'git_provider') || 'github',
            gitRepo: getVal(v, 'git_repo'),
            agentCli: getVal(v, 'agent_cli') || 'kiro',
            issueIntegrationEnabled: getVal(v, 'issue_integration_enabled') === 'true',
            createdAt: getVal(v, 'created_at') || new Date().toISOString(),
            userRole,
          };
          return response(200, project);
        }

        // List projects - only return projects where the current user is a member
        if (!userId) return response(401, { error: 'Unauthorized' });

        const results = await g
          .V()
          .has('User', 'id', userId)
          .inE('HAS_MEMBER')
          .as('e')
          .outV()
          .hasLabel('Project')
          .as('p')
          .select('e', 'p')
          .by(__.valueMap())
          .by(__.valueMap())
          .toList();
        const projects = results.map((item) => {
          // item is a Map with keys 'e' (edge) and 'p' (project vertex)
          const e = item instanceof Map ? item.get('e') : item.e;
          const v = item instanceof Map ? item.get('p') : item.p;
          return {
            id: getVal(v, 'id'),
            name: getVal(v, 'name'),
            gitProvider: getVal(v, 'git_provider') || 'github',
            gitRepo: getVal(v, 'git_repo'),
            agentCli: getVal(v, 'agent_cli') || 'kiro',
            issueIntegrationEnabled: getVal(v, 'issue_integration_enabled') === 'true',
            createdAt: getVal(v, 'created_at') || new Date().toISOString(),
            userRole: getVal(e, 'role') || 'member',
          };
        });
        return response(200, projects);

      case 'POST': {
        if (!userId) return response(401, { error: 'Unauthorized' });

        const data = JSON.parse(body);
        const id = randomUUID();
        const createdAt = new Date().toISOString();

        const issueIntegrationEnabled = data.issueIntegrationEnabled === true;

        // Create the project vertex with creator tracking
        await g
          .addV('Project')
          .property('id', id)
          .property('name', data.name)
          .property('git_provider', data.gitProvider || 'github')
          .property('git_repo', data.gitRepo || '')
          .property('agent_cli', data.agentCli || 'kiro')
          .property('issue_integration_enabled', issueIntegrationEnabled ? 'true' : 'false')
          .property('created_by', userId)
          .property('created_at', createdAt)
          .next();

        // Ensure the User vertex exists
        const userExists = await g.V().has('User', 'id', userId).hasNext();
        if (!userExists) {
          await g.addV('User').property('id', userId).property('email', userEmail).next();
        }

        // Add the creator as project owner
        await g
          .V()
          .has('Project', 'id', id)
          .addE('HAS_MEMBER')
          .property('role', 'owner')
          .to(__.V().has('User', 'id', userId))
          .next();

        return response(201, {
          id,
          name: data.name,
          gitProvider: data.gitProvider || 'github',
          gitRepo: data.gitRepo || '',
          agentCli: data.agentCli || 'kiro',
          issueIntegrationEnabled,
          createdAt,
        });
      }

      case 'PUT': {
        if (!userId) return response(401, { error: 'Unauthorized' });

        // Owners and admins can update project settings
        const updateEdges = await g
          .V()
          .has('Project', 'id', projectId)
          .outE('HAS_MEMBER')
          .as('e')
          .inV()
          .has('User', 'id', userId)
          .select('e')
          .by(__.valueMap())
          .toList();
        if (updateEdges.length === 0) return response(403, { error: 'Access denied' });

        const updaterRole = getVal(updateEdges[0], 'role') || 'member';
        if (updaterRole !== 'owner' && updaterRole !== 'admin') {
          return response(403, { error: 'Only project owners and admins can update settings' });
        }

        const data = JSON.parse(body);
        let vertex;
        if (data.name) {
          vertex = g.V().has('Project', 'id', projectId);
          await vertex.property(cardinality.single, 'name', data.name).next();
        }
        if (data.gitRepo !== undefined) {
          vertex = g.V().has('Project', 'id', projectId);
          await vertex.property(cardinality.single, 'git_repo', data.gitRepo).next();
        }
        if (data.gitProvider) {
          vertex = g.V().has('Project', 'id', projectId);
          await vertex.property(cardinality.single, 'git_provider', data.gitProvider).next();
        }
        if (data.agentCli) {
          const validClis = ['kiro', 'claude', 'opencode'];
          if (!validClis.includes(data.agentCli)) {
            return response(400, {
              error: `Invalid agentCli value. Must be one of: ${validClis.join(', ')}`,
            });
          }
          vertex = g.V().has('Project', 'id', projectId);
          await vertex.property(cardinality.single, 'agent_cli', data.agentCli).next();
        }
        if (data.issueIntegrationEnabled !== undefined) {
          vertex = g.V().has('Project', 'id', projectId);
          await vertex
            .property(
              cardinality.single,
              'issue_integration_enabled',
              data.issueIntegrationEnabled ? 'true' : 'false',
            )
            .next();
        }
        return response(200, { id: projectId, ...data });
      }

      case 'DELETE':
        if (!userId) return response(401, { error: 'Unauthorized' });

        // Only owners can delete projects
        const canDelete = await g
          .V()
          .has('Project', 'id', projectId)
          .outE('HAS_MEMBER')
          .has('role', 'owner')
          .inV()
          .has('User', 'id', userId)
          .hasNext();
        if (!canDelete) return response(403, { error: 'Only project owners can delete projects' });

        await g.V().has('Project', 'id', projectId).drop().next();
        return response(204, {});

      default:
        return response(405, { error: 'Method not allowed' });
    }
  } catch (err) {
    console.error('Error:', err);
    return response(500, {
      error: 'Internal server error',
      message: err.message,
      neptune: process.env.NEPTUNE_ENDPOINT,
    });
  } finally {
    if (conn) {
      try {
        await conn.close();
      } catch (e) {
        console.error('Error closing connection:', e);
      }
    }
  }
};

// ---------------------------------------------------------------------------
// Project-level MCP servers: GET/PUT /projects/{projectId}/mcp-servers
// ---------------------------------------------------------------------------

async function handleProjectMcpServers(g, response, httpMethod, projectId, userId, body) {
  if (!userId) return response(401, { error: 'Unauthorized' });

  // Verify user is a project member
  const memberEdges = await g
    .V()
    .has('Project', 'id', projectId)
    .outE('HAS_MEMBER')
    .as('e')
    .inV()
    .has('User', 'id', userId)
    .select('e')
    .by(__.valueMap())
    .toList();
  if (memberEdges.length === 0) return response(403, { error: 'Access denied' });

  if (httpMethod === 'GET') {
    const result = await g.V().has('Project', 'id', projectId).valueMap('mcp_servers').next();
    const raw = result.value ? getVal(result.value, 'mcp_servers') : '[]';
    return response(200, { mcpServers: raw || '[]' });
  }

  if (httpMethod === 'PUT') {
    const data = JSON.parse(body || '{}');
    const mcpServersJson = data.mcpServers || '[]';
    const validation = validateMcpServersJson(mcpServersJson);
    if (!validation.valid) {
      return response(400, {
        error: 'Invalid MCP servers configuration',
        issues: validation.issues,
      });
    }
    await g
      .V()
      .has('Project', 'id', projectId)
      .property(cardinality.single, 'mcp_servers', mcpServersJson)
      .next();
    return response(200, { saved: true });
  }

  return response(405, { error: 'Method not allowed' });
}

// ---------------------------------------------------------------------------
// Project-level steering docs: GET/PUT /projects/{projectId}/steering-docs
// ---------------------------------------------------------------------------

async function handleProjectSteeringDocs(g, response, httpMethod, projectId, userId, body) {
  if (!userId) return response(401, { error: 'Unauthorized' });

  // Verify user is a project member
  const memberEdges = await g
    .V()
    .has('Project', 'id', projectId)
    .outE('HAS_MEMBER')
    .as('e')
    .inV()
    .has('User', 'id', userId)
    .select('e')
    .by(__.valueMap())
    .toList();
  if (memberEdges.length === 0) return response(403, { error: 'Access denied' });

  const artifactsBucket = process.env.ARTIFACTS_BUCKET;
  const region = process.env.AWS_REGION || 'us-east-1';
  const s3 = new S3Client({ region });

  if (httpMethod === 'GET') {
    const result = await g.V().has('Project', 'id', projectId).valueMap('steering_docs').next();
    const raw = result.value ? getVal(result.value, 'steering_docs') : '[]';
    let docs = [];
    try {
      docs = JSON.parse(raw || '[]');
    } catch {
      docs = [];
    }

    // Generate presigned download URLs for each doc
    const docsWithUrls = await Promise.all(
      docs.map(async (doc) => {
        if (!doc.s3Key || !artifactsBucket) return doc;
        try {
          const downloadUrl = await getSignedUrl(
            s3,
            new GetObjectCommand({ Bucket: artifactsBucket, Key: doc.s3Key }),
            { expiresIn: 3600 },
          );
          return { ...doc, downloadUrl };
        } catch {
          return doc;
        }
      }),
    );

    return response(200, { steeringDocs: docsWithUrls });
  }

  if (httpMethod === 'PUT') {
    const data = JSON.parse(body || '{}');
    const incomingDocs = data.steeringDocs || [];

    if (!artifactsBucket) {
      return response(500, { error: 'ARTIFACTS_BUCKET env var not configured' });
    }
    if (incomingDocs.length > 20) {
      return response(400, { error: 'Maximum 20 steering documents per project' });
    }

    // Compute S3 keys and generate presigned upload URLs for new/changed docs
    const uploadUrls = [];
    const savedDocs = [];
    for (const doc of incomingDocs) {
      const filename = doc.filename || '';
      const safeBase = path.basename(filename);
      if (!safeBase || safeBase !== filename || !safeBase.toLowerCase().endsWith('.md')) {
        return response(400, {
          error: `Invalid filename "${filename}". Must end in .md and contain no path separators.`,
        });
      }
      const s3Key = `steering/${projectId}/project--${safeBase}`;
      try {
        const uploadUrl = await getSignedUrl(
          s3,
          new PutObjectCommand({
            Bucket: artifactsBucket,
            Key: s3Key,
            ContentType: 'text/markdown',
          }),
          { expiresIn: 3600 },
        );
        uploadUrls.push({ filename: safeBase, s3Key, uploadUrl });
      } catch (err) {
        console.error(`[projects] Failed to generate presigned URL for ${s3Key}:`, err.message);
      }
      savedDocs.push({ filename: safeBase, s3Key });
    }

    // Persist metadata to Neptune
    const metadataJson = JSON.stringify(savedDocs);
    await g
      .V()
      .has('Project', 'id', projectId)
      .property(cardinality.single, 'steering_docs', metadataJson)
      .next();

    return response(200, { saved: true, uploadUrls });
  }

  return response(405, { error: 'Method not allowed' });
}
