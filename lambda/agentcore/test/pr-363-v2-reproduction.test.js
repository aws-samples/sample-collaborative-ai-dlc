import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { commitAll, pushBranch, runGit } from '../git-engine.js';
import { HOOKS_DISABLED_ARGS } from '../git-runner.js';
import { checkoutRepo } from '../workspace.js';

vi.setConfig({ testTimeout: 30_000 });

const CLEAN_REPOSITORY_URL = 'https://github.com/owner/repo.git';
const PASSWORD_SENTINEL = ['workspace', 'password', 'sentinel'].join('-');
let root;

const git = (args, cwd) => runGit(args, { cwd });

const fixtureGitEnvironment = (overrides = {}) => {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key];
  }
  return {
    ...env,
    HOME: root,
    XDG_CONFIG_HOME: path.join(root, 'xdg'),
    GIT_CONFIG_GLOBAL: path.join(root, 'global.gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    AIDLC_GIT_PASSWORD: '',
    ...overrides,
  };
};

const runFixtureGit = (args, { cwd = root, env = {} } = {}) =>
  new Promise((resolve) => {
    let settled = false;
    const settle = (result) => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };
    const child = spawn('git', args, {
      cwd,
      env: fixtureGitEnvironment(env),
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => settle({ code: null, stdout, stderr, error }));
    child.on('close', (code) => settle({ code, stdout, stderr }));
  });

const fixtureGitOk = async (args, options) => {
  const result = await runFixtureGit(args, options);
  expect(result.code, result.stderr).toBe(0);
  return result;
};

const initRemoteAndClone = async () => {
  const remote = path.join(root, 'remote.git');
  const seed = path.join(root, 'seed');
  const work = path.join(root, 'work');
  await git(['init', '--bare', '-b', 'main', remote], root);
  await git(['init', '-b', 'main', seed], root);
  await writeFile(path.join(seed, 'README.md'), 'seed\n');
  await git(['add', '-A'], seed);
  await git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'seed'], seed);
  await git(['push', remote, 'main'], seed);
  await git(['clone', remote, work], root);
  return { remote, seed, work };
};

const installHook = async (work, name, body) => {
  const dir = path.join(work, '.custom-hooks');
  const marker = path.join(work, `${name}-ran.txt`);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, name), body(marker), { mode: 0o755 });
  await git(['config', 'core.hooksPath', dir], work);
  return marker;
};

const postCheckoutHook = (marker) =>
  `#!/bin/sh\nprintf '%s' "\${AIDLC_GIT_PASSWORD:-<unset>}" > "${marker}"\nprintf 'post-checkout rejected: %s\\n' "\${AIDLC_GIT_PASSWORD:-<unset>}" >&2\nexit 97\n`;

const workspaceRunner =
  ({ remoteUrl, records, env = {} }) =>
  async (command, args, options = {}) => {
    expect(command).toBe('git');
    const localArgs = args.map((arg) => (arg === CLEAN_REPOSITORY_URL ? remoteUrl : arg));
    const result = await runFixtureGit(localArgs, {
      cwd: options.cwd ?? root,
      env: { ...env, ...options.env },
    });
    records.push({ args: [...args], stdout: result.stdout, stderr: result.stderr });
    return result;
  };

const expectWorkspaceCommandsProtected = (records) => {
  expect(records.length).toBeGreaterThan(0);
  for (const record of records) {
    expect(record.args.slice(0, HOOKS_DISABLED_ARGS.length)).toEqual(HOOKS_DISABLED_ARGS);
    expect(record.args.join('\0')).not.toContain(PASSWORD_SENTINEL);
    expect(record.stdout).not.toContain(PASSWORD_SENTINEL);
    expect(record.stderr).not.toContain(PASSWORD_SENTINEL);
  }
};

