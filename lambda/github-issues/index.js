import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ssm = new SSMClient({});

const GIT_TOKEN_PARAM_PATTERN = /^\/[\w-]+\/[\w-]+\/[\w-]+\/[\w-]+$/;

const allowedOrigin = (headers) => {
  const origins = (process.env.CORS_ALLOWED_ORIGINS || '*').split(',');
  const reqOrigin = headers?.origin || headers?.Origin;
  return origins.includes(reqOrigin) ? reqOrigin : origins[0];
};

const buildResponse = (event, { methods = 'GET,OPTIONS' } = {}) =>
  (statusCode, body) => ({
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': allowedOrigin(event?.headers),
      'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
      'Access-Control-Allow-Methods': methods,
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

const githubFetch = (url, token) =>
  fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
    },
  });

const ISSUES_LIST_PATH = /\/github\/repos\/([^/]+)\/([^/]+)\/issues$/;
const ISSUE_DETAIL_PATH = /\/github\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/;

export const handler = async (event) => {
  const response = buildResponse(event);

  if (event.httpMethod === 'OPTIONS') return response(200, {});
  if (event.httpMethod !== 'GET') return response(405, { error: 'Method not allowed' });

  const userId = event.requestContext?.authorizer?.claims?.sub;
  if (!userId) return response(401, { error: 'Unauthorized' });

  const path = event.path || '';
  const detailMatch = path.match(ISSUE_DETAIL_PATH);
  const listMatch = !detailMatch && path.match(ISSUES_LIST_PATH);

  if (!detailMatch && !listMatch) return response(404, { error: 'Not found' });

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
    if (detailMatch) {
      const [, owner, repo, number] = detailMatch;
      const r = await githubFetch(
        `https://api.github.com/repos/${owner}/${repo}/issues/${number}`,
        token,
      );
      const data = await r.json();
      if (!r.ok || data.message) {
        return response(r.ok ? 400 : r.status, { error: data.message || 'Failed to fetch issue' });
      }
      if (data.pull_request) return response(404, { error: 'Not found' });
      return response(200, mapIssue(data));
    }

    const [, owner, repo] = listMatch;
    const qs = event.queryStringParameters || {};
    const state = ['open', 'closed', 'all'].includes(qs.state) ? qs.state : 'open';
    const q = (qs.q || '').trim();

    let url;
    let isSearch = false;
    if (q) {
      const searchQ = `repo:${owner}/${repo}+state:${state}+${encodeURIComponent(q)}`;
      url = `https://api.github.com/search/issues?q=${searchQ}&per_page=100`;
      isSearch = true;
    } else {
      url = `https://api.github.com/repos/${owner}/${repo}/issues?per_page=100&state=${state}`;
    }

    const r = await githubFetch(url, token);
    if (r.status === 404) return response(200, []);
    const data = await r.json();
    if (!r.ok) {
      return response(r.status, { error: data.message || 'Failed to fetch issues' });
    }

    const items = isSearch ? (Array.isArray(data.items) ? data.items : []) : (Array.isArray(data) ? data : []);
    const issues = items.filter(i => !i.pull_request).map(mapIssue);
    return response(200, issues);
  } catch (err) {
    console.error('Error:', err);
    return response(500, { error: 'Internal server error' });
  }
};
