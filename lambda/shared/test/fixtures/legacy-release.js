// Builds the closure an importer-revision-1 deployment published for a profile,
// for tests of the closure upgrade path (issue #482).
//
// The running importer can only produce its OWN revision, so a revision-1
// closure has to be reconstructed: the current bundle's catalog minus every
// fields the current importer maps that revision-1 catalogs do not carry,
// re-addressed under the i1 prefix, without a mapper fingerprint, and with its
// catalog digest and closureDigest recomputed using the legacy format.

import { releaseCatalogKey } from '../../aidlc-release.js';
import { sha256 } from '../../blocks.js';
import { canonicalJson } from '../../workflow-checkpoint.js';

const LATER_MAPPER_FIELDS = Object.freeze({
  STAGE: ['reviewClass', 'reviewArtifact', 'summaryConfirmation'],
  AGENT: ['maxTurns'],
  SCOPE: [
    'sensorsPolicy',
    'reviewCap',
    'summaryConfirmation',
    'changeControl',
    'learnings',
    'skeleton',
    'runner',
  ],
  SENSOR: ['fireOn'],
});

const withoutFields = (block, fields) =>
  Object.fromEntries(Object.entries(block).filter(([key]) => !fields.includes(key)));

const legacyCatalog = (catalog) => ({
  ...catalog,
  blocks: Object.fromEntries(
    Object.entries(catalog.blocks).map(([type, blocks]) => [
      type,
      blocks.map((block) => withoutFields(block, LATER_MAPPER_FIELDS[type] ?? [])),
    ]),
  ),
});

const legacyReleaseBundle = (bundle) => {
  const catalog = legacyCatalog(bundle.catalog);
  const { closureDigest: _digest, mapperFingerprint: _fingerprint, ...current } = bundle.manifest;
  const base = {
    ...current,
    importerRevision: 1,
    catalog: {
      key: releaseCatalogKey({ sha: current.sourceSha, importerRevision: 1 }),
      sha256: sha256(canonicalJson(catalog)),
      bytes: Buffer.byteLength(`${JSON.stringify(catalog, null, 2)}\n`),
    },
  };
  return {
    manifest: { ...base, closureDigest: sha256(canonicalJson(base)) },
    catalog,
    objects: bundle.objects,
  };
};

const countAuthored = (catalog, type, field) =>
  (catalog.blocks?.[type] ?? []).filter((block) => block[field] != null).length;

export { LATER_MAPPER_FIELDS, countAuthored, legacyReleaseBundle };
