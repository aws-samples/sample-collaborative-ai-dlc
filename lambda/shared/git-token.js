import crypto from 'crypto';
import { GetParameterCommand, PutParameterCommand } from '@aws-sdk/client-ssm';
import { GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { getGitConnection, putGitConnection } from './git-connection-store.js';
import {
  clearGitHubAuthConfigCache,
  getGitHubAppConfig,
  getGitHubAuthMode,
} from './github-auth-config.js';

// Matches the git-token SSM parameter path. Legacy connections used a
// 4-segment path (/PREFIX/env/git-token/userId); per-provider connections add a
// 5th provider segment. Both are valid: migrated rows keep their 4-segment path.
const GIT_TOKEN_PARAM_PATTERN = /^\/[\w-]+\/[\w-]+\/[\w-]+\/[\w-]+(\/[\w-]+)?$/;

// Refresh a GitLab access token when it is within this many ms of expiry (or
// has no recorded expiry). GitLab access tokens live ~2h; refreshing a little
// early avoids handing a token to a clone/push/MR that outlives it.
const REFRESH_SAFETY_MARGIN_MS = 5 * 60 * 1000;

const validateParamName = (parameterName) => {
  if (!GIT_TOKEN_PARAM_PATTERN.test(parameterName)) {
    throw new Error('Invalid SSM parameter name format');
  }
};

const readTokenValue = async (ssm, parameterName) => {
  validateParamName(parameterName);
  const param = await ssm.send(
    new GetParameterCommand({ Name: parameterName, WithDecryption: true }),
  );
  return JSON.parse(param.Parameter.Value);
};

// Back-compat: resolve just the access token from the stored SSM value.
const resolveGitToken = async (ssm, item) => {
  if (!item?.parameterName) throw new Error('No SSM parameter name set');
  const value = await readTokenValue(ssm, item.parameterName);
  return value.accessToken;
};

const getGitlabOAuthCredentials = async (secrets) => {
  const secretName = process.env.GITLAB_OAUTH_SECRET_NAME;
  if (!secretName) throw new Error('GITLAB_OAUTH_SECRET_NAME env var is required');
  const result = await secrets.send(new GetSecretValueCommand({ SecretId: secretName }));
  const parsed = JSON.parse(result.SecretString || '{}');
  if (!parsed.client_id || !parsed.client_secret) {
    throw new Error('GitLab OAuth is not configured');
  }
  return parsed;
};

const refreshGitlabToken = async ({ ssm, secrets, ddb, item, tokens }) => {
  if (!tokens.refreshToken) {
    // No refresh token (e.g. very old row) — nothing we can do; return as-is.
    return tokens.accessToken;
  }
  const { client_id, client_secret } = await getGitlabOAuthCredentials(secrets);
  // GitLab requires redirect_uri on the refresh_token grant, matching the one
  // used at authorization time — without it GitLab returns `invalid_grant`.
  const redirectUri = process.env.GITLAB_REDIRECT_URI;
  const res = await fetch('https://gitlab.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: tokens.refreshToken,
      client_id,
      client_secret,
      ...(redirectUri ? { redirect_uri: redirectUri } : {}),
    }),
  });
  const data = await res.json();
  if (data.error) {
    console.error('[git-token:refresh] failed', {
      httpStatus: res.status,
      error: data.error,
      errorDescription: data.error_description,
      userId: item?.userId,
      hasRedirectUri: Boolean(redirectUri),
    });
    throw new Error(data.error_description || data.error);
  }
  console.log('[git-token:refresh] ok', { userId: item?.userId, expiresIn: data.expires_in });
  const expiresAt = data.expires_in ? Date.now() + Number(data.expires_in) * 1000 : undefined;
  const newValue = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    tokenType: data.token_type,
    ...(expiresAt ? { expiresAt } : {}),
  };
  await ssm.send(
    new PutParameterCommand({
      Name: item.parameterName,
      Value: JSON.stringify(newValue),
      Type: 'SecureString',
      Overwrite: true,
    }),
  );
  // Persist the rotated refresh-token metadata (the access token itself lives
  // in SSM, written above). Use putGitConnection so the row lands in the
  // authoritative composite-key table (userId + providerInstance) — writing the
  // raw item to the legacy single-key table would mismatch its schema. The SSM
  // parameterName never changes, so the stored token reference stays valid.
  if (ddb && item?.userId && item?.provider) {
    try {
      await putGitConnection(ddb, {
        ...item,
        scope: data.scope,
        updatedAt: new Date().toISOString(),
      });
    } catch (e) {
      // Best-effort: the access token is already persisted in SSM, so a failure
      // here only loses the metadata refresh, not the token itself.
      console.error('Failed to persist refreshed git connection metadata:', e.message);
    }
  }
  return data.access_token;
};

