// The closure upgrade HTTP surface on the workflows lambda (issue #482):
// PATCH /aidlc-releases/{releaseId} {expectedRevision, importerRevision}, the
// admin stale flag on GET /aidlc-releases, and the compose reads that let an
// intent pinned before an upgrade keep compiling its own closure.

import { readFileSync } from 'node:fs';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { filesFromCompatibilityFixture } from '../../shared/aidlc-compatibility.js';
import {
  AIDLC_RELEASE_IMPORTER_REVISION,
  buildReleaseBundle,
  publishReleaseBundle,
  releaseCatalogKey,
  releaseManifestKey,
} from '../../shared/aidlc-release.js';
import { __test as releaseResolverTest } from '../../shared/release-resolver.js';
import { legacyReleaseBundle } from '../../shared/test/fixtures/legacy-release.js';
import {
  installReleaseStoreFakes,
  keyOf,
  pointRecordAtLegacyClosure,
} from '../../shared/test/fixtures/release-store-fakes.js';

const BLOCKS_TABLE = 'blocks-test';
const ARTIFACTS_BUCKET = 'artifacts-test';
const PROFILE = 'v2.9.0';

const s3Mock = mockClient(S3Client);
const ddbMock = mockClient(DynamoDBDocumentClient);
const s3 = new S3Client({});
const objects = new Map();
const rows = new Map();

