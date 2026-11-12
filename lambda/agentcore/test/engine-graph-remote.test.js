// Remote mode end to end: engine commands run with the runtime's graph access
// pointed at engine-data (in process: JSON both ways → the real graph gateway →
// the real gremlin-server) under signed grants read from the invocation, and
// with the direct Neptune opener replaced by the tripwire. Any command path
// that still opens its own connection fails the test instead of passing on the
// runtime role.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import gremlin from 'gremlin';
import { PartitionStrategy } from 'gremlin/lib/process/traversal-strategy.js';
import { issueGatewayGrant, verifyGatewayGrant } from '../../shared/gateway-grant.js';
import { createGraphManager } from '../../shared/mcp/graph-manager.js';
import { createGraphWriter } from '../../shared/mcp/graph-writer.js';
import { createGraphGateway } from '../../engine-data/graph-gateway.js';
import { createRemoteGraphAccess, directGraphTripwire } from '../engine-data-client.js';
import { currentGatewayGrant, runWithGatewayGrant } from '../mcp/gateway-context.js';
import { initWs } from '../commands/init-ws.js';
import { inspect } from '../commands/inspect.js';
import { recordPr } from '../commands/record-pr.js';
import { recordUnitPr } from '../commands/record-unit-pr.js';
import { recordLearning } from '../commands/record-learning.js';
import { promoteUnits } from '../commands/promote-units.js';
import { deriveArtifacts } from '../commands/derive-artifacts.js';
import { createWorkflowCheckpoint } from '../commands/create-workflow-checkpoint.js';
import { createDiscussionAssistStart } from '../commands/discussion-assist-start.js';
import { createQuorumEditApplyStart } from '../commands/quorum-edit-apply-start.js';
import { ingestStageCodeTraceability } from '../code-traceability.js';
import { compileContextPack } from '../context-compiler.js';
import { stageInstanceId as planStageInstanceId } from '../../shared/v2-execution-plan.js';

const NOW = Date.parse('2026-10-19T12:00:00.000Z');
const CLOCK = () => '2026-10-19T12:00:00.000Z';
const KID = 'kid-1';
const P = 'p-remote';
const I = 'i-remote';
const OTHER = 'i-foreign';
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const grantFor = (scope) =>
  issueGatewayGrant(scope, {
    keyId: KID,
    sign: async (m) => cryptoSign('sha256', m, privateKey),
    now: () => NOW,
    randomId: () => 'grant-1',
  });
const verifyGrant = (token) =>
  verifyGatewayGrant(token, {
    publicKeyFor: async (kid) => (kid === KID ? publicKey : null),
    now: () => NOW + 1000,
  });

const EXECUTION = { mode: 'execution', projectId: P, intentId: I, executionId: I };
// Instance ids as run-stage derives them, so stage grants resolve to them.
const PIN = { workflowId: 'aidlc-v2', workflowVersion: 1 };
const SI_STORIES = planStageInstanceId('aidlc-v2@1', 'user-stories');
const SI_CODE = planStageInstanceId('aidlc-v2@1', 'code-generation', 'auth', 0);
const STAGES = {
  [SI_STORIES]: { executionId: I, stageInstanceId: SI_STORIES, stageId: 'user-stories' },
  'si-units': { executionId: I, stageInstanceId: 'si-units', stageId: 'units-generation' },
  [SI_CODE]: {
    executionId: I,
    stageInstanceId: SI_CODE,
    stageId: 'code-generation',
    sectionIndex: 0,
    unitSlug: 'auth',
  },
  'si-stories-auth': {
    executionId: I,
    stageInstanceId: 'si-stories-auth',
    stageId: 'user-stories',
    sectionIndex: 0,
    unitSlug: 'auth',
  },
  'si-stories-catalog': {
    executionId: I,
    stageInstanceId: 'si-stories-catalog',
    stageId: 'user-stories',
    sectionIndex: 0,
    unitSlug: 'catalog',
  },
};
// engine-data's own view of the process table.
const engineDataStore = {
  getExecution: async (id) =>
    id === I ? { executionId: I, projectId: P, intentId: I, ...PIN } : null,
  getStage: async (e, s) => (e === I ? (STAGES[s] ?? null) : null),
  getUnit: async (e, section, slug) =>
    e === I && section === 0 && ['auth', 'catalog', 'checkout'].includes(slug)
      ? { executionId: e }
      : null,
  getQuorumEdit: async (e, editId) => (e === I && editId === 'qe-1' ? { executionId: e } : null),
  getHumanTask: async (e, id) =>
    e === I && id === 'gate-1'
      ? {
          executionId: e,
          stageInstanceId: 'si-units',
          loopBackTarget: 'user-stories',
          status: 'rejected',
          answer: { decision: 'loop-back' },
        }
      : null,
};

