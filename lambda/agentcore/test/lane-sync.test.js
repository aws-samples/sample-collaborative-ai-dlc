import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runGit, fetchOrigin } from '../git-engine.js';
import { laneSyncEvent, laneSyncPolicy, syncLaneWithIntent } from '../lane-sync.js';

// Real git spawns can be slow on busy CI machines.
vi.setConfig({ testTimeout: 30_000 });

// Exercised against real git: a bare "remote", a lane checkout on the unit
// branch, and peer clones that move the intent branch the way a merged unit or
// a directly merged change would.
const INTENT = 'aidlc/i1';
const UNIT = 'aidlc/i1--s1-unit-auth';
let root;
const git = (args, cwd) => runGit(args, { cwd });
const commitAs = ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m'];

// A new branch forks from `from` (default: the remote's main).
const commitOnRemote = async (remote, branch, file, content, from = 'main') => {
  const dir = await mkdtemp(path.join(root, 'peer-'));
  await git(['clone', remote, dir], root);
  const co = await git(['checkout', branch], dir);
  if (co.exitCode !== 0) await git(['checkout', '-b', branch, `origin/${from}`], dir);
  await writeFile(path.join(dir, file), content);
  await git(['add', '-A'], dir);
  await git([...commitAs, `add ${file}`], dir);
  await git(['push', 'origin', `HEAD:refs/heads/${branch}`], dir);
};

const urls = (remote) => ({ auth: remote, clean: 'https://github.com/o/r.git' });

// remote: main -> intent (base.txt) -> unit (auth.txt); the lane workspace is
// checked out on the unit branch, in step with its remote.
const setup = async () => {
  const remote = path.join(root, 'remote.git');
  const work = path.join(root, 'work');
  await git(['init', '--bare', '-b', 'main', remote], root);
  const seed = path.join(root, 'seed');
  await git(['init', '-b', 'main', seed], root);
  await writeFile(path.join(seed, 'README.md'), 'seed\n');
  await git(['add', '-A'], seed);
  await git([...commitAs, 'seed'], seed);
  await git(['push', remote, 'main'], seed);
  await commitOnRemote(remote, INTENT, 'base.txt', 'base\n');
  await commitOnRemote(remote, UNIT, 'auth.txt', 'auth\n', INTENT);
  await git(['clone', remote, work], root);
  await fetchOrigin({ dir: work, repo: 'o/r', urls: urls(remote) });
  await git(['checkout', '-B', UNIT, `refs/remotes/origin/${UNIT}`], work);
  return { remote, work };
};

const sync = (remote, work, overrides = {}) =>
  syncLaneWithIntent(
    {
      projectId: 'p1',
      executionId: 'e1',
      unitSlug: 'auth',
      repos: ['o/r'],
      unitBranch: UNIT,
      intentBranch: INTENT,
      gitProvider: 'github',
      workspaceDir: work,
      ...overrides,
    },
    { env: {}, urlsFor: () => urls(remote) },
  );

const remoteHead = async (remote, branch) =>
  (await git(['ls-remote', remote, branch], root)).stdout.trim().split(/\s/)[0];

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'lane-sync-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('laneSyncPolicy', () => {
  it('is none unless set to before-stage', () => {
    expect(laneSyncPolicy({})).toBe('none');
    expect(laneSyncPolicy({ LANE_SYNC_POLICY: 'none' })).toBe('none');
    expect(laneSyncPolicy({ LANE_SYNC_POLICY: 'always' })).toBe('none');
    expect(laneSyncPolicy({ LANE_SYNC_POLICY: 'before-stage' })).toBe('before-stage');
  });
});

