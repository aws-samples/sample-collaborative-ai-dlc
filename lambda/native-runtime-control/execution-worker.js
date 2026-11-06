import {
  fail,
  recoveryStopId,
  writerOptions,
  writerPayload,
  checkReportIdentity,
  admitted,
  ownerErrors,
  statusOwnerErrors,
  workflowRecoveryFailure,
  markRuntimeReadFailure,
  failRuntimeRead,
  shortTransportRetry,
  runtimeOwnerRejected,
  statusReadFailure,
  catchUpNativeActivity,
  phaseError,
  checkedCredentials,
  reconcileNativeRecovery,
  reconcileNativeDispatch,
  verifyCompletedNativeTurn,
} from './execution-lifecycle.js';
import { createHash } from 'node:crypto';
import { nativeRuntimeFailureCode } from '../shared/native-execution-failure.js';
import { nativeWorkspaceRecovery } from '../shared/native-recovery-mode.js';
import gremlin from 'gremlin';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { getUrlAndHeaders } from 'gremlin-aws-sigv4/lib/utils.js';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
  StopRuntimeSessionCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import { BedrockAgentCoreControlClient } from '@aws-sdk/client-bedrock-agentcore-control';
import { IAMClient } from '@aws-sdk/client-iam';
import { EFSClient } from '@aws-sdk/client-efs';
import { S3Client } from '@aws-sdk/client-s3';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { ID, UUID_V4, matches } from './store.js';
import { nativeTurnSequence, nativeWriterGeneration } from './execution-store.js';
import { createExecutionRuntimeUpgrade, executionIdentity } from './execution-runtime.js';
import { nativeDeploymentFromEnv } from './worker.js';
import { createNativePublications } from '../shared/native-publication.js';
import { createNativeInteractions } from '../shared/native-interaction.js';
import { createNativeExecutionFence } from '../shared/native-execution-fence.js';
import { createWorkflowSourceService } from '../shared/workflow-source-service.js';
import { fetchWorkflowSourceMembership } from '../shared/workflow-source-membership.js';
import { createNativeRuntimeImagePolicy } from './runtime-images.js';
import { executionObservationPort, nativeAuthorityPort } from './authority-client.js';
import { recordNativeBoundary } from '../shared/native-lifecycle.js';
import {
  createNativeExecutionDiagnostics,
  emitNativeExecutionDiagnostic,
  nativeDiagnosticError,
  nativeDiagnosticPhase,
  nativeDiagnosticReport,
  nativeDiagnosticResponse,
} from './execution-diagnostics.js';

