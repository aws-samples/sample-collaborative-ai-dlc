import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { SSMClient, PutParameterCommand, DeleteParameterCommand } from '@aws-sdk/client-ssm';
import { buildResponse } from '../shared/response.js';
import {
  getOAuthCredentials,
  createSignedState,
  verifySignedState,
  resolveGitTokenFull,
  getUserId,
} from '../shared/git-oauth.js';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const secrets = new SecretsManagerClient({});
const ssm = new SSMClient({});

const mapNote = (n) => ({
  id: n.id,
  type: 'issue',
  body: n.body,
  user: { login: n.author?.username, avatarUrl: n.author?.avatar_url },
  path: null,
  line: null,
  createdAt: n.created_at,
  updatedAt: n.updated_at,
});

// Refresh an expired GitLab access token using the stored refresh token.
// Returns the new access token and persists updated tokens in SSM + DynamoDB.
const refreshAccessToken = async (item, credentials) => {
  const { refreshToken } = await resolveGitTokenFull(ssm, item);
  if (!refreshToken) {
    throw new Error('No refresh token available');
  }

  const { client_id, client_secret } = credentials;
  const tokenRes = await fetch('https://gitlab.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id,
      client_secret,
    }),
  });
  const tokenData = await tokenRes.json();

  if (tokenData.error) {
    throw new Error(tokenData.error_description || tokenData.error);
  }

  // Persist updated tokens
  await ssm.send(
    new PutParameterCommand({
      Name: item.parameterName,
      Value: JSON.stringify({
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token,
        tokenType: tokenData.token_type,
      }),
      Type: 'SecureString',
      Overwrite: true,
    }),
  );

  // Update DynamoDB scope/timestamp
  await ddb.send(
    new PutCommand({
      TableName: process.env.GIT_CONNECTIONS_TABLE,
      Item: {
        ...item,
        scope: tokenData.scope,
        updatedAt: new Date().toISOString(),
      },
    }),
  );

  return tokenData.access_token;
};

// Make a GitLab API call with automatic token refresh on 401.
const gitlabFetch = async (url, options, item) => {
  const res = await fetch(url, options);
  if (res.status === 401 && item) {
    // Attempt token refresh
    try {
      const credentials = await getOAuthCredentials(
        secrets,
        process.env.GITLAB_OAUTH_SECRET_NAME,
        'GitLab',
      );
      const newToken = await refreshAccessToken(item, credentials);
      const retryOptions = {
        ...options,
        headers: { ...options.headers, Authorization: `Bearer ${newToken}` },
      };
      return fetch(url, retryOptions);
    } catch {
      // If refresh fails, return original 401 response
      return res;
    }
  }
  return res;
};

