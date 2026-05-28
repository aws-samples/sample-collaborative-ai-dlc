import { randomUUID } from 'node:crypto';
import gremlin from 'gremlin';
import { PartitionStrategy } from 'gremlin/lib/process/traversal-strategy.js';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { getUrlAndHeaders } from 'gremlin-aws-sigv4/lib/utils.js';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  DeleteCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import { SSMClient, DeleteParameterCommand } from '@aws-sdk/client-ssm';
import { buildResponse } from '../shared/response.js';
import { getProvider, KNOWN_PROVIDERS, ProviderError } from './providers/index.js';

const DriverRemoteConnection = gremlin.driver.DriverRemoteConnection;
const traversal = gremlin.process.AnonymousTraversalSource.traversal;
const __ = gremlin.process.statics;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ssm = new SSMClient({});

const getVal = (v, key) => {
  if (!v) return '';
  const raw = v instanceof Map ? v.get(key) : v[key];
  if (Array.isArray(raw)) return raw[0] ?? '';
  return raw ?? '';
};

const mapBindingFromVertex = (v) => ({
  id: getVal(v, 'id'),
  provider: getVal(v, 'provider'),
  instance: getVal(v, 'instance') || null,
  externalProjectKey: getVal(v, 'external_project_key') || null,
  displayName: getVal(v, 'display_name') || null,
  createdAt: getVal(v, 'created_at') || null,
  createdBy: getVal(v, 'created_by') || null,
});

const getConnection = async () => {
  const host = process.env.NEPTUNE_ENDPOINT;
  const port = process.env.GREMLIN_PORT ?? '8182';
  const protocol = process.env.GREMLIN_PROTOCOL ?? 'wss';

  const credentials = await fromNodeProviderChain()();
  credentials.region = process.env.AWS_REGION ?? 'us-east-1';
  const { url, headers } = getUrlAndHeaders(host, port, credentials, '/gremlin', protocol);
  return new DriverRemoteConnection(url, { headers });
};

const requireUserId = (event) => event.requestContext?.authorizer?.claims?.sub;

// Membership check used by every /projects/{projectId}/... route.
// Returns the user's role string, or null if not a member.
const fetchMembership = async (g, projectId, userId) => {
  const edges = await g
    .V()
    .has('Project', 'id', projectId)
    .outE('HAS_MEMBER')
    .as('e')
    .inV()
    .has('User', 'id', userId)
    .select('e')
    .by(__.valueMap())
    .toList();
  if (edges.length === 0) return null;
  return getVal(edges[0], 'role') || 'member';
};

const fetchBinding = async (g, projectId, bindingId) => {
  const list = await g
    .V()
    .has('Project', 'id', projectId)
    .out('HAS_TRACKER')
    .hasLabel('TrackerBinding')
    .has('id', bindingId)
    .valueMap()
    .toList();
  if (list.length === 0) return null;
  return mapBindingFromVertex(list[0]);
};

const listBindingsForProject = async (g, projectId) => {
  const list = await g
    .V()
    .has('Project', 'id', projectId)
    .out('HAS_TRACKER')
    .hasLabel('TrackerBinding')
    .valueMap()
    .toList();
  return list.map(mapBindingFromVertex);
};

const handleProviderError = (response, err) => {
  if (err instanceof ProviderError) {
    if (err.status === 429) return response(429, err.extra);
    return response(err.status, { error: err.message || 'Provider error' });
  }
  if (err.code === 'NOT_CONNECTED') {
    return response(400, { error: err.message || 'Provider not connected' });
  }
  console.error('Provider error:', err);
  return response(500, { error: 'Internal server error' });
};

