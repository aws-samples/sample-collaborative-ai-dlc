import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  runGit,
  cleanRemoteUrl,
  scrubRemote,
  commitAll,
  isAheadOfRemote,
  pushBranch,
  remoteBranchExists,
  commitAndPushAll,
  seedInitialCommit,
} from '../git-engine.js';

// Real git spawns (~10 per test) can be slow on busy CI machines.
vi.setConfig({ testTimeout: 30_000 });

// WP2 (docs/v2-parallel.md): the engine-owned git layer, exercised against
// REAL git in throwaway repos with a local bare "remote" (file:// URLs stand in
// for the tokenized/clean https URLs via the `urls` seam). This proves the
// actual porcelain/plumbing behavior — commit, push, retry, remote-HEAD
// verification, credential scrubbing — not just argv shapes.

let root; // scratch dir per test: <root>/remote.git (bare), <root>/work (clone)

const git = (args, cwd) => runGit(args, { cwd });

const initRemoteAndClone = async ({ withInitialCommit = true } = {}) => {
  const remote = path.join(root, 'remote.git');
  const work = path.join(root, 'work');
  await git(['init', '--bare', '-b', 'main', remote], root);
  if (withInitialCommit) {
    const seed = path.join(root, 'seed');
    await git(['init', '-b', 'main', seed], root);
    await writeFile(path.join(seed, 'README.md'), 'seed\n');
    await git(['add', '-A'], seed);
    await git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'seed'], seed);
    await git(['push', remote, 'main'], seed);
  }
  await git(['clone', remote, work], root);
  if (!withInitialCommit) {
    // Clone of an empty bare repo leaves no branch; mirror workspace.js's
    // git-init fallback shape (a repo with origin but no commits).
    await git(['checkout', '-b', 'main'], work);
  }
  return { remote, work };
};

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'git-engine-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('cleanRemoteUrl', () => {
  it('builds a token-free https URL per provider', () => {
    expect(cleanRemoteUrl('owner/repo', 'github')).toBe('https://github.com/owner/repo.git');
    expect(cleanRemoteUrl('owner/repo', 'gitlab')).toBe('https://gitlab.com/owner/repo.git');
    // Legacy/blank provider defaults to github.
    expect(cleanRemoteUrl('owner/repo', undefined)).toBe('https://github.com/owner/repo.git');
  });
});

describe('scrubRemote', () => {
  it('resets an existing origin to the clean URL (token gone from .git/config)', async () => {
    const { work } = await initRemoteAndClone();
    // Built at runtime so secret scanners don't flag a basic-auth literal —
    // this is a FAKE token exercising the scrub.
    const fakeToken = ['NOT', 'A', 'REAL', 'SECRET'].join('');
    const tokenizedUrl = `https://x-access-token:${fakeToken}@github.com/o/r.git`;
    await git(['remote', 'set-url', 'origin', tokenizedUrl], work);
    const res = await scrubRemote({ dir: work, repo: 'o/r', gitProvider: 'github' });
    expect(res.scrubbed).toBe(true);
    const config = await readFile(path.join(work, '.git', 'config'), 'utf8');
    expect(config).not.toContain(fakeToken);
    expect(config).toContain('https://github.com/o/r.git');
  });

  it('adds origin when the repo has none (git-init fallback)', async () => {
    const bare = path.join(root, 'norigin');
    await git(['init', bare], root);
    const res = await scrubRemote({ dir: bare, repo: 'o/r', gitProvider: 'github' });
    expect(res.scrubbed).toBe(true);
    const { stdout } = await git(['remote', 'get-url', 'origin'], bare);
    expect(stdout.trim()).toBe('https://github.com/o/r.git');
  });
});