export const handler = async (event) => {
  const response = buildResponse(event, { methods: 'GET,POST,DELETE,OPTIONS' });
  const {
    gitToken: _gitToken,
    code: _code,
    state: _state,
    accessToken: _accessToken,
    ...safeEvent
  } = event;
  console.log('Request:', JSON.stringify({ ...safeEvent, body: '[REDACTED]' }));

  if (event.httpMethod === 'OPTIONS') {
    return response(200, {});
  }

  const { httpMethod, path, queryStringParameters, body } = event;
  const userId = getUserId(event);

  try {
    // GET /gitlab/auth - Return OAuth URL
    if (httpMethod === 'GET' && path.endsWith('/auth')) {
      const { client_id, client_secret } = await getOAuthCredentials(
        secrets,
        process.env.GITLAB_OAUTH_SECRET_NAME,
        'GitLab',
      );
      const redirectUri = process.env.GITLAB_REDIRECT_URI;
      const scope = 'api read_user';
      const state = createSignedState({ userId, ts: Date.now() }, client_secret);

      const url = `https://gitlab.com/oauth/authorize?client_id=${client_id}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${encodeURIComponent(scope)}&state=${encodeURIComponent(state)}`;
      return response(200, { url });
    }

    // GET /gitlab/callback - Exchange code for token
    if (httpMethod === 'GET' && path.endsWith('/callback')) {
      const { code, state } = queryStringParameters || {};
      if (!code) return response(400, { error: 'Missing code parameter' });
      if (!state) return response(400, { error: 'Missing state parameter' });

      const { client_id, client_secret } = await getOAuthCredentials(
        secrets,
        process.env.GITLAB_OAUTH_SECRET_NAME,
        'GitLab',
      );

      // Verify HMAC signature on state to prevent CSRF/forgery
      const statePayload = verifySignedState(decodeURIComponent(state), client_secret);
      if (!statePayload || !statePayload.userId) {
        return response(400, { error: 'Invalid or tampered state parameter' });
      }

      // Reject state tokens older than 10 minutes
      if (Date.now() - statePayload.ts > 10 * 60 * 1000) {
        return response(400, { error: 'OAuth state expired, please try again' });
      }

      const tokenRes = await fetch('https://gitlab.com/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id,
          client_secret,
          code,
          redirect_uri: process.env.GITLAB_REDIRECT_URI,
        }),
      });
      const tokenData = await tokenRes.json();

      if (tokenData.error) {
        return response(400, { error: tokenData.error_description || tokenData.error });
      }

      // Store token in SSM SecureString (encrypted at rest with KMS)
      // GitLab returns a refresh token — store it alongside the access token
      const parameterName = `/${process.env.GIT_TOKEN_SSM_PREFIX}/${statePayload.userId}`;
      await ssm.send(
        new PutParameterCommand({
          Name: parameterName,
          Value: JSON.stringify({
            accessToken: tokenData.access_token,
            refreshToken: tokenData.refresh_token,
            tokenType: tokenData.token_type,
          }),
          Type: 'SecureString',
          Overwrite: true,
        }),
      );

      // Store metadata + SSM reference in DynamoDB (no plaintext token)
      await ddb.send(
        new PutCommand({
          TableName: process.env.GIT_CONNECTIONS_TABLE,
          Item: {
            userId: statePayload.userId,
            provider: 'gitlab',
            parameterName,
            scope: tokenData.scope,
            createdAt: new Date().toISOString(),
          },
        }),
      );

      return response(200, { success: true });
    }

    // GET /gitlab/status - Check if user has connected
    if (httpMethod === 'GET' && path.endsWith('/status')) {
      if (!userId) return response(401, { error: 'Unauthorized' });

      const { Item } = await ddb.send(
        new GetCommand({
          TableName: process.env.GIT_CONNECTIONS_TABLE,
          Key: { userId },
        }),
      );

      return response(200, { connected: !!Item, provider: Item?.provider });
    }

    // GET /gitlab/repos - List user's projects
    if (httpMethod === 'GET' && path.endsWith('/repos')) {
      if (!userId) return response(401, { error: 'Unauthorized' });

      const { Item } = await ddb.send(
        new GetCommand({
          TableName: process.env.GIT_CONNECTIONS_TABLE,
          Key: { userId },
        }),
      );

      if (!Item) return response(400, { error: 'GitLab not connected' });
      const { accessToken: token } = await resolveGitTokenFull(ssm, Item);

      const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
      const reposRes = await gitlabFetch(
        'https://gitlab.com/api/v4/projects?membership=true&min_access_level=30&per_page=100&order_by=last_activity_at',
        { headers },
        Item,
      );
      const repos = await reposRes.json();

      if (!Array.isArray(repos)) {
        return response(400, { error: repos.message || repos.error || 'Failed to fetch projects' });
      }

      return response(
        200,
        repos.map((r) => ({
          id: r.id,
          name: r.name,
          fullName: r.path_with_namespace,
          private: r.visibility !== 'public',
          defaultBranch: r.default_branch,
        })),
      );
    }

    // DELETE /gitlab/disconnect - Remove connection
    if (httpMethod === 'DELETE' && path.endsWith('/disconnect')) {
      if (!userId) return response(401, { error: 'Unauthorized' });

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

    // GET /gitlab/projects/{id}/branches - List branches
    if (httpMethod === 'GET' && path.match(/\/projects\/[^/]+\/branches$/)) {
      if (!userId) return response(401, { error: 'Unauthorized' });

      const { Item } = await ddb.send(
        new GetCommand({
          TableName: process.env.GIT_CONNECTIONS_TABLE,
          Key: { userId },
        }),
      );

      if (!Item) return response(400, { error: 'GitLab not connected' });
      const { accessToken: token } = await resolveGitTokenFull(ssm, Item);

      const pathMatch = path.match(/\/projects\/([^/]+)\/branches$/);
      if (!pathMatch) return response(400, { error: 'Invalid path' });

      const [, projectId] = pathMatch;

      const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
      const branchRes = await gitlabFetch(
        `https://gitlab.com/api/v4/projects/${encodeURIComponent(projectId)}/repository/branches?per_page=100`,
        { headers },
        Item,
      );

      if (branchRes.status === 404) {
        return response(200, { branches: [] });
      }

      const branchData = await branchRes.json();

      if (!Array.isArray(branchData)) {
        return response(400, { error: branchData.message || 'Failed to fetch branches' });
      }

      return response(200, { branches: branchData.map((b) => b.name) });
    }

    // GET /gitlab/projects/{id}/tree - Get repository file tree
    if (httpMethod === 'GET' && path.includes('/tree')) {
      if (!userId) return response(401, { error: 'Unauthorized' });

      const { Item } = await ddb.send(
        new GetCommand({
          TableName: process.env.GIT_CONNECTIONS_TABLE,
          Key: { userId },
        }),
      );

      if (!Item) return response(400, { error: 'GitLab not connected' });
      const { accessToken: token } = await resolveGitTokenFull(ssm, Item);

      const pathMatch = path.match(/\/projects\/([^/]+)\/tree/);
      if (!pathMatch) return response(400, { error: 'Invalid path' });

      const [, projectId] = pathMatch;
      const branch = queryStringParameters?.branch || 'main';

      const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
      const treeRes = await gitlabFetch(
        `https://gitlab.com/api/v4/projects/${encodeURIComponent(projectId)}/repository/tree?ref=${encodeURIComponent(branch)}&recursive=true&per_page=100`,
        { headers },
        Item,
      );
      const treeData = await treeRes.json();

      if (treeData.message || treeData.error) {
        return response(400, { error: treeData.message || treeData.error });
      }

      if (!Array.isArray(treeData)) {
        return response(400, { error: 'Failed to fetch tree' });
      }

      return response(200, {
        tree: treeData
          .filter((item) => item.type === 'blob')
          .map((item) => ({
            path: item.path,
            sha: item.id,
            size: 0, // GitLab tree endpoint does not return file sizes
          })),
      });
    }

    // GET /gitlab/projects/{id}/contents - Get file contents
    if (httpMethod === 'GET' && path.includes('/contents')) {
      if (!userId) return response(401, { error: 'Unauthorized' });

      const { Item } = await ddb.send(
        new GetCommand({
          TableName: process.env.GIT_CONNECTIONS_TABLE,
          Key: { userId },
        }),
      );

      if (!Item) return response(400, { error: 'GitLab not connected' });
      const { accessToken: token } = await resolveGitTokenFull(ssm, Item);

      const pathMatch = path.match(/\/projects\/([^/]+)\/contents/);
      if (!pathMatch) return response(400, { error: 'Invalid path' });

      const [, projectId] = pathMatch;
      const filePath = queryStringParameters?.path;
      const branch = queryStringParameters?.branch || 'main';

      if (!filePath) return response(400, { error: 'Missing path parameter' });

      const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
      const contentRes = await gitlabFetch(
        `https://gitlab.com/api/v4/projects/${encodeURIComponent(projectId)}/repository/files/${encodeURIComponent(filePath)}?ref=${encodeURIComponent(branch)}`,
        { headers },
        Item,
      );
      const contentData = await contentRes.json();

      if (contentData.message || contentData.error) {
        return response(400, { error: contentData.message || contentData.error });
      }

      // Decode base64 content
      const content = Buffer.from(contentData.content, 'base64').toString('utf-8');

      return response(200, {
        path: contentData.file_path,
        sha: contentData.blob_id,
        size: contentData.size,
        content,
      });
    }

    // GET /gitlab/projects/{id}/merge_requests/{iid}/notes - List MR notes
    if (httpMethod === 'GET' && path.includes('/merge_requests/') && path.endsWith('/notes')) {
      if (!userId) return response(401, { error: 'Unauthorized' });

      const { Item } = await ddb.send(
        new GetCommand({
          TableName: process.env.GIT_CONNECTIONS_TABLE,
          Key: { userId },
        }),
      );

      if (!Item) return response(400, { error: 'GitLab not connected' });
      const { accessToken: token } = await resolveGitTokenFull(ssm, Item);

      const mrMatch = path.match(/\/projects\/([^/]+)\/merge_requests\/(\d+)\/notes/);
      if (!mrMatch) return response(400, { error: 'Invalid path' });

      const [, projectId, mrIid] = mrMatch;

      const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
      // Fetch MR notes (general comments) and discussions (inline comments)
      const [notesRes, discussionsRes] = await Promise.all([
        gitlabFetch(
          `https://gitlab.com/api/v4/projects/${encodeURIComponent(projectId)}/merge_requests/${mrIid}/notes?per_page=100`,
          { headers },
          Item,
        ),
        gitlabFetch(
          `https://gitlab.com/api/v4/projects/${encodeURIComponent(projectId)}/merge_requests/${mrIid}/discussions?per_page=100`,
          { headers },
          Item,
        ),
      ]);

      const notes = await notesRes.json();
      const discussions = await discussionsRes.json();

      // Extract inline discussion notes (those with position data)
      const inlineComments = [];
      if (Array.isArray(discussions)) {
        for (const discussion of discussions) {
          if (!Array.isArray(discussion.notes)) continue;
          for (const note of discussion.notes) {
            if (note.position) {
              inlineComments.push({
                id: note.id,
                type: 'review',
                body: note.body,
                user: { login: note.author?.username, avatarUrl: note.author?.avatar_url },
                path: note.position?.new_path || note.position?.old_path || null,
                line: note.position?.new_line || note.position?.old_line || null,
                createdAt: note.created_at,
                updatedAt: note.updated_at,
              });
            }
          }
        }
      }

      // General notes (non-system, non-inline)
      const generalNotes = Array.isArray(notes)
        ? notes.filter((n) => !n.system && !n.position).map(mapNote)
        : [];

      const comments = [...generalNotes, ...inlineComments].toSorted(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      );

      return response(200, { comments });
    }

    // POST /gitlab/projects/{id}/merge_requests/{iid}/notes - Add MR note
    if (httpMethod === 'POST' && path.includes('/merge_requests/') && path.endsWith('/notes')) {
      if (!userId) return response(401, { error: 'Unauthorized' });

      const { Item } = await ddb.send(
        new GetCommand({
          TableName: process.env.GIT_CONNECTIONS_TABLE,
          Key: { userId },
        }),
      );

      if (!Item) return response(400, { error: 'GitLab not connected' });
      const { accessToken: token } = await resolveGitTokenFull(ssm, Item);

      const mrMatch = path.match(/\/projects\/([^/]+)\/merge_requests\/(\d+)\/notes/);
      if (!mrMatch) return response(400, { error: 'Invalid path' });

      const [, projectId, mrIid] = mrMatch;
      const data = JSON.parse(body || '{}');

      if (!data.body) return response(400, { error: 'Comment body is required' });

      const headers = {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      };

      let result;
      if (data.path && data.line) {
        // Create a discussion with position (inline comment on a specific file/line)
        const mrRes = await gitlabFetch(
          `https://gitlab.com/api/v4/projects/${encodeURIComponent(projectId)}/merge_requests/${mrIid}`,
          { headers },
          Item,
        );
        const mrData = await mrRes.json();
        const headSha = mrData.diff_refs?.head_sha;
        const baseSha = mrData.diff_refs?.base_sha;
        const startSha = mrData.diff_refs?.start_sha;

        if (!headSha) return response(400, { error: 'Could not determine commit SHA' });

        const discussionRes = await gitlabFetch(
          `https://gitlab.com/api/v4/projects/${encodeURIComponent(projectId)}/merge_requests/${mrIid}/discussions`,
          {
            method: 'POST',
            headers,
            body: JSON.stringify({
              body: data.body,
              position: {
                position_type: 'text',
                base_sha: baseSha,
                head_sha: headSha,
                start_sha: startSha,
                new_path: data.path,
                new_line: data.line,
              },
            }),
          },
          Item,
        );
        result = await discussionRes.json();
        // Extract the first note from the discussion
        if (result.notes && result.notes.length > 0) {
          result = result.notes[0];
        }
      } else {
        // General MR note
        const noteRes = await gitlabFetch(
          `https://gitlab.com/api/v4/projects/${encodeURIComponent(projectId)}/merge_requests/${mrIid}/notes`,
          {
            method: 'POST',
            headers,
            body: JSON.stringify({ body: data.body }),
          },
          Item,
        );
        result = await noteRes.json();
      }

      if (result.message || result.error) {
        return response(400, { error: result.message || result.error });
      }

      return response(201, {
        id: result.id,
        body: result.body,
        user: { login: result.author?.username, avatarUrl: result.author?.avatar_url },
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
