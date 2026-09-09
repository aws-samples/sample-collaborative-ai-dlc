import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkoutRepo, checkoutRepos, ensureWorkspaceSource } from '../workspace.js';
import { commitAll } from '../git-engine.js';
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
    calls.push(args);
    const actual = [...args];
    if (args[0] === 'clone') actual[actual.length - 2] = source;
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
        args[0] === 'sparse-checkout' ? { code: 1 } : realRunner(cmd, args, opts),
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
