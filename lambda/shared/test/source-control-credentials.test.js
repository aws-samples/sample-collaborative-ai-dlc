import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../git-token.js', () => ({
  discoverGitHubInstallation: vi.fn(),
  ensureFreshGitToken: vi.fn(),
  getGitHubAppIdentity: vi.fn(),
  getInstallationToken: vi.fn(),
  validateGitHubAppInstallation: vi.fn(),
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
  getGitHubAppIdentity,
  getInstallationToken,
  validateGitHubAppInstallation,
} from '../git-token.js';
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