describe('commitAll', () => {
  it('commits the whole tree with the engine identity and returns the sha', async () => {
    const { work } = await initRemoteAndClone();
    await writeFile(path.join(work, 'src.js'), 'export const x = 1;\n');
    const res = await commitAll({ dir: work, message: 'aidlc(code-generation): e1' });
    expect(res.committed).toBe(true);
    expect(res.sha).toMatch(/^[0-9a-f]{40}$/);
    const log = await git(['log', '-1', '--format=%an|%ae|%s'], work);
    expect(log.stdout.trim()).toBe(
      'AI-DLC Engine|aidlc-engine@noreply.local|aidlc(code-generation): e1',
    );
    // The repo config was NOT mutated (identity passed per-command).
    const cfg = await git(['config', '--local', '--get', 'user.email'], work);
    expect(cfg.exitCode).not.toBe(0);
  });

  it('reports clean when there is nothing to commit', async () => {
    const { work } = await initRemoteAndClone();
    const res = await commitAll({ dir: work, message: 'aidlc(x): e1' });
    expect(res).toEqual({ committed: false, reason: 'clean' });
  });

  it('is immune to ambient GIT_* env (running inside a git hook must not redirect or re-identify)', async () => {
    // Regression: when the engine is spawned from inside a git hook (or any
    // git-managed process), GIT_DIR / GIT_INDEX_FILE / GIT_AUTHOR_* leak into
    // child processes and redirect git to the WRONG repository or identity.
    const { work } = await initRemoteAndClone();
    const saved = {};
    const ambient = {
      GIT_DIR: path.join(root, 'bogus', '.git'),
      GIT_INDEX_FILE: path.join(root, 'bogus-index'),
      GIT_WORK_TREE: path.join(root, 'bogus-tree'),
      GIT_AUTHOR_NAME: 'Hook Author',
      GIT_AUTHOR_EMAIL: 'hook@example.com',
    };
    for (const [k, v] of Object.entries(ambient)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    try {
      await writeFile(path.join(work, 'hooked.js'), 'x\n');
      const res = await commitAll({ dir: work, message: 'aidlc(x): e1' });
      expect(res.committed).toBe(true);
      const log = await git(['log', '-1', '--format=%an|%ae'], work);
      expect(log.stdout.trim()).toBe('AI-DLC Engine|aidlc-engine@noreply.local');
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it('captures untracked, modified AND deleted files (add -A semantics)', async () => {
    const { work } = await initRemoteAndClone();
    await writeFile(path.join(work, 'new.txt'), 'new\n');
    await rm(path.join(work, 'README.md'));
    const res = await commitAll({ dir: work, message: 'aidlc(x): e1' });
    expect(res.committed).toBe(true);
    const show = await git(['show', '--stat', '--format='], work);
    expect(show.stdout).toContain('new.txt');
    expect(show.stdout).toContain('README.md');
  });
});

describe('seedInitialCommit', () => {
  it('roots history on the BASE branch and forks the intent branch off it (empty repo)', async () => {
    const { work } = await initRemoteAndClone({ withInitialCommit: false });
    // Empty repo: unborn HEAD, currently on a branch with no commit.
    expect((await git(['rev-parse', '--verify', 'HEAD'], work)).exitCode).not.toBe(0);

    const res = await seedInitialCommit({
      dir: work,
      branch: 'aidlc/i1',
      baseBranch: 'main',
    });
    expect(res.seeded).toBe(true);
    expect(res.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(res.baseBranch).toBe('main');

    // Working tree ends on the intent branch, forked off the base at the same SHA.
    const head = await git(['rev-parse', '--abbrev-ref', 'HEAD'], work);
    expect(head.stdout.trim()).toBe('aidlc/i1');
    const baseSha = await git(['rev-parse', 'main'], work);
    const intentSha = await git(['rev-parse', 'aidlc/i1'], work);
    expect(baseSha.stdout.trim()).toBe(intentSha.stdout.trim());

    // The base branch pushes FIRST (becomes remote default), then the intent one.
    const basePush = await pushBranch({
      dir: work,
      repo: 'o/r',
      branch: 'main',
      urls: { auth: path.join(root, 'remote.git') },
    });
    expect(basePush.pushed).toBe(true);
    const intentPush = await pushBranch({
      dir: work,
      repo: 'o/r',
      branch: 'aidlc/i1',
      urls: { auth: path.join(root, 'remote.git') },
    });
    expect(intentPush.pushed).toBe(true);
  });

  it('defaults the base branch to main when none is provided', async () => {
    const { work } = await initRemoteAndClone({ withInitialCommit: false });
    const res = await seedInitialCommit({ dir: work, branch: 'aidlc/i1' });
    expect(res.seeded).toBe(true);
    expect(res.baseBranch).toBe('main');
    expect((await git(['rev-parse', '--verify', 'main'], work)).exitCode).toBe(0);
  });

  it('is a no-op on a repo that already has history', async () => {
    const { work } = await initRemoteAndClone({ withInitialCommit: true });
    const res = await seedInitialCommit({ dir: work, branch: 'aidlc/i1', baseBranch: 'main' });
    expect(res).toEqual({ seeded: false, reason: 'not_empty' });
  });
});

// ── commitAll durability hardening (the 2026-07 "no changes" incident) ───────
// Retry/self-heal paths are driven through a SCRIPTED git stub — real ENOSPC
// cannot be simulated hermetically. The stub answers by argv substring; more
// specific matchers first.
describe('commitAll — retry / ENOSPC self-heal / dirty reporting', () => {
  const scriptedGit = (script) => {
    const calls = [];
    const fn = async (args) => {
      const line = args.join(' ');
      calls.push(line);
      for (const [match, resp] of script) {
        if (line.includes(match)) {
          const r = typeof resp === 'function' ? resp(args, calls) : resp;
          return { exitCode: 0, stdout: '', stderr: '', ...r };
        }
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    fn.calls = calls;
    return fn;
  };
  const quiet = () => {};

  it('retries a transient commit failure with backoff and succeeds', async () => {
    let commits = 0;
    const g = scriptedGit([
      ['status --porcelain --ignored', { stdout: '' }],
      ['status --porcelain', { stdout: ' M src.js\n' }],
      [
        'commit',
        () =>
          ++commits === 1
            ? { exitCode: 1, stderr: 'error: unable to write — waiting to be backed up' }
            : { exitCode: 0 },
      ],
      ['rev-parse HEAD', { stdout: `${'a'.repeat(40)}\n` }],
    ]);
    const sleep = vi.fn(async () => {});
    const res = await commitAll({ dir: root, message: 'm', git: g, sleep, log: quiet });
    expect(res.committed).toBe(true);
    expect(commits).toBe(2);
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it('persistent ENOSPC reclaims ONLY well-known git-ignored dirs and then commits', async () => {
    let reclaimed = false;
    const rmDir = vi.fn(async () => {
      reclaimed = true;
    });
    const g = scriptedGit([
      // The ignored listing: node_modules is reclaimable; dist is NOT in the
      // reclaim set; .env is a file (no trailing slash) — both must survive.
      ['status --porcelain --ignored', { stdout: '!! node_modules/\n!! dist/\n!! .env\n' }],
      ['status --porcelain', { stdout: ' M src.js\n' }],
      [
        'commit',
        () =>
          reclaimed
            ? { exitCode: 0 }
            : {
                exitCode: 1,
                stderr: 'fatal: unable to write loose object: No space left on device',
              },
      ],
      ['rev-parse HEAD', { stdout: `${'b'.repeat(40)}\n` }],
    ]);
    const res = await commitAll({
      dir: root,
      message: 'm',
      git: g,
      sleep: async () => {},
      log: quiet,
      rmDir,
    });
    expect(res.committed).toBe(true);
    expect(res.reclaimed).toEqual(['node_modules']);
    expect(rmDir).toHaveBeenCalledTimes(1);
    expect(rmDir.mock.calls[0][0]).toBe(path.resolve(root, 'node_modules'));
  });

  it('a terminal commit failure reports dirty:true with the git stderr (stage-failing signal)', async () => {
    const rmDir = vi.fn();
    const g = scriptedGit([
      ['status --porcelain --ignored', { stdout: '' }],
      ['status --porcelain', { stdout: ' M src.js\n' }],
      ['commit', { exitCode: 1, stderr: 'fatal: disk I/O error' }],
    ]);
    const sleep = vi.fn(async () => {});
    const res = await commitAll({
      dir: root,
      message: 'm',
      git: g,
      sleep,
      log: quiet,
      rmDir,
    });
    expect(res).toMatchObject({
      committed: false,
      reason: 'commit_failed',
      dirty: true,
    });
    expect(res.detail).toContain('disk I/O error');
    // Non-ENOSPC failures never trigger the reclaim.
    expect(rmDir).not.toHaveBeenCalled();
    // All three attempts ran, with linear backoff between them.
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([2000, 4000]);
  });

  it('an add failure with a CLEAN tree reports dirty:false (no work at risk)', async () => {
    const g = scriptedGit([
      ['add -A', { exitCode: 1, stderr: 'error: transient lock' }],
      ['status --porcelain --ignored', { stdout: '' }],
      ['status --porcelain', { stdout: '' }],
    ]);
    const res = await commitAll({
      dir: root,
      message: 'm',
      git: g,
      sleep: async () => {},
      log: quiet,
    });
    expect(res).toMatchObject({ committed: false, reason: 'add_failed', dirty: false });
  });

  it('reclaim never escapes the repo dir (a hostile ignored path is skipped)', async () => {
    const rmDir = vi.fn(async () => {});
    const g = scriptedGit([
      ['status --porcelain --ignored', { stdout: '!! ../../outside/node_modules/\n' }],
      ['status --porcelain', { stdout: ' M src.js\n' }],
      ['commit', { exitCode: 1, stderr: 'No space left on device' }],
    ]);
    const res = await commitAll({
      dir: root,
      message: 'm',
      git: g,
      sleep: async () => {},
      log: quiet,
      rmDir,
    });
    expect(rmDir).not.toHaveBeenCalled();
    expect(res.committed).toBe(false);
  });
});

describe('isAheadOfRemote', () => {
  it('false right after clone (remote-tracking ref matches HEAD)', async () => {
    const { work } = await initRemoteAndClone();
    expect(await isAheadOfRemote({ dir: work, branch: 'main' })).toBe(false);
  });

  it('true when a new branch has never been pushed', async () => {
    const { work } = await initRemoteAndClone();
    await git(['checkout', '-b', 'ai-dlc/i1'], work);
    expect(await isAheadOfRemote({ dir: work, branch: 'ai-dlc/i1' })).toBe(true);
  });

  it('true after a local commit, false again after a push', async () => {
    const { work, remote } = await initRemoteAndClone();
    await writeFile(path.join(work, 'a.txt'), 'a\n');
    await commitAll({ dir: work, message: 'aidlc(x): e1' });
    expect(await isAheadOfRemote({ dir: work, branch: 'main' })).toBe(true);
    await pushBranch({
      dir: work,
      repo: 'o/r',
      branch: 'main',
      urls: { auth: remote, clean: remote },
    });
    expect(await isAheadOfRemote({ dir: work, branch: 'main' })).toBe(false);
  });

  it('false for an empty repo (no HEAD)', async () => {
    const empty = path.join(root, 'empty');
    await git(['init', empty], root);
    expect(await isAheadOfRemote({ dir: empty, branch: 'main' })).toBe(false);
  });
});

describe('remoteBranchExists', () => {
  it('true for an existing remote branch, false for an absent one', async () => {
    const { work, remote } = await initRemoteAndClone();
    const urls = { auth: remote, clean: 'https://github.com/o/r.git' };

    const present = await remoteBranchExists({ dir: work, repo: 'o/r', branch: 'main', urls });
    expect(present).toEqual({ exists: true });

    const absent = await remoteBranchExists({
      dir: work,
      repo: 'o/r',
      branch: 'aidlc/never',
      urls,
    });
    expect(absent).toEqual({ exists: false });
  });

  it('restores the clean URL after the check (token window scrubbed)', async () => {
    const { work, remote } = await initRemoteAndClone();
    await remoteBranchExists({
      dir: work,
      repo: 'o/r',
      branch: 'main',
      urls: { auth: remote, clean: 'https://github.com/o/r.git' },
    });
    const url = await git(['remote', 'get-url', 'origin'], work);
    expect(url.stdout.trim()).toBe('https://github.com/o/r.git');
  });

  it('returns exists:null (undetermined) when the remote is unreachable', async () => {
    const { work } = await initRemoteAndClone();
    const res = await remoteBranchExists({
      dir: work,
      repo: 'o/r',
      branch: 'main',
      urls: { auth: path.join(root, 'does-not-exist.git'), clean: 'https://github.com/o/r.git' },
    });
    expect(res.exists).toBeNull();
  });
});

describe('pushBranch', () => {
  it('pushes HEAD to the branch refspec and verifies the remote head', async () => {
    const { work, remote } = await initRemoteAndClone();
    await writeFile(path.join(work, 'b.txt'), 'b\n');
    const commit = await commitAll({ dir: work, message: 'aidlc(x): e1' });
    const res = await pushBranch({
      dir: work,
      repo: 'o/r',
      branch: 'ai-dlc/i1', // remote branch name differs from local (HEAD refspec)
      urls: { auth: remote, clean: 'https://github.com/o/r.git' },
    });
    expect(res).toEqual({ pushed: true, sha: commit.sha, verified: true });
    const remoteHead = await git(
      ['rev-parse', 'refs/heads/ai-dlc/i1'],
      path.join(root, 'remote.git'),
    );
    expect(remoteHead.stdout.trim()).toBe(commit.sha);
  });

  it('ALWAYS restores the clean URL after the push window — success and failure', async () => {
    const { work, remote } = await initRemoteAndClone();
    await writeFile(path.join(work, 'c.txt'), 'c\n');
    await commitAll({ dir: work, message: 'aidlc(x): e1' });

    await pushBranch({
      dir: work,
      repo: 'o/r',
      branch: 'main',
      urls: { auth: remote, clean: 'https://github.com/o/r.git' },
    });
    let url = await git(['remote', 'get-url', 'origin'], work);
    expect(url.stdout.trim()).toBe('https://github.com/o/r.git');

    // Failure path: unreachable auth URL; sleep stubbed to avoid backoff delay.
    const res = await pushBranch({
      dir: work,
      repo: 'o/r',
      branch: 'main',
      attempts: 2,
      sleep: async () => {},
      log: () => {},
      urls: { auth: path.join(root, 'nonexistent.git'), clean: 'https://github.com/o/r.git' },
    });
    expect(res.pushed).toBe(false);
    expect(res.reason).toBe('push_failed');
    url = await git(['remote', 'get-url', 'origin'], work);
    expect(url.stdout.trim()).toBe('https://github.com/o/r.git');
  });

  it('retries with backoff before giving up', async () => {
    const { work } = await initRemoteAndClone();
    await writeFile(path.join(work, 'd.txt'), 'd\n');
    await commitAll({ dir: work, message: 'aidlc(x): e1' });
    const sleeps = [];
    const res = await pushBranch({
      dir: work,
      repo: 'o/r',
      branch: 'main',
      attempts: 3,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      log: () => {},
      urls: { auth: path.join(root, 'nonexistent.git'), clean: 'https://github.com/o/r.git' },
    });
    expect(res.pushed).toBe(false);
    // Linear backoff between attempts (v1 semantics): 2s, 4s.
    expect(sleeps).toEqual([2000, 4000]);
  });

  it("returns the neutral 'empty' sentinel for a repo with no commits", async () => {
    const empty = path.join(root, 'empty');
    await git(['init', empty], root);
    const res = await pushBranch({
      dir: empty,
      repo: 'o/r',
      branch: 'main',
      urls: { auth: 'x', clean: 'y' },
    });
    expect(res).toEqual({ pushed: 'empty' });
  });

  it('refuses without a branch', async () => {
    const res = await pushBranch({ dir: root, repo: 'o/r', branch: null });
    expect(res).toEqual({ pushed: false, reason: 'no_branch' });
  });
});

describe('commitAndPushAll — the stage-exit hook', () => {
  it('single repo: commits + pushes new work and reports ok', async () => {
    const { work, remote } = await initRemoteAndClone();
    await git(['checkout', '-b', 'ai-dlc/i1'], work);
    await writeFile(path.join(work, 'feature.js'), 'export const f = 1;\n');

    const res = await commitAndPushAll({
      repos: ['o/r'],
      workspaceDir: work,
      branch: 'ai-dlc/i1',
      gitToken: 'unused',
      gitProvider: 'github',
      message: 'aidlc(code-generation): e1',
      urlsFor: () => ({ auth: remote, clean: 'https://github.com/o/r.git' }),
    });
    expect(res.ok).toBe(true);
    expect(res.committed).toBe(true);
    expect(res.results).toHaveLength(1);
    expect(res.results[0]).toMatchObject({ repo: 'o/r', committed: true, pushed: true });
    const remoteHead = await git(
      ['rev-parse', 'refs/heads/ai-dlc/i1'],
      path.join(root, 'remote.git'),
    );
    expect(remoteHead.stdout.trim()).toBe(res.results[0].sha);
  });

  it('clean tree + up-to-date remote: no commit, NO network (pushed: up_to_date)', async () => {
    const { work } = await initRemoteAndClone();
    const res = await commitAndPushAll({
      repos: ['o/r'],
      workspaceDir: work,
      branch: 'main',
      gitToken: '',
      gitProvider: 'github',
      message: 'aidlc(x): e1',
      // Unreachable URLs — if the engine touched the network this would fail.
      urlsFor: () => ({ auth: path.join(root, 'nope.git'), clean: 'https://github.com/o/r.git' }),
    });
    expect(res.ok).toBe(true);
    expect(res.committed).toBe(false);
    expect(res.results[0].pushed).toBe('up_to_date');
  });

  it('clean tree but ahead of remote: retries the push of earlier work', async () => {
    const { work, remote } = await initRemoteAndClone();
    // Simulate an earlier stage exit whose push failed: commit locally only.
    await writeFile(path.join(work, 'earlier.js'), 'x\n');
    await commitAll({ dir: work, message: 'aidlc(earlier): e1' });

    const res = await commitAndPushAll({
      repos: ['o/r'],
      workspaceDir: work,
      branch: 'main',
      gitToken: '',
      gitProvider: 'github',
      message: 'aidlc(now): e1',
      urlsFor: () => ({ auth: remote, clean: 'https://github.com/o/r.git' }),
    });
    expect(res.ok).toBe(true);
    expect(res.committed).toBe(false); // THIS call created no commit…
    expect(res.results[0].pushed).toBe(true); // …but the earlier one got pushed
  });

  it('push failure with a new commit: ok=false, committed=true (stage-failing condition)', async () => {
    const { work } = await initRemoteAndClone();
    await writeFile(path.join(work, 'atrisk.js'), 'y\n');
    const res = await commitAndPushAll({
      repos: ['o/r'],
      workspaceDir: work,
      branch: 'main',
      gitToken: '',
      gitProvider: 'github',
      message: 'aidlc(x): e1',
      sleep: async () => {},
      log: () => {},
      urlsFor: () => ({ auth: path.join(root, 'nope.git'), clean: 'https://github.com/o/r.git' }),
    });
    expect(res.ok).toBe(false);
    expect(res.committed).toBe(true);
    expect(res.results[0]).toMatchObject({ committed: true, pushed: false, reason: 'push_failed' });
    // The commit is preserved locally for the retry.
    const head = await git(['log', '-1', '--format=%s'], work);
    expect(head.stdout.trim()).toBe('aidlc(x): e1');
  });

  it('empty repo list is a no-op with ok=true', async () => {
    const res = await commitAndPushAll({
      repos: [],
      workspaceDir: root,
      branch: 'main',
      message: 'aidlc(x): e1',
    });
    expect(res).toEqual({ ok: true, committed: false, results: [] });
  });

  it('multi-repo: each repo commits/pushes in its own subdir; one failure flips ok', async () => {
    // repo A under <ws>/o/a (healthy), repo B under <ws>/o/b (push fails).
    const ws = path.join(root, 'ws');
    const remoteA = path.join(root, 'a.git');
    await git(['init', '--bare', '-b', 'main', remoteA], root);
    for (const sub of ['o/a', 'o/b']) {
      const dir = path.join(ws, sub);
      await git(['init', '-b', 'main', dir], root);
      await writeFile(path.join(dir, 'file.txt'), `${sub}\n`);
      await git(['remote', 'add', 'origin', 'https://github.com/x/y.git'], dir);
    }
    const res = await commitAndPushAll({
      repos: ['o/a', 'o/b'],
      workspaceDir: ws,
      branch: 'main',
      gitToken: '',
      gitProvider: 'github',
      message: 'aidlc(x): e1',
      sleep: async () => {},
      log: () => {},
      urlsFor: (repo) =>
        repo === 'o/a'
          ? { auth: remoteA, clean: 'https://github.com/o/a.git' }
          : { auth: path.join(root, 'nope.git'), clean: 'https://github.com/o/b.git' },
    });
    expect(res.ok).toBe(false);
    expect(res.committed).toBe(true);
    const byRepo = Object.fromEntries(res.results.map((r) => [r.repo, r]));
    expect(byRepo['o/a']).toMatchObject({ committed: true, pushed: true });
    expect(byRepo['o/b']).toMatchObject({ committed: true, pushed: false });
  });

  it('never throws — a crashing git runner becomes an engine_crashed result', async () => {
    const res = await commitAndPushAll({
      repos: ['o/r'],
      workspaceDir: root,
      branch: 'main',
      message: 'aidlc(x): e1',
      log: () => {},
      git: async () => {
        throw new Error('spawn exploded');
      },
    });
    expect(res.ok).toBe(false);
    expect(res.results[0]).toMatchObject({ reason: 'engine_crashed', detail: 'spawn exploded' });
  });
});

// ── WP5: lane primitives (docs/v2-parallel.md A3 — lane start / lane end) ────

import { fetchOrigin, ensureLaneBranch, mergeBranchNoFf } from '../git-engine.js';

// Commit a file onto a branch of the bare remote via a throwaway clone —
// simulates another session (a lane / the pre-section stages) pushing work.
const commitOnRemote = async (remote, branch, file, content, msg = `add ${file}`) => {
  const dir = await mkdtemp(path.join(root, 'peer-'));
  await git(['clone', remote, dir], root);
  const co = await git(['checkout', branch], dir);
  if (co.exitCode !== 0) await git(['checkout', '-b', branch], dir);
  await writeFile(path.join(dir, file), content);
  await git(['add', '-A'], dir);
  await git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', msg], dir);
  await git(['push', 'origin', `HEAD:refs/heads/${branch}`], dir);
};

const laneUrls = (remote) => ({ auth: remote, clean: 'https://github.com/o/r.git' });
const quiet = { sleep: async () => {}, log: () => {} };

describe('fetchOrigin', () => {
  it('fetches remote refs inside the token window and scrubs after', async () => {
    const { remote, work } = await initRemoteAndClone();
    await commitOnRemote(remote, 'feat/x', 'x.txt', 'x\n');
    const res = await fetchOrigin({ dir: work, repo: 'o/r', urls: laneUrls(remote) });
    expect(res).toEqual({ fetched: true });
    const ref = await git(['rev-parse', '--verify', 'refs/remotes/origin/feat/x'], work);
    expect(ref.exitCode).toBe(0);
    const { stdout } = await git(['remote', 'get-url', 'origin'], work);
    expect(stdout.trim()).toBe('https://github.com/o/r.git'); // scrubbed even on success
  });

  it('reports a fetch failure as a value and still scrubs', async () => {
    const { work } = await initRemoteAndClone();
    const res = await fetchOrigin({
      dir: work,
      repo: 'o/r',
      urls: { auth: path.join(root, 'nonexistent.git'), clean: 'https://github.com/o/r.git' },
    });
    expect(res.fetched).toBe(false);
    expect(res.reason).toBe('fetch_failed');
    const { stdout } = await git(['remote', 'get-url', 'origin'], work);
    expect(stdout.trim()).toBe('https://github.com/o/r.git');
  });
});

describe('ensureLaneBranch', () => {
  it('creates the unit branch from the intent branch remote HEAD and pushes it', async () => {
    const { remote, work } = await initRemoteAndClone();
    // The intent branch exists remotely (pre-section stages pushed it).
    await commitOnRemote(remote, 'aidlc/i1', 'intent.txt', 'intent work\n');
    const res = await ensureLaneBranch({
      dir: work,
      repo: 'o/r',
      unitBranch: 'aidlc/i1--s1-unit-auth',
      intentBranch: 'aidlc/i1',
      urls: laneUrls(remote),
      ...quiet,
    });
    expect(res.ready).toBe(true);
    expect(res.created).toBe(true);
    // Checked out on the unit branch, containing the intent branch's work.
    const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], work);
    expect(branch.stdout.trim()).toBe('aidlc/i1--s1-unit-auth');
    const ls = await git(['ls-remote', remote, 'aidlc/i1--s1-unit-auth'], root);
    expect(ls.stdout.trim()).not.toBe(''); // registered on the remote
    const file = await readFile(path.join(work, 'intent.txt'), 'utf8');
    expect(file).toBe('intent work\n');
  });

  it('re-checks out an EXISTING remote unit branch (lane retry / wiped mount)', async () => {
    const { remote, work } = await initRemoteAndClone();
    await commitOnRemote(remote, 'aidlc/i1', 'intent.txt', 'intent work\n');
    await commitOnRemote(remote, 'aidlc/i1--s1-unit-auth', 'auth.txt', 'lane work\n');
    const res = await ensureLaneBranch({
      dir: work,
      repo: 'o/r',
      unitBranch: 'aidlc/i1--s1-unit-auth',
      intentBranch: 'aidlc/i1',
      urls: laneUrls(remote),
      ...quiet,
    });
    expect(res.ready).toBe(true);
    expect(res.created).toBe(false);
    // The lane's prior pushed work is present — never recreated from scratch.
    const file = await readFile(path.join(work, 'auth.txt'), 'utf8');
    expect(file).toBe('lane work\n');
  });

  it('publishes a local commit rejected by the previous push without discarding it', async () => {
    const { remote, work } = await initRemoteAndClone();
    await commitOnRemote(remote, 'aidlc/i1', 'intent.txt', 'intent work\n');
    await fetchOrigin({ dir: work, repo: 'o/r', urls: laneUrls(remote) });
    await git(['checkout', '-B', 'aidlc/i1--s1-unit-auth', 'refs/remotes/origin/aidlc/i1'], work);
    await git(['push', remote, 'HEAD:refs/heads/aidlc/i1--s1-unit-auth'], work);
    await writeFile(path.join(work, 'auth.txt'), 'unpublished lane work\n');
    await git(['add', '-A'], work);
    await git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'lane work'], work);
    const localSha = (await git(['rev-parse', 'HEAD'], work)).stdout.trim();

    const res = await ensureLaneBranch({
      dir: work,
      repo: 'o/r',
      unitBranch: 'aidlc/i1--s1-unit-auth',
      intentBranch: 'aidlc/i1',
      urls: laneUrls(remote),
      ...quiet,
    });

    expect(res).toEqual({ ready: true, created: false, sha: localSha });
    const remoteSha = (
      await git(['ls-remote', remote, 'refs/heads/aidlc/i1--s1-unit-auth'], root)
    ).stdout.split(/\s/)[0];
    expect(remoteSha).toBe(localSha);
    expect(await readFile(path.join(work, 'auth.txt'), 'utf8')).toBe('unpublished lane work\n');
  });

  it('publishes an unpublished local unit branch when no remote unit ref exists', async () => {
    const { remote, work } = await initRemoteAndClone();
    await commitOnRemote(remote, 'aidlc/i1', 'intent.txt', 'intent work\n');
    await fetchOrigin({ dir: work, repo: 'o/r', urls: laneUrls(remote) });
    await git(['checkout', '-B', 'aidlc/i1--s1-unit-auth', 'refs/remotes/origin/aidlc/i1'], work);
    await writeFile(path.join(work, 'auth.txt'), 'local lane work\n');
    await git(['add', '-A'], work);
    await git(
      ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'local lane work'],
      work,
    );
    const localSha = (await git(['rev-parse', 'HEAD'], work)).stdout.trim();

    const res = await ensureLaneBranch({
      dir: work,
      repo: 'o/r',
      unitBranch: 'aidlc/i1--s1-unit-auth',
      intentBranch: 'aidlc/i1',
      urls: laneUrls(remote),
      ...quiet,
    });

    expect(res).toEqual({ ready: true, created: true, sha: localSha });
    const remoteSha = (
      await git(['ls-remote', remote, 'refs/heads/aidlc/i1--s1-unit-auth'], root)
    ).stdout.split(/\s/)[0];
    expect(remoteSha).toBe(localSha);
  });

  it('fails with intent_branch_missing when the fork point does not exist remotely', async () => {
    const { remote, work } = await initRemoteAndClone();
    const res = await ensureLaneBranch({
      dir: work,
      repo: 'o/r',
      unitBranch: 'aidlc/i1--s1-unit-auth',
      intentBranch: 'aidlc/ghost',
      urls: laneUrls(remote),
      ...quiet,
    });
    expect(res).toMatchObject({ ready: false, reason: 'intent_branch_missing' });
  });

  it('fails as a value when the remote is unreachable', async () => {
    const { work } = await initRemoteAndClone();
    const res = await ensureLaneBranch({
      dir: work,
      repo: 'o/r',
      unitBranch: 'u',
      intentBranch: 'i',
      urls: { auth: path.join(root, 'nonexistent.git'), clean: 'https://github.com/o/r.git' },
      ...quiet,
    });
    expect(res.ready).toBe(false);
    expect(res.reason).toBe('fetch_failed');
  });
});

describe('mergeBranchNoFf', () => {
  const setup = async () => {
    const { remote, work } = await initRemoteAndClone();
    await commitOnRemote(remote, 'aidlc/i1', 'base.txt', 'base\n');
    // The intent workspace sits on the intent branch (like the intent session).
    await fetchOrigin({ dir: work, repo: 'o/r', urls: laneUrls(remote) });
    await git(['checkout', '-B', 'aidlc/i1', 'refs/remotes/origin/aidlc/i1'], work);
    return { remote, work };
  };

  it('merges the unit branch with --no-ff, engine identity, and pushes the intent branch', async () => {
    const { remote, work } = await setup();
    await commitOnRemote(remote, 'aidlc/i1--s1-unit-auth', 'auth.txt', 'auth code\n');
    const res = await mergeBranchNoFf({
      dir: work,
      repo: 'o/r',
      intentBranch: 'aidlc/i1',
      unitBranch: 'aidlc/i1--s1-unit-auth',
      message: 'aidlc(merge): auth — e1',
      urls: laneUrls(remote),
      ...quiet,
    });
    expect(res.merged).toBe(true);
    expect(res.sha).toMatch(/^[0-9a-f]{40}$/);
    // A true merge commit (two parents) with the engine identity, on the remote.
    const parents = await git(['log', '-1', '--format=%P'], work);
    expect(parents.stdout.trim().split(' ')).toHaveLength(2);
    const who = await git(['log', '-1', '--format=%an|%s'], work);
    expect(who.stdout.trim()).toBe('AI-DLC Engine|aidlc(merge): auth — e1');
    const ls = await git(['ls-remote', remote, 'aidlc/i1'], root);
    expect(ls.stdout.trim().split(/\s/)[0]).toBe(res.sha);
    // The merged file is in the intent branch's tree.
    const file = await readFile(path.join(work, 'auth.txt'), 'utf8');
    expect(file).toBe('auth code\n');
  });

  it('is idempotent: a re-dispatched merge of an already-merged lane is up_to_date', async () => {
    const { remote, work } = await setup();
    await commitOnRemote(remote, 'aidlc/i1--s1-unit-auth', 'auth.txt', 'auth code\n');
    const args = {
      dir: work,
      repo: 'o/r',
      intentBranch: 'aidlc/i1',
      unitBranch: 'aidlc/i1--s1-unit-auth',
      message: 'aidlc(merge): auth — e1',
      urls: laneUrls(remote),
      ...quiet,
    };
    const first = await mergeBranchNoFf(args);
    expect(first.merged).toBe(true);
    const second = await mergeBranchNoFf(args);
    expect(second.merged).toBe('up_to_date');
  });

  it('serialized merges: a second lane merges on top of the first (deps see merged code)', async () => {
    const { remote, work } = await setup();
    await commitOnRemote(remote, 'aidlc/i1--s1-unit-auth', 'auth.txt', 'auth code\n');
    await commitOnRemote(remote, 'aidlc/i1--s1-unit-billing', 'billing.txt', 'billing code\n');
    const merge = (unit) =>
      mergeBranchNoFf({
        dir: work,
        repo: 'o/r',
        intentBranch: 'aidlc/i1',
        unitBranch: `aidlc/i1--s1-unit-${unit}`,
        message: `aidlc(merge): ${unit} — e1`,
        urls: laneUrls(remote),
        ...quiet,
      });
    expect((await merge('auth')).merged).toBe(true);
    expect((await merge('billing')).merged).toBe(true);
    // Both files present on the merged intent branch.
    expect(await readFile(path.join(work, 'auth.txt'), 'utf8')).toBe('auth code\n');
    expect(await readFile(path.join(work, 'billing.txt'), 'utf8')).toBe('billing code\n');
  });

  it('a conflict aborts cleanly, reports the conflicted paths, and leaves the tree pristine', async () => {
    const { remote, work } = await setup();
    // Both the intent branch and the unit branch edit the same file.
    await commitOnRemote(remote, 'aidlc/i1', 'shared.txt', 'intent version\n');
    await commitOnRemote(remote, 'aidlc/i1--s1-unit-auth', 'shared.txt', 'lane version\n');
    const res = await mergeBranchNoFf({
      dir: work,
      repo: 'o/r',
      intentBranch: 'aidlc/i1',
      unitBranch: 'aidlc/i1--s1-unit-auth',
      message: 'aidlc(merge): auth — e1',
      urls: laneUrls(remote),
      ...quiet,
    });
    expect(res.merged).toBe(false);
    expect(res.reason).toBe('merge_conflict');
    expect(res.conflicts).toEqual(['shared.txt']);
    // Tree pristine: no in-progress merge, no dirty files.
    const status = await git(['status', '--porcelain'], work);
    expect(status.stdout.trim()).toBe('');
    const mergeHead = await git(['rev-parse', '--verify', 'MERGE_HEAD'], work);
    expect(mergeHead.exitCode).not.toBe(0);
    // The remote intent branch did NOT move.
    const file = await readFile(path.join(work, 'shared.txt'), 'utf8');
    expect(file).toBe('intent version\n');
  });

  it('resets a stale local intent branch onto the remote before merging', async () => {
    const { remote, work } = await setup();
    // The local intent branch diverges (stale workspace state).
    await writeFile(path.join(work, 'stale.txt'), 'stale local work\n');
    await git(['add', '-A'], work);
    await git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'stale'], work);
    await commitOnRemote(remote, 'aidlc/i1--s1-unit-auth', 'auth.txt', 'auth code\n');
    const res = await mergeBranchNoFf({
      dir: work,
      repo: 'o/r',
      intentBranch: 'aidlc/i1',
      unitBranch: 'aidlc/i1--s1-unit-auth',
      message: 'aidlc(merge): auth — e1',
      urls: laneUrls(remote),
      ...quiet,
    });
    expect(res.merged).toBe(true);
    // The stale local-only commit is NOT in the pushed merge (remote was the base).
    const log = await git(['log', '--format=%s', 'aidlc/i1'], work);
    expect(log.stdout).not.toContain('stale');
  });

  it('fails as a value when the unit branch does not exist remotely', async () => {
    const { remote, work } = await setup();
    const res = await mergeBranchNoFf({
      dir: work,
      repo: 'o/r',
      intentBranch: 'aidlc/i1',
      unitBranch: 'aidlc/i1--s1-unit-ghost',
      message: 'm',
      urls: laneUrls(remote),
      ...quiet,
    });
    expect(res).toMatchObject({ merged: false, reason: 'unit_branch_missing' });
  });
});

// ── WP6: conflict-resolution primitives (docs/v2-parallel.md) ────────────────

import {
  beginConflictMerge,
  findRemainingConflictMarkers,
  concludeConflictMerge,
} from '../git-engine.js';

describe('beginConflictMerge / concludeConflictMerge', () => {
  // Remote with: intent branch (shared.txt = intent version) and a unit
  // branch that forked BEFORE that commit and adds its own shared.txt.
  const conflictSetup = async () => {
    const { remote, work } = await initRemoteAndClone();
    await commitOnRemote(remote, 'aidlc/i1', 'base.txt', 'base\n');
    // Unit branch forks from the CURRENT intent HEAD…
    await commitOnRemote(remote, 'aidlc/i1--s1-unit-u', 'unit.txt', 'unit work\n');
    // …then BOTH sides add shared.txt with different content.
    await commitOnRemote(remote, 'aidlc/i1', 'shared.txt', 'intent version\n');
    await commitOnRemote(remote, 'aidlc/i1--s1-unit-u', 'shared.txt', 'unit version\n');
    return { remote, work };
  };
  const args = (remote, work) => ({
    dir: work,
    repo: 'o/r',
    unitBranch: 'aidlc/i1--s1-unit-u',
    intentBranch: 'aidlc/i1',
    message: 'aidlc(conflict-resolution): u — e1',
    urls: laneUrls(remote),
  });

  it('begins the reverse merge leaving REAL markers, then concludes after resolution and pushes', async () => {
    const { remote, work } = await conflictSetup();
    const begin = await beginConflictMerge(args(remote, work));
    expect(begin).toMatchObject({ conflicted: true, conflicts: ['shared.txt'] });
    // Genuine markers in the tree, merge in progress.
    const conflicted = await readFile(path.join(work, 'shared.txt'), 'utf8');
    expect(conflicted).toContain('<<<<<<<');
    expect((await git(['rev-parse', '--verify', 'MERGE_HEAD'], work)).exitCode).toBe(0);

    // "The agent" resolves the file (markers gone, both intents kept).
    await writeFile(path.join(work, 'shared.txt'), 'intent version + unit version\n');

    const conclude = await concludeConflictMerge({
      dir: work,
      repo: 'o/r',
      unitBranch: 'aidlc/i1--s1-unit-u',
      conflicts: begin.conflicts,
      urls: laneUrls(remote),
      ...quiet,
    });
    expect(conclude.concluded).toBe(true);
    expect(conclude.sha).toMatch(/^[0-9a-f]{40}$/);
    // A true merge commit with the ENGINE identity, pushed to the unit branch.
    const who = await git(['log', '-1', '--format=%an|%P'], work);
    expect(who.stdout.trim().startsWith('AI-DLC Engine|')).toBe(true);
    expect(who.stdout.trim().split('|')[1].split(' ')).toHaveLength(2);
    const ls = await git(['ls-remote', remote, 'aidlc/i1--s1-unit-u'], root);
    expect(ls.stdout.trim().split(/\s/)[0]).toBe(conclude.sha);
    // The unit branch now CONTAINS the intent branch → the merge-back retry
    // is conflict-free by construction.
    const ancestor = await git(
      ['merge-base', '--is-ancestor', 'refs/remotes/origin/aidlc/i1', 'HEAD'],
      work,
    );
    expect(ancestor.exitCode).toBe(0);
  });

  it('conclude REFUSES when markers remain and aborts back to a pristine tree', async () => {
    const { remote, work } = await conflictSetup();
    const begin = await beginConflictMerge(args(remote, work));
    expect(begin.conflicted).toBe(true);
    // The "agent" did nothing — markers still present.
    const conclude = await concludeConflictMerge({
      dir: work,
      repo: 'o/r',
      unitBranch: 'aidlc/i1--s1-unit-u',
      conflicts: begin.conflicts,
      urls: laneUrls(remote),
      ...quiet,
    });
    expect(conclude).toMatchObject({ concluded: false, reason: 'markers_remain' });
    expect(conclude.remaining).toEqual(['shared.txt']);
    // Aborted: no MERGE_HEAD, clean status, unit content restored.
    expect((await git(['rev-parse', '--verify', 'MERGE_HEAD'], work)).exitCode).not.toBe(0);
    expect((await git(['status', '--porcelain'], work)).stdout.trim()).toBe('');
    expect(await readFile(path.join(work, 'shared.txt'), 'utf8')).toBe('unit version\n');
  });

  it('a clean reverse merge needs no agent (merged: true) and up_to_date short-circuits', async () => {
    const { remote, work } = await initRemoteAndClone();
    await commitOnRemote(remote, 'aidlc/i1', 'base.txt', 'base\n');
    await commitOnRemote(remote, 'aidlc/i1--s1-unit-u', 'unit.txt', 'unit work\n');
    // Non-overlapping change on the intent branch → clean reverse merge.
    await commitOnRemote(remote, 'aidlc/i1', 'other.txt', 'other\n');
    const first = await beginConflictMerge(args(remote, work));
    expect(first.conflicted).toBe(false);
    expect(first.merged).toBe(true);
    // Second begin: the intent branch is already an ancestor (local HEAD has
    // the merge; the remote unit branch does not — begin resets to remote, so
    // push the merge first via conclude with no conflicts).
    const conclude = await concludeConflictMerge({
      dir: work,
      repo: 'o/r',
      unitBranch: 'aidlc/i1--s1-unit-u',
      conflicts: [],
      urls: laneUrls(remote),
      ...quiet,
    });
    expect(conclude.concluded).toBe(true);
    const second = await beginConflictMerge(args(remote, work));
    expect(second).toMatchObject({ conflicted: false, merged: 'up_to_date' });
  });
});

// ── "On behalf of" attribution (author = user, committer = engine) ──────────
// When the orchestrator supplies the starting user's identity, every engine
// commit/merge is AUTHORED by the user while the COMMITTER stays AI-DLC
// Engine — GitHub renders "<user> authored and AI-DLC Engine committed".

import { gitIdentity } from '../git-engine.js';

const AUTHOR = { name: 'Jane Dev', email: '123+janedev@users.noreply.github.com' };
const ENGINE = 'AI-DLC Engine|aidlc-engine@noreply.local';

describe('gitIdentity', () => {
  it('is engine-only without an author (null / missing fields / empty strings)', () => {
    const engineOnly = [
      '-c',
      'user.email=aidlc-engine@noreply.local',
      '-c',
      'user.name=AI-DLC Engine',
    ];
    expect(gitIdentity()).toEqual(engineOnly);
    expect(gitIdentity(null)).toEqual(engineOnly);
    expect(gitIdentity({ name: 'x' })).toEqual(engineOnly);
    expect(gitIdentity({ name: '', email: 'a@b' })).toEqual(engineOnly);
    expect(gitIdentity({ name: '  ', email: 'a@b' })).toEqual(engineOnly);
  });

  it('appends author.name/author.email for a valid author', () => {
    expect(gitIdentity(AUTHOR)).toEqual([
      '-c',
      'user.email=aidlc-engine@noreply.local',
      '-c',
      'user.name=AI-DLC Engine',
      '-c',
      `author.name=${AUTHOR.name}`,
      '-c',
      `author.email=${AUTHOR.email}`,
    ]);
  });

  it('sanitizes newlines and angle brackets out of the ident fields', () => {
    const dirty = gitIdentity({ name: 'Ev<il>Name', email: 'a@b<x>' });
    expect(dirty).toContain('author.name=Ev il Name');
    expect(dirty).toContain('author.email=a@b x');
    // A field that sanitizes to NOTHING falls back to engine-only.
    expect(gitIdentity({ name: '<>\n', email: 'a@b' })).toHaveLength(4);
  });
});

describe('on-behalf-of attribution', () => {
  it('commitAll: author = user, committer = engine', async () => {
    const { work } = await initRemoteAndClone();
    await writeFile(path.join(work, 'src.js'), 'export const x = 1;\n');
    const res = await commitAll({
      dir: work,
      message: 'aidlc(code-generation): e1',
      author: AUTHOR,
    });
    expect(res.committed).toBe(true);
    const log = await git(['log', '-1', '--format=%an|%ae|%cn|%ce'], work);
    expect(log.stdout.trim()).toBe(`${AUTHOR.name}|${AUTHOR.email}|${ENGINE}`);
    // The repo config was NOT mutated (identity passed per-command).
    const cfg = await git(['config', '--local', '--get', 'author.name'], work);
    expect(cfg.exitCode).not.toBe(0);
  });

  it('commitAll: a malformed author falls back to the full engine identity (never fails the commit)', async () => {
    const { work } = await initRemoteAndClone();
    await writeFile(path.join(work, 'src.js'), 'x\n');
    const res = await commitAll({
      dir: work,
      message: 'aidlc(x): e1',
      author: { name: '<>\n', email: '' },
    });
    expect(res.committed).toBe(true);
    const log = await git(['log', '-1', '--format=%an|%ae|%cn|%ce'], work);
    expect(log.stdout.trim()).toBe(`${ENGINE}|${ENGINE}`);
  });

  it('commitAndPushAll forwards the author to the repo commit', async () => {
    const { remote, work } = await initRemoteAndClone();
    await writeFile(path.join(work, 'src.js'), 'x\n');
    const res = await commitAndPushAll({
      repos: ['o/r'],
      workspaceDir: work,
      branch: 'main',
      author: AUTHOR,
      message: 'aidlc(code-generation): e1',
      urlsFor: () => ({ auth: remote, clean: 'https://github.com/o/r.git' }),
      ...quiet,
    });
    expect(res.ok).toBe(true);
    expect(res.committed).toBe(true);
    const log = await git(['log', '-1', '--format=%an|%ae|%cn|%ce'], work);
    expect(log.stdout.trim()).toBe(`${AUTHOR.name}|${AUTHOR.email}|${ENGINE}`);
  });

  it('mergeBranchNoFf: the merge commit is authored by the user, committed by the engine', async () => {
    const { remote, work } = await initRemoteAndClone();
    await commitOnRemote(remote, 'aidlc/i1', 'base.txt', 'base\n');
    await fetchOrigin({ dir: work, repo: 'o/r', urls: laneUrls(remote) });
    await git(['checkout', '-B', 'aidlc/i1', 'refs/remotes/origin/aidlc/i1'], work);
    await commitOnRemote(remote, 'aidlc/i1--s1-unit-auth', 'auth.txt', 'auth code\n');
    const res = await mergeBranchNoFf({
      dir: work,
      repo: 'o/r',
      intentBranch: 'aidlc/i1',
      unitBranch: 'aidlc/i1--s1-unit-auth',
      message: 'aidlc(merge): auth — e1',
      author: AUTHOR,
      urls: laneUrls(remote),
      ...quiet,
    });
    expect(res.merged).toBe(true);
    const log = await git(['log', '-1', '--format=%an|%ae|%cn|%ce'], work);
    expect(log.stdout.trim()).toBe(`${AUTHOR.name}|${AUTHOR.email}|${ENGINE}`);
  });

  it('conflict resolution: begin + conclude both attribute to the user', async () => {
    const { remote, work } = await initRemoteAndClone();
    await commitOnRemote(remote, 'aidlc/i1', 'base.txt', 'base\n');
    await commitOnRemote(remote, 'aidlc/i1--s1-unit-u', 'unit.txt', 'unit work\n');
    await commitOnRemote(remote, 'aidlc/i1', 'shared.txt', 'intent version\n');
    await commitOnRemote(remote, 'aidlc/i1--s1-unit-u', 'shared.txt', 'unit version\n');
    const begin = await beginConflictMerge({
      dir: work,
      repo: 'o/r',
      unitBranch: 'aidlc/i1--s1-unit-u',
      intentBranch: 'aidlc/i1',
      message: 'aidlc(conflict-resolution): u — e1',
      author: AUTHOR,
      urls: laneUrls(remote),
    });
    expect(begin.conflicted).toBe(true);
    await writeFile(path.join(work, 'shared.txt'), 'both versions\n');
    const conclude = await concludeConflictMerge({
      dir: work,
      repo: 'o/r',
      unitBranch: 'aidlc/i1--s1-unit-u',
      conflicts: begin.conflicts,
      author: AUTHOR,
      urls: laneUrls(remote),
      ...quiet,
    });
    expect(conclude.concluded).toBe(true);
    const log = await git(['log', '-1', '--format=%an|%ae|%cn|%ce'], work);
    expect(log.stdout.trim()).toBe(`${AUTHOR.name}|${AUTHOR.email}|${ENGINE}`);
  });
});

describe('findRemainingConflictMarkers', () => {
  it('detects real marker lines, tolerates deleted files, ignores marker-free text', async () => {
    const { work } = await initRemoteAndClone();
    await writeFile(
      path.join(work, 'bad.txt'),
      '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch\n',
    );
    await writeFile(path.join(work, 'ok.txt'), 'clean content\nno markers here\n');
    const remaining = await findRemainingConflictMarkers({
      dir: work,
      files: ['bad.txt', 'ok.txt', 'deleted.txt'],
    });
    expect(remaining).toEqual(['bad.txt']);
  });
});

// ── Runtime files must never enter the user's repo ───────────────────────────
// The workspace mount doubles as the repo checkout (single-repo projects), and
// it holds engine + CLI runtime state: .aidlc/ (MCP config with infra
// endpoints), .kiro/, .claude/, .kiro-data/ and .opencode-data/
// (conversation stores). The
// stage-exit `git add -A` must leave that runtime state out of user commits,
// including stages that produce no repo work at all.

import { ensureRuntimeExcludes, RUNTIME_EXCLUDES } from '../git-engine.js';
import { mkdir } from 'node:fs/promises';

const seedRuntimeFiles = async (work) => {
  await mkdir(path.join(work, '.aidlc'), { recursive: true });
  await writeFile(
    path.join(work, '.aidlc', 'mcp-config.json'),
    '{"env":{"NEPTUNE_ENDPOINT":"internal"}}',
  );
  await writeFile(path.join(work, '.aidlc', 'rules.md'), 'rules');
  await mkdir(path.join(work, '.claude'), { recursive: true });
  await writeFile(path.join(work, '.claude', 'session.jsonl'), '{"conversation":"private"}');
  await mkdir(path.join(work, '.kiro-data'), { recursive: true });
  await writeFile(path.join(work, '.kiro-data', 'data.sqlite3'), 'db');
  await mkdir(path.join(work, '.opencode-data', 'opencode'), { recursive: true });
  await writeFile(path.join(work, '.opencode-data', 'opencode', 'opencode.db-wal'), 'wal');
  await mkdir(path.join(work, '.kiro', 'agents'), { recursive: true });
  await writeFile(path.join(work, '.kiro', 'agents', 'aidlc.json'), '{}');
};

describe('runtime excludes', () => {
  it('a tree with ONLY runtime files is CLEAN — no commit, no push, no network', async () => {
    const { work } = await initRemoteAndClone();
    await seedRuntimeFiles(work);
    const res = await commitAll({ dir: work, message: 'aidlc(workspace-scaffold): e1' });
    expect(res).toEqual({ committed: false, reason: 'clean' });
    // The stage-exit hook then skips the network entirely (up_to_date).
    const hook = await commitAndPushAll({
      repos: ['o/r'],
      workspaceDir: work,
      branch: 'main',
      message: 'aidlc(workspace-scaffold): e1',
      urlsFor: () => ({ auth: 'unused', clean: 'https://github.com/o/r.git' }),
    });
    expect(hook.ok).toBe(true);
    expect(hook.committed).toBe(false);
    expect(hook.results[0].pushed).toBe('up_to_date');
  });

  it('real work commits WITHOUT the runtime files riding along', async () => {
    const { work } = await initRemoteAndClone();
    await seedRuntimeFiles(work);
    await writeFile(path.join(work, 'src.js'), 'export const x = 1;\n');
    const res = await commitAll({ dir: work, message: 'aidlc(code-generation): e1' });
    expect(res.committed).toBe(true);
    const tree = await git(['ls-tree', '-r', '--name-only', 'HEAD'], work);
    expect(tree.stdout).toContain('src.js');
    for (const bad of ['.aidlc', '.claude', '.kiro-data', '.opencode-data', '.kiro/']) {
      expect(tree.stdout).not.toContain(bad);
    }
  });

  it('writes the managed block into .git/info/exclude exactly once (idempotent, repo-local)', async () => {
    const { work } = await initRemoteAndClone();
    await ensureRuntimeExcludes({ dir: work });
    await ensureRuntimeExcludes({ dir: work });
    const exclude = await readFile(path.join(work, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude.match(/aidlc-engine runtime excludes/g)).toHaveLength(1);
    for (const p of RUNTIME_EXCLUDES) expect(exclude).toContain(p);
    // Repo-local: nothing exclude-related is committable.
    await commitAll({ dir: work, message: 'x' });
    const status = await git(['status', '--porcelain'], work);
    expect(status.stdout.trim()).toBe('');
  });

  it('preserves user-supplied exclude content and does NOT untrack already-tracked paths', async () => {
    const { work } = await initRemoteAndClone();
    // User's own exclude content must survive.
    await writeFile(path.join(work, '.git', 'info', 'exclude'), '# mine\nmy-scratch/\n');
    // The repo ALREADY tracks a .claude file (the user's explicit choice).
    await mkdir(path.join(work, '.claude'), { recursive: true });
    await writeFile(path.join(work, '.claude', 'settings.json'), '{"user":"tracked"}');
    await git(['add', '-f', '.claude/settings.json'], work);
    await git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'track it'], work);

    await writeFile(path.join(work, '.claude', 'settings.json'), '{"user":"updated"}');
    const res = await commitAll({ dir: work, message: 'aidlc(x): e1' });
    // The tracked file's change still commits (excludes only hide UNTRACKED files).
    expect(res.committed).toBe(true);
    const show = await git(['show', 'HEAD:.claude/settings.json'], work);
    expect(show.stdout).toContain('updated');
    const exclude = await readFile(path.join(work, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude).toContain('my-scratch/');
    expect(exclude).toContain('aidlc-engine runtime excludes');
  });

  it('node_modules (dir OR the engine off-mount symlink) never rides into a commit', async () => {
    const { work } = await initRemoteAndClone();
    // A real dir (pre-fix session)…
    await mkdir(path.join(work, 'node_modules', 'left-pad'), { recursive: true });
    await writeFile(path.join(work, 'node_modules', 'left-pad', 'index.js'), 'x');
    // …and the engine symlink layout in a nested package (repo does NOT
    // gitignore node_modules — only the runtime excludes protect it).
    await mkdir(path.join(work, 'frontend'), { recursive: true });
    const offMount = path.join(root, 'off-mount-nm');
    await mkdir(offMount, { recursive: true });
    const { symlink } = await import('node:fs/promises');
    await symlink(offMount, path.join(work, 'frontend', 'node_modules'), 'dir');

    await writeFile(path.join(work, 'src.js'), 'export const x = 1;\n');
    const res = await commitAll({ dir: work, message: 'aidlc(code-generation): e1' });
    expect(res.committed).toBe(true);
    const tree = await git(['ls-tree', '-r', '--name-only', 'HEAD'], work);
    expect(tree.stdout).toContain('src.js');
    expect(tree.stdout).not.toContain('node_modules');
  });

  it('the versioned marker upgrades a warm session holding an older block', async () => {
    const { work } = await initRemoteAndClone();
    // A warm mount whose exclude was written by the PRE-node_modules engine.
    await writeFile(
      path.join(work, '.git', 'info', 'exclude'),
      '# aidlc-engine runtime excludes (managed; do not edit this block)\n.aidlc/\n.kiro/\n.claude/\n.kiro-data/\n',
    );
    await ensureRuntimeExcludes({ dir: work });
    const exclude = await readFile(path.join(work, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude).toContain('runtime excludes v3');
    expect(exclude).toContain('.opencode-data/');
    expect(exclude).toContain('node_modules');
    // Idempotent from here on.
    await ensureRuntimeExcludes({ dir: work });
    const again = await readFile(path.join(work, '.git', 'info', 'exclude'), 'utf8');
    expect(again.match(/runtime excludes v3/g)).toHaveLength(1);
  });
});
