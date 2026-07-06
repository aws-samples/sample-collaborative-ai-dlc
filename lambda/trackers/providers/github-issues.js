import { GetParameterCommand } from '@aws-sdk/client-ssm';
import { ProviderError } from './errors.js';
import { getGitConnection } from '../../shared/git-connection-store.js';
import { getGitHubAuthMode } from '../../shared/github-auth-config.js';
import { getInstallationTokenFromConfig } from '../../shared/git-token.js';

const GIT_TOKEN_PARAM_PATTERN = /^\/[\w-]+\/[\w-]+\/[\w-]+\/[\w-]+(\/[\w-]+)?$/;

const ETAG_CACHE_MAX = 200;
const etagCache = new Map();

const cacheGet = (key) => {
  const entry = etagCache.get(key);
  if (!entry) return undefined;
  etagCache.delete(key);
  etagCache.set(key, entry);
  return entry;
};

const cacheSet = (key, value) => {
  if (etagCache.has(key)) etagCache.delete(key);
  etagCache.set(key, value);
  if (etagCache.size > ETAG_CACHE_MAX) {
    const oldest = etagCache.keys().next().value;
    etagCache.delete(oldest);
  }
};

export const __resetCache = () => etagCache.clear();

const resolveGithubToken = async (ddb, ssm, userId) => {
  // GitHub issues reuse the GitHub git connection (one OAuth token backs both
  // repo and issue operations). The store returns null unless the user has a
  // GitHub connection (and lazily migrates legacy rows on read).
  const Item = await getGitConnection(ddb, userId, 'github');
  if (!Item) {
    const err = new Error('GitHub not connected');
    err.code = 'NOT_CONNECTED';
    throw err;
  }
  if (!Item.parameterName || !GIT_TOKEN_PARAM_PATTERN.test(Item.parameterName)) {
    const err = new Error('Invalid SSM parameter name');
    err.code = 'NOT_CONNECTED';
    throw err;
  }
  const param = await ssm.send(
    new GetParameterCommand({ Name: Item.parameterName, WithDecryption: true }),
  );
  return JSON.parse(param.Parameter.Value).accessToken;
};

// App-mode token: a repo-scoped installation token with issues:read — issue
// browsing needs no user connection when the platform authenticates as the
// GitHub App. Failures surface as NOT_CONNECTED-style provider errors so the
// UI shows the same "check configuration" affordance either way.
const resolveAppModeToken = async (ssm, secrets, repoSlug) => {
  try {
    return await getInstallationTokenFromConfig({
      ssm,
      secrets,
      repositories: [repoSlug],
      permissions: { issues: 'read' },
    });
  } catch (e) {
    const err = new Error(`GitHub App token unavailable: ${e.message}`);
    err.code = 'NOT_CONNECTED';
    throw err;
  }
};

const githubFetch = (url, token, etag) => {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
  };
  if (etag) headers['If-None-Match'] = etag;
  return fetch(url, { headers });
};

const parseLinkHeader = (header) => {
  if (!header) return {};
  const out = {};
  for (const part of header.split(',')) {
    const m = part.match(/<([^>]+)>;\s*rel="([^"]+)"/);
    if (m) out[m[2]] = m[1];
  }
  return out;
};

const isRateLimited = (r) => r.status === 403 && r.headers.get('x-ratelimit-remaining') === '0';

const rateLimitInfo = (r) => {
  const reset = Number.parseInt(r.headers.get('x-ratelimit-reset') || '0', 10);
  const retryAfter = reset > 0 ? Math.max(0, reset - Math.floor(Date.now() / 1000)) : 60;
  return { error: 'GitHub rate limit exceeded', retryAfter };
};

const splitOwnerRepo = (externalProjectKey) => {
  if (!externalProjectKey || typeof externalProjectKey !== 'string') {
    throw new ProviderError(400, 'Invalid externalProjectKey for github-issues');
  }
  const parts = externalProjectKey.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new ProviderError(400, 'externalProjectKey must be "owner/repo"');
  }
  return { owner: parts[0], repo: parts[1] };
};

const mapIssueToTrackerIssue = (i) => ({
  resourceId: String(i.number),
  resourceUrl: i.html_url,
  resourceType: 'issue',
  // GitHub issues are flat — no per-issue type. Left null so the
  // normalized shape matches Jira's; the UI hides the chip when null.
  entityType: null,
  entityIconUrl: null,
  title: i.title,
  body: i.body ?? null,
  state: i.state === 'closed' ? 'closed' : 'open',
  labels: Array.isArray(i.labels) ? i.labels.map((l) => ({ name: l.name, color: l.color })) : [],
  author: { handle: i.user?.login || '', avatarUrl: i.user?.avatar_url || '' },
  createdAt: i.created_at,
  updatedAt: i.updated_at,
});

