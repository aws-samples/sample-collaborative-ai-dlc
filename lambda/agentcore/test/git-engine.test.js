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
  commitAndPushAll,
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
  await git(['init', '--bare', remote], root);
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
    await git(['init', '--bare', remoteA], root);
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
