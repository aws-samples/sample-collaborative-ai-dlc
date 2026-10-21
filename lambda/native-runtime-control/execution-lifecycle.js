import { createHash } from 'node:crypto';
import { nativeTurnSequence, nativeWriterGeneration } from './execution-store.js';
import { executionIdentity, executionRuntimeConfiguration } from './execution-runtime.js';
import { nativeFileExclusion } from '../shared/native-project-files.js';
import { recordNativeBoundary } from '../shared/native-lifecycle.js';
export const fail = (code) => {
  throw Object.assign(new Error(code), { code });
};
export const hash = (value) => createHash('sha256').update(value).digest('hex');
export const recoveryStopId = (row, reason) => {
  const digest = hash(
    JSON.stringify({
      purpose: 'native-recovery-required',
      identity: executionIdentity(row),
      writerGeneration: nativeWriterGeneration(row),
      sequence: nativeTurnSequence(row),
      reason,
      recoveryId: row.recovery?.id ?? null,
    }),
  );
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
};
export const writerOptions = (row) => ({ writerGeneration: nativeWriterGeneration(row) });
export const excludedProjectPath = (path, filesystemPolicy) => {
  // The publisher applies its predicate before descending into directories.
  // Apply it to ancestors too so children of private lock directories retain
  // exactly that same visibility when verifying a flat checkpoint inventory.
  let prefix = '';
  for (const part of path.split('/')) {
    prefix = prefix ? `${prefix}/${part}` : part;
    if (nativeFileExclusion(prefix, filesystemPolicy)) return true;
  }
  return false;
};
export const verifyPublicProjectFiles = (checkpoint, publication) => {
  if (!Array.isArray(checkpoint.files) || !Array.isArray(publication.files))
    fail('NATIVE_RECOVERY_INVALID');
  if ((checkpoint.filesystem?.filesystemPolicy ?? null) !== (publication.filesystemPolicy ?? null))
    fail('NATIVE_RECOVERY_INVALID');
  const files = new Map();
  const published = new Set();
  try {
    for (const file of checkpoint.files) {
      if (file.scope !== 'project' || excludedProjectPath(file.path, publication.filesystemPolicy))
        continue;
      if (files.has(file.path)) fail('NATIVE_RECOVERY_INVALID');
      files.set(file.path, file);
    }
    if (files.size !== publication.files.length) fail('NATIVE_RECOVERY_INVALID');
    for (const file of publication.files) {
      const restored = files.get(file.path);
      if (
        excludedProjectPath(file.path, publication.filesystemPolicy) ||
        published.has(file.path) ||
        !restored ||
        restored.bytes !== file.bytes ||
        restored.sha256 !== file.sha256
      )
        fail('NATIVE_RECOVERY_INVALID');
      published.add(file.path);
    }
  } catch {
    fail('NATIVE_RECOVERY_INVALID');
  }
};
export const writerPayload = (row) => ({
  ...executionIdentity(row),
  ...(row.writerGeneration === undefined ? {} : writerOptions(row)),
});
export const checkReportIdentity = (row, report) => {
  // Old pinned servers reject extra status fields and never reported writer
  // generations. Only rows created before the generation protocol use that
  // contract. New rows explicitly carry generation 1 and must always echo it.
  const legacy = row.writerGeneration === undefined && report?.writerGeneration === undefined;
  if (
    Object.entries(executionIdentity(row)).some(([key, value]) => report?.[key] !== value) ||
    (!legacy && report?.writerGeneration !== nativeWriterGeneration(row))
  )
    fail('NATIVE_EXECUTION_RUNTIME_MISMATCH');
};
export const admitted = (row, report) =>
  report?.sequence === nativeTurnSequence(row) &&
  (!row.response || report.requestId === row.response.commandId) &&
  ['preparing', 'running', 'publishing', 'publication_ready'].includes(report.status) &&
  (report.recovered !== true || report.status === 'publication_ready');
