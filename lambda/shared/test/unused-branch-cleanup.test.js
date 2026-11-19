import { describe, expect, it, vi } from 'vitest';
import { getProvider } from '../git-providers.js';
import { deleteUnusedBranches } from '../unused-branch-cleanup.js';
import { cleanupSummary, deleteUnusedIntentBranches } from '../intent-branch-cleanup.js';

const BASE_SHA = 'base-sha';
// An in-memory repository: branch -> head, the commits the base branch
// contains, and open pull requests by source branch.
const fakeProvider = ({ branches, onBase = [BASE_SHA], openPrs = [], refuse = [] }) => {
  const heads = new Map(Object.entries(branches));
  return {
    heads,
    getDefaultBranch: vi.fn(async () => 'main'),
    listBranchesWithPrefix: vi.fn(async (_ctx, _repo, prefix) =>
      [...heads.keys()].filter((name) => name.startsWith(prefix)),
    ),
    getBranchHead: vi.fn(async (_ctx, _repo, name) => heads.get(name) ?? null),
    isCommitAncestor: vi.fn(
      async (_ctx, _repo, sha, ref) => ref === 'main' && onBase.includes(sha),
    ),
    listPullRequests: vi.fn(async (_ctx, _repo, { sourceBranch }) =>
      openPrs.includes(sourceBranch) ? [{ state: 'open', sourceBranch }] : [],
    ),
    deleteBranch: vi.fn(async (_ctx, _repo, name) => {
      if (refuse.includes(name)) throw Object.assign(new Error('protected'), { status: 403 });
      return heads.delete(name);
    }),
  };
};
const INTENT = 'aidlc/feature';
const UNIT = `${INTENT}--s0-unit-api`;
const TASK = `${INTENT}--task-1`;

describe('deleteUnusedBranches', () => {
  it('deletes the whole family of an unchanged repository, intent branch last', async () => {
    const provider = fakeProvider({
      branches: { main: BASE_SHA, [INTENT]: BASE_SHA, [UNIT]: BASE_SHA, [TASK]: BASE_SHA },
    });
    const result = await deleteUnusedBranches(provider, {}, 'org/repo', { branch: INTENT });
    expect(result).toEqual({ baseBranch: 'main', deleted: [UNIT, TASK, INTENT], kept: [] });
    expect(provider.deleteBranch.mock.calls.at(-1)[2]).toBe(INTENT);
    expect([...provider.heads.keys()]).toEqual(['main']);
  });

  it('keeps a branch whose base moved on but that has no commits of its own', async () => {
    const provider = fakeProvider({
      branches: { main: 'newer-sha', [INTENT]: BASE_SHA },
      onBase: [BASE_SHA, 'newer-sha'],
    });
    const result = await deleteUnusedBranches(provider, {}, 'org/repo', {
      branch: INTENT,
      baseBranch: 'main',
    });
    expect(result.deleted).toEqual([INTENT]);
  });

  it('keeps every branch when any branch of the family carries work', async () => {
    const provider = fakeProvider({
      branches: { main: BASE_SHA, [INTENT]: BASE_SHA, [UNIT]: 'unit-work' },
    });
    const result = await deleteUnusedBranches(provider, {}, 'org/repo', { branch: INTENT });
    expect(result.deleted).toEqual([]);
    expect(result.kept).toEqual([
      { branch: UNIT, reason: 'has_commits' },
      { branch: INTENT, reason: 'family_has_work' },
    ]);
    expect(provider.deleteBranch).not.toHaveBeenCalled();
  });

  it('keeps every branch when one is the source of an open pull request', async () => {
    const provider = fakeProvider({
      branches: { main: BASE_SHA, [INTENT]: BASE_SHA },
      openPrs: [INTENT],
    });
    const result = await deleteUnusedBranches(provider, {}, 'org/repo', { branch: INTENT });
    expect(result).toMatchObject({
      deleted: [],
      kept: [{ branch: INTENT, reason: 'open_pull_request' }],
    });
    expect(provider.listPullRequests).toHaveBeenCalledWith({}, 'org/repo', {
      sourceBranch: INTENT,
      includeTerminal: false,
    });
  });

  it('keeps a branch that moved after it was checked, and stops there', async () => {
    const provider = fakeProvider({
      branches: { main: BASE_SHA, [INTENT]: BASE_SHA, [UNIT]: BASE_SHA },
    });
    let reads = 0;
    provider.getBranchHead.mockImplementation(async (_ctx, _repo, name) =>
      name === UNIT && ++reads > 1 ? 'pushed-since' : (provider.heads.get(name) ?? null),
    );
    const result = await deleteUnusedBranches(provider, {}, 'org/repo', { branch: INTENT });
    expect(result.deleted).toEqual([]);
    expect(result.kept).toEqual([
      { branch: UNIT, reason: 'branch_changed' },
      { branch: INTENT, reason: 'family_has_work' },
    ]);
  });

  it('reports a refused deletion without throwing and keeps the intent branch', async () => {
    const provider = fakeProvider({
      branches: { main: BASE_SHA, [INTENT]: BASE_SHA, [UNIT]: BASE_SHA },
      refuse: [UNIT],
    });
    const result = await deleteUnusedBranches(provider, {}, 'org/repo', { branch: INTENT });
    expect(result.deleted).toEqual([]);
    expect(result.kept).toEqual([
      { branch: UNIT, reason: 'delete_failed', status: 403 },
      { branch: INTENT, reason: 'family_has_work' },
    ]);
  });

  it('skips branches that are already gone', async () => {
    const provider = fakeProvider({ branches: { main: BASE_SHA } });
    const result = await deleteUnusedBranches(provider, {}, 'org/repo', { branch: INTENT });
    expect(result).toEqual({ baseBranch: 'main', deleted: [], kept: [] });
    expect(provider.deleteBranch).not.toHaveBeenCalled();
  });

  it('never deletes the base or default branch', async () => {
    const provider = fakeProvider({ branches: { main: BASE_SHA, develop: BASE_SHA } });
    expect(
      await deleteUnusedBranches(provider, {}, 'org/repo', {
        branch: 'main',
        baseBranch: 'develop',
      }),
    ).toMatchObject({ deleted: [], kept: [{ branch: 'main', reason: 'base_branch' }] });
    expect(
      await deleteUnusedBranches(provider, {}, 'org/repo', {
        branch: 'develop',
        baseBranch: 'develop',
      }),
    ).toMatchObject({ deleted: [], kept: [{ branch: 'develop', reason: 'base_branch' }] });
    expect(provider.deleteBranch).not.toHaveBeenCalled();
  });

  it('refuses without a branch and when the base branch is unknown', async () => {
    const provider = fakeProvider({ branches: {} });
    await expect(deleteUnusedBranches(provider, {}, 'org/repo', {})).rejects.toMatchObject({
      status: 400,
    });
    provider.getDefaultBranch.mockResolvedValue(null);
    await expect(
      deleteUnusedBranches(provider, {}, 'org/repo', { branch: INTENT }),
    ).rejects.toMatchObject({ status: 409 });
  });
});

