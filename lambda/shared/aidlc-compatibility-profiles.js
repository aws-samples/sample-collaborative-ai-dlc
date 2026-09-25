import { isCommitSha } from './aidlc-ref.js';
import { CustomSourceError, parseRepositorySlug } from './aidlc-custom-source.js';

const OFFICIAL_AIDLC_REPOSITORY = 'awslabs/aidlc-workflows';

// Exact source commits are the compatibility identity. Tags and human-readable
// versions are labels only and must never be followed dynamically.
const AIDLC_COMPATIBILITY_PROFILES = Object.freeze({
  'current-stable': Object.freeze({
    id: 'current-stable',
    releaseId: 'aidlc:83ed7a812c4024904f2c5e4d744e28077e0a5acd',
    fixtureDigest: '7651ff897327b3d92fdea033e52f724686aeb274d144de50dbe034ef53180825',
    label: 'Collaborative stable',
    upstreamVersion: '2.3.3',
    upstreamRef: '83ed7a812c4024904f2c5e4d744e28077e0a5acd',
    upstreamChannel: 'commit',
    compatibilityStatus: 'current-baseline',
    frontmatterDialect: 'legacy',
    trustTier: 'T1',
    currentPlatformBaseline: true,
  }),
  'v2.6.18': Object.freeze({
    id: 'v2.6.18',
    releaseId: 'aidlc:fbb1460c5225657dac7f5a025657785751b41634',
    fixtureDigest: '78481064fda5ed0a6a1a5736182a22d187bb1c29d7b19cbc8715ed433e994e0c',
    label: 'AI-DLC 2.6.18',
    upstreamVersion: '2.6.18',
    upstreamRef: 'fbb1460c5225657dac7f5a025657785751b41634',
    upstreamChannel: 'tag-only',
    compatibilityStatus: 'candidate',
    frontmatterDialect: 'legacy',
    trustTier: 'T1',
    currentPlatformBaseline: false,
  }),
  'v2.7.0': Object.freeze({
    id: 'v2.7.0',
    releaseId: 'aidlc:96b11d39028955d4f92375e783525db5275cdfd8',
    fixtureDigest: 'ab4d05e351a618c3d1af8fa36a39c1c4367349db3f395d6cf079c688d594a186',
    label: 'AI-DLC 2.7.0',
    upstreamVersion: '2.7.0',
    upstreamRef: '96b11d39028955d4f92375e783525db5275cdfd8',
    upstreamChannel: 'stable',
    compatibilityStatus: 'candidate',
    frontmatterDialect: 'legacy',
    trustTier: 'T1',
    currentPlatformBaseline: false,
  }),
  'v2.8.2': Object.freeze({
    id: 'v2.8.2',
    releaseId: 'aidlc:355903d6dc8eb07d3c77180be5d40ed679d6a40f',
    fixtureDigest: '1f6cb7a38493e5640e9686d67670418697b374b3684c0cace745b3d42fe1a19e',
    label: 'AI-DLC 2.8.2',
    upstreamVersion: '2.8.2',
    upstreamRef: '355903d6dc8eb07d3c77180be5d40ed679d6a40f',
    upstreamChannel: 'stable',
    compatibilityStatus: 'candidate',
    frontmatterDialect: 'invoke-template-v1',
    trustTier: 'T1',
    currentPlatformBaseline: false,
  }),
  'v2.9.0': Object.freeze({
    id: 'v2.9.0',
    releaseId: 'aidlc:22f5d1b15a064c9ae80046e5b1761d5877e2f69f',
    fixtureDigest: '0f226dae0bb9ad453ecb1f955306883e81a2c930864edc9c572940e6ec783641',
    label: 'AI-DLC 2.9.0',
    upstreamVersion: '2.9.0',
    upstreamRef: '22f5d1b15a064c9ae80046e5b1761d5877e2f69f',
    upstreamChannel: 'stable',
    compatibilityStatus: 'candidate',
    frontmatterDialect: 'invoke-template-v1',
    trustTier: 'T1',
    currentPlatformBaseline: false,
  }),
});

