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
const { cardinality } = gremlin.process;

const getConnection = async () => {
  const host = process.env.NEPTUNE_ENDPOINT;
  const port = process.env.GREMLIN_PORT ?? '8182';
  const protocol = process.env.GREMLIN_PROTOCOL ?? 'wss';

  const credentials = await fromNodeProviderChain()();
  credentials.region = process.env.AWS_REGION ?? 'us-east-1';
  const { url, headers } = getUrlAndHeaders(host, port, credentials, '/gremlin', protocol);
  return new DriverRemoteConnection(url, { headers });
};

const mapTask = (v) => ({
  id: v.get('id')?.[0] || '',
  title: v.get('title')?.[0] || '',
  description: v.get('description')?.[0] || '',
  status: v.get('status')?.[0] || 'todo',
  sprintId: v.get('sprint_id')?.[0] || '',
  dependencies: v.get('dependencies')?.[0] ? JSON.parse(v.get('dependencies')[0]) : [],
});

// ---------------------------------------------------------------------------
// Authorization helpers
// ---------------------------------------------------------------------------

// Verify taskId belongs to sprintId AND caller is a project member.
// Returns null on success, or a response on failure.
async function authorizeTaskAccess(g, res, event, sprintId, taskId) {
  const userId = event.requestContext?.authorizer?.claims?.sub;
  if (!userId) return res(401, { error: 'Unauthorized' });

  // Validate taskId belongs to sprintId via CONTAINS edge
  const belongs = await g
    .V()
    .has('Sprint', 'id', sprintId)
    .out('CONTAINS')
    .has('Task', 'id', taskId)
    .hasNext();
  if (!belongs) return res(403, { error: 'Task does not belong to this sprint' });

  // Derive projectId from sprint and check caller is a member
  const projectVertex = await g
    .V()
    .has('Sprint', 'id', sprintId)
    .in_('HAS_SPRINT')
    .hasLabel('Project')
    .values('id')
    .next();
  if (!projectVertex.value) return res(404, { error: 'Project not found for sprint' });

  const projectId = projectVertex.value;

  const isMember = await g
    .V()
    .has('Project', 'id', projectId)
    .out('HAS_MEMBER')
    .has('User', 'id', userId)
    .hasNext();
  if (!isMember) return res(403, { error: 'Access denied' });

  return null;
}

// Verify task status is 'todo'. Returns null on success, or a response on failure.
async function requireTodoStatus(g, res, taskId) {
  const r = await g.V().has('Task', 'id', taskId).values('status').next();
  if (!r.value) return res(404, { error: 'Task not found' });
  if (r.value !== 'todo') {
    return res(409, { error: 'Task settings can only be modified when status is todo' });
  }
  return null;
}

