import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, readdir, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { withDurableExecution } from '@aws/durable-execution-sdk-js';
import {
  LocalDurableTestRunner,
  WaitingOperationStatus,
} from '@aws/durable-execution-sdk-js-testing';
import { __durableHandler } from '../index.js';
import { initLane, mergeLane } from '../../agentcore/commands/lane.js';
import { resolveConflict } from '../../agentcore/commands/resolve-conflict.js';
import { runGit, commitAndPushAll, fetchOrigin } from '../../agentcore/git-engine.js';

// ---------------------------------------------------------------------------
// WP8 merge fixtures, pulled forward (docs/v2-parallel.md):
//
//   1. 3-unit DAG (a, b ∥ → c): a∥b run, c waits and SEES MERGED a+b CODE.
//   2. Forced merge conflict → lane FAILED (conflicted paths reported) →
//      halt-and-ask SKIP → run completes without the conflicted unit; the
//      intent branch and tree stay pristine.
//
// These are the deepest local integration tests in the repo: the REAL
// orchestrator handler on the REAL durable runner (checkpoint/suspend/replay),
// dispatching to the REAL init-lane / merge-lane command functions and REAL
// engine git against local bare remotes. The only fakes are the process store
// (in-memory) and the agent CLI (each "stage" writes a real file + real
// commit + real push on its lane's branch). This closes the one seam no unit
// suite crosses: the orchestrator's dispatch payloads ARE the commands' args.
// ---------------------------------------------------------------------------

vi.setConfig({ testTimeout: 120_000 });

beforeAll(async () => {
  await LocalDurableTestRunner.setupTestEnvironment();
});

afterAll(async () => {
  await LocalDurableTestRunner.teardownTestEnvironment();
});

let root;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'section-integ-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const git = (args, cwd) => runGit(args, { cwd });
const URLS = (remote) => ({ auth: remote, clean: 'https://github.com/o/r.git' });

// Bare remote seeded with main + the intent branch (the pre-section stages
// "pushed" it — here a seed commit stands in for their work).
const initRemote = async () => {
  const remote = path.join(root, 'remote.git');
  await git(['init', '--bare', remote], root);
  const seed = path.join(root, 'seed');
  await git(['init', '-b', 'main', seed], root);
  await writeFile(path.join(seed, 'README.md'), 'seed\n');
  await git(['add', '-A'], seed);
  await git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'seed'], seed);
  await git(['push', remote, 'main'], seed);
  await git(['push', remote, 'main:refs/heads/aidlc/i1'], seed);
  return remote;
};

// Real clone from the file:// remote, scrubbed like workspace.js, checked out
// on the requested branch (stands in for checkoutRepo's provider-URL clone).
const realCheckoutRepo =
  (remote) =>
  async ({ branch, targetDir }) => {
    await mkdir(targetDir, { recursive: true });
    const clone = await git(['clone', remote, targetDir], root);
    if (clone.exitCode !== 0) return { cloned: false };
    await git(['remote', 'set-url', 'origin', 'https://github.com/o/r.git'], targetDir);
    await fetchOrigin({ dir: targetDir, repo: 'o/r', urls: URLS(remote) });
    await git(['checkout', '-B', branch, `refs/remotes/origin/${branch}`], targetDir);
    return { repo: 'o/r', targetDir, cloned: true };
  };

const META = {
  executionId: 'i1',
  intentId: 'i1',
  projectId: 'p1',
  status: 'CREATED',
  workflowId: 'aidlc-v2',
  workflowVersion: 1,
  scope: 'feature',
  startedAt: 'T',
  startedBy: 'u1',
  repos: ['o/r'],
  branch: 'aidlc/i1',
  baseBranch: 'main',
  gitProvider: 'github',
  agentCli: 'kiro',
  parkReleaseSeconds: null,
};

