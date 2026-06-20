import { randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
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
import {
  SecretsManagerClient,
  GetSecretValueCommand,
  PutSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import { buildResponse } from '../shared/response.js';
import {
  trackerBindingProjectionStep,
  mapBinding,
  fetchMembershipRole,
} from '../shared/trackers.js';
import { getProvider, KNOWN_PROVIDERS, ProviderError } from './providers/index.js';
import {
  buildAuthorizeUrl,
  exchangeCode,
  listAccessibleResources,
  persistConnection,
} from './providers/jira-cloud.js';

const DriverRemoteConnection = gremlin.driver.DriverRemoteConnection;
const traversal = gremlin.process.AnonymousTraversalSource.traversal;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ssm = new SSMClient({});
const secrets = new SecretsManagerClient({});

// HMAC-signed envelope for the OAuth `state` parameter and the multi-site
// `ticket` payload. Mirrors the pattern used in lambda/github/index.js —
// see the comment there for why we re-use the OAuth client_secret rather
// than maintaining a separate HMAC key.
const STATE_TTL_MS = 10 * 60 * 1000;

const signEnvelope = (payload, secret) => {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', secret).update(data).digest('hex');
  return `${data}.${sig}`;
};

const verifyEnvelope = (token, secret) => {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [data, sig] = parts;
  const expected = createHmac('sha256', secret).update(data).digest('hex');
  try {
    if (!timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))) return null;
  } catch {
    return null;
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(data, 'base64url').toString());
  } catch {
    return null;
  }
  if (!payload.ts || Date.now() - payload.ts > STATE_TTL_MS) return null;
  return payload;
};

// Per-provider OAuth-app metadata. The secret holds client_id +
// client_secret pairs; the env var lets terraform vary the secret name
// per environment. Shape lets us add future providers (Linear, GitLab)
// without touching the per-route logic below.
const PROVIDER_OAUTH_CONFIG = {
  'jira-cloud': {
    label: 'Jira Cloud',
    instances: ['cloud'],
    secretEnvVar: 'JIRA_OAUTH_SECRET_NAME',
    callbackPath: '/trackers/callback/jira-cloud',
  },
  'github-issues': {
    label: 'GitHub Issues',
    instances: ['public'],
    secretEnvVar: 'GITHUB_OAUTH_SECRET_NAME',
    callbackPath: '/github/callback',
  },
  'gitlab-issues': {
    label: 'GitLab Issues',
    instances: ['public'],
    secretEnvVar: 'GITLAB_OAUTH_SECRET_NAME',
    callbackPath: '/gitlab/callback',
  },
};

// Reads + validates an OAuth secret. Returns the parsed credentials on
// success or `{configured: false, reason}` on any failure mode (missing
// secret, malformed JSON, missing fields). Used both to actually fetch
// credentials for an OAuth flow and to compute the boolean exposed by
// `GET /trackers/providers`.
const readOAuthSecret = async (envVarName) => {
  const secretId = process.env[envVarName];
  if (!secretId) {
    return { configured: false, reason: 'env-var-missing' };
  }
  let result;
  try {
    result = await secrets.send(new GetSecretValueCommand({ SecretId: secretId }));
  } catch (err) {
    if (err.name === 'ResourceNotFoundException') {
      return { configured: false, reason: 'secret-not-found' };
    }
    throw err;
  }
  if (!result.SecretString) {
    return { configured: false, reason: 'empty' };
  }
  let parsed;
  try {
    parsed = JSON.parse(result.SecretString);
  } catch {
    return { configured: false, reason: 'invalid-json' };
  }
  if (!parsed?.client_id || !parsed?.client_secret) {
    return { configured: false, reason: 'missing-fields' };
  }
  return { configured: true, clientId: parsed.client_id, clientSecret: parsed.client_secret };
};

const getJiraOAuthCredentials = async () => {
  const result = await readOAuthSecret('JIRA_OAUTH_SECRET_NAME');
  if (!result.configured) {
    throw new ProviderError(503, 'Jira OAuth not configured on this environment');
  }
  return { clientId: result.clientId, clientSecret: result.clientSecret };
};

