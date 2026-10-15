// Fixed-schema timings only: no prompts, environment, filesystem paths,
// credentials, session IDs or private transcripts enter lifecycle telemetry.
import { NATIVE_PRESENTATION_REASONS } from './native-pending-input.js';
import { nativeOutputDiagnostic, nativeRuntimeFailureCode } from './native-execution-failure.js';

const BOUNDARIES = new Set([
  'accepted',
  'dispatchStarted',
  'targetReady',
  'preparationStarted',
  'preparationCompleted',
  'checkoutStarted',
  'checkoutCompleted',
  'packageVerificationStarted',
  'packageVerificationCompleted',
  'installationStarted',
  'installationCompleted',
  'packageInstallationStarted',
  'packageInstallationCompleted',
  'projectPinStarted',
  'projectPinCompleted',
  'harnessConfigurationStarted',
  'harnessConfigurationCompleted',
  'initializationVerificationStarted',
  'initializationVerificationCompleted',
  'workspaceBaselineStarted',
  'workspaceBaselineCompleted',
  'workspaceSnapshotStarted',
  'workspaceSnapshotCompleted',
  'checkpointVerificationStarted',
  'checkpointVerificationCompleted',
  'checkpointDownloadStarted',
  'checkpointDownloadCompleted',
  'filesystemRestoreStarted',
  'filesystemRestoreCompleted',
  'harnessLaunched',
  'firstOutput',
  'firstUsefulOutput',
  'harnessUsageObserved',
  'outputRejected',
  'harnessCompleted',
  'interactionUploadStarted',
  'interactionUploadCompleted',
  'checkpointCaptureStarted',
  'checkpointCaptureCompleted',
  'executionFailed',
  'questionPresentation',
  'checkpointUploadStarted',
  'checkpointUploadCompleted',
  'publicationStarted',
  'publicationCompleted',
  'publicationVerificationStarted',
  'publicationVerificationCompleted',
  'interactionVerificationStarted',
  'interactionVerificationCompleted',
  'authorityAdmissionStarted',
  'authorityAdmissionCompleted',
  'graphStarted',
  'graphCompleted',
]);
const own = (value, key) => {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
};
export const recordNativeBoundary = (identity, boundary, at = Date.now(), counts = {}) => {
  if (!BOUNDARIES.has(boundary) || !Number.isSafeInteger(at)) return;
  const event = { type: 'native.lifecycle', boundary, at };
  if (boundary === 'executionFailed') event.code = nativeRuntimeFailureCode(counts);
  if (boundary === 'outputRejected') Object.assign(event, nativeOutputDiagnostic(counts));
  if (boundary === 'harnessUsageObserved') {
    for (const key of ['durationMs', 'durationApiMs', 'numTurns'])
      if (
        Number.isSafeInteger(own(counts, key)) &&
        own(counts, key) >= 0 &&
        own(counts, key) <= (key === 'numTurns' ? 100000 : 86400000)
      )
        event[key] = own(counts, key);
  }
  if (boundary === 'questionPresentation') {
    if (
      [...NATIVE_PRESENTATION_REASONS, 'structured', 'unsafe_path', 'credential'].includes(
        own(counts, 'reason'),
      )
    )
      event.reason = own(counts, 'reason');
    const sha256 = own(counts, 'sha256');
    if (typeof sha256 === 'string' && /^[a-f0-9]{64}$/.test(sha256)) event.sha256 = sha256;
    for (const key of [
      'questions',
      'options',
      'suppliedQuestions',
      'suppliedOptions',
      'declaredVersion',
    ])
      if (
        Number.isSafeInteger(own(counts, key)) &&
        own(counts, key) >= 0 &&
        own(counts, key) <= 513
      )
        event[key] = own(counts, key);
  }
  for (const key of ['projectId', 'executionId', 'attemptId'])
    if (typeof own(identity, key) === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(own(identity, key)))
      event[key] = own(identity, key);
  for (const key of ['sequence', 'writerGeneration', 'files', 'bytes', 'retries'])
    if (Number.isSafeInteger(own(counts, key)) && own(counts, key) >= 0)
      event[key] = own(counts, key);
  try {
    console.info(JSON.stringify(event));
  } catch {
    // Telemetry cannot prevent persistence of a terminal report or publication.
  }
};