// Return a valid access token for a connection, refreshing GitLab tokens
// just-in-time when they are expired or near expiry. GitHub OAuth-App tokens
// never expire, so this is a passthrough for GitHub (and for any provider
// without a refresh token). Used by shared/git-handler.js and the GitLab
// issues tracker so long-running jobs don't push/MR with a stale GitLab token.
const ensureFreshGitToken = async ({ ssm, secrets, ddb, item, gitProvider }) => {
  if (!item?.parameterName) throw new Error('No SSM parameter name set');
  const tokens = await readTokenValue(ssm, item.parameterName);
  if (gitProvider !== 'gitlab' || !tokens.refreshToken) {
    return tokens.accessToken;
  }
  const expiresAt = Number(tokens.expiresAt) || 0;
  const isStale = !expiresAt || expiresAt - Date.now() <= REFRESH_SAFETY_MARGIN_MS;
  if (!isStale) {
    return tokens.accessToken;
  }
  return refreshGitlabToken({ ssm, secrets, ddb, item, tokens });
};

// GitHub App installation tokens (GitHub-only): used platform-wide when the
// admin-controlled auth mode is 'app' (see shared/github-auth-config.js)
// instead of per-user OAuth connections. The App private key never expires
// (unlike OAuth refresh tokens, there is nothing to rotate or revoke
// server-side), so minting is stateless and dependency-free. Each MINTED
// installation token still has GitHub's hard ~1h TTL; we cache per repo-scope
// and re-mint on demand. A single agent phase running >1h is the only edge case
// — the orchestrator re-mints per phase on re-dispatch.
let _appPrivateKeyPem = null;
let _appPrivateKeyPemFetchedAt = 0;
// Cache key = `${installationId}|${sortedRepoScope}` so a token scoped to repo A
// is never handed to a request scoped to repo B.
const _installationTokenCache = new Map();

// Installation account login cache: avoids re-fetching on every mint. Keyed by
// installationId. Entries expire after PEM_CACHE_TTL_MS.
const _installationAccountCache = new Map();
const PEM_CACHE_TTL_MS = 15 * 60 * 1000;

// Drop all App-auth caches. Called by the admin config endpoint after the
// private key / App config changes so the validation probe (and subsequent
// mints in this container) use the fresh values instead of a 15-min-stale PEM.
const clearAppAuthCaches = () => {
  _appPrivateKeyPem = null;
  _appPrivateKeyPemFetchedAt = 0;
  _installationTokenCache.clear();
  _installationAccountCache.clear();
  clearGitHubAuthConfigCache();
};

const base64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

// Build a short-lived RS256 JWT signed with the App private key. Per GitHub's
// requirements: iat backdated 60s for clock skew, exp <= 10min (we use 9), and
// iss set to the App ID. The token is opaque — do not parse or store it.
const buildAppJwt = (appId, privateKeyPem) => {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(
    JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: String(appId) }),
  );
  const signingInput = `${header}.${payload}`;
  const signature = base64url(
    crypto.createSign('RSA-SHA256').update(signingInput).sign(privateKeyPem),
  );
  return `${signingInput}.${signature}`;
};

// Secret may be a raw PEM or JSON ({ privateKey | private_key | pem }), with
// literal or \n-escaped newlines — all tolerated.
const getAppPrivateKey = async (secrets) => {
  if (_appPrivateKeyPem && Date.now() - _appPrivateKeyPemFetchedAt < PEM_CACHE_TTL_MS) {
    return _appPrivateKeyPem;
  }
  const secretId = process.env.GITHUB_APP_PRIVATE_KEY_SECRET_NAME;
  if (!secretId) throw new Error('GITHUB_APP_PRIVATE_KEY_SECRET_NAME env var is required');
  const result = await secrets.send(new GetSecretValueCommand({ SecretId: secretId }));
  const raw = result.SecretString || '';
  let pem = raw;
  if (raw.trim().startsWith('{')) {
    const parsed = JSON.parse(raw);
    pem = parsed.privateKey || parsed.private_key || parsed.pem || '';
  }
  pem = pem.replace(/\\n/g, '\n');
  if (!pem.includes('BEGIN') || !pem.includes('PRIVATE KEY')) {
    throw new Error('GitHub App private key in Secrets Manager is not a valid PEM');
  }
  _appPrivateKeyPem = pem;
  _appPrivateKeyPemFetchedAt = Date.now();
  return pem;
};

