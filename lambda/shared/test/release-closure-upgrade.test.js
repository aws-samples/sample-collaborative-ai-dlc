// The closure upgrade path (issue #482): a release registered against an older
// importer revision's closure is moved onto the corrected closure of the SAME
// source SHA. Existing intents keep resolving the closure they pinned; only new
// intents pin the upgraded one.

import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { S3Client } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { RUNTIME_HANDLERS } from '../aidlc-capabilities.js';
import { filesFromCompatibilityFixture } from '../aidlc-compatibility.js';
import {
  AIDLC_RELEASE_IMPORTER_REVISION,
  buildReleaseBundle,
  publishReleaseBundle,
  readReleaseManifest,
  releaseCatalogKey,
  releaseManifestKey,
} from '../aidlc-release.js';
import {
  getRelease,
  listRegistrableProfiles,
  listReleases,
  registerRelease,
  releasePinFromRecord,
  resolveSelectableRelease,
  setChannel,
  updateRelease,
  upgradeReleaseClosure,
} from '../release-registry.js';
import { loadReleaseClosure } from '../release-resolver.js';
import { sha256 } from '../blocks.js';
import { canonicalJson } from '../workflow-checkpoint.js';
import { countAuthored, legacyReleaseBundle } from './fixtures/legacy-release.js';
import {
  installReleaseStoreFakes,
  keyOf,
  pointRecordAtLegacyClosure,
} from './fixtures/release-store-fakes.js';

const BUCKET = 'artifacts-test';
const TABLE = 'blocks-test';
const PROFILE = RUNTIME_HANDLERS.has('stage.mode.ensemble-sessions@v1')
  ? 'v2.9.0'
  : 'current-stable';

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
        new URL(`./fixtures/aidlc-compatibility/${PROFILE}.json`, import.meta.url),
        'utf8',
      ),
    ),
  }),
});
const legacyBundle = legacyReleaseBundle(currentBundle);
const RELEASE_ID = currentBundle.manifest.releaseId;
const SHA = currentBundle.manifest.sourceSha;

const registryArgs = () => ({ ddb: ddbMock, tableName: TABLE });
const storageArgs = () => ({ ...registryArgs(), s3, bucket: BUCKET });

const upgrade = (expectedRevision, importerRevision = AIDLC_RELEASE_IMPORTER_REVISION) =>
  upgradeReleaseClosure({
    ...storageArgs(),
    releaseId: RELEASE_ID,
    expectedRevision,
    importerRevision,
    actor: 'admin-1',
  });

const record = () => getRelease({ ...registryArgs(), releaseId: RELEASE_ID });

const addUnsupportedModeToCurrentClosure = () => {
  const manifestKey = releaseManifestKey({ sha: SHA, importerRevision: 2 });
  const manifest = JSON.parse(objects.get(manifestKey));
  const catalog = JSON.parse(objects.get(manifest.catalog.key));
  catalog.blocks.STAGE[0].mode = 'agent-team';
  const catalogBody = `${JSON.stringify(catalog, null, 2)}\n`;
  objects.set(manifest.catalog.key, catalogBody);
  const { closureDigest: _closureDigest, ...base } = manifest;
  const next = {
    ...base,
    catalog: {
      ...base.catalog,
      sha256: sha256(canonicalJson(catalog)),
      bytes: Buffer.byteLength(catalogBody),
    },
  };
  objects.set(
    manifestKey,
    `${JSON.stringify({ ...next, closureDigest: sha256(canonicalJson(next)) }, null, 2)}\n`,
  );
};

// The post-deploy, pre-upgrade world: both closures are published (the operator
// re-imported at revision 2), but the record still points at the revision-1
// closure it was registered against before the importer bump.
const registerLegacy = async () => {
  await publishReleaseBundle({ s3, bucket: BUCKET, bundle: currentBundle });
  await registerRelease({ ...storageArgs(), profileId: PROFILE, actor: 'admin-0' });
  await publishReleaseBundle({ s3, bucket: BUCKET, bundle: legacyBundle });
  pointRecordAtLegacyClosure(rows, legacyBundle.manifest);
};