const PLAN = {
  valid: true,
  plan: {
    namespace: 'aidlc-v2@1',
    stages: [
      {
        stageId: 'gen',
        stageInstanceId: 'si-gen',
        parallelSection: null,
        outputArtifacts: [{ artifact: 'unit-of-work-dependency' }],
      },
      {
        stageId: 'cg',
        stageInstanceId: 'si-cg',
        parallelSection: 1,
        execution: 'ALWAYS',
        phase: 'construction',
        // A lane stage that RECORDS an artifact: the per-lane derive hook must
        // fire (graph projection for lane-produced artifacts, unit-attributed).
        outputArtifacts: [{ artifact: 'component-implementation' }],
      },
      { stageId: 'bt', stageInstanceId: 'si-bt', parallelSection: null, outputArtifacts: [] },
    ],
  },
};

// The in-memory world: process-store fake + the "container" that does REAL
// git work per dispatch. Each AgentCore session gets its own workspace dir —
// exactly the per-session mount model.
const makeWorld = ({ remote, unitPlan, fileFor, beforeStage = null, conflictAgent = null }) => {
  const world = {
    remote,
    invokes: [],
    sessions: [],
    unitStates: [],
    events: [],
    statusWrites: [],
    gates: new Map(),
    gateCallbackBindings: [],
    seen: new Map(), // unitSlug (or 'intent') → files present when its stage ran
    pendingHumanTaskId: null,
    runner: null, // bound after the runner exists
  };

  const store = {
    getExecution: async () => ({ ...META, pendingHumanTaskId: world.pendingHumanTaskId }),
    updateExecution: async (input) => {
      if (input.status) world.statusWrites.push(input.status);
      return { orchestratorRunId: input.orchestratorRunId ?? null };
    },
    setGateCallbackId: async (input) => {
      world.gateCallbackBindings.push(input);
      return {};
    },
    createHumanTask: async (args) => {
      if (!world.gates.has(args.humanTaskId)) {
        world.gates.set(args.humanTaskId, { ...args, status: 'pending' });
      }
      return world.gates.get(args.humanTaskId);
    },
    getHumanTask: async (_e, id) => world.gates.get(id) ?? null,
    appendEvent: async (e) => {
      world.events.push(e);
      return e;
    },
    getUnitPlan: async () => unitPlan,
    updateUnitPlanDecisions: async () => ({}),
    updateUnitState: async (args) => {
      world.unitStates.push(`${args.slug}:${args.state}`);
      return { slug: args.slug, state: args.state };
    },
    putStage: async (args) => args,
    getStage: async () => null,
  };

  const wsFor = (sessionId) => path.join(root, 'ws', sessionId);

  // One "agent stage": record what the workspace contains, write this unit's
  // file, then REAL engine commit+push on the lane's branch — the same hook
  // run-stage runs after every CLI exit.
  const doStageWork = async (payload, ws) => {
    if (payload.stageId === 'cg') {
      if (beforeStage) await beforeStage(payload, world);
      const seen = (await readdir(ws)).filter((f) => f !== '.git');
      world.seen.set(payload.unitSlug, seen.toSorted());
      const file = fileFor(payload.unitSlug);
      await writeFile(path.join(ws, file.name), file.content);
      const pushed = await commitAndPushAll({
        repos: ['o/r'],
        workspaceDir: ws,
        branch: payload.branch, // the lane's unit branch, from cloneInputs
        message: `aidlc(cg): ${payload.unitSlug} — i1`,
        urlsFor: () => URLS(remote),
        sleep: async () => {},
        log: () => {},
      });
      if (!pushed.ok) return { ok: false, state: 'FAILED', reason: 'push_failed' };
      return { ok: true, state: 'SUCCEEDED' };
    }
    if (payload.stageId === 'bt') {
      world.seen.set('intent', (await readdir(ws)).filter((f) => f !== '.git').toSorted());
    }
    return { ok: true, state: 'SUCCEEDED' };
  };

  // The container: REAL command functions for init-lane / merge-lane; stages
  // as accepted background jobs that complete their durable callback.
  const invokeRuntime = async (payload, sessionId) => {
    world.invokes.push(payload);
    world.sessions.push(sessionId);
    const ws = wsFor(sessionId);
    if (payload.command === 'init-ws') {
      await realCheckoutRepo(remote)({ branch: payload.branch, targetDir: ws });
      return { ok: true };
    }
    if (payload.command === 'promote-units') {
      return { ok: true, unitCount: unitPlan.units.length, batchCount: unitPlan.batches.length };
    }
    if (payload.command === 'derive-artifacts') {
      return { ok: true, artifacts: payload.artifactTypes ?? [], sections: 0, items: 0 };
    }
    if (payload.command === 'init-lane') {
      return initLane(
        { ...payload, workspaceDir: ws },
        { store, checkoutRepo: realCheckoutRepo(remote), urlsFor: () => URLS(remote) },
      );
    }
    if (payload.command === 'merge-lane') {
      return mergeLane({ ...payload, workspaceDir: ws }, { store, urlsFor: () => URLS(remote) });
    }
    if (payload.command === 'resolve-conflict') {
      // The REAL WP6 conflict-resolution command: engine reverse-merge + a
      // fake CLI whose "agent" is the fixture's conflictAgent (or a no-op —
      // markers remain and the engine verification refuses). META requests
      // kiro, so the container must offer it (selectCli honors the request).
      return resolveConflict(
        { ...payload, workspaceDir: ws },
        {
          store,
          availableClis: ['kiro'],
          mcpEntry: '/opt/agentcore/mcp/index.js',
          env: {},
          materializeKiroAgent: async () => 'aidlc',
          spawnFn: (_c, _a, opts) => ({
            on(ev, cb) {
              if (ev === 'close') {
                Promise.resolve()
                  .then(() => conflictAgent?.(opts?.cwd))
                  .then(
                    () => setImmediate(() => cb(0)),
                    () => setImmediate(() => cb(0)),
                  );
              }
            },
            stdin: { end() {} },
          }),
          urlsFor: () => URLS(remote),
        },
      );
    }
    if (payload.command === 'run-stage-start') {
      const opName = `stage-cb-${payload.stageId}${
        payload.unitSlug ? `-s${payload.sectionIndex ?? 'legacy'}-u-${payload.unitSlug}` : ''
      }${payload.resumeFrom ? `-resume-${payload.resumeFrom}` : ''}`;
      (async () => {
        try {
          const result = await doStageWork(payload, ws);
          const op = await world.runner
            .getOperation(opName)
            .waitForData(WaitingOperationStatus.STARTED);
          await op.sendCallbackSuccess(JSON.stringify(result));
        } catch (e) {
          console.error(`[fixture] stage work failed for ${opName}:`, e?.message);
        }
      })();
      return { ok: true, accepted: true, stageId: payload.stageId };
    }
    throw new Error(`fixture container: unknown command ${payload.command}`);
  };

  world.deps = {
    store,
    loadPlan: async () => PLAN,
    invokeRuntime,
    resolveToken: async () => '',
    stopSession: async () => ({ stopped: true }),
    broadcast: async () => {},
  };
  return world;
};

