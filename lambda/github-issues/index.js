import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ssm = new SSMClient({});

const GIT_TOKEN_PARAM_PATTERN = /^\/[\w-]+\/[\w-]+\/[\w-]+\/[\w-]+$/;

const DEFAULT_PER_PAGE = 30;
const MAX_PER_PAGE = 100;
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

const allowedOrigin = (headers) => {
  const origins = (process.env.CORS_ALLOWED_ORIGINS || '*').split(',');
  const reqOrigin = headers?.origin || headers?.Origin;
  return origins.includes(reqOrigin) ? reqOrigin : origins[0];
};

const buildResponse = (event, { methods = 'GET,OPTIONS' } = {}) =>
  (statusCode, body, extraHeaders = {}) => ({
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': allowedOrigin(event?.headers),
      'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
      'Access-Control-Allow-Methods': methods,
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });

const resolveGitToken = async (item) => {
  if (!item?.parameterName) throw new Error('No SSM parameter name set');
  if (!GIT_TOKEN_PARAM_PATTERN.test(item.parameterName)) {
    throw new Error('Invalid SSM parameter name format');
  }
  const param = await ssm.send(new GetParameterCommand({
    Name: item.parameterName,
    WithDecryption: true,
  }));
  return JSON.parse(param.Parameter.Value).accessToken;
};

const mapIssue = (i) => ({
  number: i.number,
  title: i.title,
  body: i.body ?? null,
  state: i.state,
  htmlUrl: i.html_url,
  labels: Array.isArray(i.labels)
    ? i.labels.map(l => ({ name: l.name, color: l.color })).filter(l => l.name)
    : [],
  user: { login: i.user?.login || '', avatarUrl: i.user?.avatar_url || '' },
  createdAt: i.created_at,
  updatedAt: i.updated_at,
});

const parseLinkHeader = (header) => {
  if (!header) return {};
  const out = {};
  for (const part of header.split(',')) {
    const m = part.match(/<([^>]+)>;\s*rel="([^"]+)"/);
    if (m) out[m[2]] = m[1];
  }
  return out;
};

const githubFetch = async (url, token, etag) => {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
  };
  if (etag) headers['If-None-Match'] = etag;
  return fetch(url, { headers });
};

const ISSUES_LIST_PATH = /\/github\/repos\/([^/]+)\/([^/]+)\/issues$/;
const ISSUE_DETAIL_PATH = /\/github\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/;
const ISSUE_COMMENTS_PATH = /\/github\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/comments$/;

const mapComment = (c) => ({
  id: c.id,
  user: { login: c.user?.login || '', avatarUrl: c.user?.avatar_url || '' },
  body: c.body ?? '',
  createdAt: c.created_at,
  updatedAt: c.updated_at,
});

const parsePerPage = (raw) => {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_PER_PAGE;
  return Math.min(n, MAX_PER_PAGE);
};

const parsePage = (raw) => {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return n;
};

const isRateLimited = (r) =>
  r.status === 403 && r.headers.get('x-ratelimit-remaining') === '0';

const rateLimitBody = (r) => {
  const reset = Number.parseInt(r.headers.get('x-ratelimit-reset') || '0', 10);
  const retryAfter = reset > 0
    ? Math.max(0, reset - Math.floor(Date.now() / 1000))
    : 60;
  return { error: 'GitHub rate limit exceeded', retryAfter };
};

