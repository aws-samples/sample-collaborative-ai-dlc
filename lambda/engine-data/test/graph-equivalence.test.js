// Local/remote equivalence: the same semantic scenario run through the engine's
// local graph operations and through the wire (JSON both ways) → engine-data's
// graph gateway → the same operations, each against its own isolated graph on
// the real gremlin-server. Results, errors and the resulting graphs must match
// once generated UUIDs are normalized.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import gremlin from 'gremlin';
import { PartitionStrategy } from 'gremlin/lib/process/traversal-strategy.js';
import { issueGatewayGrant, verifyGatewayGrant } from '../../shared/gateway-grant.js';
import { engineDataGraphOp } from '../../shared/engine-data-ops.js';
import { createEngineGraphOps } from '../../shared/engine-graph-ops.js';
import { createGraphManager } from '../../shared/mcp/graph-manager.js';
import { createGraphWriter } from '../../shared/mcp/graph-writer.js';
import { extractArtifactStructure } from '../../shared/artifact-extractors.js';
import { readCurrentArtifactHeads } from '../../shared/artifact-versioning.js';
import { createGraphGateway } from '../graph-gateway.js';

const __ = gremlin.process.statics;
const NOW = Date.parse('2026-10-18T12:00:00.000Z');
const CLOCK = () => '2026-10-18T12:00:00.000Z';
const KID = 'kid-1';
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

const OWN = { mode: 'execution', projectId: 'p-1', intentId: 'i-1', executionId: 'e-1' };
const DISCUSSION = { mode: 'discussion', projectId: 'p-1', intentId: 'i-1' };
const STAGES = {
  'si-1': { executionId: 'e-1', stageInstanceId: 'si-1', stageId: 'requirements-analysis' },
  'si-lane': {
    executionId: 'e-1',
    stageInstanceId: 'si-lane',
    stageId: 'code-generation',
    sectionIndex: 1,
    unitSlug: 'u-auth',
  },
};
const store = {
  getExecution: async (id) =>
    id === 'e-1' || id === 'i-1' ? { executionId: id, projectId: 'p-1', intentId: 'i-1' } : null,
  getStage: async (e, s) => (e === 'e-1' ? (STAGES[s] ?? null) : null),
  getUnit: async (e, section, slug) =>
    e === 'e-1' && section === 1 && slug === 'u-auth' ? { executionId: e } : null,
  getQuorumEdit: async (e, editId) =>
    e === 'e-1' && editId === 'qe-1' ? { executionId: e } : null,
};

const REQUIREMENTS =
  '# Requirements\n\n## Login\n\nUsers sign in.\n\n## Audit\n\nEvery change is logged.\n';
const DESIGN = '# Design\n\nBuilt from the requirements.\n';

const connections = [];
const partitionGraph = (partition) => {
  const conn = new gremlin.driver.DriverRemoteConnection(
    `ws://${process.env.NEPTUNE_ENDPOINT}:${process.env.GREMLIN_PORT}/gremlin`,
  );
  connections.push(conn);
  return gremlin.process.AnonymousTraversalSource.traversal()
    .withRemote(conn)
    .withStrategies(
      new PartitionStrategy({
        partitionKey: '_partition',
        writePartition: partition,
        readPartitions: [partition],
      }),
    );
};

let local;
let remote;

beforeAll(async () => {
  local = partitionGraph('engine-data-equivalence-local');
  remote = partitionGraph('engine-data-equivalence-remote');
  await local.V().drop().next();
  await remote.V().drop().next();
});

afterAll(async () => {
  await Promise.all(connections.map((conn) => conn.close()));
});

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const PARTITION = /engine-data-equivalence-(?:local|remote)/g;
const normalize = (value) =>
  JSON.parse(
    JSON.stringify(value ?? null)
      .replace(UUID, '<uuid>')
      .replace(PARTITION, '<partition>'),
  );

// What the gateway rebuilds from the grant and the resolved stage row.
const scopeFor = (grantScope, selector = {}) => {
  const stage = selector.stageInstanceId ? STAGES[selector.stageInstanceId] : null;
  return {
    projectId: grantScope.projectId,
    intentId: grantScope.intentId,
    executionId: grantScope.executionId ?? grantScope.intentId,
    ...(stage
      ? {
          stageInstanceId: stage.stageInstanceId,
          stageId: stage.stageId,
          sectionIndex: stage.sectionIndex ?? null,
          unitSlug: stage.unitSlug ?? null,
        }
      : {}),
  };
};