const fetchResponse = (data, status = 200) => ({
  ok: status < 400,
  status,
  json: async () => data,
  text: async () => JSON.stringify(data),
  headers: { get: () => null },
});

describe('provider branch primitives', () => {
  it('github lists branches by ref prefix and deletes by ref', async () => {
    const provider = getProvider('github');
    const fetchImpl = vi.fn(async (url, init) =>
      init?.method === 'DELETE'
        ? fetchResponse(null, 204)
        : fetchResponse([{ ref: `refs/heads/${UNIT}` }, { ref: `refs/heads/${INTENT}--x` }]),
    );
    const ctx = { token: 'test', fetchImpl };
    expect(await provider.listBranchesWithPrefix(ctx, 'org/repo', `${INTENT}--`)).toEqual([
      UNIT,
      `${INTENT}--x`,
    ]);
    expect(fetchImpl.mock.calls[0][0]).toContain('/git/matching-refs/heads/aidlc/feature--');
    expect(await provider.deleteBranch(ctx, 'org/repo', INTENT)).toBe(true);
    expect(fetchImpl.mock.calls[1][0]).toContain('/git/refs/heads/aidlc/feature');
    expect(fetchImpl.mock.calls[1][1].method).toBe('DELETE');
  });

  it('gitlab anchors its branch search, drains every page and keeps only true prefixes', async () => {
    const provider = getProvider('gitlab');
    let page = 0;
    const fetchImpl = vi.fn(async () =>
      fetchResponse(
        ++page === 1
          ? [
              ...Array.from({ length: 99 }, (_, i) => ({ name: `${INTENT}--task-${i}` })),
              { name: `other/${INTENT}--x` },
            ]
          : [{ name: UNIT }],
      ),
    );
    const names = await provider.listBranchesWithPrefix(
      { token: 'test', fetchImpl },
      'org/repo',
      `${INTENT}--`,
    );
    expect(names).toHaveLength(100);
    expect(names.at(-1)).toBe(UNIT);
    expect(fetchImpl.mock.calls[0][0]).toContain(`search=${encodeURIComponent(`^${INTENT}--`)}`);
    expect(fetchImpl.mock.calls[1][0]).toContain('page=2');
  });

  it.each(['github', 'gitlab', 'bitbucket'])(
    '%s distinguishes a missing branch from a refused deletion',
    async (name) => {
      const provider = getProvider(name);
      const del = (status) =>
        provider.deleteBranch(
          { token: 'test', fetchImpl: async () => fetchResponse({}, status) },
          'org/repo',
          INTENT,
        );
      expect(await del(204)).toBe(true);
      expect(await del(404)).toBe(false);
      await expect(del(403)).rejects.toMatchObject({ status: 403 });
    },
  );

  it.each(['github', 'gitlab', 'bitbucket'])('%s never returns a partial listing', async (name) => {
    const provider = getProvider(name);
    await expect(
      provider.listBranchesWithPrefix(
        { token: 'test', fetchImpl: async () => fetchResponse({}, 500) },
        'org/repo',
        `${INTENT}--`,
      ),
    ).rejects.toThrow();
  });

  it('bitbucket filters every listed page by prefix', async () => {
    const provider = getProvider('bitbucket');
    const fetchImpl = vi.fn(async (url) =>
      fetchResponse(
        url.includes('page=2')
          ? { values: [{ name: UNIT }] }
          : { values: [{ name: 'main' }], next: `${url}&page=2` },
      ),
    );
    expect(
      await provider.listBranchesWithPrefix(
        { token: 'test', fetchImpl },
        'org/repo',
        `${INTENT}--`,
      ),
    ).toEqual([UNIT]);
  });

  it('codecommit filters its branch listing and treats a missing branch as deleted', async () => {
    const provider = getProvider('codecommit');
    const arn = 'arn:aws:codecommit:eu-west-3:123456789012:demo-repo';
    const calls = [];
    const client = {
      send: async (command) => {
        const name = command.constructor.name.replace(/Command$/, '');
        calls.push({ name, input: command.input });
        if (name === 'ListBranches') return { branches: ['main', UNIT] };
        if (command.input.branchName === 'gone')
          throw Object.assign(new Error('gone'), { name: 'BranchDoesNotExistException' });
        return { deletedBranch: { branchName: command.input.branchName } };
      },
    };
    expect(await provider.listBranchesWithPrefix({ client }, arn, `${INTENT}--`)).toEqual([UNIT]);
    expect(await provider.deleteBranch({ client }, arn, INTENT)).toBe(true);
    expect(await provider.deleteBranch({ client }, arn, 'gone')).toBe(false);
    expect(calls.filter((c) => c.name === 'DeleteBranch')[0].input).toMatchObject({
      repositoryName: 'demo-repo',
      branchName: INTENT,
    });
  });
});