export const priorBoundary = (row, report) =>
  report?.sequence === row.publication?.sequence &&
  report?.nativeSessionId === row.publication?.nativeSessionId &&
  ((report.status === 'publication_ready' &&
    report.receipt?.id === row.publication.id &&
    report.interaction?.id === row.interaction?.id) ||
    (report.status === 'recovery_ready' &&
      report.recoveryId === row.lastRecoveryId &&
      report.checkpointId === row.recoveryCheckpoint?.id &&
      report.recovered === false));
export const ownerErrors = new Set([
  'native_execution_existing_owner',
  'native_execution_owner_conflict',
  'native_execution_reply_conflict',
  'native_execution_local_record_unavailable',
  'native_execution_reply_admission_unconfirmed',
]);
export const statusOwnerErrors = new Set([
  ...ownerErrors,
  'native_execution_scope_mismatch',
  'native_execution_owner_invalid',
  'native_execution_local_record_invalid',
  'native_execution_cancelled',
]);
// Transport provenance is local controller state, never an agent-supplied
// property or a diagnostic logger result. Keep the original thrown error and
// any structured rejection separate from the unreadable-response category.
export const runtimeReadFailures = new WeakMap();
export const markRuntimeReadFailure = (error, kind, runtimeCode) => {
  if (error && (typeof error === 'object' || typeof error === 'function'))
    runtimeReadFailures.set(error, { kind, runtimeCode });
  return error;
};
export const failRuntimeRead = (code, kind, runtimeCode) => {
  throw markRuntimeReadFailure(Object.assign(new Error(code), { code }), kind, runtimeCode);
};
export const shortTransportRetry = (error) =>
  error?.code === 'NATIVE_RECOVERY_UNAVAILABLE' ||
  [
    'AbortError',
    'TimeoutError',
    'ThrottlingException',
    'TooManyRequestsException',
    'ServiceUnavailableException',
    'InternalServerException',
    'RetryableConflictException',
  ].includes(error?.name) ||
  ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE'].includes(error?.code);
export const statusReadFailure = (error) => {
  if (statusOwnerErrors.has(error?.code)) return null;
  const kind = runtimeReadFailures.get(error)?.kind;
  if (kind === 'OWNER_REJECTED') return null;
  if (kind) return kind;
  // Injected SDK ports can throw the same transport errors without going
  // through our adapter. A report-identity mismatch is never in this set.
  if (error?.name === 'RuntimeClientError' || shortTransportRetry(error)) return 'SDK_FAILURE';
  return null;
};
export const recoveryReadRejected = (error) =>
  // SDK errors carry the code directly; parsed HTTP rejections retain it in
  // controller provenance. Never infer a runtime rejection from message text.
  [error?.code, runtimeReadFailures.get(error)?.runtimeCode].some(
    (code) => typeof code === 'string' && /^native_execution_[a-z_]+$/.test(code),
  );
