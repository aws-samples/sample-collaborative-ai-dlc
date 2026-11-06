import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { prepareBinding } from '../../shared/source-control-bindings.js';
import { sourceCredentialIdentity } from '../../shared/source-credential-identity.js';
import { resolveNativeSourceCommit } from '../../shared/native-application-source.js';
import { captureNativeSource } from '../native-source.js';

const credentials = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock('../../shared/source-control-credentials.js', () => ({
  resolveBindingCredential: credentials.resolve,
}));
beforeEach(() => {
  vi.stubEnv('SOURCE_CONTROL_BINDINGS_TABLE', 'source-bindings');
  vi.stubEnv('GIT_PROVIDER_CONNECTIONS_TABLE', 'git-connections');
  credentials.resolve
    .mockReset()
    .mockResolvedValue({ token: 'fixture-token', username: 'fixture-user' });
});
afterEach(() => vi.unstubAllEnvs());
const fixture = (provider = 'github') => {
  const state = {
    binding: prepareBinding({
      projectId: 'project',
      provider,
      repo: 'owner/repo',
      authType: `${provider}-oauth`,
      connectionUserId: 'owner',
      credentialRef: `oauth#${provider}#owner`,
      capabilities: { repositoryWrite: true },
    }),
    connection: {
      userId: 'owner',
      provider,
      providerInstance: `${provider}#public`,
      parameterName: `/fixture/${provider}/owner`,
      generation: 'original',
      status: 'active',
    },
    members: new Set(['starter', 'owner']),
    repos: [{ provider, repo: 'owner/repo' }],
    commit: 'a'.repeat(40),
  };
  const fetchImpl = vi.fn(async (url) => {
    const pathname = new URL(url).pathname;
    if (pathname.includes('/branches/') || pathname.includes('/refs/branches/'))
      return Response.json(
        provider === 'github'
          ? { name: 'main', commit: { sha: state.commit } }
          : provider === 'gitlab'
            ? { name: 'main', commit: { id: state.commit } }
            : { name: 'main', target: { hash: state.commit } },
      );
    return Response.json(
      provider === 'bitbucket' ? { mainbranch: { name: 'main' } } : { default_branch: 'main' },
    );
  });
  const ddb = {
    send: vi.fn(async (command) => {
      expect(command.input.ConsistentRead).toBe(true);
      if (command.input.TableName === 'source-bindings')
        return { Item: structuredClone(state.binding) };
      expect(command.input.Key).toEqual({
        userId: 'owner',
        providerInstance: `${provider}#public`,
      });
      return { Item: structuredClone(state.connection) };
    }),
  };
  const input = {
    projectId: 'project',
    userId: 'starter',
    provider,
    repository: 'owner/repo',
    bindingRevision: state.binding.revision,
  };
  const run = () =>
    captureNativeSource({
      input,
      ddb,
      ssm: {},
      secrets: {},
      membership: async (id) => (state.members.has(id) ? 'member' : null),
      repositories: async () => structuredClone(state.repos),
      resolveCommit: async (args) => {
        const source = await resolveNativeSourceCommit({ ...args, fetchImpl });
        await state.afterResolve?.();
        return source;
      },
    });
  return { state, input, run, ddb, fetchImpl };
};
it.each(['github', 'gitlab', 'bitbucket'])(
  'captures an exact %s commit using its existing credential owner',
  async (provider) => {
    const f = fixture(provider);
    const source = await f.run();
    expect(source).toEqual({
      branch: 'main',
      commit: f.state.commit,
      bindingRevision: f.input.bindingRevision,
      credentialIdentity: sourceCredentialIdentity(f.state.binding, f.state.connection),
    });
    expect(f.fetchImpl).toHaveBeenCalledTimes(2);
    expect(credentials.resolve).toHaveBeenCalledWith(
      expect.objectContaining({
        binding: f.state.binding,
        requiredAccess: 'read',
      }),
    );
    expect(JSON.stringify(source)).not.toMatch(/fixture-token|parameterName|username/);
  },
);
it.each([
  ['starter membership revoked', (f) => f.state.members.delete('starter')],
  ['delegator membership revoked', (f) => f.state.members.delete('owner')],
  [
    'repository detached',
    (f) => {
      f.state.repos = [];
    },
  ],
  [
    'binding replaced',
    (f) => {
      f.state.binding.revision = 'changed';
    },
  ],
  [
    'connection replaced',
    (f) => {
      f.state.connection.generation = 'replacement';
    },
  ],
  [
    'connection revoked',
    (f) => {
      f.state.connection.status = 'deleted';
    },
  ],
])('rejects %s during commit resolution', async (_name, mutate) => {
  const f = fixture();
  f.state.afterResolve = () => mutate(f);
  await expect(f.run()).rejects.toThrow();
});
it('allows token rotation within the captured connection identity', async () => {
  const f = fixture();
  const original = sourceCredentialIdentity(f.state.binding, f.state.connection);
  f.state.afterResolve = () => {
    f.state.connection.updatedAt = 'later';
    f.state.connection.scope = 'repo';
  };
  expect((await f.run()).credentialIdentity).toBe(original);
});
it.each([
  { repository: '../another/repo' },
  { repository: 'https://evil.test/owner/repo' },
  { provider: 'codecommit' },
  { userId: 'outsider' },
  { bindingRevision: 'different' },
])('denies invalid or substituted source scope %j before credential use', async (patch) => {
  const f = fixture();
  Object.assign(f.input, patch);
  await expect(f.run()).rejects.toThrow();
  expect(credentials.resolve).not.toHaveBeenCalled();
  expect(f.fetchImpl).not.toHaveBeenCalled();
});
