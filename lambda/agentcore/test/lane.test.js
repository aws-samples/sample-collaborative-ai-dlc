import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initLane, mergeLane, reconcileLane, refreshIntentWorkspace } from '../commands/lane.js';
import { runGit, fetchOrigin } from '../git-engine.js';

// WP5 lane commands against REAL git (local bare remotes via the urls seam) —
// proving the lane lifecycle end to end: clone → unit branch off intent HEAD →
// push, then the serialized --no-ff merge-back with conflict reporting.

vi.setConfig({ testTimeout: 30_000 });

let root;

const git = (args, cwd) => runGit(args, { cwd });

// Bare remote seeded with main + an intent branch carrying work.
const initRemote = async () => {
  const remote = path.join(root, 'remote.git');
  await git(['init', '--bare', '-b', 'main', remote], root);
  const seed = path.join(root, 'seed');
  await git(['init', '-b', 'main', seed], root);
  await writeFile(path.join(seed, 'README.md'), 'seed\n');
  await git(['add', '-A'], seed);
  await git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'seed'], seed);
  await git(['push', remote, 'main'], seed);
  await commitOnRemote(remote, 'aidlc/i1', 'intent.txt', 'intent work\n');
  return remote;
};

const commitOnRemote = async (remote, branch, file, content) => {
  const dir = await mkdtemp(path.join(root, 'peer-'));
  await git(['clone', remote, dir], root);
  const co = await git(['checkout', branch], dir);
  if (co.exitCode !== 0) await git(['checkout', '-b', branch], dir);
  await writeFile(path.join(dir, file), content);
  await git(['add', '-A'], dir);
  await git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', `add ${file}`], dir);
  await git(['push', 'origin', `HEAD:refs/heads/${branch}`], dir);
};

const spyStore = () => {
  const events = [];
  return {
    events,
    appendEvent: async (e) => {
      events.push(e);
      return e;
    },
  };
};

// A checkoutRepo stub backed by a real clone from the file:// remote — mirrors
// workspace.js behavior without provider URLs.
const realCheckoutRepo =
  (remote) =>
  async ({ branch, targetDir }) => {
    await mkdir(targetDir, { recursive: true });
    const clone = await git(['clone', remote, targetDir], root);
    if (clone.exitCode !== 0) return { cloned: false };
    await git(['remote', 'set-url', 'origin', 'https://github.com/o/r.git'], targetDir);
    // fetch through the seam then checkout the requested branch.
    await fetchOrigin({
      dir: targetDir,
      repo: 'o/r',
      urls: { auth: remote, clean: 'https://github.com/o/r.git' },
    });
    await git(['checkout', '-B', branch, `refs/remotes/origin/${branch}`], targetDir);
    return { repo: 'o/r', targetDir, cloned: true };
  };

const basePayload = (ws, over = {}) => ({
  projectId: 'p1',
  intentId: 'i1',
  executionId: 'e1',
  unitSlug: 'auth',
  sectionIndex: 1,
  repos: ['o/r'],
  unitBranch: 'aidlc/i1--s1-unit-auth',
  intentBranch: 'aidlc/i1',
  workspaceDir: ws,
  ...over,
});

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'lane-cmd-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('init-lane', () => {
  it('clones the intent branch and creates + pushes the unit branch (fresh lane mount)', async () => {
    const remote = await initRemote();
    const ws = path.join(root, 'lane-ws');
    const store = spyStore();
    const res = await initLane(basePayload(ws), {
      store,
      checkoutRepo: realCheckoutRepo(remote),
      urlsFor: () => ({ auth: remote, clean: 'https://github.com/o/r.git' }),
    });
    expect(res.ok).toBe(true);
    expect(res.repos).toEqual([expect.objectContaining({ repo: 'o/r', created: true })]);
    // Workspace sits on the unit branch with the intent branch's work.
    const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], ws);
    expect(branch.stdout.trim()).toBe('aidlc/i1--s1-unit-auth');
    expect(await readFile(path.join(ws, 'intent.txt'), 'utf8')).toBe('intent work\n');
    // The unit branch is registered on the remote (self-heal can re-clone it).
    const ls = await git(['ls-remote', remote, 'aidlc/i1--s1-unit-auth'], root);
    expect(ls.stdout.trim()).not.toBe('');
    // Traceable: the lane-ready event carries the unit.
    expect(store.events).toEqual([
      expect.objectContaining({ type: 'v2.unit.lane_ready', unitSlug: 'auth' }),
    ]);
  });

  it('is idempotent: a re-init after the branch exists checks out the pushed lane work', async () => {
    const remote = await initRemote();
    await commitOnRemote(remote, 'aidlc/i1--s1-unit-auth', 'auth.txt', 'lane work\n');
    const ws = path.join(root, 'lane-ws');
    const res = await initLane(basePayload(ws), {
      store: spyStore(),
      checkoutRepo: realCheckoutRepo(remote),
      urlsFor: () => ({ auth: remote, clean: 'https://github.com/o/r.git' }),
    });
    expect(res.ok).toBe(true);
    expect(res.repos[0].created).toBe(false);
    expect(await readFile(path.join(ws, 'auth.txt'), 'utf8')).toBe('lane work\n');
  });

  it('a repo-less project is a successful no-op', async () => {
    const res = await initLane(basePayload('/nope', { repos: [] }), { store: spyStore() });
    expect(res).toMatchObject({ ok: true, unitSlug: 'auth', repos: [] });
  });

  it('validates its inputs and surfaces clone failures as values', async () => {
    expect(await initLane(basePayload('/ws', { unitSlug: null }), {})).toMatchObject({
      ok: false,
      reason: 'missing_unit_slug',
    });
    expect(await initLane(basePayload('/ws', { unitBranch: null }), {})).toMatchObject({
      ok: false,
      reason: 'missing_branch',
    });
    const res = await initLane(basePayload(path.join(root, 'ws2')), {
      store: spyStore(),
      checkoutRepo: async () => ({ cloned: false }),
    });
    expect(res).toMatchObject({ ok: false, reason: 'lane_clone_failed' });
  });
});