// GET /trackers — unified listing across the legacy git-connections table
// (still the only place GitHub PATs live, by design — see #194 §3a) and
// tracker-connections (Phase 3 will start writing Jira rows here).
const listTrackerConnections = async (response, userId) => {
  const out = [];
  try {
    const { Item } = await ddb.send(
      new GetCommand({
        TableName: process.env.GIT_CONNECTIONS_TABLE,
        Key: { userId },
      }),
    );
    if (Item) {
      out.push({
        provider: 'github-issues',
        instance: 'public',
        connectedAt: Item.createdAt || null,
        scope: Item.scope || null,
      });
    }
  } catch (err) {
    console.error('Failed to read git-connections:', err.message);
  }

  // tracker-connections is keyed (userId, provider#instance). Empty in Phase 2;
  // populated by Jira in Phase 3. Scan with a userId filter is fine — N is
  // small (one row per provider per user).
  if (process.env.TRACKER_CONNECTIONS_TABLE) {
    try {
      const result = await ddb.send(
        new ScanCommand({
          TableName: process.env.TRACKER_CONNECTIONS_TABLE,
          FilterExpression: 'userId = :u',
          ExpressionAttributeValues: { ':u': userId },
        }),
      );
      for (const item of result.Items || []) {
        const [provider, instance] = (item.providerInstance || '').split('#');
        if (!provider) continue;
        out.push({
          provider,
          instance: instance || null,
          connectedAt: item.createdAt || null,
          scope: item.scope || null,
        });
      }
    } catch (err) {
      console.error('Failed to scan tracker-connections:', err.message);
    }
  }
  return response(200, out);
};

// DELETE /trackers/{provider}/{instance}
const disconnectTracker = async (response, userId, provider, instance) => {
  if (provider === 'github-issues' && instance === 'public') {
    const { Item } = await ddb.send(
      new GetCommand({
        TableName: process.env.GIT_CONNECTIONS_TABLE,
        Key: { userId },
      }),
    );
    if (Item?.parameterName) {
      try {
        await ssm.send(new DeleteParameterCommand({ Name: Item.parameterName }));
      } catch (e) {
        console.error('Failed to delete git token parameter:', e.message);
      }
    }
    await ddb.send(
      new DeleteCommand({
        TableName: process.env.GIT_CONNECTIONS_TABLE,
        Key: { userId },
      }),
    );
    return response(200, { success: true });
  }
  // Phase 3: jira-cloud disconnect from tracker-connections + SSM.
  return response(400, { error: `Disconnect not implemented for ${provider}/${instance}` });
};