const makeSelectable = async () => {
  const key = keyOf(`AIDLC_RELEASE#${RELEASE_ID}`, 'META');
  // The upgrade assertions exercise closure-revision coexistence. Model a
  // catalog whose authored values are handled so the independent promotion
  // guard does not mask those transitions; its refusal path is covered in the
  // registry tests.
  rows.set(key, { ...rows.get(key), fidelityGaps: [] });
  const stated = await updateRelease({
    ...registryArgs(),
    releaseId: RELEASE_ID,
    expectedRevision: (await record()).revision,
    patch: { supportState: 'certified' },
    actor: 'admin-1',
  });
  return updateRelease({
    ...registryArgs(),
    releaseId: RELEASE_ID,
    expectedRevision: stated.revision,
    patch: { visible: true },
    actor: 'admin-1',
  });
};

beforeEach(async () => {
  installReleaseStoreFakes({ s3Mock, ddbMock, objects, rows });
  await registerLegacy();
});

describe('importer revisions coexist', () => {
  it('keeps both closures published, distinct, and resolvable', async () => {
    const i1 = await readReleaseManifest({ s3, bucket: BUCKET, sha: SHA, importerRevision: 1 });
    const i2 = await readReleaseManifest({ s3, bucket: BUCKET, sha: SHA, importerRevision: 2 });

    expect(i1.closureDigest).toBe(legacyBundle.manifest.closureDigest);
    expect(i2.closureDigest).toBe(currentBundle.manifest.closureDigest);
    expect(i1.catalog.key).toBe(releaseCatalogKey({ sha: SHA, importerRevision: 1 }));
    expect(i2.catalog.key).toBe(releaseCatalogKey({ sha: SHA, importerRevision: 2 }));
    expect(countAuthored(JSON.parse(objects.get(i1.catalog.key)), 'STAGE', 'reviewClass')).toBe(0);
    expect(countAuthored(JSON.parse(objects.get(i2.catalog.key)), 'STAGE', 'reviewClass')).toBe(
      PROFILE === 'current-stable' ? 0 : 8,
    );
  });

  it('re-publishes revision 2 idempotently without touching revision 1', async () => {
    const i1Keys = [
      releaseManifestKey({ sha: SHA, importerRevision: 1 }),
      releaseCatalogKey({ sha: SHA, importerRevision: 1 }),
    ];
    const before = i1Keys.map((key) => objects.get(key));

    const again = await publishReleaseBundle({ s3, bucket: BUCKET, bundle: currentBundle });

    expect(again.status).toBe('already-published');
    expect(i1Keys.map((key) => objects.get(key))).toEqual(before);
  });
});

describe('stale detection', () => {
  it('marks a record on an older importer revision as stale, and clears it once upgraded', async () => {
    const [stale] = await listReleases(registryArgs());
    expect(stale).toMatchObject({
      releaseId: RELEASE_ID,
      importerRevision: 1,
      importerStale: true,
    });

    await upgrade(stale.revision);

    const [fresh] = await listReleases(registryArgs());
    expect(fresh).toMatchObject({ importerRevision: 2, importerStale: false });
  });

  it('flags the stale registration on the admin profile listing too', async () => {
    const profiles = await listRegistrableProfiles(storageArgs());
    expect(profiles.find((profile) => profile.profileId === PROFILE)).toMatchObject({
      published: true,
      registered: true,
      importerRevision: AIDLC_RELEASE_IMPORTER_REVISION,
      registeredImporterRevision: 1,
      importerStale: true,
    });
  });

  it('never exposes the stale flag or the history to a non-admin projection', async () => {
    await makeSelectable();
    const [selection] = await listReleases({ ...registryArgs(), visibleOnly: true });
    expect(selection).not.toHaveProperty('importerStale');
    expect(selection).not.toHaveProperty('importerHistory');
  });

  it('keeps a stale release selectable for new intents (allowed, but surfaced)', async () => {
    await makeSelectable();
    const selected = await resolveSelectableRelease({ ...registryArgs(), releaseId: RELEASE_ID });
    expect(selected).toMatchObject({ importerRevision: 1, importerStale: true });
  });
});