const expectMissing = async (file) => {
  await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
};

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'pr-363-v2-'));
  await writeFile(path.join(root, 'global.gitconfig'), '');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('PR #363 behavior on pinned v2', () => {
  it('suppresses prepare-commit-msg and commits completed stage work', async () => {
    const { work } = await initRemoteAndClone();
    const before = (await git(['rev-parse', 'HEAD'], work)).stdout.trim();
    const marker = await installHook(
      work,
      'prepare-commit-msg',
      (file) => `#!/bin/sh\necho ran > "${file}"\necho "prepare-commit-msg rejected" >&2\nexit 1\n`,
    );
    await writeFile(path.join(work, 'agent-work.txt'), 'completed stage output\n');

    const result = await commitAll({
      dir: work,
      message: 'aidlc(functional-design): reproduction',
      attempts: 1,
      log: () => {},
    });

    expect(result).toMatchObject({ committed: true });
    await expectMissing(marker);
    expect((await git(['rev-parse', 'HEAD'], work)).stdout.trim()).not.toBe(before);
    expect((await git(['status', '--porcelain'], work)).stdout).not.toContain('agent-work.txt');
  });

  it('suppresses pre-push while the short-lived write credential is in the environment', async () => {
    const { remote, work } = await initRemoteAndClone();
    const marker = await installHook(
      work,
      'pre-push',
      (file) =>
        `#!/bin/sh\nif [ "$AIDLC_GIT_PASSWORD" = "reproduction-write-token" ]; then\n  echo credential-present > "${file}"\nelse\n  echo credential-missing > "${file}"\nfi\necho "pre-push rejected" >&2\nexit 1\n`,
    );
    await writeFile(path.join(work, 'agent-work.txt'), 'completed stage output\n');
    const committed = await commitAll({ dir: work, message: 'aidlc(code): reproduction' });
    expect(committed.committed).toBe(true);

    const result = await pushBranch({
      dir: work,
      repo: 'owner/repo',
      branch: 'main',
      projectId: 'project-1',
      executionId: 'execution-1',
      gitProvider: 'github',
      attempts: 1,
      urls: { clean: remote },
      withGitCredential: async (_request, operation) =>
        operation({
          env: {
            AIDLC_GIT_PASSWORD: 'reproduction-write-token',
            GIT_TERMINAL_PROMPT: '0',
          },
        }),
      log: () => {},
    });

    expect(result).toMatchObject({ pushed: true, verified: true });
    await expectMissing(marker);
    const localHead = (await git(['rev-parse', 'HEAD'], work)).stdout.trim();
    const remoteHead = (await git(['rev-parse', 'refs/heads/main'], remote)).stdout.trim();
    expect(remoteHead).toBe(localHead);
  });

  it('suppresses an inherited tracked post-checkout hook during credentialed workspace clone', async () => {
    const { remote, seed } = await initRemoteAndClone();
    const marker = path.join(root, 'fresh-clone-hook-ran.txt');
    const hooksDir = path.join(seed, '.githooks');
    await mkdir(hooksDir, { recursive: true });
    await writeFile(path.join(hooksDir, 'post-checkout'), postCheckoutHook(marker), {
      mode: 0o755,
    });
    await git(['add', '-A'], seed);
    await git(
      ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'add tracked hook'],
      seed,
    );
    await git(['push', remote, 'main'], seed);
    await fixtureGitOk(['config', '--global', 'core.hooksPath', '.githooks']);

    const remoteUrl = pathToFileURL(remote).href;
    const unprotectedTarget = path.join(root, 'unprotected-clone');
    const unprotected = await runFixtureGit(['clone', remoteUrl, unprotectedTarget]);
    expect(unprotected.code).not.toBe(0);
    expect(unprotected.stderr).not.toContain(PASSWORD_SENTINEL);
    expect(await readFile(marker, 'utf8')).toBe('<unset>');
    await rm(marker, { force: true });
    await rm(unprotectedTarget, { recursive: true, force: true });

    const records = [];
    const targetDir = path.join(root, 'protected-clone');
    const result = await checkoutRepo({
      repo: 'owner/repo',
      branch: 'main',
      gitProvider: 'github',
      projectId: 'project-1',
      executionId: 'execution-1',
      targetDir,
      runner: workspaceRunner({ remoteUrl, records }),
      withGitCredential: async (_request, operation) =>
        operation({
          env: {
            AIDLC_GIT_PASSWORD: PASSWORD_SENTINEL,
            GIT_TERMINAL_PROMPT: '0',
          },
        }),
      trustDirectory: async () => true,
    });

    expect(result).toMatchObject({ cloned: true, branchOk: true });
    await expectMissing(marker);
    expect(await readFile(path.join(targetDir, '.git', 'config'), 'utf8')).not.toContain(
      PASSWORD_SENTINEL,
    );
    expectWorkspaceCommandsProtected(records);
  });

  it('retains the contributor-only post-checkout failure and suppresses it during warm reuse', async () => {
    const { remote, work } = await initRemoteAndClone();
    await git(['branch', 'next'], work);
    const marker = await installHook(work, 'post-checkout', postCheckoutHook);

    // This is the decisive contributor-only baseline: checkout switches the
    // branch, but the configured hook rejects it and observes the environment.
    const unprotected = await runFixtureGit(['checkout', 'next'], { cwd: work });
    expect(unprotected.code).not.toBe(0);
    expect(unprotected.stderr).not.toContain(PASSWORD_SENTINEL);
    expect(await readFile(marker, 'utf8')).toBe('<unset>');
    await git(['checkout', 'main'], work);
    await rm(marker, { force: true });

    const records = [];
    const result = await checkoutRepo({
      repo: 'owner/repo',
      branch: 'next',
      gitProvider: 'github',
      projectId: 'project-1',
      executionId: 'execution-1',
      targetDir: work,
      runner: workspaceRunner({
        remoteUrl: pathToFileURL(remote).href,
        records,
        env: { AIDLC_GIT_PASSWORD: PASSWORD_SENTINEL },
      }),
      trustDirectory: async () => true,
    });

    expect(result).toMatchObject({ cloned: true, reused: true, branchOk: true });
    await expectMissing(marker);
    expect((await git(['branch', '--show-current'], work)).stdout.trim()).toBe('next');
    expect(await readFile(path.join(work, '.git', 'config'), 'utf8')).not.toContain(
      PASSWORD_SENTINEL,
    );
    expectWorkspaceCommandsProtected(records);
  });
});
