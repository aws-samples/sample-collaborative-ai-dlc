import { getGitConnection } from './git-connection-store.js';
import {
  gitConnectionIdentity,
  isGitConnectionCreatedAt,
  isGitConnectionIdentity,
} from './git-connection-identity.js';
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

const SOURCE_READ_PERMISSIONS = Object.freeze({ contents: 'read', metadata: 'read' });
const SOURCE_READ_TIMEOUT_MS = 10_000;
const SOURCE_READ_CAPABILITIES = Object.freeze({
  repositoryRead: true,
  metadata: 'read',
  contents: 'read',
  pullRequests: 'none',
  issues: 'none',
  workflows: 'none',
  repositoryWrite: false,
});

const invalidSourceBinding = () =>
  Object.assign(new Error('Invalid read-only workflow source binding'), {
    code: 'BINDING_INVALID',
  });
const hasPublicCredentialFields = (value) =>
  Object.keys(value).some((name) =>
    /^(?:credential|connection|installation)|token|^(?:parameterName|username|password|authorization|cookie|refresh)$/i.test(
      name,
    ),
  );

const connectionUnavailable = () =>
  Object.assign(new Error('Delegated OAuth connection is unavailable or has changed'), {
    code: 'CONNECTION_REQUIRED',
  });

const sourceConnectionIdentity = (connection, provider, userId) => {
  if (connection?.provider !== provider || connection?.userId !== userId) {
    throw connectionUnavailable();
  }
  try {
    return gitConnectionIdentity(connection);
  } catch {
    throw connectionUnavailable();
  }
};

const assertConnectionGeneration = (binding, connection) => {
  if (
    !isGitConnectionCreatedAt(binding.connectionCreatedAt) ||
    !isGitConnectionIdentity(binding.connectionIdentity)
  ) {
    throw invalidSourceBinding();
  }
  if (
    sourceConnectionIdentity(connection, binding.provider, binding.connectionUserId) !==
      binding.connectionIdentity ||
    connection.createdAt !== binding.connectionCreatedAt
  ) {
    throw connectionUnavailable();
  }
};

const validInstallationId = (value) =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 20 &&
  value[0] !== '0' &&
  !/[^0-9]/.test(value);

const assertSourceIdentity = ({ provider, repo, authType }) => {
  if (
    !['github', 'gitlab', 'bitbucket'].includes(provider) ||
    (authType !== 'public' &&
      authType !== `${provider}-oauth` &&
      !(provider === 'github' && authType === 'github-app')) ||
    typeof repo !== 'string' ||
    repo.length > 512
  ) {
    throw invalidSourceBinding();
  }
  const segments = repo.split('/');
  if (
    segments.length < 2 ||
    (provider !== 'gitlab' && segments.length !== 2) ||
    segments.some(
      (segment) =>
        !segment || /[^A-Za-z0-9._-]/.test(segment) || segment === '.' || segment === '..',
    )
  ) {
    throw invalidSourceBinding();
  }
};

const sourceReadDenied = (status) =>
  Object.assign(new Error('Workflow source repository read access could not be verified'), {
    code: 'INSUFFICIENT_REPOSITORY_ACCESS',
    ...(Number.isInteger(status) ? { status } : {}),
  });

