import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, access, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkoutRepo, checkoutRepos, ensureWorkspaceSource } from '../workspace.js';
import {
  beginConflictMerge,
  commitAll,
  commitAndPushAll,
  concludeConflictMerge,
  runGit,
} from '../git-engine.js';
import { HOOKS_DISABLED_ARGS } from '../git-runner.js';
import {
  isInSparseCone,
  validateSparseCheckout,
  validateSparseDirectories,
} from '../../shared/sparse-checkout.js';

// Git exports GIT_DIR / GIT_INDEX_FILE to its hooks. A run started from one
// (the pre-commit hook) must act on the fixture repositories, never on the
// repository the hook belongs to.
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
);
const git = (cwd, ...args) => {
  const result = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
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
    const result = spawnSync(command, actual, { cwd: options.cwd, env, encoding: 'utf8' });
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
    expect(committed.outsideSelection).toBeUndefined();
  });

  // Refusal contract: nothing is committed, HEAD stays put, and the agent's
  // work stays on disk and staged as evidence.
  const expectRefused = (committed, headBefore, reason = 'sparse_outside_selection') => {
    expect(committed).toMatchObject({ committed: false, reason, dirty: true });
    expect(git(target, 'rev-parse', 'HEAD')).toBe(headBefore);
  };
  const sparseWorkspace = async () => {
    const result = await checkoutRepo({ ...inputs(), sparseDirectories: ['services/api'] });
    expect(result.branchOk).toBe(true);
    expect(await exists(path.join(target, 'assets'))).toBe(false);
    return git(target, 'rev-parse', 'HEAD');
  };
  const commit = (options = {}) =>
    commitAll({ dir: target, message: 'stage', attempts: 1, log: () => {}, ...options });

  it('refuses to commit a hidden tracked file the agent recreated from scratch', async () => {
    const head = await sparseWorkspace();
    await mkdir(path.join(target, 'assets'));
    await writeFile(path.join(target, 'assets/large.txt'), 'rewritten');
    await writeFile(path.join(target, 'services/api/index.js'), 'updated');
    const sleep = vi.fn(async () => {});
    const committed = await commit({ attempts: 3, sleep });
    expectRefused(committed, head);
    expect(committed.outsideSelection).toEqual(['assets/large.txt']);
    expect(committed.detail).toContain('assets/large.txt');
    // Deterministic: no retry backoff.
    expect(sleep).not.toHaveBeenCalled();
    // Evidence preserved: on disk and staged, the commit still holds the original.
    expect(await readFile(path.join(target, 'assets/large.txt'), 'utf8')).toBe('rewritten');
    expect(git(target, 'show', ':assets/large.txt')).toBe('rewritten');
    expect(git(target, 'show', ':services/api/index.js')).toBe('updated');
    expect(git(target, 'show', 'HEAD:assets/large.txt')).toBe('assets/large.txt');
  });

  it('refuses a staged deletion of a hidden tracked file (git bypass)', async () => {
    const head = await sparseWorkspace();
    git(target, 'rm', '--cached', '--sparse', '-q', 'assets/large.txt');
    const committed = await commit();
    expectRefused(committed, head);
    expect(committed.outsideSelection).toEqual(['assets/large.txt']);
    expect(git(target, 'ls-files', 'assets/large.txt')).toBe('');
  });

  it('refuses replacing a hidden tracked file with a symlink (type change)', async () => {
    const head = await sparseWorkspace();
    await mkdir(path.join(target, 'assets'));
    await symlink('../README.md', path.join(target, 'assets/large.txt'));
    const committed = await commit();
    expectRefused(committed, head);
    expect(committed.outsideSelection).toEqual(['assets/large.txt']);
  });

  it('refuses a previously refused change again on the next attempt', async () => {
    const head = await sparseWorkspace();
    await mkdir(path.join(target, 'assets'));
    await writeFile(path.join(target, 'assets/large.txt'), 'rewritten');
    expectRefused(await commit(), head);
    expectRefused(await commit(), head);
    // Restoring the committed content (the recovery the prompt asks for) unblocks it.
    await writeFile(
      path.join(target, 'assets/large.txt'),
      git(target, 'show', 'HEAD:assets/large.txt'),
    );
    await writeFile(path.join(target, 'services/api/index.js'), 'updated');
    const recovered = await commit();
    expect(recovered.committed).toBe(true);
    expect(git(target, 'show', 'HEAD:assets/large.txt')).toBe('assets/large.txt');
    expect(git(target, 'show', 'HEAD:services/api/index.js')).toBe('updated');
  });

  it('commits root and ancestor-directory files that cone mode materializes', async () => {
    await sparseWorkspace();
    await writeFile(path.join(target, 'README.md'), 'root edit');
    await writeFile(path.join(target, 'services/config.json'), 'ancestor edit');
    const committed = await commit();
    expect(committed.committed).toBe(true);
    expect(git(target, 'show', 'HEAD:services/config.json')).toBe('ancestor edit');
  });

  // `git sparse-checkout list` quotes and escapes non-ASCII paths unless
  // core.quotePath is off; the quoted form is not a valid selection.
  it('commits in a selected directory with a non-ASCII name and still guards the rest', async () => {
    await mkdir(path.join(source, 'docs/café'), { recursive: true });
    await writeFile(path.join(source, 'docs/café/guide.md'), 'guide');
    git(source, 'add', '.');
    git(source, 'commit', '-m', 'docs');
    const result = await checkoutRepo({ ...inputs(), sparseDirectories: ['docs/café'] });
    expect(result.branchOk).toBe(true);
    expect(await exists(path.join(target, 'assets'))).toBe(false);
    await writeFile(path.join(target, 'docs/café/guide.md'), 'updated');
    const committed = await commit();
    expect(committed).toMatchObject({ committed: true });
    expect(git(target, 'show', 'HEAD:docs/café/guide.md')).toBe('updated');
    const head = git(target, 'rev-parse', 'HEAD');
    await mkdir(path.join(target, 'assets'));
    await writeFile(path.join(target, 'assets/large.txt'), 'rewritten');
    const refused = await commit();
    expectRefused(refused, head);
    expect(refused.outsideSelection).toEqual(['assets/large.txt']);
  });

  it.each([
    ['core.sparseCheckout is unreadable', 'config --bool core.sparseCheckout', { exitCode: 128 }],
    [
      'cone mode is off',
      'config --bool core.sparseCheckoutCone',
      { exitCode: 0, stdout: 'false\n' },
    ],
    ['the selection list fails', '-c core.quotePath=false sparse-checkout list', { exitCode: 128 }],
    [
      'the selection list is malformed',
      '-c core.quotePath=false sparse-checkout list',
      { exitCode: 0, stdout: '"a\\tb"\n' },
    ],
    [
      'the selection list is empty',
      '-c core.quotePath=false sparse-checkout list',
      { exitCode: 0, stdout: '' },
    ],
    ['HEAD cannot be resolved', 'rev-parse --verify -q HEAD^{commit}', { exitCode: 128 }],
    ['the staged diff fails', 'diff-index --cached -z --no-renames HEAD', { exitCode: 128 }],
    [
      'the staged diff is malformed',
      'diff-index --cached -z --no-renames HEAD',
      { exitCode: 0, stdout: 'not raw output\0' },
    ],
  ])('refuses to commit when %s', async (_label, command, response) => {
    const head = await sparseWorkspace();
    await writeFile(path.join(target, 'services/api/index.js'), 'updated');
    const failing = (args, options) =>
      args.join(' ') === command
        ? { stdout: '', stderr: 'simulated', ...response }
        : runGit(args, options);
    const committed = await commit({ git: failing });
    expectRefused(committed, head, 'sparse_check_failed');
    expect(committed.detail).toContain('could not verify the sparse checkout selection');
  });

  it('leaves full checkouts unaffected, including edits anywhere', async () => {
    const result = await checkoutRepo(inputs());
    expect(result.branchOk).toBe(true);
    await writeFile(path.join(target, 'assets/large.txt'), 'edited');
    const committed = await commit();
    expect(committed.committed).toBe(true);
    expect(git(target, 'show', 'HEAD:assets/large.txt')).toBe('edited');
  });

  it('pushes nothing for a refused repository and still delivers the other one', async () => {
    const remote = path.join(root, 'remote.git');
    git(root, 'clone', '--bare', source, remote);
    const other = path.join(root, 'other.git');
    git(root, 'clone', '--bare', source, other);
    source = remote;
    const options = {
      ...inputs(),
      workspaceDir: target,
      repos: ['owner/repo', 'owner/other'],
      sparseCheckout: { 'owner/repo': ['services/api'] },
    };
    const realRunner = runner;
    const rows = await checkoutRepos({
      ...options,
      runner: async (command, args, opts) => {
        const commandArgs = args.slice(HOOKS_DISABLED_ARGS.length);
        if (commandArgs[0] === 'clone' && commandArgs.at(-1).endsWith('owner/other')) {
          const actual = [...args];
          actual[actual.length - 2] = other;
          const result = spawnSync(command, actual, { cwd: opts?.cwd, env, encoding: 'utf8' });
          return { code: result.status };
        }
        return realRunner(command, args, opts);
      },
    });
    expect(rows.every((row) => row.branchOk)).toBe(true);
    const sparseDir = path.join(target, 'owner/repo');
    const fullDir = path.join(target, 'owner/other');
    await mkdir(path.join(sparseDir, 'assets'));
    await writeFile(path.join(sparseDir, 'assets/large.txt'), 'rewritten');
    await writeFile(path.join(sparseDir, 'services/api/index.js'), 'updated');
    await writeFile(path.join(fullDir, 'assets/large.txt'), 'full checkout edit');
    const refusedRefPrefix = 'refs/aidlc/refused/e1/code-generation/attempt-0';
    const commitAndPush = (overrides = {}) =>
      commitAndPushAll({
        repos: ['owner/repo', 'owner/other'],
        workspaceDir: target,
        branch: 'aidlc/test',
        gitProvider: 'github',
        message: 'stage',
        refusedRefPrefix,
        urlsFor: (url) =>
          url === 'owner/repo' ? { auth: remote, clean: remote } : { auth: other, clean: other },
        log: () => {},
        ...overrides,
      });
    const head = git(sparseDir, 'rev-parse', 'HEAD');
    const result = await commitAndPush();
    expect(result.ok).toBe(false);
    const [refused, delivered] = result.results;
    expect(refused).toMatchObject({
      repo: 'owner/repo',
      committed: false,
      pushed: false,
      reason: 'sparse_outside_selection',
      dirty: true,
      outsideSelection: ['assets/large.txt'],
    });
    expect(delivered).toMatchObject({ repo: 'owner/other', committed: true, pushed: true });
    // No intent branch reached the refused remote; the other one was pushed.
    expect(
      spawnSync('git', ['rev-parse', '--verify', 'refs/heads/aidlc/test'], { cwd: remote, env })
        .status,
    ).not.toBe(0);
    expect(git(other, 'show', 'aidlc/test:assets/large.txt')).toBe('full checkout edit');
    // The refused state is durable on its remote, on top of the unchanged HEAD
    // and under its own side ref only: the work inside the selection and the
    // refused file.
    const refusedRef = `${refusedRefPrefix}/${refused.preserved.sha}`;
    expect(refused.preserved).toEqual({
      ref: refusedRef,
      sha: git(remote, 'rev-parse', refusedRef),
    });
    expect(git(remote, 'rev-parse', `${refusedRef}^`)).toBe(head);
    expect(git(remote, 'show', `${refusedRef}:services/api/index.js`)).toBe('updated');
    expect(git(remote, 'show', `${refusedRef}:assets/large.txt`)).toBe('rewritten');
    expect(git(remote, 'show', `${refusedRef}:services/web/index.js`)).toBe(
      'services/web/index.js',
    );
    expect(git(remote, 'for-each-ref', '--format=%(refname)', 'refs/aidlc')).toBe(refusedRef);
    expect(delivered.preserved).toBeUndefined();
    expect(git(other, 'for-each-ref', 'refs/aidlc')).toBe('');
    // The workspace keeps the evidence: nothing committed, everything staged.
    expect(git(sparseDir, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(sparseDir, 'show', ':assets/large.txt')).toBe('rewritten');
    expect(git(sparseDir, 'show', ':services/api/index.js')).toBe('updated');

    // A later refusal under the same prefix gets its own ref; the first stays.
    await writeFile(path.join(sparseDir, 'services/api/index.js'), 'updated again');
    const again = await commitAndPush();
    expect(again.results[0].preserved.ref).toBe(
      `${refusedRefPrefix}/${again.results[0].preserved.sha}`,
    );
    expect(again.results[0].preserved.sha).not.toBe(refused.preserved.sha);
    expect(git(remote, 'show', `${again.results[0].preserved.ref}:services/api/index.js`)).toBe(
      'updated again',
    );
    expect(git(remote, 'show', `${refusedRef}:services/api/index.js`)).toBe('updated');

    // A state that cannot be saved is reported, pushes nothing, and the refusal stands.
    const refsBefore = git(remote, 'for-each-ref', '--format=%(refname) %(objectname)');
    const unsaved = await commitAndPush({ refusedRefPrefix: 'refs/aidlc/refused/e1/bad..name' });
    expect(unsaved.results[0]).toMatchObject({
      committed: false,
      reason: 'sparse_outside_selection',
      preserved: {
        ref: expect.stringMatching(/^refs\/aidlc\/refused\/e1\/bad\.\.name\/[0-9a-f]{40}$/),
        error: expect.stringContaining('check-ref-format'),
      },
    });
    expect(unsaved.results[0].preserved.sha).toBeUndefined();
    expect(git(remote, 'for-each-ref', '--format=%(refname) %(objectname)')).toBe(refsBefore);
  });

  // Review of #450: a retry after the workspace was lost starts from a fresh
  // clone that never saw the first attempt's snapshot. Its refusal must not
  // replace that snapshot, and neither save may move the intent branch.
  it("keeps every attempt's refused work when a retry starts from a fresh clone", async () => {
    git(source, 'branch', 'aidlc/test');
    const remote = path.join(root, 'remote.git');
    git(root, 'clone', '--bare', source, remote);
    source = remote;
    const intentHead = git(remote, 'rev-parse', 'refs/heads/aidlc/test');
    const branches = () =>
      git(remote, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads');
    const branchesBefore = branches();
    const refuse = (dir, attempt) =>
      commitAndPushAll({
        repos: ['owner/repo'],
        workspaceDir: dir,
        branch: 'aidlc/test',
        gitProvider: 'github',
        message: `stage attempt ${attempt}`,
        refusedRefPrefix: `refs/aidlc/refused/e1/code-generation--unit-a/attempt-${attempt}`,
        urlsFor: () => ({ auth: remote, clean: remote }),
        log: () => {},
      });
    const sparseClone = async (dir) => {
      const result = await checkoutRepo({
        ...inputs(),
        targetDir: dir,
        sparseDirectories: ['services/api'],
      });
      expect(result.branchOk).toBe(true);
      expect(await exists(path.join(dir, 'assets'))).toBe(false);
      expect(git(dir, 'rev-parse', 'HEAD')).toBe(intentHead);
    };
    // Snapshot of what a refusal leaves in a workspace.
    const workspaceState = (dir) => ({
      head: git(dir, 'rev-parse', 'HEAD'),
      index: git(dir, 'ls-files', '--stage', '--sparse'),
      status: git(dir, 'status', '--porcelain=v1', '--untracked-files=all'),
    });

    // Attempt 0 refuses and saves its work.
    const first = path.join(root, 'attempt-0');
    await sparseClone(first);
    await mkdir(path.join(first, 'assets'));
    await writeFile(path.join(first, 'assets/large.txt'), 'attempt 0 rewrite');
    await writeFile(path.join(first, 'services/api/index.js'), 'attempt 0 work');
    const saved0 = (await refuse(first, 0)).results[0];
    expect(saved0).toMatchObject({ committed: false, reason: 'sparse_outside_selection' });
    expect(saved0.preserved.sha).toMatch(/^[0-9a-f]{40}$/);

    // The workspace is lost; the retry (attempt 1) starts from a fresh clone
    // with no trace of attempt 0, and is refused again with different work.
    await rm(first, { recursive: true, force: true });
    const second = path.join(root, 'attempt-1');
    await sparseClone(second);
    expect(git(second, 'status', '--porcelain')).toBe('');
    await mkdir(path.join(second, 'assets'));
    await writeFile(path.join(second, 'assets/large.txt'), 'attempt 1 rewrite');
    await writeFile(path.join(second, 'services/api/index.js'), 'attempt 1 work');
    // Saving changes nothing in the workspace beyond what the refusal itself leaves.
    const unsaved = await commitAndPushAll({
      repos: ['owner/repo'],
      workspaceDir: second,
      branch: 'aidlc/test',
      gitProvider: 'github',
      message: 'stage attempt 1',
      urlsFor: () => ({ auth: remote, clean: remote }),
      log: () => {},
    });
    expect(unsaved.results[0].preserved).toBeUndefined();
    const refusedState = workspaceState(second);
    const saved1 = (await refuse(second, 1)).results[0];
    expect(saved1).toMatchObject({ committed: false, reason: 'sparse_outside_selection' });
    expect(workspaceState(second)).toEqual(refusedState);

    // Both snapshots are retrievable, each with its own attempt's edits.
    expect(saved0.preserved.ref).toBe(
      `refs/aidlc/refused/e1/code-generation--unit-a/attempt-0/${saved0.preserved.sha}`,
    );
    expect(saved1.preserved.ref).toBe(
      `refs/aidlc/refused/e1/code-generation--unit-a/attempt-1/${saved1.preserved.sha}`,
    );
    expect(git(remote, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/aidlc')).toBe(
      [saved0, saved1].map((r) => `${r.preserved.ref} ${r.preserved.sha}`).join('\n'),
    );
    for (const [saved, attempt] of [
      [saved0, 0],
      [saved1, 1],
    ]) {
      const { ref } = saved.preserved;
      expect(git(remote, 'rev-parse', `${ref}^`)).toBe(intentHead);
      expect(git(remote, 'show', `${ref}:services/api/index.js`)).toBe(`attempt ${attempt} work`);
      expect(git(remote, 'show', `${ref}:assets/large.txt`)).toBe(`attempt ${attempt} rewrite`);
      expect(git(remote, 'show', `${ref}:services/web/index.js`)).toBe('services/web/index.js');
    }
    // A clone that fetches the saved refs recovers attempt 0's work.
    const recovery = path.join(root, 'recovery');
    git(root, 'clone', '-q', remote, recovery);
    git(recovery, 'fetch', '-q', 'origin', saved0.preserved.ref);
    expect(git(recovery, 'show', 'FETCH_HEAD:services/api/index.js')).toBe('attempt 0 work');

    // The intent branch never moved, and no other branch appeared.
    expect(git(remote, 'rev-parse', 'refs/heads/aidlc/test')).toBe(intentHead);
    expect(branches()).toBe(branchesBefore);
  });

  // A unit lane (sparse: services/api) whose reverse merge of the intent
  // branch conflicts in services/web/index.js (outside the cone) and brings an
  // incoming, non-conflicting change to the hidden assets/large.txt.
  const conflictedLane = async () => {
    const unitBranch = 'aidlc/test--unit';
    git(source, 'checkout', '-b', unitBranch);
    await writeFile(path.join(source, 'services/web/index.js'), 'unit version\n');
    git(source, 'commit', '-am', 'unit change');
    git(source, 'checkout', '-b', 'aidlc/test', 'main');
    await writeFile(path.join(source, 'services/web/index.js'), 'intent version\n');
    await writeFile(path.join(source, 'assets/large.txt'), 'incoming intent change');
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
    expect(begin.baseline).toBeTruthy();
    expect(await readFile(path.join(target, 'services/web/index.js'), 'utf8')).toContain('<<<<<<<');
    const unitHead = git(remote, 'rev-parse', unitBranch);
    return { remote, unitBranch, options, begin, unitHead };
  };

  it('concludes and pushes resolved merge conflicts outside the lane cone', async () => {
    const { remote, unitBranch, options, begin } = await conflictedLane();
    await writeFile(path.join(target, 'services/web/index.js'), 'intent + unit resolution\n');
    const concluded = await concludeConflictMerge({
      ...options,
      conflicts: begin.conflicts,
      baseline: begin.baseline,
    });
    expect(concluded).toMatchObject({ concluded: true, pushed: true });
    expect(git(remote, 'show', `${unitBranch}:services/web/index.js`)).toBe(
      'intent + unit resolution',
    );
    // The incoming change to a hidden file is merged intact.
    expect(git(remote, 'show', `${unitBranch}:assets/large.txt`)).toBe('incoming intent change');
    expect(git(remote, 'rev-parse', unitBranch)).toBe(concluded.sha);
    expect(git(target, 'log', '-1', '--format=%P').split(' ')).toHaveLength(2);
    expect(git(target, 'diff', '--name-only', '--diff-filter=U')).toBe('');
    expect(git(target, 'status', '--porcelain')).toBe('');
  });

  it('refuses a merge whose agent also overwrote an unrelated hidden file', async () => {
    const { remote, unitBranch, options, begin, unitHead } = await conflictedLane();
    await writeFile(path.join(target, 'services/web/index.js'), 'intent + unit resolution\n');
    // services/web/index.js is the only materialized conflict; the hidden
    // assets file was never shown to the agent.
    await mkdir(path.join(target, 'assets'));
    await writeFile(path.join(target, 'assets/large.txt'), 'agent rewrite');
    const concluded = await concludeConflictMerge({
      ...options,
      conflicts: begin.conflicts,
      baseline: begin.baseline,
    });
    expect(concluded).toMatchObject({
      concluded: false,
      reason: 'sparse_outside_selection',
      outsideSelection: ['assets/large.txt'],
    });
    // Aborted before committing: nothing reached the remote, no merge in progress.
    expect(git(remote, 'rev-parse', unitBranch)).toBe(unitHead);
    expect(
      spawnSync('git', ['rev-parse', '--verify', 'MERGE_HEAD'], { cwd: target, env }).status,
    ).not.toBe(0);
  });

  it('refuses a merge whose agent staged an unrelated hidden change (git bypass)', async () => {
    const { remote, unitBranch, options, begin, unitHead } = await conflictedLane();
    await writeFile(path.join(target, 'services/web/index.js'), 'intent + unit resolution\n');
    git(target, 'rm', '--cached', '--sparse', '-q', 'assets/large.txt');
    const concluded = await concludeConflictMerge({
      ...options,
      conflicts: begin.conflicts,
      baseline: begin.baseline,
    });
    expect(concluded).toMatchObject({ concluded: false, reason: 'sparse_outside_selection' });
    expect(concluded.outsideSelection).toEqual(['assets/large.txt']);
    expect(git(remote, 'rev-parse', unitBranch)).toBe(unitHead);
  });

  it('refuses to conclude a sparse merge without the pre-agent baseline', async () => {
    const { remote, unitBranch, options, begin, unitHead } = await conflictedLane();
    await writeFile(path.join(target, 'services/web/index.js'), 'intent + unit resolution\n');
    const concluded = await concludeConflictMerge({ ...options, conflicts: begin.conflicts });
    expect(concluded).toMatchObject({ concluded: false, reason: 'sparse_check_failed' });
    expect(git(remote, 'rev-parse', unitBranch)).toBe(unitHead);
  });

  it('supports a sparse checkout without a requested branch', async () => {
    expect(
      (await checkoutRepo({ ...inputs(), branch: null, sparseDirectories: ['services/api'] }))
        .branchOk,
    ).toBe(true);
    expect(await exists(path.join(target, 'services/api/index.js'))).toBe(true);
    expect(await exists(path.join(target, 'assets'))).toBe(false);
  });

  // Runs real Git except for the commands `fail` answers itself.
  const failing = (fail) => (command, args, options) =>
    fail(args.slice(HOOKS_DISABLED_ARGS.length)) ?? runner(command, args, options);

  it('keeps --no-checkout on the shallow retry after the full clone ran out of storage', async () => {
    let clones = 0;
    const result = await checkoutRepo({
      ...inputs(),
      sparseDirectories: ['services/api'],
      runner: failing((args) =>
        args[0] === 'clone' && ++clones === 1
          ? { code: 128, stderr: 'fatal: write error: No space left on device' }
          : undefined,
      ),
    });
    expect(result).toMatchObject({ cloned: true, branchOk: true });
    // The refused full clone never reached the shared recorder; the retry did.
    expect(clones).toBe(2);
    expect(calls.filter((args) => args[0] === 'clone')).toEqual([
      ['clone', '--depth', '1', '--no-single-branch', '--no-checkout', expect.any(String), target],
    ]);
    expect(await exists(path.join(target, 'services/api/index.js'))).toBe(true);
    expect(await exists(path.join(target, 'assets'))).toBe(false);
  });

  it('removes the clone when HEAD cannot be populated without a requested branch', async () => {
    const result = await checkoutRepo({
      ...inputs(),
      branch: null,
      sparseDirectories: ['services/api'],
      runner: failing((args) => (args.join(' ') === 'checkout HEAD' ? { code: 1 } : undefined)),
    });
    expect(result).toMatchObject({
      cloned: false,
      branchOk: false,
      error: 'sparse_checkout_failed',
    });
    expect(await exists(target)).toBe(false);
  });

  it('keeps a warm checkout and reports the failure when its selection cannot be set', async () => {
    expect(
      (await checkoutRepo({ ...inputs(), sparseDirectories: ['services/api'] })).branchOk,
    ).toBe(true);
    await writeFile(path.join(target, 'services/api/index.js'), 'uncommitted');
    const result = await checkoutRepo({
      ...inputs(),
      sparseDirectories: ['services/web'],
      runner: failing((args) => (args[0] === 'sparse-checkout' ? { code: 1 } : undefined)),
    });
    expect(result).toEqual({
      repo: 'owner/repo',
      targetDir: target,
      cloned: true,
      branchOk: false,
      error: 'sparse_checkout_failed',
    });
    expect(await readFile(path.join(target, 'services/api/index.js'), 'utf8')).toBe('uncommitted');
  });

  it('checks out an empty repository with a selection, with and without a branch', async () => {
    await rm(source, { recursive: true, force: true });
    await mkdir(source);
    git(source, 'init', '-b', 'main');
    const unbranched = await checkoutRepo({
      ...inputs(),
      branch: null,
      sparseDirectories: ['services/api'],
    });
    expect(unbranched).toMatchObject({ cloned: true, branchOk: true });
    // Nothing to populate: HEAD is unborn.
    expect(calls.some((args) => args.join(' ') === 'checkout HEAD')).toBe(false);
    await rm(target, { recursive: true, force: true });
    const branched = await checkoutRepo({ ...inputs(), sparseDirectories: ['services/api'] });
    expect(branched).toMatchObject({ cloned: true, branchOk: true });
    expect(git(target, 'symbolic-ref', '--short', 'HEAD')).toBe('aidlc/test');
    expect(git(target, 'config', '--bool', 'core.sparseCheckoutCone')).toBe('true');
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
    './services/api',
    '/',
  ])('rejects unsafe selection %s before touching disk', async (directory) => {
    const result = await checkoutRepo({ ...inputs(), sparseDirectories: [directory] });
    expect(result.cloned).toBe(false);
    expect(calls).toEqual([]);
    expect(await exists(target)).toBe(false);
  });

  it('normalizes trailing slashes and names the rejected entry', () => {
    expect(validateSparseDirectories(['services/api/', 'services/api', 'docs//']).value).toEqual([
      'services/api',
      'docs',
    ]);
    const rejected = validateSparseDirectories(['./services/api']);
    expect(rejected.error).toContain('"./services/api"');
    expect(rejected.error).toContain('without a leading ./');
  });

  it('matches Git cone membership', () => {
    const dirs = ['services/api'];
    expect(isInSparseCone('README.md', dirs)).toBe(true);
    expect(isInSparseCone('services/config.json', dirs)).toBe(true);
    expect(isInSparseCone('services/api/index.js', dirs)).toBe(true);
    expect(isInSparseCone('services/api/deep/x.js', dirs)).toBe(true);
    expect(isInSparseCone('services/web/index.js', dirs)).toBe(false);
    expect(isInSparseCone('services/apix/index.js', dirs)).toBe(false);
    expect(isInSparseCone('assets/large.txt', dirs)).toBe(false);
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
