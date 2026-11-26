// Shared API-Gateway handler for the git-provider connection lambdas
// (lambda/github, lambda/gitlab). Both providers expose the same logical routes
// — OAuth connect/callback, status, repo list, disconnect, branches, tree,
// contents, PR/MR comments — differing only in URL shape and the provider's
// REST mapping (already abstracted in shared/git-providers). This factory holds
// the AWS plumbing (DynamoDB connection rows, SSM token storage, Secrets
// Manager OAuth credentials) once; each lambda passes its provider + a small
// route-shape descriptor that says how to extract a repoId from the path.

import { randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { SSMClient, PutParameterCommand, DeleteParameterCommand } from '@aws-sdk/client-ssm';
import { Logger } from '@aws-lambda-powertools/logger';
import { buildResponse } from './response.js';
import { redactEventForLogging } from './safe-event-logger.js';
import {
  getOAuthCredentials,
  createSignedState,
  verifySignedState,
  resolveGitTokenFull,
  getUserId,
} from './git-oauth.js';
import {
  assertCurrentGitConnection,
  getGitConnection,
  getGitConnectionSnapshot,
  putGitConnection,
  deleteGitConnection,
} from './git-connection-store.js';
import { ensureFreshGitToken } from './git-token.js';
import {
  invalidateBindingsByCredentialRef,
  invalidationReasonForError,
  listBindingsByCredentialRef,
  oauthCredentialRef,
} from './source-control-bindings.js';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const secrets = new SecretsManagerClient({});
const ssm = new SSMClient({});
const logger = new Logger({ persistentKeys: { component: 'git-handler' } });

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
    await assertCurrentGitConnection(ddb, item);
    const tokens = await resolveGitTokenFull(ssm, item);
    await assertCurrentGitConnection(ddb, item);
    const ctx = { token: tokens.accessToken };
    if (typeof provider.oauth.refreshAccessToken === 'function') {
      ctx.onRefresh = async () => {
        try {
          return await ensureFreshGitToken({
            ssm,
            secrets,
            ddb,
            item,
            gitProvider: provider.id,
            staleToken: tokens.accessToken,
          });
        } catch (error) {
          // A delayed request for an old connection must not invalidate the
          // replacement's bindings after the user reconnects.
          if (error.code === 'CONNECTION_CHANGED') throw error;
          const reason = invalidationReasonForError(error);
          if (reason) {
            await invalidateBindingsByCredentialRef(
              ddb,
              oauthCredentialRef(provider.id, item.userId),
              reason,
              { connectionSnapshot: item },
            ).catch(() => {});
          }
          throw error;
        }
      };
    }
    return ctx;
  };

  // Personal endpoints always resolve the caller's OAuth identity. Project
  // workflows use /projects/{id}/source-control and never reach this path.
  const resolveRouteCtx = async (userId) => {
    const Item = await getConnection(userId);
    if (!Item) return { ctx: null };
    return { ctx: await buildCtx(Item) };
  };

  return async (event) => {
    const response = buildResponse(event, { methods: 'GET,POST,DELETE,OPTIONS' });
    logger.info('Request', { event: redactEventForLogging(event) });

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

        // Observe the connection before slow provider calls. A disconnect or
        // newer connect while this callback is running wins over this attempt.
        const previousConnection = await getGitConnectionSnapshot(
          ddb,
          statePayload.userId,
          provider.id,
        );
        const tokens = await provider.oauth.exchangeCode({
          clientId: client_id,
          clientSecret: client_secret,
          code,
          redirectUri: redirectUri(),
        });

        // Every connect gets its own token path. Late writes from the previous
        // connection can never replace these bytes. Keep the existing segment
        // count for path validation/IAM; old stored paths remain readable.
        const generation = randomUUID();
        const parameterName = `/${process.env.GIT_TOKEN_SSM_PREFIX}/${statePayload.userId}/${provider.id}-${generation}`;
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
            // Bitbucket access/refresh tokens are JWTs (~2800+ chars) that
            // exceed the SSM Standard-tier 4096-char cap. Intelligent-Tiering
            // promotes to Advanced only when needed (no-op for short tokens).
            Tier: 'Intelligent-Tiering',
            Overwrite: false,
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
            logger.error(`Failed to fetch ${providerLabel} user for attribution`, e);
          }
        }
        try {
          await putGitConnection(
            ddb,
            {
              userId: statePayload.userId,
              provider: provider.id,
              parameterName,
              generation,
              scope: tokens.scope,
              createdAt: new Date().toISOString(),
              ...authorFields,
            },
            { expectedItem: previousConnection },
          );
        } catch (error) {
          // A retry can turn a committed write with a lost response into a
          // conditional failure. Check the live row before deciding cleanup;
          // never delete a parameter still referenced by the connection.
          if (error.code === 'CONNECTION_CHANGED') {
            let current;
            try {
              current = await getGitConnectionSnapshot(ddb, statePayload.userId, provider.id);
            } catch {
              throw error;
            }
            if (current?.parameterName === parameterName) {
              if (current.generation === generation && current.status !== 'deleted') {
                return response(200, { success: true });
              }
            } else {
              await ssm.send(new DeleteParameterCommand({ Name: parameterName })).catch(() => {});
            }
          }
          throw error;
        }
        return response(200, { success: true });
      }

      // GET /{provider}/status
      if (httpMethod === 'GET' && path.endsWith('/status')) {
        if (!userId) return response(401, { error: 'Unauthorized' });
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
          await invalidateBindingsByCredentialRef(
            ddb,
            oauthCredentialRef(provider.id, userId),
            'oauth_scopes_missing',
            { connectionSnapshot: Item },
          ).catch(() => {});
          return response(200, {
            connected: false,
            provider: Item.provider,
            reauthorizationRequired: true,
            missingScopes,
          });
        }
        return response(200, { connected: !!Item, provider: Item?.provider });
      }

      // GET /{provider}/repos
      if (httpMethod === 'GET' && path.endsWith('/repos')) {
        if (!userId) return response(401, { error: 'Unauthorized' });
        const { ctx } = await resolveRouteCtx(userId);
        if (!ctx) return response(400, { error: `${providerLabel} not connected` });
        const repos = await provider.listRepos(ctx);
        return response(200, repos);
      }

      // DELETE /{provider}/disconnect
      if (httpMethod === 'DELETE' && path.endsWith('/disconnect')) {
        if (!userId) return response(401, { error: 'Unauthorized' });
        const connection = await getConnection(userId);
        const snapshot = connection ?? (await getGitConnectionSnapshot(ddb, userId, provider.id));
        const Item = snapshot?.status === 'deleted' ? null : snapshot;
        const credentialRef = oauthCredentialRef(provider.id, userId);
        const inspectedBindings = await listBindingsByCredentialRef(ddb, credentialRef);
        // Revoke authority before best-effort token cleanup. Condition against
        // the viewed connection so a delayed disconnect cannot delete a newer
        // connect, and leave a tombstone to prevent stale legacy migration.
        // With no active connection, also fence an in-flight first callback.
        await deleteGitConnection(ddb, userId, provider.id, { expectedItem: snapshot });
        if (Item?.parameterName) {
          try {
            await ssm.send(new DeleteParameterCommand({ Name: Item.parameterName }));
          } catch (e) {
            logger.error('Failed to delete git token parameter', e);
          }
        }
        await invalidateBindingsByCredentialRef(ddb, credentialRef, 'oauth_disconnected', {
          actor: userId,
          inspectedBindings,
        });
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
      logger.error('Error', err);
      if (err.code === 'CONNECTION_CHANGED') {
        return response(409, {
          error: 'Git connection changed; reload before retrying',
          code: err.code,
        });
      }
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
