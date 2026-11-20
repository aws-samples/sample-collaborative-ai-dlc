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
import { validateStagePolicies } from '../stage-responsibilities.js';
import { DEFAULT_STAGE_PERMISSIONS } from '../stage-responsibility-defaults.js';
import {
  countAuthored,
  legacyReleaseBundle,
  withoutStageResponsibilities,
} from './fixtures/legacy-release.js';

const PROFILES = Object.freeze([
  'current-stable',
  'v2.6.18',
  'v2.7.0',
  'v2.8.2',
  'v2.9.0',
  'v2.11.0',
  'v2.11.1',
  'v2.11.3',
  'v2.11.4',
]);

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
  // Revision 3 adds the 2.11 scope settings. None of the vendored releases
  // authors one, and `changeControl` falls back to `change_control`, so every
  // digest is UNCHANGED — which is the compatibility claim, not a coincidence.
  3: Object.freeze({
    'current-stable': 'e755d11af6ac83b558c93367e66760a2422bb90a90101e71fdc783542456cdf6',
    'v2.6.18': 'c96da502d523da21a2e19c661908c8dce43ddfe1f1dc95c36a50c89488f4f974',
    'v2.7.0': '0f3d5f6b898ac5f92bd9cfb142781081b0480f418de61eb755a1dd75a3f13b1a',
    'v2.8.2': '11268485c203bdbc0b1253ab09af9b97ac3dab428fb24b8c515cfa9d0900b96a',
    'v2.9.0': 'fdb354d35b4f207fa81df92bf6230fb97be1e90e5b56e669b5dc2135fc30bd0b',
    'v2.11.0': 'c289301158ffb6f6ad002d14af637f61bbec1997ed7eef0668d3649fdf3da58f',
    'v2.11.1': '4e7b502baabd3b717e98b8c0b6f7ecd559ebde1394156c8daf5dcda1d8346104',
  }),
  // Revision 4 adds the 2.11.3 frontmatter normalization. It leaves earlier
  // release catalogs byte-identical and makes the previously malformed 2.11.3
  // requirements-analysis stage importable.
  4: Object.freeze({
    'current-stable': 'e755d11af6ac83b558c93367e66760a2422bb90a90101e71fdc783542456cdf6',
    'v2.6.18': 'c96da502d523da21a2e19c661908c8dce43ddfe1f1dc95c36a50c89488f4f974',
    'v2.7.0': '0f3d5f6b898ac5f92bd9cfb142781081b0480f418de61eb755a1dd75a3f13b1a',
    'v2.8.2': '11268485c203bdbc0b1253ab09af9b97ac3dab428fb24b8c515cfa9d0900b96a',
    'v2.9.0': 'fdb354d35b4f207fa81df92bf6230fb97be1e90e5b56e669b5dc2135fc30bd0b',
    'v2.11.0': 'c289301158ffb6f6ad002d14af637f61bbec1997ed7eef0668d3649fdf3da58f',
    'v2.11.1': '4e7b502baabd3b717e98b8c0b6f7ecd559ebde1394156c8daf5dcda1d8346104',
    'v2.11.3': '811faa9795d2b2cd760380bb1d51f0cad7cfcf39a72951922ad1cdb24bb1e5fb',
  }),
  // Revision 5 changes the dependency closure, not the mappers: every catalog
  // is unchanged, and only 2.11.3's recorded compatibility evidence differs.
  // 2.11.4 is first imported at this revision.
  5: Object.freeze({
    'current-stable': 'e755d11af6ac83b558c93367e66760a2422bb90a90101e71fdc783542456cdf6',
    'v2.6.18': 'c96da502d523da21a2e19c661908c8dce43ddfe1f1dc95c36a50c89488f4f974',
    'v2.7.0': '0f3d5f6b898ac5f92bd9cfb142781081b0480f418de61eb755a1dd75a3f13b1a',
    'v2.8.2': '11268485c203bdbc0b1253ab09af9b97ac3dab428fb24b8c515cfa9d0900b96a',
    'v2.9.0': 'fdb354d35b4f207fa81df92bf6230fb97be1e90e5b56e669b5dc2135fc30bd0b',
    'v2.11.0': 'c289301158ffb6f6ad002d14af637f61bbec1997ed7eef0668d3649fdf3da58f',
    'v2.11.1': '4e7b502baabd3b717e98b8c0b6f7ecd559ebde1394156c8daf5dcda1d8346104',
    'v2.11.3': '811faa9795d2b2cd760380bb1d51f0cad7cfcf39a72951922ad1cdb24bb1e5fb',
    'v2.11.4': '5e7f13060ccaedb2c20ca7a204f0191abfed174bdf0f2b3db2e793e9ab040085',
  }),
  // Revision 6 adds the platform default stage responsibilities. Every digest
  // changes; with the responsibilities removed, each catalog is still exactly
  // its revision 5 catalog (asserted below).
  6: Object.freeze({
    'current-stable': '4a2ea2adce2dd16865c45c9e7cf8f13281914fd15411aae42e9f291ca34a4603',
    'v2.6.18': '3af38b3baa77ab7c28a0e1b95df470f1b007943ca68158a2edb00796dcebac0d',
    'v2.7.0': '44d63015a237381d9044dc8219231a6e76614d6c92404683792fd1198ff5a71d',
    'v2.8.2': '2a191ae3f53684de66cdbe7e9e062cf8e4d28027fd5d212d5775c7357142713b',
    'v2.9.0': '4666ba6747cc621e68ea897d9a0749269f6e06ecb84ca2cc2489052cd9af0a43',
    'v2.11.0': '0ca8d3c0391bc05cb0b090de5d2c1e5a386e5165a25a4aff87460229e1d19b03',
    'v2.11.1': 'a151a4bfa8a28d79ce8a27aa92ff8a19ef2241d35a6c3ef519874e37b222cd06',
    'v2.11.3': '4e17edcc24c2f0f85e704126925bd479bcf1e97f9f730c128e8b3b1e00262787',
    'v2.11.4': 'fa62937807897349f8837573391ddeb54bdb7b237c58daed3505163ffdf0b9f6',
  }),
});