describe('merge-lane', () => {
  // The intent session workspace: a clone sitting on the intent branch.
  const intentWorkspace = async (remote) => {
    const ws = path.join(root, 'intent-ws');
    await realCheckoutRepo(remote)({ branch: 'aidlc/i1', targetDir: ws });
    return ws;
  };
  const deps = (remote, store = spyStore()) => ({
    store,
    ensureWorkspaceSource: async () => ({ restored: false, repos: [], failed: [] }),
    urlsFor: () => ({ auth: remote, clean: 'https://github.com/o/r.git' }),
  });

  it('merges the lane branch --no-ff into the intent branch and records the event', async () => {
    const remote = await initRemote();
    await commitOnRemote(remote, 'aidlc/i1--s1-unit-auth', 'auth.txt', 'auth code\n');
    const ws = await intentWorkspace(remote);
    const store = spyStore();
    const res = await mergeLane(basePayload(ws), deps(remote, store));
    expect(res.ok).toBe(true);
    expect(res.results[0].merged).toBe(true);
    // Deterministic merge message carries unit + execution.
    const msg = await git(['log', '-1', '--format=%s', 'aidlc/i1'], ws);
    expect(msg.stdout.trim()).toBe('aidlc(merge): auth — e1');
    expect(store.events).toEqual([
      expect.objectContaining({ type: 'v2.git.merged', unitSlug: 'auth' }),
    ]);
  });

  it('a payload gitAuthor makes the merge commit authored by the user, committed by the engine', async () => {
    const remote = await initRemote();
    await commitOnRemote(remote, 'aidlc/i1--s1-unit-auth', 'auth.txt', 'auth code\n');
    const ws = await intentWorkspace(remote);
    const gitAuthor = { name: 'Jane Dev', email: '1+jane@users.noreply.github.com' };
    const res = await mergeLane(basePayload(ws, { gitAuthor }), deps(remote));
    expect(res.ok).toBe(true);
    const who = await git(['log', '-1', '--format=%an|%ae|%cn|%ce', 'aidlc/i1'], ws);
    expect(who.stdout.trim()).toBe(
      'Jane Dev|1+jane@users.noreply.github.com|AI-DLC Engine|aidlc-engine@noreply.local',
    );
  });

  it('a conflict fails with the conflicted paths (repo-qualified) and the merge_failed event', async () => {
    const remote = await initRemote();
    await commitOnRemote(remote, 'aidlc/i1', 'shared.txt', 'intent version\n');
    await commitOnRemote(remote, 'aidlc/i1--s1-unit-auth', 'shared.txt', 'lane version\n');
    const ws = await intentWorkspace(remote);
    const store = spyStore();
    const res = await mergeLane(basePayload(ws), deps(remote, store));
    expect(res).toMatchObject({ ok: false, reason: 'merge_conflict' });
    expect(res.conflicts).toEqual(['o/r:shared.txt']);
    expect(store.events).toEqual([
      expect.objectContaining({ type: 'v2.git.merge_failed', unitSlug: 'auth' }),
    ]);
  });

  it('is idempotent under a re-dispatched merge step (up_to_date)', async () => {
    const remote = await initRemote();
    await commitOnRemote(remote, 'aidlc/i1--s1-unit-auth', 'auth.txt', 'auth code\n');
    const ws = await intentWorkspace(remote);
    const first = await mergeLane(basePayload(ws), deps(remote));
    expect(first.ok).toBe(true);
    const second = await mergeLane(basePayload(ws), deps(remote));
    expect(second.ok).toBe(true);
    expect(second.results[0].merged).toBe('up_to_date');
  });

  it('self-heals a wiped intent workspace before merging and fails as a value if it cannot', async () => {
    const remote = await initRemote();
    await commitOnRemote(remote, 'aidlc/i1--s1-unit-auth', 'auth.txt', 'auth code\n');
    // Wiped mount: the workspace dir does not exist; ensureWorkspaceSource re-clones.
    const ws = path.join(root, 'wiped-ws');
    const res = await mergeLane(basePayload(ws), {
      store: spyStore(),
      ensureWorkspaceSource: async ({ branch }) => {
        await realCheckoutRepo(remote)({ branch, targetDir: ws });
        return { restored: true, repos: ['o/r'], failed: [] };
      },
      urlsFor: () => ({ auth: remote, clean: 'https://github.com/o/r.git' }),
    });
    expect(res.ok).toBe(true);

    const failed = await mergeLane(basePayload(path.join(root, 'nope')), {
      store: spyStore(),
      ensureWorkspaceSource: async () => ({ restored: false, repos: [], failed: ['o/r'] }),
    });
    expect(failed).toMatchObject({ ok: false, reason: 'workspace_restore_failed' });
  });

  it('a repo-less lane merge is a successful no-op', async () => {
    const res = await mergeLane(basePayload('/nope', { repos: [] }), { store: spyStore() });
    expect(res).toMatchObject({ ok: true, merged: 'empty' });
  });
});