// Answer an engine gate (its id embeds the run's non-deterministic runId):
// wait for the row to appear, flip it, complete its durable callback.
const answerEngineGate = async (world, prefix, patch = { status: 'answered' }) => {
  let id;
  for (let i = 0; i < 400 && !id; i++) {
    id = [...world.gates.keys()].find((k) => k.startsWith(prefix));
    if (!id) await new Promise((r) => setTimeout(r, 25));
  }
  expect(id, `engine gate ${prefix} was never opened`).toBeTruthy();
  const op = await world.runner
    .getOperation(`await-${id}`)
    .waitForData(WaitingOperationStatus.STARTED);
  world.gates.set(id, { ...world.gates.get(id), ...patch });
  await op.sendCallbackSuccess(JSON.stringify({ answer: patch.answer ?? null }));
  return id;
};

const startRun = (world) => {
  const handler = withDurableExecution((event, ctx) => __durableHandler(event, ctx, world.deps));
  world.runner = new LocalDurableTestRunner({ handlerFunction: handler });
  return world.runner.run({ payload: { action: 'start', intentId: 'i1', executionId: 'i1' } });
};

// Fresh clone of the remote's intent branch for end-state assertions.
const verifyClone = async (remote) => {
  const dir = path.join(root, 'verify');
  await realCheckoutRepo(remote)({ branch: 'aidlc/i1', targetDir: dir });
  return dir;
};

