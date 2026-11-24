import { nativeGitDeltaSha256 } from '../shared/native-git-change-set.js';
import { nativeEngineAuthoredPath, engineFailure } from '../shared/native-workflow-protocol.js';

export const engineReviewPath = (path, declared) =>
  (nativeEngineAuthoredPath(path) || declared.has(path)) &&
  !(path.startsWith('aidlc/') && /(?:^|\/)(?:memory|reasoning|plan)\.md$/.test(path)) &&
  !path.startsWith('aidlc/spaces/default/memory/');

export const scopedEngineGitDelta = (delta, declared) => ({
  ...delta,
  changes: delta.changes.filter((change) => engineReviewPath(change.path, declared)),
});

// Both the terminal observation and each reviewer observation predate finalization.
// Recompute their expected commitments from the named admitted revision on a member read.
export const engineGitVerification = (evidence, delta) => {
  const proof = evidence?.gitObservation;
  if (!proof)
    return {
      reason: evidence ? 'git_observations_not_retained' : 'proof_not_recorded',
      terminal: 'not_recorded',
      review: 'not_verified',
      applicability: 'unknown',
      reviews: [],
    };
  const sha256 = nativeGitDeltaSha256(delta);
  if (sha256 !== proof.publicationSha256) throw engineFailure('NATIVE_ARTIFACT_REVISION_INVALID');
  const reviews = evidence.reviews.map(({ git, ...review }) => {
    const scoped = git && scopedEngineGitDelta(delta, new Set(git.declared));
    const matches = scoped && nativeGitDeltaSha256(scoped) === git.sha256;
    return {
      ...review,
      inspectedSha256: git?.sha256 ?? null,
      coverage: !matches
        ? 'unknown'
        : scoped.changes.length === delta.changes.length
          ? 'full'
          : 'scoped',
      freshness: !scoped
        ? 'not_recorded'
        : review.status === 'stale' || !git.currentDirective || !matches
          ? 'stale'
          : 'current',
    };
  });
  return {
    sha256,
    terminalSha256: proof.terminalSha256,
    workflowCompletion: evidence.workflowCompletion,
    terminal: !proof.terminalSha256
      ? 'not_recorded'
      : proof.terminalMatch && proof.terminalSha256 === sha256
        ? 'matched'
        : 'stale',
    applicability: proof.applicability,
    review:
      proof.applicability !== 'captured' || reviews.some((item) => item.freshness !== 'current')
        ? 'not_verified'
        : reviews.length
          ? 'recorded'
          : 'not_required',
    reviews,
  };
};
