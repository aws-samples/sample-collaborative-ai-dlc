import { createHash } from 'node:crypto';
import { nativeTurnSequence, nativeWriterGeneration } from './execution-store.js';
import { executionIdentity, executionRuntimeConfiguration } from './execution-runtime.js';
import { recordNativeBoundary } from '../shared/native-lifecycle.js';
import { nativeDiagnosticError, nativeDiagnosticPhase } from './execution-diagnostics.js';
import { nativeRuntimeCommand } from '../shared/native-runtime-command.js';
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
export const writerPayload = (row) => ({
  ...executionIdentity(row),
  ...writerOptions(row),
});
export const checkReportIdentity = (row, report) => {
  if (
    Object.entries(executionIdentity(row)).some(([key, value]) => report?.[key] !== value) ||
    report?.writerGeneration !== nativeWriterGeneration(row)
  )
    fail('NATIVE_EXECUTION_RUNTIME_MISMATCH');
};
export const admitted = (row, report) =>
  report?.sequence === nativeTurnSequence(row) &&
  (row.workspaceResume?.sequence === nativeTurnSequence(row)
    ? report.requestId === row.workspaceResume.id
    : !row.response || report.requestId === row.response.commandId) &&
  ['preparing', 'running', 'publishing', 'publication_ready'].includes(report.status) &&
  (report.recovered !== true || report.status === 'publication_ready');
export const priorBoundary = (row, report) =>
  report?.sequence === row.publication?.sequence &&
  report?.nativeSessionId === row.publication?.nativeSessionId &&
  report.status === 'publication_ready' &&
  report.receipt?.id === row.publication.id &&
  report.interaction?.id === row.interaction?.id;
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
export const workflowRecoveryFailure = (code) =>
  code === 'native_execution_workflow_not_created'
    ? 'INTAKE_UNAVAILABLE'
    : code === 'native_execution_workflow_state_unavailable'
      ? 'WORKFLOW_STATE_UNAVAILABLE'
      : null;
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
export const runtimeOwnerRejected = (error) =>
  statusOwnerErrors.has(error?.code) || runtimeReadFailures.get(error)?.kind === 'OWNER_REJECTED';
