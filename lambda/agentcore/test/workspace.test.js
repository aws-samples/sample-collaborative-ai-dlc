import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtemp,
  mkdir,
  rm,
  writeFile,
  lstat,
  readlink,
  readFile,
  stat,
  symlink as createSymlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  checkoutRepo,
  checkoutRepos,
  ensureWorkspaceSource,
  redirectHeavyDirs,
} from '../workspace.js';
import { repoTargetDir, runGit } from '../git-engine.js';
import { HOOKS_DISABLED_ARGS } from '../git-runner.js';

// redirectHeavyDirs (2026-07 ENOSPC incident #2): node_modules must live on
// container-local disk, never on the session mount — the mount's write/backup
// pipeline chokes on a single npm install while `df` still reports 0% used.
// Exercised against a REAL filesystem in throwaway dirs: `ws` stands in for
// the mount, `off` for container-local /tmp.

let root;
let ws; // the "session mount" workspace
let off; // the "container-local" off-mount root

const pkg = async (dir) => {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'package.json'), '{"name":"x"}');
};

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'workspace-'));
  ws = path.join(root, 'ws');
  off = path.join(root, 'off');
  await mkdir(ws, { recursive: true });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe('repository directory safety', () => {
  it.each(['owner/.', 'owner/..', 'owner/../other', '../outside', '/owner/repo', 'owner//repo'])(
    'rejects %s before filesystem changes, including failed-clone cleanup',
    async (url) => {
      const sibling = path.join(ws, 'owner', 'keep');
      await mkdir(sibling, { recursive: true });
      const marker = path.join(sibling, 'keep.txt');
      await writeFile(marker, 'existing checkout');
      const ensureDir = vi.fn(async () => {});
      const runner = vi.fn(async () => ({ code: 0 }));
      const withGitCredential = vi.fn(async () => {
        throw new Error('credential_unavailable');
      });
      const options = {
        repos: ['owner/keep', url],
        workspaceDir: ws,
        runner,
        withGitCredential,
        ensureDir,
        trustDirectory: async () => true,
      };

      await expect(checkoutRepos(options)).rejects.toThrow('Invalid repository path');
      await expect(ensureWorkspaceSource(options)).rejects.toThrow('Invalid repository path');
      await expect(checkoutRepo({ ...options, repo: url, targetDir: ws })).rejects.toThrow(
        'Invalid repository path',
      );
      expect(await readFile(marker, 'utf8')).toBe('existing checkout');
      expect(ensureDir).not.toHaveBeenCalled();
      expect(runner).not.toHaveBeenCalled();
      expect(withGitCredential).not.toHaveBeenCalled();
      expect(() => repoTargetDir({ url, workspaceDir: ws, multi: true })).toThrow(
        'Invalid repository path',
      );
    },
  );

  it.each(['owner/-repo', 'owner/.github', 'owner/test...plop', 'team/subgroup/repo'])(
    'keeps %s inside the workspace for checkout and lane operations',
    async (url) => {
      const expected = path.join(ws, url);
      expect(repoTargetDir({ url, workspaceDir: ws, multi: true })).toBe(expected);
      const runner = vi.fn(async () => ({ code: 0 }));
      const results = await checkoutRepos({
        repos: [url, 'owner/other'],
        workspaceDir: ws,
        runner,
        trustDirectory: async () => true,
        withGitCredential: async (_context, operation) => operation({ env: {} }),
      });
      expect(results[0]).toMatchObject({ targetDir: expected, cloned: true });
      expect((await stat(expected)).isDirectory()).toBe(true);
      expect(runner.mock.calls.some(([, args]) => args.includes(expected))).toBe(true);
    },
  );
});

