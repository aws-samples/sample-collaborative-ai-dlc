// Which native AI-DLC distribution a native export ships.
//
// An intent normally exports the official distribution at its own pinned ref.
// An intent pinned to a custom fork release carries the fork's commit as that
// ref, and the official repository has no distribution at the fork's commit, so
// the official fetch can never succeed. Such an intent is exported:
//
//   1. with the release's own distribution for the requested harness, when the
//      fork shipped one at `dist/<harness>/` and it was captured at import
//      (shared/release-distributions.js). The workspace then matches the intent
//      as configured: the fork's stages, agents, knowledge, rules and sensors.
//   2. otherwise onto the official release the fork borrows its parsing dialect
//      from (the release manifest's base profile), with a warning saying what
//      that leaves out, and stages only the fork defines dropped from the
//      workspace rather than failing the export.
//
// Dependencies are injected so this stays a pure decision.
import { isCommitSha } from '../shared/aidlc-ref.js';
import { profileFor } from '../shared/aidlc-compatibility-profiles.js';

const LEGACY_REF_WARNING =
  'This legacy intent did not pin a native upstream ref; the current deployment ref was used.';

// Returns { upstreamRef, warnings, omitStagesNotInDistribution,
// preloadedDistribution }, or null when the intent runs a custom release whose
// own distribution is absent and whose base cannot be determined.
//
//   readManifest({ sha, importerRevision, custom, sourceRepository })
//   loadReleaseDistribution({ keyArgs, harness })  -> distribution | null
const resolveNativeExportSource = async ({
  meta,
  harness,
  deploymentRef,
  readManifest,
  loadReleaseDistribution,
}) => {
  const release = meta.methodologyRelease;
  if (release?.custom !== true) {
    return {
      upstreamRef: meta.aidlcRepoRef || (await deploymentRef()),
      warnings: meta.aidlcRepoRef ? [] : [LEGACY_REF_WARNING],
      omitStagesNotInDistribution: false,
      preloadedDistribution: null,
    };
  }
  const keyArgs = {
    sha: release.sourceSha,
    importerRevision: Number(release.importerRevision),
    custom: true,
    sourceRepository: release.sourceRepository ?? null,
  };
  const own = await loadReleaseDistribution({ keyArgs, harness });
  if (own) {
    return {
      upstreamRef: release.sourceSha,
      warnings: [],
      omitStagesNotInDistribution: false,
      preloadedDistribution: own,
    };
  }
  const manifest = await readManifest(keyArgs);
  const base = manifest?.baseProfileId ? profileFor(manifest.baseProfileId) : null;
  if (!base || base.custom || !isCommitSha(base.upstreamRef)) return null;
  return {
    upstreamRef: base.upstreamRef,
    warnings: [
      `This intent runs the custom AI-DLC release ${release.sourceRepository}@${String(release.sourceSha).slice(0, 12)}, ` +
        `which ships no ${harness} distribution. ` +
        `The export uses the official ${base.label} distribution it is based on (${base.upstreamRef.slice(0, 12)}), ` +
        'so stages, agents, knowledge, rules and sensors that the release adds or changes are not in this workspace.',
    ],
    omitStagesNotInDistribution: true,
    preloadedDistribution: null,
  };
};

export { resolveNativeExportSource };
export default { resolveNativeExportSource };
