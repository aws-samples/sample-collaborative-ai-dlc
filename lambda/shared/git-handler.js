// Shared API-Gateway handler for the git-provider connection lambdas
// (lambda/github, lambda/gitlab). Both providers expose the same logical routes
// — OAuth connect/callback, status, repo list, disconnect, branches, tree,
// contents, PR/MR comments — differing only in URL shape and the provider's
// REST mapping (already abstracted in shared/git-providers). This factory holds
// the AWS plumbing (DynamoDB connection rows, SSM token storage, Secrets
// Manager OAuth credentials) once; each lambda passes its provider + a small
// route-shape descriptor that says how to extract a repoId from the path.

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
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
import { getGitConnection, putGitConnection, deleteGitConnection } from './git-connection-store.js';
import { getGitHubAuthMode, getGitHubAppConfig } from './github-auth-config.js';
import { getInstallationTokenFromConfig, getInstallationReadToken } from './git-token.js';

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

  // GitHub only: the platform-wide auth mode ('oauth' | 'app', admin-managed,
  // see shared/github-auth-config.js). Every other provider is always 'oauth'.
  const isGitHub = provider.id === 'github';
  const authMode = async () => (isGitHub ? getGitHubAuthMode(ssm) : 'oauth');

  // Resolve the caller's connection row for THIS provider. Backed by the
  // composite-key git-provider-connections table; a user can hold a GitHub and
  // a GitLab connection at once. Connections written before the cutover are
  // lazily migrated out of the legacy single-key table on first read (see
  // git-connection-store). Returns null when this provider isn't connected.
  const getConnection = async (userId) => getGitConnection(ddb, userId, provider.id);

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
          redirectUri: redirectUri(),
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
        await putGitConnection(ddb, {
          ...item,
          scope: refreshed.scope,
          updatedAt: new Date().toISOString(),
        });
        return refreshed.accessToken;
      };
    }
    return ctx;
  };

  // Mode-aware ctx resolution for repo-scoped routes. In GitHub-App mode the
  // per-user connection is bypassed entirely: a repo-scoped installation
  // token (down-scoped to `permissions`) is minted instead; without a repo
  // scope a metadata:read discovery token is used. Returns { ctx:null } when
  // the caller has no usable credentials (oauth mode + not connected).
  const resolveRouteCtx = async (userId, { repositories, permissions } = {}) => {
    if ((await authMode()) === 'app') {
      const token = repositories?.length
        ? await getInstallationTokenFromConfig({ ssm, secrets, repositories, permissions })
        : await getInstallationReadToken({ ssm, secrets });
      return { ctx: { token }, mode: 'app' };
    }
    const Item = await getConnection(userId);
    if (!Item) return { ctx: null, mode: 'oauth' };
    return { ctx: await buildCtx(Item), mode: 'oauth' };
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
        if ((await authMode()) === 'app') {
          // No per-user connect flow in app mode — the platform authenticates
          // as the GitHub App installation (admin-configured).
          return response(409, {
            error: `${providerLabel} uses GitHub App authentication on this platform — no per-user connection is needed`,
            code: 'APP_MODE',
          });
        }
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

        // Per-provider SSM token path. The 5th `provider.id` segment keeps a
        // user's GitHub and GitLab tokens from colliding (both used to write to
        // /PREFIX/userId). Legacy connections kept the 4-segment path; their
        // parameterName is read from the stored row, so they remain valid.
        const parameterName = `/${process.env.GIT_TOKEN_SSM_PREFIX}/${statePayload.userId}/${provider.id}`;
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
        // Commit-attribution identity ("on behalf of": author = user,
        // committer = engine). Best-effort — a failed /user lookup must never
        // break the connect flow; the orchestrator lazily backfills later.
        let authorFields = {};
        if (typeof provider.getAuthenticatedUser === 'function') {
          try {
            const user = await provider.getAuthenticatedUser({ token: tokens.accessToken });
            authorFields = {
              githubLogin: user.login,
              authorName: user.authorName,
              authorEmail: user.authorEmail,
            };
          } catch (e) {
            console.error(`Failed to fetch ${providerLabel} user for attribution:`, e.message);
          }
        }
        await putGitConnection(ddb, {
          userId: statePayload.userId,
          provider: provider.id,
          parameterName,
          scope: tokens.scope,
          createdAt: new Date().toISOString(),
          ...authorFields,
        });
        return response(200, { success: true });
      }

      // GET /{provider}/status
      if (httpMethod === 'GET' && path.endsWith('/status')) {
        if (!userId) return response(401, { error: 'Unauthorized' });
        const mode = await authMode();
        if (mode === 'app') {
          // App mode: "connected" is a platform property (App configured),
          // not a per-user one. The frontend uses `mode` to hide the
          // connect/disconnect UI.
          const appConfig = await getGitHubAppConfig(ssm);
          const connected = Boolean(appConfig.appId && appConfig.installationId);
          return response(200, { connected, provider: provider.id, mode });
        }
        const Item = await getConnection(userId);
        const grantedScopes = new Set(
          String(Item?.scope ?? '')
            .split(/[\s,]+/)
            .filter(Boolean),
        );
        const missingScopes = (provider.oauth.requiredConnectionScopes ?? []).filter(
          (scope) => !grantedScopes.has(scope),
        );
        if (Item && missingScopes.length > 0) {
          return response(200, {
            connected: false,
            provider: Item.provider,
            mode,
            reauthorizationRequired: true,
            missingScopes,
          });
        }
        return response(200, { connected: !!Item, provider: Item?.provider, mode });
      }

      // GET /{provider}/repos
      if (httpMethod === 'GET' && path.endsWith('/repos')) {
        if (!userId) return response(401, { error: 'Unauthorized' });
        const { ctx, mode } = await resolveRouteCtx(userId);
        if (!ctx) return response(400, { error: `${providerLabel} not connected` });
        // App mode lists the repos the installation can access (installation
        // scoping replaces the per-user repo list); oauth lists the user's.
        const repos =
          mode === 'app' && typeof provider.listInstallationRepos === 'function'
            ? await provider.listInstallationRepos(ctx)
            : await provider.listRepos(ctx);
        return response(200, repos);
      }

      // DELETE /{provider}/disconnect
      if (httpMethod === 'DELETE' && path.endsWith('/disconnect')) {
        if (!userId) return response(401, { error: 'Unauthorized' });
        const Item = await getConnection(userId);
        // getConnection scopes by provider, so a null Item means "nothing of
        // ours to disconnect".
        if (!Item) return response(200, { success: true });
        if (Item.parameterName) {
          try {
            await ssm.send(new DeleteParameterCommand({ Name: Item.parameterName }));
          } catch (e) {
            console.error('Failed to delete git token parameter:', e.message);
          }
        }
        // Delete from BOTH the new and legacy tables so a stale legacy row
        // can't resurrect this connection via migrate-on-read.
        await deleteGitConnection(ddb, userId, provider.id);
        return response(200, { success: true });
      }

      // GET .../branches
      const branchRepo = routes.branches?.(path, queryStringParameters);
      if (httpMethod === 'GET' && branchRepo) {
        if (!userId) return response(401, { error: 'Unauthorized' });
        const { ctx } = await resolveRouteCtx(userId, {
          repositories: [branchRepo],
          permissions: { contents: 'read' },
        });
        if (!ctx) return response(400, { error: `${providerLabel} not connected` });
        const branches = await provider.listBranches(ctx, branchRepo);
        // Best-effort: also surface the repo's actual default branch so a
        // base-branch picker can preselect it instead of assuming `main`.
        // Never fail the request over this — the picker just falls back to
        // showing no preselection.
        const defaultBranch = await provider.getDefaultBranch(ctx, branchRepo).catch(() => null);
        return response(200, defaultBranch ? { branches, defaultBranch } : { branches });
      }

      // GET .../tree
      const treeRepo = routes.tree?.(path, queryStringParameters);
      if (httpMethod === 'GET' && treeRepo) {
        if (!userId) return response(401, { error: 'Unauthorized' });
        const { ctx } = await resolveRouteCtx(userId, {
          repositories: [treeRepo],
          permissions: { contents: 'read' },
        });
        if (!ctx) return response(400, { error: `${providerLabel} not connected` });
        const branch = queryStringParameters?.branch || 'main';
        const tree = await provider.getTree(ctx, treeRepo, branch);
        return response(200, { tree });
      }

      // GET .../contents
      const contentsRepo = routes.contents?.(path, queryStringParameters);
      if (httpMethod === 'GET' && contentsRepo) {
        if (!userId) return response(401, { error: 'Unauthorized' });
        const filePath = queryStringParameters?.path;
        if (!filePath) return response(400, { error: 'Missing path parameter' });
        const { ctx } = await resolveRouteCtx(userId, {
          repositories: [contentsRepo],
          permissions: { contents: 'read' },
        });
        if (!ctx) return response(400, { error: `${providerLabel} not connected` });
        const branch = queryStringParameters?.branch || 'main';
        const file = await provider.getFileContents(ctx, contentsRepo, filePath, branch);
        return response(200, file);
      }

      // GET/POST PR/MR comments. In app mode comments are authored by the App
      // (bot attribution) — the platform-level trade-off of installation auth.
      const commentRef = routes.comments?.(path, queryStringParameters);
      if (commentRef && (httpMethod === 'GET' || httpMethod === 'POST')) {
        if (!userId) return response(401, { error: 'Unauthorized' });
        const { ctx } = await resolveRouteCtx(userId, {
          repositories: [commentRef.repoId],
          permissions: { pull_requests: httpMethod === 'POST' ? 'write' : 'read' },
        });
        if (!ctx) return response(400, { error: `${providerLabel} not connected` });

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