const getInstallationAccountLogin = async (secrets, appId, installationId) => {
  const cached = _installationAccountCache.get(installationId);
  if (cached && Date.now() - cached.fetchedAt < PEM_CACHE_TTL_MS) {
    return cached.login;
  }
  const privateKeyPem = await getAppPrivateKey(secrets);
  const jwt = buildAppJwt(appId, privateKeyPem);
  const res = await fetch(
    `https://api.github.com/app/installations/${encodeURIComponent(installationId)}`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'collaborative-ai-dlc',
      },
    },
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.account?.login) {
    throw new Error(
      `Failed to resolve installation account (HTTP ${res.status}): ${data.message || 'unknown'}`,
    );
  }
  _installationAccountCache.set(installationId, {
    login: data.account.login,
    fetchedAt: Date.now(),
  });
  return data.account.login;
};

const getInstallationToken = async ({
  secrets,
  appId,
  installationId,
  repositories,
  permissions,
} = {}) => {
  const resolvedAppId = appId || process.env.GITHUB_APP_ID;
  const resolvedInstallationId = installationId || process.env.GITHUB_INSTALLATION_ID;
  if (!resolvedAppId || !resolvedInstallationId) {
    throw new Error('GITHUB_APP_ID and GITHUB_INSTALLATION_ID are required for GitHub App auth');
  }

  // SECURITY: fail closed — never mint an installation-wide token.
  if (!Array.isArray(repositories) || repositories.filter(Boolean).length === 0) {
    throw new Error('repositories array is required and must not be empty');
  }

  // Normalize: callers pass full owner/repo slugs; we validate the owner below
  // and extract short names for the GitHub mint API.
  const fullSlugs = [...new Set(repositories.filter(Boolean))];

  // SECURITY: bind to the installation account. Reject any slug whose
  // owner does not match the installation's account login.
  const accountLogin = await getInstallationAccountLogin(
    secrets,
    resolvedAppId,
    resolvedInstallationId,
  );
  for (const slug of fullSlugs) {
    const owner = slug.split('/')[0];
    if (!owner || owner.toLowerCase() !== accountLogin.toLowerCase()) {
      throw new Error(
        `Repository "${slug}" owner does not match installation account "${accountLogin}"`,
      );
    }
  }

  const scopedRepos = fullSlugs.map((s) => s.split('/').pop()).toSorted();
  // SECURITY: default down-scoped permissions when caller omits them.
  const resolvedPermissions =
    permissions && Object.keys(permissions).length
      ? permissions
      : { contents: 'write', pull_requests: 'write', workflows: 'write' };
  // Cache key includes the permission set so a token minted for one permission
  // profile is never served to a caller requesting a different one.
  const permKey = Object.entries(resolvedPermissions)
    .map(([k, v]) => `${k}=${v}`)
    .toSorted()
    .join(',');
  const cacheKey = `${resolvedInstallationId}|${scopedRepos.join(',')}|${permKey}`;

  const cached = _installationTokenCache.get(cacheKey);
  if (cached && cached.expiresAt - Date.now() > REFRESH_SAFETY_MARGIN_MS) {
    return cached.token;
  }

  const privateKeyPem = await getAppPrivateKey(secrets);
  const jwt = buildAppJwt(resolvedAppId, privateKeyPem);
  const mintBody = { repositories: scopedRepos, permissions: resolvedPermissions };
  const res = await fetch(
    `https://api.github.com/app/installations/${encodeURIComponent(resolvedInstallationId)}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'collaborative-ai-dlc',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(mintBody),
    },
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.token) {
    console.error('[git-token:app] installation token mint failed', {
      httpStatus: res.status,
      message: data.message,
      installationId: resolvedInstallationId,
      scopedRepos,
    });
    throw new Error(data.message || `Failed to mint installation token (HTTP ${res.status})`);
  }

  const expiresAt = data.expires_at ? Date.parse(data.expires_at) : Date.now() + 60 * 60 * 1000;
  _installationTokenCache.set(cacheKey, { token: data.token, expiresAt });
  console.log('[git-token:app] minted installation token', {
    installationId: resolvedInstallationId,
    scopedRepos,
    expiresAt: new Date(expiresAt).toISOString(),
  });
  return data.token;
};

// Installation-token minting with App credentials sourced from the
// admin-managed SSM config parameter (GITHUB_APP_CONFIG_PARAM) instead of
// caller-supplied/env values. This is the runtime entry point used by
// mode-aware callers (orchestrator, trackers, git-handler).
const getInstallationTokenFromConfig = async ({ ssm, secrets, repositories, permissions } = {}) => {
  const { appId, installationId } = await getGitHubAppConfig(ssm);
  if (!appId || !installationId) {
    throw new Error(
      'GitHub App is not configured (missing appId/installationId) — set it up on the Admin page',
    );
  }
  return getInstallationToken({ secrets, appId, installationId, repositories, permissions });
};

// Metadata-read installation token for repo DISCOVERY (the app-mode repo
// picker calls GET /installation/repositories, which must not be repo-scoped
// or GitHub would only return the scoped repos). The deliberate exception to
// getInstallationToken's fail-closed repo requirement: permissions are pinned
// to metadata:read — the least GitHub grants any installation token — so this
// token can list repos and branches but never touch contents.
const getInstallationReadToken = async ({ ssm, secrets } = {}) => {
  const { appId, installationId } = await getGitHubAppConfig(ssm);
  if (!appId || !installationId) {
    throw new Error(
      'GitHub App is not configured (missing appId/installationId) — set it up on the Admin page',
    );
  }
  const cacheKey = `${installationId}|__all__|metadata=read`;
  const cached = _installationTokenCache.get(cacheKey);
  if (cached && cached.expiresAt - Date.now() > REFRESH_SAFETY_MARGIN_MS) {
    return cached.token;
  }
  const privateKeyPem = await getAppPrivateKey(secrets);
  const jwt = buildAppJwt(appId, privateKeyPem);
  const res = await fetch(
    `https://api.github.com/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'collaborative-ai-dlc',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ permissions: { metadata: 'read' } }),
    },
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.token) {
    throw new Error(data.message || `Failed to mint installation read token (HTTP ${res.status})`);
  }
  const expiresAt = data.expires_at ? Date.parse(data.expires_at) : Date.now() + 60 * 60 * 1000;
  _installationTokenCache.set(cacheKey, { token: data.token, expiresAt });
  return data.token;
};

