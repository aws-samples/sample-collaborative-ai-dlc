import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { GetParameterCommand, PutParameterCommand } from '@aws-sdk/client-ssm';
import { GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { ProviderError } from './errors.js';

// Provider for GitLab Issues. Mirrors the github-issues provider's shape and
// DTOs (same `code: 'NOT_CONNECTED'` contract, same normalized issue/comment
// shapes) so the route layer keeps a single error-handling branch.
//
// GitLab issues + OAuth share the GitLab connection stored in git-connections
// (written by lambda/gitlab via shared/git-handler), exactly as github-issues
// reuses the GitHub connection. The access token expires, so reads refresh it
// on 401 using the stored refresh token + the GitLab OAuth secret.

const GIT_TOKEN_PARAM_PATTERN = /^\/[\w-]+\/[\w-]+\/[\w-]+\/[\w-]+$/;
const API_BASE = 'https://gitlab.com/api/v4';

const requireEnv = (name) => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} env var is required`);
  return v;
};

const encodeProject = (externalProjectKey) => {
  if (!externalProjectKey || typeof externalProjectKey !== 'string') {
    throw new ProviderError(400, 'Invalid externalProjectKey for gitlab-issues');
  }
  // GitLab addresses projects by URL-encoded "group/project".
  return encodeURIComponent(externalProjectKey);
};

// ---------------------------------------------------------------------------
// Token resolution + refresh (mirrors lambda/gitlab's refresh flow)
// ---------------------------------------------------------------------------

const getGitlabConnection = async (ddb, userId) => {
  const { Item } = await ddb.send(
    new GetCommand({ TableName: process.env.GIT_CONNECTIONS_TABLE, Key: { userId } }),
  );
  if (!Item) {
    const err = new Error('GitLab not connected');
    err.code = 'NOT_CONNECTED';
    throw err;
  }
  if (Item.provider && Item.provider !== 'gitlab') {
    // The single-key git-connections row currently holds a different provider.
    const err = new Error('GitLab not connected');
    err.code = 'NOT_CONNECTED';
    throw err;
  }
  if (!Item.parameterName || !GIT_TOKEN_PARAM_PATTERN.test(Item.parameterName)) {
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

const getOAuthCredentials = async (secrets) => {
  const secretName = requireEnv('GITLAB_OAUTH_SECRET_NAME');
  let result;
  try {
    result = await secrets.send(new GetSecretValueCommand({ SecretId: secretName }));
  } catch (e) {
    if (e.name === 'ResourceNotFoundException') {
      throw new ProviderError(503, 'GitLab OAuth is not configured on this environment');
    }
    throw e;
  }
  const parsed = JSON.parse(result.SecretString || '{}');
  if (!parsed.client_id || !parsed.client_secret) {
    throw new ProviderError(503, 'GitLab OAuth is not configured on this environment');
  }
  return parsed;
};

const refreshToken = async ({ ddb, ssm, secrets, item, refreshTokenValue }) => {
  const { client_id, client_secret } = await getOAuthCredentials(secrets);
  const res = await fetch('https://gitlab.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: refreshTokenValue,
      client_id,
      client_secret,
    }),
  });
  const data = await res.json();
  if (data.error) {
    throw new ProviderError(401, data.error_description || data.error);
  }
  await ssm.send(
    new PutParameterCommand({
      Name: item.parameterName,
      Value: JSON.stringify({
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        tokenType: data.token_type,
      }),
      Type: 'SecureString',
      Overwrite: true,
    }),
  );
  await ddb.send(
    new PutCommand({
      TableName: process.env.GIT_CONNECTIONS_TABLE,
      Item: { ...item, scope: data.scope, updatedAt: new Date().toISOString() },
    }),
  );
  return data.access_token;
};

// Build a fetch context that refreshes the token once on 401.
const buildContext = async ({ ddb, ssm, secrets, userId }) => {
  const item = await getGitlabConnection(ddb, userId);
  const tokens = await readTokens(ssm, item.parameterName);
  const ctx = { token: tokens.accessToken };
  ctx.fetch = async (url, options = {}) => {
    const withAuth = (token) => ({
      ...options,
      headers: { Authorization: `Bearer ${token}`, ...options.headers },
    });
    const res = await fetch(url, withAuth(ctx.token));
    if (res.status === 401 && tokens.refreshToken) {
      const newToken = await refreshToken({
        ddb,
        ssm,
        secrets,
        item,
        refreshTokenValue: tokens.refreshToken,
      });
      ctx.token = newToken;
      return fetch(url, withAuth(newToken));
    }
    return res;
  };
  return ctx;
};

// ---------------------------------------------------------------------------
// DTO mapping (identical normalized shape to github-issues)
// ---------------------------------------------------------------------------

const mapIssue = (i) => ({
  resourceId: String(i.iid),
  resourceUrl: i.web_url,
  resourceType: 'issue',
  entityType: i.issue_type || null,
  entityIconUrl: null,
  title: i.title,
  body: i.description ?? null,
  state: i.state === 'closed' ? 'closed' : 'open',
  labels: Array.isArray(i.labels) ? i.labels.map((name) => ({ name, color: null })) : [],
  author: { handle: i.author?.username || '', avatarUrl: i.author?.avatar_url || '' },
  createdAt: i.created_at,
  updatedAt: i.updated_at,
});

const mapComment = (c) => ({
  id: String(c.id),
  author: { handle: c.author?.username || '', avatarUrl: c.author?.avatar_url || '' },
  body: c.body ?? '',
  createdAt: c.created_at,
  updatedAt: c.updated_at,
});

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
// Provider operations
// ---------------------------------------------------------------------------

const listIssues = async ({ ddb, ssm, secrets, userId }, externalProjectKey, opts = {}) => {
  const project = encodeProject(externalProjectKey);
  const ctx = await buildContext({ ddb, ssm, secrets, userId });
  const state = ['open', 'closed', 'all'].includes(opts.state) ? opts.state : 'open';
  const glState = state === 'open' ? 'opened' : state === 'closed' ? 'closed' : 'all';
  const q = (opts.q || '').trim();
  const page = parsePageNumber(opts.page);
  const perPage = parsePerPage(opts.perPage);

  const params = new URLSearchParams({
    per_page: String(perPage),
    page: String(page),
    order_by: 'updated_at',
  });
  if (glState !== 'all') params.set('state', glState);
  if (q) params.set('search', q);

  const url = `${API_BASE}/projects/${project}/issues?${params.toString()}`;
  const res = await ctx.fetch(url);
  if (res.status === 404) {
    return { items: [], page, perPage, hasNext: false, hasPrev: false, totalCount: null };
  }
  const data = await res.json();
  if (!res.ok) {
    throw new ProviderError(res.status, data.message || 'Failed to fetch issues');
  }
  const items = Array.isArray(data) ? data.map(mapIssue) : [];
  const totalPages = Number.parseInt(res.headers.get('x-total-pages') || '0', 10);
  const totalCount = Number.parseInt(res.headers.get('x-total') || '', 10);
  const hasNext = totalPages ? page < totalPages : items.length === perPage;
  const hasPrev = page > 1;

  return {
    items,
    page,
    perPage,
    hasNext,
    hasPrev,
    totalCount: Number.isFinite(totalCount) ? totalCount : null,
  };
};

const getIssue = async ({ ddb, ssm, secrets, userId }, externalProjectKey, resourceId) => {
  const project = encodeProject(externalProjectKey);
  const ctx = await buildContext({ ddb, ssm, secrets, userId });
  const res = await ctx.fetch(`${API_BASE}/projects/${project}/issues/${resourceId}`);
  if (res.status === 404) throw new ProviderError(404, 'Not found');
  const data = await res.json();
  if (!res.ok || data.message) {
    throw new ProviderError(res.ok ? 400 : res.status, data.message || 'Failed to fetch issue');
  }
  return mapIssue(data);
};

const getIssueDiscussion = async (
  { ddb, ssm, secrets, userId },
  externalProjectKey,
  resourceId,
) => {
  const project = encodeProject(externalProjectKey);
  const ctx = await buildContext({ ddb, ssm, secrets, userId });
  const res = await ctx.fetch(
    `${API_BASE}/projects/${project}/issues/${resourceId}/notes?per_page=100&sort=asc`,
  );
  if (res.status === 404) return [];
  const data = await res.json();
  if (!res.ok) {
    throw new ProviderError(res.status, data.message || 'Failed to fetch comments');
  }
  // Drop GitLab system notes (label changes, status changes, etc.) — only
  // surface human comments, matching github-issues' issue-comment semantics.
  return Array.isArray(data) ? data.filter((n) => !n.system).map(mapComment) : [];
};

const listExternalProjects = async () => {
  throw new ProviderError(501, 'gitlab-issues listExternalProjects not implemented');
};

export const provider = {
  id: 'gitlab-issues',
  listExternalProjects,
  listIssues,
  getIssue,
  getIssueDiscussion,
};
