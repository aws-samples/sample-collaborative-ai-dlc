const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand } = require('@aws-sdk/lib-dynamodb');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
const { SSMClient, PutParameterCommand, DeleteParameterCommand } = require('@aws-sdk/client-ssm');
const crypto = require('crypto');
const { buildResponse } = require('./shared/response');
const { resolveGitToken } = require('./shared/git-token');

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const secrets = new SecretsManagerClient({});
const ssm = new SSMClient({});

const OAUTH_NOT_CONFIGURED = 'GitHub OAuth is not configured on this environment. See README §4 for setup instructions.';

const oauthNotConfiguredError = () => {
  const err = new Error(OAUTH_NOT_CONFIGURED);
  err.statusCode = 503;
  err.errorCode = 'OAUTH_NOT_CONFIGURED';
  return err;
};

const getOAuthCredentials = async () => {
  let result;
  try {
    result = await secrets.send(new GetSecretValueCommand({
      SecretId: process.env.GITHUB_OAUTH_SECRET_NAME
    }));
  } catch (e) {
    if (e.name === 'ResourceNotFoundException') {
      throw oauthNotConfiguredError();
    }
    throw e;
  }
  if (!result.SecretString) {
    throw oauthNotConfiguredError();
  }
  let parsed;
  try {
    parsed = JSON.parse(result.SecretString);
  } catch {
    throw oauthNotConfiguredError();
  }
  const { client_id, client_secret } = parsed || {};
  if (typeof client_id !== 'string' || !client_id || typeof client_secret !== 'string' || !client_secret) {
    throw oauthNotConfiguredError();
  }
  return { client_id, client_secret };
};

// Create HMAC-signed state parameter to prevent CSRF/forgery attacks on OAuth callback
const createSignedState = (payload, secret) => {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64');
  const hmac = crypto.createHmac('sha256', secret).update(data).digest('hex');
  return `${data}.${hmac}`;
};

// Verify and decode HMAC-signed state parameter
const verifySignedState = (state, secret) => {
  const parts = state.split('.');
  if (parts.length !== 2) return null;
  const [data, signature] = parts;
  const expectedSignature = crypto.createHmac('sha256', secret).update(data).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expectedSignature, 'hex'))) {
    return null;
  }
  return JSON.parse(Buffer.from(data, 'base64').toString());
};

const getUserId = (event) => {
  return event.requestContext?.authorizer?.claims?.sub;
};