const DAG_BODY = [
  '# Unit of Work Dependency',
  '',
  '```yaml',
  'units:',
  '  - name: auth',
  '    depends_on: []',
  '  - name: catalog',
  '    depends_on: []',
  '  - name: checkout',
  '    depends_on: [auth, catalog]',
  '```',
  '',
].join('\n');
const STORIES_BODY = [
  '## Stories',
  '',
  '```yaml',
  'stories:',
  '  - id: s1',
  '    title: Sign in',
  '```',
].join('\n');

let conn;
let g;
const ops = [];
const exchanges = [];
let openGraph;
let openEngineGraph;

const asJson = (value) => JSON.parse(JSON.stringify(value ?? null));

beforeAll(async () => {
  conn = new gremlin.driver.DriverRemoteConnection(
    `ws://${process.env.NEPTUNE_ENDPOINT}:${process.env.GREMLIN_PORT}/gremlin`,
  );
  g = gremlin.process.AnonymousTraversalSource.traversal()
    .withRemote(conn)
    .withStrategies(
      new PartitionStrategy({
        partitionKey: '_partition',
        writePartition: 'agentcore-engine-graph-remote',
        readPartitions: ['agentcore-engine-graph-remote'],
      }),
    );
  await g.V().drop().next();
  // A sibling intent of the same project in the same partition: only the
  // gateway's checks, not partition isolation, keep it out of reach.
  await g.addV('Intent').property('id', OTHER).property('project_id', P).next();
  await createGraphWriter({
    g,
    scope: { projectId: P, intentId: OTHER, executionId: OTHER, stageInstanceId: 'si-x' },
    clock: CLOCK,
  }).createArtifact({ artifactType: 'stories', id: 'foreign-stories', content: STORIES_BODY });

  const manager = createGraphManager({
    openGraph: async () => g,
    closeGraphSource: async () => {},
  });
  const handler = createGraphGateway({
    verifyGrant,
    createStore: () => engineDataStore,
    withGraph: manager.withGraph,
    clock: CLOCK,
  });
  const invoke = async (event) => {
    ops.push(event.op);
    const response = asJson(await handler(asJson(event)));
    exchanges.push({ op: event.op, input: event.args?.[1] ?? null, response });
    return response;
  };
  openEngineGraph = createRemoteGraphAccess({ invoke, grant: currentGatewayGrant });
  openGraph = vi.fn(directGraphTripwire());
});

afterAll(async () => {
  await conn?.close();
});

const granted = async (scope, fn) => runWithGatewayGrant(await grantFor(scope), fn);
const opsDuring = async (fn) => {
  ops.length = 0;
  const result = await fn();
  return { result, ops: [...ops] };
};
const recordingStore = (methods = {}) => ({
  appendEvent: vi.fn(async () => ({})),
  recordMetric: vi.fn(async () => ({})),
  ...methods,
});
const remoteDeps = (extra = {}) => ({ openGraph, openEngineGraph, ...extra });