describe('deleteUnusedIntentBranches', () => {
  const meta = {
    executionId: 'exec-1',
    projectId: 'proj-1',
    branch: INTENT,
    gitProvider: 'gitlab',
    repos: ['group/api', { url: 'org/web' }],
    repoProviders: { 'org/web': 'github' },
    baseBranches: { 'group/api': 'develop' },
  };

  it('asks the source-control service about every repository and survives a failure', async () => {
    const operation = vi.fn(async ({ repo }) => {
      if (repo === 'org/web')
        throw Object.assign(new Error('denied'), { code: 'PROVIDER_UNAUTHORIZED' });
      return { deleted: [INTENT], kept: [] };
    });
    const results = await deleteUnusedIntentBranches({ meta, operation });
    expect(operation.mock.calls.map(([call]) => call)).toEqual([
      {
        projectId: 'proj-1',
        provider: 'gitlab',
        repo: 'group/api',
        operation: 'delete-unused-branches',
        args: { branch: INTENT, baseBranch: 'develop' },
      },
      {
        projectId: 'proj-1',
        provider: 'github',
        repo: 'org/web',
        operation: 'delete-unused-branches',
        args: { branch: INTENT, baseBranch: null },
      },
    ]);
    expect(results).toEqual([
      { repoId: 'group/api', deleted: [INTENT], kept: [] },
      { repoId: 'org/web', deleted: [], kept: [], error: 'PROVIDER_UNAUTHORIZED' },
    ]);
    expect(cleanupSummary(results)).toBe(
      'Deleted the unused intent branch from 1 unchanged repository: group/api',
    );
  });

  it('logs why each branch was kept', async () => {
    const logger = { info: vi.fn() };
    await deleteUnusedIntentBranches({
      meta: { ...meta, repos: ['group/api'] },
      operation: async () => ({
        deleted: [],
        kept: [{ branch: INTENT, reason: 'delete_failed', status: 403 }],
      }),
      logger,
    });
    expect(logger.info).toHaveBeenCalledWith('unused intent branch cleanup', {
      executionId: 'exec-1',
      deleted: 0,
      kept: [{ repoId: 'group/api', branch: INTENT, reason: 'delete_failed', status: 403 }],
      failedRepositories: [],
    });
  });

  it('does nothing without a branch or repositories', async () => {
    const operation = vi.fn();
    expect(
      await deleteUnusedIntentBranches({ meta: { ...meta, branch: null }, operation }),
    ).toEqual([]);
    expect(
      await deleteUnusedIntentBranches({ meta: { ...meta, repos: undefined }, operation }),
    ).toEqual([]);
    expect(operation).not.toHaveBeenCalled();
    expect(cleanupSummary([{ repoId: 'a', deleted: [], kept: [{ branch: INTENT }] }])).toBeNull();
  });
});
