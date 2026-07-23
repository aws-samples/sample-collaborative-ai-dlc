import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import gremlin from 'gremlin';
import { PartitionStrategy } from 'gremlin/lib/process/traversal-strategy.js';
import { initWs, ensureIntentVertex } from '../commands/init-ws.js';
import {
  checkoutRepos as checkoutReposImpl,
  checkoutRepo as checkoutRepoImpl,
  ensureWorkspaceSource as ensureWorkspaceSourceImpl,
} from '../workspace.js';

const TEST_SECRET = ['broker', 'credential'].join('-');
const withTestCredential = async (context, operation) =>
  operation({
    env: {
      GIT_ASKPASS: '/tmp/test-askpass',
      GIT_TERMINAL_PROMPT: '0',
      AIDLC_GIT_USERNAME: context.provider === 'gitlab' ? 'oauth2' : 'x-access-token',
      AIDLC_GIT_PASSWORD: TEST_SECRET,
    },
  });
const credentialContext = {
  projectId: 'p1',
  executionId: 'e1',
  gitProvider: 'github',
  withGitCredential: withTestCredential,
};
const checkoutRepo = (args) => checkoutRepoImpl({ ...credentialContext, ...args });
const checkoutRepos = (args) => checkoutReposImpl({ ...credentialContext, ...args });
const ensureWorkspaceSource = (args) =>
  ensureWorkspaceSourceImpl({ ...credentialContext, ...args });

const PARTITION = 'agentcore-init-ws';
let conn;
let g;

beforeAll(async () => {
  const url = `ws://${process.env.NEPTUNE_ENDPOINT}:${process.env.GREMLIN_PORT}/gremlin`;
  conn = new gremlin.driver.DriverRemoteConnection(url);
  g = gremlin.process.AnonymousTraversalSource.traversal()
    .withRemote(conn)
    .withStrategies(
      new PartitionStrategy({
        partitionKey: '_partition',
        writePartition: PARTITION,
        readPartitions: [PARTITION],
      }),
    );
});
afterAll(async () => {
  await conn?.close();
});
beforeEach(async () => {
  await g.V().drop().next();
});

// Spy store with createExecution/appendEvent.
const spyStore = (createImpl) => {
  const calls = [];
  return {
    calls,
    createExecution: createImpl ?? (async (a) => calls.push(['createExecution', a])),
    appendEvent: async (a) => calls.push(['appendEvent', a]),
  };
};

describe('ensureIntentVertex', () => {
  it('creates the Intent anchor idempotently', async () => {
    await ensureIntentVertex({
      g,
      projectId: 'p1',
      intentId: 'i1',
      title: 'Build login',
      now: 'T',
    });
    await ensureIntentVertex({
      g,
      projectId: 'p1',
      intentId: 'i1',
      title: 'Build login',
      now: 'T',
    });
    const count = await g.V().has('Intent', 'id', 'i1').count().next();
    expect(count.value).toBe(1);
    const props = await g.V().has('Intent', 'id', 'i1').valueMap().next();
    expect(props.value.get('project_id')[0]).toBe('p1');
  });
});