export const createNativeExecutionSupervisor =
  ({
    store,
    preparationStore,
    upgrade,
    authorize,
    credentials,
    invoke,
    stop,
    publications,
    interactions,
    fence,
    diagnostics,
    imagePolicy,
    activity,
    now = Date.now,
  }) =>
  async (identity) => {
    const state = { row: undefined };
    const observe = (value) => emitNativeExecutionDiagnostic(diagnostics, value);
    const controlCall = async (operation, call) => {
      try {
        return await call();
      } catch (error) {
        observe({
          phase: state.row?.status === 'RECOVERING' ? 'recover' : 'unknown',
          stage: 'call',
          code: 'CALL_FAILED',
          operation,
          controlStatus: state.row?.status,
          writerGeneration: state.row?.writerGeneration,
          ...nativeDiagnosticError(error),
        });
        throw error;
      }
    };
    let draft;
    let observation = {};
    let workflowResumeState;
    const observedInvoke = async (input) => {
      const phase = nativeDiagnosticPhase(input.payload.command);
      if (['native-start', 'native-continue', 'native-resume'].includes(input.payload.command))
        recordNativeBoundary(executionIdentity(state.row), 'dispatchStarted', now(), {
          sequence: nativeTurnSequence(state.row),
          writerGeneration: nativeWriterGeneration(state.row),
        });
      try {
        const report = await invoke(input);
        observation = { phase, ...nativeDiagnosticReport(input.execution, report) };
        observe({ ...observation, stage: 'report', code: 'REPORT_OBSERVED' });
        return report;
      } catch (error) {
        observation = { phase, ...nativeDiagnosticError(error) };
        observe({ ...observation, stage: 'call', code: 'CALL_FAILED' });
        throw error;
      }
    };
    const current = async ({ allowCancelled = false } = {}) => {
      const latest = await controlCall('authority-read', () => store.get(identity));
      if (
        !latest ||
        latest.bindingId !== state.row.bindingId ||
        latest.version !== state.row.version ||
        latest.epoch !== state.row.epoch ||
        latest.leaseToken !== state.row.leaseToken ||
        latest.leaseExpiresAt <= now() ||
        (!allowCancelled && latest.cancelRequested)
      )
        fail('NATIVE_EXECUTION_LEASE_LOST');
      if (!draft || draft.bindingId !== state.row.bindingId)
        fail('NATIVE_EXECUTION_SOURCE_CHANGED');
      return latest;
    };
    const check = async () => {
      await current();
      await controlCall('authorization', () => authorize({ draft, execution: state.row }));
      await current();
    };
    const advance = async (patch, stopped) => {
      state.row = await store.advance({
        row: state.row,
        patch,
        ...stopEvidence(stopped),
      });
    };
    const stopEvidence = (stopped) => {
      if (stopped?.confirmed !== true || !state.row.target) return {};
      if (stopped.runtimeSessionId !== state.row.runtimeSessionId)
        fail('NATIVE_EXECUTION_STOP_UNCONFIRMED');
      return { stoppedSessionId: stopped.runtimeSessionId };
    };
    const yieldPending = async (status = state.row.status) => {
      state.row = await controlCall('authority-release', () => store.release({ row: state.row }));
      return { pending: true, status };
    };
    const requireRecovery = async (requestedReason, deniedResumeObservation) => {
      const observedState = deniedResumeObservation
        ? deniedResumeObservation.workflowResumeState
        : workflowResumeState;
      const verifiedState = ['created', 'not_created', 'unavailable'].includes(observedState)
        ? observedState
        : 'unavailable';
      const observedWorkflow =
        requestedReason === 'INTAKE_UNAVAILABLE'
          ? 'not_created'
          : ['WORKSPACE_UNAVAILABLE', 'WORKFLOW_STATE_UNAVAILABLE'].includes(requestedReason)
            ? 'unavailable'
            : verifiedState;
      const reason =
        requestedReason === 'WORKSPACE_UNAVAILABLE' || observedWorkflow === 'created'
          ? requestedReason
          : observedWorkflow === 'not_created'
            ? 'INTAKE_UNAVAILABLE'
            : 'WORKFLOW_STATE_UNAVAILABLE';
      const workflowEvidence = { workflowResumeState: observedWorkflow };
      observe({
        ...observation,
        stage: 'decision',
        code: 'RECOVERY_REQUIRED',
        reason,
        controlStatus: state.row.status,
        dispatchPresent: Boolean(state.row.dispatch),
      });
      try {
        await check();
        const recoveryId = recoveryStopId(state.row, reason);
        if (
          ['INTAKE_UNAVAILABLE', 'WORKFLOW_STATE_UNAVAILABLE'].includes(reason) &&
          state.row.status === 'RECOVERING' &&
          state.row.recovery.phase === 'RESTORING'
        ) {
          const predecessor = await fence.read(executionIdentity(state.row));
          await check();
          if (
            predecessor.state === 'FENCED' &&
            predecessor.writerGeneration === state.row.recovery.previousGeneration &&
            state.row.recovery.previousGeneration + 1 === nativeWriterGeneration(state.row) &&
            ((predecessor.recoveryId === state.row.recovery.id &&
              predecessor.reason === state.row.recovery.reason) ||
              (predecessor.recoveryId === recoveryId && predecessor.reason === reason))
          ) {
            // RESTORING is protected proof that this predecessor was positively
            // stopped. No successor was admitted by this closed fence. Keep its
            // generation closed and replace only the admission episode so a
            // delayed activation CAS cannot reopen it after we block recovery.
            // The deterministic ID also resumes a crash before the table commit.
            await fence.suspend(executionIdentity(state.row), {
              writerGeneration: state.row.recovery.previousGeneration,
              recoveryId,
              reason,
              ...workflowEvidence,
            });
            await check();
            state.row = await store.recoveryRequired({
              row: state.row,
              reason,
              recoveryId,
              ...workflowEvidence,
            });
            return { pending: false, status: state.row.status, reason };
          }
        }
        await fence.suspend(executionIdentity(state.row), {
          ...writerOptions(state.row),
          recoveryId,
          reason,
          ...workflowEvidence,
        });
        await check();
        const stopped = await stop({ draft, execution: state.row, recoveryId });
        await check();
        if (stopped?.confirmed !== true || stopped.runtimeSessionId !== state.row.runtimeSessionId)
          fail('NATIVE_EXECUTION_STOP_UNCONFIRMED');
        state.row = await store.recoveryRequired({
          row: state.row,
          reason,
          recoveryId,
          ...workflowEvidence,
          ...stopEvidence(stopped),
        });
        return { pending: false, status: state.row.status, reason };
      } catch (error) {
        if (!shortTransportRetry(error)) throw error;
        await current();
        return await yieldPending();
      }
    };
    const status = async ({ predecessor = false } = {}) => {
      if (
        predecessor &&
        (!nativeWorkspaceRecovery(state.row.configuration) ||
          state.row.status !== 'RECOVERING' ||
          state.row.recovery.phase !== 'RESTORING' ||
          state.row.stopConfirmation?.writerGeneration !== state.row.recovery.previousGeneration ||
          state.row.stopConfirmation.runtimeSessionId !== state.row.runtimeSessionId)
      )
        fail('NATIVE_EXECUTION_RUNTIME_MISMATCH');
      const writer = predecessor
        ? { ...state.row, writerGeneration: state.row.recovery.previousGeneration }
        : state.row;
      if (!predecessor) workflowResumeState = undefined;
      let report;
      try {
        report = await observedInvoke({
          execution: writer,
          payload: { command: 'native-status', ...writerPayload(writer) },
        });
      } catch (error) {
        await check();
        if (runtimeOwnerRejected(error)) return { kind: 'owner-rejected' };
        const failureClass = statusReadFailure(error);
        if (!failureClass) throw error;
        observe({
          ...observation,
          phase: 'status',
          stage: 'decision',
          code: 'STATUS_READ_RETRY',
          failureClass,
          controlStatus: state.row.status,
          dispatchPresent: Boolean(state.row.dispatch),
        });
        return { kind: 'retry' };
      }
      await check();
      try {
        checkReportIdentity(writer, report);
      } catch (error) {
        // A resumed writer can answer a predecessor probe. That is not proof
        // about the old workspace and cannot acknowledge successor admission.
        if (predecessor && error?.code === 'NATIVE_EXECUTION_RUNTIME_MISMATCH')
          return { kind: 'owner-rejected' };
        throw error;
      }
      // Only a fresh status response from this exact writer can establish the
      // current filesystem phase. Published files and earlier observations
      // cannot prove that an interrupted turn did or did not create a workflow.
      if (
        !predecessor &&
        nativeWorkspaceRecovery(state.row.configuration) &&
        ['created', 'not_created', 'unavailable'].includes(report.workflowResumeState)
      )
        workflowResumeState = report.workflowResumeState;
      return { kind: 'reported', report };
    };
    try {
      const initial = await controlCall('authority-read', () => store.get(identity));
      if (!initial) return { pending: false, status: 'missing' };
      if (!nativeWorkspaceRecovery(initial.configuration)) fail('NATIVE_EXECUTION_INVALID');
      const claim = await controlCall('authority-claim', () =>
        store.claim({ ...identity, bindingId: initial.bindingId }),
      );
      if (claim.kind !== 'claimed') return { pending: claim.kind === 'busy', status: claim.kind };
      state.row = claim.row;
      draft = await controlCall('preparation-read', () => preparationStore.get(identity));
      if (state.row.cancelRequested) {
        await current({ allowCancelled: true });
        // A transport accepted before cancellation can arrive after Stop.
        // This controller-only fence also denies that late start in a new VM.
        await fence.cancel(executionIdentity(state.row));
        await current({ allowCancelled: true });
        // The original session ID remains fixed even after cancellation fences
        // the epoch. Stop uses protected runtime/session pins, never agent text.
        const stopped = await stop({ draft, execution: state.row });
        await current({ allowCancelled: true });
        await advance({ status: 'CANCELLED' }, stopped);
        return { pending: false, status: 'CANCELLED' };
      }
      await check();
      // An administrator revocation fences active execution before any status
      // read, dispatch or recovery step. Committed results stay readable and a
      // pending graph projection of already-published content still completes.
      if (
        imagePolicy &&
        ['REQUESTED', 'UPGRADING', 'DISPATCHING', 'RUNNING', 'RECOVERING'].includes(
          state.row.status,
        ) &&
        (await controlCall('image-policy', () =>
          imagePolicy.revocation(state.row.configuration.image.digest),
        ))
      ) {
        observe({ stage: 'decision', code: 'IMAGE_REVOKED', controlStatus: state.row.status });
        await current();
        await fence.cancel(executionIdentity(state.row));
        await current();
        const stopped = await stop({ draft, execution: state.row });
        await current();
        await advance({ status: 'FAILED', failureCode: 'native_execution_image_revoked' }, stopped);
        return { pending: false, status: 'FAILED', failureCode: 'native_execution_image_revoked' };
      }
      if (['DISPATCHING', 'RUNNING', 'RECOVERING'].includes(state.row.status) && fence.read) {
        const savedFence = await controlCall('fence-read', async () => {
          try {
            return await fence.read(executionIdentity(state.row));
          } catch (error) {
            if (!['NoSuchKey', 'NotFound'].includes(error?.name)) throw error;
          }
        });
        if (
          savedFence?.state === 'FENCED' &&
          savedFence.writerGeneration === nativeWriterGeneration(state.row) &&
          savedFence.recoveryId === recoveryStopId(state.row, savedFence.reason)
        ) {
          // Eligibility belongs to this protected stop episode. Reading the
          // runtime again could create a diagnostic VM after a successful stop
          // whose acknowledgement was lost. Retain its proof and stop token.
          workflowResumeState = savedFence.workflowResumeState;
          return await requireRecovery(savedFence.reason);
        }
      }
      if (state.row.status === 'REQUESTED') {
        await advance({ status: 'UPGRADING' });
        return await yieldPending();
      }
      if (state.row.status === 'UPGRADING') {
        if (!state.row.target) {
          const result = await upgrade({ draft, execution: state.row, authorize: check });
          if (result.ready) {
            recordNativeBoundary(executionIdentity(state.row), 'targetReady', now());
            await advance({ target: result.target });
          }
          return await yieldPending();
        }
        const material = checkedCredentials(state.row, await credentials(state.row));
        await check();
        if (!material?.ok || !material.source?.commit || !material.source.branch)
          fail('NATIVE_EXECUTION_SOURCE_CHANGED');
        await advance({
          sourceCommit: material.source.commit,
          sourceBranch: material.source.branch,
          status: 'DISPATCHING',
        });
        return await yieldPending();
      }
      if (state.row.status === 'RECOVERING') {
        return await reconcileNativeRecovery({
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
          controlCall,
        });
      }
      if (state.row.status === 'DISPATCHING') {
        return await reconcileNativeDispatch({
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
        });
      }
      if (state.row.status !== 'RUNNING') fail('NATIVE_EXECUTION_RUNTIME_MISMATCH');
      const observed = await status();
      if (observed.kind === 'retry') return await yieldPending();
      if (observed.kind === 'owner-rejected') return await requireRecovery('DELIVERY_UNCERTAIN');
      const { report } = observed;
      const unavailableWorkflow = nativeWorkspaceRecovery(state.row.configuration)
        ? workflowRecoveryFailure(report.code)
        : null;
      if (unavailableWorkflow) return await requireRecovery(unavailableWorkflow);
      if (report.recovered === true && !admitted(state.row, report))
        return await requireRecovery('DELIVERY_UNCERTAIN');
      if (report.sequence !== nativeTurnSequence(state.row))
        fail('NATIVE_EXECUTION_RUNTIME_MISMATCH');
      const caughtUp = await catchUpNativeActivity({
        row: state.row,
        report,
        activity,
        invoke: observedInvoke,
        check,
        observe,
        controlCall,
      });
      if (caughtUp.kind === 'unclosed') {
        observe({ phase: 'activity', stage: 'decision', code: 'ACTIVITY_UNCLOSED' });
        return await requireRecovery('DELIVERY_UNCERTAIN');
      }
      if (caughtUp.kind === 'pending') {
        observe({ phase: 'activity', stage: 'decision', code: 'ACTIVITY_PENDING' });
        return await yieldPending();
      }
      if (['preparing', 'running', 'publishing', 'cancelling'].includes(report.status))
        return await yieldPending();
      if (report.status === 'publication_ready') {
        return await verifyCompletedNativeTurn({
          state,
          report,
          store,
          publications,
          interactions,
          check,
          yieldPending,
        });
      }
      // Unknown/cold/stale ownership is not success and never starts a new
      // writer. Recovery is an explicit subsequent control-plane operation.
      observe({
        ...observation,
        stage: 'decision',
        code: 'RUNTIME_TERMINAL',
        controlStatus: state.row.status,
      });
      await current();
      await fence.cancel(executionIdentity(state.row));
      await current();
      const stopped = await stop({ draft, execution: state.row });
      await current();
      await advance({ status: 'FAILED', failureCode: nativeRuntimeFailureCode(report) }, stopped);
      return { pending: false, status: 'FAILED' };
    } catch (cause) {
      let error = cause;
      try {
        if (error?.code === 'NATIVE_EXECUTION_RUNTIME_MISMATCH' || runtimeOwnerRejected(error)) {
          if (state.row.status === 'RECOVERING') return await requireRecovery('RESTORE_FAILED');
          // A confirmed workspace resume runs without a Start/Continue dispatch.
          // Its current episode, turn and writer still identify in-flight work.
          const resumedWorkspace =
            state.row.status === 'RUNNING' &&
            nativeWorkspaceRecovery(state.row.configuration) &&
            state.row.workspaceResume?.id === state.row.lastRecoveryId &&
            state.row.workspaceResume?.sequence === nativeTurnSequence(state.row) &&
            state.row.workspaceResume?.writerGeneration === nativeWriterGeneration(state.row);
          if (
            resumedWorkspace ||
            (state.row.dispatch && ['DISPATCHING', 'RUNNING'].includes(state.row.status))
          )
            return await requireRecovery('DELIVERY_UNCERTAIN');
        }
        const terminal = phaseError(error);
        if (terminal) {
          await current();
          await fence.cancel(executionIdentity(state.row));
          await current();
          const stopped = await stop({ draft, execution: state.row });
          await current();
          await advance({ status: 'FAILED', failureCode: terminal }, stopped);
          return { pending: false, status: 'FAILED', failureCode: terminal };
        }
        if (shortTransportRetry(error) && state.row) {
          // SDK transport uncertainty retains the same attempt/session. Release
          // and send a fresh short-delay pointer instead of waiting for the long
          // queue visibility period reserved for a crashed Lambda invocation.
          await current({ allowCancelled: state.row.cancelRequested });
          return await yieldPending();
        }
      } catch (failure) {
        // Preserve the actual failed cleanup/recheck, including ownership loss.
        // A new worker reconciles durable state; this worker cannot adopt it.
        error = failure;
      }
      if (error?.code === 'NATIVE_EXECUTION_CONFLICT' && state.row) {
        try {
          await current({ allowCancelled: state.row.cancelRequested });
        } catch (changed) {
          error = changed;
        }
        // A conflict under unchanged authority is not evidence of takeover.
        if (error?.code === 'NATIVE_EXECUTION_CONFLICT') throw error;
      }
      if (['NATIVE_EXECUTION_LEASE_LOST', 'NATIVE_EXECUTION_CONFLICT'].includes(error?.code)) {
        observe({
          phase: 'unknown',
          stage: 'decision',
          code: 'OWNERSHIP_LOST',
          controlStatus: state.row?.status,
          ...nativeDiagnosticError(error),
        });
        return { pending: true, status: 'ownership_lost' };
      }
      if (
        ['NATIVE_EXECUTION_UNAVAILABLE', 'NATIVE_PREPARATION_UNAVAILABLE'].includes(error?.code) ||
        (!state.row && shortTransportRetry(error))
      ) {
        observe({
          phase: 'unknown',
          stage: 'decision',
          code: 'AUTHORITY_UNAVAILABLE',
          controlStatus: state.row?.status,
          ...nativeDiagnosticError(error),
        });
        // Ownership is unconfirmed. Leave its lease and delivery marker intact;
        // a later wakeup must read/claim authority before taking another step.
        return { pending: true, status: 'authority_unavailable' };
      }
      throw error;
    }
  };

