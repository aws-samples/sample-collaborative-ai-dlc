import { isDeepStrictEqual } from 'node:util';
import {
  nativeGitChanges,
  nativeGitInventorySha256,
  nativeGitDeltaSha256,
} from '../../shared/native-git-change-set.js';
import { NATIVE_PUBLICATION_LIMITS } from '../../shared/native-publication.js';
import { nativeEngineAuthoredPath, engineFailure } from '../../shared/native-workflow-protocol.js';

export const engineGitSource = ({ receipt, epoch }) => ({
  id: receipt.id,
  versionId: receipt.manifest.versionId,
  epoch,
});

// The source receipt is provisional until the result naming this exact base is admitted.
// The repository identity always comes from the immutable Start configuration.
export const openEngineGitInput = async (
  { row, identity, workspace, publications, request, snapshot },
  input,
  files,
) => {
  if (!input.git && !input.sourceBaseline) {
    if (!snapshot && request.action === 'mirror') workspace.state.gitSource = null;
    return null;
  }
  if (workspace.state.gitSource === null) return null;
  const pointer = input.sourceBaseline;
  let previous = workspace.state.gitSource;
  if (!previous && row.publication) {
    const admitted = (
      await publications.read({ ...identity, epoch: row.publicationEpoch }, row.publication)
    ).sourceBaseline;
    if (!admitted?.receipt) return null;
    previous = engineGitSource(admitted);
  }
  if (!previous && (snapshot || request.action !== 'mirror')) return null;
  if (
    !pointer?.receipt?.manifest ||
    !Number.isSafeInteger(pointer.epoch) ||
    pointer.epoch < 1 ||
    pointer.epoch > identity.epoch ||
    (previous && !isDeepStrictEqual(previous, engineGitSource(pointer)))
  )
    throw engineFailure('NATIVE_ENGINE_SOURCE_MISMATCH');
  const scope = { ...identity, epoch: pointer.epoch };
  const base = await publications.read(scope, pointer.receipt);
  const pin = row.configuration.repository;
  if (
    base.nativeSessionId !== null ||
    base.packageId !== row.configuration.packageId ||
    base.repository.branch !== pin.branch ||
    base.repository.commit !== pin.commit ||
    base.git?.provider !== pin.provider ||
    base.git.repository !== pin.repository
  )
    throw engineFailure('NATIVE_ENGINE_SOURCE_MISMATCH');
  const git = input.git;
  if (
    !Array.isArray(git?.deleted) ||
    git.deleted.length > base.files.length ||
    git.deleted.some((path, index) => index && path <= git.deleted[index - 1]) ||
    files.some((file) => !file.mode) ||
    nativeGitInventorySha256(files) !== git.inventorySha256 ||
    !nativeGitChanges(base, { files, git })
  )
    throw engineFailure('NATIVE_ENGINE_INPUT_INVALID');
  workspace.state.gitSource = engineGitSource(pointer);
  return { base, scope, pointer, git };
};

export const engineGitDelta = (pointer, base, changes) => ({
  sourceBaseline: engineGitSource(pointer),
  repository: { provider: base.git.provider, repository: base.git.repository, ...base.repository },
  changes: changes.map(({ path, before, after }) => ({ path, before, after })),
});

export const observedEngineGitDelta = (input, files) => {
  if (!input || files.length > NATIVE_PUBLICATION_LIMITS.files || files.some((file) => !file.mode))
    return null;
  const changes = nativeGitChanges(input.base, { files, git: input.git });
  return changes && engineGitDelta(input.pointer, input.base, changes);
};

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
