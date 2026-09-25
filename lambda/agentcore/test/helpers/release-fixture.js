// A/B release fixtures for AgentCore release-mode tests.
//
// Same construction as lambda/shared/test/release-resolver.test.js: two real
// compatibility fixtures are published as releases A and B because they carry
// the same workflow id at the same numeric workflowVersion with materially
// different content — the drift a numeric version cannot distinguish. The
// DynamoDB fake is seeded from B, so ANY leak into the SYSTEM rows is visible.

import { readFileSync } from 'node:fs';
import { mockClient } from 'aws-sdk-client-mock';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { filesFromCompatibilityFixture } from '../../../shared/aidlc-compatibility.js';
import { buildReleaseBundle, publishReleaseBundle } from '../../../shared/aidlc-release.js';
import {
  __test as releaseResolverTest,
  methodologyReleasePinFromManifest,
} from '../../../shared/release-resolver.js';

export const BUCKET = 'artifacts-test';
export const TABLE = 'blocks-test';
export const WORKFLOW_ID = 'aidlc-v2';
export const CONDUCTOR_REPO_PATH = 'core/aidlc-common/conductor.md';

const RELEASE_A = 'current-stable';
const RELEASE_B = 'v2.9.0';

const noSuchKey = () => {
  const error = new Error('The specified key does not exist.');
  error.name = 'NoSuchKey';
  error.$metadata = { httpStatusCode: 404 };
  return error;
};

const bundleFor = (profileId) =>
  buildReleaseBundle({
    profileId,
    files: filesFromCompatibilityFixture({
      profileId,
      fixture: JSON.parse(
        readFileSync(
          new URL(
            `../../../shared/test/fixtures/aidlc-compatibility/${profileId}.json`,
            import.meta.url,
          ),
          'utf8',
        ),
      ),
    }),
  });

// Parsing two full fixtures is the expensive part, so do it once per test file.
export const bundleA = bundleFor(RELEASE_A);
export const bundleB = bundleFor(RELEASE_B);
export const pinA = methodologyReleasePinFromManifest(bundleA.manifest);
export const pinB = methodologyReleasePinFromManifest(bundleB.manifest);

const systemBlockRows = Object.fromEntries(
  Object.entries(bundleB.catalog.blocks).map(([type, blocks]) => [
    type,
    blocks.map((block) => ({ ...block, GSI1PK: `TENANT#SYSTEM#${type}` })),
  ]),
);

const systemWorkflowRows = [
  {
    pk: `WF#SYSTEM#${WORKFLOW_ID}`,
    sk: 'V#1#META',
    version: 1,
    sourceRef: bundleB.manifest.sourceSha,
  },
  ...bundleB.catalog.workflow.placements.map((placement, index) => ({
    pk: `WF#SYSTEM#${WORKFLOW_ID}`,
    sk: `V#1#PLACEMENT#${placement.stageId}`,
    stageId: placement.stageId,
    stageTenant: placement.stageTenant,
    pinnedVersion: placement.pinnedVersion,
    order: placement.order ?? index,
    scopeMembership: placement.scopeMembership ?? {},
  })),
];

// Install the Map-backed S3 fake + the B-seeded DynamoDB fake, publish both
// releases, and clear the process-wide closure cache (immutable in production,
// so each test must start cold).
export const installReleaseFixtures = async () => {
  const s3Mock = mockClient(S3Client);
  const ddbMock = mockClient(DynamoDBDocumentClient);
  const s3 = new S3Client({});
  const store = new Map();
  const userBlockRows = new Map();

  s3Mock.on(PutObjectCommand).callsFake((input) => {
    store.set(input.Key, String(input.Body));
    return {};
  });
  s3Mock.on(GetObjectCommand).callsFake((input) => {
    if (!store.has(input.Key)) throw noSuchKey();
    return { Body: { transformToString: async () => store.get(input.Key) } };
  });
  ddbMock.on(GetCommand).callsFake((input) => ({
    Item: userBlockRows.get(`${input.Key.pk}|${input.Key.sk}`) ?? null,
  }));
  ddbMock.on(QueryCommand).callsFake((input) => {
    const pk = String(input.ExpressionAttributeValues?.[':pk'] ?? '');
    if (input.IndexName === 'GSI1') {
      const [, tenant, type] = pk.split('#');
      return { Items: tenant === 'SYSTEM' ? (systemBlockRows[type] ?? []) : [] };
    }
    if (pk === `WF#SYSTEM#${WORKFLOW_ID}`) return { Items: systemWorkflowRows };
    return { Items: [] };
  });

  releaseResolverTest.releaseClosureCache.clear();
  process.env.ARTIFACTS_BUCKET = BUCKET;
  process.env.BLOCKS_TABLE = TABLE;
  for (const bundle of [bundleA, bundleB]) {
    await publishReleaseBundle({ s3, bucket: BUCKET, bundle });
  }

  const pksTouchingSystem = () =>
    [
      ...ddbMock
        .commandCalls(QueryCommand)
        .map((call) => String(call.args[0].input.ExpressionAttributeValues?.[':pk'] ?? '')),
      ...ddbMock.commandCalls(GetCommand).map((call) => String(call.args[0].input.Key?.pk ?? '')),
    ].filter((pk) => pk.includes('SYSTEM'));

  return { s3Mock, ddbMock, store, userBlockRows, pksTouchingSystem };
};

export const conductorEntry = (bundle) =>
  bundle.manifest.runtimeFiles.find((file) => file.path === CONDUCTOR_REPO_PATH);