export const handler = async (event) => {
  const response = buildResponse(event);

  if (event.httpMethod === 'OPTIONS') return response(200, {});
  if (event.httpMethod !== 'GET') return response(405, { error: 'Method not allowed' });

  const userId = event.requestContext?.authorizer?.claims?.sub;
  if (!userId) return response(401, { error: 'Unauthorized' });

  const path = event.path || '';
  const commentsMatch = path.match(ISSUE_COMMENTS_PATH);
  const detailMatch = !commentsMatch && path.match(ISSUE_DETAIL_PATH);
  const listMatch = !commentsMatch && !detailMatch && path.match(ISSUES_LIST_PATH);

  if (!commentsMatch && !detailMatch && !listMatch) return response(404, { error: 'Not found' });

  let token;
  try {
    const { Item } = await ddb.send(new GetCommand({
      TableName: process.env.GIT_CONNECTIONS_TABLE,
      Key: { userId },
    }));
    if (!Item) return response(400, { error: 'GitHub not connected' });
    token = await resolveGitToken(Item);
  } catch (err) {
    console.error('Token resolution failed:', err.message);
    return response(400, { error: 'GitHub not connected' });
  }

  try {
    if (commentsMatch) {
      const [, owner, repo, number] = commentsMatch;
      const url = `https://api.github.com/repos/${owner}/${repo}/issues/${number}/comments?per_page=100`;
      const cacheKey = `comments:${userId}:${owner}/${repo}#${number}`;
      const cached = cacheGet(cacheKey);
      const r = await githubFetch(url, token, cached?.etag);
      if (r.status === 304 && cached) return response(200, cached.body);
      if (r.status === 404) return response(200, []);
      if (isRateLimited(r)) return response(429, rateLimitBody(r));
      const data = await r.json();
      if (!r.ok) {
        return response(r.status, { error: data.message || 'Failed to fetch comments' });
      }
      const comments = Array.isArray(data) ? data.map(mapComment) : [];
      const newEtag = r.headers.get('etag');
      if (newEtag) cacheSet(cacheKey, { etag: newEtag, body: comments });
      return response(200, comments);
    }

    if (detailMatch) {
      const [, owner, repo, number] = detailMatch;
      const cacheKey = `detail:${userId}:${owner}/${repo}#${number}`;
      const cached = cacheGet(cacheKey);
      const r = await githubFetch(
        `https://api.github.com/repos/${owner}/${repo}/issues/${number}`,
        token,
        cached?.etag,
      );
      if (r.status === 304 && cached) return response(200, cached.body);
      if (isRateLimited(r)) return response(429, rateLimitBody(r));
      const data = await r.json();
      if (!r.ok || data.message) {
        return response(r.ok ? 400 : r.status, { error: data.message || 'Failed to fetch issue' });
      }
      if (data.pull_request) return response(404, { error: 'Not found' });
      const mapped = mapIssue(data);
      const newEtag = r.headers.get('etag');
      if (newEtag) cacheSet(cacheKey, { etag: newEtag, body: mapped });
      return response(200, mapped);
    }

    const [, owner, repo] = listMatch;
    const qs = event.queryStringParameters || {};
    const state = ['open', 'closed', 'all'].includes(qs.state) ? qs.state : 'open';
    const q = (qs.q || '').trim();
    const page = parsePage(qs.page);
    const perPage = parsePerPage(qs.perPage);

    let url;
    let isSearch = false;
    if (q) {
      const searchQ = `repo:${owner}/${repo}+state:${state}+is:issue+${encodeURIComponent(q)}`;
      url = `https://api.github.com/search/issues?q=${searchQ}&per_page=${perPage}&page=${page}`;
      isSearch = true;
    } else {
      url = `https://api.github.com/repos/${owner}/${repo}/issues?per_page=${perPage}&page=${page}&state=${state}`;
    }

    const cacheKey = `list:${userId}:${url}`;
    const cached = cacheGet(cacheKey);
    const r = await githubFetch(url, token, cached?.etag);

    if (r.status === 304 && cached) return response(200, cached.body);
    if (r.status === 404) {
      return response(200, { items: [], page, perPage, hasNext: false, hasPrev: false, totalCount: null });
    }
    if (isRateLimited(r)) return response(429, rateLimitBody(r));

    const data = await r.json();
    if (!r.ok) {
      return response(r.status, { error: data.message || 'Failed to fetch issues' });
    }

    const rawItems = isSearch ? (Array.isArray(data.items) ? data.items : []) : (Array.isArray(data) ? data : []);
    const items = rawItems.filter(i => !i.pull_request).map(mapIssue);

    const link = parseLinkHeader(r.headers.get('link'));
    const hasNext = Boolean(link.next);
    const hasPrev = Boolean(link.prev);
    const totalCount = isSearch && Number.isFinite(data.total_count) ? data.total_count : null;

    const body = { items, page, perPage, hasNext, hasPrev, totalCount };
    const newEtag = r.headers.get('etag');
    if (newEtag) cacheSet(cacheKey, { etag: newEtag, body });
    return response(200, body);
  } catch (err) {
    console.error('Error:', err);
    return response(500, { error: 'Internal server error' });
  }
};
