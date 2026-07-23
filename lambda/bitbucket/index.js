import { createGitHandler } from '../shared/git-handler.js';
import bitbucketProvider from '../shared/git-providers/bitbucket.js';
import {
  GetSecretValueCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { requirePlatformAdmin } from '../shared/authz.js';
import { getUserId } from '../shared/git-oauth.js';
import { buildResponse } from '../shared/response.js';

const secrets = new SecretsManagerClient({});

// Route-shape descriptors: how to recognise repo-scoped routes and extract the
// repoId ("workspace/repo_slug") from the Bitbucket URL layout. Bitbucket
// addresses repositories by a two-segment "workspace/repo_slug" path — the
// same shape as GitHub's "owner/repo" — so the routes mirror the GitHub
// handler exactly (path segments, not GitLab's ?project= query string). All
// provider-agnostic plumbing lives in shared/git-handler.js.
const routes = {
  branches: (path) => {
    const m = path.match(/\/repos\/([^/]+)\/([^/]+)\/branches$/);
    return m ? `${m[1]}/${m[2]}` : null;
  },
  tree: (path) => {
    if (!path.includes('/tree')) return null;
    const m = path.match(/\/repos\/([^/]+)\/([^/]+)\/tree/);
    return m ? `${m[1]}/${m[2]}` : null;
  },
  contents: (path) => {
    if (!path.includes('/contents')) return null;
    const m = path.match(/\/repos\/([^/]+)\/([^/]+)\/contents/);
    return m ? `${m[1]}/${m[2]}` : null;
  },
  comments: (path) => {
    if (!path.includes('/pulls/') || !path.endsWith('/comments')) return null;
    const m = path.match(/\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/comments/);
    return m ? { repoId: `${m[1]}/${m[2]}`, prRef: m[3] } : null;
  },
};

const gitHandler = createGitHandler(bitbucketProvider, routes);

const isOAuthConfigured = async () => {
  const secretId = process.env.BITBUCKET_OAUTH_SECRET_NAME;
  if (!secretId) return false;
  try {
    const result = await secrets.send(new GetSecretValueCommand({ SecretId: secretId }));
    const credentials = JSON.parse(result.SecretString || '{}');
    return Boolean(credentials.client_id && credentials.client_secret);
  } catch {
    return false;
  }
};

const handleOAuthConfig = async (event) => {
  const response = buildResponse(event, { methods: 'GET,PUT,OPTIONS' });
  if (event.httpMethod === 'OPTIONS') return response(200, {});

  const userId = getUserId(event);
  if (!userId) return response(401, { error: 'Unauthorized' });
  const denied = requirePlatformAdmin(event);
  if (denied) return response(denied.statusCode, { error: denied.error, code: denied.code });

  if (event.httpMethod === 'GET') {
    return response(200, { configured: await isOAuthConfigured() });
  }
  if (event.httpMethod !== 'PUT') return response(404, { error: 'Not found' });

  let data;
  try {
    data = event.body ? JSON.parse(event.body) : {};
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
  const secretId = process.env.BITBUCKET_OAUTH_SECRET_NAME;
  if (!secretId) {
    return response(500, { error: 'BITBUCKET_OAUTH_SECRET_NAME is not configured' });
  }
  try {
    await secrets.send(
      new PutSecretValueCommand({
        SecretId: secretId,
        SecretString: JSON.stringify({ client_id: clientId, client_secret: clientSecret }),
      }),
    );
    return response(200, { success: true });
  } catch (error) {
    console.error('Failed to write Bitbucket OAuth secret:', error);
    return response(500, { error: 'Failed to write OAuth secret' });
  }
};

export const handler = async (event) =>
  event.path?.endsWith('/bitbucket/oauth-config') ? handleOAuthConfig(event) : gitHandler(event);