describe('WP8 fixture 1 — 3-unit DAG: a, b ∥ → c sees merged a+b code (real git)', () => {
  it('runs the section end to end; c genuinely builds on the merged work of a and b', async () => {
    const remote = await initRemote();
    const world = makeWorld({
      remote,
      unitPlan: {
        units: [
          { slug: 'a', dependsOn: [] },
          { slug: 'b', dependsOn: [] },
          { slug: 'c', dependsOn: ['a', 'b'] },
        ],
        batches: [['a', 'b'], ['c']],
        skipMatrix: {},
        walkingSkeleton: 'a',
      },
      fileFor: (slug) => ({ name: `unit-${slug}.txt`, content: `code of ${slug}\n` }),
    });
    const executionPromise = startRun(world);

    // gen → fan-out gate → skeleton lane a (solo) → skeleton gate → ladder.
    const genOp = await world.runner
      .getOperation('stage-cb-gen')
      .waitForData(WaitingOperationStatus.STARTED);
    await genOp.sendCallbackSuccess(JSON.stringify({ ok: true, state: 'SUCCEEDED' }));
    await answerEngineGate(world, 'eg-validation-si-gen-0');
    await answerEngineGate(world, 'eg-skeleton-s1');
    await answerEngineGate(world, 'eg-ladder-s1', {
      status: 'answered',
      answer: { mode: 'autonomous' },
    });

    const execution = await executionPromise;
    expect(execution.getResult()).toEqual({ ok: true, intentId: 'i1', stages: 3 });

    // ── The core promise: c's lane workspace CONTAINED a's and b's code ────
    // (its branch forked from the intent branch only after both merged).
    expect(world.seen.get('c')).toEqual(
      expect.arrayContaining(['unit-a.txt', 'unit-b.txt', 'README.md']),
    );
    // The skeleton (a) ran first and solo — it saw nobody's work.
    expect(world.seen.get('a')).toEqual(['README.md']);
    // b forked AFTER the skeleton merged (by design: remaining lanes fork
    // from post-skeleton intent HEAD) but never saw its peer c.
    expect(world.seen.get('b')).toContain('unit-a.txt');
    expect(world.seen.get('b')).not.toContain('unit-c.txt');
    // The post-section stage (bt) ran on the fully fanned-in intent branch.
    expect(world.seen.get('intent')).toEqual(
      expect.arrayContaining(['unit-a.txt', 'unit-b.txt', 'unit-c.txt']),
    );

    // ── Remote end state: all three files on the intent branch, one --no-ff
    // merge commit per lane with the deterministic message. ────────────────
    const dir = await verifyClone(remote);
    for (const slug of ['a', 'b', 'c']) {
      expect(await readFile(path.join(dir, `unit-${slug}.txt`), 'utf8')).toBe(`code of ${slug}\n`);
    }
    const merges = await git(['log', '--merges', '--format=%s', 'aidlc/i1'], dir);
    const mergeSubjects = merges.stdout.trim().split('\n').toSorted();
    expect(mergeSubjects).toEqual([
      'aidlc(merge): a — i1',
      'aidlc(merge): b — i1',
      'aidlc(merge): c — i1',
    ]);

    // ── Lane derive hook: one graph-projection dispatch per unit lane, scoped
    // to the lane's stage instance, attributed to the unit, riding the lane
    // session (never the intent session). Enrichment defaults off (no META
    // snapshot in this fixture).
    const laneDerives = world.invokes.filter((p) => p.command === 'derive-artifacts' && p.unitSlug);
    expect(laneDerives.map((p) => p.unitSlug).toSorted()).toEqual(['a', 'b', 'c']);
    // Per-unit stage instances are distinct (hashed plan ids), one per lane.
    expect(new Set(laneDerives.map((p) => p.stageInstanceId)).size).toBe(3);
    for (const d of laneDerives) {
      expect(d).toMatchObject({
        artifactTypes: ['component-implementation'],
        enrichment: 'off',
      });
      const session = world.sessions[world.invokes.indexOf(d)];
      expect(session).toContain(`-${d.unitSlug}`);
    }
    // Unit branches remain on the remote (audit trail / retry substrate).
    for (const slug of ['a', 'b', 'c']) {
      const ls = await git(['ls-remote', remote, `aidlc/i1--s1-unit-${slug}`], root);
      expect(ls.stdout.trim(), `unit branch for ${slug}`).not.toBe('');
    }

    // ── Lane lifecycle: every unit RUNNING → MERGING → MERGED exactly once;
    // c only after a and b (its lane awaited their DurablePromises). ───────
    const per = (slug) => world.unitStates.filter((s) => s.startsWith(`${slug}:`));
    for (const slug of ['a', 'b', 'c']) {
      expect(per(slug)).toEqual([`${slug}:RUNNING`, `${slug}:MERGING`, `${slug}:MERGED`]);
    }
    expect(world.unitStates.indexOf('c:RUNNING')).toBeGreaterThan(
      Math.max(world.unitStates.indexOf('a:MERGED'), world.unitStates.indexOf('b:MERGED')),
    );
    // Each lane ran in its own session; merges all ran in the intent session.
    const sessionOf = (pred) => world.sessions[world.invokes.findIndex(pred)];
    for (const slug of ['a', 'b', 'c']) {
      expect(sessionOf((p) => p.command === 'init-lane' && p.unitSlug === slug)).toBe(
        `aidlc-intent-i1-s1-${slug}`.padEnd(33, '0'),
      );
      expect(sessionOf((p) => p.command === 'merge-lane' && p.unitSlug === slug)).toBe(
        'aidlc-intent-i1'.padEnd(33, '0'),
      );
    }
    expect(world.statusWrites.filter((s) => s === 'SUCCEEDED')).toHaveLength(1);
  });
});

