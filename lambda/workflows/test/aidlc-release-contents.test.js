// Release contents for the authoring UI (issue #607):
//   GET /aidlc-releases/{releaseId}/blocks[?type=…]
//   GET /aidlc-releases/{releaseId}/blocks/{type}/{blockId}
// and the `?libraryRelease=` authoring preview on the compiled and
// execution-preview reads.
//
// The properties under test: the listing is the digest-verified closure (never
// the SYSTEM rows), a non-admin cannot use it to probe the registry, a body is
// served only when the closure vouches for its bytes, and a custom stage that
// names an agent only the release ships previews the way the pinned intent
// will run it.
import { readFileSync } from 'node:fs';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { filesFromCompatibilityFixture } from '../../shared/aidlc-compatibility.js';
import { buildReleaseBundle, publishReleaseBundle } from '../../shared/aidlc-release.js';
import { __test as releaseResolverTest } from '../../shared/release-resolver.js';
import { installReleaseStoreFakes, keyOf } from '../../shared/test/fixtures/release-store-fakes.js';

const BLOCKS_TABLE = 'blocks-test';
const ARTIFACTS_BUCKET = 'artifacts-test';
const PROFILE = 'v2.9.0';

const s3Mock = mockClient(S3Client);
const ddbMock = mockClient(DynamoDBDocumentClient);
const s3 = new S3Client({});
const objects = new Map();
const rows = new Map();

const bundle = buildReleaseBundle({
  profileId: PROFILE,
  files: filesFromCompatibilityFixture({
    profileId: PROFILE,
    fixture: JSON.parse(
      readFileSync(
        new URL(`../../shared/test/fixtures/aidlc-compatibility/${PROFILE}.json`, import.meta.url),
        'utf8',
      ),
    ),
  }),
});
const RELEASE_ID = bundle.manifest.releaseId;
const catalogBlocks = (type) => bundle.catalog.blocks[type] ?? [];
const releaseAgent = catalogBlocks('AGENT').find((block) => block.bodyRef);
const releaseSensor = catalogBlocks('SENSOR')[0];

const adminClaims = { sub: 'admin-1', email: 'a@example.com', 'cognito:groups': 'platform-admin' };
const memberClaims = { sub: 'user-2', email: 'u@example.com' };

const event = ({ method = 'GET', resource, pathParameters = {}, query = {}, claims }) => ({
  httpMethod: method,
  resource: `/api${resource}`,
  path: `/api${resource}`,
  pathParameters,
  body: null,
  queryStringParameters: query,
  requestContext: { authorizer: { claims: claims ?? adminClaims } },
  headers: {},
});

let handler;
const parse = (res) => ({ status: res.statusCode, body: res.body ? JSON.parse(res.body) : null });

const contents = async (releaseId, { query = {}, claims } = {}) =>
  parse(
    await handler(
      event({
        resource: '/aidlc-releases/{releaseId}/blocks',
        pathParameters: { releaseId: encodeURIComponent(releaseId) },
        query,
        claims,
      }),
    ),
  );

const releaseBlock = async (releaseId, type, blockId, { claims } = {}) =>
  parse(
    await handler(
      event({
        resource: '/aidlc-releases/{releaseId}/blocks/{type}/{blockId}',
        pathParameters: { releaseId: encodeURIComponent(releaseId), type, blockId },
        claims,
      }),
    ),
  );

const register = async () => {
  const res = parse(
    await handler({
      ...event({ method: 'POST', resource: '/aidlc-releases' }),
      body: JSON.stringify({ profileId: PROFILE }),
    }),
  );
  expect(res.status).toBe(201);
};

// Selectability is the registry's business and has its own suites; these tests
// only need a record a non-admin may or may not see.
const makeSelectable = () => {
  const key = keyOf(`AIDLC_RELEASE#${RELEASE_ID}`, 'META');
  rows.set(key, { ...rows.get(key), supportState: 'selectable', visible: true, runnable: true });
};

beforeAll(async () => {
  process.env.BLOCKS_TABLE = BLOCKS_TABLE;
  process.env.ARTIFACTS_BUCKET = ARTIFACTS_BUCKET;
  ({ handler } = await import('../index.js'));
});

beforeEach(async () => {
  installReleaseStoreFakes({ s3Mock, ddbMock, objects, rows });
  releaseResolverTest.releaseClosureCache.clear();
  await publishReleaseBundle({ s3, bucket: ARTIFACTS_BUCKET, bundle });
  await register();
});