const runLocal = async (grantScope, op, input, selector) => {
  try {
    const ops = createEngineGraphOps({
      g: local,
      scope: scopeFor(grantScope, selector),
      clock: CLOCK,
    });
    return { ok: true, result: normalize(await ops[op](input)) };
  } catch (error) {
    return {
      error: {
        name: error.name,
        code: typeof error.code === 'string' ? error.code : null,
        message: error.message,
      },
    };
  }
};

const manager = createGraphManager({
  openGraph: async () => remote,
  closeGraphSource: async () => {},
});
const handler = createGraphGateway({
  verifyGrant,
  createStore: () => store,
  withGraph: manager.withGraph,
  clock: CLOCK,
});

const runRemote = async (grantScope, op, input, selector) => {
  const event = {
    op: engineDataGraphOp(op),
    args: [selector, input],
    grant: await grantFor(grantScope),
  };
  const body = JSON.parse(JSON.stringify(await handler(JSON.parse(JSON.stringify(event)))));
  if (body.error) {
    const { name, code, message } = body.error;
    return { error: { name, code, message } };
  }
  return { ok: true, result: normalize(body.result) };
};

// Row lists come back in traversal order, which the graph does not define.
const unordered = (value) => {
  if (Array.isArray(value)) {
    const items = value.map(unordered);
    return items.every((item) => item && typeof item === 'object')
      ? items.toSorted((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
      : items;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, unordered(item)]));
  }
  return value;
};

const failures = [];
const both = async (op, input = {}, { selector = {}, grant = OWN } = {}) => {
  const [l, r] = [
    await runLocal(grant, op, input, selector),
    await runRemote(grant, op, input, selector),
  ];
  expect(unordered(r), op).toEqual(unordered(l));
  if (l.error) failures.push(`${op}:${l.error.code}`);
  return l;
};

const seedBoth = async (fn) => {
  await fn(local);
  await fn(remote);
};

const dump = async (g) => {
  const vertices = (await g.V().valueMap().toList()).map((row) => {
    const out = {};
    for (const [key, value] of row instanceof Map ? row.entries() : Object.entries(row)) {
      if (key !== '_partition') out[key] = Array.isArray(value) ? value[0] : value;
    }
    // An archived version records its edges in traversal order.
    if (typeof out.relationships === 'string') {
      out.relationships = unordered(JSON.parse(out.relationships));
    }
    return Object.fromEntries(Object.entries(out).toSorted(([a], [b]) => a.localeCompare(b)));
  });
  const edges = await g
    .E()
    .project('label', 'from', 'to')
    .by(gremlin.process.t.label)
    .by(__.outV().values('id'))
    .by(__.inV().values('id'))
    .toList();
  const sorted = (rows) => rows.map((row) => JSON.stringify(normalize(row))).toSorted();
  return {
    vertices: sorted(vertices),
    edges: sorted(edges.map((edge) => Object.fromEntries(edge.entries()))),
  };
};