describe('initWs', () => {
  const deps = (overrides = {}) => ({
    store: spyStore(),
    openGraph: async () => g,
    checkoutRepos: async ({ repos }) =>
      repos.map((r) => ({
        repo: typeof r === 'string' ? r : r.url,
        targetDir: `/tmp/ws/${typeof r === 'string' ? r : r.url}`,
      })),
    workspaceDir: '/tmp/ws',
    clock: () => 'T',
    // Default: the branch is not yet on the remote, and the publish succeeds.
    // Overridden per test to assert the call or exercise a failure.
    remoteBranchExists: async () => ({ exists: false }),
    pushBranch: async () => ({ pushed: true, sha: 'abc', verified: true }),
    // Default: the repo has history (not empty) — seeding is a no-op.
    seedInitialCommit: async () => ({ seeded: false, reason: 'not_empty' }),
    // Default provider default-branch (only consulted for empty repos).
    resolveDefaultBranch: async () => 'main',
    ...overrides,
  });

  it('checks out repos, creates the Intent vertex, and seeds CREATED state', async () => {
    const d = deps();
    const res = await initWs(
      {
        projectId: 'p1',
        intentId: 'i1',
        executionId: 'e1',
        repos: ['acme/api'],
        workflowId: 'aidlc-v2',
        workflowVersion: 1,
        scope: 'feature',
      },
      d,
    );
    expect(res).toMatchObject({ ok: true, intentId: 'i1', repos: ['acme/api'] });
    const intentExists = await g.V().has('Intent', 'id', 'i1').hasNext();
    expect(intentExists).toBe(true);
    const created = d.store.calls.find((c) => c[0] === 'createExecution')[1];
    expect(created).toMatchObject({
      executionId: 'e1',
      status: 'CREATED',
      workflowId: 'aidlc-v2',
      scope: 'feature',
    });
  });

  it('broadcasts the workspace init on success', async () => {
    const sent = [];
    await initWs(
      { projectId: 'p1', intentId: 'i1', executionId: 'e1', repos: ['acme/api'] },
      deps({ broadcast: async (p) => sent.push(p) }),
    );
    expect(sent[0]).toMatchObject({
      action: 'agent.workspace',
      executionId: 'e1',
      intentId: 'i1',
      projectId: 'p1',
      state: 'INITIALIZED',
      repos: ['acme/api'],
    });
  });

  it('tolerates a re-init (execution already exists)', async () => {
    const store = spyStore(async () => {
      throw Object.assign(new Error('exists'), { name: 'ConditionalCheckFailedException' });
    });
    const res = await initWs(
      { projectId: 'p1', intentId: 'i1', executionId: 'e1', repos: [] },
      deps({ store }),
    );
    expect(res.ok).toBe(true);
  });

  it('reports a checkout failure without touching the graph', async () => {
    const res = await initWs(
      { projectId: 'p1', intentId: 'i1', executionId: 'e1', repos: ['x/y'] },
      deps({
        checkoutRepos: async () => {
          throw new Error('clone denied');
        },
      }),
    );
    expect(res).toMatchObject({ ok: false, reason: 'checkout_failed' });
  });
  it('FAILS loudly when a clone fails', async () => {
    // A genuinely empty repo clones successfully. cloned:false therefore means
    // unreachable/unauthorized and must never become reusable local git state.
    const d = deps({
      checkoutRepos: async ({ repos }) =>
        repos.map((r) => ({ repo: typeof r === 'string' ? r : r.url, cloned: false })),
    });
    const res = await initWs(
      {
        projectId: 'p1',
        intentId: 'i1',
        executionId: 'e1',
        repos: ['owner/private-repo'],
        branch: 'aidlc/i1',
        baseBranch: 'main',
        workflowId: 'aidlc-v2',
        workflowVersion: 1,
        scope: 'feature',
      },
      d,
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('checkout_failed');
    expect(res.detail).toContain('owner/private-repo');
    expect(res.detail).toContain('binding');
  });

  it('FAILS loudly when the intent branch could not be set up (branchOk:false)', async () => {
    // Clone came down but every branch rung failed — proceeding would commit
    // every stage's work to whatever branch HEAD happens to be on.
    const d = deps({
      checkoutRepos: async ({ repos }) =>
        repos.map((r) => ({
          repo: typeof r === 'string' ? r : r.url,
          cloned: true,
          branchOk: false,
        })),
    });
    const res = await initWs(
      {
        projectId: 'p1',
        intentId: 'i1',
        executionId: 'e1',
        repos: ['acme/empty'],
        branch: 'aidlc/i1',
        baseBranch: 'main',
      },
      d,
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('branch_setup_failed');
    expect(res.detail).toContain('acme/empty');
    expect(res.detail).toContain("'aidlc/i1'");
  });

  it('publishes the intent branch to the remote (per repo) so lanes can fork/merge it', async () => {
    const pushed = [];
    const d = deps({
      checkoutRepos: async ({ repos }) =>
        repos.map((r) => ({ repo: r, targetDir: `/tmp/ws/${r}` })),
      pushBranch: async (args) => {
        pushed.push(args);
        return { pushed: true, sha: 'abc', verified: true };
      },
    });
    const res = await initWs(
      {
        projectId: 'p1',
        intentId: 'i1',
        executionId: 'e1',
        repos: ['acme/api', 'acme/web'],
        branch: 'aidlc/i1',
        baseBranch: 'main',
        gitProvider: 'github',
      },
      d,
    );
    expect(res.ok).toBe(true);
    // One publish per repo, targeting the intent branch with broker context.
    expect(pushed).toHaveLength(2);
    expect(pushed[0]).toMatchObject({
      dir: '/tmp/ws/acme/api',
      repo: 'acme/api',
      branch: 'aidlc/i1',
      gitProvider: 'github',
      projectId: 'p1',
      executionId: 'e1',
    });
    expect(pushed[1]).toMatchObject({ repo: 'acme/web', branch: 'aidlc/i1' });
  });

  it('FAILS loudly when the intent branch cannot be published (lanes depend on it)', async () => {
    const d = deps({
      pushBranch: async () => ({ pushed: false, reason: 'push_failed', detail: 'Access denied' }),
    });
    const res = await initWs(
      {
        projectId: 'p1',
        intentId: 'i1',
        executionId: 'e1',
        repos: ['acme/api'],
        branch: 'aidlc/i1',
        baseBranch: 'main',
        gitProvider: 'gitlab',
      },
      d,
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('intent_branch_push_failed');
    expect(res.detail).toContain('acme/api');
    expect(res.detail).toContain('aidlc/i1');
  });

  it('for an empty repo, roots the base branch then publishes base FIRST, intent SECOND', async () => {
    const seeded = [];
    const pushed = [];
    const d = deps({
      // Empty repo → seedInitialCommit roots the base branch + forks the intent.
      seedInitialCommit: async (args) => {
        seeded.push(args);
        return { seeded: true, sha: 'root0', baseBranch: args.baseBranch };
      },
      pushBranch: async (args) => {
        pushed.push(args.branch);
        return { pushed: true, sha: 'root0', verified: true };
      },
    });
    const res = await initWs(
      {
        projectId: 'p1',
        intentId: 'i1',
        executionId: 'e1',
        repos: ['acme/empty'],
        branch: 'aidlc/i1',
        baseBranch: 'main',
        gitProvider: 'github',
      },
      d,
    );
    expect(res.ok).toBe(true);
    expect(seeded).toHaveLength(1);
    expect(seeded[0]).toMatchObject({ branch: 'aidlc/i1', baseBranch: 'main' });
    // Base branch pushed first (→ remote default), intent branch second.
    expect(pushed).toEqual(['main', 'aidlc/i1']);
  });

  it('resolves the base branch from the provider default when none is configured (empty repo)', async () => {
    const seeded = [];
    const pushed = [];
    const d = deps({
      resolveDefaultBranch: async () => 'master',
      seedInitialCommit: async (args) => {
        seeded.push(args);
        return { seeded: true, sha: 'root0', baseBranch: args.baseBranch };
      },
      pushBranch: async (args) => {
        pushed.push(args.branch);
        return { pushed: true };
      },
    });
    const res = await initWs(
      {
        projectId: 'p1',
        intentId: 'i1',
        executionId: 'e1',
        repos: ['acme/empty'],
        branch: 'aidlc/i1',
        // no baseBranch / baseBranches → provider default wins
        gitProvider: 'github',
      },
      d,
    );
    expect(res.ok).toBe(true);
    expect(seeded[0]).toMatchObject({ baseBranch: 'master' });
    expect(pushed).toEqual(['master', 'aidlc/i1']);
  });

  it('FAILS if the base branch cannot be published (empty repo)', async () => {
    const d = deps({
      seedInitialCommit: async (args) => ({
        seeded: true,
        sha: 'root0',
        baseBranch: args.baseBranch,
      }),
      pushBranch: async (args) =>
        args.branch === 'main'
          ? { pushed: false, reason: 'push_failed', detail: 'denied' }
          : { pushed: true },
    });
    const res = await initWs(
      {
        projectId: 'p1',
        intentId: 'i1',
        executionId: 'e1',
        repos: ['acme/empty'],
        branch: 'aidlc/i1',
        baseBranch: 'main',
        gitProvider: 'github',
      },
      d,
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('intent_branch_push_failed');
    expect(res.detail).toContain('base main');
  });

  it("FAILS when the push is still 'empty' after seeding (branch cannot be published)", async () => {
    const d = deps({
      seedInitialCommit: async () => ({ seeded: false, reason: 'not_empty' }),
      pushBranch: async () => ({ pushed: 'empty' }),
    });
    const res = await initWs(
      {
        projectId: 'p1',
        intentId: 'i1',
        executionId: 'e1',
        repos: ['acme/api'],
        branch: 'aidlc/i1',
        baseBranch: 'main',
        gitProvider: 'github',
      },
      d,
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('intent_branch_push_failed');
  });

  it('SKIPS the publish when the intent branch already exists remotely (rewind/retry re-init)', async () => {
    let pushCalls = 0;
    const d = deps({
      remoteBranchExists: async () => ({ exists: true }),
      pushBranch: async () => {
        pushCalls += 1;
        return { pushed: true };
      },
    });
    const res = await initWs(
      {
        projectId: 'p1',
        intentId: 'i1',
        executionId: 'e1',
        repos: ['acme/api'],
        branch: 'aidlc/i1',
        baseBranch: 'main',
        gitProvider: 'github',
      },
      d,
    );
    expect(res.ok).toBe(true);
    // Already established → no push attempted (avoids non-fast-forward failure).
    expect(pushCalls).toBe(0);
  });
});

describe('workspace checkout (mocked git runner)', () => {
  const noMkdir = async () => {};

  it('REUSES an existing checkout (warm session on rewind/retry): no clone, no init, still scrubbed', async () => {
    // Field incident: the rewind relaunch reuses the intent's runtimeSessionId,
    // so /mnt/workspace still holds the checkout. `git clone` refused the
    // non-empty dir, the git-init fallback flagged cloned:false, and init-ws
    // failed every retry with checkout_failed for a perfectly healthy tree.
    const cmds = [];
    const runner = async (command, args) => {
      cmds.push([command, ...args].join(' '));
      return { code: 0 };
    };
    const statFn = async (p) => {
      if (p.endsWith('/.git')) return { isDirectory: () => true, isFile: () => false };
      throw new Error('ENOENT');
    };
    const res = await checkoutRepo({
      repo: 'acme/api',
      branch: 'aidlc/x',
      baseBranch: 'main',
      targetDir: '/ws',
      runner,
      ensureDir: noMkdir,
      statFn,
    });
    expect(res).toMatchObject({ cloned: true, reused: true });
    expect(cmds.some((c) => c.startsWith('git clone'))).toBe(false);
    expect(cmds.some((c) => c.startsWith('git init'))).toBe(false);
    // Remote is still (re-)scrubbed and the intent branch ensured.
    expect(cmds[0]).toBe('git remote set-url origin https://github.com/acme/api.git');
    expect(cmds[1]).toBe('git checkout aidlc/x');
    // Nothing in the reuse path ever sees a credential.
    for (const c of cmds) expect(c).not.toContain(TEST_SECRET);
  });

  it('clones with askpass, keeps argv clean, then checks out the branch', async () => {
    const cmds = [];
    const environments = [];
    const runner = async (command, args, options = {}) => {
      cmds.push([command, ...args].join(' '));
      environments.push(options.env ?? {});
      return { code: 0 };
    };
    await checkoutRepo({
      repo: 'acme/api',
      branch: 'feat/x',
      baseBranch: 'main',
      targetDir: '/ws',
      runner,
      ensureDir: noMkdir,
    });
    expect(cmds[0]).toBe('git clone https://github.com/acme/api.git /ws');
    expect(environments[0]).toMatchObject({
      GIT_ASKPASS: '/tmp/test-askpass',
      AIDLC_GIT_PASSWORD: TEST_SECRET,
    });
    expect(cmds[1]).toBe('git remote set-url origin https://github.com/acme/api.git');
    expect(cmds[2]).toBe('git checkout feat/x');
    for (const c of cmds) expect(c).not.toContain(TEST_SECRET);
  });

  it('removes a stale origin pushurl from the durable git config', async () => {
    const cmds = [];
    const runner = async (command, args) => {
      cmds.push([command, ...args].join(' '));
      return { code: 0 };
    };
    await checkoutRepo({
      repo: 'acme/api',
      branch: 'feat/x',
      targetDir: '/ws',
      runner,
      ensureDir: noMkdir,
      readGitConfig: async () =>
        '[remote "origin"]\n\turl = https://github.com/acme/api.git\n\tpushurl = https://old@example.invalid/repo.git\n',
    });
    expect(cmds).toContain('git config --unset-all remote.origin.pushurl');
  });

  it('removes partial checkout state after clone failure without running git init', async () => {
    const cmds = [];
    const removed = [];
    const runner = async (command, args) => {
      cmds.push([command, ...args].join(' '));
      if (args[0] === 'clone') return { code: 128 };
      return { code: 0 };
    };
    const result = await checkoutRepo({
      repo: 'acme/new',
      branch: 'feat/x',
      targetDir: '/ws',
      runner,
      ensureDir: noMkdir,
      removeDir: async (dir) => removed.push(dir),
    });
    expect(result).toMatchObject({ cloned: false, branchOk: false });
    expect(cmds).toEqual(['git clone https://github.com/acme/new.git /ws']);
    expect(removed).toEqual(['/ws']);
    expect(cmds.some((command) => command.startsWith('git init'))).toBe(false);
  });

  it('scrubs with the provider-correct clean URL for gitlab', async () => {
    const cmds = [];
    const runner = async (command, args) => {
      cmds.push([command, ...args].join(' '));
      return { code: 0 };
    };
    await checkoutRepo({
      repo: 'group/proj',
      branch: 'b',
      gitProvider: 'gitlab',
      targetDir: '/ws',
      runner,
      ensureDir: noMkdir,
    });
    expect(cmds[1]).toBe('git remote set-url origin https://gitlab.com/group/proj.git');
  });

  it('uses a clean GitLab clone URL and supplies oauth2 through askpass', async () => {
    const cmds = [];
    const environments = [];
    const runner = async (command, args, options = {}) => {
      cmds.push([command, ...args].join(' '));
      environments.push(options.env ?? {});
      return { code: 0 };
    };
    await checkoutRepo({
      repo: 'group/proj',
      branch: 'feat/x',
      gitProvider: 'gitlab',
      targetDir: '/ws',
      runner,
      ensureDir: noMkdir,
    });
    expect(cmds[0]).toBe('git clone https://gitlab.com/group/proj.git /ws');
    expect(environments[0].AIDLC_GIT_USERNAME).toBe('oauth2');
    expect(environments[0].AIDLC_GIT_PASSWORD).toBe(TEST_SECRET);
  });

  it('defaults to a clean GitHub URL when gitProvider is omitted', async () => {
    const cmds = [];
    const runner = async (command, args) => {
      cmds.push([command, ...args].join(' '));
      return { code: 0 };
    };
    await checkoutRepo({
      repo: 'acme/api',
      targetDir: '/ws',
      runner,
      ensureDir: noMkdir,
    });
    expect(cmds[0]).toBe('git clone https://github.com/acme/api.git /ws');
  });

  it('creates the branch when checkout fails', async () => {
    const cmds = [];
    const runner = async (command, args) => {
      cmds.push(args.join(' '));
      return { code: args[0] === 'checkout' && args.length === 2 ? 1 : 0 };
    };
    await checkoutRepo({
      repo: 'a/b',
      branch: 'feat/y',
      targetDir: '/ws',
      runner,
      ensureDir: noMkdir,
    });
    expect(cmds.some((c) => c.startsWith('checkout -b feat/y'))).toBe(true);
  });

  it('cuts a NON-default base branch off the remote-tracking ref (origin/<base>), not the bare name', async () => {
    // Field bug: after a fresh clone, only the repo's DEFAULT branch has a
    // local ref — every other branch exists solely as `origin/<name>`.
    // `git checkout -b <branch> <base>` with the bare name silently fails for
    // any non-default base (no DWIM for the `-b <new> <start-point>` form),
    // which used to fall through to the orphan rung and silently divorce the
    // branch from the real base. `origin/<base>` must be tried FIRST.
    const cmds = [];
    const runner = async (command, args) => {
      cmds.push(args.join(' '));
      if (args[0] === 'checkout' && args[1] === 'aidlc/i1') return { code: 1 }; // rung 1: no local ref yet
      if (args.join(' ') === 'checkout -b aidlc/i1 origin/develop') return { code: 0 };
      if (args[0] === 'checkout') return { code: 1 }; // bare name / orphan must NOT be reached
      return { code: 0 }; // clone / remote set-url succeed
    };
    const res = await checkoutRepo({
      repo: 'acme/api',
      branch: 'aidlc/i1',
      baseBranch: 'develop',
      targetDir: '/ws',
      runner,
      ensureDir: noMkdir,
    });
    expect(res).toMatchObject({ cloned: true, branchOk: true });
    expect(cmds).toContain('checkout -b aidlc/i1 origin/develop');
    expect(cmds).not.toContain('checkout --orphan aidlc/i1');
  });

  it('falls back to the bare base name when origin/<base> does not resolve (caller already holds a local ref)', async () => {
    // e.g. a unit lane basing off the intent branch, which a prior checkout in
    // THIS workspace already created as a local branch (no `origin/` needed).
    const cmds = [];
    const runner = async (command, args) => {
      cmds.push(args.join(' '));
      if (args[0] === 'checkout' && args[1] === 'aidlc/i1--s0-unit-a') return { code: 1 };
      if (args.join(' ') === 'checkout -b aidlc/i1--s0-unit-a origin/aidlc/i1') return { code: 1 };
      if (args.join(' ') === 'checkout -b aidlc/i1--s0-unit-a aidlc/i1') return { code: 0 };
      if (args[0] === 'checkout') return { code: 1 };
      return { code: 0 }; // clone / remote set-url succeed
    };
    const res = await checkoutRepo({
      repo: 'acme/api',
      branch: 'aidlc/i1--s0-unit-a',
      baseBranch: 'aidlc/i1',
      targetDir: '/ws',
      runner,
      ensureDir: noMkdir,
    });
    expect(res).toMatchObject({ cloned: true, branchOk: true });
    expect(cmds).toContain('checkout -b aidlc/i1--s0-unit-a aidlc/i1');
  });

  it('branches off the clone HEAD (no base arg) when baseBranch is null — never assumes "main"', async () => {
    const cmds = [];
    const runner = async (command, args) => {
      cmds.push(args.join(' '));
      if (args.join(' ') === 'checkout aidlc/i1') return { code: 1 };
      if (args.join(' ') === 'checkout -b aidlc/i1') return { code: 0 };
      if (args[0] === 'checkout') return { code: 1 };
      return { code: 0 }; // clone / remote set-url succeed
    };
    const res = await checkoutRepo({
      repo: 'acme/api',
      branch: 'aidlc/i1',
      baseBranch: null,
      targetDir: '/ws',
      runner,
      ensureDir: noMkdir,
    });
    expect(res).toMatchObject({ cloned: true, branchOk: true });
    expect(cmds).toContain('checkout -b aidlc/i1');
  });

  it('falls back to an orphan branch for an EMPTY repo (clone ok, no base commit)', async () => {
    // Field incident: `git clone` of an empty repo exits 0, but
    // `git checkout -b <branch> main` fails ("'main' is not a commit") — the
    // run silently stayed on the unborn default branch. The orphan rung gives
    // the intent a real branch on the unborn HEAD. `rev-parse --verify HEAD`
    // failing is what proves the repo is genuinely empty (unborn HEAD) — the
    // gate that keeps a typo'd/deleted base from silently orphaning a repo
    // that actually has history.
    const cmds = [];
    const runner = async (command, args) => {
      cmds.push(args.join(' '));
      if (args[0] === 'checkout' && args[1] !== '--orphan') return { code: 1 };
      if (args[0] === 'rev-parse') return { code: 1 };
      return { code: 0 };
    };
    const res = await checkoutRepo({
      repo: 'acme/empty',
      branch: 'aidlc/i1',
      baseBranch: 'main',
      targetDir: '/ws',
      runner,
      ensureDir: noMkdir,
    });
    expect(res).toMatchObject({ cloned: true, branchOk: true });
    expect(cmds).toContain('checkout --orphan aidlc/i1');
  });

  it('reports branchOk:false when every branch rung fails (checkout, -b, --orphan)', async () => {
    // rev-parse succeeds (HEAD exists — the repo genuinely has history), so
    // the base-branch failure must NOT fall through to orphan (that would
    // silently divorce the branch from real history); it fails loudly.
    const runner = async (command, args) => ({ code: args[0] === 'checkout' ? 1 : 0 });
    const res = await checkoutRepo({
      repo: 'acme/broken',
      branch: 'aidlc/i1',
      baseBranch: 'main',
      targetDir: '/ws',
      runner,
      ensureDir: noMkdir,
    });
    expect(res).toMatchObject({ cloned: true, branchOk: false });
  });

  it('ensures the branch (with orphan fallback) on the warm-session reuse path too', async () => {
    const cmds = [];
    const runner = async (command, args) => {
      cmds.push(args.join(' '));
      if (args[0] === 'checkout' && args[1] !== '--orphan') return { code: 1 };
      if (args[0] === 'rev-parse') return { code: 1 };
      return { code: 0 };
    };
    const statFn = async (p) => {
      if (p.endsWith('/.git')) return { isDirectory: () => true, isFile: () => false };
      throw new Error('ENOENT');
    };
    const res = await checkoutRepo({
      repo: 'acme/empty',
      branch: 'aidlc/i1',
      baseBranch: 'main',
      targetDir: '/ws',
      runner,
      ensureDir: noMkdir,
      statFn,
    });
    expect(res).toMatchObject({ reused: true, branchOk: true });
    expect(cmds).toContain('checkout --orphan aidlc/i1');
  });

  it('lays multi-repo out under <ws>/<owner>/<repo>', async () => {
    const targets = [];
    const runner = async (command, args) => {
      if (args[0] === 'clone') targets.push(args[2]);
      return { code: 0 };
    };
    await checkoutRepos({
      repos: ['acme/api', 'acme/web'],
      branch: 'b',
      workspaceDir: '/ws',
      runner,
      ensureDir: noMkdir,
    });
    expect(targets).toEqual(['/ws/acme/api', '/ws/acme/web']);
  });

  it('threads gitProvider through to each clean repo clone URL', async () => {
    const cloneUrls = [];
    const runner = async (command, args) => {
      if (args[0] === 'clone') cloneUrls.push(args[1]);
      return { code: 0 };
    };
    await checkoutRepos({
      repos: ['group/api', 'group/web'],
      branch: 'b',
      gitProvider: 'gitlab',
      workspaceDir: '/ws',
      runner,
      ensureDir: noMkdir,
    });
    expect(cloneUrls).toEqual([
      'https://gitlab.com/group/api.git',
      'https://gitlab.com/group/web.git',
    ]);
  });

  it('resolves each repo base branch from the per-repo baseBranches map, falling back to the legacy single baseBranch', async () => {
    // acme/api overrides to 'develop' via the map; acme/web has no override
    // and falls back to the legacy `baseBranch` string.
    const basesUsed = [];
    const runner = async (command, args) => {
      if (args[0] === 'checkout' && args.length === 2) return { code: 1 }; // rung 1: no local ref yet
      if (args[0] === 'checkout' && args[1] === '-b') basesUsed.push(args[3] ?? null);
      return { code: 0 };
    };
    await checkoutRepos({
      repos: ['acme/api', 'acme/web'],
      branch: 'aidlc/i1',
      baseBranch: 'main',
      baseBranches: { 'acme/api': 'develop' },
      workspaceDir: '/ws',
      runner,
      ensureDir: noMkdir,
    });
    expect(basesUsed).toEqual(['origin/develop', 'origin/main']);
  });

  it('falls back to null (branch off clone HEAD) when a repo is absent from both baseBranches and the legacy baseBranch', async () => {
    const basesUsed = [];
    const runner = async (command, args) => {
      if (args[0] === 'checkout' && args.length === 2) return { code: 1 }; // rung 1: no local ref yet
      if (args[0] === 'checkout' && args[1] === '-b') basesUsed.push(args[3] ?? null);
      return { code: 0 };
    };
    await checkoutRepos({
      repos: ['acme/docs'],
      branch: 'aidlc/i1',
      workspaceDir: '/ws',
      runner,
      ensureDir: noMkdir,
    });
    expect(basesUsed).toEqual([null]);
  });
});

describe('ensureWorkspaceSource (self-heal a wiped checkout)', () => {
  const noMkdir = async () => {};
  // A stat that reports `.git` present for the given set of target dirs.
  const statFor = (presentDirs) => async (p) => {
    const dir = p.replace(/\/\.git$/, '');
    if (presentDirs.includes(dir)) return { isDirectory: () => true, isFile: () => false };
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  };
  const cloneRunner = () => {
    const targets = [];
    const runner = async (command, args) => {
      if (args[0] === 'clone') targets.push(args[2]);
      return { code: 0 };
    };
    return { targets, runner };
  };

  it('re-clones when the single-repo checkout is missing', async () => {
    const { targets, runner } = cloneRunner();
    const res = await ensureWorkspaceSource({
      repos: ['acme/api'],
      branch: 'b',
      workspaceDir: '/ws',
      runner,
      ensureDir: noMkdir,
      statFn: statFor([]), // nothing present → wiped
    });
    expect(res).toMatchObject({ restored: true, repos: ['acme/api'], failed: [] });
    expect(targets).toEqual(['/ws']);
  });

  it('is a no-op when the checkout is already present', async () => {
    const { targets, runner } = cloneRunner();
    const res = await ensureWorkspaceSource({
      repos: ['acme/api'],
      workspaceDir: '/ws',
      runner,
      ensureDir: noMkdir,
      statFn: statFor(['/ws']), // .git present
    });
    expect(res.restored).toBe(false);
    expect(targets).toEqual([]);
  });

  it('is a no-op for a repo-less project (empty repos)', async () => {
    const { targets, runner } = cloneRunner();
    const res = await ensureWorkspaceSource({
      repos: [],
      workspaceDir: '/ws',
      runner,
      ensureDir: noMkdir,
      statFn: statFor([]),
    });
    expect(res).toMatchObject({ restored: false, repos: [], failed: [] });
    expect(targets).toEqual([]);
  });

  it('only re-clones the missing repo in a multi-repo layout', async () => {
    const { targets, runner } = cloneRunner();
    const res = await ensureWorkspaceSource({
      repos: ['acme/api', 'acme/web'],
      workspaceDir: '/ws',
      runner,
      ensureDir: noMkdir,
      statFn: statFor(['/ws/acme/api']), // api present, web wiped
    });
    expect(res.restored).toBe(true);
    expect(res.repos).toEqual(['acme/web']);
    expect(targets).toEqual(['/ws/acme/web']);
  });

  it('resolves the re-cloned repo base branch from the per-repo baseBranches map', async () => {
    const basesUsed = [];
    const runner = async (command, args) => {
      if (args[0] === 'checkout' && args.length === 2) return { code: 1 }; // rung 1: fresh clone
      if (args[0] === 'checkout' && args[1] === '-b') basesUsed.push(args[3] ?? null);
      return { code: 0 };
    };
    const res = await ensureWorkspaceSource({
      repos: ['acme/api', 'acme/web'],
      branch: 'aidlc/i1',
      baseBranch: 'main',
      baseBranches: { 'acme/web': 'release' },
      workspaceDir: '/ws',
      runner,
      ensureDir: noMkdir,
      statFn: statFor([]), // both wiped
    });
    expect(res.failed).toEqual([]);
    expect(basesUsed).toEqual(['origin/main', 'origin/release']);
  });

  it('reports a repo that could not be re-cloned as failed', async () => {
    // clone exits non-zero and no local repository is initialized.
    const runner = async (command, args) => ({ code: args[0] === 'clone' ? 1 : 0 });
    const res = await ensureWorkspaceSource({
      repos: ['acme/api'],
      workspaceDir: '/ws',
      runner,
      ensureDir: noMkdir,
      statFn: statFor([]),
    });
    expect(res).toMatchObject({ restored: true, repos: ['acme/api'], failed: ['acme/api'] });
  });

  it('reports a restored repo whose branch setup failed as failed', async () => {
    // Clone ok but no branch rung landed — the CLI would run on the wrong branch.
    const runner = async (command, args) => ({ code: args[0] === 'checkout' ? 1 : 0 });
    const res = await ensureWorkspaceSource({
      repos: ['acme/api'],
      branch: 'aidlc/i1',
      baseBranch: 'main',
      workspaceDir: '/ws',
      runner,
      ensureDir: noMkdir,
      statFn: statFor([]),
    });
    expect(res).toMatchObject({ restored: true, repos: ['acme/api'], failed: ['acme/api'] });
  });
});
