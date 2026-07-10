import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveConflict, buildConflictPrompt } from '../commands/resolve-conflict.js';
import { runGit } from '../git-engine.js';

// WP6 conflict-resolution stage against REAL git: the engine's reverse merge
// materializes genuine conflict markers, the "agent" is a spawnFn stub that
// edits files (or doesn't), and the engine verification decides the outcome.

vi.setConfig({ testTimeout: 30_000 });

let root;
const git = (args, cwd) => runGit(args, { cwd });
const URLS = (remote) => ({ auth: remote, clean: 'https://github.com/o/r.git' });

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

// Remote with a genuine add/add conflict between the intent and unit branch,
// plus the LANE workspace checked out on the unit branch.
const conflictWorld = async () => {
  const remote = path.join(root, 'remote.git');
  await git(['init', '--bare', '-b', 'main', remote], root);
  const seed = path.join(root, 'seed');
  await git(['init', '-b', 'main', seed], root);
  await writeFile(path.join(seed, 'README.md'), 'seed\n');
  await git(['add', '-A'], seed);
  await git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'seed'], seed);
  await git(['push', remote, 'main'], seed);
  await git(['push', remote, 'main:refs/heads/aidlc/i1'], seed);
  await commitOnRemote(remote, 'aidlc/i1--s1-unit-u', 'unit.txt', 'unit work\n');
  await commitOnRemote(remote, 'aidlc/i1', 'shared.txt', 'intent version\n');
  await commitOnRemote(remote, 'aidlc/i1--s1-unit-u', 'shared.txt', 'unit version\n');
  const ws = path.join(root, 'lane-ws');
  await git(['clone', remote, ws], root);
  await git(['remote', 'set-url', 'origin', 'https://github.com/o/r.git'], ws);
  await git(['checkout', 'aidlc/i1--s1-unit-u'], ws);
  return { remote, ws };
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

// A fake CLI child: runs `agent(ws)` (the "resolution") then exits.
const fakeCliSpawn =
  (agent, exitCode = 0) =>
  (_command, _args, opts) => ({
    on(ev, cb) {
      if (ev === 'close') {
        Promise.resolve()
          .then(() => agent?.(opts?.cwd))
          .then(
            () => setImmediate(() => cb(exitCode)),
            () => setImmediate(() => cb(exitCode)),
          );
      }
    },
    stdin: { end() {} },
  });

const basePayload = (ws, over = {}) => ({
  projectId: 'p1',
  intentId: 'i1',
  executionId: 'e1',
  unitSlug: 'u',
  sectionIndex: 1,
  repos: ['o/r'],
  unitBranch: 'aidlc/i1--s1-unit-u',
  intentBranch: 'aidlc/i1',
  workspaceDir: ws,
  requestedCli: 'claude',
  ...over,
});

const baseDeps = (remote, store, spawnFn) => ({
  store,
  availableClis: ['claude'],
  mcpEntry: '/opt/agentcore/mcp/index.js',
  env: { BEDROCK_MODEL: 'us.anthropic.claude-sonnet-4-6' },
  spawnFn,
  materializeMcpConfig: async () => '/tmp/mcp.json',
  materializeKiroAgent: async () => 'aidlc',
  urlsFor: () => URLS(remote),
});

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'resolve-conflict-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('buildConflictPrompt', () => {
  it('names the lane, the branches, every conflicted file, and the hard rules', () => {
    const prompt = buildConflictPrompt({
      unitSlug: 'auth',
      unitBranch: 'aidlc/i1--s1-unit-auth',
      intentBranch: 'aidlc/i1',
      conflictedByRepo: [{ repo: 'o/r', conflicts: ['src/a.js', 'src/b.js'] }],
    });
    expect(prompt).toContain('Unit lane "auth"');
    expect(prompt).toContain('- o/r: src/a.js');
    expect(prompt).toContain('- o/r: src/b.js');
    expect(prompt).toContain('Do NOT run any git command');
    expect(prompt).toContain('Edit ONLY the files listed above');
  });
});

