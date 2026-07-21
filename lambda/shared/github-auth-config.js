// Platform-level GitHub App identity configuration. OAuth and App credentials
// coexist; projects select their auth type when repository bindings are saved.
// Installation IDs are discovered per repository and never stored globally.

import { GetParameterCommand, PutParameterCommand } from '@aws-sdk/client-ssm';

const CONFIG_CACHE_TTL_MS = 60 * 1000;

let appConfigCache = null;

const clearGitHubAuthConfigCache = () => {
  appConfigCache = null;
};

const getGitHubAppConfig = async (ssm) => {
  if (appConfigCache && Date.now() - appConfigCache.fetchedAt < CONFIG_CACHE_TTL_MS) {
    return appConfigCache.value;
  }
  const paramName = process.env.GITHUB_APP_CONFIG_PARAM;
  const empty = { appId: null };
  if (!paramName) return empty;
  let value = empty;
  try {
    const param = await ssm.send(new GetParameterCommand({ Name: paramName }));
    const parsed = JSON.parse(param.Parameter?.Value || '{}');
    value = { appId: parsed.appId ? String(parsed.appId) : null };
  } catch (error) {
    console.error('[github-auth-config] failed to read app config:', error.message);
  }
  appConfigCache = { value, fetchedAt: Date.now() };
  return value;
};

const writeGitHubAppConfig = async (ssm, { appId }) => {
  const paramName = process.env.GITHUB_APP_CONFIG_PARAM;
  if (!paramName) throw new Error('GITHUB_APP_CONFIG_PARAM env var is required');
  await ssm.send(
    new PutParameterCommand({
      Name: paramName,
      Value: JSON.stringify({ appId: appId ? String(appId) : null }),
      Type: 'String',
      Overwrite: true,
    }),
  );
  clearGitHubAuthConfigCache();
};

export {
  CONFIG_CACHE_TTL_MS,
  getGitHubAppConfig,
  writeGitHubAppConfig,
  clearGitHubAuthConfigCache,
};

export default {
  CONFIG_CACHE_TTL_MS,
  getGitHubAppConfig,
  writeGitHubAppConfig,
  clearGitHubAuthConfigCache,
};