describe('CodeCommit checkout identity', () => {
  const west1 = 'arn:aws:codecommit:eu-west-1:123456789012:app';
  const west2 = 'arn:aws:codecommit:eu-west-2:123456789012:app';

  it('clones same-name repositories from two regions into their own directories', async () => {
    const runner = vi.fn(async () => ({ code: 0 }));
    const results = await checkoutRepos({
      repos: [
        { url: west1, provider: 'codecommit' },
        { url: west2, provider: 'codecommit' },
      ],
      workspaceDir: ws,
      runner,
      trustDirectory: async () => true,
      withGitCredential: async (_context, operation) => operation({ env: {} }),
    });
    const dir1 = path.join(ws, 'codecommit/aws/eu-west-1/123456789012/app');
    const dir2 = path.join(ws, 'codecommit/aws/eu-west-2/123456789012/app');
    expect(results.map((r) => r.targetDir)).toEqual([dir1, dir2]);
    expect(results.every((r) => r.cloned)).toBe(true);
    // Each clone targets its own directory and its own regional endpoint.
    const clones = runner.mock.calls.filter(([, args]) => args.includes('clone'));
    expect(clones).toHaveLength(2);
    expect(clones[0][1]).toEqual(
      expect.arrayContaining(['https://git-codecommit.eu-west-1.amazonaws.com/v1/repos/app']),
    );
    expect(clones[1][1]).toEqual(
      expect.arrayContaining(['https://git-codecommit.eu-west-2.amazonaws.com/v1/repos/app']),
    );
  });

  it('refuses a batch whose repositories would share a directory before touching anything', async () => {
    const runner = vi.fn(async () => ({ code: 0 }));
    const ensureDir = vi.fn(async () => {});
    const withGitCredential = vi.fn();
    const options = {
      repos: [
        { url: 'codecommit/aws', provider: 'gitlab' },
        { url: west1, provider: 'codecommit' },
      ],
      workspaceDir: ws,
      runner,
      ensureDir,
      withGitCredential,
      trustDirectory: async () => true,
    };
    await expect(checkoutRepos(options)).rejects.toMatchObject({
      code: 'REPOSITORY_PATH_COLLISION',
    });
    await expect(ensureWorkspaceSource(options)).rejects.toMatchObject({
      code: 'REPOSITORY_PATH_COLLISION',
    });
    expect(ensureDir).not.toHaveBeenCalled();
    expect(runner).not.toHaveBeenCalled();
    expect(withGitCredential).not.toHaveBeenCalled();
  });
});

