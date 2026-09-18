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
import {
  ACTIVE,
  appCredentialRef,
  oauthCredentialRef,
  roleCredentialRef,
} from './source-control-bindings.js';
import {
  assumeCodeCommitRole,
  isCodeCommitExternalId,
  isCodeCommitRoleArn,
  roleAccountId,
} from './codecommit-role.js';
import { parseCodeCommitRepo } from './git-providers/codecommit-repo.js';
import { signCodeCommitGitCredential } from './git-providers/codecommit-credential.js';

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
  // workflows:write is recommended, not required — an installation without it
  // binds fine but the agent cannot modify .github/workflows/ files. Never
  // request a permission the installation lacks: GitHub rejects the mint.
  const workflowsGranted = !validated.missingOptionalPermissions?.includes('workflows:write');
  const token = await getInstallationToken({
    secrets,
    appId,
    installationId: discovered.installationId,
    repositories: [repo],
    permissions: {
      contents: 'write',
      pull_requests: 'write',
      ...(workflowsGranted ? { workflows: 'write' } : {}),
    },
  });
  // The repository probe verifies the installation can SEE the repo (it
  // throws on 404/403). It must NOT gate on access.canWrite: GET /repos
  // `permissions` is user-style authority and is unreliable for installation
  // tokens (absent or all-false even with Contents: Read & write). Write
  // authority is already proven — validateGitHubAppInstallation required
  // contents:write and the repo-scoped contents:write mint above succeeded
  // (GitHub refuses to mint permissions the installation lacks).
  const [access, identity] = await Promise.all([
    getProvider('github').getRepositoryAccess({ token }, repo),
    getGitHubAppIdentity({ secrets, appId }),
  ]);
  const appAccess = { ...access, canRead: true, canWrite: true };
  return {
    authType: 'github-app',
    credentialRef: appCredentialRef(discovered.installationId),
    installationId: discovered.installationId,
    installationAccount: validated.accountLogin || discovered.installationAccount,
    actorLogin: identity.login,
    actorName: identity.name,
    actorEmail: identity.email,
    capabilities: {
      ...capabilitiesFor('github', appAccess),
      workflows: workflowsGranted ? 'write' : 'none',
      appPermissions: validated.permissions,
    },
  };
};

// CodeCommit committer identity: CodeCommit has no user-identity API, so the
// author of engine-made commits is configured on the binding. Any RFC-shaped
// address is accepted by CodeCommit (it is not validated); the default uses the
// reserved `.invalid` TLD so it can never route.
const DEFAULT_COMMITTER_NAME = 'Collaborative AI-DLC';
const defaultCommitterEmail = (accountId) => `aidlc-bot@${accountId || 'codecommit'}.invalid`;

const verifyCodeCommitRoleBinding = async ({ sts, repo, selection = {} }) => {
  if (!sts) {
    throw Object.assign(new Error('STS client is required for CodeCommit role verification'), {
      code: 'STS_UNAVAILABLE',
    });
  }
  const roleArn = String(selection.roleArn || '').trim();
  if (!isCodeCommitRoleArn(roleArn)) {
    throw Object.assign(new Error('A valid IAM role ARN is required for CodeCommit'), {
      code: 'ROLE_ARN_REQUIRED',
    });
  }
  const externalId = String(selection.externalId || '').trim();
  if (!isCodeCommitExternalId(externalId)) {
    throw Object.assign(new Error('The CodeCommit connection external ID is required'), {
      code: 'EXTERNAL_ID_REQUIRED',
    });
  }
  const target = parseCodeCommitRepo(repo);
  if (!target.arn) {
    throw Object.assign(new Error('CodeCommit repositories must be bound by ARN'), {
      code: 'INVALID_REPOSITORY',
    });
  }
  const accountId = roleAccountId(roleArn);
  // Prove the whole chain once, with the write-scoped session policy the
  // engine will use: trust policy + external ID + tenant role policy + the
  // repository actually existing. The provider probe is read-only.
  const credentials = await assumeCodeCommitRole({
    sts,
    roleArn,
    externalId,
    repoArn: target.arn,
    access: 'write',
    executionId: 'verify',
  });
  const access = await getProvider('codecommit').getRepositoryAccess(
    { token: credentials },
    target.arn,
  );
  if (!access.canRead) {
    throw Object.assign(new Error('The role cannot read the CodeCommit repository'), {
      code: 'INSUFFICIENT_REPOSITORY_ACCESS',
    });
  }
  // Write authority is what the session policy asked for; a tenant role that
  // lacks GitPush surfaces as a push failure, not a bind failure — the same
  // trade-off as github-app, where the mint is the proof.
  const roleAccess = { ...access, canRead: true, canWrite: true };
  const actorName = String(selection.committerName || '').trim() || DEFAULT_COMMITTER_NAME;
  const actorEmail =
    String(selection.committerEmail || '').trim() || defaultCommitterEmail(target.accountId);
  return {
    authType: 'codecommit-role',
    credentialRef: roleCredentialRef(roleArn),
    roleArn,
    externalId,
    roleAccountId: accountId,
    region: target.region,
    repositoryAccountId: target.accountId,
    actorLogin: credentials.assumedRoleArn || roleArn,
    actorName,
    actorEmail,
    capabilities: {
      ...capabilitiesFor('codecommit', roleAccess),
      // No issue tracker and no CI check statuses on CodeCommit.
      issues: 'none',
      workflows: 'none',
    },
  };
};

