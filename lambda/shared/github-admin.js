// Platform-admin GitHub configuration endpoints (GitHub-only, so this lives
// beside — not inside — the provider-agnostic shared/git-handler.js):
//
//   GET /github/admin/config — current auth mode + App config (masked key)
//   PUT /github/admin/config — update mode / App ID / installation ID /
//                              private key (PEM → Secrets Manager)
//
// Both routes require the Cognito `platform-admin` group (shared/authz.js).
// Switching the mode to 'app' is validated with a LIVE probe — a JWT signed
// with the stored private key must successfully resolve the installation
// (GET /app/installations/{id}) before the mode flips, so an admin can never
// strand the platform on a broken App config.

import { SSMClient } from '@aws-sdk/client-ssm';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
  PutSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import { buildResponse } from './response.js';
import { requirePlatformAdmin } from './authz.js';
import { getUserId } from './git-oauth.js';
import {
  VALID_MODES,
  getGitHubAuthMode,
  getGitHubAppConfig,
  writeGitHubAuthMode,
  writeGitHubAppConfig,
} from './github-auth-config.js';
import { validateGitHubAppInstallation, clearAppAuthCaches } from './git-token.js';

const ssm = new SSMClient({});
const secrets = new SecretsManagerClient({});

const ID_PATTERN = /^\d{1,32}$/;
const MAX_PEM_LENGTH = 16 * 1024;

// The secret exists from day one (Terraform provisions the container) but has
// no version until first written — GetSecretValue throws until then.
const isPrivateKeySet = async () => {
  const secretId = process.env.GITHUB_APP_PRIVATE_KEY_SECRET_NAME;
  if (!secretId) return false;
  try {
    const result = await secrets.send(new GetSecretValueCommand({ SecretId: secretId }));
    const raw = result.SecretString || '';
    return raw.includes('PRIVATE KEY');
  } catch {
    return false;
  }
};

const currentState = async () => {
  const [mode, appConfig, privateKeySet] = await Promise.all([
    getGitHubAuthMode(ssm),
    getGitHubAppConfig(ssm),
    isPrivateKeySet(),
  ]);
  let appConfigured = Boolean(appConfig.appId && appConfig.installationId && privateKeySet);
  let appConfigurationError = null;
  if (mode === 'app' && appConfigured) {
    try {
      await validateGitHubAppInstallation(secrets, appConfig.appId, appConfig.installationId);
    } catch (error) {
      appConfigured = false;
      appConfigurationError = error?.message ?? 'GitHub App validation failed';
    }
  }
  return {
    mode,
    appId: appConfig.appId,
    installationId: appConfig.installationId,
    privateKeySet,
    appConfigured,
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
      // Admin status is a live recheck: App permissions may have been changed
      // on GitHub since the last request.
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

    const { mode, appId, installationId, privateKey } = data;

    if (mode !== undefined && !VALID_MODES.includes(mode)) {
      return response(400, { error: `mode must be one of: ${VALID_MODES.join(', ')}` });
    }
    if (appId !== undefined && appId !== null && !ID_PATTERN.test(String(appId))) {
      return response(400, { error: 'appId must be numeric' });
    }
    if (
      installationId !== undefined &&
      installationId !== null &&
      !ID_PATTERN.test(String(installationId))
    ) {
      return response(400, { error: 'installationId must be numeric' });
    }
    if (privateKey !== undefined) {
      if (typeof privateKey !== 'string' || privateKey.length > MAX_PEM_LENGTH) {
        return response(400, { error: 'privateKey must be a PEM string (max 16KB)' });
      }
      const pem = privateKey.replace(/\\n/g, '\n');
      if (!pem.includes('BEGIN') || !pem.includes('PRIVATE KEY')) {
        return response(400, { error: 'privateKey is not a valid PEM private key' });
      }
    }

    // 1. Persist the private key first — the validation probe below needs it.
    if (privateKey !== undefined) {
      const secretId = process.env.GITHUB_APP_PRIVATE_KEY_SECRET_NAME;
      if (!secretId) {
        return response(500, { error: 'GITHUB_APP_PRIVATE_KEY_SECRET_NAME is not configured' });
      }
      await secrets.send(
        new PutSecretValueCommand({ SecretId: secretId, SecretString: privateKey }),
      );
      // New key ⇒ every cached JWT/PEM/installation token in this container is stale.
      clearAppAuthCaches();
    }

    // 2. Resolve the candidate config (request values win over stored ones).
    const stored = await getGitHubAppConfig(ssm);
    const candidate = {
      appId: appId !== undefined ? (appId ? String(appId) : null) : stored.appId,
      installationId:
        installationId !== undefined
          ? installationId
            ? String(installationId)
            : null
          : stored.installationId,
    };

    // 3. Live-probe before anything can flip to (or keep running in) app mode.
    //    Probing on every app-config touch keeps a broken edit from silently
    //    breaking an already-app-mode platform.
    const currentMode = await getGitHubAuthMode(ssm);
    const targetMode = mode !== undefined ? mode : currentMode;
    const appConfigTouched =
      appId !== undefined || installationId !== undefined || privateKey !== undefined;
    let installationAccount = null;
    if (targetMode === 'app' && (mode === 'app' || appConfigTouched)) {
      if (!candidate.appId || !candidate.installationId) {
        return response(400, {
          error: 'GitHub App mode requires appId and installationId',
          code: 'APP_CONFIG_INCOMPLETE',
        });
      }
      if (!(await isPrivateKeySet())) {
        return response(400, {
          error: 'GitHub App mode requires the App private key',
          code: 'APP_CONFIG_INCOMPLETE',
        });
      }
      try {
        clearAppAuthCaches();
        const validated = await validateGitHubAppInstallation(
          secrets,
          candidate.appId,
          candidate.installationId,
        );
        installationAccount = validated.accountLogin;
      } catch (e) {
        console.error('[github-admin] app config validation failed:', e.message);
        return response(400, {
          error: `GitHub App validation failed: ${e.message}`,
          code: 'APP_CONFIG_INVALID',
        });
      }
    }

    // 4. Persist config + mode only after validation passed.
    if (appId !== undefined || installationId !== undefined) {
      await writeGitHubAppConfig(ssm, candidate);
    }
    if (mode !== undefined && mode !== currentMode) {
      await writeGitHubAuthMode(ssm, mode);
      console.log('[github-admin] auth mode changed', { from: currentMode, to: mode, by: userId });
    }

    const state = await currentState();
    return response(200, {
      ...state,
      ...(installationAccount ? { installationAccount } : {}),
    });
  } catch (err) {
    console.error('[github-admin] error:', err);
    return response(500, { error: 'Internal server error' });
  }
};