// First-page routes/shapes come from the existing providers' listBranches
// implementations. Do not use those enumeration helpers here: some mask 404,
// log rejected provider bodies, or follow arbitrary/unbounded pagination.
// A read probe needs one confirmed page, not membership or release discovery.
const verifySourceRepositoryRead = async ({
  provider,
  repo,
  token,
  refresh,
  anonymous = false,
  fetchImpl = fetch,
}) => {
  // Public access must be selected explicitly, never inferred from missing or
  // failed OAuth credentials. It cannot borrow a token or refresh callback.
  if (anonymous && (token !== undefined || refresh !== undefined)) throw invalidSourceBinding();
  if (!anonymous && (typeof token !== 'string' || !token)) {
    throw Object.assign(new Error('Workflow source credential is unavailable'), {
      code: 'CONNECTION_REQUIRED',
    });
  }
  const base = getProvider(provider).apiBase;
  const url =
    provider === 'github'
      ? `${base}/repos/${repo}/branches?per_page=100`
      : provider === 'gitlab'
        ? `${base}/projects/${encodeURIComponent(repo)}/repository/branches?per_page=100`
        : `${base}/repositories/${repo}/refs/branches?pagelen=100`;
  const controller = new AbortController();
  let activeToken = token;
  let lastStatus;
  const readPage = async () => {
    // Public reads make one GET. Authenticated reads may retry one 401 against
    // the same repository after a refresh.
    for (let attempt = 0; attempt < (anonymous ? 1 : 2); attempt += 1) {
      if (controller.signal.aborted) throw sourceReadDenied();
      const response = await fetchImpl(url, {
        method: 'GET',
        headers: {
          ...(!anonymous ? { Authorization: `Bearer ${activeToken}` } : {}),
          Accept: provider === 'github' ? 'application/vnd.github+json' : 'application/json',
        },
        ...(anonymous ? { credentials: 'omit' } : {}),
        redirect: 'error',
        signal: controller.signal,
      });
      lastStatus = response.status;
      if (!anonymous && response.status === 401 && attempt === 0 && typeof refresh === 'function') {
        activeToken = await refresh();
        if (typeof activeToken !== 'string' || !activeToken) throw connectionUnavailable();
        continue;
      }
      if (!response.ok) throw sourceReadDenied(response.status);
      const body = await response.json();
      const entries = provider === 'bitbucket' ? body?.values : body;
      if (
        !Array.isArray(entries) ||
        entries.some((entry) => typeof entry?.name !== 'string' || !entry.name)
      ) {
        throw sourceReadDenied(response.status);
      }
      // Ignore next URLs, even when valid: reading this page proves access.
      return activeToken;
    }
    throw sourceReadDenied(lastStatus);
  };
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(sourceReadDenied());
    }, SOURCE_READ_TIMEOUT_MS);
  });
  try {
    // The deadline also bounds body parsing/refresh waits, not just headers.
    // A timed-out refresh may still finish in the underlying token helper;
    // the aborted signal prevents starting another repository request.
    return await Promise.race([readPage(), timeout]);
  } catch (error) {
    if (error?.code === 'BINDING_INVALID') throw invalidSourceBinding();
    if (error?.code === 'CONNECTION_REQUIRED') throw connectionUnavailable();
    // Provider response bodies and transport errors may contain sensitive data.
    throw sourceReadDenied(lastStatus);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
};

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

const resolveCredential = async (
  { ddb, ssm, secrets, binding, requiredAccess = 'write', fetchImpl },
  sourceReadOnly = false,
) => {
  if (!binding || binding.status !== ACTIVE) {
    throw Object.assign(new Error('Source-control binding is not active'), {
      code: 'BINDING_INVALID',
    });
  }
  if (sourceReadOnly) {
    assertSourceIdentity(binding);
    if (
      binding.purpose !== 'workflow-source' ||
      binding.capabilities?.repositoryRead !== true ||
      binding.capabilities?.repositoryWrite !== false ||
      binding.capabilities?.contents !== 'read'
    ) {
      throw invalidSourceBinding();
    }
    if (binding.authType === 'public') {
      if (hasPublicCredentialFields(binding)) throw invalidSourceBinding();
      await verifySourceRepositoryRead({
        provider: binding.provider,
        repo: binding.repo,
        anonymous: true,
        fetchImpl,
      });
      // Explicit anonymous authority for intake; verified and stored rows omit
      // token fields entirely. No credential or refresh authority exists.
      return { purpose: 'workflow-source', token: null };
    }
    if (
      (binding.authType !== 'github-app' &&
        (typeof binding.connectionUserId !== 'string' ||
          !binding.connectionUserId.trim() ||
          !isGitConnectionCreatedAt(binding.connectionCreatedAt) ||
          !isGitConnectionIdentity(binding.connectionIdentity))) ||
      (binding.authType === 'github-app' &&
        (!validInstallationId(binding.installationId) ||
          binding.credentialRef !== appCredentialRef(binding.installationId)))
    ) {
      throw invalidSourceBinding();
    }
  } else if (
    binding.authType === 'public' ||
    binding.purpose === 'workflow-source' ||
    binding.capabilities?.repositoryWrite === false
  ) {
    // Never route a source binding into the application's write-capable token
    // resolver, even if its underlying OAuth connection has broader grants.
    throw invalidSourceBinding();
  }
  let token;
  let username;
  let refresh = null;
  let recheckConnection = null;
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
      ...(fetchImpl === undefined ? {} : { fetchImpl }),
      permissions: sourceReadOnly
        ? { ...SOURCE_READ_PERMISSIONS }
        : requiredAccess === 'read'
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
    if (sourceReadOnly) {
      assertConnectionGeneration(binding, connection);
      recheckConnection = async () => {
        const current = await getGitConnection(ddb, binding.connectionUserId, binding.provider);
        assertConnectionGeneration(binding, current);
        return current;
      };
    }
    // Source reads are proved against the repository API below. Do not apply
    // application write/PR/identity scope requirements to a read-only source.
    const missing = sourceReadOnly ? [] : missingScopes(connection, binding.provider);
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
      ...(fetchImpl === undefined ? {} : { fetchImpl }),
    });
    if (recheckConnection) await recheckConnection();
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
      refresh = async () => {
        const refreshConnection = recheckConnection ? await recheckConnection() : connection;
        const refreshed = await ensureFreshGitToken({
          ssm,
          secrets,
          ddb,
          item: refreshConnection,
          gitProvider: binding.provider,
          staleToken: sourceReadOnly ? token : rejectedToken,
          ...(fetchImpl === undefined ? {} : { fetchImpl }),
        });
        if (recheckConnection) await recheckConnection();
        if (sourceReadOnly) token = refreshed;
        return refreshed;
      };
    }
  }
  if (sourceReadOnly) {
    try {
      token = await verifySourceRepositoryRead({
        provider: binding.provider,
        repo: binding.repo,
        token,
        refresh,
        fetchImpl,
      });
    } finally {
      // Reject identity changes observed around the provider probe. Atomic
      // revocation also depends on guarded connection persistence and the
      // broker's authorization check before publishing package bytes.
      if (recheckConnection) await recheckConnection();
    }
  }
  return {
    ...(sourceReadOnly ? { purpose: 'workflow-source' } : {}),
    token,
    username,
    ...(refresh ? { refresh } : {}),
    committer:
      !sourceReadOnly && binding.actorName && binding.actorEmail
        ? { name: binding.actorName, email: binding.actorEmail }
        : null,
    actor: binding.actorLogin || binding.actorName || null,
  };
};