export const handler = async (event) => {
  const res = buildResponse(event);
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

    const { httpMethod, pathParameters, body } = event;
    const { sprintId, taskId } = pathParameters || {};

    // ---------------------------------------------------------------------------
    // Sub-resource routing: /sprints/{sprintId}/tasks/{taskId}/mcp-servers
    //                       /sprints/{sprintId}/tasks/{taskId}/steering-docs
    // Detected by examining event.path since each sub-resource has its own
    // API Gateway resource that maps to this Lambda.
    // ---------------------------------------------------------------------------
    const requestPath = event.path || '';
    if (taskId && requestPath.endsWith('/mcp-servers')) {
      return await handleTaskMcpServers(g, res, event, httpMethod, sprintId, taskId, body);
    }
    if (taskId && requestPath.endsWith('/steering-docs')) {
      return await handleTaskSteeringDocs(g, res, event, httpMethod, sprintId, taskId, body);
    }

    switch (httpMethod) {
      case 'GET': {
        if (taskId) {
          const r = await g.V().has('Task', 'id', taskId).valueMap().next();
          if (!r.value) return res(404, { error: 'Task not found' });
          return res(200, mapTask(r.value));
        }
        const list = await g
          .V()
          .has('Sprint', 'id', sprintId)
          .out('CONTAINS')
          .hasLabel('Task')
          .valueMap()
          .toList();
        return res(200, list.map(mapTask));
      }

      case 'POST': {
        const data = JSON.parse(body);
        const id = randomUUID();
        const dependencies = data.dependencies || [];

        await g
          .V()
          .has('Sprint', 'id', sprintId)
          .as('s')
          .addV('Task')
          .property('id', id)
          .property('title', data.title)
          .property('description', data.description || '')
          .property('status', data.status || 'todo')
          .property('sprint_id', sprintId)
          .property('dependencies', JSON.stringify(dependencies))
          .as('t')
          .addE('CONTAINS')
          .from_('s')
          .to('t')
          .next();

        // BREAKS_INTO from Requirement and/or UserStory
        if (data.requirementId) {
          await g
            .V()
            .has('Requirement', 'id', data.requirementId)
            .as('r')
            .V()
            .has('Task', 'id', id)
            .as('t')
            .addE('BREAKS_INTO')
            .from_('r')
            .to('t')
            .next();
        }
        if (data.userStoryId) {
          await g
            .V()
            .has('UserStory', 'id', data.userStoryId)
            .as('us')
            .V()
            .has('Task', 'id', id)
            .as('t')
            .addE('BREAKS_INTO')
            .from_('us')
            .to('t')
            .next();
        }

        // DEPENDS_ON edges for task dependencies
        for (const depId of dependencies) {
          await g
            .V()
            .has('Task', 'id', id)
            .as('t')
            .V()
            .has('Task', 'id', depId)
            .as('dep')
            .addE('DEPENDS_ON')
            .from_('t')
            .to('dep')
            .next();
        }

        return res(201, {
          id,
          title: data.title,
          description: data.description || '',
          status: data.status || 'todo',
          sprintId,
          dependencies,
        });
      }

      case 'PUT': {
        const authErr = await authorizeTaskAccess(g, res, event, sprintId, taskId);
        if (authErr) return authErr;

        const data = JSON.parse(body);

        // Status changes are always allowed (orchestrator agents need them).
        // Other field edits require status === 'todo'.
        const isStatusChangeOnly = Object.keys(data).length === 1 && data.status;
        if (!isStatusChangeOnly) {
          const statusErr = await requireTodoStatus(g, res, taskId);
          if (statusErr) return statusErr;
        }

        if (data.title)
          await g
            .V()
            .has('Task', 'id', taskId)
            .property(cardinality.single, 'title', data.title)
            .next();
        if (data.description !== undefined)
          await g
            .V()
            .has('Task', 'id', taskId)
            .property(cardinality.single, 'description', data.description)
            .next();
        if (data.status) {
          await g
            .V()
            .has('Task', 'id', taskId)
            .property(cardinality.single, 'status', data.status)
            .next();

          // When resetting a task back to "todo", clear execution metadata so it can be re-dispatched cleanly.
          // This handles the case where a task was marked "done" or "failed" but the work was lost (e.g. push failed).
          if (data.status === 'todo') {
            await g
              .V()
              .has('Task', 'id', taskId)
              .property(cardinality.single, 'task_execution_id', '')
              .property(cardinality.single, 'task_execution_arn', '')
              .property(cardinality.single, 'task_execution_status', 'reset')
              .next();
          }
        }

        // Update dependencies if provided
        if (data.dependencies !== undefined) {
          await g
            .V()
            .has('Task', 'id', taskId)
            .property(cardinality.single, 'dependencies', JSON.stringify(data.dependencies))
            .next();

          // Remove old DEPENDS_ON edges
          await g.V().has('Task', 'id', taskId).outE('DEPENDS_ON').drop().next();

          // Add new DEPENDS_ON edges
          for (const depId of data.dependencies) {
            await g
              .V()
              .has('Task', 'id', taskId)
              .as('t')
              .V()
              .has('Task', 'id', depId)
              .as('dep')
              .addE('DEPENDS_ON')
              .from_('t')
              .to('dep')
              .next();
          }
        }

        const updated = await g.V().has('Task', 'id', taskId).valueMap().next();
        return res(200, mapTask(updated.value));
      }

      case 'DELETE': {
        await g.V().has('Task', 'id', taskId).drop().next();
        return res(204, {});
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

// ---------------------------------------------------------------------------
// Task-level config: GET/PUT /sprints/{sprintId}/tasks/{taskId}/mcp-servers
//                    GET/PUT /sprints/{sprintId}/tasks/{taskId}/steering-docs
// Manages task-level mcp_servers and steering_docs properties.
// ---------------------------------------------------------------------------

// Helper to extract Neptune valueMap property (handles Map and plain object)
const getTaskVal = (v, key) => {
  if (!v) return '';
  const raw = v instanceof Map ? v.get(key) : v[key];
  if (Array.isArray(raw)) return raw[0] ?? '';
  return raw ?? '';
};

// ---------------------------------------------------------------------------
// Task-level MCP servers: GET/PUT /sprints/{sprintId}/tasks/{taskId}/mcp-servers
// ---------------------------------------------------------------------------

async function handleTaskMcpServers(g, res, event, httpMethod, sprintId, taskId, body) {
  if (httpMethod === 'GET') {
    const r = await g.V().has('Task', 'id', taskId).valueMap('mcp_servers').next();
    if (!r.value) return res(404, { error: 'Task not found' });
    const raw = getTaskVal(r.value, 'mcp_servers') || '[]';
    return res(200, { mcpServers: raw });
  }

  if (httpMethod === 'PUT') {
    const authErr = await authorizeTaskAccess(g, res, event, sprintId, taskId);
    if (authErr) return authErr;
    const statusErr = await requireTodoStatus(g, res, taskId);
    if (statusErr) return statusErr;

    const data = JSON.parse(body || '{}');
    const mcpServersJson = data.mcpServers || '[]';
    const validation = validateMcpServersJson(mcpServersJson);
    if (!validation.valid) {
      return res(400, {
        error: 'Invalid MCP servers configuration',
        issues: validation.issues,
      });
    }
    await g
      .V()
      .has('Task', 'id', taskId)
      .property(cardinality.single, 'mcp_servers', mcpServersJson)
      .next();
    return res(200, { saved: true });
  }

  return res(405, { error: 'Method not allowed' });
}

// ---------------------------------------------------------------------------
// Task-level steering docs: GET/PUT /sprints/{sprintId}/tasks/{taskId}/steering-docs
// ---------------------------------------------------------------------------

async function handleTaskSteeringDocs(g, res, event, httpMethod, sprintId, taskId, body) {
  const artifactsBucket = process.env.ARTIFACTS_BUCKET;
  const region = process.env.AWS_REGION || 'us-east-1';
  const s3 = new S3Client({ region });

  if (httpMethod === 'GET') {
    const r = await g.V().has('Task', 'id', taskId).valueMap('steering_docs').next();
    if (!r.value) return res(404, { error: 'Task not found' });
    let docs = [];
    try {
      docs = JSON.parse(getTaskVal(r.value, 'steering_docs') || '[]');
    } catch {
      docs = [];
    }

    // Generate presigned download URLs using the s3Keys already stored in metadata
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

    return res(200, { steeringDocs: docsWithUrls });
  }

  if (httpMethod === 'PUT') {
    const authErr = await authorizeTaskAccess(g, res, event, sprintId, taskId);
    if (authErr) return authErr;
    const statusErr = await requireTodoStatus(g, res, taskId);
    if (statusErr) return statusErr;

    const data = JSON.parse(body || '{}');

    if (!artifactsBucket) {
      return res(500, { error: 'ARTIFACTS_BUCKET env var not configured' });
    }

    const incomingDocs = data.steeringDocs || [];
    if (incomingDocs.length > 20) {
      return res(400, { error: 'Maximum 20 steering documents per task' });
    }

    // Resolve project ID for S3 key construction.
    // Edge model: Project --HAS_SPRINT--> Sprint --CONTAINS--> Task
    let projectId = '';
    try {
      const sprintResult = await g
        .V()
        .has('Task', 'id', taskId)
        .in_('CONTAINS')
        .hasLabel('Sprint')
        .in_('HAS_SPRINT')
        .hasLabel('Project')
        .valueMap('id')
        .next();
      if (sprintResult.value) {
        projectId = getTaskVal(sprintResult.value, 'id');
      }
    } catch (err) {
      console.error('[tasks] Failed to resolve projectId for task', taskId, err.message);
    }
    if (!projectId) {
      return res(404, { error: 'Could not resolve project for task; cannot save steering docs' });
    }

    // Compute S3 keys and generate presigned upload URLs
    const uploadUrls = [];
    const savedDocs = [];
    for (const doc of incomingDocs) {
      const filename = doc.filename || '';
      const safeBase = path.basename(filename);
      if (!safeBase || safeBase !== filename || !safeBase.toLowerCase().endsWith('.md')) {
        return res(400, {
          error: `Invalid filename "${filename}". Must end in .md and contain no path separators.`,
        });
      }
      const s3Key = `steering/${projectId}/${taskId}/task--${safeBase}`;
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
        console.error(`[tasks] Failed to generate presigned URL for ${s3Key}:`, err.message);
      }
      savedDocs.push({ filename: safeBase, s3Key });
    }

    // Persist steering_docs metadata to Neptune
    const metadataJson = JSON.stringify(savedDocs);
    await g
      .V()
      .has('Task', 'id', taskId)
      .property(cardinality.single, 'steering_docs', metadataJson)
      .next();

    return res(200, { saved: true, uploadUrls });
  }

  return res(405, { error: 'Method not allowed' });
}