describe('syncLaneWithIntent', () => {
  it('merges a moved intent branch into the lane and pushes the unit branch', async () => {
    const { remote, work } = await setup();
    // A change merged into the intent branch after the lane was cut.
    await commitOnRemote(remote, INTENT, 'filestore.txt', 'ranged read\n');

    const res = await sync(remote, work);

    expect(res.synced).toBe(true);
    expect(res.results).toEqual([
      { repo: 'o/r', outcome: 'merged', sha: expect.stringMatching(/^[0-9a-f]{40}$/) },
    ]);
    expect(await readFile(path.join(work, 'filestore.txt'), 'utf8')).toBe('ranged read\n');
    expect(await readFile(path.join(work, 'auth.txt'), 'utf8')).toBe('auth\n');
    expect(await remoteHead(remote, UNIT)).toBe(res.results[0].sha);
    const parents = await git(['log', '-1', '--format=%P'], work);
    expect(parents.stdout.trim().split(' ')).toHaveLength(2);
    const subject = await git(['log', '-1', '--format=%s'], work);
    expect(subject.stdout.trim()).toBe('chore(aidlc): reconcile auth lane with the intent branch');
    expect((await git(['branch', '--show-current'], work)).stdout.trim()).toBe(UNIT);
  });

  it('takes broker credentials for the fetch and push when no test URLs are given', async () => {
    const { remote, work } = await setup();
    await commitOnRemote(remote, INTENT, 'filestore.txt', 'ranged read\n');
    // The production path: no urlsFor, so git-engine asks the credential broker
    // for each network operation. The stub stands in for the broker; origin is
    // already the local remote, so the operation itself needs no extra env.
    await git(['remote', 'set-url', 'origin', remote], work);
    const requests = [];
    const withGitCredential = async (request, operation) => {
      requests.push(request);
      return operation({ env: {} });
    };

    const res = await syncLaneWithIntent(
      {
        projectId: 'p1',
        executionId: 'e1',
        unitSlug: 'auth',
        repos: ['o/r'],
        unitBranch: UNIT,
        intentBranch: INTENT,
        gitProvider: 'gitlab',
        workspaceDir: work,
      },
      { env: {}, withGitCredential },
    );

    expect(res.results).toEqual([
      { repo: 'o/r', outcome: 'merged', sha: expect.stringMatching(/^[0-9a-f]{40}$/) },
    ]);
    expect(await remoteHead(remote, UNIT)).toBe(res.results[0].sha);
    expect(requests.map((r) => r.requiredAccess)).toEqual(
      expect.arrayContaining(['read', 'write']),
    );
    for (const request of requests) {
      expect(request).toMatchObject({
        executionId: 'e1',
        projectId: 'p1',
        provider: 'gitlab',
        repository: 'o/r',
      });
    }
  });

  it('is up to date when the lane already contains the intent head', async () => {
    const { remote, work } = await setup();
    const before = await remoteHead(remote, UNIT);

    const res = await sync(remote, work);

    expect(res).toEqual({ synced: false, results: [{ repo: 'o/r', outcome: 'up_to_date' }] });
    expect(await remoteHead(remote, UNIT)).toBe(before);
  });

  it('aborts a conflicting merge and leaves the lane as it was', async () => {
    const { remote, work } = await setup();
    await commitOnRemote(remote, INTENT, 'auth.txt', 'changed on the intent branch\n');
    const before = await remoteHead(remote, UNIT);

    const res = await sync(remote, work);

    expect(res.synced).toBe(false);
    expect(res.results).toEqual([
      expect.objectContaining({
        repo: 'o/r',
        outcome: 'conflict',
        reason: 'merge_conflict',
        conflicts: ['auth.txt'],
      }),
    ]);
    expect(await remoteHead(remote, UNIT)).toBe(before);
    expect((await git(['rev-parse', 'HEAD'], work)).stdout.trim()).toBe(before);
    expect((await git(['status', '--porcelain'], work)).stdout.trim()).toBe('');
    expect(await readFile(path.join(work, 'auth.txt'), 'utf8')).toBe('auth\n');
  });

  it('skips a checkout with uncommitted changes', async () => {
    const { remote, work } = await setup();
    await commitOnRemote(remote, INTENT, 'filestore.txt', 'ranged read\n');
    await writeFile(path.join(work, 'auth.txt'), 'work in progress\n');

    const res = await sync(remote, work);

    expect(res.results).toEqual([
      { repo: 'o/r', outcome: 'skipped', reason: 'uncommitted_changes' },
    ]);
    expect(await readFile(path.join(work, 'auth.txt'), 'utf8')).toBe('work in progress\n');
  });

  it('skips a checkout with unpushed commits rather than resetting them away', async () => {
    const { remote, work } = await setup();
    await commitOnRemote(remote, INTENT, 'filestore.txt', 'ranged read\n');
    await writeFile(path.join(work, 'local.txt'), 'not pushed\n');
    await git(['add', '-A'], work);
    await git([...commitAs, 'local'], work);
    const local = (await git(['rev-parse', 'HEAD'], work)).stdout.trim();

    const res = await sync(remote, work);

    expect(res.results).toEqual([{ repo: 'o/r', outcome: 'skipped', reason: 'unpushed_commits' }]);
    expect((await git(['rev-parse', 'HEAD'], work)).stdout.trim()).toBe(local);
  });

  it('puts the lane back when its push is rejected, keeping commits others pushed', async () => {
    const { remote, work } = await setup();
    await commitOnRemote(remote, INTENT, 'filestore.txt', 'ranged read\n');
    // Someone pushes to the unit branch, then the remote rejects the sync's push
    // (as it would after a race between our fetch and our push).
    await commitOnRemote(remote, UNIT, 'human.txt', 'pushed by a person\n');
    const humanHead = await remoteHead(remote, UNIT);
    const before = (await git(['rev-parse', 'HEAD'], work)).stdout.trim();
    const hook = path.join(remote, 'hooks', 'pre-receive');
    await writeFile(hook, '#!/bin/sh\necho "rejected for the test" >&2\nexit 1\n', {
      mode: 0o755,
    });

    const res = await sync(remote, work);

    expect(res.results).toEqual([
      expect.objectContaining({ repo: 'o/r', outcome: 'failed', reason: 'push_failed' }),
    ]);
    expect(await remoteHead(remote, UNIT)).toBe(humanHead);
    expect((await git(['rev-parse', 'HEAD'], work)).stdout.trim()).toBe(before);
    expect((await git(['status', '--porcelain'], work)).stdout.trim()).toBe('');
    // The next sync, once the remote accepts pushes, takes the person's commit too.
    await rm(hook);
    const retry = await sync(remote, work);
    expect(retry.results[0].outcome).toBe('merged');
    expect(await readFile(path.join(work, 'human.txt'), 'utf8')).toBe('pushed by a person\n');
    expect(await readFile(path.join(work, 'filestore.txt'), 'utf8')).toBe('ranged read\n');
    const ancestor = await git(['merge-base', '--is-ancestor', humanHead, 'HEAD'], work);
    expect(ancestor.exitCode).toBe(0);
  });

  it('reports a missing intent branch as a failure, not a throw', async () => {
    const { remote, work } = await setup();

    const res = await sync(remote, work, { intentBranch: 'aidlc/missing' });

    expect(res.results).toEqual([
      expect.objectContaining({
        repo: 'o/r',
        outcome: 'failed',
        reason: 'intent_branch_missing',
      }),
    ]);
  });

  it('does nothing outside a lane', async () => {
    const { remote, work } = await setup();
    expect(await sync(remote, work, { unitBranch: INTENT })).toEqual({
      synced: false,
      results: [],
    });
    expect(await sync(remote, work, { repos: [] })).toEqual({ synced: false, results: [] });
  });
});

