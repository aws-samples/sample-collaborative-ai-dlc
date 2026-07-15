'use strict';

const { GetParameterCommand, PutParameterCommand } = require('@aws-sdk/client-ssm');
const { GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
const { putGitConnection } = require('./git-connection-store');

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

const getBitbucketOAuthCredentials = async (secrets) => {
  const secretName = process.env.BITBUCKET_OAUTH_SECRET_NAME;
  if (!secretName) throw new Error('BITBUCKET_OAUTH_SECRET_NAME env var is required');
  const result = await secrets.send(new GetSecretValueCommand({ SecretId: secretName }));
  const parsed = JSON.parse(result.SecretString || '{}');
  if (!parsed.client_id || !parsed.client_secret) {
    throw new Error('Bitbucket OAuth is not configured');
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

const refreshBitbucketToken = async ({ ssm, secrets, ddb, item, tokens }) => {
  if (!tokens.refreshToken) {
    // No refresh token (e.g. very old row) — nothing we can do; return as-is.
    return tokens.accessToken;
  }
  const { client_id, client_secret } = await getBitbucketOAuthCredentials(secrets);
  // Bitbucket requires redirect_uri on the refresh_token grant, similar to GitLab
  const redirectUri = process.env.BITBUCKET_REDIRECT_URI;
  const res = await fetch('https://bitbucket.org/site/oauth2/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
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
  // Persist the rotated refresh-token metadata (similar to GitLab)
  if (ddb && item?.userId && item?.provider) {
    try {
      await putGitConnection(ddb, {
        ...item,
        scope: data.scope,
        updatedAt: new Date().toISOString(),
      });
    } catch (e) {
      console.error('Failed to persist refreshed git connection metadata:', e.message);
    }
  }
  return data.access_token;
};

// Return a valid access token for a connection, refreshing GitLab/Bitbucket tokens
// just-in-time when they are expired or near expiry. GitHub OAuth-App tokens
// never expire, so this is a passthrough for GitHub (and for any provider
// without a refresh token). Used by the construction path (create-pr, the
// agents-lambda token-refresh action) so long-running jobs don't push/MR with
// a stale token.
const ensureFreshGitToken = async ({ ssm, secrets, ddb, item, gitProvider }) => {
  if (!item?.parameterName) throw new Error('No SSM parameter name set');
  const tokens = await readTokenValue(ssm, item.parameterName);
  if ((gitProvider !== 'gitlab' && gitProvider !== 'bitbucket') || !tokens.refreshToken) {
    return tokens.accessToken;
  }
  const expiresAt = Number(tokens.expiresAt) || 0;
  const isStale = !expiresAt || expiresAt - Date.now() <= REFRESH_SAFETY_MARGIN_MS;
  if (!isStale) {
    return tokens.accessToken;
  }
  if (gitProvider === 'gitlab') {
    return refreshGitlabToken({ ssm, secrets, ddb, item, tokens });
  } else if (gitProvider === 'bitbucket') {
    return refreshBitbucketToken({ ssm, secrets, ddb, item, tokens });
  }
  return tokens.accessToken;
};

module.exports = {
  GIT_TOKEN_PARAM_PATTERN,
  resolveGitToken,
  ensureFreshGitToken,
  REFRESH_SAFETY_MARGIN_MS,
};
