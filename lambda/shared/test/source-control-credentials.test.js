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
  resolveBindingCredential,
} from '../source-control-credentials.js';
import {
  discoverGitHubInstallation,
  ensureFreshGitToken,
  getGitHubAppIdentity,
  getInstallationToken,
  validateGitHubAppInstallation,
} from '../git-token.js';
import { getGitConnection } from '../git-connection-store.js';
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

describe('resolveBindingCredential Bitbucket support', () => {
  const binding = {
    authType: 'bitbucket-oauth',
    provider: 'bitbucket',
    repo: 'workspace/repo',
    status: 'active',
    connectionUserId: 'u1',
    credentialRef: 'oauth#bitbucket#u1',
    capabilities: { repositoryWrite: true },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    getGitConnection.mockResolvedValue({
      userId: 'u1',
      provider: 'bitbucket',
      parameterName: '/proj/dev/git-token/bitbucket/u1',
      scope: 'account email repository pullrequest',
    });
    ensureFreshGitToken.mockResolvedValue('bb-token');
  });

  it('returns Bitbucket git credentials and retries a rejected token', async () => {
    const credential = await resolveBindingCredential({ ddb: {}, ssm: {}, secrets: {}, binding });

    expect(credential).toMatchObject({ token: 'bb-token', username: 'x-token-auth' });
    expect(typeof credential.refresh).toBe('function');

    ensureFreshGitToken.mockResolvedValue('bb-rotated');
    await expect(credential.refresh()).resolves.toBe('bb-rotated');
    expect(ensureFreshGitToken).toHaveBeenLastCalledWith(
      expect.objectContaining({ staleToken: 'bb-token', gitProvider: 'bitbucket' }),
    );
  });
});