describe('WP8 fixture 2 — forced merge conflict → halt-and-ask SKIP (real git)', () => {
  it('the conflicting lane fails with the conflicted paths; skip completes the run; the intent branch stays pristine', async () => {
    const remote = await initRemote();
    // a is the skeleton; b and c are INDEPENDENT and both write shared.txt —
    // they fork from the same post-skeleton HEAD, so the second merge is a
    // genuine add/add conflict. c's stage waits for b to MERGE first, making
    // the conflict land deterministically on c.
    const world = makeWorld({
      remote,
      unitPlan: {
        units: [
          { slug: 'a', dependsOn: [] },
          { slug: 'b', dependsOn: [] },
          { slug: 'c', dependsOn: [] },
        ],
        batches: [['a', 'b', 'c']],
        skipMatrix: {},
        walkingSkeleton: 'a',
      },
      fileFor: (slug) =>
        slug === 'a'
          ? { name: 'unit-a.txt', content: 'code of a\n' }
          : { name: 'shared.txt', content: `${slug} version\n` },
      beforeStage: async (payload, w) => {
        if (payload.unitSlug !== 'c') return;
        for (let i = 0; i < 400 && !w.unitStates.includes('b:MERGED'); i++) {
          await new Promise((r) => setTimeout(r, 25));
        }
      },
    });
    const executionPromise = startRun(world);

    const genOp = await world.runner
      .getOperation('stage-cb-gen')
      .waitForData(WaitingOperationStatus.STARTED);
    await genOp.sendCallbackSuccess(JSON.stringify({ ok: true, state: 'SUCCEEDED' }));
    await answerEngineGate(world, 'eg-validation-si-gen-0');
    await answerEngineGate(world, 'eg-skeleton-s1');
    await answerEngineGate(world, 'eg-ladder-s1', {
      status: 'answered',
      answer: { mode: 'autonomous' },
    });
    // b merges; c's merge conflicts → halt-and-ask → human SKIPS.
    await answerEngineGate(world, 'eg-halt-s1-r0', {
      status: 'answered',
      answer: { decision: 'skip' },
    });

    const execution = await executionPromise;
    expect(execution.getResult()).toEqual({ ok: true, intentId: 'i1', stages: 3 });

    // ── Lane verdicts: b MERGED; c hit a real conflict, the resolution stage
    // ran (no-op agent → markers remained → engine refused), lane FAILED. ──
    expect(world.unitStates.filter((s) => s.startsWith('b:'))).toEqual([
      'b:RUNNING',
      'b:MERGING',
      'b:MERGED',
    ]);
    expect(world.unitStates.filter((s) => s.startsWith('c:'))).toEqual([
      'c:RUNNING',
      'c:MERGING',
      'c:FAILED',
    ]);
    const cFailed = world.events.find((e) => e.type === 'v2.unit.failed' && e.unitSlug === 'c');
    expect(cFailed?.summary).toContain('markers_remain');
    // The full escalation chain is on the audit trail: the REAL merge-lane
    // recorded the conflicted path, the resolution stage ran and refused.
    const mergeFailed = world.events.find((e) => e.type === 'v2.git.merge_failed');
    expect(mergeFailed?.summary).toContain('shared.txt');
    expect(
      world.events.find((e) => e.type === 'v2.unit.conflict' && e.unitSlug === 'c')?.summary,
    ).toContain('shared.txt');
    expect(world.events.some((e) => e.type === 'v2.conflict.resolving')).toBe(true);
    expect(world.events.some((e) => e.type === 'v2.conflict.unresolved')).toBe(true);
    // The resolution ran in c's LANE session.
    const rcIdx = world.invokes.findIndex((p) => p.command === 'resolve-conflict');
    expect(world.invokes[rcIdx]).toMatchObject({ unitSlug: 'c' });
    expect(world.sessions[rcIdx]).toBe('aidlc-intent-i1-s1-c'.padEnd(33, '0'));
    // The halt decision + skip are on the audit trail; fan-in is HONEST (2/3).
    expect(world.events.find((e) => e.type === 'v2.units.halt_decision')?.summary).toContain(
      'skip',
    );
    expect(world.events.some((e) => e.type === 'v2.units.lanes_skipped')).toBe(true);
    expect(world.events.find((e) => e.type === 'v2.units.fan_in')?.summary).toContain('2/3');

    // ── Remote end state: b's version won; c's work exists ONLY on its unit
    // branch (preserved for the retry / WP6 conflict stage), and the intent
    // branch has exactly two merge commits (a, b). ─────────────────────────
    const dir = await verifyClone(remote);
    expect(await readFile(path.join(dir, 'shared.txt'), 'utf8')).toBe('b version\n');
    const merges = await git(['log', '--merges', '--format=%s', 'aidlc/i1'], dir);
    expect(merges.stdout.trim().split('\n').toSorted()).toEqual([
      'aidlc(merge): a — i1',
      'aidlc(merge): b — i1',
    ]);
    const lsC = await git(['ls-remote', remote, 'aidlc/i1--s1-unit-c'], root);
    expect(lsC.stdout.trim()).not.toBe('');
    // The intent-session tree is pristine: no in-progress merge, no dirt.
    const intentWs = path.join(root, 'ws', 'aidlc-intent-i1'.padEnd(33, '0'));
    const status = await git(['status', '--porcelain'], intentWs);
    expect(status.stdout.trim()).toBe('');
    const mergeHead = await git(['rev-parse', '--verify', 'MERGE_HEAD'], intentWs);
    expect(mergeHead.exitCode).not.toBe(0);
    expect(world.statusWrites.filter((s) => s === 'SUCCEEDED')).toHaveLength(1);
  });
});

