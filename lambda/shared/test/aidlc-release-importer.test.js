// Importer identity (issue #482): the importer revision that addresses a
// closure, and the behavioural mapper fingerprint that makes a mapper change
// without a revision bump impossible to publish.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { filesFromCompatibilityFixture } from '../aidlc-compatibility.js';
import { AIDLC_CAPABILITIES } from '../aidlc-capabilities.js';
import {
  AIDLC_RELEASE_IMPORTER_REVISION,
  buildReleaseBundle,
  releaseCatalogKey,
  validateReleaseManifest,
} from '../aidlc-release.js';
import {
  AIDLC_RELEASE_MAPPER_FINGERPRINTS,
  FIRST_FINGERPRINTED_IMPORTER_REVISION,
  MAPPER_PROBE_FILES,
  computeMapperFingerprint,
} from '../aidlc-release-importer.js';
import { sha256 } from '../blocks.js';
import { parseFrontmatter } from '../frontmatter.js';
import { canonicalJson } from '../workflow-checkpoint.js';
import { countAuthored, legacyReleaseBundle } from './fixtures/legacy-release.js';

const PROFILES = Object.freeze(['current-stable', 'v2.6.18', 'v2.7.0', 'v2.8.2', 'v2.9.0']);

// Catalog digests every vendored fixture maps to under importer revision 2.
// A mapper change that alters any of them is an importer semantics change:
// bump AIDLC_RELEASE_IMPORTER_REVISION, pin the new fingerprint, and add a new
// revision's goldens here — never edit these.
const CATALOG_GOLDENS = Object.freeze({
  2: Object.freeze({
    'current-stable': 'e755d11af6ac83b558c93367e66760a2422bb90a90101e71fdc783542456cdf6',
    'v2.6.18': 'c96da502d523da21a2e19c661908c8dce43ddfe1f1dc95c36a50c89488f4f974',
    'v2.7.0': '0f3d5f6b898ac5f92bd9cfb142781081b0480f418de61eb755a1dd75a3f13b1a',
    'v2.8.2': '11268485c203bdbc0b1253ab09af9b97ac3dab428fb24b8c515cfa9d0900b96a',
    'v2.9.0': 'fdb354d35b4f207fa81df92bf6230fb97be1e90e5b56e669b5dc2135fc30bd0b',
  }),
});

const filesFor = (profileId) =>
  filesFromCompatibilityFixture({
    profileId,
    fixture: JSON.parse(
      readFileSync(
        new URL(`./fixtures/aidlc-compatibility/${profileId}.json`, import.meta.url),
        'utf8',
      ),
    ),
  });

const bundles = Object.fromEntries(
  PROFILES.map((profileId) => [
    profileId,
    buildReleaseBundle({ profileId, files: filesFor(profileId) }),
  ]),
);

const withDigest = (base) => ({ ...base, closureDigest: sha256(canonicalJson(base)) });

const rebuilt = (manifest, patch) => {
  const { closureDigest: _digest, ...base } = manifest;
  return withDigest({ ...base, ...patch });
};