describe('GET /aidlc-releases/{releaseId}/blocks', () => {
  it('lists the closure by type, read-only and labelled with the release', async () => {
    const res = await contents(RELEASE_ID);

    expect(res.status).toBe(200);
    expect(res.body.release).toMatchObject({ releaseId: RELEASE_ID, upstreamVersion: '2.9.0' });
    expect(Object.keys(res.body.blocks)).toEqual(expect.arrayContaining(['stage', 'agent']));
    expect(res.body.blocks.agent.map((block) => block.id)).toEqual(
      catalogBlocks('AGENT').map((block) => block.id),
    );
    const agent = res.body.blocks.agent.find((block) => block.id === releaseAgent.id);
    expect(agent).toMatchObject({
      id: releaseAgent.id,
      blockId: releaseAgent.id,
      blockType: 'AGENT',
      tenantId: 'SYSTEM',
      readOnly: true,
      hasBody: true,
      bodyBytes: releaseAgent.bodyRef.bytes,
      source: 'release',
      releaseId: RELEASE_ID,
    });
    // Storage pointers stay server-side.
    expect(agent).not.toHaveProperty('bodyRef');
    expect(agent).not.toHaveProperty('type');
  });

  it('includes the release workflow', async () => {
    const res = await contents(RELEASE_ID);
    const { workflow } = bundle.catalog;

    expect(res.body.workflow).toMatchObject({
      id: workflow.id,
      readOnly: true,
      source: 'release',
      releaseId: RELEASE_ID,
    });
    expect(res.body.workflow.placements).toHaveLength(workflow.placements.length);
    expect(res.body.workflow.scopeRefs.length).toBeGreaterThan(0);
  });

  it('never reads the mutable SYSTEM library', async () => {
    // A SYSTEM row with an id the release lacks must not appear: the listing is
    // what a pinned intent resolves, not what the seed job last wrote.
    rows.set(keyOf('BLOCK#SYSTEM#AGENT#seeded-only', 'V#latest'), {
      pk: 'BLOCK#SYSTEM#AGENT#seeded-only',
      sk: 'V#latest',
      GSI1PK: 'TENANT#SYSTEM#AGENT',
      blockId: 'seeded-only',
      tenantId: 'SYSTEM',
      name: 'Seeded only',
    });

    const res = await contents(RELEASE_ID, { query: { type: 'agent' } });

    expect(res.body.blocks.agent.map((block) => block.id)).not.toContain('seeded-only');
  });

  it('narrows to the requested types', async () => {
    const res = await contents(RELEASE_ID, { query: { type: 'agent,SENSOR' } });

    expect(res.status).toBe(200);
    expect(Object.keys(res.body.blocks).toSorted()).toEqual(['agent', 'sensor']);
  });

  it('400s an unknown type', async () => {
    const res = await contents(RELEASE_ID, { query: { type: 'agent,widget' } });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('release_block_type_invalid');
  });

  it('gives a non-admin the same 404 for a hidden release as for an unknown one', async () => {
    const hidden = await contents(RELEASE_ID, { claims: memberClaims });
    const unknown = await contents('aidlc:not-registered', { claims: memberClaims });

    expect(hidden.status).toBe(404);
    expect(hidden.body.code).toBe('release_not_found');
    expect(hidden).toEqual({
      ...unknown,
      body: { ...unknown.body, error: hidden.body.error },
    });
  });

  it('serves a selectable release to a non-admin in the selection projection', async () => {
    makeSelectable();

    const res = await contents(RELEASE_ID, { claims: memberClaims });

    expect(res.status).toBe(200);
    expect(res.body.release).not.toHaveProperty('sourceSha');
    expect(res.body.release).not.toHaveProperty('manifestKey');
    expect(res.body.blocks.agent.length).toBeGreaterThan(0);
  });

  it('409s a tampered closure', async () => {
    objects.set(bundle.manifest.catalog.key, JSON.stringify({ tampered: true }));

    const res = await contents(RELEASE_ID);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('release_closure_mismatch');
  });

  it('only answers GET', async () => {
    const res = parse(
      await handler(
        event({
          method: 'PUT',
          resource: '/aidlc-releases/{releaseId}/blocks',
          pathParameters: { releaseId: RELEASE_ID },
        }),
      ),
    );

    expect(res.status).toBe(405);
  });
});

