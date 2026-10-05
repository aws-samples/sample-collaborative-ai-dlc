import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkoutRepo, checkoutRepos, ensureWorkspaceSource } from '../workspace.js';
import { beginConflictMerge, commitAll, concludeConflictMerge } from '../git-engine.js';
import { HOOKS_DISABLED_ARGS } from '../git-runner.js';
import { validateSparseCheckout } from '../../shared/sparse-checkout.js';

const git = (cwd, ...args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
};
const exists = (p) =>
  access(p).then(
    () => true,
    () => false,
  );
let root, source, target, calls, runner;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'aidlc-sparse-'));
  source = path.join(root, 'source');
  target = path.join(root, 'workspace');
  await mkdir(source);
  git(source, 'init', '-b', 'main');
  git(source, 'config', 'user.email', 'test@example.invalid');
  git(source, 'config', 'user.name', 'Test');
  for (const file of [
    'README.md',
    'services/config.json',
    'services/api/index.js',
    'services/web/index.js',
    'assets/large.txt',
  ]) {
    await mkdir(path.dirname(path.join(source, file)), { recursive: true });
    await writeFile(path.join(source, file), file);
  }
  git(source, 'add', '.');
  git(source, 'commit', '-m', 'initial');
  git(source, 'checkout', '-b', 'develop');
  await writeFile(path.join(source, 'services/api/index.js'), 'develop');
  git(source, 'commit', '-am', 'develop');
  git(source, 'checkout', 'main');
  calls = [];
  runner = async (command, args, options = {}) => {
    expect(args.slice(0, HOOKS_DISABLED_ARGS.length)).toEqual(HOOKS_DISABLED_ARGS);
    const commandArgs = args.slice(HOOKS_DISABLED_ARGS.length);
    calls.push(commandArgs);
    const actual = [...args];
    if (commandArgs[0] === 'clone') actual[actual.length - 2] = source;
    const result = spawnSync(command, actual, { cwd: options.cwd, encoding: 'utf8' });
    return { code: result.status };
  };
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const inputs = () => ({
  repo: 'owner/repo',
  branch: 'aidlc/test',
  targetDir: target,
  runner,
  withGitCredential: async (_context, operation) => operation({ env: {} }),
  trustDirectory: async () => true,
});