export const phaseError = (error) => {
  // A closed fence on a still-active protected row means earlier failure
  // cleanup was interrupted. Retry stop/persistence, never reopen dispatch.
  if (error?.code === 'NATIVE_EXECUTION_CANCELLED') return 'native_execution_failed';
  if (error?.code === 'NATIVE_EXECUTION_RUNTIME_MISMATCH' || ownerErrors.has(error?.code))
    return 'native_execution_runtime_mismatch';
  if (
    [
      'NATIVE_PUBLICATION_INVALID',
      'NATIVE_INTERACTION_INVALID',
      'NATIVE_RECOVERY_INVALID',
    ].includes(error?.code)
  )
    return 'native_execution_publication_invalid';
  if (['WORKFLOW_SOURCE_FORBIDDEN', 'NATIVE_EXECUTION_FORBIDDEN'].includes(error?.code))
    return 'native_execution_access_denied';
  if (error?.code === 'NATIVE_EXECUTION_IMAGE_REVOKED') return 'native_execution_image_revoked';
  if (
    [
      'WORKFLOW_SOURCE_CONFLICT',
      'WORKFLOW_SOURCE_NOT_FOUND',
      'NATIVE_EXECUTION_SOURCE_CHANGED',
    ].includes(error?.code)
  )
    return 'native_execution_source_changed';
  return null;
};
export const checkedCredentials = (row, material) => {
  if (!material?.ok) {
    const code = material?.code;
    if (code === 'NATIVE_EXECUTION_CREDENTIALS_FORBIDDEN') fail('NATIVE_EXECUTION_FORBIDDEN');
    if (code === 'NATIVE_EXECUTION_CREDENTIALS_IMAGE_REVOKED')
      fail('NATIVE_EXECUTION_IMAGE_REVOKED');
    if (
      [
        'NATIVE_EXECUTION_CREDENTIALS_CHANGED',
        'NATIVE_EXECUTION_SOURCE_CREDENTIAL_CHANGED',
        'NATIVE_EXECUTION_MODEL_CREDENTIAL_UNAVAILABLE',
      ].includes(code)
    )
      fail('NATIVE_EXECUTION_SOURCE_CHANGED');
    // Unavailable transport/provider responses are retried for this attempt;
    // they do not establish that a binding was changed or a model failed.
    fail('NATIVE_EXECUTION_CREDENTIALS_UNAVAILABLE');
  }
  if (
    Object.entries(executionIdentity(row)).some(([key, value]) => material[key] !== value) ||
    typeof material.model?.value !== 'string' ||
    !material.model.value ||
    material.model.provider !== row.configuration.credentialBinding.provider ||
    typeof material.git?.username !== 'string' ||
    !material.git.username ||
    typeof material.git.password !== 'string' ||
    !material.git.password
  )
    fail('NATIVE_EXECUTION_RUNTIME_MISMATCH');
  return material;
};

export const reconcileNativeRecovery = async ({
  state,
  draft,
  store,
  verifyCheckpoint,
  requireRecovery,
  fence,
  check,
  stop,
  yieldPending,
  observedInvoke,
  status,
  observe,
}) => {
  const recovery = state.row.recovery;
  try {
    await verifyCheckpoint(
      state.row.recoveryCheckpoint,
      state.row.publication,
      state.row.interaction,
    );
  } catch (error) {
    if (['NATIVE_RECOVERY_INVALID', 'NATIVE_RECOVERY_MISSING'].includes(error.code))
      return requireRecovery('CHECKPOINT_UNAVAILABLE');
    throw error;
  }
  if (recovery.phase === 'FENCING') {
    await fence.suspend(executionIdentity(state.row), {
      writerGeneration: recovery.previousGeneration,
      recoveryId: recovery.id,
      reason: recovery.reason,
    });
    await check();
    // Same AWS session IDs are reusable. A stable per-episode stop token
    // prevents an old retry from stopping a replacement generation.
    const stopped = await stop({ draft, execution: state.row, recoveryId: recovery.id });
    await check();
    if (stopped?.confirmed !== true || stopped.runtimeSessionId !== state.row.runtimeSessionId)
      fail('NATIVE_EXECUTION_STOP_UNCONFIRMED');
    state.row = await store.recoveryStopped({ row: state.row });
    return yieldPending();
  }
  await fence.activate(executionIdentity(state.row), {
    writerGeneration: nativeWriterGeneration(state.row),
    recoveryId: recovery.id,
    checkpointId: state.row.recoveryCheckpoint.id,
  });
  await check();
  let report;
  let phase = 'recover';
  try {
    const ack = await observedInvoke({
      execution: state.row,
      payload: {
        command: 'native-recover',
        schemaVersion: 1,
        ...writerPayload(state.row),
        recoveryId: recovery.id,
        sequence: state.row.publication.sequence,
        checkpoint: state.row.recoveryCheckpoint,
        publication: state.row.publication,
        interaction: state.row.interaction,
        configuration: executionRuntimeConfiguration(draft, state.row),
        imageDigest: state.row.configuration.image.digest,
        package: { candidate: draft.candidate, archiveReceipt: draft.archiveReceipt },
      },
    });
    await check();
    checkReportIdentity(state.row, ack);
    phase = 'status';
    report = ack.status === 'recovery_ready' ? ack : await status();
  } catch (error) {
    if (recoveryReadRejected(error)) return requireRecovery('RESTORE_FAILED');
    const failureClass = statusReadFailure(error);
    if (!failureClass) throw error;
    // Recovery deduplicates the exact episode/generation/checkpoint. An
    // unreadable acknowledgement or status does not prove restore failure.
    // Recheck authority and yield the lease; the next worker repeats only
    // that restore, never an accepted answer or a new writer admission.
    await check();
    observe({
      phase,
      stage: 'decision',
      code: 'STATUS_READ_RETRY',
      failureClass,
      controlStatus: state.row.status,
    });
    return yieldPending();
  }
  await check();
  checkReportIdentity(state.row, report);
  if (
    report.recoveryId !== recovery.id ||
    report.checkpointId !== state.row.recoveryCheckpoint.id ||
    report.sequence !== state.row.publication.sequence
  )
    return requireRecovery('RESTORE_FAILED');
  if (report.status === 'recovering' && report.recovered === false) return yieldPending();
  if (
    report.status !== 'recovery_ready' ||
    report.recovered !== false ||
    report.nativeSessionId !== state.row.publication.nativeSessionId
  )
    return requireRecovery('RESTORE_FAILED');
  state.row = await store.recovered({ row: state.row });
  return yieldPending();
};

