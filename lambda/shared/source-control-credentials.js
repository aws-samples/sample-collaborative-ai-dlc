import { getGitConnection } from './git-connection-store.js';
import {
  discoverGitHubInstallation,
  ensureFreshGitToken,
  getGitHubAppIdentity,
  getInstallationToken,
  validateGitHubAppInstallation,
} from './git-token.js';
import { getGitHubAppConfig } from './github-auth-config.js';
import { getProvider } from './git-providers.js';
import { ACTIVE, appCredentialRef, oauthCredentialRef } from './source-control-bindings.js';

const parseScopes = (raw) =>
  new Set(
    String(raw || '')
      .split(/[\s,]+/)
      .map((scope) => scope.trim())
      .filter(Boolean),
  );

const missingScopes = (connection, provider) => {
  const required = getProvider(provider).oauth?.requiredConnectionScopes ?? [];
  const granted = parseScopes(connection?.scope);
  return required.filter((scope) => !granted.has(scope));
};

const capabilitiesFor = (provider, access) => ({
  metadata: 'read',
  contents: access.canWrite ? 'write' : access.canRead ? 'read' : 'none',
  pullRequests: access.canWrite ? 'write' : 'read',
  issues: access.canWrite ? 'write' : 'read',
  workflows: access.canWrite ? 'write' : 'none',
  repositoryWrite: Boolean(access.canWrite),
  ...(provider === 'gitlab' ? { accessLevel: access.accessLevel } : {}),
});

const verifyOAuthBinding = async ({
  ddb,
  ssm,
  secrets,
  provider,
  repo,
  userId,
  confirmDelegation,
  actorName = null,
}) => {
  if (!confirmDelegation) {
    throw Object.assign(new Error('OAuth delegation must be explicitly confirmed'), {
      code: 'DELEGATION_CONFIRMATION_REQUIRED',
    });
  }
  const connection = await getGitConnection(ddb, userId, provider);
  if (!connection?.parameterName) {
    throw Object.assign(new Error(`${provider} is not connected for this user`), {
      code: 'CONNECTION_REQUIRED',
    });
  }
  const missing = missingScopes(connection, provider);
  if (missing.length) {
    throw Object.assign(new Error(`Connection is missing required scopes: ${missing.join(', ')}`), {
      code: 'MISSING_SCOPES',
      missingScopes: missing,
    });
  }
  const token = await ensureFreshGitToken({
    ssm,
    secrets,
    ddb,
    item: connection,
    gitProvider: provider,
  });
  const adapter = getProvider(provider);
  const [access, identity] = await Promise.all([
    adapter.getRepositoryAccess({ token }, repo),
    adapter.getAuthenticatedUser({ token }),
  ]);
  if (!access.canWrite) {
    throw Object.assign(
      new Error(
        provider === 'gitlab'
          ? 'GitLab Developer-or-higher repository access is required'
          : 'Repository write access is required',
      ),
      { code: 'INSUFFICIENT_REPOSITORY_ACCESS' },
    );
  }
  return {
    authType: `${provider}-oauth`,
    credentialRef: oauthCredentialRef(provider, userId),
    connectionUserId: userId,
    connectionDisplayName: actorName,
    actorLogin: identity.login,
    actorName: identity.authorName,
    actorEmail: identity.authorEmail,
    capabilities: capabilitiesFor(provider, access),
  };
};

