import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import gremlin from 'gremlin';
import { PartitionStrategy } from 'gremlin/lib/process/traversal-strategy.js';
import { initWs, ensureIntentVertex } from '../commands/init-ws.js';
import { checkoutRepos, checkoutRepo } from '../workspace.js';

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
      repos.map((r) => ({ repo: typeof r === 'string' ? r : r.url })),
    workspaceDir: '/tmp/ws',
    clock: () => 'T',
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
});

describe('workspace checkout (mocked git runner)', () => {
  const noMkdir = async () => {};

  it('clones then checks out the branch for a single repo', async () => {
    const cmds = [];
    const runner = async (command, args) => {
      cmds.push([command, ...args].join(' '));
      return { code: 0 };
    };
    await checkoutRepo({
      repo: 'acme/api',
      branch: 'feat/x',
      baseBranch: 'main',
      gitToken: 'tok',
      targetDir: '/ws',
      runner,
      ensureDir: noMkdir,
    });
    expect(cmds[0]).toContain('git clone https://x-access-token:tok@github.com/acme/api.git /ws');
    expect(cmds[1]).toBe('git checkout feat/x');
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

  it('lays multi-repo out under <ws>/<owner>/<repo>', async () => {
    const targets = [];
    const runner = async (command, args) => {
      if (args[0] === 'clone') targets.push(args[2]);
      return { code: 0 };
    };
    await checkoutRepos({
      repos: ['acme/api', 'acme/web'],
      branch: 'b',
      gitToken: 't',
      workspaceDir: '/ws',
      runner,
      ensureDir: noMkdir,
    });
    expect(targets).toEqual(['/ws/acme/api', '/ws/acme/web']);
  });
});
