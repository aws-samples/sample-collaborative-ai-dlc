'use strict';

const { GetParameterCommand, PutParameterCommand } = require('@aws-sdk/client-ssm');
const { GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
const { PutCommand } = require('@aws-sdk/lib-dynamodb');

const GIT_TOKEN_PARAM_PATTERN = /^\/[\w-]+\/[\w-]+\/[\w-]+\/[\w-]+$/;

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
  const res = await fetch('https://gitlab.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: tokens.refreshToken,
      client_id,
      client_secret,
    }),
  });
  const data = await res.json();
  if (data.error) {
    throw new Error(data.error_description || data.error);
  }
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
  if (ddb && process.env.GIT_CONNECTIONS_TABLE) {
    await ddb.send(
      new PutCommand({
        TableName: process.env.GIT_CONNECTIONS_TABLE,
        Item: { ...item, scope: data.scope, updatedAt: new Date().toISOString() },
      }),
    );
  }
  return data.access_token;
};

// Return a valid access token for a connection, refreshing GitLab tokens
// just-in-time when they are expired or near expiry. GitHub OAuth-App tokens
// never expire, so this is a passthrough for GitHub (and for any provider
// without a refresh token). Used by the construction path (create-pr, the
// agents-lambda token-refresh action) so long-running jobs don't push/MR with
// a stale GitLab token.
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

module.exports = {
  GIT_TOKEN_PARAM_PATTERN,
  resolveGitToken,
  ensureFreshGitToken,
  REFRESH_SAFETY_MARGIN_MS,
};
