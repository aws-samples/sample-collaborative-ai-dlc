import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import gremlin from 'gremlin';
import { PartitionStrategy } from 'gremlin/lib/process/traversal-strategy.js';
import { issueGatewayGrant, verifyGatewayGrant } from '../../shared/gateway-grant.js';
import {
  ENGINE_DATA_GRAPH_DISCUSSION_OPS,
  ENGINE_DATA_GRAPH_OPS,
  ENGINE_DATA_STORE_METHODS,
  engineDataGraphOp,
} from '../../shared/engine-data-ops.js';
import { createEngineGraphOps } from '../../shared/engine-graph-ops.js';
import { createGraphManager } from '../../shared/mcp/graph-manager.js';
import { createGraphWriter } from '../../shared/mcp/graph-writer.js';
import { GRAPH_OPS } from '../graph-schemas.js';
import { createGraphGateway } from '../graph-gateway.js';

const NOW = Date.parse('2026-10-18T12:00:00.000Z');
const KID = 'kid-1';
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const grantFor = (scope, { ttlSeconds } = {}) =>
  issueGatewayGrant(scope, {
    keyId: KID,
    sign: async (m) => cryptoSign('sha256', m, privateKey),
    now: () => NOW,
    randomId: () => 'grant-1',
    ...(ttlSeconds ? { ttlSeconds } : {}),
  });
let verifyAt = NOW + 1000;
const verifyGrant = (token) =>
  verifyGatewayGrant(token, {
    publicKeyFor: async (kid) => (kid === KID ? publicKey : null),
    now: () => verifyAt,
  });

const OWN = { mode: 'execution', projectId: 'p-1', intentId: 'i-1', executionId: 'e-1' };
const SIBLING = { mode: 'execution', projectId: 'p-1', intentId: 'i-2', executionId: 'e-2' };
const FOREIGN = { mode: 'execution', projectId: 'p-2', intentId: 'i-3', executionId: 'e-3' };
const DISCUSSION = { mode: 'discussion', projectId: 'p-1', intentId: 'i-1' };

const meta = ({ executionId, projectId, intentId }) => ({ executionId, projectId, intentId });
const ROWS = {
  meta: { 'e-1': meta(OWN), 'e-2': meta(SIBLING), 'e-3': meta(FOREIGN), 'i-1': meta(OWN) },
  stages: {
    'e-1/si-1': { executionId: 'e-1', stageInstanceId: 'si-1', stageId: 'requirements-analysis' },
    'e-1/si-lane': {
      executionId: 'e-1',
      stageInstanceId: 'si-lane',
      stageId: 'code-generation',
      sectionIndex: 1,
      unitSlug: 'u-auth',
    },
    'e-2/si-2': { executionId: 'e-2', stageInstanceId: 'si-2', stageId: 'requirements-analysis' },
  },
  units: { 'e-1/1/u-auth': { executionId: 'e-1', slug: 'u-auth' } },
  edits: { 'e-1/qe-1': { executionId: 'e-1', editId: 'qe-1' } },
};
const store = {
  getExecution: async (id) => ROWS.meta[id] ?? null,
  getStage: async (e, s) => ROWS.stages[`${e}/${s}`] ?? null,
  getUnit: async (e, section, slug) => ROWS.units[`${e}/${section}/${slug}`] ?? null,
  getQuorumEdit: async (e, editId) => ROWS.edits[`${e}/${editId}`] ?? null,
};

let conn;
let g;
let opened = 0;
let audit = [];
let manager;

const wire = (handler) => async (event) =>
  JSON.parse(JSON.stringify(await handler(JSON.parse(JSON.stringify(event)))));

const gateway = (overrides = {}) =>
  wire(
    createGraphGateway({
      verifyGrant,
      createStore: () => store,
      withGraph: manager.withGraph,
      clock: () => '2026-10-18T12:00:00.000Z',
      audit: (record) => audit.push(record),
      ...overrides,
    }),
  );

const call = async (scope, op, input = {}, selector = {}, overrides) =>
  gateway(overrides)({
    op: engineDataGraphOp(op),
    args: [selector, input],
    grant: await grantFor(scope),
  });

const writerFor = (scope, extra = {}) =>
  createGraphWriter({
    g,
    scope: { ...scope, stageInstanceId: 'si-1', ...extra },
    clock: () => '2026-10-18T11:00:00.000Z',
  });

const seedIntent = (intentId, projectId) =>
  g.addV('Intent').property('id', intentId).property('project_id', projectId).next();

