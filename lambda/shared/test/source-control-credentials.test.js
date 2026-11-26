import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../git-token.js', () => ({
  discoverGitHubInstallation: vi.fn(),
  ensureFreshGitToken: vi.fn(),
  getGitHubAppIdentity: vi.fn(),
  getInstallationToken: vi.fn(),
  validateGitHubAppInstallation: vi.fn(),
}));
vi.mock('../git-connection-store.js', () => ({
  getGitConnection: vi.fn(),
}));
vi.mock('../github-auth-config.js', () => ({
  getGitHubAppConfig: vi.fn(),
}));
vi.mock('../git-providers.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, getProvider: vi.fn(actual.getProvider) };
});

import {
  missingScopes,
  parseScopes,
  verifyGitHubAppBinding,
  verifyBindingCredential,
  resolveBindingCredential,
  verifyReadOnlySourceCredential,
  resolveReadOnlySourceCredential,
} from '../source-control-credentials.js';
import {
  discoverGitHubInstallation,
  ensureFreshGitToken,
  getGitHubAppIdentity,
  getInstallationToken,
  validateGitHubAppInstallation,
} from '../git-token.js';
import { getGitConnection } from '../git-connection-store.js';
import { gitConnectionIdentity } from '../git-connection-identity.js';
import { getGitHubAppConfig } from '../github-auth-config.js';
import { getProvider } from '../git-providers.js';

describe('source-control credential validation', () => {
  it('normalizes comma and whitespace separated OAuth scopes', () => {
    expect([...parseScopes('repo, workflow read:user')]).toEqual(['repo', 'workflow', 'read:user']);
  });

  it('requires the complete GitHub private-repository scope set', () => {
    expect(missingScopes({ scope: 'workflow read:user' }, 'github')).toEqual(['repo']);
    expect(missingScopes({ scope: 'repo workflow read:user' }, 'github')).toEqual([]);
  });

  it('requires GitLab api and read_user scopes', () => {
    expect(missingScopes({ scope: 'api' }, 'gitlab')).toEqual(['read_user']);
    expect(missingScopes({ scope: 'api read_user' }, 'gitlab')).toEqual([]);
  });
});

describe('verifyGitHubAppBinding without workflows:write', () => {
  const ssm = {};
  const secrets = {};

  beforeEach(() => {
    vi.clearAllMocks();
    getGitHubAppConfig.mockResolvedValue({ appId: '12345' });
    discoverGitHubInstallation.mockResolvedValue({
      installationId: '67890',
      installationAccount: 'my-org',
    });
    getInstallationToken.mockResolvedValue('ghs_token');
    getGitHubAppIdentity.mockResolvedValue({
      login: 'app[bot]',
      name: 'App',
      email: 'app@users.noreply.github.com',
    });
    getProvider.mockReturnValue({
      getRepositoryAccess: vi.fn().mockResolvedValue({ canRead: true, canWrite: true }),
    });
  });

  it('binds successfully and records the reduced workflows capability', async () => {
    validateGitHubAppInstallation.mockResolvedValue({
      accountLogin: 'my-org',
      permissions: { contents: 'write', pull_requests: 'write', issues: 'write' },
      missingOptionalPermissions: ['workflows:write'],
    });

    const credential = await verifyGitHubAppBinding({ ssm, secrets, repo: 'my-org/repo' });

    expect(credential.capabilities.workflows).toBe('none');
    // The verification mint must not request the permission GitHub would reject.
    expect(getInstallationToken).toHaveBeenCalledWith(
      expect.objectContaining({
        permissions: { contents: 'write', pull_requests: 'write' },
      }),
    );
  });

  it('records workflows:write and requests it when granted', async () => {
    validateGitHubAppInstallation.mockResolvedValue({
      accountLogin: 'my-org',
      permissions: { contents: 'write', pull_requests: 'write', workflows: 'write' },
      missingOptionalPermissions: [],
    });

    const credential = await verifyGitHubAppBinding({ ssm, secrets, repo: 'my-org/repo' });

    expect(credential.capabilities.workflows).toBe('write');
    expect(getInstallationToken).toHaveBeenCalledWith(
      expect.objectContaining({
        permissions: { contents: 'write', pull_requests: 'write', workflows: 'write' },
      }),
    );
  });

  it('does not require user-style push/admin permissions on the repo probe', async () => {
    validateGitHubAppInstallation.mockResolvedValue({
      accountLogin: 'my-org',
      permissions: { contents: 'write', pull_requests: 'write', issues: 'write' },
      missingOptionalPermissions: ['workflows:write'],
    });
    // GET /repos with an installation token: `permissions` is user-authority
    // shaped and comes back absent/all-false even when the App has
    // Contents: Read & write — canWrite:false despite full write authority.
    getProvider.mockReturnValue({
      getRepositoryAccess: vi
        .fn()
        .mockResolvedValue({ canRead: true, canWrite: false, permissions: {} }),
    });

    const credential = await verifyGitHubAppBinding({ ssm, secrets, repo: 'my-org/repo' });

    expect(credential.capabilities.repositoryWrite).toBe(true);
    expect(credential.capabilities.contents).toBe('write');
  });

  it('still fails when the installation cannot see the repository at all', async () => {
    validateGitHubAppInstallation.mockResolvedValue({
      accountLogin: 'my-org',
      permissions: { contents: 'write', pull_requests: 'write', issues: 'write' },
      missingOptionalPermissions: [],
    });
    getProvider.mockReturnValue({
      getRepositoryAccess: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('Not Found'), { status: 404 })),
    });

    await expect(verifyGitHubAppBinding({ ssm, secrets, repo: 'my-org/repo' })).rejects.toThrow(
      /Not Found/,
    );
  });
});

