import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, lstat, readlink, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkoutRepo, redirectHeavyDirs } from '../workspace.js';
import { runGit } from '../git-engine.js';
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
});