describe('local and remote graph operations are equivalent', () => {
  it('runs one engine scenario to the same results and the same graph', async () => {
    expect((await both('ensureIntent', { title: 'Checkout' })).result).toEqual({ intentId: 'i-1' });
    await both('ensureIntent', { title: 'Checkout' });

    await seedBoth(async (g) => {
      const writer = createGraphWriter({
        g,
        scope: { ...OWN, stageInstanceId: 'si-1' },
        clock: CLOCK,
      });
      await writer.createArtifact({
        artifactType: 'requirements',
        id: 'requirements',
        content: REQUIREMENTS,
      });
      await writer.createArtifact({
        artifactType: 'design',
        id: 'design',
        content: DESIGN,
        links: [{ edge: 'DERIVED_FROM', toId: 'requirements' }],
      });
      await g.addV('Project').property('id', 'p-1').property('agent_cli', 'claude').next();
      await g
        .addV('Steering')
        .property('id', 'st-1')
        .property('intent_id', 'i-1')
        .property('kind', 'note')
        .next();
      await g
        .addV('Discussion')
        .property('id', 'd-1')
        .property('intent_id', 'i-1')
        .property('entity_type', 'artifact')
        .property('entity_id', 'design')
        .next();
      for (const [id, authorType, requestId] of [
        ['m-1', 'user', ''],
        ['m-2', 'agent', 'req-1'],
      ]) {
        await g
          .addV('DiscussionMessage')
          .property('id', id)
          .property('intent_id', 'i-1')
          .property('discussion_id', 'd-1')
          .property('author_type', authorType)
          .property('request_id', requestId)
          .property('content', `${id} text`)
          .property('created_at', `2026-10-18T10:00:0${id.at(-1)}.000Z`)
          .next();
        await g
          .V()
          .has('Discussion', 'id', 'd-1')
          .addE('HAS_MESSAGE')
          .to(__.V().has('DiscussionMessage', 'id', id))
          .next();
      }
    });

    const sourceHash = extractArtifactStructure({
      artifactType: 'requirements',
      artifactId: 'requirements',
      content: REQUIREMENTS,
    }).contentHash;

    await both('lookupArtifacts', { artifactType: 'requirements' });
    await both('getIntentGraph', { includeContent: true });
    expect(
      (await both('mirrorArtifactDerivations', { artifactId: 'requirements', sourceHash })).ok,
    ).toBe(true);
    await both('mirrorArtifactDerivations', {
      artifactId: 'requirements',
      sourceHash: '0'.repeat(64),
    });
    await both('getArtifactToc', { id: 'requirements' });
    await both('applyArtifactEnrichment', {
      artifactId: 'requirements',
      gist: 'Sign-in and audit',
      claims: ['users sign in'],
      model: 'm',
      sourceHash,
    });
    await both('getItems', {});
    await both('getCoverage', { unitSlug: 'u-auth' });
    await both('mirrorUnitDag', {
      units: [
        { slug: 'u-auth', dependsOn: [] },
        { slug: 'u-api', dependsOn: ['u-auth'] },
      ],
      sourceArtifactId: 'requirements',
    });
    await both('resolveDerivedItemEdges');
    await both('recordPullRequest', {
      repoId: 'org/api',
      prUrl: 'https://git/pr/1',
      prNumber: 1,
      branch: 'b',
    });
    await both('recordUnitPullRequest', {
      sectionIndex: 1,
      unitSlug: 'u-auth',
      repoId: 'org/api',
      provider: 'github',
      prNumber: 7,
      sourceBranch: 'unit/u-auth',
    });
    await both(
      'recordContributionGap',
      { agentRef: 'critic', reason: 'no output' },
      {
        selector: { stageInstanceId: 'si-1' },
      },
    );
    await both('ingestCodeFiles', {
      repository: 'org/api',
      commitRef: 'abc123',
      stageInstanceId: 'si-lane',
      unitSlug: 'u-auth',
      files: [{ filePath: 'src/login.js', evidenceIds: ['requirements'] }],
    });
    await both('linkSteeringInfluences', { steerIds: ['st-1'], stageInstanceId: 'si-1' });
    await both('recordLearningRule', {
      id: 'rule-1',
      content: 'Always log changes',
      layer: 'project-learnings',
      props: { source: 'gate-learnings-ritual' },
    });
    await both('getTeamKnowledge', {});
    await both('getLearningRules');
    await both('getArtifactForEdit', { artifactId: 'requirements' });
    await both('fetchDownstreamClosure', { artifactId: 'requirements' });
    expect(
      (
        await both('applyArtifactEdit', {
          artifactId: 'design',
          editId: 'qe-1',
          content: '# Design v2\n',
          ifCollaborationEpoch: 'not-current',
        })
      ).error,
    ).toMatchObject({ code: 'edit_conflict' });
    await both('applyArtifactEdit', {
      artifactId: 'design',
      editId: 'qe-1',
      content: '# Design v2\n',
    });
    await both('markArtifactsStale', {
      sourceArtifactId: 'design',
      artifactIds: ['requirements'],
      editId: 'qe-1',
    });
    await both('verifyArtifact', { artifactId: 'requirements', note: 'still valid' });
    await both('updateArtifact', { id: 'design', props: { content: '# Design v3\n' } });
    await both('readCurrentArtifactHeadHashes');
    await both('snapshotCurrentArtifactHeads');
    await both('readProjectCliConfig');
    await both('inspect', { artifactType: 'design', artifactId: 'design' });
    await both(
      'readDiscussionContext',
      { discussionId: 'd-1', messageId: 'm-2', selectedMessageIds: ['m-1'] },
      { grant: DISCUSSION },
    );
    await both(
      'completeDiscussionAssist',
      {
        discussionId: 'd-1',
        messageId: 'm-2',
        requestId: 'req-1',
        content: 'Answer',
        status: 'completed',
      },
      { grant: DISCUSSION },
    );
    await both('archiveArtifactsForStages', {
      stageInstanceIds: ['si-1'],
      restartId: 'restart-1',
      reason: 'loop-back',
      actor: 'reviewer',
    });
    await both('supersedeDerivationsForArtifacts', { artifactIds: ['requirements'] });
    await both('getIntentGraph', { includeSuperseded: true });

    const [localGraph, remoteGraph] = [await dump(local), await dump(remote)];
    expect(remoteGraph).toEqual(localGraph);
    expect(failures).toEqual([
      'mirrorArtifactDerivations:artifact_changed',
      'applyArtifactEdit:edit_conflict',
    ]);
    expect(localGraph.vertices.length).toBeGreaterThan(10);
    expect(localGraph.edges.length).toBeGreaterThan(10);
  });
});

