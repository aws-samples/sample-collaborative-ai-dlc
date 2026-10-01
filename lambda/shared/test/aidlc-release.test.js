import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { filesFromCompatibilityFixture, blockTypeForPath } from '../aidlc-compatibility.js';
import { AIDLC_COMPATIBILITY_PROFILES, customProfile } from '../aidlc-compatibility-profiles.js';
import { canonicalJson } from '../workflow-checkpoint.js';
import {
  AIDLC_RELEASE_IMPORTER_REVISION,
  AIDLC_RELEASE_SCHEMA_VERSION,
  buildReleaseBundle,
  collectReleaseObjects,
  publishReleaseBundle,
  readReleaseManifest,
  releaseCatalogKey,
  releaseKeyArgs,
  releaseKeyPrefix,
  releaseManifestKey,
  runtimeObjectKey,
  validateReleaseManifest,
} from '../aidlc-release.js';

const BUCKET = 'artifacts-test';

const fixtureFor = (profileId) =>
  JSON.parse(
    readFileSync(
      new URL(`./fixtures/aidlc-compatibility/${profileId}.json`, import.meta.url),
      'utf8',
    ),
  );

const filesFor = (profileId) =>
  filesFromCompatibilityFixture({ profileId, fixture: fixtureFor(profileId) });

const s3Mock = mockClient(S3Client);
const s3 = new S3Client({});
const store = new Map();

const preconditionFailed = () => {
  const error = new Error('At least one of the pre-conditions you specified did not hold');
  error.name = 'PreconditionFailed';
  error.$metadata = { httpStatusCode: 412 };
  return error;
};

const noSuchKey = () => {
  const error = new Error('The specified key does not exist.');
  error.name = 'NoSuchKey';
  error.$metadata = { httpStatusCode: 404 };
  return error;
};

const installS3Fake = () => {
  s3Mock.reset();
  store.clear();
  s3Mock.on(PutObjectCommand).callsFake((input) => {
    if (input.IfNoneMatch === '*' && store.has(input.Key)) throw preconditionFailed();
    store.set(input.Key, String(input.Body));
    return {};
  });
  s3Mock.on(GetObjectCommand).callsFake((input) => {
    if (!store.has(input.Key)) throw noSuchKey();
    return { Body: { transformToString: async () => store.get(input.Key) } };
  });
};

const putKeysInOrder = () =>
  s3Mock.commandCalls(PutObjectCommand).map((call) => call.args[0].input.Key);

const STABLE = 'current-stable';
const NEXT = 'v2.9.0';

beforeEach(() => {
  installS3Fake();
});

describe('release key layout', () => {
  const sha = AIDLC_COMPATIBILITY_PROFILES[STABLE].upstreamRef;

  it('scopes every release under its exact source SHA and importer revision', () => {
    expect(releaseKeyPrefix({ sha, importerRevision: 1 })).toBe(`aidlc-releases/v1/${sha}/i1`);
    expect(releaseManifestKey({ sha })).toBe(
      `aidlc-releases/v1/${sha}/i${AIDLC_RELEASE_IMPORTER_REVISION}/manifest.json`,
    );
    expect(releaseCatalogKey({ sha })).toBe(
      `aidlc-releases/v1/${sha}/i${AIDLC_RELEASE_IMPORTER_REVISION}/catalog.json`,
    );
    expect(releaseKeyPrefix({ sha, importerRevision: 2 })).toBe(`aidlc-releases/v1/${sha}/i2`);
  });

  it('rejects anything that is not a full SHA or a positive importer revision', () => {
    expect(() => releaseKeyPrefix({ sha: 'main' })).toThrow(/commit SHA/);
    expect(() => releaseKeyPrefix({ sha: sha.slice(0, 7) })).toThrow(/commit SHA/);
    expect(() => releaseKeyPrefix({ sha, importerRevision: 0 })).toThrow(/positive integer/);
    expect(() => releaseKeyPrefix({ sha, importerRevision: 1.5 })).toThrow(/positive integer/);
  });

  it('content-addresses runtime objects outside any per-commit prefix', () => {
    expect(runtimeObjectKey('a'.repeat(64))).toBe(
      `aidlc-releases/v1/runtime/sha256/${'a'.repeat(64)}`,
    );
    expect(() => runtimeObjectKey('nope')).toThrow(/sha256/);
  });
});

