// Platform GitHub integration configuration. OAuth and GitHub App credentials
// are configured simultaneously; projects choose an auth type when they bind
// repositories. There is no platform-wide runtime mode or installation id.

import { SSMClient } from '@aws-sdk/client-ssm';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
  PutSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import { buildResponse } from './response.js';
import { requirePlatformAdmin } from './authz.js';
import { getUserId } from './git-oauth.js';
import { getGitHubAppConfig, writeGitHubAppConfig } from './github-auth-config.js';
import { clearAppAuthCaches, getGitHubAppIdentity } from './git-token.js';

const ssm = new SSMClient({});
const secrets = new SecretsManagerClient({});
const ID_PATTERN = /^\d{1,32}$/;
const MAX_PEM_LENGTH = 16 * 1024;

const isPrivateKeySet = async () => {
  const secretId = process.env.GITHUB_APP_PRIVATE_KEY_SECRET_NAME;
  if (!secretId) return false;
  try {
    const result = await secrets.send(new GetSecretValueCommand({ SecretId: secretId }));
    return String(result.SecretString || '').includes('PRIVATE KEY');
  } catch {
    return false;
  }
};

const isOAuthConfigured = async () => {
  const secretId = process.env.GITHUB_OAUTH_SECRET_NAME;
  if (!secretId) return false;
  try {
    const result = await secrets.send(new GetSecretValueCommand({ SecretId: secretId }));
    const parsed = JSON.parse(result.SecretString || '{}');
    return Boolean(parsed.client_id && parsed.client_secret);
  } catch {
    return false;
  }
};

const currentState = async () => {
  const [appConfig, privateKeySet, oauthConfigured] = await Promise.all([
    getGitHubAppConfig(ssm),
    isPrivateKeySet(),
    isOAuthConfigured(),
  ]);
  let appConfigured = Boolean(appConfig.appId && privateKeySet);
  let appIdentity = null;
  let appConfigurationError = null;
  if (appConfigured) {
    try {
      const identity = await getGitHubAppIdentity({
        secrets,
        appId: appConfig.appId,
      });
      appIdentity = identity.login;
    } catch (error) {
      appConfigured = false;
      appConfigurationError = error?.message || 'GitHub App validation failed';
    }
  }
  return {
    oauthConfigured,
    appId: appConfig.appId,
    privateKeySet,
    appConfigured,
    appIdentity,
    ...(appConfigurationError ? { appConfigurationError } : {}),
  };
};

export const handleGitHubAdminConfig = async (event) => {
  const response = buildResponse(event, { methods: 'GET,PUT,OPTIONS' });
  if (event.httpMethod === 'OPTIONS') return response(200, {});
  const userId = getUserId(event);
  if (!userId) return response(401, { error: 'Unauthorized' });
  const denied = requirePlatformAdmin(event);
  if (denied) return response(denied.statusCode, { error: denied.error, code: denied.code });

  try {
    if (event.httpMethod === 'GET') {
      clearAppAuthCaches();
      return response(200, await currentState());
    }
    if (event.httpMethod !== 'PUT') return response(404, { error: 'Not found' });

    let data;
    try {
      data = event.body ? JSON.parse(event.body) : {};
    } catch {
      return response(400, { error: 'Invalid JSON body' });
    }
    const { appId, privateKey } = data;
    if ('mode' in data || 'installationId' in data) {
      return response(400, {
        error:
          'Global mode and installationId are no longer supported; bind installations per project',
        code: 'PROJECT_BINDING_REQUIRED',
      });
    }
    if (appId !== undefined && appId !== null && !ID_PATTERN.test(String(appId))) {
      return response(400, { error: 'appId must be numeric' });
    }
    if (privateKey !== undefined) {
      if (typeof privateKey !== 'string' || privateKey.length > MAX_PEM_LENGTH) {
        return response(400, { error: 'privateKey must be a PEM string (max 16KB)' });
      }
      const pem = privateKey.replace(/\\n/g, '\n');
      if (!pem.includes('BEGIN') || !pem.includes('PRIVATE KEY')) {
        return response(400, { error: 'privateKey is not a valid PEM private key' });
      }
      const secretId = process.env.GITHUB_APP_PRIVATE_KEY_SECRET_NAME;
      if (!secretId) {
        return response(500, { error: 'GITHUB_APP_PRIVATE_KEY_SECRET_NAME is not configured' });
      }
      await secrets.send(new PutSecretValueCommand({ SecretId: secretId, SecretString: pem }));
      clearAppAuthCaches();
    }

    const stored = await getGitHubAppConfig(ssm);
    const candidateAppId = appId !== undefined ? (appId ? String(appId) : null) : stored.appId;
    if (candidateAppId && !(await isPrivateKeySet())) {
      return response(400, {
        error: 'GitHub App configuration requires the private key',
        code: 'APP_CONFIG_INCOMPLETE',
      });
    }
    if (candidateAppId) {
      try {
        clearAppAuthCaches();
        await getGitHubAppIdentity({ secrets, appId: candidateAppId });
      } catch (error) {
        return response(400, {
          error: `GitHub App validation failed: ${error.message}`,
          code: 'APP_CONFIG_INVALID',
        });
      }
    }
    if (appId !== undefined) {
      await writeGitHubAppConfig(ssm, { appId: candidateAppId });
    }
    console.log('[github-admin] integration config updated', { by: userId });
    return response(200, await currentState());
  } catch (error) {
    console.error('[github-admin] error:', error);
    return response(500, { error: 'Internal server error' });
  }
};