const seedDiscussion = async ({ intentId, discussionId, messages }) => {
  await g
    .addV('Discussion')
    .property('id', discussionId)
    .property('intent_id', intentId)
    .property('entity_type', 'intent')
    .property('status', 'open')
    .next();
  for (const m of messages) {
    await g
      .addV('DiscussionMessage')
      .property('id', m.id)
      .property('intent_id', m.intentId ?? intentId)
      .property('discussion_id', discussionId)
      .property('author_type', m.authorType ?? 'user')
      .property('author_id', m.authorType === 'agent' ? 'quorum' : 'u-1')
      .property('request_id', m.requestId ?? '')
      .property('content', m.content ?? 'hello')
      .property('created_at', m.createdAt ?? '2026-10-18T10:00:00.000Z')
      .next();
    await g
      .V()
      .has('Discussion', 'id', discussionId)
      .has('intent_id', intentId)
      .addE('HAS_MESSAGE')
      .to(gremlin.process.statics.V().has('DiscussionMessage', 'id', m.id))
      .next();
  }
};

beforeAll(async () => {
  const url = `ws://${process.env.NEPTUNE_ENDPOINT}:${process.env.GREMLIN_PORT}/gremlin`;
  conn = new gremlin.driver.DriverRemoteConnection(url);
  g = gremlin.process.AnonymousTraversalSource.traversal()
    .withRemote(conn)
    .withStrategies(
      new PartitionStrategy({
        partitionKey: '_partition',
        writePartition: 'engine-data-graph-gateway',
        readPartitions: ['engine-data-graph-gateway'],
      }),
    );
});

afterAll(async () => {
  await conn?.close();
});

beforeEach(async () => {
  await g.V().drop().next();
  verifyAt = NOW + 1000;
  audit = [];
  opened = 0;
  manager = createGraphManager({
    openGraph: async () => {
      opened += 1;
      return g;
    },
    closeGraphSource: async () => {},
  });
  await seedIntent('i-1', 'p-1');
  await seedIntent('i-2', 'p-1');
  await seedIntent('i-3', 'p-2');
});

describe('graph wire contract', () => {
  it('keeps the allowlist, the schemas and the server operations in lockstep', () => {
    const served = Object.keys(createEngineGraphOps({ g: {}, scope: { intentId: 'x' } }));
    expect(Object.keys(GRAPH_OPS).toSorted()).toEqual([...ENGINE_DATA_GRAPH_OPS].toSorted());
    expect(served.toSorted()).toEqual([...ENGINE_DATA_GRAPH_OPS].toSorted());
    expect(ENGINE_DATA_GRAPH_DISCUSSION_OPS.every((op) => ENGINE_DATA_GRAPH_OPS.includes(op))).toBe(
      true,
    );
    // The two namespaces never overlap, so dispatch by prefix is unambiguous.
    expect(ENGINE_DATA_GRAPH_OPS.filter((op) => ENGINE_DATA_STORE_METHODS.includes(op))).toEqual(
      [],
    );
  });

  it.each([
    'createArtifact',
    'getNeighbors',
    'searchGraph',
    'recordQuestion',
    'getSection',
    'getArtifact',
    'readIntentArtifactEntries',
    'clearArtifactStale',
    'withGraph',
    '__proto__',
    'toString',
    'getExecution',
  ])('refuses graph.%s', async (op) => {
    expect((await call(OWN, op)).error).toMatchObject({
      name: 'EngineDataAccessDenied',
      code: 'op_not_allowed',
    });
  });

  it('refuses ops outside the graph namespace and bytecode-shaped payloads', async () => {
    const handler = gateway();
    const grant = await grantFor(OWN);
    expect((await handler({ op: 'store.getExecution', args: [{}, {}], grant })).error.code).toBe(
      'op_not_allowed',
    );
    expect(
      (
        await handler({
          op: engineDataGraphOp('getIntentGraph'),
          args: [{}, { bytecode: { step: [['V']] } }],
          grant,
        })
      ).error.code,
    ).toBe('invalid_arguments');
    expect(
      (await handler({ op: engineDataGraphOp('getIntentGraph'), args: [{}, {}, {}], grant })).error
        .code,
    ).toBe('invalid_arguments');
    expect(
      (
        await handler({
          op: engineDataGraphOp('getIntentGraph'),
          args: [JSON.parse('{"__proto__":{"x":1}}'), {}],
          grant,
        })
      ).error.code,
    ).toBe('invalid_arguments');
  });

  it('refuses property bags that would set ownership or provenance', async () => {
    expect(
      (await call(OWN, 'updateArtifact', { id: 'a', props: { content: 'x', intent_id: 'i-2' } }))
        .error.code,
    ).toBe('invalid_arguments');
    expect(
      (
        await call(OWN, 'recordLearningRule', {
          id: 'r1',
          content: 'c',
          layer: 'project-learnings',
          props: { project_id: 'p-2' },
        })
      ).error.code,
    ).toBe('invalid_arguments');
    expect(
      (
        await call(OWN, 'ingestCodeFiles', {
          repository: 'r',
          commitRef: 'c',
          files: [{ filePath: '../../etc/passwd' }],
        })
      ).error.code,
    ).toBe('invalid_arguments');
    expect(
      (
        await call(OWN, 'mirrorUnitDag', {
          units: [{ slug: 'u-a', dependsOn: ['u-elsewhere'] }],
        })
      ).error.code,
    ).toBe('invalid_arguments');
  });

  it('audits names and decisions only', async () => {
    await writerFor(OWN).createArtifact({ artifactType: 'req', id: 'a1', content: 'SECRET body' });
    await call(OWN, 'getIntentGraph', { includeContent: true });
    await call(OWN, 'getIntentGraph', {}, { intentId: 'i-2' });
    const text = JSON.stringify(audit);
    expect(text).not.toContain('SECRET');
    expect(text).not.toContain('eyJ');
    expect(audit.map((r) => [r.op, r.decision, r.reason ?? r.outcome])).toEqual([
      ['graph.getIntentGraph', 'allow', 'ok'],
      ['graph.getIntentGraph', 'deny', 'scope_mismatch'],
    ]);
  });
});