export const statusReadFailure = (error) => {
  if (runtimeOwnerRejected(error)) return null;
  const kind = runtimeReadFailures.get(error)?.kind;
  if (kind) return kind;
  // Injected SDK ports can throw the same transport errors without going
  // through our adapter. A report-identity mismatch is never in this set.
  if (error?.name === 'RuntimeClientError' || shortTransportRetry(error)) return 'SDK_FAILURE';
  return null;
};
export const catchUpNativeActivity = async ({
  row,
  report,
  activity,
  invoke,
  check,
  observe,
  controlCall,
}) => {
  if (!activity || !report?.capabilities?.includes('activity-v1')) return { kind: 'ready' };
  try {
    let after = await controlCall('activity-cursor', () => activity.cursor(row));
    for (let page = 0; page < 4; page++) {
      await check();
      const batch = await invoke({
        execution: row,
        payload: { command: 'native-activity', ...writerPayload(row), after },
      });
      await check();
      const persisted = await controlCall('activity-ingest', () => activity.ingest(row, batch));
      // Only a durably stored cursor acknowledges activity. A lost transaction
      // reply must be reconciled by the activity owner before a later pull.
      if (persisted === after && !batch.events?.length) {
        if (
          !batch.complete &&
          ['publication_ready', 'failed', 'cancelled', 'stopped_needs_review'].includes(
            report.status,
          )
        )
          return { kind: batch.cold ? 'unclosed' : 'pending' };
        return { kind: 'ready' };
      }
      after = persisted;
    }
    return { kind: 'pending' };
  } catch (error) {
    // A conditional activity write can fail because execution ownership moved.
    // Establish that first, even when the transport did not preserve its code.
    await check();
    const failureClass = runtimeOwnerRejected(error)
      ? 'OWNER_REJECTED'
      : (statusReadFailure(error) ??
        {
          NATIVE_EXECUTION_UNAVAILABLE: 'AUTHORITY_UNAVAILABLE',
          NATIVE_ACTIVITY_CONFLICT: 'ACTIVITY_CONFLICT',
        }[error?.code] ??
        (['TransactionCanceledException', 'ConditionalCheckFailedException'].includes(error?.name)
          ? 'ACTIVITY_CONFLICT'
          : null));
    if (!failureClass) throw error;
    observe({
      phase: 'activity',
      stage: 'decision',
      code: 'ACTIVITY_READ_RETRY',
      controlStatus: row.status,
      failureClass,
      ...nativeDiagnosticError(error),
    });
    // The status observation already identified the current writer. A failed
    // catch-up cannot replace that observation with a recovery verdict.
    return { kind: 'pending' };
  }
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
  if (['NATIVE_PUBLICATION_INVALID', 'NATIVE_INTERACTION_INVALID'].includes(error?.code))
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

const recoveryPayload = async (row, draft, credentials) => {
  const configuration = executionRuntimeConfiguration(draft, row);
  const common = {
    ...writerPayload(row),
    recoveryId: row.recovery.id,
    configuration,
    imageDigest: row.configuration.image.digest,
    package: { candidate: draft.candidate, archiveReceipt: draft.archiveReceipt },
  };
  const material = checkedCredentials(row, await credentials(row));
  if (
    !material?.ok ||
    material.source?.commit !== row.sourceCommit ||
    material.source?.branch !== row.sourceBranch
  )
    fail('NATIVE_EXECUTION_SOURCE_CHANGED');
  return nativeRuntimeCommand({
    ...common,
    command: 'native-resume',
    schemaVersion: 2,
    sequence: nativeTurnSequence(row),
    credentials: { model: material.model, git: material.git },
  });
};

// Interpret an owned runtime response only after the caller checks its identity.
// Resume admission never reconstructs a lost acknowledgement or replays an answer.
const completeNativeRecovery = async ({ state, report, store, requireRecovery, yieldPending }) => {
  const recovery = state.row.recovery;
  const unavailableWorkflow = workflowRecoveryFailure(report.code);
  if (unavailableWorkflow) return requireRecovery(unavailableWorkflow);
  if (
    report.status === 'stopped_needs_review' &&
    report.code === 'native_execution_existing_owner' &&
    report.accepted === false &&
    report.duplicate === true &&
    report.recoveryId === recovery.id
  )
    return requireRecovery('RESTORE_FAILED', {
      workflowResumeState: report.workflowResumeState,
    });
  if (report.recoveryId !== recovery.id || !admitted(state.row, report))
    return requireRecovery('RESTORE_FAILED');
  state.row = await store.recovered({ row: state.row });
  return yieldPending();
};

export const reconcileNativeRecovery = async ({
  state,
  draft,
  store,
  requireRecovery,
  fence,
  check,
  stop,
  yieldPending,
  observedInvoke,
  status,
  observe,
  credentials,
  controlCall = (_operation, call) => call(),
}) => {
  const recovery = state.row.recovery;
  if (recovery.workflowResumeState !== 'created')
    return requireRecovery(
      recovery.workflowResumeState === 'not_created'
        ? 'INTAKE_UNAVAILABLE'
        : 'WORKFLOW_STATE_UNAVAILABLE',
    );
  if (recovery.phase === 'FENCING') {
    await controlCall('fence-suspend', () =>
      fence.suspend(executionIdentity(state.row), {
        writerGeneration: recovery.previousGeneration,
        recoveryId: recovery.id,
        reason: recovery.reason,
        workflowResumeState: recovery.workflowResumeState,
      }),
    );
    await check();
    // Workspace confirmation already requires a durable, validated stop for
    // this predecessor. Reuse that proof after fencing and rechecking ownership:
    // repeating Stop days later can return 404 for the completed session.
    // A different generation/session must still obtain an exact positive response.
    const confirmation = state.row.stopConfirmation;
    const alreadyStopped =
      confirmation?.writerGeneration === recovery.previousGeneration &&
      confirmation?.runtimeSessionId === state.row.runtimeSessionId &&
      state.row.target?.runtimeArn === draft.runtimeArn;
    let stopped;
    if (!alreadyStopped) {
      stopped = await controlCall('stop', () =>
        stop({ draft, execution: state.row, recoveryId: recovery.id }),
      );
    }
    await check();
    if (
      !alreadyStopped &&
      (stopped?.confirmed !== true || stopped.runtimeSessionId !== state.row.runtimeSessionId)
    )
      fail('NATIVE_EXECUTION_STOP_UNCONFIRMED');
    state.row = await controlCall('authority-recovery-stopped', () =>
      store.recoveryStopped({ row: state.row }),
    );
    return yieldPending();
  }
  await controlCall('fence-activate', () =>
    fence.activate(executionIdentity(state.row), {
      writerGeneration: nativeWriterGeneration(state.row),
      recoveryId: recovery.id,
      recoveryMode: state.row.configuration.recoveryMode,
    }),
  );
  await check();
  let report;
  const phase = 'recover';
  try {
    const payload = await recoveryPayload(state.row, draft, credentials);
    await check();
    const ack = await observedInvoke({
      execution: state.row,
      payload,
    });
    await check();
    checkReportIdentity(state.row, ack);
    report = ack;
  } catch (error) {
    const unavailableWorkflow =
      workflowRecoveryFailure(error?.code) ??
      workflowRecoveryFailure(runtimeReadFailures.get(error)?.runtimeCode);
    if (unavailableWorkflow) return requireRecovery(unavailableWorkflow);
    if (
      [error?.code, runtimeReadFailures.get(error)?.runtimeCode].includes(
        'native_execution_workspace_invalid',
      )
    )
      return requireRecovery('WORKSPACE_UNAVAILABLE');
    if (recoveryReadRejected(error)) return requireRecovery('RESTORE_FAILED');
    const failureClass = statusReadFailure(error);
    if (!failureClass) throw error;
    if (error?.name === 'RuntimeClientError') {
      // AgentCore can replace the runtime's HTTP rejection with an opaque SDK
      // error. Do not infer its code from the message. A cold predecessor status
      // still observes the current EFS binding and workflow before any CLI spawn.
      // Use that observation only to deny recovery, never to acknowledge a
      // successor, replay input, or infer success from the prior publication.
      await check();
      const observed = await status({ predecessor: true });
      const predecessor = observed.kind === 'reported' ? observed.report : undefined;
      await check();
      if (predecessor?.recovered === true && priorBoundary(state.row, predecessor)) {
        if (predecessor.workflowResumeState === 'not_created')
          return requireRecovery('INTAKE_UNAVAILABLE');
        if (predecessor.workflowResumeState === 'unavailable')
          return requireRecovery('WORKFLOW_STATE_UNAVAILABLE');
      }
    }
    // Recovery deduplicates the exact episode and generation. An unreadable
    // acknowledgement does not prove resume failure. Recheck authority and
    // yield the lease; retries cannot replay an accepted answer or admit a new writer.
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
  return completeNativeRecovery({ state, report, store, requireRecovery, yieldPending });
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
  credentials,
  observedInvoke,
  observe,
}) => {
  await fence.ensureActive(executionIdentity(state.row), writerOptions(state.row));
  await check();
  // Once delivery has been attempted, never blindly replay a model turn.
  // Status may prove admission/completion; a cold or conflicting owner
  // cannot prove that a lost command was never executed.
  if (state.row.dispatch) {
    const observed = await status();
    if (observed.kind === 'retry') return yieldPending();
    if (observed.kind === 'owner-rejected') return requireRecovery('DELIVERY_UNCERTAIN');
    const { report } = observed;
    if (!admitted(state.row, report)) return requireRecovery('DELIVERY_UNCERTAIN');
    if (state.row.response) state.row = await store.dispatched({ row: state.row });
    else await advance({ status: 'RUNNING' });
    return yieldPending();
  }
  if (nativeTurnSequence(state.row) > 1) {
    const observed = await status();
    if (observed.kind === 'retry') return yieldPending();
    if (observed.kind === 'owner-rejected') return requireRecovery('DELIVERY_UNCERTAIN');
    const { report } = observed;
    if (!priorBoundary(state.row, report)) return requireRecovery('DELIVERY_UNCERTAIN');
    if (report.recovered === true) return requireRecovery('SESSION_LOST');
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
    schemaVersion: 2,
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
      schemaVersion: 2,
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
  nativeRuntimeCommand(payload);
  await check();
  state.row = await store.dispatchAttempted({ row: state.row });
  await check();
  let result;
  try {
    result = await observedInvoke({ execution: state.row, payload });
  } catch (error) {
    const failureClass = statusReadFailure(error);
    if (!failureClass) throw error;
    await check();
    observe({
      phase: nativeDiagnosticPhase(payload.command),
      stage: 'decision',
      code: 'DISPATCH_UNCERTAIN',
      controlStatus: state.row.status,
      failureClass,
      dispatchPresent: true,
      ...nativeDiagnosticError(error),
    });
    // The durable delivery marker forces subsequent workers to read status.
    // An unreadable acknowledgement cannot authorize another model command.
    return yieldPending();
  }
  await check();
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
    (manifest.git &&
      (manifest.git.provider !== state.row.configuration.repository.provider ||
        manifest.git.repository !== state.row.configuration.repository.repository ||
        !manifest.git.deleted)) ||
    receipt.sequence !== nativeTurnSequence(state.row)
  )
    fail('NATIVE_PUBLICATION_INVALID');
  if (manifest.sourceBaseline && (!state.row.publication || manifest.git))
    await publications.source(executionIdentity(state.row), manifest, {
      verifyFiles: !state.row.publication,
    });
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
  if (Object.hasOwn(report, 'checkpoint')) fail('NATIVE_PUBLICATION_INVALID');
  timing('authorityAdmissionStarted');
  state.row = await store.publish({
    row: state.row,
    publication: receipt,
    ...(interaction ? { interaction, interactionContentSha256 } : {}),
  });
  timing('authorityAdmissionCompleted');
  return yieldPending();
};