describe('GET /aidlc-releases/{releaseId}/blocks/{type}/{blockId}', () => {
  it('returns the block with its digest-verified body', async () => {
    const res = await releaseBlock(RELEASE_ID, 'agent', releaseAgent.id);

    expect(res.status).toBe(200);
    expect(res.body.block).toMatchObject({ id: releaseAgent.id, source: 'release' });
    expect(res.body.body).toBe(objects.get(releaseAgent.bodyRef.s3Key));
    expect(res.body.body.length).toBeGreaterThan(0);
    expect(res.body.script).toBe('');
  });

  it('returns a sensor script', async () => {
    const sensor = catalogBlocks('SENSOR').find((block) => block.scriptRef);
    if (!sensor) return;

    const res = await releaseBlock(RELEASE_ID, 'sensor', sensor.id);

    expect(res.status).toBe(200);
    expect(res.body.script).toBe(objects.get(sensor.scriptRef.s3Key));
  });

  it('404s a block the release does not ship', async () => {
    const res = await releaseBlock(RELEASE_ID, 'agent', 'not-in-release');

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('release_block_not_found');
  });

  it('409s a body whose bytes no longer match the closure', async () => {
    objects.set(releaseAgent.bodyRef.s3Key, 'rewritten');

    const res = await releaseBlock(RELEASE_ID, 'agent', releaseAgent.id);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('release_closure_mismatch');
  });

  it('409s a body that is missing', async () => {
    objects.delete(releaseAgent.bodyRef.s3Key);

    const res = await releaseBlock(RELEASE_ID, 'agent', releaseAgent.id);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('release_object_missing');
  });

  it('409s a body S3 refuses as AccessDenied, as it answers for a missing object', async () => {
    // The role has no s3:ListBucket, so a missing object comes back 403, not 404.
    const denied = Object.assign(new Error('Access Denied'), {
      name: 'AccessDenied',
      $metadata: { httpStatusCode: 403 },
    });
    s3Mock.on(GetObjectCommand, { Key: releaseAgent.bodyRef.s3Key }).rejects(denied);

    const res = await releaseBlock(RELEASE_ID, 'agent', releaseAgent.id);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('release_object_missing');
  });

  it('applies the same non-admin gate as the listing', async () => {
    const hidden = await releaseBlock(RELEASE_ID, 'agent', releaseAgent.id, {
      claims: memberClaims,
    });
    expect(hidden.status).toBe(404);
    expect(hidden.body.code).toBe('release_not_found');

    makeSelectable();
    const visible = await releaseBlock(RELEASE_ID, 'agent', releaseAgent.id, {
      claims: memberClaims,
    });
    expect(visible.status).toBe(200);
  });

  it('400s an unknown type', async () => {
    const res = await releaseBlock(RELEASE_ID, 'widget', releaseAgent.id);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('release_block_type_invalid');
  });
});

// ── `?libraryRelease=` authoring preview ──
//
// A `default` workflow with one custom stage. The stage names an agent and a
// sensor that only the release ships, and the DynamoDB library holds no SYSTEM
// blocks at all, so anything that resolves must have come from the closure.
const WORKFLOW_ID = 'my-flow';
const CUSTOM_STAGE = 'custom-review';
const SCOPE = bundle.catalog.workflow.scopeRefs[0].scopeId;

const seedCustomWorkflow = ({ systemPlacement = null } = {}) => {
  const pk = `WF#default#${WORKFLOW_ID}`;
  rows.set(keyOf(pk, 'META'), {
    pk,
    sk: 'META',
    workflowId: WORKFLOW_ID,
    tenantId: 'default',
    name: 'My flow',
    version: 1,
  });
  rows.set(keyOf(pk, `PLACEMENT#${CUSTOM_STAGE}`), {
    pk,
    sk: `PLACEMENT#${CUSTOM_STAGE}`,
    type: 'StagePlacement',
    stageId: CUSTOM_STAGE,
    stageTenant: 'default',
    pinnedVersion: null,
    order: 1,
    scopeMembership: { [SCOPE]: 'EXECUTE' },
  });
  if (systemPlacement) {
    rows.set(keyOf(pk, `PLACEMENT#${systemPlacement}`), {
      pk,
      sk: `PLACEMENT#${systemPlacement}`,
      type: 'StagePlacement',
      stageId: systemPlacement,
      stageTenant: 'SYSTEM',
      pinnedVersion: null,
      order: 0,
      scopeMembership: { [SCOPE]: 'EXECUTE' },
    });
  }
  rows.set(keyOf(pk, `SCOPEREF#${SCOPE}`), {
    pk,
    sk: `SCOPEREF#${SCOPE}`,
    scopeId: SCOPE,
    scopeTenant: 'SYSTEM',
  });
  const stagePk = `BLOCK#default#STAGE#${CUSTOM_STAGE}`;
  rows.set(keyOf(stagePk, 'V#latest'), {
    pk: stagePk,
    sk: 'V#latest',
    GSI1PK: 'TENANT#default#STAGE',
    blockId: CUSTOM_STAGE,
    blockType: 'STAGE',
    tenantId: 'default',
    name: 'Custom review',
    version: 3,
    leadAgent: releaseAgent.id,
    reviewer: releaseAgent.id,
    ...(releaseSensor ? { sensors: [releaseSensor.id] } : {}),
  });
};