describe('upgradeReleaseClosure', () => {
  it('moves the pointer under CAS and audits the previous and new closure', async () => {
    const before = await record();

    const result = await upgrade(before.revision);

    expect(result.status).toBe('upgraded');
    const after = await record();
    expect(after).toMatchObject({
      importerRevision: 2,
      closureDigest: currentBundle.manifest.closureDigest,
      manifestKey: releaseManifestKey({ sha: SHA, importerRevision: 2 }),
      catalogKey: releaseCatalogKey({ sha: SHA, importerRevision: 2 }),
      revision: before.revision + 1,
      updatedBy: 'admin-1',
      // A pointer move is not a support decision.
      supportState: before.supportState,
      visible: before.visible,
      runnable: before.runnable,
      registeredBy: 'admin-0',
    });
    expect(after.importerHistory).toEqual([
      {
        from: {
          importerRevision: 1,
          closureDigest: legacyBundle.manifest.closureDigest,
          manifestKey: releaseManifestKey({ sha: SHA, importerRevision: 1 }),
          catalogKey: releaseCatalogKey({ sha: SHA, importerRevision: 1 }),
        },
        to: {
          importerRevision: 2,
          closureDigest: currentBundle.manifest.closureDigest,
          manifestKey: releaseManifestKey({ sha: SHA, importerRevision: 2 }),
          catalogKey: releaseCatalogKey({ sha: SHA, importerRevision: 2 }),
        },
        upgradedAt: expect.any(String),
        upgradedBy: 'admin-1',
      },
    ]);
  });

  it('refuses a stale expectedRevision and leaves the record untouched', async () => {
    const before = await record();

    await expect(upgrade(before.revision + 7)).rejects.toMatchObject({
      code: 'release_revision_conflict',
    });
    expect(await record()).toEqual(before);
  });

  it('conditions the write on BOTH the record revision and the importer revision it replaces', async () => {
    const before = await record();

    await upgrade(before.revision);

    const [put] = ddbMock
      .commandCalls(PutCommand)
      .map((call) => call.args[0].input)
      .slice(-1);
    expect(put.ConditionExpression).toBe(
      'revision = :expected AND importerRevision = :fromImporter',
    );
    expect(put.ExpressionAttributeValues).toEqual({
      ':expected': before.revision,
      ':fromImporter': 1,
    });
  });

  it('is an idempotent no-op when the record is already on that revision', async () => {
    const first = await upgrade((await record()).revision);
    const settled = await record();

    const again = await upgrade(first.release.revision);

    expect(again.status).toBe('already-current');
    expect(await record()).toEqual(settled);
  });

  it('upgrades an official record registered before sourceRepository was stamped', async () => {
    const key = [...rows.keys()].find((k) => rows.get(k)?.releaseId === RELEASE_ID);
    rows.set(key, { ...rows.get(key), sourceRepository: null });

    const result = await upgrade((await record()).revision);

    expect(result.status).toBe('upgraded');
    expect(await record()).toMatchObject({
      importerRevision: 2,
      sourceRepository: currentBundle.manifest.sourceRepository,
    });
  });

  it('only moves forward, and never past the running importer', async () => {
    await upgrade((await record()).revision);
    const current = await record();

    await expect(upgrade(current.revision, 1)).rejects.toMatchObject({
      code: 'release_importer_revision_invalid',
    });
    await expect(
      upgrade(current.revision, AIDLC_RELEASE_IMPORTER_REVISION + 1),
    ).rejects.toMatchObject({ code: 'release_importer_revision_invalid' });
    await expect(upgrade(current.revision, 0)).rejects.toMatchObject({
      code: 'release_importer_revision_invalid',
    });
  });

  it('refuses when the target revision is not published', async () => {
    objects.delete(releaseManifestKey({ sha: SHA, importerRevision: 2 }));

    await expect(upgrade((await record()).revision)).rejects.toMatchObject({
      code: 'release_not_published',
    });
    expect((await record()).importerRevision).toBe(1);
  });

  it('fails closed on a tampered or foreign manifest at the target revision', async () => {
    const key = releaseManifestKey({ sha: SHA, importerRevision: 2 });
    const { closureDigest: _digest, ...base } = currentBundle.manifest;
    const foreign = { ...base, releaseId: 'aidlc:someone-else' };
    objects.set(key, JSON.stringify({ ...foreign, closureDigest: sha256(canonicalJson(foreign)) }));
    await expect(upgrade((await record()).revision)).rejects.toMatchObject({
      code: 'release_conflict',
    });

    objects.set(key, JSON.stringify({ ...currentBundle.manifest, closureDigest: 'f'.repeat(64) }));
    await expect(upgrade((await record()).revision)).rejects.toMatchObject({
      code: 'release_conflict',
    });
    expect((await record()).importerRevision).toBe(1);
  });

  it('refuses to move a structurally valid record onto a closure that is not', async () => {
    const key = releaseManifestKey({ sha: SHA, importerRevision: 2 });
    const { closureDigest: _digest, ...base } = currentBundle.manifest;
    const invalid = {
      ...base,
      compatibility: { ...base.compatibility, structurallyValid: false },
    };
    objects.set(key, JSON.stringify({ ...invalid, closureDigest: sha256(canonicalJson(invalid)) }));

    await expect(upgrade((await record()).revision)).rejects.toMatchObject({
      code: 'release_not_selectable',
    });
  });

  it('refuses to upgrade a selectable record to a closure with unhonoured values', async () => {
    const selectable = await makeSelectable();
    addUnsupportedModeToCurrentClosure();

    await expect(upgrade(selectable.revision)).rejects.toMatchObject({
      code: 'release_capability_unhandled',
      details: {
        gaps: [{ blockType: 'STAGE', field: 'mode', value: 'agent-team' }],
      },
    });
    expect(await record()).toMatchObject({ importerRevision: 1, supportState: 'certified' });
  });

  it('keeps a channel target satisfied: stable may be upgraded in place', async () => {
    const selectable = await makeSelectable();
    await setChannel({
      ...registryArgs(),
      channel: 'stable',
      releaseId: RELEASE_ID,
      expectedRevision: null,
      actor: 'admin-1',
    });

    const result = await upgrade(selectable.revision);

    expect(result.release).toMatchObject({ supportState: 'certified', importerRevision: 2 });
    const stable = await resolveSelectableRelease(registryArgs());
    expect(releasePinFromRecord(stable).importerRevision).toBe(2);
  });

  it('404s an unregistered release', async () => {
    await expect(
      upgradeReleaseClosure({
        ...storageArgs(),
        releaseId: 'aidlc:not-registered',
        expectedRevision: 1,
        importerRevision: 2,
      }),
    ).rejects.toMatchObject({ code: 'release_not_found' });
  });
});