const profileFor = (profileIdOrRef) => {
  const direct = Object.hasOwn(AIDLC_COMPATIBILITY_PROFILES, profileIdOrRef)
    ? AIDLC_COMPATIBILITY_PROFILES[profileIdOrRef]
    : null;
  if (direct) return direct;
  return (
    Object.values(AIDLC_COMPATIBILITY_PROFILES).find(
      (profile) => profile.upstreamRef === profileIdOrRef,
    ) ?? null
  );
};

// The official profile ids a custom fork may borrow a PARSING DIALECT from.
// This is not a trust grant: the base profile only says how to read the fork's
// frontmatter, never that the fork inherits the base's trust tier or support.
const CUSTOM_BASE_PROFILE_IDS = Object.freeze(Object.keys(AIDLC_COMPATIBILITY_PROFILES));

/**
 * Synthesizes the compatibility profile for one custom fork commit.
 *
 * Custom forks are deliberately NOT members of `AIDLC_COMPATIBILITY_PROFILES`:
 * that allowlist is what `profileFor` answers from, and every selection and
 * execution gate treats an unknown profile as fatal. Keeping the allowlist
 * closed means a custom fork can be analyzed and imported by passing this
 * object explicitly, while no id lookup anywhere can ever resurface it.
 *
 * The result is always T0 and `custom: true`, which is what makes it
 * permanently non-runnable (see release-registry `profileIsRunnable` and the
 * release-resolver `release_not_runnable` guard).
 */
const customProfile = ({ repository, sha, baseProfileId }) => {
  const { owner, repo, repository: slug } = parseRepositorySlug(repository);
  if (slug === OFFICIAL_AIDLC_REPOSITORY) {
    throw new CustomSourceError(
      'custom_repository_official',
      `aidlc-compatibility-profiles: ${OFFICIAL_AIDLC_REPOSITORY} is the official repository — use its allowlisted profile instead of a custom source`,
      { details: { repository: slug } },
    );
  }
  if (!isCommitSha(sha)) {
    throw new CustomSourceError(
      'custom_sha_invalid',
      `aidlc-compatibility-profiles: a custom source requires a full 40-hex commit SHA, got "${String(sha)}"`,
      { details: { sha: String(sha ?? '') } },
    );
  }
  const baseProfile = Object.hasOwn(AIDLC_COMPATIBILITY_PROFILES, baseProfileId)
    ? AIDLC_COMPATIBILITY_PROFILES[baseProfileId]
    : null;
  if (!baseProfile) {
    throw new CustomSourceError(
      'custom_base_profile_unknown',
      `aidlc-compatibility-profiles: base dialect profile must be one of ${CUSTOM_BASE_PROFILE_IDS.join(', ')}, got "${String(baseProfileId)}"`,
      { details: { baseProfileId: String(baseProfileId ?? '') } },
    );
  }
  const upstreamRef = String(sha).toLowerCase();
  const identity = `${owner}/${repo}@${upstreamRef}`;
  return Object.freeze({
    id: `custom:${identity}`,
    releaseId: `aidlc-custom:${identity}`,
    upstreamRef,
    upstreamVersion: `custom (${baseProfile.upstreamVersion} dialect)`,
    upstreamChannel: 'custom',
    baseProfileId: baseProfile.id,
    frontmatterDialect: baseProfile.frontmatterDialect,
    trustTier: 'T0',
    currentPlatformBaseline: false,
    custom: true,
    sourceRepository: slug,
  });
};

const isCustomProfile = (profile) => profile?.custom === true;

export {
  AIDLC_COMPATIBILITY_PROFILES,
  CUSTOM_BASE_PROFILE_IDS,
  CustomSourceError,
  OFFICIAL_AIDLC_REPOSITORY,
  customProfile,
  isCustomProfile,
  profileFor,
};
export default {
  AIDLC_COMPATIBILITY_PROFILES,
  CUSTOM_BASE_PROFILE_IDS,
  CustomSourceError,
  OFFICIAL_AIDLC_REPOSITORY,
  customProfile,
  isCustomProfile,
  profileFor,
};