export const readNativeRuntimeReport = async (
  response,
  { diagnostics, phase = 'unknown' } = {},
) => {
  const observe = (value) =>
    emitNativeExecutionDiagnostic(diagnostics, {
      phase,
      ...nativeDiagnosticResponse(response),
      ...value,
    });
  if (response?.contentType?.split(';')[0] !== 'application/json') {
    observe({ stage: 'http', code: 'CONTENT_TYPE_INVALID' });
    response?.response?.destroy?.();
    failRuntimeRead('NATIVE_EXECUTION_RUNTIME_UNAVAILABLE', 'CONTENT_TYPE_INVALID');
  }
  const chunks = [];
  let length = 0;
  let bodyRead = false;
  let oversized = false;
  try {
    for await (const chunk of response.response) {
      length += chunk.length;
      if (length > 256 * 1024) {
        oversized = true;
        observe({ stage: 'body', code: 'BODY_TOO_LARGE' });
        failRuntimeRead('NATIVE_EXECUTION_RUNTIME_MISMATCH', 'BODY_TOO_LARGE');
      }
      chunks.push(Buffer.from(chunk));
    }
    bodyRead = true;
    let value;
    try {
      value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (error) {
      observe({ stage: 'body', code: 'BODY_JSON_INVALID' });
      throw markRuntimeReadFailure(error, 'BODY_JSON_INVALID');
    }
    if (value?.ok === false && ownerErrors.has(value.code)) {
      observe({
        stage: 'report',
        code: 'OWNER_REJECTED',
        runtimeCode: value.code,
      });
      failRuntimeRead('NATIVE_EXECUTION_RUNTIME_MISMATCH', 'OWNER_REJECTED', value.code);
    }
    if (response.statusCode !== 200) {
      observe({ stage: 'http', code: 'HTTP_NON_200', runtimeCode: value?.code });
      failRuntimeRead(
        'NATIVE_EXECUTION_RUNTIME_UNAVAILABLE',
        value?.ok === false && statusOwnerErrors.has(value.code)
          ? 'OWNER_REJECTED'
          : 'HTTP_NON_200',
        value?.ok === false ? value.code : undefined,
      );
    }
    return value;
  } catch (error) {
    if (!bodyRead && !oversized) {
      observe({ stage: 'body', code: 'BODY_READ_FAILED', ...nativeDiagnosticError(error) });
      markRuntimeReadFailure(error, 'BODY_READ_FAILED');
    }
    throw error;
  } finally {
    response.response?.destroy?.();
  }
};

export const invokeNativeExecutionRuntime = async ({
  runtime,
  execution: row,
  payload,
  abortSignal,
  diagnostics,
}) => {
  const phase = nativeDiagnosticPhase(payload.command);
  let result;
  try {
    result = await runtime.send(
      new InvokeAgentRuntimeCommand({
        agentRuntimeArn: row.target.runtimeArn,
        qualifier: row.target.endpoint,
        runtimeSessionId: row.runtimeSessionId,
        contentType: 'application/json',
        accept: 'application/json',
        payload: Buffer.from(JSON.stringify(payload)),
      }),
      { abortSignal },
    );
  } catch (error) {
    emitNativeExecutionDiagnostic(diagnostics, {
      phase,
      stage: 'sdk',
      code: 'SDK_FAILURE',
      ...nativeDiagnosticError(error),
    });
    throw markRuntimeReadFailure(error, 'SDK_FAILURE');
  }
  return readNativeRuntimeReport(result, { diagnostics, phase });
};

// AWS documents that an explicitly stopped runtimeSessionId becomes active
// again on its next invocation. Never retry Stop with a new token after a
// successor could have started. Recovery only advances on the exact positive
// response; an arbitrary ResourceNotFound does not establish quiescence.
const hash = (value) => createHash('sha256').update(value).digest('hex');
export const stopNativeExecutionSession = async ({
  runtime,
  draft,
  execution: row,
  recoveryId,
  abortSignal,
}) => {
  if (!row.target) {
    if (recoveryId) fail('NATIVE_EXECUTION_STOP_UNCONFIRMED');
    return { confirmed: false };
  }
  if (row.target.runtimeArn !== draft.runtimeArn) fail('NATIVE_EXECUTION_RUNTIME_MISMATCH');
  const clientToken = hash(
    JSON.stringify({
      ...executionIdentity(row),
      writerGeneration: nativeWriterGeneration(row),
      reason: recoveryId ? 'recovery' : 'terminal',
      recoveryId: recoveryId ?? null,
      target: row.target,
    }),
  );
  try {
    const result = await runtime.send(
      new StopRuntimeSessionCommand({
        agentRuntimeArn: row.target.runtimeArn,
        qualifier: row.target.endpoint,
        runtimeSessionId: row.runtimeSessionId,
        clientToken,
      }),
      { abortSignal },
    );
    if (
      result.$metadata?.httpStatusCode !== 200 ||
      result.statusCode !== 200 ||
      result.runtimeSessionId !== row.runtimeSessionId
    )
      fail('NATIVE_EXECUTION_STOP_UNCONFIRMED');
    return { confirmed: true, runtimeSessionId: result.runtimeSessionId, clientToken };
  } catch (error) {
    if (!recoveryId && error?.name === 'ResourceNotFoundException')
      return { confirmed: false, absent: true };
    throw error;
  }
};

export const createNativeExecutionWorker =
  ({
    env = process.env,
    ddb = DynamoDBDocumentClient.from(new DynamoDBClient({})),
    sqs = new SQSClient({}),
    s3 = new S3Client({}),
    lambda = new LambdaClient({}),
    runtime = new BedrockAgentCoreClient({}),
    control = new BedrockAgentCoreControlClient({}),
    iam = new IAMClient({}),
    efs = new EFSClient({}),
    logger = console,
  } = {}) =>
  async (event, context) => {
    const failures = [];
    for (const record of event?.Records ?? []) {
      let connection;
      let identity;
      try {
        // Transport deadlines leave time to persist/requeue within this short
        // controller invocation. They do not bound the asynchronous model turn.
        const deadline =
          Date.now() + Math.min(context?.getRemainingTimeInMillis?.() ?? 120000, 120000) - 8000;
        const transportSignal = (maximum) => {
          const remaining = Math.min(maximum, deadline - Date.now());
          if (remaining < 1000) fail('NATIVE_EXECUTION_RETRY');
          return AbortSignal.timeout(remaining);
        };
        identity = JSON.parse(record.body);
        if (
          !identity ||
          Object.keys(identity).toSorted().join(',') !== 'executionId,projectId' ||
          !matches(identity.projectId, ID) ||
          !matches(identity.executionId, UUID_V4)
        )
          continue;
        const diagnostics = createNativeExecutionDiagnostics({ logger, scope: identity });
        const deployment = nativeDeploymentFromEnv(env);
        const authorityOptions = { lambda, functionName: env.NATIVE_AUTHORITY_FUNCTION };
        const preparationStore = nativeAuthorityPort(
          'execution',
          'preparation',
          ['get'],
          authorityOptions,
        );
        const store = executionObservationPort(authorityOptions);
        if (env.NATIVE_CANCELLATION_ONLY === 'true') {
          const row = await store.observeRevocation(identity);
          if (!row?.cancelRequested) continue;
        }
        let graphPromise;
        const graph = () =>
          (graphPromise ??= (async () => {
            const credentials = await fromNodeProviderChain()();
            const { url, headers } = getUrlAndHeaders(
              env.NEPTUNE_ENDPOINT,
              '8182',
              {
                ...credentials,
                region: env.AWS_REGION,
              },
              '/gremlin',
              'wss',
            );
            connection = new gremlin.driver.DriverRemoteConnection(url, { headers });
            return gremlin.process.AnonymousTraversalSource.traversal().withRemote(connection);
          })());
        const membership = async (projectId, actorId) =>
          fetchWorkflowSourceMembership(await graph(), projectId, actorId);
        const sources = createWorkflowSourceService({ ddb, getMembershipSnapshot: membership });
        const publications = createNativePublications({
          s3,
          bucket: env.NATIVE_EXECUTION_PUBLICATION_BUCKET,
          accountId: env.NATIVE_RUNTIME_ACCOUNT_ID,
        });
        const interactions = createNativeInteractions({
          s3,
          bucket: env.NATIVE_EXECUTION_PUBLICATION_BUCKET,
          accountId: env.NATIVE_RUNTIME_ACCOUNT_ID,
        });
        const reconcile = createNativeExecutionSupervisor({
          store,
          preparationStore,
          publications,
          interactions,
          diagnostics,
          activity: nativeAuthorityPort(
            'execution',
            'activity',
            ['cursor', 'ingest'],
            authorityOptions,
          ),
          imagePolicy: createNativeRuntimeImagePolicy({
            ddb,
            tableName: env.NATIVE_RUNTIME_BINDINGS_TABLE,
            env,
          }),
          fence: createNativeExecutionFence({
            s3,
            bucket: env.NATIVE_EXECUTION_PUBLICATION_BUCKET,
            accountId: env.NATIVE_RUNTIME_ACCOUNT_ID,
          }),
          authorize: async ({ draft, execution }) => {
            const member = await membership(draft.projectId, execution.startedBy);
            if (
              !['member', 'admin', 'owner'].includes(member?.role) ||
              member.projectIdentity !== draft.projectIdentity
            )
              fail('NATIVE_EXECUTION_FORBIDDEN');
            await sources.getAuthorizedBinding({
              projectId: draft.projectId,
              actorId: execution.startedBy,
              sourceId: draft.request.sourceId,
              expectedRevision: draft.request.bindingRevision,
            });
          },
          upgrade: ({ authorize, ...input }) =>
            createExecutionRuntimeUpgrade({
              iam,
              control,
              efs,
              deployment,
              authorize,
            })(input),
          credentials: async (row) => {
            const result = await lambda.send(
              new InvokeCommand({
                FunctionName: env.NATIVE_EXECUTION_CREDENTIALS_FUNCTION,
                InvocationType: 'RequestResponse',
                Payload: Buffer.from(
                  JSON.stringify({
                    ...row.scope,
                    attemptId: row.attemptId,
                    epoch: row.epoch,
                  }),
                ),
              }),
              { abortSignal: transportSignal(20000) },
            );
            if (result.FunctionError) fail('NATIVE_EXECUTION_CREDENTIALS_UNAVAILABLE');
            return JSON.parse(Buffer.from(result.Payload).toString('utf8'));
          },
          invoke: (input) =>
            invokeNativeExecutionRuntime({
              ...input,
              runtime,
              abortSignal: transportSignal(80000),
              diagnostics,
            }),
          stop: (input) =>
            stopNativeExecutionSession({
              ...input,
              runtime,
              abortSignal: transportSignal(10000),
            }),
        });
        const result = await reconcile(identity);
        if (result.pending) {
          // A fresh queue pointer for normal polling avoids exhausting a
          // receive-count budget during a legitimately long model turn.
          const sent = await sqs.send(
            new SendMessageCommand({
              QueueUrl: env.NATIVE_EXECUTION_QUEUE_URL,
              DelaySeconds: 5,
              MessageBody: JSON.stringify(identity),
            }),
          );
          if (!sent.MessageId) fail('NATIVE_EXECUTION_QUEUE_UNAVAILABLE');
        }
        logger.info(
          JSON.stringify({
            event: 'native_execution_reconciled',
            scopeHash: createHash('sha256').update(JSON.stringify(identity)).digest('hex'),
            status: result.status,
          }),
        );
      } catch (error) {
        // No event, payload, environment, provider response or error message is
        // logged on a path which can hold model/source-control credentials.
        logger.warn(
          JSON.stringify({
            event: 'native_execution_retry',
            code: /^[A-Z_]{1,80}$/.test(error?.code ?? '') ? error.code : 'NATIVE_EXECUTION_RETRY',
          }),
        );
        failures.push({ itemIdentifier: record.messageId });
      } finally {
        if (connection) await connection.close().catch(() => {});
      }
    }
    return { batchItemFailures: failures };
  };

// SDK connection pools belong to the warm worker; execution state remains per record.
let worker;
export const handler = (event, context) =>
  (worker ??= createNativeExecutionWorker())(event, context);