// Writes a {client_id, client_secret} OAuth pair to the provider's
// Secrets-Manager slot. Operator-facing — invoked from the Admin panel.
// Caller validates input shape; this helper just persists.
const writeOAuthSecret = async (envVarName, clientId, clientSecret) => {
  const secretId = process.env[envVarName];
  if (!secretId) {
    throw new ProviderError(
      503,
      'OAuth secret slot is not provisioned in this environment (missing env var)',
    );
  }
  await secrets.send(
    new PutSecretValueCommand({
      SecretId: secretId,
      SecretString: JSON.stringify({ client_id: clientId, client_secret: clientSecret }),
    }),
  );
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

const requireUserId = (event) => event.requestContext?.authorizer?.claims?.sub;

// Synthetic-binding id served for legacy projects (issue_integration_enabled
// AND no HAS_TRACKER edge). Mirrors the constant exported from
// lambda/projects so the issue-list panel can be rendered against an
// unmigrated project without writing any new graph state.
const LEGACY_GITHUB_BINDING_ID = 'legacy-github';

// Tiny `coalesce(values('k'), constant(null))` helper used by the legacy
// project lookup. Inlined to keep the projection block readable.
const coalesceProp = (key) =>
  gremlin.process.statics.coalesce(
    gremlin.process.statics.values(key),
    gremlin.process.statics.constant(null),
  );

// Reads gitRepo + issue_integration_enabled for a project so we can
// synthesize a github-issues binding for legacy callers. Returns null when
// the project doesn't qualify (no gitRepo, or already migrated).
//
// This synthesizer is GitHub-only by design: it exists purely to back-fill the
// pre-tracker-subsystem projects, which were all GitHub. GitLab support post-
// dates the tracker subsystem, so GitLab projects always create a real
// TrackerBinding (POST /projects/{id}/trackers) instead of relying on this
// legacy shim.
const fetchLegacyBindingFor = async (g, projectId) => {
  const r = await g
    .V()
    .has('Project', 'id', projectId)
    .project('gitRepo', 'gitProvider', 'issueIntegrationEnabled', 'createdAt')
    .by(coalesceProp('git_repo'))
    .by(coalesceProp('git_provider'))
    .by(coalesceProp('issue_integration_enabled'))
    .by(coalesceProp('created_at'))
    .next();
  if (r.done) return null;
  const get = (k) => (r.value instanceof Map ? r.value.get(k) : r.value[k]);
  const gitRepo = get('gitRepo');
  const gitProvider = get('gitProvider') || 'github';
  const enabled = get('issueIntegrationEnabled') === 'true';
  if (!enabled || !gitRepo || gitProvider !== 'github') return null;
  return {
    id: LEGACY_GITHUB_BINDING_ID,
    provider: 'github-issues',
    instance: 'public',
    externalProjectKey: gitRepo,
    displayName: gitRepo,
    createdAt: get('createdAt') || null,
    createdBy: null,
  };
};

// Membership + binding lookups both project server-side via the shared
// `trackerBindingProjectionStep`, returning camelCase API shape directly so
// no JS-side reshape is needed. Recognizes the legacy-github sentinel id
// and synthesizes a binding from the project's gitRepo when applicable.
const fetchBinding = async (g, projectId, bindingId) => {
  if (bindingId === LEGACY_GITHUB_BINDING_ID) {
    return fetchLegacyBindingFor(g, projectId);
  }
  const r = await g
    .V()
    .has('Project', 'id', projectId)
    .out('HAS_TRACKER')
    .hasLabel('TrackerBinding')
    .has('id', bindingId)
    .flatMap(trackerBindingProjectionStep())
    .next();
  if (r.done) return null;
  return mapBinding(r.value);
};

// Returns real bindings + the synthetic legacy one when the project still
// uses issue_integration_enabled. Two disjoint reads run concurrently.
const listBindingsForProject = async (g, projectId) => {
  const [list, legacy] = await Promise.all([
    g
      .V()
      .has('Project', 'id', projectId)
      .out('HAS_TRACKER')
      .hasLabel('TrackerBinding')
      .flatMap(trackerBindingProjectionStep())
      .toList(),
    fetchLegacyBindingFor(g, projectId),
  ]);
  const bindings = list.map(mapBinding);
  if (legacy && bindings.length === 0) bindings.push(legacy);
  return bindings;
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
// (still the only place GitHub PATs live, by design) and
// tracker-connections (Phase 3 will start writing Jira rows here).
const listTrackerConnections = async (response, userId) => {
  // Disjoint reads on different tables — fire concurrently. Each branch
  // catches its own error so a failure in one doesn't blank out the other.
  const [gitItem, trackerItems] = await Promise.all([
    ddb
      .send(new GetCommand({ TableName: process.env.GIT_CONNECTIONS_TABLE, Key: { userId } }))
      .then((r) => r.Item ?? null)
      .catch((err) => {
        console.error('Failed to read git-connections:', err.message);
        return null;
      }),
    process.env.TRACKER_CONNECTIONS_TABLE
      ? ddb
          .send(
            new ScanCommand({
              TableName: process.env.TRACKER_CONNECTIONS_TABLE,
              FilterExpression: 'userId = :u',
              ExpressionAttributeValues: { ':u': userId },
            }),
          )
          .then((r) => r.Items ?? [])
          .catch((err) => {
            console.error('Failed to scan tracker-connections:', err.message);
            return [];
          })
      : Promise.resolve([]),
  ]);

  const out = [];
  if (gitItem) {
    // The single git-connections row holds whichever git provider the user
    // connected; surface the matching issue-tracker provider id.
    out.push({
      provider: gitItem.provider === 'gitlab' ? 'gitlab-issues' : 'github-issues',
      instance: 'public',
      connectedAt: gitItem.createdAt || null,
      scope: gitItem.scope || null,
    });
  }
  // tracker-connections is keyed (userId, provider#instance). Empty in Phase 2;
  // populated by Jira in Phase 3. Scan with a userId filter is fine — N is
  // small (one row per provider per user).
  for (const item of trackerItems) {
    const [provider, instance] = (item.providerInstance || '').split('#');
    if (!provider) continue;
    out.push({
      provider,
      instance: instance || null,
      connectedAt: item.createdAt || null,
      scope: item.scope || null,
    });
  }
  return response(200, out);
};

// DELETE /trackers/{provider}/{instance}
const disconnectTracker = async (response, userId, provider, instance) => {
  if ((provider === 'github-issues' || provider === 'gitlab-issues') && instance === 'public') {
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
  if (provider === 'jira-cloud' && instance === 'cloud') {
    const { Item } = await ddb.send(
      new GetCommand({
        TableName: process.env.TRACKER_CONNECTIONS_TABLE,
        Key: { userId, providerInstance: 'jira-cloud#cloud' },
      }),
    );
    if (Item?.parameterName) {
      try {
        await ssm.send(new DeleteParameterCommand({ Name: Item.parameterName }));
      } catch (e) {
        console.error('Failed to delete jira token parameter:', e.message);
      }
    }
    await ddb.send(
      new DeleteCommand({
        TableName: process.env.TRACKER_CONNECTIONS_TABLE,
        Key: { userId, providerInstance: 'jira-cloud#cloud' },
      }),
    );
    return response(200, { success: true });
  }
  return response(400, { error: `Disconnect not implemented for ${provider}/${instance}` });
};

export const handler = async (event) => {
  const response = buildResponse(event);
  if (event.httpMethod === 'OPTIONS') return response(200, {});

  const userId = requireUserId(event);
  const { httpMethod, queryStringParameters, body, path = '' } = event;
  const pathParameters = event.pathParameters || {};

  // CloudFront prepends the stage prefix (`/api`) to the path the lambda
  // sees, so anchor-relative checks like `startsWith('/trackers/...')` would
  // miss in production while still passing locally. Switch to `includes`
  // for the route-prefix matching below — same pattern Phase 2 relied on
  // with `endsWith(...)` and `pathParameters`.

  // The OAuth callback is the only public route — it's invoked by the
  // tracker provider (Atlassian) and cannot carry a Cognito JWT. Every
  // other route in this handler requires an authenticated user.
  const isPublicCallback = path.includes('/trackers/callback/');
  if (!isPublicCallback && !userId) return response(401, { error: 'Unauthorized' });

  // /trackers/auth/{provider} — Cognito-authed; Atlassian for jira-cloud.
  // /trackers/callback/{provider} — NONE auth; the OAuth provider redirects here.
  if (path.includes('/trackers/auth/') || path.includes('/trackers/callback/')) {
    // pathParameters.provider is set by API Gateway's path templating, but
    // local invocations may pass a bare path string — fall back to splitting.
    const providerId =
      pathParameters.provider || path.split('/').filter(Boolean).slice(-1)[0] || '';
    if (providerId === 'github-issues') {
      return response(501, {
        error: 'github-issues auth lives at /github/auth — connect GitHub there',
      });
    }
    if (providerId === 'gitlab-issues') {
      return response(501, {
        error: 'gitlab-issues auth lives at /gitlab/auth — connect GitLab there',
      });
    }
    if (providerId === 'jira-cloud') {
      try {
        if (path.includes('/trackers/auth/')) {
          if (!userId) return response(401, { error: 'Unauthorized' });
          const { clientId, clientSecret } = await getJiraOAuthCredentials();
          const state = signEnvelope({ userId, ts: Date.now() }, clientSecret);
          const url = buildAuthorizeUrl({
            clientId,
            redirectUri: process.env.JIRA_REDIRECT_URI,
            state,
          });
          return response(200, { url });
        }
        // /trackers/callback/jira-cloud — Atlassian redirect, no Cognito JWT.
        const { code, state } = queryStringParameters || {};
        if (!code) return response(400, { error: 'Missing code parameter' });
        if (!state) return response(400, { error: 'Missing state parameter' });
        const { clientId, clientSecret } = await getJiraOAuthCredentials();
        const statePayload = verifyEnvelope(decodeURIComponent(state), clientSecret);
        if (!statePayload?.userId) {
          return response(400, { error: 'Invalid or expired state' });
        }
        const tokens = await exchangeCode({
          clientId,
          clientSecret,
          redirectUri: process.env.JIRA_REDIRECT_URI,
          code,
        });
        const resources = await listAccessibleResources(tokens.accessToken);
        if (resources.length === 0) {
          return response(400, { error: 'No Atlassian sites accessible to this account' });
        }
        if (resources.length === 1) {
          await persistConnection({
            ddb,
            ssm,
            userId: statePayload.userId,
            resource: resources[0],
            tokens,
            scope: 'read:jira-work read:jira-user offline_access',
          });
          return response(200, { success: true });
        }
        // Multi-site: defer the row write until the user picks. The ticket
        // signs the just-issued tokens so we don't need a DDB scratch row.
        const ticket = signEnvelope(
          {
            userId: statePayload.userId,
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            expiresIn: tokens.expiresIn,
            ts: Date.now(),
          },
          clientSecret,
        );
        return response(200, {
          pendingChoice: {
            ticket,
            resources: resources.map((r) => ({
              cloudId: r.cloudId,
              name: r.name,
              host: r.host,
              url: r.url,
            })),
          },
        });
      } catch (err) {
        if (err instanceof ProviderError) {
          return response(err.status, { error: err.message, ...err.extra });
        }
        console.error('Jira auth/callback error:', err);
        return response(500, { error: 'Internal server error' });
      }
    }
    if (KNOWN_PROVIDERS.includes(providerId)) {
      return response(501, { error: `Auth flow for ${providerId} not yet implemented` });
    }
    return response(404, { error: 'Unknown provider' });
  }

  // POST /trackers/connections/{provider}/{instance} — finalize an OAuth flow
  // that returned a pendingChoice. Today only jira-cloud uses this.
  if (
    httpMethod === 'POST' &&
    path.includes('/trackers/connections/') &&
    pathParameters.provider &&
    pathParameters.instance
  ) {
    if (!userId) return response(401, { error: 'Unauthorized' });
    if (pathParameters.provider !== 'jira-cloud' || pathParameters.instance !== 'cloud') {
      return response(404, { error: 'Unknown provider connection' });
    }
    try {
      const data = body ? JSON.parse(body) : {};
      if (!data.ticket || !data.cloudId) {
        return response(400, { error: 'ticket and cloudId are required' });
      }
      const { clientSecret } = await getJiraOAuthCredentials();
      const ticketPayload = verifyEnvelope(data.ticket, clientSecret);
      if (!ticketPayload?.userId || ticketPayload.userId !== userId) {
        return response(400, { error: 'Invalid or expired ticket' });
      }
      const resources = await listAccessibleResources(ticketPayload.accessToken);
      const chosen = resources.find((r) => r.cloudId === data.cloudId);
      if (!chosen) {
        return response(400, { error: 'Chosen cloudId is not accessible to this account' });
      }
      await persistConnection({
        ddb,
        ssm,
        userId,
        resource: chosen,
        tokens: {
          accessToken: ticketPayload.accessToken,
          refreshToken: ticketPayload.refreshToken,
          expiresIn: ticketPayload.expiresIn,
        },
        scope: 'read:jira-work read:jira-user offline_access',
      });
      return response(200, { success: true });
    } catch (err) {
      if (err instanceof ProviderError) {
        return response(err.status, { error: err.message, ...err.extra });
      }
      console.error('Jira finalize error:', err);
      return response(500, { error: 'Internal server error' });
    }
  }

  // GET /trackers/external-projects/{provider}/{instance} — picker for
  // listing the user's accessible Jira projects (or future providers'
  // equivalents) before creating a binding.
  if (
    httpMethod === 'GET' &&
    path.includes('/trackers/external-projects/') &&
    pathParameters.provider &&
    pathParameters.instance
  ) {
    if (!userId) return response(401, { error: 'Unauthorized' });
    let providerImpl;
    try {
      providerImpl = getProvider(pathParameters.provider, pathParameters.instance);
    } catch (err) {
      return handleProviderError(response, err);
    }
    try {
      const items = await providerImpl.listExternalProjects({ ddb, ssm, secrets, userId });
      return response(200, items);
    } catch (err) {
      return handleProviderError(response, err);
    }
  }

  // GET /trackers/providers — operator-configuration status for each
  // tracker provider. Drives the Admin OAuth-config form and the
  // project-level "Connect ..." button gating. Returns one entry per
  // provider with a `configured` boolean computed from its Secrets-
  // Manager slot.
  if (
    httpMethod === 'GET' &&
    path.endsWith('/trackers/providers') &&
    !pathParameters.provider &&
    !pathParameters.projectId
  ) {
    if (!userId) return response(401, { error: 'Unauthorized' });
    // Independent Secrets-Manager probes — fire concurrently so the Admin
    // page doesn't pay N×latency. Treat any unexpected error as
    // "not configured" so the UI can keep rendering.
    const out = await Promise.all(
      Object.entries(PROVIDER_OAUTH_CONFIG).map(async ([id, cfg]) => {
        let configured = false;
        try {
          const r = await readOAuthSecret(cfg.secretEnvVar);
          configured = r.configured;
        } catch (err) {
          console.error(`Failed to probe ${id} OAuth secret:`, err.message);
        }
        return { id, label: cfg.label, instances: cfg.instances, configured };
      }),
    );
    return response(200, out);
  }

  // PUT /trackers/providers/{provider}/oauth-config — admin-facing
  // writer. Persists {client_id, client_secret} to the provider's
  // Secrets-Manager slot. Cognito-authed (matches the existing
  // /agents/settings pattern; backend admin gating is a separate
  // follow-up across all admin endpoints).
  if (
    httpMethod === 'PUT' &&
    path.includes('/trackers/providers/') &&
    path.endsWith('/oauth-config') &&
    pathParameters.provider
  ) {
    if (!userId) return response(401, { error: 'Unauthorized' });
    const cfg = PROVIDER_OAUTH_CONFIG[pathParameters.provider];
    if (!cfg) {
      return response(400, { error: `Unknown tracker provider: ${pathParameters.provider}` });
    }
    let data;
    try {
      data = body ? JSON.parse(body) : {};
    } catch {
      return response(400, { error: 'Invalid JSON body' });
    }
    const clientId = typeof data.clientId === 'string' ? data.clientId.trim() : '';
    const clientSecret = typeof data.clientSecret === 'string' ? data.clientSecret.trim() : '';
    if (!clientId || !clientSecret) {
      return response(400, { error: 'clientId and clientSecret are both required' });
    }
    if (clientId.length > 1024 || clientSecret.length > 1024) {
      return response(400, { error: 'clientId / clientSecret too long' });
    }
    try {
      await writeOAuthSecret(cfg.secretEnvVar, clientId, clientSecret);
    } catch (err) {
      if (err instanceof ProviderError) {
        return response(err.status, { error: err.message });
      }
      console.error('Failed to write OAuth secret:', err);
      return response(500, { error: 'Failed to write OAuth secret' });
    }
    return response(200, { success: true });
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

    const bindingId = pathParameters.bindingId;

    // Fire role + binding lookup concurrently when a bindingId is present
    // (disjoint reads on different parts of the graph). Saves a round-trip
    // on the hot issue-list path.
    const [role, bindingOrNull] = await Promise.all([
      fetchMembershipRole(g, projectId, userId),
      bindingId ? fetchBinding(g, projectId, bindingId) : Promise.resolve(null),
    ]);
    if (!role) return response(403, { error: 'Access denied' });

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

      // Require an active connection so the binding is actually usable.
      if (provider === 'github-issues') {
        const { Item } = await ddb.send(
          new GetCommand({
            TableName: process.env.GIT_CONNECTIONS_TABLE,
            Key: { userId },
          }),
        );
        // git-connections is keyed by userId alone — ensure the row is a GitHub
        // connection (legacy rows without `provider` are treated as GitHub).
        if (!Item || (Item.provider && Item.provider !== 'github')) {
          return response(400, { error: 'GitHub not connected' });
        }
      } else if (provider === 'gitlab-issues') {
        const { Item } = await ddb.send(
          new GetCommand({
            TableName: process.env.GIT_CONNECTIONS_TABLE,
            Key: { userId },
          }),
        );
        if (!Item || (Item.provider && Item.provider !== 'gitlab')) {
          return response(400, { error: 'GitLab not connected' });
        }
      } else if (provider === 'jira-cloud') {
        const { Item } = await ddb.send(
          new GetCommand({
            TableName: process.env.TRACKER_CONNECTIONS_TABLE,
            Key: { userId, providerInstance: `${provider}#${instance}` },
          }),
        );
        if (!Item) {
          return response(400, { error: 'Jira Cloud not connected' });
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
      if (bindingId === LEGACY_GITHUB_BINDING_ID) {
        // Legacy synthetic binding has no corresponding graph edge to drop.
        // The user-visible way to remove it is to migrate the project (which
        // turns it into a real edge) or to set issueIntegrationEnabled=false
        // on the project itself.
        return response(400, {
          error: 'Migrate this project before removing the legacy GitHub-issues binding',
        });
      }
      if (!bindingOrNull) return response(404, { error: 'Binding not found' });
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
    const binding = bindingOrNull;
    if (!binding) return response(404, { error: 'Binding not found' });

    let provider;
    try {
      provider = getProvider(binding.provider, binding.instance);
    } catch (err) {
      return handleProviderError(response, err);
    }

    const ctx = { ddb, ssm, secrets, userId };

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
          // Cursor for providers (Jira Cloud since CHANGE-2046) that require
          // it; ignored by GitHub which uses page-number pagination.
          pageToken: queryStringParameters?.pageToken,
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
