import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { GetParameterCommand, PutParameterCommand } from '@aws-sdk/client-ssm';
import { GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { adfToMarkdown } from './adf-to-markdown.js';
import { ProviderError } from './errors.js';

export { ProviderError };

// Provider for Atlassian's Jira Cloud (OAuth 2.0 3LO). Mirrors the shape
// established by the github-issues provider in Phase 2 — same DTOs, same
// ProviderError class, same `code: 'NOT_CONNECTED'` for missing-token paths
// so the route layer keeps a single error-handling branch.

const JIRA_TOKEN_PARAM_PATTERN = /^\/[\w-]+\/[\w-]+\/[\w-]+\/[\w-]+$/;
const PROVIDER_INSTANCE = 'jira-cloud#cloud';
const REFRESH_SAFETY_MARGIN_MS = 60_000;

const requireEnv = (name) => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} env var is required`);
  return v;
};

// ---------------------------------------------------------------------------
// OAuth helpers — used by the trackers handler during /trackers/auth and
// /trackers/callback. Pulled out of the provider object because they don't
// depend on a connection ctx (no token yet).
// ---------------------------------------------------------------------------

export const buildAuthorizeUrl = ({ clientId, redirectUri, state }) => {
  const params = new URLSearchParams({
    audience: 'api.atlassian.com',
    client_id: clientId,
    scope: 'read:jira-work read:jira-user offline_access',
    redirect_uri: redirectUri,
    state,
    response_type: 'code',
    prompt: 'consent',
  });
  return `https://auth.atlassian.com/authorize?${params.toString()}`;
};

export const exchangeCode = async ({ clientId, clientSecret, redirectUri, code }) => {
  const r = await fetch('https://auth.atlassian.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new ProviderError(r.status, data.error_description || data.error || 'Token exchange failed');
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: Number(data.expires_in) || 3600,
  };
};

export const refreshAccessToken = async ({ clientId, clientSecret, refreshToken }) => {
  const r = await fetch('https://auth.atlassian.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new ProviderError(401, 'Jira token refresh failed', { reconnect: true });
    err.code = 'REFRESH_FAILED';
    throw err;
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || refreshToken,
    expiresIn: Number(data.expires_in) || 3600,
  };
};

export const listAccessibleResources = async (accessToken) => {
  const r = await fetch('https://api.atlassian.com/oauth/token/accessible-resources', {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  });
  const data = await r.json().catch(() => ([]));
  if (!r.ok) {
    throw new ProviderError(r.status, 'Failed to list Atlassian sites');
  }
  if (!Array.isArray(data)) return [];
  return data.map((s) => ({
    cloudId: s.id,
    name: s.name,
    url: s.url,
    host: (() => {
      try {
        return new URL(s.url).host;
      } catch {
        return null;
      }
    })(),
    scopes: s.scopes || [],
  }));
};

// Persist the connection row + SSM token. Used by both the single-resource
// and the multi-resource finalize paths in the trackers handler.
export const persistConnection = async ({
  ddb,
  ssm,
  userId,
  resource,
  tokens,
  scope,
}) => {
  const parameterName = `/${requireEnv('JIRA_TOKEN_SSM_PREFIX')}/${userId}`;
  if (!JIRA_TOKEN_PARAM_PATTERN.test(parameterName)) {
    throw new Error('Invalid SSM parameter name format');
  }
  const expiresAt = Date.now() + tokens.expiresIn * 1000;
  await ssm.send(
    new PutParameterCommand({
      Name: parameterName,
      Value: JSON.stringify({
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt,
      }),
      Type: 'SecureString',
      // Atlassian access tokens are JWTs that routinely exceed the
      // 4 KB standard-tier cap. Intelligent-Tiering keeps small values
      // on the free standard tier and auto-promotes anything larger
      // to the advanced tier instead of failing with ValidationException.
      Tier: 'Intelligent-Tiering',
      Overwrite: true,
    }),
  );
  await ddb.send(
    new PutCommand({
      TableName: requireEnv('TRACKER_CONNECTIONS_TABLE'),
      Item: {
        userId,
        providerInstance: PROVIDER_INSTANCE,
        parameterName,
        cloudId: resource.cloudId,
        baseUrl: `https://api.atlassian.com/ex/jira/${resource.cloudId}`,
        siteHost: resource.host || '',
        siteName: resource.name || '',
        scope: scope || 'read:jira-work read:jira-user offline_access',
        createdAt: new Date().toISOString(),
        expiresAt,
      },
    }),
  );
};