export const reconcileNativeDispatch = async ({
  state,
  draft,
  store,
  fence,
  status,
  check,
  requireRecovery,
  advance,
  yieldPending,
  verifyCheckpoint,
  credentials,
  observedInvoke,
  identity,
  stop,
}) => {
  await fence.ensureActive(executionIdentity(state.row), writerOptions(state.row));
  // Once delivery has been attempted, never blindly replay a model turn.
  // Status may prove admission/completion; a cold or conflicting owner
  // cannot prove that a lost command was never executed.
  if (state.row.dispatch) {
    const report = await status();
    await check();
    checkReportIdentity(state.row, report);
    if (!admitted(state.row, report)) return requireRecovery('DELIVERY_UNCERTAIN');
    if (state.row.response) state.row = await store.dispatched({ row: state.row });
    else await advance({ status: 'RUNNING' });
    return yieldPending();
  }
  if (nativeTurnSequence(state.row) > 1) {
    const report = await status();
    await check();
    checkReportIdentity(state.row, report);
    if (!priorBoundary(state.row, report)) return requireRecovery('DELIVERY_UNCERTAIN');
    if (report.recovered === true) {
      if (!state.row.recoveryCheckpoint) return requireRecovery('CHECKPOINT_UNAVAILABLE');
      try {
        await verifyCheckpoint(
          state.row.recoveryCheckpoint,
          state.row.publication,
          state.row.interaction,
        );
      } catch (error) {
        if (['NATIVE_RECOVERY_INVALID', 'NATIVE_RECOVERY_MISSING'].includes(error.code))
          return requireRecovery('CHECKPOINT_UNAVAILABLE');
        throw error;
      }
      state.row = await store.beginRecovery({ row: state.row });
      return yieldPending();
    }
  }
  const material = checkedCredentials(state.row, await credentials(state.row));
  if (
    !material?.ok ||
    material.source?.commit !== state.row.sourceCommit ||
    material.source?.branch !== state.row.sourceBranch
  )
    fail('NATIVE_EXECUTION_SOURCE_CHANGED');
  await check();
  const configuration = executionRuntimeConfiguration(draft, state.row);
  let payload = {
    command: 'native-start',
    schemaVersion: 1,
    ...writerPayload(state.row),
    imageDigest: state.row.configuration.image.digest,
    sequence: nativeTurnSequence(state.row),
    configuration,
    package: { candidate: draft.candidate, archiveReceipt: draft.archiveReceipt },
    credentials: { model: material.model, git: material.git },
  };
  let response;
  if (nativeTurnSequence(state.row) > 1) {
    if (state.row.response?.deliveryStatus !== 'pending' || !state.row.interaction)
      fail('NATIVE_EXECUTION_RUNTIME_MISMATCH');
    response = await store.response(state.row, state.row.response.interactionId);
    if (
      !response ||
      response.commandId !== state.row.response.commandId ||
      response.sequence !== nativeTurnSequence(state.row) ||
      response.interactionId !== state.row.interaction.id ||
      response.contentSha256 !== state.row.interactionContentSha256
    )
      fail('NATIVE_EXECUTION_RUNTIME_MISMATCH');
    payload = {
      command: 'native-continue',
      schemaVersion: 1,
      ...writerPayload(state.row),
      sequence: response.sequence,
      requestId: response.commandId,
      priorInteractionId: response.interactionId,
      priorPublicationId: state.row.publication.id,
      text: response.text,
      configuration,
      credentials: { model: material.model, git: material.git },
    };
  }
  await check();
  state.row = await store.dispatchAttempted({ row: state.row });
  await check();
  const result = await observedInvoke({ execution: state.row, payload });
  try {
    await check();
  } catch (error) {
    const latest = await store.get(identity);
    if (latest?.cancelRequested) {
      await fence.cancel(executionIdentity(latest));
      await stop({ draft, execution: latest });
    }
    throw error;
  }
  checkReportIdentity(state.row, result);
  if (!admitted(state.row, result)) fail('NATIVE_EXECUTION_RUNTIME_MISMATCH');
  if (response) state.row = await store.dispatched({ row: state.row });
  else await advance({ status: 'RUNNING' });
  return yieldPending();
};

