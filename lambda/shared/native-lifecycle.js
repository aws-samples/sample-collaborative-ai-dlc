// Fixed-schema timings only: no prompts, environment, filesystem paths,
// credentials, session IDs or private transcripts enter lifecycle telemetry.
import { NATIVE_PRESENTATION_REASONS, NATIVE_TYPED_ASK_TYPES } from './native-pending-input.js';
import {
  nativeOutputDiagnostic,
  nativeSnapshotDiagnostic,
  nativeRuntimeFailureCode,
} from './native-execution-failure.js';

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
  'snapshotRejected',
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
const presentationFields = (counts) => {
  const result = {};
  for (const [key, values] of [
    ['reason', [...NATIVE_PRESENTATION_REASONS, 'structured', 'unsafe_path', 'credential']],
    ['askType', [...NATIVE_TYPED_ASK_TYPES, 'unknown']],
    ['responseRoute', ['next', 'command', 'claim', 'unknown']],
  ])
    if (values.includes(own(counts, key))) result[key] = own(counts, key);
  const sha256 = own(counts, 'sha256');
  if (typeof sha256 === 'string' && /^[a-f0-9]{64}$/.test(sha256)) result.sha256 = sha256;
  for (const key of [
    'questions',
    'options',
    'suppliedQuestions',
    'suppliedOptions',
    'suppliedChoices',
    'suppliedScopeOptions',
    'declaredVersion',
  ]) {
    const value = own(counts, key);
    if (Number.isSafeInteger(value) && value >= 0 && value <= 513) result[key] = value;
  }
  return result;
};
export const recordNativeBoundary = (identity, boundary, at = Date.now(), counts = {}) => {
  if (!BOUNDARIES.has(boundary) || !Number.isSafeInteger(at)) return;
  const event = { type: 'native.lifecycle', boundary, at };
  if (boundary === 'executionFailed') event.code = nativeRuntimeFailureCode(counts);
  if (boundary === 'outputRejected') Object.assign(event, nativeOutputDiagnostic(counts));
  if (boundary === 'snapshotRejected') Object.assign(event, nativeSnapshotDiagnostic(counts));
  if (boundary === 'harnessUsageObserved') {
    for (const key of ['durationMs', 'durationApiMs', 'numTurns'])
      if (
        Number.isSafeInteger(own(counts, key)) &&
        own(counts, key) >= 0 &&
        own(counts, key) <= (key === 'numTurns' ? 100000 : 86400000)
      )
        event[key] = own(counts, key);
  }
  if (boundary === 'questionPresentation') Object.assign(event, presentationFields(counts));
  for (const key of ['projectId', 'executionId', 'attemptId'])
    if (typeof own(identity, key) === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(own(identity, key)))
      event[key] = own(identity, key);
  for (const key of boundary === 'snapshotRejected'
    ? ['sequence', 'writerGeneration', 'retries']
    : ['sequence', 'writerGeneration', 'files', 'bytes', 'retries'])
    if (Number.isSafeInteger(own(counts, key)) && own(counts, key) >= 0)
      event[key] = own(counts, key);
  try {
    console.info(JSON.stringify(event));
  } catch {
    // Telemetry cannot prevent persistence of a terminal report or publication.
  }
};