describe('buildReleaseBundle', () => {
  it('is deterministic: the same input yields a byte-identical manifest', () => {
    const first = buildReleaseBundle({ profileId: STABLE, files: filesFor(STABLE) });
    const second = buildReleaseBundle({ profileId: STABLE, files: filesFor(STABLE) });

    expect(canonicalJson(second.manifest)).toBe(canonicalJson(first.manifest));
    expect(second.manifest.closureDigest).toBe(first.manifest.closureDigest);
    expect(JSON.stringify(second.manifest)).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it('records the profile identity, catalog digest and sorted object set', () => {
    const profile = AIDLC_COMPATIBILITY_PROFILES[STABLE];
    const { manifest, catalog, objects } = buildReleaseBundle({
      profileId: STABLE,
      files: filesFor(STABLE),
    });

    expect(manifest).toMatchObject({
      schemaVersion: AIDLC_RELEASE_SCHEMA_VERSION,
      importerRevision: AIDLC_RELEASE_IMPORTER_REVISION,
      releaseId: profile.releaseId,
      sourceRepository: 'awslabs/aidlc-workflows',
      sourceSha: profile.upstreamRef,
      profileId: profile.id,
      upstreamVersion: profile.upstreamVersion,
      upstreamChannel: profile.upstreamChannel,
      trustTier: profile.trustTier,
      frontmatterDialect: profile.frontmatterDialect,
    });
    expect(catalog.ref).toBe(profile.upstreamRef);
    expect(manifest.catalog.key).toBe(releaseCatalogKey({ sha: profile.upstreamRef }));
    expect(manifest.compatibility.structurallyValid).toBe(true);
    expect(manifest.compatibility.scopes.length).toBeGreaterThan(0);
    expect(manifest.compatibility.executionRelevantUnmappedFields).toStrictEqual(
      [...manifest.compatibility.executionRelevantUnmappedFields].toSorted(),
    );

    const keys = manifest.objects.map((object) => object.key);
    expect(keys).toStrictEqual([...keys].toSorted());
    expect(new Set(keys).size).toBe(keys.length);
    expect(objects.map((object) => object.key)).toStrictEqual(keys);
    expect(new Set(manifest.objects.map((object) => object.role))).toStrictEqual(
      new Set(['body', 'script', 'runtime']),
    );
    expect(manifest.runtimeFiles.length).toBeGreaterThan(0);
    for (const runtimeFile of manifest.runtimeFiles) {
      expect(runtimeFile.key).toBe(runtimeObjectKey(runtimeFile.sha256));
    }
    expect(validateReleaseManifest(manifest)).toBe(manifest);
  });

  it('rejects an unknown profile instead of trusting an arbitrary ref', () => {
    for (const profileId of ['main', 'v2.9', '__proto__', undefined]) {
      expect(() => buildReleaseBundle({ profileId, files: filesFor(STABLE) })).toThrowError(
        expect.objectContaining({ code: 'release_profile_unknown' }),
      );
    }
  });

  it('fails closed with diagnostics when the source is not structurally importable', () => {
    const files = filesFor(STABLE);
    const blockPath = [...files.keys()].find((path) => blockTypeForPath(path));
    files.set(blockPath, '# no frontmatter at all\n');

    let caught = null;
    try {
      buildReleaseBundle({ profileId: STABLE, files });
    } catch (error) {
      caught = error;
    }
    expect(caught?.code).toBe('release_import_rejected');
    expect(caught.diagnostics.length).toBeGreaterThan(0);
    expect(caught.diagnostics.some((diagnostic) => diagnostic.path === blockPath)).toBe(true);
  });

  it('applies the 2.8+ frontmatter normalization so sensor commands survive import', () => {
    const { catalog } = buildReleaseBundle({ profileId: NEXT, files: filesFor(NEXT) });
    const sensors = catalog.blocks.SENSOR;

    expect(sensors.length).toBeGreaterThan(0);
    for (const sensor of sensors) {
      expect(typeof sensor.command).toBe('string');
      expect(sensor.command.trim()).not.toBe('');
    }
  });
});

describe('collectReleaseObjects', () => {
  const entry = (overrides) => ({
    key: 'blocks/bodies/sha256/aaa',
    body: 'one',
    contentType: 'text/markdown',
    role: 'body',
    ...overrides,
  });

  it('deduplicates repeated identical content under one key', () => {
    const objects = collectReleaseObjects([
      entry({}),
      entry({}),
      entry({ key: 'other', body: 'x' }),
    ]);
    expect(objects.map((object) => object.key)).toStrictEqual([
      'blocks/bodies/sha256/aaa',
      'other',
    ]);
  });

  it('throws when one key would carry two different contents', () => {
    expect(() => collectReleaseObjects([entry({}), entry({ body: 'two' })])).toThrowError(
      expect.objectContaining({ code: 'release_object_conflict' }),
    );
  });

  it('throws when an entry has no string body', () => {
    expect(() => collectReleaseObjects([entry({ body: null })])).toThrowError(
      expect.objectContaining({ code: 'release_object_invalid' }),
    );
  });
});

describe('publishReleaseBundle', () => {
  const bundleFor = (profileId = STABLE) =>
    buildReleaseBundle({ profileId, files: filesFor(profileId) });

  it('writes content, then the catalog, and the manifest last', async () => {
    const bundle = bundleFor();
    const result = await publishReleaseBundle({ s3, bucket: BUCKET, bundle });

    expect(result).toMatchObject({
      status: 'published',
      releaseId: bundle.manifest.releaseId,
      manifestKey: releaseManifestKey({ sha: bundle.manifest.sourceSha }),
      closureDigest: bundle.manifest.closureDigest,
      objectCount: bundle.objects.length,
    });

    const keys = putKeysInOrder();
    expect(keys.at(-1)).toBe(result.manifestKey);
    expect(keys.at(-2)).toBe(bundle.manifest.catalog.key);
    expect(keys.filter((key) => key === result.manifestKey)).toHaveLength(1);
    for (const object of bundle.objects) {
      expect(keys.indexOf(object.key)).toBeLessThan(keys.indexOf(bundle.manifest.catalog.key));
      expect(store.get(object.key)).toBe(object.body);
    }
    expect(JSON.parse(store.get(result.manifestKey)).closureDigest).toBe(result.closureDigest);
    expect(store.get(result.manifestKey).endsWith('\n')).toBe(true);
  });

  it('tolerates a 412 on an already-stored content object', async () => {
    const bundle = bundleFor();
    const shared = bundle.objects[0];
    store.set(shared.key, shared.body);

    const result = await publishReleaseBundle({ s3, bucket: BUCKET, bundle });
    expect(result.status).toBe('published');
  });

  it('throws release_conflict when the catalog key holds different content', async () => {
    const bundle = bundleFor();
    store.set(bundle.manifest.catalog.key, '{"ref":"someone-elses-release"}\n');

    await expect(publishReleaseBundle({ s3, bucket: BUCKET, bundle })).rejects.toThrowError(
      expect.objectContaining({ code: 'release_conflict' }),
    );
    expect(store.has(releaseManifestKey({ sha: bundle.manifest.sourceSha }))).toBe(false);
  });

  it('never writes the manifest when read-back verification fails', async () => {
    const bundle = bundleFor();
    const tampered = bundle.objects[0];
    store.set(tampered.key, 'tampered bytes');

    let caught = null;
    try {
      await publishReleaseBundle({ s3, bucket: BUCKET, bundle });
    } catch (error) {
      caught = error;
    }
    expect(caught?.code).toBe('release_verification_failed');
    expect(caught.keys).toStrictEqual([tampered.key]);
    expect(store.has(releaseManifestKey({ sha: bundle.manifest.sourceSha }))).toBe(false);
    expect(putKeysInOrder()).not.toContain(releaseManifestKey({ sha: bundle.manifest.sourceSha }));
  });

  it('detects a tampered catalog during verification', async () => {
    const bundle = bundleFor();
    store.set(bundle.manifest.catalog.key, 'not even json');

    await expect(publishReleaseBundle({ s3, bucket: BUCKET, bundle })).rejects.toThrowError(
      expect.objectContaining({ code: 'release_conflict' }),
    );
  });

  it('is idempotent: republishing the same bundle reports already-published', async () => {
    const bundle = bundleFor();
    await publishReleaseBundle({ s3, bucket: BUCKET, bundle });
    const before = new Map(store);

    const again = await publishReleaseBundle({ s3, bucket: BUCKET, bundle });
    expect(again.status).toBe('already-published');
    expect([...store.keys()].toSorted()).toStrictEqual([...before.keys()].toSorted());
  });

  it('throws release_conflict when the manifest key already holds another release', async () => {
    const bundle = bundleFor();
    const manifestKey = releaseManifestKey({ sha: bundle.manifest.sourceSha });
    store.set(manifestKey, '{"schemaVersion":1}\n');

    await expect(publishReleaseBundle({ s3, bucket: BUCKET, bundle })).rejects.toThrowError(
      expect.objectContaining({ code: 'release_conflict' }),
    );
  });

  it('refuses to publish a bundle whose manifest does not validate', async () => {
    const bundle = bundleFor();
    bundle.manifest.closureDigest = 'f'.repeat(64);

    await expect(publishReleaseBundle({ s3, bucket: BUCKET, bundle })).rejects.toThrowError(
      expect.objectContaining({ code: 'release_manifest_invalid' }),
    );
    expect(putKeysInOrder()).toHaveLength(0);
  });
});

describe('readReleaseManifest', () => {
  it('returns null when the release was never published', async () => {
    const sha = AIDLC_COMPATIBILITY_PROFILES[STABLE].upstreamRef;
    await expect(readReleaseManifest({ s3, bucket: BUCKET, sha })).resolves.toBeNull();
  });

  it('round-trips a published manifest', async () => {
    const bundle = buildReleaseBundle({ profileId: STABLE, files: filesFor(STABLE) });
    await publishReleaseBundle({ s3, bucket: BUCKET, bundle });

    const manifest = await readReleaseManifest({
      s3,
      bucket: BUCKET,
      sha: bundle.manifest.sourceSha,
    });
    expect(canonicalJson(manifest)).toBe(canonicalJson(bundle.manifest));
  });

  it('rejects a stored manifest whose closureDigest was tampered with', async () => {
    const bundle = buildReleaseBundle({ profileId: STABLE, files: filesFor(STABLE) });
    await publishReleaseBundle({ s3, bucket: BUCKET, bundle });
    const manifestKey = releaseManifestKey({ sha: bundle.manifest.sourceSha });
    const tampered = { ...JSON.parse(store.get(manifestKey)), trustTier: 'T3' };
    store.set(manifestKey, `${JSON.stringify(tampered, null, 2)}\n`);

    await expect(
      readReleaseManifest({ s3, bucket: BUCKET, sha: bundle.manifest.sourceSha }),
    ).rejects.toThrowError(expect.objectContaining({ code: 'release_manifest_invalid' }));
  });

  // ── Release validation and projection ──

  it('refuses a manifest whose provenance does not match the key it was read from', async () => {
    // A valid, self-consistent manifest for release A is placed at release B's
    // key. Every internal digest still checks out, so only an explicit
    // key-vs-bytes assertion can catch the swap.
    const bundleA = buildReleaseBundle({ profileId: STABLE, files: filesFor(STABLE) });
    await publishReleaseBundle({ s3, bucket: BUCKET, bundle: bundleA });
    const otherSha = 'b'.repeat(40);
    store.set(
      releaseManifestKey({ sha: otherSha }),
      `${JSON.stringify(bundleA.manifest, null, 2)}\n`,
    );

    await expect(readReleaseManifest({ s3, bucket: BUCKET, sha: otherSha })).rejects.toThrowError(
      expect.objectContaining({ code: 'release_manifest_invalid' }),
    );
    // The honest key still resolves, so the assertion rejects the swap and not
    // the release itself.
    await expect(
      readReleaseManifest({ s3, bucket: BUCKET, sha: bundleA.manifest.sourceSha }),
    ).resolves.toMatchObject({ releaseId: bundleA.manifest.releaseId });
  });

  it('refuses a manifest read at a mismatched importer revision', async () => {
    const bundle = buildReleaseBundle({ profileId: STABLE, files: filesFor(STABLE) });
    await publishReleaseBundle({ s3, bucket: BUCKET, bundle });
    // Current-revision bytes parked under the NEXT revision's prefix: a
    // re-import under new adapter semantics must not be served as if it were
    // the old one.
    const nextRevision = AIDLC_RELEASE_IMPORTER_REVISION + 1;
    store.set(
      releaseManifestKey({ sha: bundle.manifest.sourceSha, importerRevision: nextRevision }),
      `${JSON.stringify(bundle.manifest, null, 2)}\n`,
    );

    await expect(
      readReleaseManifest({
        s3,
        bucket: BUCKET,
        sha: bundle.manifest.sourceSha,
        importerRevision: nextRevision,
      }),
    ).rejects.toThrowError(expect.objectContaining({ code: 'release_manifest_invalid' }));
  });

  it('refuses a manifest whose declared length exceeds the cap, without buffering it', async () => {
    const bundle = buildReleaseBundle({ profileId: STABLE, files: filesFor(STABLE) });
    await publishReleaseBundle({ s3, bucket: BUCKET, bundle });
    const manifestKey = releaseManifestKey({ sha: bundle.manifest.sourceSha });
    let drained = false;
    s3Mock.on(GetObjectCommand).callsFake((input) => {
      if (!store.has(input.Key)) throw noSuchKey();
      return {
        ContentLength: input.Key === manifestKey ? 20 * 1024 * 1024 + 1 : undefined,
        Body: {
          transformToString: async () => {
            drained = true;
            return store.get(input.Key);
          },
        },
      };
    });

    await expect(
      readReleaseManifest({ s3, bucket: BUCKET, sha: bundle.manifest.sourceSha }),
    ).rejects.toThrowError(expect.objectContaining({ code: 'release_manifest_too_large' }));
    // The whole point of checking ContentLength is that the body never lands on
    // the heap, so a post-buffer check would not satisfy this.
    expect(drained).toBe(false);
  });

  // ── Release validation handles streamed content ──
  it('refuses an oversized manifest served with NO ContentLength', async () => {
    const bundle = buildReleaseBundle({ profileId: STABLE, files: filesFor(STABLE) });
    await publishReleaseBundle({ s3, bucket: BUCKET, bundle });
    const manifestKey = releaseManifestKey({ sha: bundle.manifest.sourceSha });
    const oversized = JSON.stringify({ pad: 'x'.repeat(20 * 1024 * 1024 + 1) });
    s3Mock.on(GetObjectCommand).callsFake((input) => {
      if (!store.has(input.Key)) throw noSuchKey();
      if (input.Key !== manifestKey) {
        return { Body: { transformToString: async () => store.get(input.Key) } };
      }
      // No ContentLength: the pre-flight check sees 0 and passes, so the cap can
      // only be enforced by counting bytes as the stream is consumed.
      return {
        Body: {
          async *[Symbol.asyncIterator]() {
            const buffer = Buffer.from(oversized, 'utf8');
            for (let offset = 0; offset < buffer.length; offset += 64 * 1024) {
              yield buffer.subarray(offset, offset + 64 * 1024);
            }
          },
        },
      };
    });

    await expect(
      readReleaseManifest({ s3, bucket: BUCKET, sha: bundle.manifest.sourceSha }),
    ).rejects.toThrowError(expect.objectContaining({ code: 'release_manifest_too_large' }));
  });
});

describe('validateReleaseManifest', () => {
  const valid = () => buildReleaseBundle({ profileId: STABLE, files: filesFor(STABLE) }).manifest;

  it('rejects a tampered closureDigest', () => {
    const manifest = { ...valid(), closureDigest: 'a'.repeat(64) };
    expect(() => validateReleaseManifest(manifest)).toThrowError(
      expect.objectContaining({ code: 'release_manifest_invalid' }),
    );
  });

  it('rejects an unsupported schema, a bad SHA, and unsorted object keys', () => {
    const manifest = valid();
    expect(() => validateReleaseManifest({ ...manifest, schemaVersion: 99 })).toThrow(
      /unsupported manifest schema/,
    );
    expect(() => validateReleaseManifest({ ...manifest, sourceSha: 'main' })).toThrow(
      /lowercase commit SHA/,
    );
    expect(() =>
      validateReleaseManifest({ ...manifest, objects: manifest.objects.toReversed() }),
    ).toThrow(/sorted and unique/);
    expect(() => validateReleaseManifest(null)).toThrow(/not an object/);
  });
});

// Custom fork releases (issue #482 follow-up). The properties under test: a
// fork's bytes live on a prefix that can never collide with the official layout,
// the manifest records its untrusted provenance, and an OFFICIAL manifest is
// byte-identical to what an existing importer revision already published.
describe('custom fork releases', () => {
  const SHA = '0123456789abcdef0123456789abcdef01234567';
  const forkProfile = (over = {}) =>
    customProfile({
      repository: 'acme/aidlc-fork',
      sha: SHA,
      baseProfileId: 'current-stable',
      ...over,
    });
  // A fork that has not diverged structurally from what it forked.
  const forkFiles = () => filesFor('current-stable');

  beforeEach(() => {
    installS3Fake();
  });

  it('keys custom bytes under a prefix that cannot collide with the official one', () => {
    const args = { sha: SHA, importerRevision: 1, custom: true, sourceRepository: 'acme/fork' };
    expect(releaseKeyPrefix(args)).toBe(
      `aidlc-releases/v${AIDLC_RELEASE_SCHEMA_VERSION}/custom/acme/fork/${SHA}/i1`,
    );
    expect(releaseManifestKey(args)).toBe(`${releaseKeyPrefix(args)}/manifest.json`);
    expect(releaseCatalogKey(args)).toBe(`${releaseKeyPrefix(args)}/catalog.json`);
    expect(releaseKeyPrefix({ sha: SHA, importerRevision: 1 })).toBe(
      `aidlc-releases/v${AIDLC_RELEASE_SCHEMA_VERSION}/${SHA}/i1`,
    );
    expect(releaseKeyPrefix(args).startsWith(releaseKeyPrefix({ sha: SHA }))).toBe(false);
  });

  it('refuses to key a custom prefix without a valid non-official repository', () => {
    for (const sourceRepository of ['awslabs/aidlc-workflows', 'acme/..', 'acme', '', null]) {
      expect(() =>
        releaseKeyPrefix({ sha: SHA, importerRevision: 1, custom: true, sourceRepository }),
      ).toThrow();
    }
  });

  it('records the fork repository, T0, and custom:true in the manifest', () => {
    const profile = forkProfile();
    const { manifest } = buildReleaseBundle({ profile, files: forkFiles() });

    expect(manifest).toMatchObject({
      releaseId: `aidlc-custom:acme/aidlc-fork@${SHA}`,
      sourceRepository: 'acme/aidlc-fork',
      sourceSha: SHA,
      profileId: profile.id,
      trustTier: 'T0',
      custom: true,
      baseProfileId: 'current-stable',
      upstreamChannel: 'custom',
    });
    expect(manifest.catalog.key).toBe(releaseCatalogKey(releaseKeyArgs(manifest)));
    expect(manifest.catalog.key).toContain('/custom/acme/aidlc-fork/');
    expect(manifest.compatibility.structurallyValid).toBe(true);
    expect(validateReleaseManifest(manifest)).toBe(manifest);
  });

  it('leaves an official manifest and its closure digest byte-identical', () => {
    const official = buildReleaseBundle({
      profileId: 'current-stable',
      files: filesFor('current-stable'),
    });

    expect(Object.hasOwn(official.manifest, 'custom')).toBe(false);
    expect(Object.hasOwn(official.manifest, 'baseProfileId')).toBe(false);
    expect(official.manifest.sourceRepository).toBe('awslabs/aidlc-workflows');
    expect(official.manifest.closureDigest).toBe(
      buildReleaseBundle({
        profile: AIDLC_COMPATIBILITY_PROFILES['current-stable'],
        files: filesFor('current-stable'),
      }).manifest.closureDigest,
    );
  });

  it('gives a fork a different release identity than the commit it forked', () => {
    const fork = buildReleaseBundle({ profile: forkProfile(), files: forkFiles() });
    const official = buildReleaseBundle({
      profileId: 'current-stable',
      files: filesFor('current-stable'),
    });

    expect(fork.manifest.releaseId).not.toBe(official.manifest.releaseId);
    expect(fork.manifest.closureDigest).not.toBe(official.manifest.closureDigest);
  });

  it('fails closed on a structurally invalid fork', () => {
    const files = new Map(forkFiles());
    files.set('core/agents/aidlc-product-agent.md', 'no frontmatter at all\n');
    expect(() => buildReleaseBundle({ profile: forkProfile(), files })).toThrowError(
      expect.objectContaining({ code: 'release_import_rejected' }),
    );
  });

  it('publishes and reads back a custom release only from its custom prefix', async () => {
    const bundle = buildReleaseBundle({ profile: forkProfile(), files: forkFiles() });
    const published = await publishReleaseBundle({ s3, bucket: BUCKET, bundle });

    expect(published.status).toBe('published');
    expect(published.manifestKey).toBe(releaseManifestKey(releaseKeyArgs(bundle.manifest)));
    expect(published.manifestKey).toContain('/custom/acme/aidlc-fork/');

    await expect(
      readReleaseManifest({
        s3,
        bucket: BUCKET,
        sha: SHA,
        importerRevision: AIDLC_RELEASE_IMPORTER_REVISION,
        custom: true,
        sourceRepository: 'acme/aidlc-fork',
      }),
    ).resolves.toMatchObject({ custom: true, sourceRepository: 'acme/aidlc-fork' });

    // The official prefix must stay empty: a custom import can never be read as
    // if it were an official release.
    await expect(readReleaseManifest({ s3, bucket: BUCKET, sha: SHA })).resolves.toBeNull();
    await expect(
      readReleaseManifest({
        s3,
        bucket: BUCKET,
        sha: SHA,
        custom: true,
        sourceRepository: 'other/fork',
      }),
    ).resolves.toBeNull();
  });

  it('keeps publication idempotent per closure for a fork', async () => {
    const bundle = buildReleaseBundle({ profile: forkProfile(), files: forkFiles() });
    await publishReleaseBundle({ s3, bucket: BUCKET, bundle });
    await expect(publishReleaseBundle({ s3, bucket: BUCKET, bundle })).resolves.toMatchObject({
      status: 'already-published',
    });
  });

  it('rejects a manifest whose custom flag and repository disagree', () => {
    const { manifest } = buildReleaseBundle({ profile: forkProfile(), files: forkFiles() });

    expect(() => validateReleaseManifest({ ...manifest, custom: false })).toThrow(
      /custom flag may only be absent or literally true/,
    );
    const { custom: _custom, ...withoutFlag } = manifest;
    expect(() => validateReleaseManifest(withoutFlag)).toThrow(
      /must record awslabs\/aidlc-workflows/,
    );
    expect(() =>
      validateReleaseManifest({ ...manifest, sourceRepository: 'awslabs/aidlc-workflows' }),
    ).toThrow();
  });
});