/**
 * Mode-aware GitHub token resolution — THE single dispatch point between the
 * two platform auth modes (see shared/github-auth-config.js):
 *
 *   oauth — resolve the user's per-user OAuth token from their connection row
 *           (returns { mode:'oauth', token:null } when not connected so the
 *           caller can surface its provider-specific "not connected" error).
 *   app   — mint a repo-scoped installation token; `repositories` is required
 *           (fail-closed, see getInstallationToken). userId is irrelevant.
 *
 * @param {object} deps { ssm, secrets, ddb }
 * @param {object} opts { userId, repositories, permissions }
 * @returns {Promise<{ mode: 'oauth'|'app', token: string|null }>}
 */
const resolveGitHubTokenForMode = async (
  { ssm, secrets, ddb },
  { userId, repositories, permissions } = {},
) => {
  const mode = await getGitHubAuthMode(ssm);
  if (mode === 'app') {
    const token = await getInstallationTokenFromConfig({ ssm, secrets, repositories, permissions });
    return { mode, token };
  }
  const item = userId ? await getGitConnection(ddb, userId, 'github') : null;
  if (!item) return { mode, token: null };
  return { mode, token: await resolveGitToken(ssm, item) };
};

export {
  GIT_TOKEN_PARAM_PATTERN,
  resolveGitToken,
  ensureFreshGitToken,
  getInstallationToken,
  getInstallationTokenFromConfig,
  getInstallationReadToken,
  resolveGitHubTokenForMode,
  getInstallationAccountLogin,
  buildAppJwt,
  getAppPrivateKey,
  clearAppAuthCaches,
  REFRESH_SAFETY_MARGIN_MS,
  PEM_CACHE_TTL_MS,
};
export default {
  GIT_TOKEN_PARAM_PATTERN,
  resolveGitToken,
  ensureFreshGitToken,
  getInstallationToken,
  getInstallationTokenFromConfig,
  getInstallationReadToken,
  resolveGitHubTokenForMode,
  getInstallationAccountLogin,
  buildAppJwt,
  getAppPrivateKey,
  clearAppAuthCaches,
  REFRESH_SAFETY_MARGIN_MS,
  PEM_CACHE_TTL_MS,
};
