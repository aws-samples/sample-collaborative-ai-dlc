import gremlin from 'gremlin';
import { PartitionStrategy } from 'gremlin/lib/process/traversal-strategy.js';
import { randomUUID } from 'node:crypto';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { getUrlAndHeaders } from 'gremlin-aws-sigv4/lib/utils.js';
import { buildResponse } from '../shared/response.js';
import { runTrackerMigration } from '../shared/tracker-migration.js';
import {
  getVal,
  projectTrackersFoldStep,
  mapBinding,
  fetchMembershipRole,
} from '../shared/trackers.js';

const DriverRemoteConnection = gremlin.driver.DriverRemoteConnection;
const traversal = gremlin.process.AnonymousTraversalSource.traversal;
const __ = gremlin.process.statics;
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

    const { httpMethod, pathParameters, body, path } = event;
    const projectId = pathParameters?.projectId;
    const userId = event.requestContext?.authorizer?.claims?.sub;
    const userEmail = event.requestContext?.authorizer?.claims?.email || '';
    const isMigrateTracker = httpMethod === 'POST' && path?.endsWith('/migrate-tracker');

    // POST /projects/{projectId}/migrate-tracker — owner/admin only.
    // Backfills the tracker_* fields on this project's sprints + creates a
    // synthetic HAS_TRACKER edge if the project still uses the legacy
    // issue_integration_enabled boolean. Idempotent. See parent issue #194.
    if (isMigrateTracker) {
      if (!userId) return response(401, { error: 'Unauthorized' });
      const role = await fetchMembershipRole(g, projectId, userId);
      if (!role) return response(403, { error: 'Access denied' });
      if (role !== 'owner' && role !== 'admin') {
        return response(403, { error: 'Only project owners and admins can migrate trackers' });
      }
      let dryRun = false;
      if (body) {
        try {
          dryRun = Boolean(JSON.parse(body)?.dryRun);
        } catch {
          return response(400, { error: 'Invalid JSON body' });
        }
      }
      const result = await runTrackerMigration(g, { projectId, dryRun });
      return response(200, result);
    }

    switch (httpMethod) {
      case 'GET':
        if (projectId) {
          // Single project lookup - verify user is a member and return their
          // role. Single round-trip: role + project valueMap + trackers all
          // fold into one traversal (parity with the list endpoint).
          if (!userId) return response(401, { error: 'Unauthorized' });

          const single = await g
            .V()
            .has('Project', 'id', projectId)
            .as('p')
            .outE('HAS_MEMBER')
            .as('e')
            .inV()
            .has('User', 'id', userId)
            .select('e', 'p')
            .by(__.values('role'))
            .by(__.project('vertex', 'trackers').by(__.valueMap()).by(projectTrackersFoldStep()))
            .next();
          if (single.done) return response(403, { error: 'Access denied' });

          const item = single.value;
          const role = item instanceof Map ? item.get('e') : item.e;
          const pBundle = item instanceof Map ? item.get('p') : item.p;
          const v = pBundle instanceof Map ? pBundle.get('vertex') : pBundle.vertex;
          const trackerMaps =
            (pBundle instanceof Map ? pBundle.get('trackers') : pBundle.trackers) ?? [];
          const project = {
            id: getVal(v, 'id') || projectId,
            name: getVal(v, 'name'),
            gitProvider: getVal(v, 'git_provider') || 'github',
            gitRepo: getVal(v, 'git_repo'),
            agentCli: getVal(v, 'agent_cli') || 'kiro',
            issueIntegrationEnabled: getVal(v, 'issue_integration_enabled') === 'true',
            createdAt: getVal(v, 'created_at') || new Date().toISOString(),
            userRole: role || 'member',
            trackers: trackerMaps.map(mapBinding),
          };
          return response(200, project);
        }

        // List projects - only return projects where the current user is a member.
        // Trackers fold into the same traversal so we don't fan out into N+1
        // per-project fetches.
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
          .by(__.values('role'))
          .by(__.project('vertex', 'trackers').by(__.valueMap()).by(projectTrackersFoldStep()))
          .toList();
        const projects = results.map((item) => {
          // item is a Map with keys 'e' (role string) and 'p' ({vertex, trackers}).
          const role = item instanceof Map ? item.get('e') : item.e;
          const pBundle = item instanceof Map ? item.get('p') : item.p;
          const v = pBundle instanceof Map ? pBundle.get('vertex') : pBundle.vertex;
          const trackerMaps =
            (pBundle instanceof Map ? pBundle.get('trackers') : pBundle.trackers) ?? [];
          return {
            id: getVal(v, 'id'),
            name: getVal(v, 'name'),
            gitProvider: getVal(v, 'git_provider') || 'github',
            gitRepo: getVal(v, 'git_repo'),
            agentCli: getVal(v, 'agent_cli') || 'kiro',
            issueIntegrationEnabled: getVal(v, 'issue_integration_enabled') === 'true',
            createdAt: getVal(v, 'created_at') || new Date().toISOString(),
            userRole: role || 'member',
            trackers: trackerMaps.map(mapBinding),
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
        const updaterRole = await fetchMembershipRole(g, projectId, userId);
        if (!updaterRole) return response(403, { error: 'Access denied' });
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