export const verifyCompletedNativeTurn = async ({
  state,
  report,
  store,
  publications,
  interactions,
  check,
  verifyCheckpoint,
  yieldPending,
}) => {
  const receipt = report.receipt;
  const timing = (boundary, counts = {}) =>
    recordNativeBoundary(executionIdentity(state.row), boundary, Date.now(), {
      sequence: nativeTurnSequence(state.row),
      ...counts,
    });
  timing('publicationVerificationStarted');
  const manifest = await publications.read(executionIdentity(state.row), receipt, {
    verifyFiles: true,
  });
  if (
    manifest.packageId !== state.row.configuration.packageId ||
    manifest.repository.commit !== state.row.sourceCommit ||
    manifest.repository.branch !== state.row.sourceBranch ||
    receipt.sequence !== nativeTurnSequence(state.row)
  )
    fail('NATIVE_PUBLICATION_INVALID');
  if (manifest.sourceBaseline && !state.row.publication)
    await publications.source(executionIdentity(state.row), manifest, { verifyFiles: true });
  if (state.row.publication) {
    const previous = await publications.read(
      {
        ...executionIdentity(state.row),
        epoch: state.row.publicationEpoch,
      },
      state.row.publication,
    );
    if (
      JSON.stringify(previous.sourceBaseline ?? null) !==
      JSON.stringify(manifest.sourceBaseline ?? null)
    )
      fail('NATIVE_PUBLICATION_INVALID');
  }
  await check();
  timing('publicationVerificationCompleted', {
    files: manifest.files?.length,
    bytes: manifest.files?.reduce((total, file) => total + file.bytes, 0),
  });
  const interaction = report.interaction;
  let interactionContentSha256;
  if (interaction) {
    if (!interactions) fail('NATIVE_INTERACTION_INVALID');
    timing('interactionVerificationStarted');
    const body = await interactions.read(executionIdentity(state.row), interaction);
    if (
      body.packageId !== state.row.configuration.packageId ||
      body.harness !== state.row.configuration.harness ||
      body.sequence !== nativeTurnSequence(state.row) ||
      body.publicationId !== receipt.id ||
      body.nativeSessionId !== receipt.nativeSessionId
    )
      fail('NATIVE_INTERACTION_INVALID');
    interactionContentSha256 = body.contentSha256;
    await check();
    timing('interactionVerificationCompleted');
  }
  const checkpoint = report.checkpoint;
  if (checkpoint) {
    await verifyCheckpoint(
      checkpoint,
      receipt,
      interaction,
      nativeWriterGeneration(state.row),
      manifest,
    );
  }
  timing('authorityAdmissionStarted');
  state.row = await store.publish({
    row: state.row,
    publication: receipt,
    ...(interaction ? { interaction, interactionContentSha256 } : {}),
    ...(checkpoint ? { checkpoint } : {}),
  });
  timing('authorityAdmissionCompleted');
  return yieldPending();
};