const verifyBindingCredential = async ({
  ddb,
  ssm,
  secrets,
  sts = null,
  provider,
  repo,
  authType,
  userId,
  confirmDelegation = false,
  actorName = null,
  selection = {},
}) => {
  if (authType === 'github-app') {
    if (provider !== 'github') throw new Error('GitHub App auth is only valid for GitHub');
    return verifyGitHubAppBinding({ ssm, secrets, repo });
  }
  if (authType === 'codecommit-role') {
    if (provider !== 'codecommit')
      throw new Error('CodeCommit role auth is only valid for CodeCommit');
    return verifyCodeCommitRoleBinding({ sts, repo, selection });
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
  sts = null,
  binding,
  requiredAccess = 'write',
  executionId = null,
}) => {
  if (!binding || binding.status !== ACTIVE) {
    throw Object.assign(new Error('Source-control binding is not active'), {
      code: 'BINDING_INVALID',
    });
  }
  if (binding.authType === 'codecommit-role') {
    if (
      !sts ||
      !binding.roleArn ||
      !binding.externalId ||
      binding.credentialRef !== roleCredentialRef(binding.roleArn)
    ) {
      throw Object.assign(new Error('CodeCommit role binding is incomplete'), {
        code: 'BINDING_INVALID',
      });
    }
    const target = parseCodeCommitRepo(binding.repo);
    const credentials = await assumeCodeCommitRole({
      sts,
      roleArn: binding.roleArn,
      externalId: binding.externalId,
      repoArn: target.arn,
      access: requiredAccess === 'read' ? 'read' : 'write',
      executionId,
    });
    // For git: a SigV4 signature as the Basic password — the same pair the
    // AWS credential helper emits, so git-auth.js needs no CodeCommit branch.
    // For the provider API: the STS triple itself, consumed by the SDK client.
    const git = signCodeCommitGitCredential({
      region: target.region,
      repositoryName: target.repositoryName,
      credentials,
    });
    return {
      token: credentials,
      username: git.username,
      password: git.password,
      committer:
        binding.actorName && binding.actorEmail
          ? { name: binding.actorName, email: binding.actorEmail }
          : null,
      actor: binding.actorLogin || binding.actorName || null,
    };
  }
  let token;
  let username;
  let refresh = null;
  if (binding.authType === 'github-app') {
    const { appId } = await getGitHubAppConfig(ssm);
    if (!appId || !binding.installationId) {
      throw Object.assign(new Error('GitHub App binding is incomplete'), {
        code: 'BINDING_INVALID',
      });
    }
    // Only request workflows:write when the verified binding recorded the
    // grant — asking for a permission the installation lacks makes GitHub
    // reject the whole mint.
    token = await getInstallationToken({
      secrets,
      appId,
      installationId: binding.installationId,
      repositories: [binding.repo],
      permissions:
        requiredAccess === 'read'
          ? {
              contents: 'read',
              metadata: 'read',
              issues: 'read',
              pull_requests: 'read',
            }
          : {
              contents: 'write',
              pull_requests: 'write',
              issues: 'write',
              ...(binding.capabilities?.workflows === 'write' ? { workflows: 'write' } : {}),
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
    username =
      binding.provider === 'gitlab'
        ? 'oauth2'
        : binding.provider === 'bitbucket'
          ? 'x-token-auth'
          : 'x-access-token';
    // 401 recovery for provider API calls (glFetch ctx.onRefresh): the stored
    // token can be rejected before its recorded expiry (clock skew, revocation,
    // or a refresh race that this call read mid-rotation). Refresh past the
    // rejected token and retry before anyone concludes the binding is broken.
    if (binding.provider === 'gitlab' || binding.provider === 'bitbucket') {
      const rejectedToken = token;
      refresh = () =>
        ensureFreshGitToken({
          ssm,
          secrets,
          ddb,
          item: connection,
          gitProvider: binding.provider,
          staleToken: rejectedToken,
        });
    }
  }
  return {
    token,
    username,
    ...(refresh ? { refresh } : {}),
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
  verifyCodeCommitRoleBinding,
  verifyBindingCredential,
  resolveBindingCredential,
};

export default {
  verifyBindingCredential,
  resolveBindingCredential,
};