describe('laneSyncEvent', () => {
  const base = { unitSlug: 'auth', intentBranch: INTENT };

  it('records nothing when every repo was up to date', () => {
    expect(laneSyncEvent({ ...base, results: [{ repo: 'o/r', outcome: 'up_to_date' }] })).toBe(
      null,
    );
    expect(laneSyncEvent({ ...base, results: [] })).toBe(null);
  });

  it('names the merged repos', () => {
    expect(
      laneSyncEvent({ ...base, results: [{ repo: 'o/r', outcome: 'merged', sha: 'abc' }] }),
    ).toEqual({ type: 'v2.lane.synced', summary: `Lane auth synced with ${INTENT}: o/r (abc)` });
  });

  it('reports conflicts first, with the conflicted files', () => {
    const event = laneSyncEvent({
      ...base,
      results: [
        { repo: 'o/a', outcome: 'merged', sha: 'abc' },
        { repo: 'o/b', outcome: 'conflict', reason: 'merge_conflict', conflicts: ['x.js'] },
      ],
    });
    expect(event.type).toBe('v2.lane.sync_conflict');
    expect(event.summary).toContain('o/b:x.js');
    expect(event.summary).toContain('resolved at merge-back');
  });

  it('reports skips and failures with their reasons', () => {
    const event = laneSyncEvent({
      ...base,
      results: [
        { repo: 'o/a', outcome: 'skipped', reason: 'unpushed_commits' },
        { repo: 'o/b', outcome: 'merged', sha: 'abc' },
      ],
    });
    expect(event).toEqual({
      type: 'v2.lane.sync_failed',
      summary: `Lane auth not synced with ${INTENT}: o/a (unpushed_commits); synced o/b (abc)`,
    });
  });
});
