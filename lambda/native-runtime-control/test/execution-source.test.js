import { afterEach, describe, expect, it, vi } from 'vitest';
import { getProvider } from '../../shared/git-providers.js';
import {
  NATIVE_SOURCE_READ_TIMEOUT_MS,
  isNativeSourceBranch,
  resolveNativeSourceCommit,
} from '../execution-source.js';

const TOKEN = 'unit-test-private-source-token';
const COMMIT = 'a'.repeat(40);
const response = (value, options) => new Response(JSON.stringify(value), options);
const fixture = (provider = 'github') => {
  const repository = provider === 'gitlab' ? 'Group/Nested/Project' : 'Owner/Repo';
  const base =
    provider === 'github'
      ? 'https://api.github.com/repos/owner/repo'
      : provider === 'gitlab'
        ? 'https://gitlab.com/api/v4/projects/group%2Fnested%2Fproject'
        : 'https://api.bitbucket.org/2.0/repositories/owner/repo';
  const branch = 'release/stable';
  const defaultBody =
    provider === 'bitbucket' ? { mainbranch: { name: branch } } : { default_branch: branch };
  const commitBody = {
    name: branch,
    ...(provider === 'github'
      ? { commit: { sha: COMMIT } }
      : provider === 'gitlab'
        ? { commit: { id: COMMIT } }
        : { target: { hash: COMMIT } }),
  };
  const branchUrl = `${base}/${provider === 'github' ? 'branches' : provider === 'gitlab' ? 'repository/branches' : 'refs/branches'}/release%2Fstable`;
  const fetchImpl = vi.fn(async (url) => {
    if (url === base) return response(defaultBody);
    if (url === branchUrl) return response(commitBody);
    throw new Error('Unexpected network route');
  });
  const input = { provider, repository, branch: null, token: TOKEN, fetchImpl };
  return { input, fetchImpl, branch, base, branchUrl, defaultBody, commitBody };
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('native source commit resolution', () => {
  it.each(['github', 'gitlab', 'bitbucket'])(
    'resolves the actual %s default and exact branch commit with two bounded GETs',
    async (provider) => {
      const f = fixture(provider);
      expect(await resolveNativeSourceCommit(f.input)).toEqual({
        branch: f.branch,
        commit: COMMIT,
      });
      expect(f.fetchImpl.mock.calls.map(([url]) => url)).toEqual([f.base, f.branchUrl]);
      for (const [, options] of f.fetchImpl.mock.calls) {
        expect(options).toMatchObject({
          method: 'GET',
          redirect: 'error',
          credentials: 'omit',
          headers: { Authorization: `Bearer ${TOKEN}` },
        });
        expect(options.signal.aborted).toBe(true);
        expect(options.body).toBeUndefined();
      }
    },
  );

  it.each(['github', 'gitlab', 'bitbucket'])(
    'uses an explicit %s branch without reading or guessing default',
    async (provider) => {
      const f = fixture(provider);
      expect(await resolveNativeSourceCommit({ ...f.input, branch: f.branch })).toEqual({
        branch: f.branch,
        commit: COMMIT,
      });
      expect(f.fetchImpl).toHaveBeenCalledTimes(1);
      expect(f.fetchImpl.mock.calls[0][0]).toBe(f.branchUrl);
    },
  );

  it('accepts a full SHA-256 commit without shortening it', async () => {
    const f = fixture();
    f.commitBody.commit.sha = 'b'.repeat(64);
    expect((await resolveNativeSourceCommit(f.input)).commit).toBe('b'.repeat(64));
  });

  it.each([
    ['unsupported provider', { provider: 'custom' }],
    ['repository URL', { repository: 'https://evil.example/owner/repo' }],
    ['traversal', { repository: 'owner/..' }],
    ['credentials in repository', { repository: 'owner/repo?token=secret' }],
    ['empty token', { token: '' }],
    ['token header injection', { token: 'secret\r\nX-Test: private' }],
    ['empty branch', { branch: '' }],
    ['revision expression', { branch: 'HEAD@{1}' }],
    ['ref traversal', { branch: '../secret' }],
    ['option injection', { branch: '--upload-pack' }],
    ['lock ref', { branch: 'nested/ref.lock' }],
    ['double slash', { branch: 'nested//branch' }],
    ['trailing newline', { branch: 'develop\n' }],
  ])('rejects %s before making a request', async (_label, overrides) => {
    const f = fixture();
    await expect(resolveNativeSourceCommit({ ...f.input, ...overrides })).rejects.toMatchObject({
      code: 'NATIVE_SOURCE_RESOLUTION_FAILED',
    });
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    [
      'missing default',
      (f) => {
        f.defaultBody.default_branch = null;
      },
    ],
    [
      'malformed default',
      (f) => {
        f.defaultBody.default_branch = ['main'];
      },
    ],
    [
      'invalid default ref',
      (f) => {
        f.defaultBody.default_branch = 'bad..ref';
      },
    ],
    [
      'wrong branch identity',
      (f) => {
        f.commitBody.name = 'other-branch';
      },
    ],
    [
      'short SHA',
      (f) => {
        f.commitBody.commit.sha = 'abcdef';
      },
    ],
    [
      'uppercase SHA',
      (f) => {
        f.commitBody.commit.sha = 'A'.repeat(40);
      },
    ],
    [
      'SHA containing a newline',
      (f) => {
        f.commitBody.commit.sha = `${'a'.repeat(63)}\n`;
      },
    ],
    [
      'missing commit',
      (f) => {
        delete f.commitBody.commit;
      },
    ],
    [
      'untrusted commit shape',
      (f) => {
        f.commitBody.commit = { sha: { value: COMMIT } };
      },
    ],
  ])('rejects %s without substituting main or following links', async (_label, mutate) => {
    const f = fixture();
    mutate(f);
    await expect(resolveNativeSourceCommit(f.input)).rejects.toMatchObject({
      code: 'NATIVE_SOURCE_RESOLUTION_FAILED',
    });
    expect(f.fetchImpl.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it.each([301, 302, 307, 401, 403, 404, 500])(
    'rejects HTTP %s without reading/logging provider errors',
    async (status) => {
      const f = fixture();
      f.fetchImpl.mockResolvedValue(response({ message: TOKEN }, { status }));
      const error = await resolveNativeSourceCommit(f.input).catch((value) => value);
      expect(error.message).not.toContain(TOKEN);
      expect(error.cause).toBeUndefined();
      expect(f.fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  it('rejects a response that reports a redirected/cross-host URL even when the fake transport follows it', async () => {
    const f = fixture();
    const reply = response(f.defaultBody);
    Object.defineProperty(reply, 'url', { value: 'https://evil.example/steal' });
    f.fetchImpl.mockResolvedValue(reply);
    await expect(resolveNativeSourceCommit(f.input)).rejects.toHaveProperty('code');
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('confines the existing provider helper to the exact repository metadata route', async () => {
    const f = fixture();
    vi.spyOn(getProvider('github'), 'getDefaultBranch').mockImplementation((ctx) =>
      ctx.fetchImpl('https://evil.example/steal'),
    );
    await expect(resolveNativeSourceCommit(f.input)).rejects.toHaveProperty('code');
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects oversized bodies even when Content-Length is absent', async () => {
    const f = fixture();
    f.fetchImpl.mockResolvedValue(response({ default_branch: 'x'.repeat(256 * 1024) }));
    await expect(resolveNativeSourceCommit(f.input)).rejects.toHaveProperty('code');
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('bounds a stalled transport without relying on its AbortSignal support', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.fetchImpl.mockImplementation(() => new Promise(() => {}));
    const checked = expect(resolveNativeSourceCommit(f.input)).rejects.toMatchObject({
      code: 'NATIVE_SOURCE_RESOLUTION_FAILED',
    });
    await vi.advanceTimersByTimeAsync(NATIVE_SOURCE_READ_TIMEOUT_MS);
    await checked;
    expect(f.fetchImpl.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it('bounds body reads as well as response headers', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.fetchImpl.mockResolvedValue(new Response(new ReadableStream({ start() {} })));
    const checked = expect(resolveNativeSourceCommit(f.input)).rejects.toHaveProperty('code');
    await vi.advanceTimersByTimeAsync(NATIVE_SOURCE_READ_TIMEOUT_MS);
    await checked;
    expect(f.fetchImpl.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it('never logs raw exceptions or request tokens', async () => {
    const logs = ['log', 'info', 'warn', 'error', 'debug'].map((name) =>
      vi.spyOn(console, name).mockImplementation(() => {}),
    );
    const f = fixture();
    f.fetchImpl.mockRejectedValue(Object.assign(new Error(TOKEN), { code: TOKEN }));
    await expect(resolveNativeSourceCommit(f.input)).rejects.toMatchObject({
      message: 'The native repository branch and commit could not be verified',
      code: 'NATIVE_SOURCE_RESOLUTION_FAILED',
    });
    expect(logs.every((log) => log.mock.calls.length === 0)).toBe(true);
    expect(isNativeSourceBranch('main')).toBe(true);
  });
});