describe('resolveBindingCredential app-binding permission scoping', () => {
  const base = {
    authType: 'github-app',
    provider: 'github',
    repo: 'my-org/repo',
    status: 'active',
    installationId: '67890',
    credentialRef: 'app#67890',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    getGitHubAppConfig.mockResolvedValue({ appId: '12345' });
    getInstallationToken.mockResolvedValue('ghs_token');
  });

  it('requests issue and pull-request permissions for read operations', async () => {
    await resolveBindingCredential({
      ddb: {},
      ssm: {},
      secrets: {},
      binding: { ...base, capabilities: { repositoryWrite: true, workflows: 'none' } },
      requiredAccess: 'read',
    });
    expect(getInstallationToken).toHaveBeenCalledWith(
      expect.objectContaining({
        permissions: {
          contents: 'read',
          metadata: 'read',
          issues: 'read',
          pull_requests: 'read',
        },
      }),
    );
  });

  it('omits workflows:write for a binding verified without it', async () => {
    await resolveBindingCredential({
      ddb: {},
      ssm: {},
      secrets: {},
      binding: { ...base, capabilities: { repositoryWrite: true, workflows: 'none' } },
    });
    expect(getInstallationToken).toHaveBeenCalledWith(
      expect.objectContaining({
        permissions: { contents: 'write', pull_requests: 'write', issues: 'write' },
      }),
    );
  });

  it('requests workflows:write for a binding verified with it', async () => {
    await resolveBindingCredential({
      ddb: {},
      ssm: {},
      secrets: {},
      binding: { ...base, capabilities: { repositoryWrite: true, workflows: 'write' } },
    });
    expect(getInstallationToken).toHaveBeenCalledWith(
      expect.objectContaining({
        permissions: {
          contents: 'write',
          pull_requests: 'write',
          issues: 'write',
          workflows: 'write',
        },
      }),
    );
  });
});

describe('resolveBindingCredential GitLab 401 retry support', () => {
  const binding = {
    authType: 'gitlab-oauth',
    provider: 'gitlab',
    repo: 'group/web',
    status: 'active',
    connectionUserId: 'u1',
    credentialRef: 'oauth#gitlab#u1',
    capabilities: { repositoryWrite: true },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    getGitConnection.mockResolvedValue({
      userId: 'u1',
      provider: 'gitlab',
      parameterName: '/proj/dev/git-token/gitlab/u1',
      scope: 'api read_user',
    });
    ensureFreshGitToken.mockResolvedValue('gl-token');
  });

  it('exposes a refresh callback that forces past the rejected token', async () => {
    const credential = await resolveBindingCredential({ ddb: {}, ssm: {}, secrets: {}, binding });
    expect(credential.token).toBe('gl-token');
    expect(typeof credential.refresh).toBe('function');

    ensureFreshGitToken.mockResolvedValue('gl-rotated');
    await expect(credential.refresh()).resolves.toBe('gl-rotated');
    expect(ensureFreshGitToken).toHaveBeenLastCalledWith(
      expect.objectContaining({ staleToken: 'gl-token', gitProvider: 'gitlab' }),
    );
  });

  it('does not expose a refresh callback for github-app bindings', async () => {
    getGitHubAppConfig.mockResolvedValue({ appId: '12345' });
    getInstallationToken.mockResolvedValue('ghs_token');
    const credential = await resolveBindingCredential({
      ddb: {},
      ssm: {},
      secrets: {},
      binding: {
        authType: 'github-app',
        provider: 'github',
        repo: 'org/repo',
        status: 'active',
        installationId: '67890',
        credentialRef: 'github-app#67890',
        capabilities: { repositoryWrite: true, workflows: 'write' },
      },
    });
    expect(credential.refresh).toBeUndefined();
  });
});