describe('checkoutRepo Git isolation', () => {
  it('passes the protected runner to custom directory-trust callbacks', async () => {
    const runner = vi.fn(async () => ({ code: 0 }));
    const trustDirectory = async ({ runner: trustRunner }) => {
      const result = await trustRunner('git', ['config', '--global', '--get', 'safe.directory']);
      return result.code === 0;
    };

    const result = await checkoutRepo({
      repo: 'acme/api',
      targetDir: ws,
      branch: 'main',
      runner,
      trustDirectory,
      statFn: async () => ({ isDirectory: () => true }),
      readGitConfig: async () => '',
    });

    expect(result).toMatchObject({ cloned: true, reused: true, branchOk: true });
    expect(runner).toHaveBeenCalledTimes(3);
    for (const [, args] of runner.mock.calls) {
      expect(args.slice(0, HOOKS_DISABLED_ARGS.length)).toEqual(HOOKS_DISABLED_ARGS);
      expect(args.filter((arg) => arg === 'core.hooksPath=/dev/null')).toHaveLength(1);
    }
  });

  it.each([false, true])(
    'ignores ambient repository overrides with the production runner (warm checkout: %s)',
    async (warm) => {
      vi.stubEnv('GIT_CONFIG_GLOBAL', path.join(root, 'global.gitconfig'));
      vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
      const git = async (args, cwd = root) => {
        const result = await runGit(args, { cwd });
        expect(result.exitCode, result.stderr).toBe(0);
        return result.stdout.trim();
      };
      const remote = path.join(root, 'remote');
      const cleanUrl = 'https://github.com/acme/api.git';
      await git(['init', '-b', 'main', remote]);
      await writeFile(path.join(remote, 'README.md'), 'seed\n');
      await git(['add', '-A'], remote);
      await git(
        [
          '-c',
          'user.name=Workspace Test',
          '-c',
          'user.email=workspace@test',
          'commit',
          '-m',
          'seed',
        ],
        remote,
      );
      const seed = await git(['rev-parse', 'HEAD'], remote);
      await git(['config', '--global', `url.${pathToFileURL(remote).href}.insteadOf`, cleanUrl]);
      if (warm) await git(['clone', cleanUrl, ws]);

      const ambient = {
        GIT_DIR: path.join(root, 'bogus.git'),
        GIT_WORK_TREE: path.join(root, 'bogus-worktree'),
        GIT_INDEX_FILE: path.join(root, 'bogus-index'),
      };
      for (const [key, value] of Object.entries(ambient)) vi.stubEnv(key, value);
      const withGitCredential = vi.fn(async (_context, operation) =>
        operation({ env: { GIT_TERMINAL_PROMPT: '0' } }),
      );

      const result = await checkoutRepo({
        repo: 'acme/api',
        targetDir: ws,
        branch: 'aidlc/test',
        withGitCredential,
      });

      expect(result).toMatchObject({ cloned: true, branchOk: true });
      expect(Boolean(result.reused)).toBe(warm);
      expect(withGitCredential).toHaveBeenCalledTimes(warm ? 0 : 1);
      expect(await git(['branch', '--show-current'], ws)).toBe('aidlc/test');
      expect(await git(['rev-parse', 'HEAD'], ws)).toBe(seed);
      expect(await git(['config', '--local', '--get', 'remote.origin.url'], ws)).toBe(cleanUrl);
      expect(await git(['config', '--global', '--get-all', 'safe.directory'])).toBe(ws);
      await expect(stat(ambient.GIT_INDEX_FILE)).rejects.toMatchObject({ code: 'ENOENT' });
      for (const [key, value] of Object.entries(ambient)) expect(process.env[key]).toBe(value);
    },
    30_000,
  );
});