describe('PR-per-unit reconciliation', () => {
  it('self-heals a wiped lane, merges the latest intent head, and pushes the unit branch', async () => {
    const remote = await initRemote();
    await commitOnRemote(remote, 'aidlc/i1--s1-unit-auth', 'auth.txt', 'auth code\n');
    await commitOnRemote(remote, 'aidlc/i1', 'sibling.txt', 'sibling code\n');
    const ws = path.join(root, 'wiped-lane');
    const res = await reconcileLane(basePayload(ws), {
      store: spyStore(),
      ensureWorkspaceSource: async ({ branch }) => {
        await realCheckoutRepo(remote)({ branch, targetDir: ws });
        return { restored: true, repos: ['o/r'], failed: [] };
      },
      urlsFor: () => ({ auth: remote, clean: 'https://github.com/o/r.git' }),
    });
    expect(res.ok).toBe(true);
    expect(await readFile(path.join(ws, 'sibling.txt'), 'utf8')).toBe('sibling code\n');

    const verify = await mkdtemp(path.join(root, 'verify-unit-'));
    await git(['clone', '--branch', 'aidlc/i1--s1-unit-auth', remote, verify], root);
    expect(await readFile(path.join(verify, 'sibling.txt'), 'utf8')).toBe('sibling code\n');
  });

  it('reports restore failure before touching a missing lane checkout', async () => {
    const res = await reconcileLane(basePayload(path.join(root, 'missing')), {
      store: spyStore(),
      ensureWorkspaceSource: async () => ({ restored: false, repos: [], failed: ['o/r'] }),
    });
    expect(res).toMatchObject({ ok: false, reason: 'workspace_restore_failed' });
  });

  it('refreshes the intent workspace to the latest provider-merged remote head', async () => {
    const remote = await initRemote();
    const ws = path.join(root, 'intent-refresh');
    await realCheckoutRepo(remote)({ branch: 'aidlc/i1', targetDir: ws });
    await commitOnRemote(remote, 'aidlc/i1', 'provider-merge.txt', 'merged remotely\n');

    const res = await refreshIntentWorkspace(basePayload(ws), {
      ensureWorkspaceSource: async () => ({ restored: false, repos: ['o/r'], failed: [] }),
      urlsFor: () => ({ auth: remote, clean: 'https://github.com/o/r.git' }),
    });
    expect(res.ok).toBe(true);
    expect(await readFile(path.join(ws, 'provider-merge.txt'), 'utf8')).toBe('merged remotely\n');
  });
});