describe('pins survive the upgrade', () => {
  it('keeps an existing intent on its i1 closure while a new intent pins i2', async () => {
    await makeSelectable();
    const existingPin = releasePinFromRecord(
      await resolveSelectableRelease({ ...registryArgs(), releaseId: RELEASE_ID }),
    );
    expect(existingPin.importerRevision).toBe(1);

    await upgrade((await record()).revision);

    // The resolver reads the intent's PERSISTED pin straight from S3; the
    // registry's new pointer is never consulted.
    const existing = await loadReleaseClosure({
      s3,
      bucket: BUCKET,
      methodologyRelease: existingPin,
      cache: new Map(),
    });
    expect(existing).toMatchObject({
      importerRevision: 1,
      closureDigest: legacyBundle.manifest.closureDigest,
    });
    expect(countAuthored(existing.catalog, 'STAGE', 'summaryConfirmation')).toBe(0);

    const newPin = releasePinFromRecord(
      await resolveSelectableRelease({ ...registryArgs(), releaseId: RELEASE_ID }),
    );
    expect(newPin).toEqual({
      releaseId: RELEASE_ID,
      sourceSha: SHA,
      importerRevision: 2,
      closureDigest: currentBundle.manifest.closureDigest,
      catalogKey: releaseCatalogKey({ sha: SHA, importerRevision: 2 }),
      manifestKey: releaseManifestKey({ sha: SHA, importerRevision: 2 }),
    });
    const upgraded = await loadReleaseClosure({
      s3,
      bucket: BUCKET,
      methodologyRelease: newPin,
      cache: new Map(),
    });
    expect(countAuthored(upgraded.catalog, 'STAGE', 'summaryConfirmation')).toBe(
      PROFILE === 'current-stable' ? 0 : 27,
    );
  });

  it('fails closed rather than silently widening an i1 pin onto the i2 closure', async () => {
    const existingPin = releasePinFromRecord(await record());
    await upgrade((await record()).revision);

    await expect(
      loadReleaseClosure({
        s3,
        bucket: BUCKET,
        methodologyRelease: { ...existingPin, importerRevision: 2 },
        cache: new Map(),
      }),
    ).rejects.toMatchObject({ code: 'release_closure_mismatch' });
  });
});