describe('resolveConflict', () => {
  it('resolves a real conflict: engine merges, agent edits, engine verifies + concludes + pushes', async () => {
    const { remote, ws } = await conflictWorld();
    const store = spyStore();
    let promptSeen = null;
    const spawnFn = (command, args, opts) => {
      const child = fakeCliSpawn(async (cwd) => {
        // The "agent" resolves the conflicted file (markers gone, both kept).
        await writeFile(path.join(cwd, 'shared.txt'), 'intent version + unit version\n');
      })(command, args, opts);
      // The prompt is piped on stdin (E2BIG fix), not on argv.
      child.stdin = { end: (v) => (promptSeen = v) };
      return child;
    };
    const res = await resolveConflict(basePayload(ws), baseDeps(remote, store, spawnFn));
    expect(res.ok).toBe(true);
    expect(res.resolvedFiles).toEqual(['o/r:shared.txt']);
    // The agent got the focused prompt with the actual conflicted file.
    expect(promptSeen).toContain('- o/r: shared.txt');
    // The unit branch on the REMOTE now contains the resolution AND the
    // intent branch (the merge-back retry is clean by construction).
    const verify = path.join(root, 'verify');
    await git(['clone', '--branch', 'aidlc/i1--s1-unit-u', remote, verify], root);
    expect(await readFile(path.join(verify, 'shared.txt'), 'utf8')).toBe(
      'intent version + unit version\n',
    );
    const ancestor = await git(['merge-base', '--is-ancestor', 'origin/aidlc/i1', 'HEAD'], verify);
    expect(ancestor.exitCode).toBe(0);
    // Audit trail: resolving → resolved, lane-attributed.
    expect(store.events.map((e) => `${e.type}:${e.unitSlug}`)).toEqual([
      'v2.conflict.resolving:u',
      'v2.conflict.resolved:u',
    ]);
  });

  it('a payload gitAuthor attributes the resolution merge commit to the user', async () => {
    const { remote, ws } = await conflictWorld();
    const spawnFn = fakeCliSpawn(async (cwd) => {
      await writeFile(path.join(cwd, 'shared.txt'), 'intent version + unit version\n');
    });
    const gitAuthor = { name: 'Jane Dev', email: '1+jane@users.noreply.github.com' };
    const res = await resolveConflict(
      basePayload(ws, { gitAuthor }),
      baseDeps(remote, spyStore(), spawnFn),
    );
    expect(res.ok).toBe(true);
    const verify = path.join(root, 'verify-author');
    await git(['clone', '--branch', 'aidlc/i1--s1-unit-u', remote, verify], root);
    const who = await git(['log', '-1', '--format=%an|%ae|%cn|%ce'], verify);
    expect(who.stdout.trim()).toBe(
      'Jane Dev|1+jane@users.noreply.github.com|AI-DLC Engine|aidlc-engine@noreply.local',
    );
  });

  it('REFUSES a lazy agent (markers remain): aborts to a pristine tree and fails as a value', async () => {
    const { remote, ws } = await conflictWorld();
    const store = spyStore();
    // The "agent" does nothing.
    const res = await resolveConflict(basePayload(ws), baseDeps(remote, store, fakeCliSpawn(null)));
    expect(res).toMatchObject({ ok: false, reason: 'markers_remain' });
    expect(res.remaining).toEqual(['shared.txt']);
    // Pristine tree, no merge in progress, unit content restored.
    expect((await git(['status', '--porcelain'], ws)).stdout.trim()).toBe('');
    expect((await git(['rev-parse', '--verify', 'MERGE_HEAD'], ws)).exitCode).not.toBe(0);
    expect(await readFile(path.join(ws, 'shared.txt'), 'utf8')).toBe('unit version\n');
    expect(store.events.map((e) => e.type)).toEqual([
      'v2.conflict.resolving',
      'v2.conflict.unresolved',
    ]);
    // The remote unit branch did NOT move.
    const ls = await git(['ls-remote', remote, 'aidlc/i1--s1-unit-u'], root);
    const local = await git(['rev-parse', 'aidlc/i1--s1-unit-u'], ws);
    expect(ls.stdout.trim().split(/\s/)[0]).toBe(local.stdout.trim());
  });

  it('a crashing CLI aborts the in-progress merge and fails cli_nonzero_exit', async () => {
    const { remote, ws } = await conflictWorld();
    const res = await resolveConflict(
      basePayload(ws),
      baseDeps(remote, spyStore(), fakeCliSpawn(null, 2)),
    );
    expect(res).toMatchObject({ ok: false, reason: 'cli_nonzero_exit', detail: '2' });
    expect((await git(['rev-parse', '--verify', 'MERGE_HEAD'], ws)).exitCode).not.toBe(0);
    expect((await git(['status', '--porcelain'], ws)).stdout.trim()).toBe('');
  });

  it('a clean reverse merge needs NO agent: concludes + pushes without spawning', async () => {
    const remote = path.join(root, 'remote.git');
    await git(['init', '--bare', '-b', 'main', remote], root);
    const seed = path.join(root, 'seed');
    await git(['init', '-b', 'main', seed], root);
    await writeFile(path.join(seed, 'README.md'), 'seed\n');
    await git(['add', '-A'], seed);
    await git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'seed'], seed);
    await git(['push', remote, 'main'], seed);
    await git(['push', remote, 'main:refs/heads/aidlc/i1'], seed);
    await commitOnRemote(remote, 'aidlc/i1--s1-unit-u', 'unit.txt', 'unit work\n');
    await commitOnRemote(remote, 'aidlc/i1', 'other.txt', 'sibling work\n'); // no overlap
    const ws = path.join(root, 'lane-ws');
    await git(['clone', remote, ws], root);
    await git(['remote', 'set-url', 'origin', 'https://github.com/o/r.git'], ws);
    await git(['checkout', 'aidlc/i1--s1-unit-u'], ws);

    const spawnFn = vi.fn();
    const res = await resolveConflict(basePayload(ws), baseDeps(remote, spyStore(), spawnFn));
    expect(res.ok).toBe(true);
    expect(res.resolvedFiles).toEqual([]);
    expect(spawnFn).not.toHaveBeenCalled();
    // The clean merge was pushed: the remote unit branch contains the intent branch.
    const verify = path.join(root, 'verify');
    await git(['clone', '--branch', 'aidlc/i1--s1-unit-u', remote, verify], root);
    expect(await readFile(path.join(verify, 'other.txt'), 'utf8')).toBe('sibling work\n');
  });

  it('validates inputs and surfaces no_cli as a value (merge aborted)', async () => {
    expect(await resolveConflict(basePayload('/ws', { unitSlug: null }), {})).toMatchObject({
      ok: false,
      reason: 'missing_unit_slug',
    });
    expect(await resolveConflict(basePayload('/ws', { repos: [] }), {})).toMatchObject({
      ok: false,
      reason: 'no_repos',
    });
    const { remote, ws } = await conflictWorld();
    const res = await resolveConflict(basePayload(ws), {
      ...baseDeps(remote, spyStore(), fakeCliSpawn(null)),
      availableClis: [], // no CLI installed
    });
    expect(res).toMatchObject({ ok: false, reason: 'no_cli' });
    expect((await git(['rev-parse', '--verify', 'MERGE_HEAD'], ws)).exitCode).not.toBe(0);
  });
});
