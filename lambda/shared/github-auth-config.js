'use strict';

// Platform-wide GitHub auth mode + GitHub App configuration.
//
// Two SSM parameters (provisioned in terraform/modules/git/main.tf, seeded
// with defaults, then owned at runtime by the Admin page's "GitHub
// Integration" card):
//
//   GITHUB_AUTH_MODE_PARAM  — 'oauth' | 'app'  (String, default 'oauth')
//   GITHUB_APP_CONFIG_PARAM — '{"appId":"...","installationId":"..."}'
//
// The mode decides how EVERY GitHub operation authenticates platform-wide:
//   oauth — per-user OAuth tokens (connect flow, SSM per-user token params)
//   app   — GitHub App installation tokens (minted per repo scope; no
//           per-user connection needed)
//
// Reads are cached briefly (MODE_CACHE_TTL_MS) so hot paths don't pay an SSM
// round-trip per request while an admin's mode flip still lands within ~60s
// on warm containers (immediately on cold ones). In-flight orchestrator runs
// are unaffected either way: they snapshot/mint tokens through durable steps.

const { GetParameterCommand, PutParameterCommand } = require('@aws-sdk/client-ssm');

const MODE_CACHE_TTL_MS = 60 * 1000;

const VALID_MODES = ['oauth', 'app'];

let modeCache = null; // { value, fetchedAt }
let appConfigCache = null; // { value, fetchedAt }

const clearGitHubAuthConfigCache = () => {
  modeCache = null;
  appConfigCache = null;
};

const normalizeMode = (raw) => {
  const value = String(raw || '')
    .trim()
    .toLowerCase();
  return VALID_MODES.includes(value) ? value : 'oauth';
};

/**
 * Platform-wide GitHub auth mode. Defaults to 'oauth' when the parameter is
 * missing/unreadable — fail toward the long-standing behaviour rather than
 * toward an App config that may not exist.
 *
 * @param {import('@aws-sdk/client-ssm').SSMClient} ssm
 * @returns {Promise<'oauth'|'app'>}
 */
const getGitHubAuthMode = async (ssm) => {
  if (modeCache && Date.now() - modeCache.fetchedAt < MODE_CACHE_TTL_MS) {
    return modeCache.value;
  }
  const paramName = process.env.GITHUB_AUTH_MODE_PARAM;
  if (!paramName) return 'oauth';
  let value = 'oauth';
  try {
    const param = await ssm.send(new GetParameterCommand({ Name: paramName }));
    value = normalizeMode(param.Parameter?.Value);
  } catch (e) {
    console.error('[github-auth-config] failed to read auth mode, defaulting to oauth:', e.message);
  }
  modeCache = { value, fetchedAt: Date.now() };
  return value;
};

/**
 * GitHub App config ({ appId, installationId } — both strings or null).
 *
 * @param {import('@aws-sdk/client-ssm').SSMClient} ssm
 * @returns {Promise<{ appId: string|null, installationId: string|null }>}
 */
const getGitHubAppConfig = async (ssm) => {
  if (appConfigCache && Date.now() - appConfigCache.fetchedAt < MODE_CACHE_TTL_MS) {
    return appConfigCache.value;
  }
  const paramName = process.env.GITHUB_APP_CONFIG_PARAM;
  const empty = { appId: null, installationId: null };
  if (!paramName) return empty;
  let value = empty;
  try {
    const param = await ssm.send(new GetParameterCommand({ Name: paramName }));
    const parsed = JSON.parse(param.Parameter?.Value || '{}');
    value = {
      appId: parsed.appId ? String(parsed.appId) : null,
      installationId: parsed.installationId ? String(parsed.installationId) : null,
    };
  } catch (e) {
    console.error('[github-auth-config] failed to read app config:', e.message);
  }
  appConfigCache = { value, fetchedAt: Date.now() };
  return value;
};

/**
 * Persist the auth mode. Caller must have validated 'app' mode first (see
 * the admin endpoint's live installation probe).
 */
const writeGitHubAuthMode = async (ssm, mode) => {
  const paramName = process.env.GITHUB_AUTH_MODE_PARAM;
  if (!paramName) throw new Error('GITHUB_AUTH_MODE_PARAM env var is required');
  if (!VALID_MODES.includes(mode)) throw new Error(`Invalid GitHub auth mode: ${mode}`);
  await ssm.send(
    new PutParameterCommand({ Name: paramName, Value: mode, Type: 'String', Overwrite: true }),
  );
  clearGitHubAuthConfigCache();
};

/**
 * Persist the App config ({ appId, installationId }).
 */
const writeGitHubAppConfig = async (ssm, { appId, installationId }) => {
  const paramName = process.env.GITHUB_APP_CONFIG_PARAM;
  if (!paramName) throw new Error('GITHUB_APP_CONFIG_PARAM env var is required');
  await ssm.send(
    new PutParameterCommand({
      Name: paramName,
      Value: JSON.stringify({
        appId: appId ? String(appId) : null,
        installationId: installationId ? String(installationId) : null,
      }),
      Type: 'String',
      Overwrite: true,
    }),
  );
  clearGitHubAuthConfigCache();
};

module.exports = {
  MODE_CACHE_TTL_MS,
  VALID_MODES,
  getGitHubAuthMode,
  getGitHubAppConfig,
  writeGitHubAuthMode,
  writeGitHubAppConfig,
  clearGitHubAuthConfigCache,
};