describe('read-only workflow source credentials', () => {
  const createdAt = '2026-09-18T08:00:00.000Z';
  const reconnectedAt = '2026-09-18T09:00:00.000Z';
  const clients = { ddb: {}, ssm: {}, secrets: {} };
  const scopes = { github: 'repo', gitlab: 'read_api', bitbucket: 'repository' };
  const connection = (provider) => ({
    userId: 'u1',
    provider,
    parameterName: `/proj/dev/git-token/${provider}/u1`,
    scope: scopes[provider],
    createdAt,
  });
  const binding = (provider = 'github') => ({
    purpose: 'workflow-source',
    provider,
    repo: 'group/repo',
    status: 'active',
    authType: `${provider}-oauth`,
    credentialRef: `oauth#${provider}#u1`,
    connectionUserId: 'u1',
    connectionCreatedAt: createdAt,
    connectionIdentity: gitConnectionIdentity(connection(provider)),
    // Match the source store's whitelist, not the richer application binding.
    capabilities: { repositoryRead: true, repositoryWrite: false, contents: 'read' },
  });
  const appBinding = () => ({
    ...binding(),
    authType: 'github-app',
    credentialRef: 'github-app#67890',
    installationId: '67890',
    connectionUserId: undefined,
    connectionCreatedAt: undefined,
    connectionIdentity: undefined,
  });
  const verification = (provider, fetchImpl) => ({
    ...clients,
    provider,
    repo: 'group/repo',
    authType: `${provider}-oauth`,
    userId: 'u1',
    confirmDelegation: true,
    fetchImpl,
  });
  const branchesResponse = (provider, names = ['main']) =>
    Response.json(
      provider === 'bitbucket'
        ? { values: names.map((name) => ({ name })) }
        : names.map((name) => ({ name })),
    );
  const branchUrl = (provider) =>
    ({
      github: 'https://api.github.com/repos/group/repo/branches?per_page=100',
      gitlab: 'https://gitlab.com/api/v4/projects/group%2Frepo/repository/branches?per_page=100',
      bitbucket: 'https://api.bitbucket.org/2.0/repositories/group/repo/refs/branches?pagelen=100',
    })[provider];

  beforeEach(async () => {
    vi.clearAllMocks();
    const actual = await vi.importActual('../git-providers.js');
    getProvider.mockImplementation(actual.getProvider);
    getGitConnection.mockImplementation(async (_ddb, _userId, provider) => connection(provider));
    ensureFreshGitToken.mockResolvedValue('oauth-read-token');
    getGitHubAppConfig.mockResolvedValue({ appId: '12345' });
    discoverGitHubInstallation.mockResolvedValue({
      installationId: '67890',
      installationAccount: 'group',
    });
    getInstallationToken.mockResolvedValue('app-read-token');
  });

  it.each(['github', 'gitlab', 'bitbucket'])(
    'verifies %s repository reads without write/identity scopes or identity endpoints',
    async (provider) => {
      const fetchImpl = vi.fn(async () => branchesResponse(provider));
      const verified = await verifyReadOnlySourceCredential(verification(provider, fetchImpl));
      expect(verified).toMatchObject({
        purpose: 'workflow-source',
        authType: `${provider}-oauth`,
        credentialRef: `oauth#${provider}#u1`,
        connectionUserId: 'u1',
        connectionCreatedAt: createdAt,
        connectionIdentity: gitConnectionIdentity(connection(provider)),
        capabilities: {
          repositoryRead: true,
          repositoryWrite: false,
          contents: 'read',
          pullRequests: 'none',
          issues: 'none',
          workflows: 'none',
        },
      });
      expect(verified).not.toHaveProperty('token');
      expect(verified).not.toHaveProperty('parameterName');
      expect(verified).not.toHaveProperty('actorEmail');
      expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(
        branchUrl(provider),
        expect.objectContaining({
          redirect: 'error',
          headers: expect.objectContaining({ Authorization: 'Bearer oauth-read-token' }),
        }),
      );
      expect(fetchImpl.mock.calls[0][1].method ?? 'GET').toBe('GET');
      expect(getGitConnection).toHaveBeenCalledWith(clients.ddb, 'u1', provider);
    },
  );

  it('accepts a public GitLab repository read without membership-derived access metadata', async () => {
    const fetchImpl = vi.fn(async () => branchesResponse('gitlab'));
    const verified = await verifyReadOnlySourceCredential(verification('gitlab', fetchImpl));
    expect(verified.capabilities.repositoryRead).toBe(true);
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([branchUrl('gitlab')]);
  });

  it('does not require private-repository OAuth scopes when a public repository read succeeds', async () => {
    getGitConnection.mockResolvedValue({ ...connection('github'), scope: '' });
    const verified = await verifyReadOnlySourceCredential(
      verification(
        'github',
        vi.fn(async () => branchesResponse('github')),
      ),
    );
    expect(verified.capabilities.repositoryWrite).toBe(false);
  });

  it.each(['github', 'gitlab', 'bitbucket'])(
    'accepts a confirmed empty %s branch list but rejects 404 hidden as an empty list',
    async (provider) => {
      const fetchImpl = vi.fn(async () => branchesResponse(provider, []));
      await expect(
        verifyReadOnlySourceCredential(verification(provider, fetchImpl)),
      ).resolves.toMatchObject({ purpose: 'workflow-source' });
      fetchImpl.mockImplementation(async () => Response.json({}, { status: 404 }));
      await expect(
        verifyReadOnlySourceCredential(verification(provider, fetchImpl)),
      ).rejects.toMatchObject({ code: 'INSUFFICIENT_REPOSITORY_ACCESS', status: 404 });
    },
  );

  it.each([false, undefined, 'true', 1])(
    'requires explicit OAuth delegation before touching credentials: %s',
    async (confirmDelegation) => {
      await expect(
        verifyReadOnlySourceCredential({
          ...verification('github', vi.fn()),
          confirmDelegation,
        }),
      ).rejects.toMatchObject({ code: 'DELEGATION_CONFIRMATION_REQUIRED' });
      expect(getGitConnection).not.toHaveBeenCalled();
      expect(ensureFreshGitToken).not.toHaveBeenCalled();
    },
  );

  it.each([null, { createdAt }, { parameterName: '/private/token' }])(
    'rejects unavailable or unversioned connections: %s',
    async (stored) => {
      getGitConnection.mockResolvedValue(stored);
      await expect(
        verifyReadOnlySourceCredential(verification('github', vi.fn())),
      ).rejects.toMatchObject({ code: 'CONNECTION_REQUIRED' });
      expect(ensureFreshGitToken).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, '', null, 123, 'yesterday', '2026-02-30T00:00:00.000Z', '2026-09-18'])(
    'rejects invalid connection creation times at verification and resolution: %s',
    async (invalidTime) => {
      getGitConnection.mockResolvedValue({ ...connection('github'), createdAt: invalidTime });
      await expect(
        verifyReadOnlySourceCredential(verification('github', vi.fn())),
      ).rejects.toMatchObject({ code: 'CONNECTION_REQUIRED' });
      getGitConnection.mockResolvedValue(connection('github'));
      await expect(
        resolveReadOnlySourceCredential({
          ...clients,
          binding: { ...binding(), connectionCreatedAt: invalidTime },
          fetchImpl: vi.fn(),
        }),
      ).rejects.toMatchObject({ code: 'BINDING_INVALID' });
      expect(ensureFreshGitToken).not.toHaveBeenCalled();
    },
  );

  it('rejects a reconnected OAuth generation even when credentialRef is unchanged', async () => {
    getGitConnection.mockResolvedValue({ ...connection('github'), createdAt: reconnectedAt });
    await expect(
      resolveReadOnlySourceCredential({ ...clients, binding: binding(), fetchImpl: vi.fn() }),
    ).rejects.toMatchObject({ code: 'CONNECTION_REQUIRED' });
    expect(ensureFreshGitToken).not.toHaveBeenCalled();
  });

  it.each(['github', 'gitlab', 'bitbucket'])(
    'rejects same-timestamp %s reconnects with a new parameter path or generation',
    async (provider) => {
      const fetchImpl = vi.fn();
      for (const replacement of [
        { ...connection(provider), parameterName: `/proj/dev/git-token/u1/${provider}-new` },
        { ...connection(provider), generation: '039d1c06-8e25-4a24-a31e-6bdb6b55f739' },
      ]) {
        getGitConnection.mockResolvedValue(replacement);
        await expect(
          resolveReadOnlySourceCredential({
            ...clients,
            binding: binding(provider),
            fetchImpl,
          }),
        ).rejects.toMatchObject({ code: 'CONNECTION_REQUIRED' });
      }
      expect(ensureFreshGitToken).not.toHaveBeenCalled();
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it.each([
    undefined,
    null,
    '',
    'a'.repeat(63),
    'a'.repeat(65),
    'A'.repeat(64),
    `${'a'.repeat(64)}\n`,
    '/private/token',
  ])('rejects a missing or invalid bound fingerprint before credentials: %s', async (identity) => {
    await expect(
      resolveReadOnlySourceCredential({
        ...clients,
        binding: { ...binding(), connectionIdentity: identity },
        fetchImpl: vi.fn(),
      }),
    ).rejects.toMatchObject({ code: 'BINDING_INVALID' });
    expect(getGitConnection).not.toHaveBeenCalled();
    expect(ensureFreshGitToken).not.toHaveBeenCalled();
  });

  it.each([{ provider: 'gitlab' }, { userId: 'someone-else' }])(
    'rejects a current connection row for another identity: %j',
    async (change) => {
      getGitConnection.mockResolvedValue({ ...connection('github'), ...change });
      await expect(
        verifyReadOnlySourceCredential(verification('github', vi.fn())),
      ).rejects.toMatchObject({ code: 'CONNECTION_REQUIRED' });
      await expect(
        resolveReadOnlySourceCredential({ ...clients, binding: binding(), fetchImpl: vi.fn() }),
      ).rejects.toMatchObject({ code: 'CONNECTION_REQUIRED' });
      expect(ensureFreshGitToken).not.toHaveBeenCalled();
    },
  );

  it('rejects reconnect between consent capture and provider verification', async () => {
    getGitConnection
      .mockResolvedValueOnce(connection('github'))
      .mockResolvedValue({ ...connection('github'), createdAt: reconnectedAt });
    await expect(
      verifyReadOnlySourceCredential(verification('github', vi.fn())),
    ).rejects.toMatchObject({ code: 'CONNECTION_REQUIRED' });
    expect(ensureFreshGitToken).not.toHaveBeenCalled();
  });

  it('rejects a same-timestamp reconnect between consent capture and provider verification', async () => {
    getGitConnection.mockResolvedValueOnce(connection('github')).mockResolvedValue({
      ...connection('github'),
      parameterName: '/proj/dev/git-token/u1/github-new',
      generation: '039d1c06-8e25-4a24-a31e-6bdb6b55f739',
    });
    await expect(
      verifyReadOnlySourceCredential(verification('github', vi.fn())),
    ).rejects.toMatchObject({ code: 'CONNECTION_REQUIRED' });
    expect(ensureFreshGitToken).not.toHaveBeenCalled();
  });

  it('rejects reconnect during token loading before making a repository request', async () => {
    const fetchImpl = vi.fn();
    ensureFreshGitToken.mockImplementationOnce(async () => {
      getGitConnection.mockResolvedValue({
        ...connection('github'),
        parameterName: '/proj/dev/git-token/u1/github-new',
      });
      return 'token-from-reconnected-account';
    });
    await expect(
      resolveReadOnlySourceCredential({ ...clients, binding: binding(), fetchImpl }),
    ).rejects.toMatchObject({ code: 'CONNECTION_REQUIRED' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    null,
    { ...connection('github'), createdAt: reconnectedAt },
    { ...connection('github'), parameterName: '/proj/dev/git-token/u1/github-new' },
    { ...connection('github'), generation: '039d1c06-8e25-4a24-a31e-6bdb6b55f739' },
  ])('rejects disconnect/reconnect during the provider probe', async (replacement) => {
    const fetchImpl = vi.fn(async () => {
      getGitConnection.mockResolvedValue(replacement);
      return branchesResponse('github');
    });
    await expect(
      resolveReadOnlySourceCredential({ ...clients, binding: binding(), fetchImpl }),
    ).rejects.toMatchObject({ code: 'CONNECTION_REQUIRED' });
  });

  it.each(['gitlab', 'bitbucket'])(
    'refreshes rejected %s tokens without changing delegation generation',
    async (provider) => {
      ensureFreshGitToken
        .mockResolvedValueOnce('old-token')
        .mockResolvedValueOnce('new-token')
        .mockResolvedValue('newer-token');
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(Response.json({ message: 'expired' }, { status: 401 }))
        .mockImplementation(async () => branchesResponse(provider));
      const resolved = await resolveReadOnlySourceCredential({
        ...clients,
        binding: binding(provider),
        fetchImpl,
      });
      expect(resolved).toMatchObject({
        purpose: 'workflow-source',
        token: 'new-token',
        committer: null,
      });
      expect(fetchImpl.mock.calls[1][1].headers.Authorization).toBe('Bearer new-token');
      expect(ensureFreshGitToken).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ staleToken: 'old-token', gitProvider: provider, fetchImpl }),
      );
      await expect(resolved.refresh()).resolves.toBe('newer-token');
      expect(ensureFreshGitToken).toHaveBeenLastCalledWith(
        expect.objectContaining({ staleToken: 'new-token', fetchImpl }),
      );
      getGitConnection.mockResolvedValue({ ...connection(provider), createdAt: reconnectedAt });
      const beforeRefresh = ensureFreshGitToken.mock.calls.length;
      await expect(resolved.refresh()).rejects.toMatchObject({ code: 'CONNECTION_REQUIRED' });
      expect(ensureFreshGitToken).toHaveBeenCalledTimes(beforeRefresh);
    },
  );

  it('rechecks the generation after an OAuth refresh finishes', async () => {
    const fetchImpl = vi.fn(async () => branchesResponse('gitlab'));
    const resolved = await resolveReadOnlySourceCredential({
      ...clients,
      binding: binding('gitlab'),
      fetchImpl,
    });
    ensureFreshGitToken.mockImplementationOnce(async () => {
      getGitConnection.mockResolvedValue({
        ...connection('gitlab'),
        generation: '039d1c06-8e25-4a24-a31e-6bdb6b55f739',
      });
      return 'token-from-reconnected-account';
    });
    await expect(resolved.refresh()).rejects.toMatchObject({ code: 'CONNECTION_REQUIRED' });
  });

  it('verifies a read-only GitHub App without application write/issue/PR requirements', async () => {
    discoverGitHubInstallation.mockResolvedValue({ installationId: 67890 });
    const fetchImpl = vi.fn(async () => branchesResponse('github'));
    const verified = await verifyReadOnlySourceCredential({
      ...verification('github', fetchImpl),
      authType: 'github-app',
      confirmDelegation: false,
    });
    expect(verified).toMatchObject({
      purpose: 'workflow-source',
      authType: 'github-app',
      installationId: '67890',
      credentialRef: 'github-app#67890',
      capabilities: {
        repositoryRead: true,
        repositoryWrite: false,
        contents: 'read',
        appPermissions: { contents: 'read', metadata: 'read' },
      },
    });
    expect(validateGitHubAppInstallation).not.toHaveBeenCalled();
    expect(getGitConnection).not.toHaveBeenCalled();
    expect(getGitHubAppIdentity).not.toHaveBeenCalled();
    expect(discoverGitHubInstallation).toHaveBeenCalledWith(
      expect.objectContaining({ repository: 'group/repo', fetchImpl }),
    );
    expect(getInstallationToken).toHaveBeenCalledExactlyOnceWith({
      secrets: clients.secrets,
      appId: '12345',
      installationId: '67890',
      repositories: ['group/repo'],
      permissions: { contents: 'read', metadata: 'read' },
      fetchImpl,
    });
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe('Bearer app-read-token');
  });

  it('resolves whitelisted App bindings with only repository read permissions', async () => {
    const fetchImpl = vi.fn(async () => branchesResponse('github'));
    const result = await resolveReadOnlySourceCredential({
      ...clients,
      binding: appBinding(),
      requiredAccess: 'write',
      fetchImpl,
    });
    expect(result).toMatchObject({
      purpose: 'workflow-source',
      token: 'app-read-token',
      username: 'x-access-token',
      committer: null,
    });
    expect(getInstallationToken).toHaveBeenCalledWith(
      expect.objectContaining({ permissions: { contents: 'read', metadata: 'read' }, fetchImpl }),
    );
    expect(result.refresh).toBeUndefined();
  });

  it('fails when the App cannot mint repository contents read permission', async () => {
    getInstallationToken.mockRejectedValueOnce(
      Object.assign(new Error('Read permission denied'), { code: 'APP_CREDENTIAL_FAILED' }),
    );
    const fetchImpl = vi.fn();
    await expect(
      verifyReadOnlySourceCredential({
        ...verification('github', fetchImpl),
        authType: 'github-app',
      }),
    ).rejects.toMatchObject({ code: 'APP_CREDENTIAL_FAILED' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(validateGitHubAppInstallation).not.toHaveBeenCalled();
  });

  it('requires App configuration and rejects an installation/ref mismatch before minting', async () => {
    getGitHubAppConfig.mockResolvedValueOnce({});
    await expect(
      verifyReadOnlySourceCredential({
        ...verification('github', vi.fn()),
        authType: 'github-app',
      }),
    ).rejects.toMatchObject({ code: 'APP_CONFIG_INCOMPLETE' });
    await expect(
      resolveReadOnlySourceCredential({
        ...clients,
        binding: { ...appBinding(), credentialRef: 'github-app#99999' },
        fetchImpl: vi.fn(),
      }),
    ).rejects.toMatchObject({ code: 'BINDING_INVALID' });
    expect(getInstallationToken).not.toHaveBeenCalled();
  });

  it.each(['', '067890', '-1', '67890\n', 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid discovered installation IDs: %s',
    async (installationId) => {
      discoverGitHubInstallation.mockResolvedValue({ installationId });
      await expect(
        verifyReadOnlySourceCredential({
          ...verification('github', vi.fn()),
          authType: 'github-app',
        }),
      ).rejects.toMatchObject({ code: 'BINDING_INVALID' });
      expect(getInstallationToken).not.toHaveBeenCalled();
    },
  );

  it.each([
    { purpose: undefined },
    { purpose: 'application' },
    { status: 'invalid' },
    { credentialRef: 'oauth#github#another-user' },
    { capabilities: { repositoryRead: true, repositoryWrite: true, contents: 'write' } },
    { capabilities: { repositoryWrite: false, contents: 'read' } },
  ])('rejects invalid source bindings before exposing a token: %s', async (change) => {
    await expect(
      resolveReadOnlySourceCredential({
        ...clients,
        binding: { ...binding(), ...change },
        fetchImpl: vi.fn(),
      }),
    ).rejects.toMatchObject({
      code: change.credentialRef ? 'CONNECTION_REQUIRED' : 'BINDING_INVALID',
    });
    expect(ensureFreshGitToken).not.toHaveBeenCalled();
    expect(getInstallationToken).not.toHaveBeenCalled();
  });

  it.each(['read', 'write'])(
    'refuses source bindings in the application resolver even for %s calls',
    async (requiredAccess) => {
      await expect(
        resolveBindingCredential({ ...clients, binding: binding(), requiredAccess }),
      ).rejects.toMatchObject({ code: 'BINDING_INVALID' });
      expect(ensureFreshGitToken).not.toHaveBeenCalled();
      expect(getInstallationToken).not.toHaveBeenCalled();
    },
  );

  it('rejects workflow purpose in the application resolver even if capabilities claim write', async () => {
    await expect(
      resolveBindingCredential({
        ...clients,
        binding: { ...binding(), capabilities: { repositoryWrite: true, contents: 'write' } },
      }),
    ).rejects.toMatchObject({ code: 'BINDING_INVALID' });
    expect(ensureFreshGitToken).not.toHaveBeenCalled();
  });

  it.each(['github', 'gitlab', 'bitbucket'])(
    'preserves the %s application write-scope requirement',
    async (provider) => {
      await expect(verifyBindingCredential(verification(provider, vi.fn()))).rejects.toMatchObject({
        code: 'MISSING_SCOPES',
      });
      expect(ensureFreshGitToken).not.toHaveBeenCalled();
    },
  );

  it.each(['github', 'gitlab', 'bitbucket'])(
    'preserves the %s application repository write-access requirement',
    async (provider) => {
      const actual = await vi.importActual('../git-providers.js');
      const adapter = actual.getProvider(provider);
      getGitConnection.mockResolvedValue({
        ...connection(provider),
        scope: adapter.oauth.requiredConnectionScopes.join(' '),
      });
      getProvider.mockReturnValue({
        ...adapter,
        getRepositoryAccess: vi.fn(async () => ({
          canRead: true,
          canWrite: false,
          accessLevel: 20,
        })),
        getAuthenticatedUser: vi.fn(async () => ({ login: 'reader' })),
      });
      await expect(verifyBindingCredential(verification(provider, vi.fn()))).rejects.toMatchObject({
        code: 'INSUFFICIENT_REPOSITORY_ACCESS',
      });
    },
  );

  it.each([
    { provider: undefined },
    { provider: 'unsupported' },
    { provider: 'gitlab', authType: 'github-app' },
    { authType: 'github-pat' },
    { repo: 'group/../escape' },
    { repo: 'group/repo?private=secret' },
    { repo: 'https://github.com/group/repo' },
    { repo: `g/${'x'.repeat(511)}` },
  ])('rejects unsupported source identities without provider calls: %s', async (change) => {
    await expect(
      verifyReadOnlySourceCredential({ ...verification('github', vi.fn()), ...change }),
    ).rejects.toMatchObject({ code: 'BINDING_INVALID' });
    expect(getGitConnection).not.toHaveBeenCalled();
    expect(getInstallationToken).not.toHaveBeenCalled();
  });

  it('supports GitLab subgroup repository identities', async () => {
    const fetchImpl = vi.fn(async () => branchesResponse('gitlab'));
    await verifyReadOnlySourceCredential({
      ...verification('gitlab', fetchImpl),
      repo: 'group/subgroup/repo',
    });
    expect(fetchImpl.mock.calls[0][0]).toContain('/projects/group%2Fsubgroup%2Frepo/');
  });

  it('accepts source identities at the manager’s 512-character boundary', async () => {
    const fetchImpl = vi.fn(async () => branchesResponse('github'));
    await expect(
      verifyReadOnlySourceCredential({
        ...verification('github', fetchImpl),
        repo: `g/${'x'.repeat(510)}`,
      }),
    ).resolves.toMatchObject({ purpose: 'workflow-source' });
  });

  it.each(['github', 'gitlab', 'bitbucket'])(
    'does not treat a denied %s private repository as an anonymous public fallback',
    async (provider) => {
      const fetchImpl = vi.fn(async () =>
        Response.json(
          { message: 'secret provider body', error: { message: 'private' } },
          { status: 403 },
        ),
      );
      await expect(
        verifyReadOnlySourceCredential(verification(provider, fetchImpl)),
      ).rejects.toMatchObject({
        code: 'INSUFFICIENT_REPOSITORY_ACCESS',
        status: 403,
        message: 'Workflow source repository read access could not be verified',
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    'https://attacker.invalid/collect-token',
    'https://api.bitbucket.org/2.0/repositories/group/other/refs/branches?page=2',
    branchUrl('bitbucket'),
    `${branchUrl('bitbucket')}&page=2`,
  ])('ignores Bitbucket pagination, including cycles and unsafe destinations: %s', async (next) => {
    const fetchImpl = vi.fn(async () => Response.json({ values: [{ name: 'main' }], next }));
    await expect(
      verifyReadOnlySourceCredential(verification('bitbucket', fetchImpl)),
    ).resolves.toMatchObject({ purpose: 'workflow-source' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each(['github', 'gitlab', 'bitbucket'])(
    'rejects malformed successful %s responses and preserves safe errors',
    async (provider) => {
      const fetchImpl = vi.fn(async () =>
        Response.json({ message: 'private-token-provider-error' }),
      );
      await expect(
        verifyReadOnlySourceCredential(verification(provider, fetchImpl)),
      ).rejects.toMatchObject({
        code: 'INSUFFICIENT_REPOSITORY_ACCESS',
        message: 'Workflow source repository read access could not be verified',
      });
    },
  );

  it.each(['gitlab', 'bitbucket'])('bounds repeated %s 401s to two GETs', async (provider) => {
    const fetchImpl = vi.fn(async () => Response.json({ message: 'expired' }, { status: 401 }));
    await expect(
      resolveReadOnlySourceCredential({ ...clients, binding: binding(provider), fetchImpl }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_REPOSITORY_ACCESS', status: 401 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(ensureFreshGitToken).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      branchUrl(provider),
      branchUrl(provider),
    ]);
  });

  it.each(['headers', 'body'])(
    'bounds stalled response %s with a ten-second deadline',
    async (part) => {
      vi.useFakeTimers();
      try {
        const never = new Promise(() => {});
        const fetchImpl = vi.fn(async () =>
          part === 'headers' ? never : { ok: true, status: 200, json: () => never },
        );
        const result = resolveReadOnlySourceCredential({
          ...clients,
          binding: binding(),
          fetchImpl,
        });
        const rejected = expect(result).rejects.toMatchObject({
          code: 'INSUFFICIENT_REPOSITORY_ACCESS',
        });
        await vi.advanceTimersByTimeAsync(10_000);
        await rejected;
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(fetchImpl.mock.calls[0][1].signal.aborted).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('does not start another GET when a refresh completes after the deadline', async () => {
    vi.useFakeTimers();
    try {
      let finishRefresh;
      ensureFreshGitToken.mockResolvedValueOnce('old-token').mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishRefresh = resolve;
          }),
      );
      const fetchImpl = vi.fn(async () => Response.json({ message: 'expired' }, { status: 401 }));
      const result = resolveReadOnlySourceCredential({
        ...clients,
        binding: binding('gitlab'),
        fetchImpl,
      });
      const rejected = expect(result).rejects.toMatchObject({
        code: 'INSUFFICIENT_REPOSITORY_ACCESS',
      });
      await vi.advanceTimersByTimeAsync(10_000);
      await rejected;
      finishRefresh('late-token');
      await vi.advanceTimersByTimeAsync(1);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
