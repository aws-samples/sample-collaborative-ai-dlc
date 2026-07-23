// GitHub App discovery routes for the create-space flow. The App path must
// work without any personal OAuth connection, so these routes authenticate
// with the platform App credentials (JWT → per-installation metadata-read
// tokens) instead of the caller's connection. Any authenticated user may call
// them: they reveal only which repositories the App is installed on — the same
// set the App-mode picker showed on the platform-wide-mode design — and the
// minted tokens never leave this lambda.

import { SSMClient } from '@aws-sdk/client-ssm';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { buildResponse } from './response.js';
import { getUserId } from './git-oauth.js';
import { getGitHubAppConfig } from './github-auth-config.js';
import { getInstallationReadToken, listAppInstallations } from './git-token.js';
import githubProvider from './git-providers/github.js';

const ssm = new SSMClient({});
const secrets = new SecretsManagerClient({});

const isAppConfigured = async () => {
  const { appId } = await getGitHubAppConfig(ssm);
  return { appId, configured: Boolean(appId) };
};

// GET /github/app/status — { configured } so the create-space flow can offer
// the App path only when an admin has set the App up.
const handleAppStatus = async (response) => {
  try {
    const { configured } = await isAppConfigured();
    return response(200, { configured });
  } catch (error) {
    console.error('[github-app-discovery] status failed:', error.message);
    return response(200, { configured: false });
  }
};

// GET /github/app/repos — repositories across every installation of the App.
// Installation scoping IS the allowlist: only repos an admin granted the App
// appear here.
const handleAppRepos = async (response) => {
  const { appId, configured } = await isAppConfigured();
  if (!configured) {
    return response(409, {
      error: 'GitHub App is not configured — set it up on the Admin page',
      code: 'APP_NOT_CONFIGURED',
    });
  }
  const installations = await listAppInstallations({ secrets, appId });
  const repoLists = await Promise.all(
    installations.map(async ({ installationId }) => {
      const token = await getInstallationReadToken({ secrets, appId, installationId });
      return githubProvider.listInstallationRepos({ token });
    }),
  );
  const seen = new Set();
  const repos = [];
  for (const repo of repoLists.flat()) {
    if (seen.has(repo.fullName)) continue;
    seen.add(repo.fullName);
    repos.push(repo);
  }
  repos.sort((a, b) => a.fullName.localeCompare(b.fullName));
  return response(200, repos);
};

export const handleGitHubAppDiscovery = async (event) => {
  const response = buildResponse(event, { methods: 'GET,OPTIONS' });
  if (event.httpMethod === 'OPTIONS') return response(200, {});
  if (!getUserId(event)) return response(401, { error: 'Unauthorized' });
  if (event.httpMethod !== 'GET') return response(405, { error: 'Method not allowed' });

  try {
    if (event.path?.endsWith('/app/status')) return handleAppStatus(response);
    if (event.path?.endsWith('/app/repos')) return handleAppRepos(response);
    return response(404, { error: 'Not found' });
  } catch (error) {
    console.error('[github-app-discovery] error:', error.message);
    return response(502, { error: 'GitHub App repository discovery failed' });
  }
};
