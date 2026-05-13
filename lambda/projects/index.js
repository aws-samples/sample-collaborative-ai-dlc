const gremlin = require('gremlin');
const { randomUUID } = require('crypto');
const { fromNodeProviderChain } = require('@aws-sdk/credential-providers');
const { getUrlAndHeaders } = require('gremlin-aws-sigv4/lib/utils');
const { buildResponse } = require('./shared/response');

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
  const port = '8182';
  const region = process.env.AWS_REGION || 'us-east-1';

  const credentials = await fromNodeProviderChain()();
  credentials.region = region;

  const connInfo = getUrlAndHeaders(host, port, credentials, '/gremlin', 'wss');

  return new DriverRemoteConnection(connInfo.url, { headers: connInfo.headers });
};

exports.handler = async (event) => {
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
    const g = traversal().withRemote(conn);

    const { httpMethod, pathParameters, body } = event;
    const projectId = pathParameters?.projectId;
    const userId = event.requestContext?.authorizer?.claims?.sub;
    const userEmail = event.requestContext?.authorizer?.claims?.email || '';

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
          await vertex.property(cardinality.single, 'issue_integration_enabled', data.issueIntegrationEnabled ? 'true' : 'false').next();
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