describe('graph authorization', () => {
  it('denies missing, expired and badly signed grants', async () => {
    const handler = gateway();
    const op = engineDataGraphOp('getIntentGraph');
    expect((await handler({ op, args: [] })).error.code).toBe('missing_grant');
    expect((await handler({ op, args: [], grant: 'not-a-grant' })).error.code).toBe(
      'grant_invalid',
    );
    const grant = await grantFor(OWN, { ttlSeconds: 60 });
    verifyAt = NOW + 120_000;
    expect((await handler({ op, args: [], grant })).error.code).toBe('grant_expired');
  });

  it('checks every selector ownership id against the grant', async () => {
    for (const selector of [
      { projectId: 'p-2' },
      { intentId: 'i-2' },
      { executionId: 'e-2' },
      { stageInstanceId: 'si-2' },
      { stageInstanceId: 'si-missing' },
      { unitSlug: 'u-auth' },
      { stageInstanceId: 'si-lane', unitSlug: 'u-other' },
      { stageInstanceId: 'si-lane', sectionIndex: 0 },
    ]) {
      expect(
        (await call(OWN, 'getIntentGraph', {}, selector)).error?.code,
        JSON.stringify(selector),
      ).toBe('scope_mismatch');
    }
    expect(
      (await call(OWN, 'getIntentGraph', {}, { stageInstanceId: 'si-lane', unitSlug: 'u-auth' }))
        .ok,
    ).toBe(true);
  });

  it('requires matching META and Intent anchor', async () => {
    expect((await call({ ...OWN, executionId: 'e-none' }, 'getIntentGraph')).error.code).toBe(
      'execution_not_found',
    );
    // META belongs to another intent of the same project.
    expect((await call({ ...OWN, executionId: 'e-2' }, 'getIntentGraph')).error.code).toBe(
      'scope_mismatch',
    );
    // The anchor belongs to another project.
    ROWS.meta['e-x'] = { executionId: 'e-x', projectId: 'p-1', intentId: 'i-3' };
    try {
      expect(
        (await call({ ...OWN, intentId: 'i-3', executionId: 'e-x' }, 'getIntentGraph')).error.code,
      ).toBe('scope_mismatch');
    } finally {
      delete ROWS.meta['e-x'];
    }
  });

  it('resolves input stages, unit lanes and Quorum edits inside the execution', async () => {
    expect(
      (
        await call(OWN, 'archiveArtifactsForStages', {
          stageInstanceIds: ['si-1', 'si-2'],
          restartId: 'r',
          reason: 'x',
          actor: 'a',
        })
      ).error.code,
    ).toBe('scope_mismatch');
    expect(
      (await call(OWN, 'linkSteeringInfluences', { steerIds: ['st'], stageInstanceId: 'si-2' }))
        .error.code,
    ).toBe('scope_mismatch');
    expect(
      (
        await call(OWN, 'recordUnitPullRequest', {
          sectionIndex: 0,
          unitSlug: 'u-auth',
          repoId: 'org/api',
          provider: 'github',
          prNumber: 7,
        })
      ).error.code,
    ).toBe('scope_mismatch');
    expect(
      (await call(OWN, 'applyArtifactEdit', { artifactId: 'a', editId: 'qe-2', content: 'x' }))
        .error.code,
    ).toBe('scope_mismatch');
    expect(
      (await call(OWN, 'recordContributionGap', { agentRef: 'x', reason: 'y' })).error.code,
    ).toBe('stage_required');
  });

  it('confines discussion grants to the three assist operations', async () => {
    for (const op of ENGINE_DATA_GRAPH_OPS.filter(
      (name) => !ENGINE_DATA_GRAPH_DISCUSSION_OPS.includes(name),
    )) {
      expect((await call(DISCUSSION, op)).error?.code, op).toBe('op_not_allowed');
    }
    expect(
      (await call(OWN, 'readDiscussionContext', { discussionId: 'd', messageId: 'm' })).error.code,
    ).toBe('op_not_allowed');
    expect(
      (await call(DISCUSSION, 'readProjectCliConfig', {}, { stageInstanceId: 'si-1' })).error.code,
    ).toBe('scope_mismatch');
    expect((await call(DISCUSSION, 'readProjectCliConfig')).ok).toBe(true);
  });

  it('lets only an execution grant create the Intent anchor, never reparent one', async () => {
    expect((await call({ ...OWN, mode: 'stage' }, 'ensureIntent', { title: 't' })).error.code).toBe(
      'grant_mode_not_allowed',
    );
    const fresh = { mode: 'execution', projectId: 'p-1', intentId: 'i-new', executionId: 'e-new' };
    expect(await call(fresh, 'ensureIntent', { title: 'New' })).toEqual({
      ok: true,
      result: { intentId: 'i-new' },
    });
    // i-3 already belongs to p-2.
    const steal = { mode: 'execution', projectId: 'p-1', intentId: 'i-3', executionId: 'e-steal' };
    expect((await call(steal, 'ensureIntent', { title: 'Mine' })).error.code).toBe(
      'scope_mismatch',
    );
    expect(await g.V().has('Intent', 'id', 'i-3').values('project_id').toList()).toEqual(['p-2']);
  });

  it('never resolves or mutates another intent’s rows by id', async () => {
    await writerFor(SIBLING).createArtifact({ artifactType: 'req', id: 'shared-id', content: 'B' });
    await writerFor(OWN).createArtifact({ artifactType: 'design', id: 'mine', content: '# A\n' });
    await g.addV('Steering').property('id', 'st-foreign').property('intent_id', 'i-2').next();

    expect((await call(OWN, 'getArtifactForEdit', { artifactId: 'shared-id' })).result).toBeNull();
    expect((await call(OWN, 'getArtifactToc', { id: 'shared-id' })).result).toEqual([]);
    expect((await call(OWN, 'lookupArtifacts', { artifactType: 'req' })).result).toEqual([]);
    expect(
      (
        await call(OWN, 'markArtifactsStale', {
          sourceArtifactId: 'shared-id',
          artifactIds: ['mine'],
          editId: 'qe-1',
        })
      ).error.code,
    ).toBe('artifact_not_in_scope');
    expect(
      (
        await call(OWN, 'markArtifactsStale', {
          sourceArtifactId: 'mine',
          artifactIds: ['shared-id'],
          editId: 'qe-1',
        })
      ).result,
    ).toEqual([]);
    expect(
      (
        await call(OWN, 'linkSteeringInfluences', {
          steerIds: ['st-foreign'],
          stageInstanceId: 'si-1',
        })
      ).result,
    ).toEqual({ linked: 0 });
    expect(
      (
        await call(OWN, 'applyArtifactEdit', {
          artifactId: 'shared-id',
          editId: 'qe-1',
          content: 'x',
        })
      ).error,
    ).toMatchObject({ name: 'Error', message: 'Artifact "shared-id" not found' });
    expect(await g.V().has('Artifact', 'id', 'shared-id').values('content').toList()).toEqual([
      'B',
    ]);
    expect(await g.V().has('Artifact', 'id', 'shared-id').values('stale_since').toList()).toEqual(
      [],
    );
  });

  it('rejects a derivation of content the graph no longer holds', async () => {
    await writerFor(OWN).createArtifact({ artifactType: 'design', id: 'mine', content: '# A\n' });
    expect(
      (
        await call(OWN, 'mirrorArtifactDerivations', {
          artifactId: 'mine',
          sourceHash: '0'.repeat(64),
        })
      ).error,
    ).toMatchObject({ name: 'EngineGraphError', code: 'artifact_changed' });
  });

  it('binds discussion completion to an agent request in the granted intent', async () => {
    await seedDiscussion({
      intentId: 'i-1',
      discussionId: 'd-1',
      messages: [
        { id: 'm-user', content: 'question' },
        { id: 'm-agent', authorType: 'agent', requestId: 'req-1', content: 'pending' },
      ],
    });
    await seedDiscussion({
      intentId: 'i-2',
      discussionId: 'd-2',
      messages: [{ id: 'm-foreign', authorType: 'agent', requestId: 'req-1' }],
    });
    const complete = (input) =>
      call(DISCUSSION, 'completeDiscussionAssist', {
        discussionId: 'd-1',
        messageId: 'm-agent',
        requestId: 'req-1',
        content: 'answer',
        status: 'completed',
        ...input,
      });
    expect((await complete({ messageId: 'm-user' })).error.code).toBe('message_not_assist_request');
    expect((await complete({ requestId: 'req-2' })).error.code).toBe('message_not_assist_request');
    expect((await complete({ discussionId: 'd-2', messageId: 'm-foreign' })).error.code).toBe(
      'discussion_not_in_scope',
    );
    expect((await complete({ messageId: 'm-foreign' })).error.code).toBe('message_not_in_thread');
    expect(
      (
        await call(DISCUSSION, 'readDiscussionContext', {
          discussionId: 'd-1',
          messageId: 'm-agent',
          selectedMessageIds: ['m-foreign'],
        })
      ).error.code,
    ).toBe('message_not_in_thread');

    const done = await complete({});
    expect(done.result).toMatchObject({
      id: 'm-agent',
      content: 'answer',
      assistStatus: 'completed',
    });
    const context = await call(DISCUSSION, 'readDiscussionContext', {
      discussionId: 'd-1',
      messageId: 'm-agent',
      selectedMessageIds: ['m-user'],
    });
    expect(context.result.selected.map((m) => m.id)).toEqual(['m-user']);
    expect(context.result.recent).toEqual([]);
    expect(context.result.anchor).toEqual({ id: 'i-1', entityType: 'intent', title: '' });
  });
});