describe('sparse checkout', () => {
  it('materializes selected and ancestor files, preserves excluded files when committing, and reuses warm work', async () => {
    const result = await checkoutRepo({
      ...inputs(),
      sparseDirectories: ['services/api'],
      baseBranch: 'develop',
    });
    expect(result.branchOk).toBe(true);
    expect(calls[0]).toEqual(['clone', '--no-checkout', expect.any(String), target]);
    expect(await readFile(path.join(target, 'services/api/index.js'), 'utf8')).toBe('develop');
    expect(await exists(path.join(target, 'README.md'))).toBe(true);
    expect(await exists(path.join(target, 'services/config.json'))).toBe(true);
    expect(await exists(path.join(target, 'services/web'))).toBe(false);
    expect(await exists(path.join(target, 'assets'))).toBe(false);
    await writeFile(path.join(target, 'services/api/index.js'), 'updated');
    const committed = await commitAll({
      dir: target,
      message: 'edit selected file',
      author: { name: 'Test', email: 'test@example.invalid' },
      committer: { name: 'Test', email: 'test@example.invalid' },
    });
    expect(committed.committed).toBe(true);
    expect(git(target, 'show', 'HEAD:assets/large.txt')).toBe('assets/large.txt');
    await writeFile(path.join(target, 'services/api/index.js'), 'uncommitted');
    const reused = await checkoutRepo({ ...inputs(), sparseDirectories: ['services/api'] });
    expect(reused.reused).toBe(true);
    expect(await readFile(path.join(target, 'services/api/index.js'), 'utf8')).toBe('uncommitted');
    expect(calls.filter((args) => args[0] === 'clone')).toHaveLength(1);
  });

  it('retains full checkout when omitted or empty', async () => {
    for (const sparseDirectories of [undefined, []]) {
      await rm(target, { recursive: true, force: true });
      const result = await checkoutRepo({ ...inputs(), sparseDirectories });
      expect(result.branchOk).toBe(true);
      expect(await exists(path.join(target, 'assets/large.txt'))).toBe(true);
    }
    expect(calls.some((args) => args[0] === 'sparse-checkout')).toBe(false);
  });

  it('commits new files outside the cone without deleting excluded tracked files', async () => {
    const result = await checkoutRepo({ ...inputs(), sparseDirectories: ['services/api'] });
    expect(result.branchOk).toBe(true);
    await writeFile(path.join(target, 'services/api/index.js'), 'updated');
    await mkdir(path.join(target, 'docs'));
    await writeFile(path.join(target, 'docs/usage.md'), 'new documentation');
    const committed = await commitAll({
      dir: target,
      message: 'stage changes inside and outside the cone',
      attempts: 1,
      log: () => {},
    });
    expect(committed.committed).toBe(true);
    expect(committed.files).toEqual(['docs/usage.md', 'services/api/index.js']);
    expect(git(target, 'show', 'HEAD:docs/usage.md')).toBe('new documentation');
    expect(git(target, 'show', 'HEAD:services/api/index.js')).toBe('updated');
    expect(git(target, 'show', 'HEAD:services/web/index.js')).toBe('services/web/index.js');
    expect(git(target, 'show', 'HEAD:assets/large.txt')).toBe('assets/large.txt');
    expect(git(target, 'status', '--porcelain')).toBe('');
    expect(await exists(path.join(target, 'assets'))).toBe(false);
  });

  it('concludes and pushes resolved merge conflicts outside the lane cone', async () => {
    const unitBranch = 'aidlc/test--unit';
    git(source, 'checkout', '-b', unitBranch);
    await writeFile(path.join(source, 'services/web/index.js'), 'unit version\n');
    git(source, 'commit', '-am', 'unit change');
    git(source, 'checkout', '-b', 'aidlc/test', 'main');
    await writeFile(path.join(source, 'services/web/index.js'), 'intent version\n');
    git(source, 'commit', '-am', 'intent change');
    const remote = path.join(root, 'remote.git');
    git(root, 'clone', '--bare', source, remote);
    source = remote;
    const result = await checkoutRepo({
      ...inputs(),
      branch: unitBranch,
      sparseDirectories: ['services/api'],
    });
    expect(result.branchOk).toBe(true);
    expect(await exists(path.join(target, 'services/web'))).toBe(false);
    const options = {
      dir: target,
      repo: 'owner/repo',
      unitBranch,
      intentBranch: 'aidlc/test',
      message: 'resolve lane conflict',
      urls: { network: remote, clean: remote },
      committer: null,
      log: () => {},
    };
    const begin = await beginConflictMerge(options);
    expect(begin).toMatchObject({ conflicted: true, conflicts: ['services/web/index.js'] });
    expect(await readFile(path.join(target, 'services/web/index.js'), 'utf8')).toContain('<<<<<<<');
    await writeFile(path.join(target, 'services/web/index.js'), 'intent + unit resolution\n');
    const concluded = await concludeConflictMerge({ ...options, conflicts: begin.conflicts });
    expect(concluded).toMatchObject({ concluded: true, pushed: true });
    expect(git(remote, 'show', `${unitBranch}:services/web/index.js`)).toBe(
      'intent + unit resolution',
    );
    expect(git(remote, 'rev-parse', unitBranch)).toBe(concluded.sha);
    expect(git(target, 'log', '-1', '--format=%P').split(' ')).toHaveLength(2);
    expect(git(target, 'show', 'HEAD:assets/large.txt')).toBe('assets/large.txt');
    expect(git(target, 'diff', '--name-only', '--diff-filter=U')).toBe('');
    expect(git(target, 'status', '--porcelain')).toBe('');
  });

  it('supports a sparse checkout without a requested branch', async () => {
    expect(
      (await checkoutRepo({ ...inputs(), branch: null, sparseDirectories: ['services/api'] }))
        .branchOk,
    ).toBe(true);
    expect(await exists(path.join(target, 'services/api/index.js'))).toBe(true);
    expect(await exists(path.join(target, 'assets'))).toBe(false);
  });

  it('applies per-repo selections and restores them after mount loss', async () => {
    const options = {
      ...inputs(),
      workspaceDir: target,
      repos: ['owner/repo', 'owner/other'],
      sparseCheckout: { 'owner/repo': ['services/api'] },
    };
    const rows = await checkoutRepos(options);
    expect(rows.every((row) => row.branchOk)).toBe(true);
    expect(await exists(path.join(target, 'owner/repo/assets'))).toBe(false);
    expect(await exists(path.join(target, 'owner/other/assets/large.txt'))).toBe(true);
    await rm(target, { recursive: true, force: true });
    const restored = await ensureWorkspaceSource(options);
    expect(restored.failed).toEqual([]);
    expect(restored.restored).toBe(true);
    expect(await exists(path.join(target, 'owner/repo/assets'))).toBe(false);
    expect(await exists(path.join(target, 'owner/repo/services/api/index.js'))).toBe(true);
    expect(await exists(path.join(target, 'owner/other/assets/large.txt'))).toBe(true);
  });

  it('removes incomplete clones when sparse setup fails without falling back to full checkout', async () => {
    const realRunner = runner;
    const result = await checkoutRepo({
      ...inputs(),
      sparseDirectories: ['services/api'],
      runner: (cmd, args, opts) =>
        args[HOOKS_DISABLED_ARGS.length] === 'sparse-checkout'
          ? { code: 1 }
          : realRunner(cmd, args, opts),
    });
    expect(result.error).toBe('sparse_checkout_failed');
    expect(await exists(target)).toBe(false);
    expect(calls.some((args) => args[0] === 'checkout')).toBe(false);
  });

  it.each([
    '/absolute',
    '../escape',
    'a/../b',
    '.',
    '.git',
    'a/.git/config',
    '--help',
    'a\nb',
    'a/*',
    'a\\b',
    'a//b',
    ' services/api',
    'services/api ',
  ])('rejects unsafe selection %s before touching disk', async (directory) => {
    const result = await checkoutRepo({ ...inputs(), sparseDirectories: [directory] });
    expect(result.cloned).toBe(false);
    expect(calls).toEqual([]);
    expect(await exists(target)).toBe(false);
  });

  it('validates map shape and repository membership', () => {
    expect(validateSparseCheckout({ 'other/repo': ['src'] }, ['owner/repo']).error).toBeTruthy();
    expect(validateSparseCheckout([], ['owner/repo']).error).toBeTruthy();
    expect(validateSparseCheckout({ 'owner/repo': 'src' }, ['owner/repo']).error).toBeTruthy();
    expect(validateSparseCheckout({ 'owner/repo': [] }, ['owner/repo']).value).toBeNull();
    expect(
      validateSparseCheckout({ 'owner/repo': ['src', 'src', 'shared code'] }, ['owner/repo']).value,
    ).toEqual({ 'owner/repo': ['src', 'shared code'] });
  });
});
