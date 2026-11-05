// `?libraryRelease=` authoring previews over the live workflow, checked against
// the immutable release closure and the current user-library overlay.
import { readFileSync } from 'node:fs';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { S3Client } from '@aws-sdk/client-s3';
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

const validateGrid = async (query, claims) =>
  parse(
    await handler({
      ...event({
        method: 'POST',
        resource: '/workflows/{workflowId}/validate-grid',
        pathParameters: { workflowId: WORKFLOW_ID },
        query,
        claims,
      }),
      body: JSON.stringify({ composedGrid: { [CUSTOM_STAGE]: 'EXECUTE' }, scope: SCOPE }),
    }),
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

  it('uses the release closure for validate-grid too', async () => {
    seedCustomWorkflow();

    const result = await validateGrid({ libraryRelease: RELEASE_ID });

    expect(result.status).toBe(200);
    expect(result.body.libraryRelease).toBe(RELEASE_ID);
    expect(unresolvedRefs(result.body)).toEqual([]);
  });

  it('refuses release and libraryRelease together', async () => {
    seedCustomWorkflow();

    const viaPreview = await preview({ release: RELEASE_ID, libraryRelease: RELEASE_ID });
    const viaCompiled = await compiled({ release: RELEASE_ID, libraryRelease: RELEASE_ID });

    expect(viaPreview.status).toBe(400);
    expect(viaCompiled.status).toBe(400);
  });
});