describe('importer revision and mapper fingerprint', () => {
  it('is on importer revision 2', () => {
    expect(AIDLC_RELEASE_IMPORTER_REVISION).toBe(2);
    expect(FIRST_FINGERPRINTED_IMPORTER_REVISION).toBe(2);
  });

  it('reproduces the fingerprint pinned for the current revision', () => {
    // On failure: the mappers changed. Bump AIDLC_RELEASE_IMPORTER_REVISION and
    // pin THIS value for the new revision; never edit an existing entry.
    expect(computeMapperFingerprint()).toBe(
      AIDLC_RELEASE_MAPPER_FINGERPRINTS[AIDLC_RELEASE_IMPORTER_REVISION],
    );
  });

  it('authors every frontmatter field the capability registry classifies in the probe', () => {
    const authored = new Map();
    for (const [path, content] of MAPPER_PROBE_FILES) {
      if (!path.endsWith('.md')) continue;
      const { data } = parseFrontmatter(content);
      const blockType = path.includes('/stages/')
        ? 'STAGE'
        : path.includes('/agents/')
          ? 'AGENT'
          : path.includes('/scopes/')
            ? 'SCOPE'
            : path.includes('/sensors/')
              ? 'SENSOR'
              : null;
      if (!blockType) continue;
      for (const field of Object.keys(data)) authored.set(`${blockType}:${field}`, true);
    }
    const missing = AIDLC_CAPABILITIES.filter((entry) => entry.blockType !== 'PROTOCOL')
      .map((entry) => entry.key)
      .filter((key) => !authored.has(key));
    expect(missing).toEqual([]);
  });

  it('pins every vendored fixture catalog for the current revision', () => {
    const goldens = CATALOG_GOLDENS[AIDLC_RELEASE_IMPORTER_REVISION];
    expect(Object.keys(goldens).toSorted()).toEqual([...PROFILES].toSorted());
    for (const profileId of PROFILES) {
      expect({ profileId, sha256: bundles[profileId].manifest.catalog.sha256 }).toEqual({
        profileId,
        sha256: goldens[profileId],
      });
    }
  });

  it('carries the mapped policy fields into the 2.9.0 catalog, like 2.8.2', () => {
    for (const profileId of ['v2.8.2', 'v2.9.0']) {
      const { catalog } = bundles[profileId];
      expect(countAuthored(catalog, 'STAGE', 'summaryConfirmation')).toBe(27);
      expect(countAuthored(catalog, 'STAGE', 'reviewClass')).toBe(8);
    }
  });

  it('records the fingerprint and the current revision in every manifest', () => {
    for (const profileId of PROFILES) {
      const { manifest } = bundles[profileId];
      expect(manifest.importerRevision).toBe(AIDLC_RELEASE_IMPORTER_REVISION);
      expect(manifest.mapperFingerprint).toBe(computeMapperFingerprint());
      expect(manifest.catalog.key).toBe(
        releaseCatalogKey({ sha: manifest.sourceSha, importerRevision: 2 }),
      );
      expect(validateReleaseManifest(manifest)).toBe(manifest);
    }
  });

  it('refuses to build any revision other than its own', () => {
    for (const importerRevision of [1, 3]) {
      expect(() =>
        buildReleaseBundle({
          profileId: 'v2.9.0',
          files: filesFor('v2.9.0'),
          importerRevision,
        }),
      ).toThrowError(expect.objectContaining({ code: 'release_importer_revision_invalid' }));
    }
  });
});

describe('2.3.3 stays byte-identical across the importer bump', () => {
  it('maps the platform baseline to the exact catalog revision 1 produced', () => {
    const { catalog } = bundles['current-stable'];
    // Stripping every field a later mapper added is a no-op for 2.3.3: it
    // authors none of them, so its i2 catalog is its i1 catalog, byte for byte.
    expect(canonicalJson(legacyReleaseBundle(bundles['current-stable']).catalog)).toBe(
      canonicalJson(catalog),
    );
  });
});

describe('manifest fingerprint validation', () => {
  it('accepts a revision-1 manifest without a fingerprint', () => {
    const { manifest } = legacyReleaseBundle(bundles['v2.9.0']);
    expect(manifest.mapperFingerprint).toBeUndefined();
    expect(validateReleaseManifest(manifest)).toBe(manifest);
  });

  it('refuses a revision-1 manifest that claims a fingerprint', () => {
    const legacy = legacyReleaseBundle(bundles['v2.9.0']).manifest;
    const tampered = rebuilt(legacy, { mapperFingerprint: computeMapperFingerprint() });
    expect(() => validateReleaseManifest(tampered)).toThrowError(
      expect.objectContaining({ code: 'release_manifest_invalid' }),
    );
  });

  it('refuses a revision-2 manifest with a missing or unpinned fingerprint, even with a valid digest', () => {
    const { manifest } = bundles['v2.9.0'];
    const { mapperFingerprint: _dropped, ...withoutFingerprint } = manifest;
    for (const candidate of [
      rebuilt(withoutFingerprint, {}),
      rebuilt(manifest, { mapperFingerprint: 'f'.repeat(64) }),
      rebuilt(manifest, { mapperFingerprint: 'not-a-digest' }),
    ]) {
      expect(() => validateReleaseManifest(candidate)).toThrowError(
        expect.objectContaining({ code: 'release_manifest_invalid' }),
      );
    }
  });

  it('accepts a revision newer than this code on shape alone, so a rollback cannot strand it', () => {
    const { manifest } = bundles['v2.9.0'];
    const future = rebuilt(manifest, { importerRevision: 3, mapperFingerprint: 'e'.repeat(64) });
    expect(validateReleaseManifest(future)).toBe(future);
  });
});