const mapCommentToTrackerComment = (c) => ({
  id: String(c.id),
  author: { handle: c.user?.login || '', avatarUrl: c.user?.avatar_url || '' },
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

const buildContext = async ({ ddb, ssm, secrets, userId }, repoSlug) => {
  // Mode dispatch (shared/github-auth-config.js): app mode mints a repo-scoped
  // installation token; oauth mode resolves the user's connection token.
  if (secrets && (await getGitHubAuthMode(ssm)) === 'app') {
    const token = await resolveAppModeToken(ssm, secrets, repoSlug);
    return { userId, token };
  }
  const token = await resolveGithubToken(ddb, ssm, userId);
  return { userId, token };
};

const listIssues = async ({ ddb, ssm, secrets, userId }, externalProjectKey, opts = {}) => {
  const { owner, repo } = splitOwnerRepo(externalProjectKey);
  const ctx = await buildContext({ ddb, ssm, secrets, userId }, `${owner}/${repo}`);
  const state = ['open', 'closed', 'all'].includes(opts.state) ? opts.state : 'open';
  const q = (opts.q || '').trim();
  const page = parsePageNumber(opts.page);
  const perPage = parsePerPage(opts.perPage);

  let url;
  let isSearch = false;
  if (q) {
    const searchQ = `repo:${owner}/${repo}+state:${state}+is:issue+${encodeURIComponent(q)}`;
    url = `https://api.github.com/search/issues?q=${searchQ}&per_page=${perPage}&page=${page}`;
    isSearch = true;
  } else {
    url = `https://api.github.com/repos/${owner}/${repo}/issues?per_page=${perPage}&page=${page}&state=${state}`;
  }

  const cacheKey = `list:${ctx.userId}:${url}`;
  const cached = cacheGet(cacheKey);
  const r = await githubFetch(url, ctx.token, cached?.etag);

  if (r.status === 304 && cached) return cached.body;
  if (r.status === 404) {
    return { items: [], page, perPage, hasNext: false, hasPrev: false, totalCount: null };
  }
  if (isRateLimited(r)) throw new ProviderError(429, '', rateLimitInfo(r));

  const data = await r.json();
  if (!r.ok) {
    throw new ProviderError(r.status, data.message || 'Failed to fetch issues');
  }

  const rawItems = isSearch
    ? Array.isArray(data.items)
      ? data.items
      : []
    : Array.isArray(data)
      ? data
      : [];
  const items = rawItems.filter((i) => !i.pull_request).map(mapIssueToTrackerIssue);

  const link = parseLinkHeader(r.headers.get('link'));
  const hasNext = Boolean(link.next);
  const hasPrev = Boolean(link.prev);
  const totalCount = isSearch && Number.isFinite(data.total_count) ? data.total_count : null;

  const body = { items, page, perPage, hasNext, hasPrev, totalCount };
  const newEtag = r.headers.get('etag');
  if (newEtag) cacheSet(cacheKey, { etag: newEtag, body });
  return body;
};

const getIssue = async ({ ddb, ssm, secrets, userId }, externalProjectKey, resourceId) => {
  const { owner, repo } = splitOwnerRepo(externalProjectKey);
  const ctx = await buildContext({ ddb, ssm, secrets, userId }, `${owner}/${repo}`);
  const cacheKey = `detail:${ctx.userId}:${owner}/${repo}#${resourceId}`;
  const cached = cacheGet(cacheKey);
  const r = await githubFetch(
    `https://api.github.com/repos/${owner}/${repo}/issues/${resourceId}`,
    ctx.token,
    cached?.etag,
  );
  if (r.status === 304 && cached) return cached.body;
  if (isRateLimited(r)) throw new ProviderError(429, '', rateLimitInfo(r));
  const data = await r.json();
  if (!r.ok || data.message) {
    throw new ProviderError(r.ok ? 400 : r.status, data.message || 'Failed to fetch issue');
  }
  if (data.pull_request) throw new ProviderError(404, 'Not found');
  const mapped = mapIssueToTrackerIssue(data);
  const newEtag = r.headers.get('etag');
  if (newEtag) cacheSet(cacheKey, { etag: newEtag, body: mapped });
  return mapped;
};

const getIssueDiscussion = async (
  { ddb, ssm, secrets, userId },
  externalProjectKey,
  resourceId,
) => {
  const { owner, repo } = splitOwnerRepo(externalProjectKey);
  const ctx = await buildContext({ ddb, ssm, secrets, userId }, `${owner}/${repo}`);
  const url = `https://api.github.com/repos/${owner}/${repo}/issues/${resourceId}/comments?per_page=100`;
  const cacheKey = `comments:${ctx.userId}:${owner}/${repo}#${resourceId}`;
  const cached = cacheGet(cacheKey);
  const r = await githubFetch(url, ctx.token, cached?.etag);
  if (r.status === 304 && cached) return cached.body;
  if (r.status === 404) return [];
  if (isRateLimited(r)) throw new ProviderError(429, '', rateLimitInfo(r));
  const data = await r.json();
  if (!r.ok) {
    throw new ProviderError(r.status, data.message || 'Failed to fetch comments');
  }
  const comments = Array.isArray(data) ? data.map(mapCommentToTrackerComment) : [];
  const newEtag = r.headers.get('etag');
  if (newEtag) cacheSet(cacheKey, { etag: newEtag, body: comments });
  return comments;
};

// listExternalProjects is unused in Phase 2 (the picker UI lands in Phase 3).
// Stubbed so the provider exposes the full uniform shape.
const listExternalProjects = async () => {
  throw new ProviderError(501, 'github-issues listExternalProjects not implemented in Phase 2');
};

export const provider = {
  id: 'github-issues',
  listExternalProjects,
  listIssues,
  getIssue,
  getIssueDiscussion,
};
