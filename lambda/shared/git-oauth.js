'use strict';

const crypto = require('crypto');

// Matches the git-token SSM parameter path. Legacy connections used a
// 4-segment path (/PREFIX/env/git-token/userId); per-provider connections add a
// 5th provider segment (/PREFIX/env/git-token/userId/provider). Both are valid:
// migrated rows keep their original 4-segment parameterName.
const GIT_TOKEN_PARAM_PATTERN = /^\/[\w-]+\/[\w-]+\/[\w-]+\/[\w-]+(\/[\w-]+)?$/;

/**
 * Validates an SSM parameter name against the expected pattern.
 * @param {string} parameterName
 */
const validateParamName = (parameterName) => {
  if (!GIT_TOKEN_PARAM_PATTERN.test(parameterName)) {
    throw new Error('Invalid SSM parameter name format');
  }
};

/**
 * Fetches OAuth credentials from Secrets Manager.
 *
 * @param {import('@aws-sdk/client-secrets-manager').SecretsManagerClient} secretsClient
 * @param {string} secretName - The Secrets Manager secret name (env var)
 * @param {string} providerLabel - Human-readable provider name for error messages (e.g. "GitHub", "GitLab")
 * @returns {Promise<{ client_id: string, client_secret: string }>}
 */
const getOAuthCredentials = async (secretsClient, secretName, providerLabel) => {
  const { GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

  class OAuthNotConfiguredError extends Error {
    constructor() {
      super(
        `${providerLabel} OAuth is not configured on this environment. See README §4 for setup instructions.`,
      );
      this.name = 'OAuthNotConfiguredError';
      this.statusCode = 503;
      this.errorCode = 'OAUTH_NOT_CONFIGURED';
    }
  }

  let result;
  try {
    result = await secretsClient.send(new GetSecretValueCommand({ SecretId: secretName }));
  } catch (e) {
    if (e.name === 'ResourceNotFoundException') {
      throw new OAuthNotConfiguredError();
    }
    throw e;
  }
  if (!result.SecretString) {
    throw new OAuthNotConfiguredError();
  }
  let parsed;
  try {
    parsed = JSON.parse(result.SecretString);
  } catch {
    throw new OAuthNotConfiguredError();
  }
  const { client_id, client_secret } = parsed || {};
  if (
    typeof client_id !== 'string' ||
    !client_id ||
    typeof client_secret !== 'string' ||
    !client_secret
  ) {
    throw new OAuthNotConfiguredError();
  }
  return { client_id, client_secret };
};

/**
 * Create HMAC-signed state parameter to prevent CSRF/forgery attacks on OAuth callback.
 * @param {object} payload
 * @param {string} secret
 * @returns {string}
 */
const createSignedState = (payload, secret) => {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64');
  const hmac = crypto.createHmac('sha256', secret).update(data).digest('hex');
  return `${data}.${hmac}`;
};

/**
 * Verify and decode HMAC-signed state parameter.
 * @param {string} state
 * @param {string} secret
 * @returns {object|null}
 */
const verifySignedState = (state, secret) => {
  const parts = state.split('.');
  if (parts.length !== 2) return null;
  const [data, signature] = parts;
  const expectedSignature = crypto.createHmac('sha256', secret).update(data).digest('hex');
  if (
    !crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expectedSignature, 'hex'))
  ) {
    return null;
  }
  return JSON.parse(Buffer.from(data, 'base64').toString());
};

/**
 * Resolve a git access token from SSM via the DynamoDB connection item.
 * Returns the full parsed SSM value (may include refreshToken for GitLab).
 *
 * @param {import('@aws-sdk/client-ssm').SSMClient} ssmClient
 * @param {{ parameterName?: string }} item - DynamoDB connection item
 * @returns {Promise<{ accessToken: string, refreshToken?: string }>}
 */
const resolveGitTokenFull = async (ssmClient, item) => {
  const { GetParameterCommand } = require('@aws-sdk/client-ssm');
  if (item?.parameterName) {
    validateParamName(item.parameterName);
    const param = await ssmClient.send(
      new GetParameterCommand({ Name: item.parameterName, WithDecryption: true }),
    );
    return JSON.parse(param.Parameter.Value);
  }
  throw new Error('No SSM parameter name set');
};

/**
 * Extract the user ID from an API Gateway proxy event.
 * @param {object} event
 * @returns {string|undefined}
 */
const getUserId = (event) => {
  return event.requestContext?.authorizer?.claims?.sub;
};

module.exports = {
  GIT_TOKEN_PARAM_PATTERN,
  validateParamName,
  getOAuthCredentials,
  createSignedState,
  verifySignedState,
  resolveGitTokenFull,
  getUserId,
};
