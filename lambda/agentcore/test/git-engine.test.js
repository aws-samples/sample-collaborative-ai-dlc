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
