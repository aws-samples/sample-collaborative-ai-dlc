// Fixed-schema timings only: no prompts, environment, filesystem paths,
// credentials, session IDs or private transcripts enter lifecycle telemetry.
import { nativeRuntimeFailureCode } from './native-execution-failure.js';

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
  'checkpointVerificationStarted',
  'checkpointVerificationCompleted',
  'checkpointDownloadStarted',
  'checkpointDownloadCompleted',
  'filesystemRestoreStarted',
  'filesystemRestoreCompleted',
  'harnessLaunched',
  'firstOutput',
  'harnessCompleted',
  'interactionUploadStarted',
  'interactionUploadCompleted',
  'checkpointCaptureStarted',
  'checkpointCaptureCompleted',
  'executionFailed',
  'checkpointUploadStarted',
  'checkpointUploadCompleted',
  'publicationStarted',
  'publicationCompleted',
  'graphStarted',
  'graphCompleted',
]);
export const recordNativeBoundary = (identity, boundary, at = Date.now(), counts = {}) => {
  if (!BOUNDARIES.has(boundary) || !Number.isSafeInteger(at)) return;
  const event = { type: 'native.lifecycle', boundary, at };
  if (boundary === 'executionFailed') event.code = nativeRuntimeFailureCode(counts);
  for (const key of ['projectId', 'executionId', 'attemptId'])
    if (typeof identity?.[key] === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(identity[key]))
      event[key] = identity[key];
  for (const key of ['sequence', 'writerGeneration', 'files', 'bytes', 'retries'])
    if (Number.isSafeInteger(counts[key]) && counts[key] >= 0) event[key] = counts[key];
  try {
    console.info(JSON.stringify(event));
  } catch {
    // Telemetry cannot prevent persistence of a terminal report or publication.
  }
};