export const handler = async (event) => {
  const response = buildResponse(event);
  if (event.httpMethod === 'OPTIONS') return response(200, {});

  const userId = requireUserId(event);
  if (!userId) return response(401, { error: 'Unauthorized' });

  const { httpMethod, queryStringParameters, body, path = '' } = event;
  const pathParameters = event.pathParameters || {};

  // Auth/callback stubs — real OAuth for github-issues lives at /github/auth.
  // Phase 3 implements jira-cloud here.
  if (path.startsWith('/trackers/auth/') || path.startsWith('/trackers/callback/')) {
    const providerId = pathParameters.provider || path.split('/')[3];
    if (providerId === 'github-issues') {
      return response(501, {
        error: 'github-issues auth lives at /github/auth — connect GitHub there',
      });
    }
    if (KNOWN_PROVIDERS.includes(providerId)) {
      return response(501, { error: `Auth flow for ${providerId} not yet implemented` });
    }
    return response(404, { error: 'Unknown provider' });
  }

  // GET /trackers
  if (
    httpMethod === 'GET' &&
    (path === '/trackers' || path.endsWith('/trackers')) &&
    !pathParameters.projectId
  ) {
    return listTrackerConnections(response, userId);
  }

  // DELETE /trackers/{provider}/{instance}
  if (
    httpMethod === 'DELETE' &&
    pathParameters.provider &&
    pathParameters.instance &&
    !pathParameters.projectId
  ) {
    return disconnectTracker(response, userId, pathParameters.provider, pathParameters.instance);
  }

  // Everything below is /projects/{projectId}/trackers...
  const projectId = pathParameters.projectId;
  if (!projectId) return response(404, { error: 'Not found' });

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

    const role = await fetchMembership(g, projectId, userId);
    if (!role) return response(403, { error: 'Access denied' });

    const bindingId = pathParameters.bindingId;

    // GET /projects/{id}/trackers
    if (httpMethod === 'GET' && !bindingId) {
      const bindings = await listBindingsForProject(g, projectId);
      return response(200, bindings);
    }

    // POST /projects/{id}/trackers
    if (httpMethod === 'POST' && !bindingId) {
      if (role !== 'owner' && role !== 'admin') {
        return response(403, { error: 'Only project owners and admins can add trackers' });
      }
      const data = body ? JSON.parse(body) : {};
      const provider = data.provider;
      const instance = data.instance || 'public';
      const externalProjectKey = data.externalProjectKey;
      const displayName = data.displayName || externalProjectKey;
      if (!provider || !KNOWN_PROVIDERS.includes(provider)) {
        return response(400, { error: 'Unknown or missing provider' });
      }
      if (!externalProjectKey) {
        return response(400, { error: 'externalProjectKey is required' });
      }
      // Validate provider+instance up front
      try {
        getProvider(provider, instance);
      } catch (err) {
        return handleProviderError(response, err);
      }

      // For github-issues, require an active GitHub connection so the binding
      // is actually usable. For Jira (Phase 3) this will check tracker-connections.
      if (provider === 'github-issues') {
        const { Item } = await ddb.send(
          new GetCommand({
            TableName: process.env.GIT_CONNECTIONS_TABLE,
            Key: { userId },
          }),
        );
        if (!Item) {
          return response(400, { error: 'GitHub not connected' });
        }
      }

      const id = randomUUID();
      const createdAt = new Date().toISOString();
      await g
        .V()
        .has('Project', 'id', projectId)
        .as('p')
        .addV('TrackerBinding')
        .property('id', id)
        .property('provider', provider)
        .property('instance', instance)
        .property('external_project_key', externalProjectKey)
        .property('display_name', displayName)
        .property('created_at', createdAt)
        .property('created_by', userId)
        .as('b')
        .addE('HAS_TRACKER')
        .from_('p')
        .to('b')
        .next();

      return response(201, {
        id,
        provider,
        instance,
        externalProjectKey,
        displayName,
        createdAt,
        createdBy: userId,
      });
    }

    if (!bindingId) return response(404, { error: 'Not found' });

    // DELETE /projects/{id}/trackers/{bindingId}
    if (httpMethod === 'DELETE' && bindingId && !path.includes('/issues')) {
      if (role !== 'owner' && role !== 'admin') {
        return response(403, { error: 'Only project owners and admins can remove trackers' });
      }
      const binding = await fetchBinding(g, projectId, bindingId);
      if (!binding) return response(404, { error: 'Binding not found' });
      await g
        .V()
        .has('Project', 'id', projectId)
        .out('HAS_TRACKER')
        .hasLabel('TrackerBinding')
        .has('id', bindingId)
        .drop()
        .next();
      return response(204, {});
    }

    // /projects/{id}/trackers/{bindingId}/issues...
    const binding = await fetchBinding(g, projectId, bindingId);
    if (!binding) return response(404, { error: 'Binding not found' });

    let provider;
    try {
      provider = getProvider(binding.provider, binding.instance);
    } catch (err) {
      return handleProviderError(response, err);
    }

    const ctx = { ddb, ssm, userId };

    try {
      const resourceId = pathParameters.resourceId;

      // GET /projects/{id}/trackers/{bid}/issues/{rid}/comments
      if (httpMethod === 'GET' && resourceId && path.endsWith('/comments')) {
        const comments = await provider.getIssueDiscussion(
          ctx,
          binding.externalProjectKey,
          resourceId,
        );
        return response(200, comments);
      }

      // GET /projects/{id}/trackers/{bid}/issues/{rid}
      if (httpMethod === 'GET' && resourceId) {
        const issue = await provider.getIssue(ctx, binding.externalProjectKey, resourceId);
        return response(200, issue);
      }

      // GET /projects/{id}/trackers/{bid}/issues
      if (httpMethod === 'GET' && path.endsWith('/issues')) {
        const issues = await provider.listIssues(ctx, binding.externalProjectKey, {
          state: queryStringParameters?.state,
          q: queryStringParameters?.q,
          page: queryStringParameters?.page,
          perPage: queryStringParameters?.perPage,
        });
        return response(200, issues);
      }
    } catch (err) {
      return handleProviderError(response, err);
    }

    return response(404, { error: 'Not found' });
  } catch (err) {
    console.error('Error:', err);
    return response(500, { error: 'Internal server error', message: err.message });
  } finally {
    if (conn) {
      try {
        await conn.close();
      } catch {}
    }
  }
};
