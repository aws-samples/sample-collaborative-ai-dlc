import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  verifyCodeCommitRoleBinding,
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

describe('verifyCodeCommitRoleBinding (platform connection, #531)', () => {
  const ROLE = 'arn:aws:iam::123456789012:role/aidlc-codecommit-access';
  const OTHER_ROLE = 'arn:aws:iam::210987654321:role/someone-elses-role';
  const EXTERNAL_ID = 'aidlc:0f8fad5b-d9cb-469f-a165-70867728950e';
  const REPO = 'arn:aws:codecommit:eu-west-1:123456789012:demo';

  const ssmReturning = (value) => ({
    async send(command) {
      if (command.constructor.name === 'GetParameterCommand') {
        return { Parameter: { Value: value } };
      }
      throw new Error(`unexpected ${command.constructor.name}`);
    },
  });

  const stsOk = () => ({
    calls: [],
    async send(command) {
      this.calls.push(command);
      return {
        Credentials: {
          AccessKeyId: 'ASIA',
          SecretAccessKey: 's',
          SessionToken: 't',
          Expiration: new Date(),
        },
        AssumedRoleUser: { Arn: 'arn:aws:sts::123456789012:assumed-role/x/y' },
      };
    },
  });

  let env;
  beforeEach(() => {
    env = { ...process.env };
    process.env.CODECOMMIT_EXTERNAL_ID = EXTERNAL_ID;
    process.env.CODECOMMIT_CONNECTION_PARAM = '/aidlc/dev/codecommit-connection';
    getProvider.mockImplementation((provider) => {
      if (provider === 'codecommit') {
        return { getRepositoryAccess: async () => ({ canRead: true, canWrite: true }) };
      }
      throw new Error(`unexpected provider ${provider}`);
    });
  });

  it('takes the role from the connection and the external id from the env, ignoring the selection', async () => {
    const sts = stsOk();
    const credential = await verifyCodeCommitRoleBinding({
      ssm: ssmReturning(JSON.stringify({ roleArn: ROLE, region: 'eu-west-1' })),
      sts,
      repo: REPO,
      // A selection that tries to name a different role/external id is ignored.
      selection: { roleArn: OTHER_ROLE, externalId: 'aidlc:ffffffff-ffff-ffff-ffff-ffffffffffff' },
    });
    expect(credential.authType).toBe('codecommit-role');
    expect(credential.roleArn).toBe(ROLE);
    expect(credential.externalId).toBe(EXTERNAL_ID);
    expect(sts.calls[0].input.RoleArn).toBe(ROLE);
    expect(sts.calls[0].input.ExternalId).toBe(EXTERNAL_ID);
  });

  it('throws CODECOMMIT_NOT_CONFIGURED when no connection is set (bind returns the 409)', async () => {
    const sts = stsOk();
    await expect(
      verifyCodeCommitRoleBinding({
        ssm: ssmReturning('{}'),
        sts,
        repo: REPO,
        selection: {},
      }),
    ).rejects.toMatchObject({ code: 'CODECOMMIT_NOT_CONFIGURED' });
    // Nothing is assumed when there is no connection.
    expect(sts.calls).toHaveLength(0);
  });

  it('binds only in the connection region, even when the role allows more (review #578)', async () => {
    // One role that AWS would let reach both regions: the connection region
    // binds, the other is refused before STS (no write: see the handler test).
    const connectionSsm = ssmReturning(JSON.stringify({ roleArn: ROLE, region: 'eu-west-1' }));
    const okSts = stsOk();
    const bound = await verifyCodeCommitRoleBinding({
      ssm: connectionSsm,
      sts: okSts,
      repo: REPO,
      selection: {},
    });
    expect(bound.region).toBe('eu-west-1');
    expect(okSts.calls).toHaveLength(1);

    const deniedSts = stsOk();
    await expect(
      verifyCodeCommitRoleBinding({
        ssm: connectionSsm,
        sts: deniedSts,
        repo: 'arn:aws:codecommit:us-west-2:123456789012:demo',
        selection: {},
      }),
    ).rejects.toMatchObject({ code: 'CODECOMMIT_REGION_MISMATCH' });
    expect(deniedSts.calls).toHaveLength(0);
  });

  // Guard, not proof of the fix: runtime never read the connection region.
  // It pins that the region check stays a bind-time check only.
  it('resolveBindingCredential keeps a binding pinned to its stored region after the connection region changes', async () => {
    const sts = stsOk();
    const binding = {
      status: 'active',
      authType: 'codecommit-role',
      provider: 'codecommit',
      repo: REPO,
      roleArn: ROLE,
      externalId: EXTERNAL_ID,
      region: 'eu-west-1',
      credentialRef: `codecommit-role#${ROLE}#${EXTERNAL_ID}`,
      actorName: 'AIDLC',
      actorEmail: 'aidlc@example.com',
      actorLogin: ROLE,
    };
    const resolved = await resolveBindingCredential({
      ddb: {},
      ssm: ssmReturning(JSON.stringify({ roleArn: ROLE, region: 'us-west-2' })),
      secrets: {},
      sts,
      binding,
      requiredAccess: 'write',
      executionId: 'exec-1',
    });
    expect(resolved.token.accessKeyId).toBe('ASIA');
    expect(sts.calls).toHaveLength(1);
  });

  it('rejects an unreadable repository with INSUFFICIENT_REPOSITORY_ACCESS', async () => {
    getProvider.mockImplementation(() => ({
      getRepositoryAccess: async () => ({ canRead: false, canWrite: false }),
    }));
    await expect(
      verifyCodeCommitRoleBinding({
        ssm: ssmReturning(JSON.stringify({ roleArn: ROLE, region: 'eu-west-1' })),
        sts: stsOk(),
        repo: REPO,
        selection: {},
      }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_REPOSITORY_ACCESS' });
  });

  it('resolveBindingCredential keeps assuming the role recorded on the binding, not the one the connection now names', async () => {
    // A binding verified under role A keeps A even after the admin saves role B
    // The runtime resolver reads the binding, never the connection.
    const ROLE_B = 'arn:aws:iam::555555555555:role/new-platform-role';
    const sts = stsOk();
    getProvider.mockImplementation(() => ({
      getRepositoryAccess: async () => ({ canRead: true, canWrite: true }),
    }));
    const binding = {
      status: 'active',
      authType: 'codecommit-role',
      provider: 'codecommit',
      repo: REPO,
      roleArn: ROLE,
      externalId: EXTERNAL_ID,
      credentialRef: `codecommit-role#${ROLE}#${EXTERNAL_ID}`,
      actorName: 'AIDLC',
      actorEmail: 'aidlc@example.com',
      actorLogin: ROLE,
    };
    // The connection now names role B, but the resolver must ignore it.
    const resolved = await resolveBindingCredential({
      ddb: {},
      ssm: ssmReturning(JSON.stringify({ roleArn: ROLE_B, region: 'eu-west-1' })),
      secrets: {},
      sts,
      binding,
      requiredAccess: 'write',
      executionId: 'exec-1',
    });
    expect(resolved.token.accessKeyId).toBe('ASIA');
    expect(sts.calls[0].input.RoleArn).toBe(ROLE);
    expect(sts.calls[0].input.RoleArn).not.toBe(ROLE_B);
  });

  afterEach(() => {
    process.env = env;
  });
});