// Counts, at the graph boundary, how many artifact bodies each traversal returns.
const countingBodies = (g) => {
  let bodies = 0;
  const hasBody = (value) => {
    if (value instanceof Map) return value.has('content') || [...value.values()].some(hasBody);
    return Array.isArray(value) && value.some(hasBody);
  };
  const counted = new Proxy(g, {
    get(target, key) {
      const value = target[key];
      if (key !== 'V') return typeof value === 'function' ? value.bind(target) : value;
      return (...args) => {
        const traversal = target.V(...args);
        const toList = traversal.toList.bind(traversal);
        traversal.toList = async () => {
          const rows = await toList();
          bodies += rows.filter(hasBody).length;
          return rows;
        };
        return traversal;
      };
    },
  });
  return { g: counted, bodies: () => bodies };
};

describe('per-artifact engine reads', () => {
  it('load only the named head body, whatever the size of the intent', async () => {
    const g = partitionGraph('engine-data-head-reads');
    await g.V().drop().next();
    const scope = { ...OWN, stageInstanceId: 'si-1' };
    const writer = createGraphWriter({ g, scope, clock: CLOCK });
    await createEngineGraphOps({ g, scope: OWN, clock: CLOCK }).ensureIntent({
      title: 'Big',
    });
    for (let i = 0; i < 12; i += 1) {
      await writer.createArtifact({
        artifactType: 'requirements',
        id: `req-${i}`,
        content: `# Requirements ${i}\n\n## Item\n\n${'x'.repeat(2000)}\n`,
      });
    }
    const content = (await writer.getArtifact({ id: 'req-7' })).content;
    const sourceHash = extractArtifactStructure({
      artifactType: 'requirements',
      artifactId: 'req-7',
      content,
    }).contentHash;

    const counter = countingBodies(g);
    const ops = createEngineGraphOps({ g: counter.g, scope, clock: CLOCK });
    expect((await ops.getArtifactContent({ artifactId: 'req-7' })).content).toBe(content);
    await ops.mirrorArtifactDerivations({ artifactId: 'req-7', sourceHash });
    await ops.applyArtifactEnrichment({
      artifactId: 'req-7',
      gist: 'g',
      claims: [],
      sourceHash,
    });
    expect(counter.bodies()).toBe(3);
    await expect(ops.getArtifactContent({ artifactId: 'missing' })).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('do not return a head superseded between selecting it and reading its body', async () => {
    const g = partitionGraph('engine-data-head-race');
    await g.V().drop().next();
    const scope = { ...OWN, stageInstanceId: 'si-1' };
    await createEngineGraphOps({ g, scope: OWN, clock: CLOCK }).ensureIntent({ title: 'Race' });
    await createGraphWriter({ g, scope, clock: CLOCK }).createArtifact({
      artifactType: 'requirements',
      id: 'req',
      content: '# Requirements\n',
    });
    // A rewind archives the head after it was selected, before its body is read.
    const racing = new Proxy(g, {
      get(target, key) {
        const value = target[key];
        if (key !== 'V') return typeof value === 'function' ? value.bind(target) : value;
        return (...ids) => {
          const traversal = target.V(...ids);
          if (ids.length === 0) return traversal;
          const toList = traversal.toList.bind(traversal);
          traversal.toList = async () => {
            await target
              .V(...ids)
              .property('superseded_at', CLOCK())
              .next();
            return toList();
          };
          return traversal;
        };
      },
    });
    expect(await readCurrentArtifactHeads(g, 'i-1', 'req')).toHaveLength(1);
    expect(await readCurrentArtifactHeads(racing, 'i-1', 'req')).toEqual([]);
  });
});