// ---------------------------------------------------------------------------
// Connection resolution + auto-refresh, used by every resource call.
// ---------------------------------------------------------------------------

const getConnectionRow = async (ddb, userId) => {
  const { Item } = await ddb.send(
    new GetCommand({
      TableName: requireEnv('TRACKER_CONNECTIONS_TABLE'),
      Key: { userId, providerInstance: PROVIDER_INSTANCE },
    }),
  );
  if (!Item) {
    const err = new Error('Jira Cloud not connected');
    err.code = 'NOT_CONNECTED';
    throw err;
  }
  if (!Item.parameterName || !JIRA_TOKEN_PARAM_PATTERN.test(Item.parameterName)) {
    const err = new Error('Invalid SSM parameter name');
    err.code = 'NOT_CONNECTED';
    throw err;
  }
  return Item;
};

const readTokens = async (ssm, parameterName) => {
  const param = await ssm.send(
    new GetParameterCommand({ Name: parameterName, WithDecryption: true }),
  );
  return JSON.parse(param.Parameter.Value);
};

const writeTokens = async (ssm, parameterName, tokens) =>
  ssm.send(
    new PutParameterCommand({
      Name: parameterName,
      Value: JSON.stringify(tokens),
      Type: 'SecureString',
      // Atlassian access tokens are JWTs that routinely exceed the
      // 4 KB standard-tier cap. Intelligent-Tiering keeps small values
      // on the free standard tier and auto-promotes anything larger
      // to the advanced tier instead of failing with ValidationException.
      Tier: 'Intelligent-Tiering',
      Overwrite: true,
    }),
  );

const updateRowExpiresAt = async (ddb, row, expiresAt) =>
  ddb.send(
    new PutCommand({
      TableName: requireEnv('TRACKER_CONNECTIONS_TABLE'),
      Item: { ...row, expiresAt },
    }),
  );

const getOAuthCredentials = async (secrets) => {
  const result = await secrets.send(
    new GetSecretValueCommand({ SecretId: requireEnv('JIRA_OAUTH_SECRET_NAME') }),
  );
  if (!result.SecretString) throw new Error('Jira OAuth secret is empty');
  const parsed = JSON.parse(result.SecretString);
  if (!parsed.client_id || !parsed.client_secret) {
    throw new Error('Jira OAuth secret missing client_id / client_secret');
  }
  return { clientId: parsed.client_id, clientSecret: parsed.client_secret };
};

// Returns { accessToken, baseUrl, siteHost, row, parameterName, ddb, ssm }.
// Refreshes proactively if the cached access token is within the safety
// margin of expiry. Reactive refresh-on-401 happens inside `jiraFetch`.
const buildContext = async ({ ddb, ssm, secrets, userId }) => {
  const row = await getConnectionRow(ddb, userId);
  const tokens = await readTokens(ssm, row.parameterName);
  let accessToken = tokens.accessToken;

  if (!tokens.expiresAt || Date.now() >= tokens.expiresAt - REFRESH_SAFETY_MARGIN_MS) {
    try {
      const creds = await getOAuthCredentials(secrets);
      const fresh = await refreshAccessToken({
        clientId: creds.clientId,
        clientSecret: creds.clientSecret,
        refreshToken: tokens.refreshToken,
      });
      const expiresAt = Date.now() + fresh.expiresIn * 1000;
      await writeTokens(ssm, row.parameterName, {
        accessToken: fresh.accessToken,
        refreshToken: fresh.refreshToken,
        expiresAt,
      });
      await updateRowExpiresAt(ddb, row, expiresAt);
      accessToken = fresh.accessToken;
    } catch (err) {
      if (err.code === 'REFRESH_FAILED') throw err;
      throw err;
    }
  }

  return {
    userId,
    accessToken,
    baseUrl: row.baseUrl,
    siteHost: row.siteHost,
    row,
    ddb,
    ssm,
    secrets,
  };
};