// The first revision whose catalogs carry stage responsibilities.
const FIRST_RESPONSIBILITIES_REVISION = 6;
const catalogDigestFor = (revision, catalog) =>
  sha256(
    canonicalJson(
      revision < FIRST_RESPONSIBILITIES_REVISION ? withoutStageResponsibilities(catalog) : catalog,
    ),
  );

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
  it('is on importer revision 6', () => {
    expect(AIDLC_RELEASE_IMPORTER_REVISION).toBe(6);
    expect(FIRST_FINGERPRINTED_IMPORTER_REVISION).toBe(2);
  });

  it('records the 2.11.3 sensor closure as complete, through its .js imports', () => {
    expect(bundles['v2.11.3'].manifest.compatibility.dependencyClosureComplete).toBe(true);
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
    for (const [profileId, digest] of Object.entries(goldens)) {
      expect({ profileId, sha256: bundles[profileId].manifest.catalog.sha256 }).toEqual({
        profileId,
        sha256: digest,
      });
    }
  });

  // A mapper that learned the 2.11 scope settings must not reinterpret a
  // closure that authors none of them. Revision 5 only adds responsibilities,
  // so earlier revisions compare against the catalog without them. Mapping happens at import
  // and an existing pin keeps its own revision's bytes — but if the new mappers
  // produced a DIFFERENT catalog for the same source, a re-import under the new
  // revision would hand an unchanged release different semantics.
  it('reproduces every previous revision’s catalog for every vendored release', () => {
    const revisions = Object.keys(CATALOG_GOLDENS).map(Number).toSorted();
    expect(revisions.at(-1)).toBe(AIDLC_RELEASE_IMPORTER_REVISION);
    for (const revision of revisions) {
      for (const [profileId, digest] of Object.entries(CATALOG_GOLDENS[revision])) {
        expect({
          revision,
          profileId,
          sha256: catalogDigestFor(revision, bundles[profileId].catalog),
        }).toEqual({ revision, profileId, sha256: digest });
      }
    }
  });

  it('carries the default stage responsibilities and valid policies into every catalog', () => {
    for (const profileId of PROFILES) {
      const { workflow, blocks } = bundles[profileId].catalog;
      for (const placement of workflow.placements) {
        expect({
          profileId,
          stageId: placement.stageId,
          permissions: placement.permissions,
        }).toEqual({
          profileId,
          stageId: placement.stageId,
          permissions: DEFAULT_STAGE_PERMISSIONS[placement.stageId] ?? null,
        });
      }
      for (const stage of blocks.STAGE) {
        expect(stage.permissions).toEqual(DEFAULT_STAGE_PERMISSIONS[stage.blockId] ?? null);
      }
      expect(() => validateStagePolicies(workflow.cedarPolicies)).not.toThrow();
      expect(workflow.cedarPolicies).toContain('resource == Stage::"requirements-analysis"');
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
        releaseCatalogKey({
          sha: manifest.sourceSha,
          importerRevision: AIDLC_RELEASE_IMPORTER_REVISION,
        }),
      );
      expect(validateReleaseManifest(manifest)).toBe(manifest);
    }
  });

  it('refuses to build any revision other than its own', () => {
    for (const importerRevision of [1, 2, 3, 4, 5]) {
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
    // authors none of them, so apart from the revision 6 responsibilities its
    // current catalog is its i1 catalog, byte for byte.
    expect(canonicalJson(legacyReleaseBundle(bundles['current-stable']).catalog)).toBe(
      canonicalJson(withoutStageResponsibilities(catalog)),
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
    const future = rebuilt(manifest, { importerRevision: 7, mapperFingerprint: 'e'.repeat(64) });
    expect(validateReleaseManifest(future)).toBe(future);
  });
});