describe('engine commands in remote mode', () => {
  it('init-ws creates the Intent anchor through engine-data', async () => {
    const store = recordingStore({ createExecution: vi.fn(async () => ({})) });
    const { result, ops: called } = await opsDuring(() =>
      granted(EXECUTION, () =>
        initWs(
          { projectId: P, intentId: I, executionId: I, repos: [], title: 'Remote intent' },
          remoteDeps({
            store,
            checkoutRepos: async () => [],
            workspaceDir: '/tmp/ws-remote',
            clock: CLOCK,
            remoteBranchExists: async () => ({ exists: false }),
            pushBranch: async () => ({ pushed: true }),
            seedInitialCommit: async () => ({ seeded: false }),
            resolveDefaultBranch: async () => 'main',
          }),
        ),
      ),
    );
    expect(result).toMatchObject({ ok: true, intentId: I });
    expect(called).toEqual(['graph.ensureIntent']);
    const anchor = await g.V().has('Intent', 'id', I).values('project_id').toList();
    expect(anchor).toEqual([P]);
  });

  it('promote-units reads the DAG and mirrors the units', async () => {
    await createGraphWriter({
      g,
      scope: { projectId: P, intentId: I, executionId: I, stageInstanceId: 'si-units' },
      clock: CLOCK,
    }).createArtifact({ artifactType: 'unit-of-work-dependency', id: 'dag-1', content: DAG_BODY });
    const store = recordingStore({
      getUnitPlan: vi.fn(async () => null),
      putUnitPlan: vi.fn(async (plan) => plan),
      syncUnitRows: vi.fn(async () => ({ created: [], updated: [], preserved: [], orphaned: [] })),
    });
    const { result, ops: called } = await opsDuring(() =>
      granted(EXECUTION, () =>
        promoteUnits(
          { projectId: P, intentId: I, executionId: I, stageInstanceId: 'si-units' },
          remoteDeps({ store }),
        ),
      ),
    );
    expect(result).toMatchObject({ ok: true });
    expect(called).toEqual([
      'graph.lookupArtifacts',
      'graph.mirrorUnitDag',
      'graph.resolveDerivedItemEdges',
    ]);
    expect(store.appendEvent.mock.calls.map(([e]) => e.type)).not.toContain(
      'v2.units.mirror_failed',
    );
    const units = await g.V().hasLabel('UnitOfWork').has('intent_id', I).values('slug').toList();
    expect(units.toSorted()).toEqual(['auth', 'catalog', 'checkout']);
  });

  it('derive-artifacts mirrors only this intent’s stage artifacts', async () => {
    await createGraphWriter({
      g,
      scope: { projectId: P, intentId: I, executionId: I, stageInstanceId: SI_STORIES },
      clock: CLOCK,
    }).createArtifact({ artifactType: 'stories', id: 'stories-1', content: STORIES_BODY });
    const store = recordingStore();
    const { result, ops: called } = await opsDuring(() =>
      granted(EXECUTION, () =>
        deriveArtifacts(
          { projectId: P, intentId: I, executionId: I, stageInstanceId: SI_STORIES },
          remoteDeps({ store }),
        ),
      ),
    );
    expect(result).toMatchObject({ ok: true, artifacts: ['stories-1'], items: 1, errors: [] });
    expect(called).toEqual([
      'graph.getIntentGraph',
      'graph.getArtifactContent',
      'graph.mirrorArtifactDerivations',
      'graph.resolveDerivedItemEdges',
    ]);
    const foreignItems = await g.V().has('intent_id', OTHER).hasLabel('Story').count().next();
    expect(foreignItems.value).toBe(0);
  });

  it('derives same-id artifacts of two unit lanes, locally and through engine-data', async () => {
    const laneBody = (title) => STORIES_BODY.replace('Sign in', title);
    const writeLane = (stageInstanceId, unitSlug, title) =>
      createGraphWriter({
        g,
        scope: {
          projectId: P,
          intentId: I,
          executionId: I,
          stageInstanceId,
          sectionIndex: 0,
          unitSlug,
        },
        clock: CLOCK,
      }).createArtifact({ artifactType: 'stories', id: 'lane-stories', content: laneBody(title) });
    await writeLane('si-stories-auth', 'auth', 'Auth story');
    await writeLane('si-stories-catalog', 'catalog', 'Catalog story');
    const heads = await g
      .V()
      .has('Artifact', 'id', 'lane-stories')
      .has('intent_id', I)
      .count()
      .next();
    expect(heads.value).toBe(2);

    const derive = (stageInstanceId, deps) =>
      deriveArtifacts({ projectId: P, intentId: I, executionId: I, stageInstanceId }, deps);
    for (const stageInstanceId of ['si-stories-auth', 'si-stories-catalog']) {
      const local = await derive(stageInstanceId, {
        store: recordingStore(),
        openGraph: async () => g,
      });
      expect(local, `local ${stageInstanceId}`).toMatchObject({
        ok: true,
        artifacts: ['lane-stories'],
        errors: [],
      });
      const { result: viaEngineData, ops: called } = await opsDuring(() =>
        granted(EXECUTION, () => derive(stageInstanceId, remoteDeps({ store: recordingStore() }))),
      );
      expect(viaEngineData, `remote ${stageInstanceId}`).toMatchObject({
        ok: true,
        artifacts: ['lane-stories'],
        errors: [],
      });
      expect(called).toContain('graph.mirrorArtifactDerivations');
    }
  });

  it('derive-artifacts never asks engine-data for the whole intent with bodies', async () => {
    exchanges.length = 0;
    await granted(EXECUTION, () =>
      deriveArtifacts(
        { projectId: P, intentId: I, executionId: I, stageInstanceId: 'si-stories-auth' },
        remoteDeps({ store: recordingStore() }),
      ),
    );
    const listings = exchanges.filter(({ op }) => op === 'graph.getIntentGraph');
    expect(listings.length).toBeGreaterThan(0);
    for (const { input, response } of listings) {
      expect(input.includeContent).toBeFalsy();
      expect(response.result.some((row) => Object.hasOwn(row, 'content'))).toBe(false);
    }
    const bodies = exchanges.filter(({ op }) => op === 'graph.getArtifactContent');
    expect(bodies.map(({ response }) => response.result.content)).toEqual([
      STORIES_BODY.replace('Sign in', 'Auth story'),
    ]);
  });

  it('the context compiler and graph sensors read through the same writer shape', async () => {
    const { result, ops: called } = await opsDuring(() =>
      granted({ ...EXECUTION, mode: 'stage', stageId: 'user-stories' }, async () => {
        const graph = await openEngineGraph({
          projectId: P,
          intentId: I,
          executionId: I,
          stageInstanceId: SI_STORIES,
        });
        return compileContextPack({
          graph,
          stage: { stageId: 'design', inputArtifacts: [{ artifact: 'stories' }] },
          unit: null,
        });
      }),
    );
    expect(result.markdown).toContain('stories-1');
    expect(called.every((op) => op.startsWith('graph.'))).toBe(true);
    expect(called).toContain('graph.lookupArtifacts');
  });

  it('records intent and unit PRs, forwarding only the fields the graph accepts', async () => {
    const store = recordingStore();
    const pr = await opsDuring(() =>
      granted(EXECUTION, () =>
        recordPr(
          {
            projectId: P,
            intentId: I,
            executionId: I,
            prs: [
              {
                repoId: 'acme/api',
                prUrl: 'https://example.test/pr/7',
                prNumber: 7,
                branch: 'aidlc/i',
                baseBranch: 'main',
                provider: 'github',
                title: 'not a graph field',
              },
            ],
          },
          remoteDeps({ store }),
        ),
      ),
    );
    expect(pr.result).toMatchObject({ ok: true });
    expect(pr.ops).toEqual(['graph.recordPullRequest']);

    const unit = await opsDuring(() =>
      granted(EXECUTION, () =>
        recordUnitPr(
          {
            projectId: P,
            intentId: I,
            executionId: I,
            unitPrs: [
              {
                sectionIndex: 0,
                unitSlug: 'auth',
                repoId: 'acme/api',
                provider: 'github',
                prNumber: 8,
                sourceBranch: 'aidlc/i/auth',
                targetBranch: 'aidlc/i',
                unitKey: 'not a graph field',
              },
            ],
          },
          remoteDeps({ store }),
        ),
      ),
    );
    expect(unit.result).toMatchObject({ ok: true });
    expect(unit.ops).toEqual(['graph.recordUnitPullRequest']);
  });

  it('records a gate learning into the project rules', async () => {
    const store = recordingStore();
    const { result, ops: called } = await opsDuring(() =>
      granted(EXECUTION, () =>
        recordLearning(
          {
            projectId: P,
            intentId: I,
            executionId: I,
            stageInstanceId: SI_STORIES,
            stageId: 'user-stories',
            learnings: 'Always name the auth provider in stories.',
            recordedByName: 'Ada',
          },
          remoteDeps({ store }),
        ),
      ),
    );
    expect(result).toMatchObject({ ok: true });
    expect(called).toEqual(['graph.recordLearningRule']);
  });

  it('projects stage code files with traceability evidence', async () => {
    const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const root = await mkdtemp(path.join(tmpdir(), 'trace-remote-'));
    await mkdir(path.join(root, 'src'), { recursive: true });
    await writeFile(path.join(root, 'src/auth.ts'), 'export const a = 1;\n');
    const { result, ops: called } = await opsDuring(() =>
      granted(
        {
          ...EXECUTION,
          mode: 'stage',
          stageId: 'code-generation',
          unitSlug: 'auth',
          sectionIndex: 0,
        },
        () =>
          ingestStageCodeTraceability({
            openGraph,
            openEngineGraph,
            scope: {
              projectId: P,
              intentId: I,
              executionId: I,
              stageInstanceId: SI_CODE,
              sectionIndex: 0,
              unitSlug: 'auth',
            },
            gitResult: {
              ok: true,
              committed: true,
              results: [
                {
                  repo: 'acme/api',
                  committed: true,
                  pushed: true,
                  sha: 'a'.repeat(40),
                  files: ['src/auth.ts'],
                },
              ],
            },
            repos: ['acme/api'],
            workspaceDir: root,
            stageId: 'code-generation',
            stageInstanceId: SI_CODE,
            unitSlug: 'auth',
          }),
      ),
    );
    expect(called).toEqual(['graph.ingestCodeFiles']);
    expect(result).toMatchObject({ batches: 1, codeFiles: 1 });
  });

  it('create-workflow-checkpoint snapshots the heads through engine-data', async () => {
    const putWorkflowCheckpoint = vi.fn(async (checkpoint) => checkpoint);
    const { result, ops: called } = await opsDuring(() =>
      granted(EXECUTION, () =>
        createWorkflowCheckpoint(
          { projectId: P, intentId: I, executionId: I, orchestratorRunId: 'run-1' },
          remoteDeps({
            store: {
              getExecutionRecords: async () => ({
                meta: { executionId: I, projectId: P, customRules: [] },
                stages: [],
                humanTasks: [],
                units: [],
              }),
              putWorkflowCheckpoint,
            },
            s3: { send: vi.fn() },
            bucket: 'artifacts',
            clock: CLOCK,
          }),
        ),
      ),
    );
    expect(result).toMatchObject({ ok: true });
    expect(result.artifactCount).toBeGreaterThanOrEqual(2);
    expect(called).toEqual(['graph.snapshotCurrentArtifactHeads']);
    const refs = putWorkflowCheckpoint.mock.calls[0][0].artifactRefs.map((ref) => ref.artifactId);
    expect(refs).not.toContain('foreign-stories');
  });

  it('inspect reads remotely and refuses partition maintenance before any graph access', async () => {
    const read = await opsDuring(() =>
      granted(EXECUTION, () =>
        inspect({ intentId: I, artifactId: 'stories-1' }, remoteDeps({ engineData: true })),
      ),
    );
    expect(read.result).toMatchObject({ ok: true, intentId: I });
    expect(read.result.artifact?.id).toBe('stories-1');
    expect(read.ops).toEqual(['graph.inspect']);

    for (const flags of [{ cleanup: true }, { cleanup: true, apply: false }, { drop: true }]) {
      const refused = await opsDuring(() =>
        granted(EXECUTION, () =>
          inspect({ intentId: I, ...flags }, remoteDeps({ engineData: true })),
        ),
      );
      expect(refused.result).toEqual({ ok: false, reason: 'maintenance_not_supported' });
      expect(refused.ops).toEqual([]);
    }
  });

  it('a call for another intent is denied server-side, not answered', async () => {
    const result = await granted(EXECUTION, async () => {
      const graph = await openEngineGraph({ projectId: P, intentId: OTHER, executionId: OTHER });
      return graph.lookupArtifacts({ artifactType: 'stories' }).catch((error) => error);
    });
    expect(result).toMatchObject({ name: 'EngineDataAccessDenied', code: 'scope_mismatch' });
  });

  it('discussion assist reads context and completes its message under a discussion grant', async () => {
    await g
      .addV('Discussion')
      .property('id', 'd-1')
      .property('intent_id', I)
      .property('entity_type', 'intent')
      .property('entity_title', 'Remote intent')
      .next();
    const message = (id, props) => {
      let t = g.addV('DiscussionMessage').property('id', id);
      for (const [k, v] of Object.entries({ intent_id: I, discussion_id: 'd-1', ...props })) {
        t = t.property(k, v);
      }
      return t.next();
    };
    await message('m-1', {
      content: 'What is the auth plan?',
      author_type: 'user',
      created_at: '1',
    });
    await message('m-2', {
      content: '',
      author_type: 'agent',
      request_id: 'req-1',
      assist_status: 'pending',
      created_at: '2',
    });
    for (const id of ['m-1', 'm-2']) {
      await g
        .V()
        .has('Discussion', 'id', 'd-1')
        .addE('HAS_MESSAGE')
        .to(gremlin.process.statics.V().has('DiscussionMessage', 'id', id))
        .next();
    }
    const broadcast = vi.fn(async () => {});
    const oneShot = vi.fn(async () => ({ ok: true, text: 'Use the IdP.' }));
    const start = createDiscussionAssistStart({
      ...remoteDeps(),
      store: { getExecution: async () => ({ agentCli: 'claude' }) },
      broadcast,
      availableClis: ['claude'],
      oneShot,
      materializeCliContextFn: async () => ({}),
    });
    ops.length = 0;
    await granted({ mode: 'discussion', projectId: P, intentId: I }, () =>
      start({
        projectId: P,
        intentId: I,
        discussionId: 'd-1',
        messageId: 'm-2',
        requestId: 'req-1',
        assistCommand: 'ask',
      }),
    );
    await vi.waitFor(() => expect(broadcast).toHaveBeenCalled(), { timeout: 10_000 });
    expect(ops).toEqual(['graph.readDiscussionContext', 'graph.completeDiscussionAssist']);
    expect(oneShot.mock.calls[0][0].prompt).toContain('What is the auth plan?');
    expect(broadcast.mock.calls[0][0].message).toMatchObject({
      id: 'm-2',
      content: 'Use the IdP.',
      assistStatus: 'completed',
    });
  });

  it('quorum apply edits, marks the closure stale and re-derives through engine-data', async () => {
    const sendCallbackSuccess = vi.fn(async () => ({ delivered: true }));
    const rederive = vi.fn(async () => ({ ok: true }));
    const start = createQuorumEditApplyStart({
      ...remoteDeps(),
      store: recordingStore({
        getQuorumEdit: async () => ({ plan: { items: [] } }),
        appendOutput: vi.fn(async () => ({})),
      }),
      oneShot: async () => ({ ok: true, text: `${STORIES_BODY}\n\nSign-in uses the IdP.\n` }),
      deriveArtifacts: rederive,
      sendCallbackSuccess,
    });
    ops.length = 0;
    await granted(EXECUTION, () =>
      start({
        projectId: P,
        intentId: I,
        executionId: I,
        editId: 'qe-1',
        artifactId: 'stories-1',
        changeDescription: 'Name the IdP',
        callbackId: 'cb-1',
      }),
    );
    await vi.waitFor(() => expect(sendCallbackSuccess).toHaveBeenCalled(), {
      timeout: 10_000,
    });
    expect(sendCallbackSuccess.mock.calls[0][1]).toMatchObject({ ok: true });
    expect(ops).toEqual([
      'graph.getArtifactForEdit',
      'graph.applyArtifactEdit',
      'graph.fetchDownstreamClosure',
      'graph.markArtifactsStale',
    ]);
    const content = await g.V().has('Artifact', 'id', 'stories-1').values('content').next();
    expect(content.value).toContain('Sign-in uses the IdP.');
    expect(rederive).toHaveBeenCalledWith(expect.objectContaining({ artifactTypes: ['stories'] }));
  });

  it('serves the run-stage graph paths under a stage grant', async () => {
    const STAGE_GRANT = { ...EXECUTION, mode: 'stage', stageId: 'user-stories' };
    const { result, ops: called } = await opsDuring(() =>
      granted(STAGE_GRANT, async () => {
        const memory = await openEngineGraph({ projectId: P, intentId: I, executionId: I });
        const knowledge = await memory.getTeamKnowledge({ agentRef: 'aidlc-product-agent' });
        const rules = await memory.getLearningRules({});
        const heads = await memory.readCurrentArtifactHeadHashes({});
        const coverage = await memory.getCoverage({});
        const stage = await openEngineGraph({
          projectId: P,
          intentId: I,
          executionId: I,
          stageInstanceId: SI_STORIES,
        });
        const gap = await stage.recordContributionGap({
          agentRef: 'aidlc-quality-agent',
          reason: 'session exited without evidence',
        });
        await stage.linkSteeringInfluences({ steerIds: [], stageInstanceId: SI_STORIES });
        const archived = await memory.archiveArtifactsForStages({
          stageInstanceIds: [SI_STORIES],
          restartId: 'loopback-gate-1',
          reason: 'Loop-back to user-stories: tests fail',
          actor: 'Ada',
        });
        return { knowledge, rules, heads, coverage, gap, archived };
      }),
    );
    expect(called).toEqual([
      'graph.getTeamKnowledge',
      'graph.getLearningRules',
      'graph.readCurrentArtifactHeadHashes',
      'graph.getCoverage',
      'graph.recordContributionGap',
      'graph.linkSteeringInfluences',
      'graph.archiveArtifactsForStages',
    ]);
    expect(result.rules.map((rule) => rule.content)).toContain(
      'Always name the auth provider in stories.',
    );
    const headIds = result.heads.map((head) => head.artifactId);
    expect(headIds).toContain('stories-1');
    expect(headIds).not.toContain('foreign-stories');
    expect(result.gap).toMatchObject({ id: 'contribution-user-stories-aidlc-quality-agent' });
  });

  it('never opened a direct graph connection', () => {
    expect(openGraph).not.toHaveBeenCalled();
  });
});