const jiraFetch = async (ctx, path, init = {}) => {
  const url = path.startsWith('http') ? path : `${ctx.baseUrl}${path}`;
  const headers = {
    Authorization: `Bearer ${ctx.accessToken}`,
    Accept: 'application/json',
    ...init.headers,
  };
  let r = await fetch(url, { ...init, headers });
  if (r.status !== 401) return r;

  // Reactive refresh-and-retry once. If the proactive refresh in
  // buildContext already happened, this still covers the rare case where
  // Atlassian invalidates a token mid-flight (revoked at server).
  let creds;
  let refreshed;
  try {
    creds = await getOAuthCredentials(ctx.secrets);
    const tokens = await readTokens(ctx.ssm, ctx.row.parameterName);
    refreshed = await refreshAccessToken({
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
      refreshToken: tokens.refreshToken,
    });
  } catch {
    throw new ProviderError(401, 'Jira authentication expired', { reconnect: true });
  }
  const expiresAt = Date.now() + refreshed.expiresIn * 1000;
  await writeTokens(ctx.ssm, ctx.row.parameterName, {
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken,
    expiresAt,
  });
  await updateRowExpiresAt(ctx.ddb, ctx.row, expiresAt);
  ctx.accessToken = refreshed.accessToken;

  r = await fetch(url, {
    ...init,
    headers: { ...headers, Authorization: `Bearer ${refreshed.accessToken}` },
  });
  if (r.status === 401) {
    throw new ProviderError(401, 'Jira authentication expired', { reconnect: true });
  }
  return r;
};

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

const stateFromStatus = (fields) => {
  const cat = fields?.status?.statusCategory?.key;
  return cat === 'done' ? 'closed' : 'open';
};

const mapIssueToTrackerIssue = (i, siteHost) => {
  const fields = i.fields || {};
  const reporter = fields.reporter || {};
  const url = `https://${siteHost}/browse/${i.key}`;
  // entityType surfaces Jira's per-issue type (Epic / Story / Task / Bug /
  // Sub-task) so the UI can show what kind of resource the user is looking
  // at. iconUrl is Atlassian's per-type icon (16×16 PNG hosted by the
  // Jira instance); the frontend renders it inline next to the title.
  const issueType = fields.issuetype || {};
  return {
    resourceId: i.key,
    resourceUrl: url,
    resourceType: 'issue',
    entityType: issueType.name || null,
    entityIconUrl: issueType.iconUrl || null,
    title: fields.summary || '',
    body: fields.description ? adfToMarkdown(fields.description) : null,
    state: stateFromStatus(fields),
    labels: Array.isArray(fields.labels) ? fields.labels.map((name) => ({ name })) : [],
    author: {
      handle: reporter.displayName || reporter.accountId || '',
      avatarUrl: reporter.avatarUrls?.['48x48'] || '',
    },
    createdAt: fields.created || '',
    updatedAt: fields.updated || '',
  };
};

const mapCommentToTrackerComment = (c) => ({
  id: String(c.id),
  author: {
    handle: c.author?.displayName || c.author?.accountId || '',
    avatarUrl: c.author?.avatarUrls?.['48x48'] || '',
  },
  body: c.body ? adfToMarkdown(c.body) : '',
  createdAt: c.created || '',
  updatedAt: c.updated || '',
});

// ---------------------------------------------------------------------------
// JQL helpers
// ---------------------------------------------------------------------------

const escapeJqlString = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');

const buildJql = (projectKey, { state, q }) => {
  const parts = [`project = "${escapeJqlString(projectKey)}"`];
  if (state === 'closed') parts.push('statusCategory = Done');
  else if (state !== 'all') parts.push('statusCategory != Done');
  if (q && q.trim()) parts.push(`text ~ "${escapeJqlString(q.trim())}"`);
  return parts.join(' AND ');
};

const DEFAULT_PER_PAGE = 30;
const MAX_PER_PAGE = 100;

const parsePerPage = (raw) => {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_PER_PAGE;
  return Math.min(n, MAX_PER_PAGE);
};