const preview = async (query, claims) =>
  parse(
    await handler(
      event({
        resource: '/workflows/{workflowId}/execution-preview',
        pathParameters: { workflowId: WORKFLOW_ID },
        query: { scope: SCOPE, ...query },
        claims,
      }),
    ),
  );

const compiled = async (query, claims) =>
  parse(
    await handler(
      event({
        resource: '/workflows/{workflowId}/compiled',
        pathParameters: { workflowId: WORKFLOW_ID },
        query,
        claims,
      }),
    ),
  );

const unresolvedRefs = (body) =>
  [...(body.errors ?? []), ...(body.warnings ?? [])]
    .filter((issue) => issue.stageId === CUSTOM_STAGE && /unresolved|unknown/.test(issue.code))
    .map((issue) => `${issue.code}:${issue.ref}`);

describe('?libraryRelease= authoring preview', () => {
  it('cannot resolve a release-only agent from the mutable library alone', async () => {
    seedCustomWorkflow();

    const res = await preview({});

    expect(res.status).toBe(200);
    expect(unresolvedRefs(res.body)).toContain(`unresolved_agent:${releaseAgent.id}`);
    expect(res.body).not.toHaveProperty('libraryRelease');
  });

  it('resolves the custom stage against the release, as the pinned intent will', async () => {
    seedCustomWorkflow();

    const res = await preview({ libraryRelease: RELEASE_ID });

    expect(res.status).toBe(200);
    expect(res.body.libraryRelease).toBe(RELEASE_ID);
    expect(unresolvedRefs(res.body)).toEqual([]);
  });

  it('lets a user block shadow the release block of the same id', async () => {
    // The pins an intent snapshots overlay the closure, so a `default` copy of
    // a release agent is what the run uses; the preview must agree.
    seedCustomWorkflow();
    const stagePk = `BLOCK#default#STAGE#${CUSTOM_STAGE}`;
    rows.set(keyOf(stagePk, 'V#latest'), {
      ...rows.get(keyOf(stagePk, 'V#latest')),
      leadAgent: 'team-only-agent',
      reviewer: null,
      sensors: [],
    });
    const agentPk = 'BLOCK#default#AGENT#team-only-agent';
    rows.set(keyOf(agentPk, 'V#latest'), {
      pk: agentPk,
      sk: 'V#latest',
      GSI1PK: 'TENANT#default#AGENT',
      blockId: 'team-only-agent',
      tenantId: 'default',
      name: 'Team only',
      version: 1,
    });

    const res = await preview({ libraryRelease: RELEASE_ID });

    expect(unresolvedRefs(res.body)).toEqual([]);
  });

  it('resolves SYSTEM placements from the closure, not the SYSTEM rows', async () => {
    // A placed stage the closure defines with an `execution` mode: the compiled
    // node carries that mode only when the stage block resolved.
    const systemStage = catalogBlocks('STAGE').find((stage) =>
      bundle.catalog.workflow.placements.some(
        (placement) => placement.stageId === stage.id && stage.execution,
      ),
    );
    seedCustomWorkflow({ systemPlacement: systemStage.id });
    const nodeFor = (body) => body.graph.nodes.find((node) => node.stageId === systemStage.id);

    const live = await compiled({});
    const viaRelease = await compiled({ libraryRelease: RELEASE_ID });

    expect(live.status).toBe(200);
    expect(nodeFor(live.body).execution).toBeNull();
    expect(viaRelease.status).toBe(200);
    expect(viaRelease.body.libraryRelease).toBe(RELEASE_ID);
    expect(nodeFor(viaRelease.body).execution).toBe(systemStage.execution);
  });

  it('gates a non-admin on selectability, with the unknown-release 404', async () => {
    seedCustomWorkflow();

    const hidden = await preview({ libraryRelease: RELEASE_ID }, memberClaims);
    expect(hidden.status).toBe(404);
    expect(hidden.body.code).toBe('release_not_found');

    makeSelectable();
    const visible = await preview({ libraryRelease: RELEASE_ID }, memberClaims);
    expect(visible.status).toBe(200);
  });

  it('refuses release and libraryRelease together', async () => {
    seedCustomWorkflow();

    const viaPreview = await preview({ release: RELEASE_ID, libraryRelease: RELEASE_ID });
    const viaCompiled = await compiled({ release: RELEASE_ID, libraryRelease: RELEASE_ID });

    expect(viaPreview.status).toBe(400);
    expect(viaCompiled.status).toBe(400);
  });
});