describe('redirectHeavyDirs', () => {
  it('symlinks node_modules for every package.json dir (root + nested) to the off-mount root', async () => {
    await pkg(ws);
    await pkg(path.join(ws, 'frontend'));
    // A dir WITHOUT package.json gets no link.
    await mkdir(path.join(ws, 'docs'), { recursive: true });

    const res = await redirectHeavyDirs({ workspaceDir: ws, offMountRoot: off });
    expect(res.links.map((l) => l.action)).toEqual(['created', 'created']);

    for (const [dir, targetKey] of [
      [ws, 'root'],
      [path.join(ws, 'frontend'), 'frontend'],
    ]) {
      const link = path.join(dir, 'node_modules');
      expect((await lstat(link)).isSymbolicLink()).toBe(true);
      expect(await readlink(link)).toBe(path.join(off, targetKey, 'node_modules'));
      // The target exists — an install can write through immediately.
      expect((await stat(link)).isDirectory()).toBe(true);
    }
    let missing = false;
    await lstat(path.join(ws, 'docs', 'node_modules')).catch(() => {
      missing = true;
    });
    expect(missing).toBe(true);
  });

  it('writes through the link land off-mount, not on the workspace', async () => {
    await pkg(ws);
    await redirectHeavyDirs({ workspaceDir: ws, offMountRoot: off });
    // Simulate npm: write a module through the workspace-side path.
    await mkdir(path.join(ws, 'node_modules', 'left-pad'), { recursive: true });
    await writeFile(path.join(ws, 'node_modules', 'left-pad', 'index.js'), 'x');
    // The bytes physically live under the off-mount root.
    const offSide = await readFile(
      path.join(off, 'root', 'node_modules', 'left-pad', 'index.js'),
      'utf8',
    );
    expect(offSide).toBe('x');
  });

  it('is idempotent and HEALS a dangling link after a container swap (fresh /tmp)', async () => {
    await pkg(ws);
    await redirectHeavyDirs({ workspaceDir: ws, offMountRoot: off });
    // Container swap: the mount (ws) survives, /tmp (off) is gone.
    await rm(off, { recursive: true, force: true });
    const res = await redirectHeavyDirs({ workspaceDir: ws, offMountRoot: off });
    expect(res.links[0].action).toBe('kept');
    // The dangling link resolves again — target re-created empty.
    expect((await stat(path.join(ws, 'node_modules'))).isDirectory()).toBe(true);
  });

  it('REPLACES a real node_modules directory (pre-fix session) with the link', async () => {
    await pkg(ws);
    await mkdir(path.join(ws, 'node_modules', 'left-pad'), { recursive: true });
    const res = await redirectHeavyDirs({ workspaceDir: ws, offMountRoot: off });
    expect(res.links[0].action).toBe('replaced');
    expect((await lstat(path.join(ws, 'node_modules'))).isSymbolicLink()).toBe(true);
  });

  it('never walks INTO node_modules, .git, or build output dirs', async () => {
    await pkg(ws);
    // package.json files inside skip-dirs must not produce links.
    await pkg(path.join(ws, 'node_modules', 'dep'));
    await pkg(path.join(ws, '.git', 'weird'));
    await pkg(path.join(ws, 'dist', 'bundle'));
    // Wait: pkg(ws/node_modules/dep) created a REAL node_modules at the root…
    // which is exactly the pre-fix shape — the root link replaces it, and the
    // nested package.json disappears with it. The point: only ONE link, at ws.
    const res = await redirectHeavyDirs({ workspaceDir: ws, offMountRoot: off });
    expect(res.links).toHaveLength(1);
    expect(res.links[0].dir).toBe(ws);
  });

  it('a per-dir failure is reported as a value and does not block the other links', async () => {
    await pkg(ws);
    await pkg(path.join(ws, 'frontend'));
    let calls = 0;
    const {
      mkdir: realMkdir,
      readdir,
      rm: realRm,
      symlink,
      lstat: realLstat,
    } = await import('node:fs/promises');
    const res = await redirectHeavyDirs({
      workspaceDir: ws,
      offMountRoot: off,
      log: () => {},
      fsOps: {
        mkdir: async (...a) => {
          calls += 1;
          if (calls === 1) throw new Error('EACCES boom');
          return realMkdir(...a);
        },
        readdir,
        rm: realRm,
        symlink,
        lstat: realLstat,
      },
    });
    const actions = res.links.map((l) => l.action).toSorted();
    expect(actions).toEqual(['created', 'failed']);
    expect(res.links.find((l) => l.action === 'failed').detail).toContain('EACCES');
  });

  it('sets no pnpm environment for npm and yarn projects', async () => {
    await pkg(ws);
    await pkg(path.join(ws, 'frontend'));
    await writeFile(path.join(ws, 'package-lock.json'), '{}');
    await writeFile(path.join(ws, 'frontend', 'yarn.lock'), '');
    await writeFile(
      path.join(ws, 'frontend', 'package.json'),
      '{"name":"x","packageManager":"yarn@4.5.0"}',
    );

    const res = await redirectHeavyDirs({ workspaceDir: ws, offMountRoot: off });
    expect(res.links.map((l) => l.action)).toEqual(['created', 'created']);
    expect(res.env).toEqual({});
  });
});