describe('graph connection', () => {
  it('serves alternating grants over one warm connection with fresh scope', async () => {
    await writerFor(OWN).createArtifact({ artifactType: 'req', id: 'own', content: 'A' });
    await writerFor(FOREIGN).createArtifact({ artifactType: 'req', id: 'other', content: 'C' });
    const ids = async (scope) => (await call(scope, 'getIntentGraph')).result.map((row) => row.id);
    expect(await ids(OWN)).toEqual(['own']);
    expect(await ids(FOREIGN)).toEqual(['other']);
    expect(await ids(OWN)).toEqual(['own']);
    expect(opened).toBe(1);
  });

  it('carries named graph errors back without replaying a mutation', async () => {
    let calls = 0;
    const failing = () => ({
      ...createEngineGraphOps({ g, scope: { intentId: 'i-1' } }),
      resolveDerivedItemEdges: async () => {
        calls += 1;
        const error = new Error('Unexpected server response: 403 Signature expired');
        error.name = 'ConcurrentModificationException';
        error.code = 'cme';
        throw error;
      },
    });
    const response = await call(OWN, 'resolveDerivedItemEdges', {}, {}, { createOps: failing });
    expect(response.error).toEqual({
      name: 'ConcurrentModificationException',
      code: 'cme',
      message: 'Unexpected server response: 403 Signature expired',
      conflict: false,
    });
    expect(calls).toBe(1);
  });

  it('refuses a response too large for a synchronous invoke', async () => {
    await writerFor(OWN).createArtifact({
      artifactType: 'req',
      id: 'big',
      content: 'x'.repeat(2048),
    });
    const response = await call(
      OWN,
      'getIntentGraph',
      { includeContent: true },
      {},
      {
        maxResponseBytes: 1024,
      },
    );
    expect(response.error).toMatchObject({ code: 'response_too_large' });
  });
});