exports.handler = async (event) => {
  const response = buildResponse(event, { methods: 'GET,POST,DELETE,OPTIONS' });
  const { gitToken, code, state, accessToken, ...safeEvent } = event;
  console.log('Request:', JSON.stringify({ ...safeEvent, body: '[REDACTED]' }));

  if (event.httpMethod === 'OPTIONS') {
    return response(200, {});
  }

  const { httpMethod, path, queryStringParameters, body } = event;
  const userId = getUserId(event);

  try {
    // GET /github/auth - Return OAuth URL
    if (httpMethod === 'GET' && path.endsWith('/auth')) {
      const { client_id, client_secret } = await getOAuthCredentials();
      const redirectUri = process.env.GITHUB_REDIRECT_URI;
      const scope = 'repo read:user';
      const state = createSignedState({ userId, ts: Date.now() }, client_secret);
      
      const url = `https://github.com/login/oauth/authorize?client_id=${client_id}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scope)}&state=${encodeURIComponent(state)}`;
      return response(200, { url });
    }

    // GET /github/callback - Exchange code for token
    if (httpMethod === 'GET' && path.endsWith('/callback')) {
      const { code, state } = queryStringParameters || {};
      if (!code) return response(400, { error: 'Missing code parameter' });
      if (!state) return response(400, { error: 'Missing state parameter' });

      const { client_id, client_secret } = await getOAuthCredentials();
      
      // Verify HMAC signature on state to prevent CSRF/forgery
      const statePayload = verifySignedState(decodeURIComponent(state), client_secret);
      if (!statePayload || !statePayload.userId) {
        return response(400, { error: 'Invalid or tampered state parameter' });
      }
      
      // Reject state tokens older than 10 minutes
      if (Date.now() - statePayload.ts > 10 * 60 * 1000) {
        return response(400, { error: 'OAuth state expired, please try again' });
      }

      const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id, client_secret, code })
      });
      const tokenData = await tokenRes.json();

      if (tokenData.error) {
        return response(400, { error: tokenData.error_description || tokenData.error });
      }

      // Store token in SSM SecureString (encrypted at rest with KMS)
      const parameterName = `/${process.env.GIT_TOKEN_SSM_PREFIX}/${statePayload.userId}`;
      await ssm.send(new PutParameterCommand({
        Name: parameterName,
        Value: JSON.stringify({ accessToken: tokenData.access_token, tokenType: tokenData.token_type }),
        Type: 'SecureString',
        Overwrite: true,
      }));

      // Store metadata + SSM reference in DynamoDB (no plaintext token)
      await ddb.send(new PutCommand({
        TableName: process.env.GIT_CONNECTIONS_TABLE,
        Item: {
          userId: statePayload.userId,
          provider: 'github',
          parameterName,
          scope: tokenData.scope,
          createdAt: new Date().toISOString(),
        },
      }));

      return response(200, { success: true });
    }

    // GET /github/status - Check if user has connected
    if (httpMethod === 'GET' && path.endsWith('/status')) {
      if (!userId) return response(401, { error: 'Unauthorized' });

      const { Item } = await ddb.send(new GetCommand({
        TableName: process.env.GIT_CONNECTIONS_TABLE,
        Key: { userId }
      }));

      return response(200, { connected: !!Item, provider: Item?.provider });
    }

    // GET /github/repos - List user's repositories
    if (httpMethod === 'GET' && path.endsWith('/repos')) {
      if (!userId) return response(401, { error: 'Unauthorized' });

      const { Item } = await ddb.send(new GetCommand({
        TableName: process.env.GIT_CONNECTIONS_TABLE,
        Key: { userId }
      }));

      if (!Item) return response(400, { error: 'GitHub not connected' });
      const token = await resolveGitToken(ssm, Item);

      const reposRes = await fetch('https://api.github.com/user/repos?per_page=100&sort=updated', {
        headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github+json' }
      });
      const repos = await reposRes.json();

      if (!Array.isArray(repos)) {
        return response(400, { error: repos.message || 'Failed to fetch repos' });
      }

      return response(200, repos.map(r => ({
        id: r.id,
        name: r.name,
        fullName: r.full_name,
        private: r.private,
        defaultBranch: r.default_branch
      })));
    }

    // DELETE /github/disconnect - Remove connection
    if (httpMethod === 'DELETE' && path.endsWith('/disconnect')) {
      if (!userId) return response(401, { error: 'Unauthorized' });

      const { Item } = await ddb.send(new GetCommand({
        TableName: process.env.GIT_CONNECTIONS_TABLE,
        Key: { userId },
      }));

      if (Item?.parameterName) {
        try {
          await ssm.send(new DeleteParameterCommand({ Name: Item.parameterName }));
        } catch (e) {
          console.error('Failed to delete git token parameter:', e.message);
        }
      }

      await ddb.send(new DeleteCommand({
        TableName: process.env.GIT_CONNECTIONS_TABLE,
        Key: { userId },
      }));

      return response(200, { success: true });
    }

    // GET /github/repos/{owner}/{repo}/branches - List branches
    if (httpMethod === 'GET' && path.match(/\/repos\/[^/]+\/[^/]+\/branches$/)) {
      if (!userId) return response(401, { error: 'Unauthorized' });

      const { Item } = await ddb.send(new GetCommand({
        TableName: process.env.GIT_CONNECTIONS_TABLE,
        Key: { userId }
      }));

      if (!Item) return response(400, { error: 'GitHub not connected' });
      const token = await resolveGitToken(ssm, Item);

      const pathMatch = path.match(/\/repos\/([^/]+)\/([^/]+)\/branches$/);
      if (!pathMatch) return response(400, { error: 'Invalid path' });

      const [, owner, repo] = pathMatch;

      const branchRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/branches?per_page=100`, {
        headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github+json' }
      });

      if (branchRes.status === 404) {
        return response(200, { branches: [] });
      }

      const branchData = await branchRes.json();

      if (!Array.isArray(branchData)) {
        return response(400, { error: branchData.message || 'Failed to fetch branches' });
      }

      return response(200, { branches: branchData.map(b => b.name) });
    }

    // GET /github/repos/{owner}/{repo}/tree - Get repository file tree
    if (httpMethod === 'GET' && path.includes('/tree')) {
      if (!userId) return response(401, { error: 'Unauthorized' });

      const { Item } = await ddb.send(new GetCommand({
        TableName: process.env.GIT_CONNECTIONS_TABLE,
        Key: { userId }
      }));

      if (!Item) return response(400, { error: 'GitHub not connected' });
      const token = await resolveGitToken(ssm, Item);

      const pathMatch = path.match(/\/repos\/([^/]+)\/([^/]+)\/tree/);
      if (!pathMatch) return response(400, { error: 'Invalid path' });

      const [, owner, repo] = pathMatch;
      const branch = queryStringParameters?.branch || 'main';

      const treeRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`, {
        headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github+json' }
      });
      const treeData = await treeRes.json();

      if (treeData.message) {
        return response(400, { error: treeData.message });
      }

      return response(200, {
        tree: treeData.tree.filter(item => item.type === 'blob').map(item => ({
          path: item.path,
          sha: item.sha,
          size: item.size
        }))
      });
    }

    // GET /github/repos/{owner}/{repo}/contents - Get file contents
    if (httpMethod === 'GET' && path.includes('/contents')) {
      if (!userId) return response(401, { error: 'Unauthorized' });

      const { Item } = await ddb.send(new GetCommand({
        TableName: process.env.GIT_CONNECTIONS_TABLE,
        Key: { userId }
      }));

      if (!Item) return response(400, { error: 'GitHub not connected' });
      const token = await resolveGitToken(ssm, Item);

      const pathMatch = path.match(/\/repos\/([^/]+)\/([^/]+)\/contents/);
      if (!pathMatch) return response(400, { error: 'Invalid path' });

      const [, owner, repo] = pathMatch;
      const filePath = queryStringParameters?.path;
      const branch = queryStringParameters?.branch || 'main';

      if (!filePath) return response(400, { error: 'Missing path parameter' });

      const contentRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${filePath}?ref=${branch}`, {
        headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github+json' }
      });
      const contentData = await contentRes.json();

      if (contentData.message) {
        return response(400, { error: contentData.message });
      }

      // Decode base64 content
      const content = Buffer.from(contentData.content, 'base64').toString('utf-8');

      return response(200, {
        path: contentData.path,
        sha: contentData.sha,
        size: contentData.size,
        content
      });
    }

    // GET /github/repos/{owner}/{repo}/pulls/{prNumber}/comments - List PR comments
    if (httpMethod === 'GET' && path.includes('/pulls/') && path.endsWith('/comments')) {
      if (!userId) return response(401, { error: 'Unauthorized' });

      const { Item } = await ddb.send(new GetCommand({
        TableName: process.env.GIT_CONNECTIONS_TABLE,
        Key: { userId }
      }));

      if (!Item) return response(400, { error: 'GitHub not connected' });
      const token = await resolveGitToken(ssm, Item);

      const prMatch = path.match(/\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/comments/);
      if (!prMatch) return response(400, { error: 'Invalid path' });

      const [, owner, repo, prNumber] = prMatch;

      // Fetch both review comments and issue comments
      const [reviewCommentsRes, issueCommentsRes] = await Promise.all([
        fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/comments`, {
          headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github+json' }
        }),
        fetch(`https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments`, {
          headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github+json' }
        }),
      ]);

      const reviewComments = await reviewCommentsRes.json();
      const issueComments = await issueCommentsRes.json();

      const mapComment = (c, type) => ({
        id: c.id,
        type,
        body: c.body,
        user: { login: c.user?.login, avatarUrl: c.user?.avatar_url },
        path: c.path || null,
        line: c.line || c.original_line || null,
        createdAt: c.created_at,
        updatedAt: c.updated_at,
      });

      const comments = [
        ...(Array.isArray(reviewComments) ? reviewComments.map(c => mapComment(c, 'review')) : []),
        ...(Array.isArray(issueComments) ? issueComments.map(c => mapComment(c, 'issue')) : []),
      ].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

      return response(200, { comments });
    }

    // POST /github/repos/{owner}/{repo}/pulls/{prNumber}/comments - Add PR comment
    if (httpMethod === 'POST' && path.includes('/pulls/') && path.endsWith('/comments')) {
      if (!userId) return response(401, { error: 'Unauthorized' });

      const { Item } = await ddb.send(new GetCommand({
        TableName: process.env.GIT_CONNECTIONS_TABLE,
        Key: { userId }
      }));

      if (!Item) return response(400, { error: 'GitHub not connected' });
      const token = await resolveGitToken(ssm, Item);

      const prMatch = path.match(/\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/comments/);
      if (!prMatch) return response(400, { error: 'Invalid path' });

      const [, owner, repo, prNumber] = prMatch;
      const data = JSON.parse(body || '{}');

      if (!data.body) return response(400, { error: 'Comment body is required' });

      let result;
      if (data.path && data.line) {
        // Review comment (on a specific file/line)
        // First we need the latest commit SHA
        const prRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`, {
          headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github+json' }
        });
        const prData = await prRes.json();
        const commitId = prData.head?.sha;

        if (!commitId) return response(400, { error: 'Could not determine commit SHA' });

        const commentRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/comments`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' },
          body: JSON.stringify({ body: data.body, commit_id: commitId, path: data.path, line: data.line, side: data.side || 'RIGHT' }),
        });
        result = await commentRes.json();
      } else {
        // Issue comment (general PR comment)
        const commentRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' },
          body: JSON.stringify({ body: data.body }),
        });
        result = await commentRes.json();
      }

      if (result.message) return response(400, { error: result.message });

      return response(201, {
        id: result.id,
        body: result.body,
        user: { login: result.user?.login, avatarUrl: result.user?.avatar_url },
        createdAt: result.created_at,
      });
    }

    return response(404, { error: 'Not found' });
  } catch (err) {
    console.error('Error:', err);
    if (err.statusCode) {
      return response(err.statusCode, { error: err.message, code: err.errorCode });
    }
    return response(500, { error: 'Internal server error' });
  }
};