// pnpm refuses a symlinked node_modules, so a pnpm install root keeps a real
// directory and the engine owns node_modules/.pnpm — the virtual store — as a
// link to the off-mount directory instead. The virtual store stays at pnpm's
// default location (per install root by construction), so `pnpm dlx` temp
// projects never share it and any number of pnpm roots works.
describe('redirectHeavyDirs — pnpm install roots', () => {
  const store = () => path.join(root, 'cache', 'pnpm-store');
  const redirect = () =>
    redirectHeavyDirs({ workspaceDir: ws, offMountRoot: off, pnpmStoreDir: store() });
  const absent = (p) =>
    lstat(p).then(
      () => false,
      () => true,
    );
  // What pnpm writes after an install; storeDir gets a layout-version suffix.
  const modulesYaml = (dir, { storeDir, virtualStoreDir = '.pnpm' } = {}) =>
    writeFile(
      path.join(dir, 'node_modules', '.modules.yaml'),
      `{\n  "storeDir": "${storeDir ?? path.join(store(), 'v10')}",\n` +
        `  "virtualStoreDir": "${virtualStoreDir}",\n  "virtualStoreDirMaxLength": 120\n}\n`,
    );
  const expectEnginePnpmLayout = async (dir, key) => {
    expect((await lstat(path.join(dir, 'node_modules'))).isDirectory()).toBe(true);
    expect(await readlink(path.join(dir, 'node_modules', '.pnpm'))).toBe(
      path.join(off, key, '.pnpm'),
    );
    expect((await stat(path.join(off, key, '.pnpm'))).isDirectory()).toBe(true);
  };

  const markers = {
    'pnpm-lock.yaml': (dir) =>
      writeFile(path.join(dir, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n"),
    'pnpm-workspace.yaml': (dir) =>
      writeFile(path.join(dir, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n"),
    'a pnpm packageManager field': (dir) =>
      writeFile(path.join(dir, 'package.json'), '{"name":"x","packageManager":"pnpm@10.34.9"}'),
  };

  it.each(Object.keys(markers))(
    'gives a root marked by %s a real node_modules with an off-mount .pnpm link',
    async (marker) => {
      await pkg(ws);
      await markers[marker](ws);

      const res = await redirect();

      expect(res.links).toEqual([
        { dir: ws, target: path.join(off, 'root', '.pnpm'), action: 'linked' },
      ]);
      await expectEnginePnpmLayout(ws, 'root');
      expect(res.env).toEqual({ npm_config_store_dir: store() });
    },
  );

  it.each([
    ['another package manager', '{"name":"x","packageManager":"npm@11.6.0"}'],
    ['a packageManager that is not a string', '{"name":"x","packageManager":{"name":"pnpm@10"}}'],
    ['a package.json that is not valid JSON', '{"packageManager":"pnpm@10.34.9"'],
  ])('still links a root with %s', async (_label, packageJson) => {
    await pkg(ws);
    await writeFile(path.join(ws, 'package.json'), packageJson);

    const res = await redirect();

    expect(res.links.map((l) => l.action)).toEqual(['created']);
    expect((await lstat(path.join(ws, 'node_modules'))).isSymbolicLink()).toBe(true);
    expect(res.env).toEqual({});
  });

  it('replaces the whole-directory link an earlier run created with the real layout', async () => {
    await pkg(ws);
    // The broken state: the engine linked the root before it knew about pnpm,
    // and an install wrote through the link.
    await redirect();
    await mkdir(path.join(ws, 'node_modules', 'left-pad'), { recursive: true });
    await markers['pnpm-lock.yaml'](ws);

    const res = await redirect();

    expect(res.links).toEqual([
      { dir: ws, target: path.join(off, 'root', '.pnpm'), action: 'linked' },
    ]);
    await expectEnginePnpmLayout(ws, 'root');
    // Only the link went; what it pointed at is untouched.
    expect((await stat(path.join(off, 'root', 'node_modules', 'left-pad'))).isDirectory()).toBe(
      true,
    );
    // The next run keeps the prepared directory as it is.
    expect((await redirect()).links).toEqual([
      { dir: ws, target: path.join(off, 'root', '.pnpm'), action: 'kept' },
    ]);
  });

  it('heals the layout after a container swap emptied the off-mount side', async () => {
    await pkg(ws);
    await markers['pnpm-lock.yaml'](ws);
    await redirect();
    await rm(off, { recursive: true, force: true });

    const res = await redirect();

    expect(res.links).toEqual([
      { dir: ws, target: path.join(off, 'root', '.pnpm'), action: 'kept' },
    ]);
    await expectEnginePnpmLayout(ws, 'root');
  });

  it('keeps an installation whose recorded configuration matches the engine', async () => {
    await pkg(ws);
    await markers['pnpm-lock.yaml'](ws);
    await redirect();
    await mkdir(path.join(ws, 'node_modules', '.bin'), { recursive: true });
    await modulesYaml(ws);

    const res = await redirect();

    expect(res.links).toEqual([
      { dir: ws, target: path.join(off, 'root', '.pnpm'), action: 'kept' },
    ]);
    await expectEnginePnpmLayout(ws, 'root');
    expect((await stat(path.join(ws, 'node_modules', '.bin'))).isDirectory()).toBe(true);
  });

  it.each([
    ['another content store', { storeDir: '/somewhere/else/v10' }],
    ['a non-default virtual store', { virtualStoreDir: '/tmp/old-env-design/.pnpm' }],
    ['no recorded store', { storeDir: '' }],
  ])(
    'purges an installation recorded against %s, so the next install needs no prompt',
    async (_label, fields) => {
      await pkg(ws);
      await markers['pnpm-lock.yaml'](ws);
      await mkdir(path.join(ws, 'node_modules', 'left-pad'), { recursive: true });
      await modulesYaml(ws, fields);

      const res = await redirect();

      expect(res.links).toEqual([
        { dir: ws, target: path.join(off, 'root', '.pnpm'), action: 'purged' },
      ]);
      await expectEnginePnpmLayout(ws, 'root');
      expect(await absent(path.join(ws, 'node_modules', 'left-pad'))).toBe(true);
      expect(await absent(path.join(ws, 'node_modules', '.modules.yaml'))).toBe(true);
    },
  );

  it('accepts the plain-YAML .modules.yaml form of older pnpm versions', async () => {
    await pkg(ws);
    await markers['pnpm-lock.yaml'](ws);
    await mkdir(path.join(ws, 'node_modules'), { recursive: true });
    await writeFile(
      path.join(ws, 'node_modules', '.modules.yaml'),
      `storeDir: ${path.join(store(), 'v10')}\nvirtualStoreDir: .pnpm\n`,
    );

    const res = await redirect();

    expect(res.links[0].action).toBe('kept');
  });

  it('purges a directory another tool populated (no .modules.yaml)', async () => {
    await pkg(ws);
    await markers['pnpm-lock.yaml'](ws);
    await mkdir(path.join(ws, 'node_modules', 'left-pad'), { recursive: true });

    const res = await redirect();

    expect(res.links).toEqual([
      { dir: ws, target: path.join(off, 'root', '.pnpm'), action: 'purged' },
    ]);
    await expectEnginePnpmLayout(ws, 'root');
    expect(await absent(path.join(ws, 'node_modules', 'left-pad'))).toBe(true);
  });

  it('replaces a real on-mount .pnpm directory from an install made before the redirect', async () => {
    await pkg(ws);
    await markers['pnpm-lock.yaml'](ws);
    await mkdir(path.join(ws, 'node_modules', '.pnpm', 'is-number@7.0.0'), { recursive: true });
    await modulesYaml(ws);

    const res = await redirect();

    // The installation metadata matches, so the directory is kept — but the
    // heavy .pnpm payload moves off the mount; pnpm reinstalls it silently.
    expect(res.links).toEqual([
      { dir: ws, target: path.join(off, 'root', '.pnpm'), action: 'kept' },
    ]);
    await expectEnginePnpmLayout(ws, 'root');
  });

  it('re-points a .pnpm link whose off-mount key changed', async () => {
    await pkg(ws);
    await markers['pnpm-lock.yaml'](ws);
    await mkdir(path.join(ws, 'node_modules'), { recursive: true });
    await mkdir(path.join(off, 'stale'), { recursive: true });
    await createSymlink(path.join(off, 'stale'), path.join(ws, 'node_modules', '.pnpm'), 'dir');

    const res = await redirect();

    expect(res.links[0].action).toBe('kept');
    await expectEnginePnpmLayout(ws, 'root');
  });

  it.each([
    ['absolute', () => path.join(root, 'elsewhere')],
    ['relative', () => path.join('..', 'elsewhere')],
  ])('keeps a link that points outside the off-mount root (%s target)', async (_label, to) => {
    await pkg(ws);
    await markers['pnpm-lock.yaml'](ws);
    await mkdir(path.join(root, 'elsewhere'));
    await createSymlink(to(), path.join(ws, 'node_modules'), 'dir');

    const res = await redirect();

    expect(res.links).toEqual([{ dir: ws, action: 'skipped' }]);
    expect(await readlink(path.join(ws, 'node_modules'))).toBe(to());
  });

  it('keys the .pnpm target by the directory of a nested pnpm root and leaves npm neighbours linked', async () => {
    await pkg(ws);
    const app = path.join(ws, 'apps', 'web');
    await pkg(app);
    await markers['pnpm-lock.yaml'](app);

    const res = await redirect();

    expect(res.links).toEqual([
      { dir: ws, target: path.join(off, 'root', 'node_modules'), action: 'created' },
      { dir: app, target: path.join(off, 'apps__web', '.pnpm'), action: 'linked' },
    ]);
    await expectEnginePnpmLayout(app, 'apps__web');
    expect(res.env).toEqual({ npm_config_store_dir: store() });
  });

  it('keeps the link of a workspace member that has no pnpm marker of its own', async () => {
    await pkg(ws);
    await markers['pnpm-workspace.yaml'](ws);
    const member = path.join(ws, 'packages', 'a');
    await pkg(member);

    const res = await redirect();

    expect(res.links.map((l) => l.action)).toEqual(['linked', 'created']);
    expect((await lstat(path.join(member, 'node_modules'))).isSymbolicLink()).toBe(true);
    await expectEnginePnpmLayout(ws, 'root');
  });

  it('gives each of two pnpm roots its own off-mount .pnpm and shares the store', async () => {
    const first = path.join(ws, 'owner', 'first');
    const second = path.join(ws, 'owner', 'second');
    await pkg(first);
    await pkg(second);
    await markers['pnpm-lock.yaml'](first);
    await markers['a pnpm packageManager field'](second);

    const res = await redirect();

    expect(res.links).toEqual([
      { dir: first, target: path.join(off, 'owner__first', '.pnpm'), action: 'linked' },
      { dir: second, target: path.join(off, 'owner__second', '.pnpm'), action: 'linked' },
    ]);
    await expectEnginePnpmLayout(first, 'owner__first');
    await expectEnginePnpmLayout(second, 'owner__second');
    expect(res.env).toEqual({ npm_config_store_dir: store() });
  });

  it('keeps the first root installed when a workspace gains a second pnpm root', async () => {
    const first = path.join(ws, 'owner', 'first');
    const second = path.join(ws, 'owner', 'second');
    await pkg(first);
    await markers['pnpm-lock.yaml'](first);
    await redirect();
    // An install happened in the first root…
    await mkdir(path.join(first, 'node_modules', '.bin'), { recursive: true });
    await modulesYaml(first);
    // …then the workspace gains a second pnpm root between stages.
    await pkg(second);
    await markers['a pnpm packageManager field'](second);

    const res = await redirect();

    expect(res.links).toEqual([
      { dir: first, target: path.join(off, 'owner__first', '.pnpm'), action: 'kept' },
      { dir: second, target: path.join(off, 'owner__second', '.pnpm'), action: 'linked' },
    ]);
    expect((await stat(path.join(first, 'node_modules', '.bin'))).isDirectory()).toBe(true);
  });

  it('reports a root it cannot prepare as a failure and still sets the environment', async () => {
    await pkg(ws);
    await redirect();
    await markers['pnpm-lock.yaml'](ws);

    const res = await redirectHeavyDirs({
      workspaceDir: ws,
      offMountRoot: off,
      pnpmStoreDir: store(),
      log: () => {},
      fsOps: {
        rm: async () => {
          throw new Error('EACCES boom');
        },
      },
    });

    expect(res.links).toEqual([{ dir: ws, action: 'failed', detail: 'EACCES boom' }]);
    expect(res.env).toEqual({ npm_config_store_dir: store() });
  });
});
