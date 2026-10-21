// Called only by trusted checkout preparation before the first package command.
// Never reconstruct a missing baseline from the first generated publication.
import { snapshotNativeExecutionFiles } from './execution-files.js';
import { nativeCredentialPath } from '../../shared/native-project-files.js';
import { NATIVE_PUBLICATION_LIMITS } from '../../shared/native-publication.js';
import { NATIVE_DEPENDENCY_POLICY } from '../../shared/native-dependency-links.js';

export const captureNativeSourceBaseline = async ({
  project,
  identity,
  repository,
  packageId,
  publications,
  signal,
  forbiddenBytes,
}) => {
  let snapshot;
  try {
    snapshot = await snapshotNativeExecutionFiles({
      project,
      signal,
      forbiddenBytes,
      filesystemPolicy: NATIVE_DEPENDENCY_POLICY,
    });
  } catch (error) {
    if (error.code === 'native_snapshot_limit') return { unavailable: 'snapshot_limit' };
    if (error.code === 'native_snapshot_credential_content') return { unavailable: 'file_policy' };
    throw error;
  }
  if (snapshot.files.length > NATIVE_PUBLICATION_LIMITS.files)
    return { unavailable: 'snapshot_limit' };
  // Existing credential-shaped publication policy remains unresolved. Do not
  // introduce a new retained copy of those bytes through source comparisons.
  if (snapshot.files.some((file) => nativeCredentialPath(file.path)))
    return { unavailable: 'file_policy' };
  const receipt = await publications.write({
    identity,
    repository,
    packageId,
    nativeSessionId: null,
    outcome: 'STOPPED',
    sequence: 1,
    files: snapshot.files,
    filesystemPolicy: snapshot.filesystemPolicy,
  });
  return { epoch: identity.epoch, receipt };
};
