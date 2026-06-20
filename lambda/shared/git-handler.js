// Shared API-Gateway handler for the git-provider connection lambdas
// (lambda/github, lambda/gitlab). Both providers expose the same logical routes
// — OAuth connect/callback, status, repo list, disconnect, branches, tree,
// contents, PR/MR comments — differing only in URL shape and the provider's
// REST mapping (already abstracted in shared/git-providers). This factory holds
// the AWS plumbing (DynamoDB connection rows, SSM token storage, Secrets
// Manager OAuth credentials) once; each lambda passes its provider + a small
// route-shape descriptor that says how to extract a repoId from the path.

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { SSMClient, PutParameterCommand, DeleteParameterCommand } from '@aws-sdk/client-ssm';
import { buildResponse } from './response.js';
import {
  getOAuthCredentials,
  createSignedState,
  verifySignedState,
  resolveGitTokenFull,
  getUserId,
} from './git-oauth.js';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const secrets = new SecretsManagerClient({});
const ssm = new SSMClient({});

// Build a handler bound to a single provider.
//
// provider: the shared/git-providers entry (github or gitlab).
// routes: {
//   branches: (path) => repoId | null,       // GET .../branches
//   tree:     (path) => repoId | null,        // GET .../tree
//   contents: (path) => repoId | null,        // GET .../contents
//   comments: (path) => { repoId, prRef } | null, // GET/POST PR/MR comments
// }
export const createGitHandler = (provider, routes) => {
  const providerLabel = provider.displayName;
  const secretName = () => process.env[provider.oauth.secretEnvName];
  const redirectUri = () => process.env[provider.oauth.redirectUriEnvName];

  // Resolve the caller's git-connections row ONLY when it belongs to this
  // provider. The table is keyed by userId alone (one row per user), so a row
  // written by a different provider must not satisfy this provider's routes —
  // otherwise a GitHub connection would make GitLab look connected (and the
  // GitLab endpoints would call GitLab APIs with a GitHub token, or vice
  // versa). Legacy rows predate the `provider` field and are treated as GitHub.
  const getConnection = async (userId) => {
    const { Item } = await ddb.send(
      new GetCommand({ TableName: process.env.GIT_CONNECTIONS_TABLE, Key: { userId } }),
    );
    if (!Item) return null;
    const rowProvider = Item.provider || 'github';
    if (rowProvider !== provider.id) return null;
    return Item;
  };

  // Build a provider ctx that refreshes (and persists) the token on 401 when
  // the provider supports it (GitLab). GitHub's oauth has no refreshAccessToken
  // so onRefresh stays undefined and glFetch/ghFetch behave identically.
  const buildCtx = async (item) => {
    const tokens = await resolveGitTokenFull(ssm, item);
    const ctx = { token: tokens.accessToken };
    if (typeof provider.oauth.refreshAccessToken === 'function') {
      ctx.onRefresh = async () => {
        const creds = await getOAuthCredentials(secrets, secretName(), providerLabel);
        const refreshed = await provider.oauth.refreshAccessToken({
          clientId: creds.client_id,
          clientSecret: creds.client_secret,
          refreshToken: tokens.refreshToken,
        });
        await ssm.send(
          new PutParameterCommand({
            Name: item.parameterName,
            Value: JSON.stringify({
              accessToken: refreshed.accessToken,
              refreshToken: refreshed.refreshToken,
              tokenType: refreshed.tokenType,
              // Record expiry so the construction path (ensureFreshGitToken)
              // can tell whether an API-refreshed token is still valid.
              ...(refreshed.expiresIn
                ? { expiresAt: Date.now() + Number(refreshed.expiresIn) * 1000 }
                : {}),
            }),
            Type: 'SecureString',
            Overwrite: true,
          }),
        );
        await ddb.send(
          new PutCommand({
            TableName: process.env.GIT_CONNECTIONS_TABLE,
            Item: { ...item, scope: refreshed.scope, updatedAt: new Date().toISOString() },
          }),
        );
        return refreshed.accessToken;
      };
    }
    return ctx;
  };

  return async (event) => {
    const response = buildResponse(event, { methods: 'GET,POST,DELETE,OPTIONS' });
    const {
      gitToken: _gitToken,
      code: _code,
      state: _state,
      accessToken: _accessToken,
      ...safeEvent
    } = event;
    console.log('Request:', JSON.stringify({ ...safeEvent, body: '[REDACTED]' }));

    if (event.httpMethod === 'OPTIONS') return response(200, {});

    const { httpMethod, path, queryStringParameters, body } = event;
    const userId = getUserId(event);

    try {
      // GET /{provider}/auth — return OAuth URL
      if (httpMethod === 'GET' && path.endsWith('/auth')) {
        const { client_id, client_secret } = await getOAuthCredentials(
          secrets,
          secretName(),
          providerLabel,
        );
        const state = createSignedState({ userId, ts: Date.now() }, client_secret);
        const url = provider.oauth.buildAuthorizeUrl({
          clientId: client_id,
          redirectUri: redirectUri(),
          state,
        });
        return response(200, { url });
      }

      // GET /{provider}/callback — exchange code for token
      if (httpMethod === 'GET' && path.endsWith('/callback')) {
        const { code, state } = queryStringParameters || {};
        if (!code) return response(400, { error: 'Missing code parameter' });
        if (!state) return response(400, { error: 'Missing state parameter' });

        const { client_id, client_secret } = await getOAuthCredentials(
          secrets,
          secretName(),
          providerLabel,
        );
        const statePayload = verifySignedState(decodeURIComponent(state), client_secret);
        if (!statePayload || !statePayload.userId) {
          return response(400, { error: 'Invalid or tampered state parameter' });
        }
        if (Date.now() - statePayload.ts > 10 * 60 * 1000) {
          return response(400, { error: 'OAuth state expired, please try again' });
        }

        const tokens = await provider.oauth.exchangeCode({
          clientId: client_id,
          clientSecret: client_secret,
          code,
          redirectUri: redirectUri(),
        });

        const parameterName = `/${process.env.GIT_TOKEN_SSM_PREFIX}/${statePayload.userId}`;
        // GitLab stores a refresh token (+ expiry so the construction path can
        // refresh just-in-time); GitHub does not. Match each provider's
        // historical SSM value shape (key order matters for existing assertions).
        const ssmValue = tokens.refreshToken
          ? {
              accessToken: tokens.accessToken,
              refreshToken: tokens.refreshToken,
              tokenType: tokens.tokenType,
              ...(tokens.expiresIn
                ? { expiresAt: Date.now() + Number(tokens.expiresIn) * 1000 }
                : {}),
            }
          : { accessToken: tokens.accessToken, tokenType: tokens.tokenType };
        await ssm.send(
          new PutParameterCommand({
            Name: parameterName,
            Value: JSON.stringify(ssmValue),
            Type: 'SecureString',
            Overwrite: true,
          }),
        );
        await ddb.send(
          new PutCommand({
            TableName: process.env.GIT_CONNECTIONS_TABLE,
            Item: {
              userId: statePayload.userId,
              provider: provider.id,
              parameterName,
              scope: tokens.scope,
              createdAt: new Date().toISOString(),
            },
          }),
        );
        return response(200, { success: true });
      }

      // GET /{provider}/status
      if (httpMethod === 'GET' && path.endsWith('/status')) {
        if (!userId) return response(401, { error: 'Unauthorized' });
        const Item = await getConnection(userId);
        return response(200, { connected: !!Item, provider: Item?.provider });
      }

      // GET /{provider}/repos
      if (httpMethod === 'GET' && path.endsWith('/repos')) {
        if (!userId) return response(401, { error: 'Unauthorized' });
        const Item = await getConnection(userId);
        if (!Item) return response(400, { error: `${providerLabel} not connected` });
        const ctx = await buildCtx(Item);
        const repos = await provider.listRepos(ctx);
        return response(200, repos);
      }

      // DELETE /{provider}/disconnect
      if (httpMethod === 'DELETE' && path.endsWith('/disconnect')) {
        if (!userId) return response(401, { error: 'Unauthorized' });
        const Item = await getConnection(userId);
        // Only remove the connection when it belongs to this provider — never
        // delete another provider's row (getConnection already scopes by
        // provider, so a null Item means "nothing of ours to disconnect").
        if (!Item) return response(200, { success: true });
        if (Item.parameterName) {
          try {
            await ssm.send(new DeleteParameterCommand({ Name: Item.parameterName }));
          } catch (e) {
            console.error('Failed to delete git token parameter:', e.message);
          }
        }
        await ddb.send(
          new DeleteCommand({ TableName: process.env.GIT_CONNECTIONS_TABLE, Key: { userId } }),
        );
        return response(200, { success: true });
      }

      // GET .../branches
      const branchRepo = routes.branches?.(path, queryStringParameters);
      if (httpMethod === 'GET' && branchRepo) {
        if (!userId) return response(401, { error: 'Unauthorized' });
        const Item = await getConnection(userId);
        if (!Item) return response(400, { error: `${providerLabel} not connected` });
        const ctx = await buildCtx(Item);
        const branches = await provider.listBranches(ctx, branchRepo);
        return response(200, { branches });
      }

      // GET .../tree
      const treeRepo = routes.tree?.(path, queryStringParameters);
      if (httpMethod === 'GET' && treeRepo) {
        if (!userId) return response(401, { error: 'Unauthorized' });
        const Item = await getConnection(userId);
        if (!Item) return response(400, { error: `${providerLabel} not connected` });
        const ctx = await buildCtx(Item);
        const branch = queryStringParameters?.branch || 'main';
        const tree = await provider.getTree(ctx, treeRepo, branch);
        return response(200, { tree });
      }

      // GET .../contents
      const contentsRepo = routes.contents?.(path, queryStringParameters);
      if (httpMethod === 'GET' && contentsRepo) {
        if (!userId) return response(401, { error: 'Unauthorized' });
        const Item = await getConnection(userId);
        if (!Item) return response(400, { error: `${providerLabel} not connected` });
        const filePath = queryStringParameters?.path;
        if (!filePath) return response(400, { error: 'Missing path parameter' });
        const ctx = await buildCtx(Item);
        const branch = queryStringParameters?.branch || 'main';
        const file = await provider.getFileContents(ctx, contentsRepo, filePath, branch);
        return response(200, file);
      }

      // GET/POST PR/MR comments
      const commentRef = routes.comments?.(path, queryStringParameters);
      if (commentRef && (httpMethod === 'GET' || httpMethod === 'POST')) {
        if (!userId) return response(401, { error: 'Unauthorized' });
        const Item = await getConnection(userId);
        if (!Item) return response(400, { error: `${providerLabel} not connected` });
        const ctx = await buildCtx(Item);

        if (httpMethod === 'GET') {
          const comments = await provider.listPRComments(ctx, commentRef.repoId, commentRef.prRef);
          return response(200, { comments });
        }
        const data = JSON.parse(body || '{}');
        if (!data.body) return response(400, { error: 'Comment body is required' });
        const created = await provider.addPRComment(ctx, commentRef.repoId, commentRef.prRef, {
          body: data.body,
          path: data.path,
          line: data.line,
          side: data.side,
        });
        return response(201, created);
      }

      return response(404, { error: 'Not found' });
    } catch (err) {
      console.error('Error:', err);
      if (err.status && err.name === 'ProviderError') {
        return response(err.status, { error: err.message, ...err.extra });
      }
      if (err.statusCode) {
        return response(err.statusCode, { error: err.message, code: err.errorCode });
      }
      return response(500, { error: 'Internal server error' });
    }
  };
};