describe('WP6 fixture 3 — conflict RESOLVED by the resolution stage (real git)', () => {
  it('the agent resolves the reverse merge, the merge-back retry lands, all lanes merge', async () => {
    const remote = await initRemote();
    const world = makeWorld({
      remote,
      unitPlan: {
        units: [
          { slug: 'a', dependsOn: [] },
          { slug: 'b', dependsOn: [] },
          { slug: 'c', dependsOn: [] },
        ],
        batches: [['a', 'b', 'c']],
        skipMatrix: {},
        walkingSkeleton: 'a',
      },
      fileFor: (slug) =>
        slug === 'a'
          ? { name: 'unit-a.txt', content: 'code of a\n' }
          : { name: 'shared.txt', content: `${slug} version\n` },
      beforeStage: async (payload, w) => {
        if (payload.unitSlug !== 'c') return;
        for (let i = 0; i < 400 && !w.unitStates.includes('b:MERGED'); i++) {
          await new Promise((r) => setTimeout(r, 25));
        }
      },
      // The "agent" genuinely resolves the add/add conflict: both versions kept.
      conflictAgent: async (cwd) => {
        await writeFile(path.join(cwd, 'shared.txt'), 'b version + c version\n');
      },
    });
    const executionPromise = startRun(world);

    const genOp = await world.runner
      .getOperation('stage-cb-gen')
      .waitForData(WaitingOperationStatus.STARTED);
    await genOp.sendCallbackSuccess(JSON.stringify({ ok: true, state: 'SUCCEEDED' }));
    await answerEngineGate(world, 'eg-validation-si-gen-0');
    await answerEngineGate(world, 'eg-skeleton-s1');
    await answerEngineGate(world, 'eg-ladder-s1', {
      status: 'answered',
      answer: { mode: 'autonomous' },
    });
    // NO halt gate this time — the resolution stage handles the conflict.

    const execution = await executionPromise;
    expect(execution.getResult()).toEqual({ ok: true, intentId: 'i1', stages: 3 });

    // Every lane merged — including the conflicted one, after resolution.
    for (const slug of ['a', 'b', 'c']) {
      expect(world.unitStates.filter((s) => s === `${slug}:MERGED`)).toHaveLength(1);
    }
    // The escalation chain: conflict → resolving → resolved; NO halt decision.
    expect(world.events.some((e) => e.type === 'v2.unit.conflict' && e.unitSlug === 'c')).toBe(
      true,
    );
    expect(world.events.some((e) => e.type === 'v2.conflict.resolved')).toBe(true);
    expect(world.events.some((e) => e.type === 'v2.units.halt_decision')).toBe(false);
    expect(world.events.find((e) => e.type === 'v2.units.fan_in')?.summary).toContain('3/3');
    // Dispatch order for c: merge (conflict) → resolve (lane session) → merge retry.
    const cOps = world.invokes
      .map((p, i) => ({ p, s: world.sessions[i] }))
      .filter(
        ({ p }) => p.unitSlug === 'c' && ['merge-lane', 'resolve-conflict'].includes(p.command),
      );
    expect(cOps.map(({ p }) => p.command)).toEqual([
      'merge-lane',
      'resolve-conflict',
      'merge-lane',
    ]);
    expect(cOps[1].s).toBe('aidlc-intent-i1-s1-c'.padEnd(33, '0'));

    // ── Remote end state: the resolved content is on the intent branch; the
    // resolution merge commit (engine identity) is on c's unit branch. ─────
    const dir = await verifyClone(remote);
    expect(await readFile(path.join(dir, 'shared.txt'), 'utf8')).toBe('b version + c version\n');
    const merges = await git(['log', '--merges', '--format=%s', 'aidlc/i1'], dir);
    expect(merges.stdout.trim().split('\n').toSorted()).toEqual([
      'aidlc(conflict-resolution): c — i1',
      'aidlc(merge): a — i1',
      'aidlc(merge): b — i1',
      'aidlc(merge): c — i1',
    ]);
    expect(world.statusWrites.filter((s) => s === 'SUCCEEDED')).toHaveLength(1);
  });
});