const parsePageNumber = (raw) => {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return n;
};

// ---------------------------------------------------------------------------
// Provider methods
// ---------------------------------------------------------------------------

const listExternalProjects = async ({ ddb, ssm, secrets, userId }) => {
  const ctx = await buildContext({ ddb, ssm, secrets, userId });
  const r = await jiraFetch(ctx, '/rest/api/3/project/search?maxResults=100');
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new ProviderError(r.status, data.errorMessages?.[0] || 'Failed to list Jira projects');
  }
  const values = Array.isArray(data.values) ? data.values : [];
  return values.map((p) => ({
    key: p.key,
    name: p.name,
    displayKey: p.key,
  }));
};

const listIssues = async ({ ddb, ssm, secrets, userId }, projectKey, opts = {}) => {
  if (!projectKey) {
    throw new ProviderError(400, 'Invalid externalProjectKey for jira-cloud');
  }
  const ctx = await buildContext({ ddb, ssm, secrets, userId });
  const state = ['open', 'closed', 'all'].includes(opts.state) ? opts.state : 'open';
  const page = parsePageNumber(opts.page);
  const perPage = parsePerPage(opts.perPage);
  const pageToken = typeof opts.pageToken === 'string' && opts.pageToken ? opts.pageToken : null;

  // Atlassian deprecated `/rest/api/3/search` (CHANGE-2046). The replacement
  // `/rest/api/3/search/jql` uses cursor pagination (`nextPageToken`) and
  // doesn't return a total by default. We thread an opaque `pageToken`
  // through the provider DTO so the frontend's sequential `listIssuePages`
  // generator can drive paging without knowing it's cursor-based; the
  // user-visible `page` is still incremented in the generator and is just
  // a counter on this side.
  const jql = buildJql(projectKey, { state, q: opts.q });
  const fields = 'summary,status,labels,reporter,created,updated,description,issuetype';
  const params = new URLSearchParams({ jql, maxResults: String(perPage), fields });
  if (pageToken) params.set('nextPageToken', pageToken);
  const url = `/rest/api/3/search/jql?${params.toString()}`;

  const r = await jiraFetch(ctx, url);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new ProviderError(r.status, data.errorMessages?.[0] || 'Failed to fetch Jira issues');
  }

  const rawItems = Array.isArray(data.issues) ? data.issues : [];
  const items = rawItems.map((i) => mapIssueToTrackerIssue(i, ctx.siteHost));
  const nextPageToken = typeof data.nextPageToken === 'string' ? data.nextPageToken : null;
  const hasNext = data.isLast === true ? false : !!nextPageToken;
  const hasPrev = page > 1;

  return { items, page, perPage, hasNext, hasPrev, totalCount: null, nextPageToken };
};

const getIssue = async ({ ddb, ssm, secrets, userId }, projectKey, resourceId) => {
  if (!resourceId) throw new ProviderError(400, 'Missing resourceId');
  const ctx = await buildContext({ ddb, ssm, secrets, userId });
  const r = await jiraFetch(ctx, `/rest/api/3/issue/${encodeURIComponent(resourceId)}`);
  if (r.status === 404) throw new ProviderError(404, 'Not found');
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new ProviderError(r.status, data.errorMessages?.[0] || 'Failed to fetch Jira issue');
  }
  return mapIssueToTrackerIssue(data, ctx.siteHost);
};

const getIssueDiscussion = async ({ ddb, ssm, secrets, userId }, projectKey, resourceId) => {
  if (!resourceId) throw new ProviderError(400, 'Missing resourceId');
  const ctx = await buildContext({ ddb, ssm, secrets, userId });
  const r = await jiraFetch(
    ctx,
    `/rest/api/3/issue/${encodeURIComponent(resourceId)}/comment?maxResults=100`,
  );
  if (r.status === 404) return [];
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new ProviderError(r.status, data.errorMessages?.[0] || 'Failed to fetch Jira comments');
  }
  const comments = Array.isArray(data.comments) ? data.comments : [];
  return comments.map(mapCommentToTrackerComment);
};

export const provider = {
  id: 'jira-cloud',
  listExternalProjects,
  listIssues,
  getIssue,
  getIssueDiscussion,
};