const resolveBindingCredential = (options) => resolveCredential(options);

// These helpers must be called behind the workflow-source owner's/admin's
// authorization check. They do not grant project membership or store consent.
// OAuth tokens retain their provider-side grants: do not expose them to agents
// as if they were provider-enforced read-only tokens. App tokens ARE downscoped.
const resolveReadOnlySourceCredential = (options) =>
  resolveCredential({ ...options, requiredAccess: 'read' }, true);

const verifyReadOnlySourceCredential = async ({
  ddb,
  ssm,
  secrets,
  provider,
  repo,
  authType,
  userId,
  confirmDelegation = false,
  fetchImpl,
}) => {
  assertSourceIdentity({ provider, repo, authType });
  let credential;
  if (authType === 'public') {
    credential = {
      purpose: 'workflow-source',
      authType,
      capabilities: { ...SOURCE_READ_CAPABILITIES },
    };
  } else if (authType === 'github-app') {
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
      ...(fetchImpl === undefined ? {} : { fetchImpl }),
    });
    if (
      typeof discovered.installationId === 'number' &&
      !Number.isSafeInteger(discovered.installationId)
    ) {
      throw invalidSourceBinding();
    }
    const installationId = String(discovered.installationId ?? '');
    if (!validInstallationId(installationId)) throw invalidSourceBinding();
    // Do not call the application installation validator: it intentionally
    // requires write/issue/PR permissions. The scoped mint and read probe below
    // establish this source's much smaller permission requirement.
    credential = {
      purpose: 'workflow-source',
      authType,
      credentialRef: appCredentialRef(installationId),
      installationId,
      capabilities: {
        ...SOURCE_READ_CAPABILITIES,
        appPermissions: { ...SOURCE_READ_PERMISSIONS },
      },
    };
  } else {
    if (confirmDelegation !== true) {
      throw Object.assign(new Error('OAuth delegation must be explicitly confirmed'), {
        code: 'DELEGATION_CONFIRMATION_REQUIRED',
      });
    }
    if (typeof userId !== 'string' || !userId.trim()) throw invalidSourceBinding();
    const connection = await getGitConnection(ddb, userId, provider);
    const connectionIdentity = sourceConnectionIdentity(connection, provider, userId);
    // Attribute consent to the platform connection owner. Commit attribution
    // is unnecessary here, so do not require account/read_user/email scopes or
    // call identity endpoints to manufacture a committer for a read-only source.
    credential = {
      purpose: 'workflow-source',
      authType,
      credentialRef: oauthCredentialRef(provider, userId),
      connectionUserId: userId,
      connectionCreatedAt: connection.createdAt,
      connectionIdentity,
      capabilities: { ...SOURCE_READ_CAPABILITIES },
    };
  }
  await resolveReadOnlySourceCredential({
    ddb,
    ssm,
    secrets,
    binding: { ...credential, provider, repo, status: ACTIVE },
    fetchImpl,
  });
  return credential;
};

export {
  parseScopes,
  missingScopes,
  capabilitiesFor,
  verifyOAuthBinding,
  verifyGitHubAppBinding,
  verifyBindingCredential,
  resolveBindingCredential,
  verifyReadOnlySourceCredential,
  resolveReadOnlySourceCredential,
};

export default {
  verifyBindingCredential,
  resolveBindingCredential,
  verifyReadOnlySourceCredential,
  resolveReadOnlySourceCredential,
};