const verifyGitHubAppBinding = async ({ ssm, secrets, repo }) => {
  const { appId } = await getGitHubAppConfig(ssm);
  if (!appId) {
    throw Object.assign(new Error('GitHub App ID and private key must be configured'), {
      code: 'APP_CONFIG_INCOMPLETE',
    });
  }
  const discovered = await discoverGitHubInstallation({
    secrets,
    appId,
    repository: repo,
  });
  const validated = await validateGitHubAppInstallation(secrets, appId, discovered.installationId);
  const token = await getInstallationToken({
    secrets,
    appId,
    installationId: discovered.installationId,
    repositories: [repo],
  });
  const [access, identity] = await Promise.all([
    getProvider('github').getRepositoryAccess({ token }, repo),
    getGitHubAppIdentity({ secrets, appId }),
  ]);
  if (!access.canWrite) {
    throw Object.assign(new Error('GitHub App repository write access is required'), {
      code: 'INSUFFICIENT_REPOSITORY_ACCESS',
    });
  }
  return {
    authType: 'github-app',
    credentialRef: appCredentialRef(discovered.installationId),
    installationId: discovered.installationId,
    installationAccount: validated.accountLogin || discovered.installationAccount,
    actorLogin: identity.login,
    actorName: identity.name,
    actorEmail: identity.email,
    capabilities: {
      ...capabilitiesFor('github', access),
      appPermissions: validated.permissions,
    },
  };
};

const verifyBindingCredential = async ({
  ddb,
  ssm,
  secrets,
  provider,
  repo,
  authType,
  userId,
  confirmDelegation = false,
  actorName = null,
}) => {
  if (authType === 'github-app') {
    if (provider !== 'github') throw new Error('GitHub App auth is only valid for GitHub');
    return verifyGitHubAppBinding({ ssm, secrets, repo });
  }
  if (authType !== `${provider}-oauth`) {
    throw new Error(`Invalid auth type ${authType} for ${provider}`);
  }
  return verifyOAuthBinding({
    ddb,
    ssm,
    secrets,
    provider,
    repo,
    userId,
    confirmDelegation,
    actorName,
  });
};

const resolveBindingCredential = async ({
  ddb,
  ssm,
  secrets,
  binding,
  requiredAccess = 'write',
}) => {
  if (!binding || binding.status !== ACTIVE) {
    throw Object.assign(new Error('Source-control binding is not active'), {
      code: 'BINDING_INVALID',
    });
  }
  let token;
  let username;
  if (binding.authType === 'github-app') {
    const { appId } = await getGitHubAppConfig(ssm);
    if (!appId || !binding.installationId) {
      throw Object.assign(new Error('GitHub App binding is incomplete'), {
        code: 'BINDING_INVALID',
      });
    }
    token = await getInstallationToken({
      secrets,
      appId,
      installationId: binding.installationId,
      repositories: [binding.repo],
      permissions:
        requiredAccess === 'read'
          ? { contents: 'read', metadata: 'read' }
          : {
              contents: 'write',
              pull_requests: 'write',
              issues: 'write',
              workflows: 'write',
            },
    });
    username = 'x-access-token';
  } else {
    const connection = await getGitConnection(ddb, binding.connectionUserId, binding.provider);
    if (
      !connection?.parameterName ||
      binding.credentialRef !== oauthCredentialRef(binding.provider, binding.connectionUserId)
    ) {
      throw Object.assign(new Error('Delegated OAuth connection is unavailable'), {
        code: 'CONNECTION_REQUIRED',
      });
    }
    const missing = missingScopes(connection, binding.provider);
    if (missing.length) {
      throw Object.assign(new Error(`Connection is missing scopes: ${missing.join(', ')}`), {
        code: 'MISSING_SCOPES',
      });
    }
    token = await ensureFreshGitToken({
      ssm,
      secrets,
      ddb,
      item: connection,
      gitProvider: binding.provider,
    });
    username = binding.provider === 'gitlab' ? 'oauth2' : 'x-access-token';
  }
  return {
    token,
    username,
    committer:
      binding.actorName && binding.actorEmail
        ? { name: binding.actorName, email: binding.actorEmail }
        : null,
    actor: binding.actorLogin || binding.actorName || null,
  };
};

export {
  parseScopes,
  missingScopes,
  capabilitiesFor,
  verifyOAuthBinding,
  verifyGitHubAppBinding,
  verifyBindingCredential,
  resolveBindingCredential,
};

export default {
  verifyBindingCredential,
  resolveBindingCredential,
};