const currentBundle = buildReleaseBundle({
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
const legacyBundle = legacyReleaseBundle(currentBundle);
const RELEASE_ID = currentBundle.manifest.releaseId;
const SHA = currentBundle.manifest.sourceSha;

const adminClaims = { sub: 'admin-1', email: 'a@example.com', 'cognito:groups': 'platform-admin' };
const memberClaims = { sub: 'user-2', email: 'u@example.com' };

const event = ({
  method,
  resource,
  pathParameters = {},
  body,
  query = {},
  claims = adminClaims,
}) => ({
  httpMethod: method,
  resource: `/api${resource}`,
  path: `/api${resource}`,
  pathParameters,
  body: body === undefined ? null : JSON.stringify(body),
  queryStringParameters: query,
  requestContext: { authorizer: { claims } },
  headers: {},
});

let handler;
const parse = (res) => ({ status: res.statusCode, body: res.body ? JSON.parse(res.body) : null });

const patchRelease = async (body, claims = adminClaims) =>
  parse(
    await handler(
      event({
        method: 'PATCH',
        resource: '/aidlc-releases/{releaseId}',
        pathParameters: { releaseId: encodeURIComponent(RELEASE_ID) },
        body,
        claims,
      }),
    ),
  );

const listReleases = async (claims = adminClaims) =>
  parse(await handler(event({ method: 'GET', resource: '/aidlc-releases', claims })));

const compiled = async (query, claims = adminClaims) =>
  parse(
    await handler(
      event({
        method: 'GET',
        resource: '/workflows/{workflowId}/compiled',
        pathParameters: { workflowId: 'aidlc-v2' },
        query,
        claims,
      }),
    ),
  );

const currentRevision = async () =>
  (await listReleases()).body.releases.find((release) => release.releaseId === RELEASE_ID).revision;

const catalogReads = () =>
  s3Mock
    .commandCalls(GetObjectCommand)
    .map((call) => call.args[0].input.Key)
    .filter((key) => key.endsWith('/catalog.json'));

beforeAll(async () => {
  process.env.BLOCKS_TABLE = BLOCKS_TABLE;
  process.env.ARTIFACTS_BUCKET = ARTIFACTS_BUCKET;
  ({ handler } = await import('../index.js'));
});

beforeEach(async () => {
  installReleaseStoreFakes({ s3Mock, ddbMock, objects, rows });
  releaseResolverTest.releaseClosureCache.clear();
  await publishReleaseBundle({ s3, bucket: ARTIFACTS_BUCKET, bundle: currentBundle });
  await publishReleaseBundle({ s3, bucket: ARTIFACTS_BUCKET, bundle: legacyBundle });
  const registered = parse(
    await handler(
      event({ method: 'POST', resource: '/aidlc-releases', body: { profileId: PROFILE } }),
    ),
  );
  expect(registered.status).toBe(201);
  pointRecordAtLegacyClosure(rows, legacyBundle.manifest);
  rows.set(keyOf('WF#SYSTEM#aidlc-v2', 'META'), {
    pk: 'WF#SYSTEM#aidlc-v2',
    sk: 'META',
    workflowId: 'aidlc-v2',
    tenantId: 'SYSTEM',
    name: 'AI-DLC v2',
    version: 1,
  });
});

describe('GET /aidlc-releases stale flag', () => {
  it('tells an admin the current importer revision and which records are stale', async () => {
    const res = await listReleases();

    expect(res.status).toBe(200);
    expect(res.body.currentImporterRevision).toBe(AIDLC_RELEASE_IMPORTER_REVISION);
    expect(res.body.releases[0]).toMatchObject({ importerRevision: 1, importerStale: true });
  });

  it('tells a non-admin neither', async () => {
    const res = await listReleases(memberClaims);

    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('currentImporterRevision');
  });
});

describe('PATCH /aidlc-releases/{releaseId} {importerRevision}', () => {
  it('upgrades the closure and reports the audited record', async () => {
    const res = await patchRelease({
      expectedRevision: await currentRevision(),
      importerRevision: AIDLC_RELEASE_IMPORTER_REVISION,
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('upgraded');
    expect(res.body.release).toMatchObject({
      importerRevision: 2,
      importerStale: false,
      closureDigest: currentBundle.manifest.closureDigest,
      catalogKey: releaseCatalogKey({ sha: SHA, importerRevision: 2 }),
      manifestKey: releaseManifestKey({ sha: SHA, importerRevision: 2 }),
    });
    expect(res.body.release.importerHistory).toHaveLength(1);
    expect(res.body.release.importerHistory[0]).toMatchObject({
      from: { importerRevision: 1, closureDigest: legacyBundle.manifest.closureDigest },
      to: { importerRevision: 2, closureDigest: currentBundle.manifest.closureDigest },
      upgradedBy: 'admin-1',
    });
  });

  it('is idempotent on retry', async () => {
    const first = await patchRelease({
      expectedRevision: await currentRevision(),
      importerRevision: 2,
    });
    const again = await patchRelease({
      expectedRevision: first.body.release.revision,
      importerRevision: 2,
    });

    expect(again.status).toBe(200);
    expect(again.body.status).toBe('already-current');
    expect(again.body.release.revision).toBe(first.body.release.revision);
  });

  it('409s a stale expectedRevision', async () => {
    const res = await patchRelease({
      expectedRevision: (await currentRevision()) + 3,
      importerRevision: 2,
    });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('release_revision_conflict');
  });

  it('400s an unpublished target, a bad revision, and a mixed patch', async () => {
    const revision = await currentRevision();

    for (const [body, code] of [
      [
        { expectedRevision: revision, importerRevision: 'two' },
        'release_importer_revision_invalid',
      ],
      [{ expectedRevision: revision, importerRevision: 9 }, 'release_importer_revision_invalid'],
      [{ expectedRevision: revision, importerRevision: 2, visible: true }, 'release_state_invalid'],
    ]) {
      const res = await patchRelease(body);
      expect({ status: res.status, code: res.body.code }).toEqual({ status: 400, code });
    }

    objects.delete(releaseManifestKey({ sha: SHA, importerRevision: 2 }));
    const unpublished = await patchRelease({ expectedRevision: revision, importerRevision: 2 });
    expect({ status: unpublished.status, code: unpublished.body.code }).toEqual({
      status: 400,
      code: 'release_not_published',
    });
  });

  it('409s a manifest at the target revision that fails verification', async () => {
    const key = releaseManifestKey({ sha: SHA, importerRevision: 2 });
    objects.set(key, JSON.stringify({ ...currentBundle.manifest, closureDigest: 'a'.repeat(64) }));

    const res = await patchRelease({
      expectedRevision: await currentRevision(),
      importerRevision: 2,
    });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('release_conflict');
  });

  it('403s a non-admin', async () => {
    const res = await patchRelease(
      { expectedRevision: await currentRevision(), importerRevision: 2 },
      memberClaims,
    );

    expect(res.status).toBe(403);
  });
});

describe('compose reads after an upgrade', () => {
  beforeEach(async () => {
    const res = await patchRelease({
      expectedRevision: await currentRevision(),
      importerRevision: 2,
    });
    expect(res.status).toBe(200);
  });

  it("compiles an existing intent's i1 closure when it names its pin's revision", async () => {
    const before = catalogReads().length;
    const res = await compiled({ release: RELEASE_ID, releaseImporterRevision: '1' });

    expect(res.status).toBe(200);
    expect(catalogReads().slice(before)).toEqual([
      releaseCatalogKey({ sha: SHA, importerRevision: 1 }),
    ]);
  });

  it('compiles the current closure without the parameter', async () => {
    const before = catalogReads().length;
    const res = await compiled({ release: RELEASE_ID });

    expect(res.status).toBe(200);
    expect(catalogReads().slice(before)).toEqual([
      releaseCatalogKey({ sha: SHA, importerRevision: 2 }),
    ]);
  });

  it('404s a revision the record never pointed at and 400s a malformed one', async () => {
    const never = await compiled({ release: RELEASE_ID, releaseImporterRevision: '3' });
    expect({ status: never.status, code: never.body.code }).toEqual({
      status: 404,
      code: 'release_not_found',
    });

    const malformed = await compiled({ release: RELEASE_ID, releaseImporterRevision: 'x' });
    expect({ status: malformed.status, code: malformed.body.code }).toEqual({
      status: 400,
      code: 'release_importer_revision_invalid',
    });
  });
});
