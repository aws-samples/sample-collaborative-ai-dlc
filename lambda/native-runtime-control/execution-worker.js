import {
  fail,
  hash,
  recoveryStopId,
  writerOptions,
  verifyPublicProjectFiles,
  writerPayload,
  checkReportIdentity,
  admitted,
  ownerErrors,
  statusOwnerErrors,
  markRuntimeReadFailure,
  failRuntimeRead,
  shortTransportRetry,
  statusReadFailure,
  phaseError,
  checkedCredentials,
  reconcileNativeRecovery,
  reconcileNativeDispatch,
  verifyCompletedNativeTurn,
} from './execution-lifecycle.js';
import { createHash } from 'node:crypto';
import { nativeRuntimeFailureCode } from '../shared/native-execution-failure.js';
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
import {
  createExecutionRuntimeUpgrade,
  executionIdentity,
  executionRuntimeConfiguration,
} from './execution-runtime.js';
import { nativeDeploymentFromEnv } from './worker.js';
import { createNativePublications } from '../shared/native-publication.js';
import { createNativeInteractions } from '../shared/native-interaction.js';
import { createNativeExecutionFence } from '../shared/native-execution-fence.js';
import { createNativeRecoveryCheckpoints } from '../shared/native-recovery-checkpoint.js';
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
    checkpoints,
    fence,
    diagnostics,
    imagePolicy,
    activity,
    now = Date.now,
  }) =>
  async (identity) => {
    const initial = await store.get(identity);
    if (!initial) return { pending: false, status: 'missing' };
    const claim = await store.claim({ ...identity, bindingId: initial.bindingId });
    if (claim.kind !== 'claimed') return { pending: claim.kind === 'busy', status: claim.kind };
    const state = { row: claim.row };
    const draft = await preparationStore.get(identity);
    let observation = {};
    const observe = (value) => emitNativeExecutionDiagnostic(diagnostics, value);
    const observedInvoke = async (input) => {
      const phase = nativeDiagnosticPhase(input.payload.command);
      if (
        ['native-start', 'native-continue', 'native-recover', 'native-resume'].includes(
          input.payload.command,
        )
      )
        recordNativeBoundary(executionIdentity(state.row), 'dispatchStarted', now(), {
          sequence: nativeTurnSequence(state.row),
          writerGeneration: nativeWriterGeneration(state.row),
        });
      try {
        const report = await invoke(input);
        if (
          activity &&
          input.payload.command === 'native-status' &&
          report?.capabilities?.includes('activity-v1')
        ) {
          checkReportIdentity(state.row, report);
          let after = await activity.cursor(state.row);
          for (let page = 0; page < 4; page++) {
            await check();
            const batch = await invoke({
              execution: state.row,
              payload: {
                command: 'native-activity',
                ...writerPayload(state.row),
                after,
              },
            });
            const persisted = await activity.ingest(state.row, batch);
            // The next pull is the acknowledgment; this cursor exists only
            // after persistence. A failed transaction leaves the prior cursor.
            if (persisted === after && !batch.events?.length) {
              if (
                !batch.complete &&
                ['publication_ready', 'failed', 'cancelled', 'stopped_needs_review'].includes(
                  report.status,
                )
              )
                throw Object.assign(new Error('Final native activity pending'), {
                  code: batch.cold ? 'NATIVE_ACTIVITY_UNCLOSED' : 'NATIVE_ACTIVITY_PENDING',
                });
              break;
            }
            after = persisted;
            if (page === 3)
              throw Object.assign(new Error('Native activity catch-up pending'), {
                code: 'NATIVE_ACTIVITY_PENDING',
              });
          }
        }
        observation = { phase, ...nativeDiagnosticReport(state.row, report) };
        observe({ ...observation, stage: 'report', code: 'REPORT_OBSERVED' });
        return report;
      } catch (error) {
        observation = { phase, ...nativeDiagnosticError(error) };
        observe({ ...observation, stage: 'call', code: 'CALL_FAILED' });
        throw error;
      }
    };
    const current = async ({ allowCancelled = false } = {}) => {
      const latest = await store.get(identity);
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
      await authorize({ draft, execution: state.row });
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
      state.row = await store.release({ row: state.row });
      return { pending: true, status };
    };
    const requireRecovery = async (reason) => {
      observe({
        ...observation,
        stage: 'decision',
        code: 'RECOVERY_REQUIRED',
        reason,
        controlStatus: state.row.status,
        dispatchPresent: Boolean(state.row.dispatch),
        checkpointPresent: Boolean(state.row.recoveryCheckpoint),
      });
      try {
        await check();
        const recoveryId = recoveryStopId(state.row, reason);
        if (
          reason === 'CHECKPOINT_UNAVAILABLE' &&
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
            });
            await check();
            state.row = await store.recoveryRequired({ row: state.row, reason, recoveryId });
            return { pending: false, status: state.row.status, reason };
          }
        }
        await fence.suspend(executionIdentity(state.row), {
          ...writerOptions(state.row),
          recoveryId,
          reason,
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
          ...stopEvidence(stopped),
        });
        return { pending: false, status: state.row.status, reason };
      } catch (error) {
        if (!shortTransportRetry(error)) throw error;
        await current();
        return yieldPending();
      }
    };
    const verifyCheckpoint = async (
      receipt,
      publication,
      interaction,
      generation,
      verifiedPublication,
    ) => {
      if (!checkpoints || !receipt || !interaction) fail('NATIVE_RECOVERY_INVALID');
      recordNativeBoundary(executionIdentity(state.row), 'checkpointVerificationStarted', now(), {
        sequence: nativeTurnSequence(state.row),
      });
      const manifest = await checkpoints.read(executionIdentity(state.row), receipt, {
        verifyFiles: true,
      });
      if (
        !Number.isSafeInteger(manifest.writerGeneration) ||
        manifest.writerGeneration < 1 ||
        manifest.writerGeneration > nativeWriterGeneration(state.row) ||
        (generation !== undefined && manifest.writerGeneration !== generation) ||
        manifest.sequence !== publication.sequence ||
        manifest.publicationId !== publication.id ||
        manifest.interactionId !== interaction.id ||
        manifest.nativeSessionId !== publication.nativeSessionId ||
        manifest.harness !== state.row.configuration.harness ||
        manifest.packageId !== state.row.configuration.packageId ||
        manifest.imageDigest !== state.row.configuration.image.digest ||
        manifest.configurationSha256 !==
          hash(JSON.stringify(executionRuntimeConfiguration(draft, state.row)))
      )
        fail('NATIVE_RECOVERY_INVALID');
      await check();
      let publicManifest = verifiedPublication;
      if (!publicManifest) {
        try {
          publicManifest = await publications.read(
            {
              ...executionIdentity(state.row),
              epoch: state.row.publicationEpoch ?? state.row.epoch,
            },
            publication,
            { verifyFiles: true },
          );
        } catch (error) {
          if (error?.code === 'NATIVE_PUBLICATION_INVALID') fail('NATIVE_RECOVERY_INVALID');
          if (['NoSuchKey', 'NoSuchVersion', 'NotFound'].includes(error?.name))
            fail('NATIVE_RECOVERY_MISSING');
          fail('NATIVE_RECOVERY_UNAVAILABLE');
        }
      }
      if (
        publicManifest.packageId !== state.row.configuration.packageId ||
        publicManifest.repository?.commit !== state.row.sourceCommit ||
        publicManifest.repository?.branch !== state.row.sourceBranch
      )
        fail('NATIVE_RECOVERY_INVALID');
      verifyPublicProjectFiles(manifest, publicManifest);
      await check();
      recordNativeBoundary(executionIdentity(state.row), 'checkpointVerificationCompleted', now(), {
        sequence: manifest.sequence,
        files: manifest.files?.length,
        bytes: manifest.files?.reduce((total, file) => total + file.bytes, 0),
      });
      return manifest;
    };
    const status = () =>
      observedInvoke({
        execution: state.row,
        payload: { command: 'native-status', ...writerPayload(state.row) },
      });
    try {
      if (state.row.cancelRequested) {
        await current({ allowCancelled: true });
        // A transport accepted before cancellation can arrive after Stop.
        // This controller-only fence also denies that late start in a new VM.
        await fence.cancel(executionIdentity(state.row));
        // The original session ID remains fixed even after cancellation fences
        // the epoch. Stop uses protected runtime/session pins, never agent text.
        const stopped = await stop({ draft, execution: state.row });
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
        (await imagePolicy.revocation(state.row.configuration.image.digest))
      ) {
        observe({ stage: 'decision', code: 'IMAGE_REVOKED', controlStatus: state.row.status });
        await current();
        await fence.cancel(executionIdentity(state.row));
        const stopped = await stop({ draft, execution: state.row });
        await advance({ status: 'FAILED', failureCode: 'native_execution_image_revoked' }, stopped);
        return { pending: false, status: 'FAILED', failureCode: 'native_execution_image_revoked' };
      }
      if (['DISPATCHING', 'RUNNING', 'RECOVERING'].includes(state.row.status) && fence.read) {
        let savedFence;
        try {
          savedFence = await fence.read(executionIdentity(state.row));
        } catch (error) {
          if (!['NoSuchKey', 'NotFound'].includes(error?.name)) throw error;
        }
        if (
          savedFence?.state === 'FENCED' &&
          savedFence.writerGeneration === nativeWriterGeneration(state.row) &&
          savedFence.recoveryId === recoveryStopId(state.row, savedFence.reason)
        )
          return requireRecovery(savedFence.reason);
      }
      if (state.row.status === 'REQUESTED') {
        await advance({ status: 'UPGRADING' });
        return yieldPending();
      }
      if (state.row.status === 'UPGRADING') {
        if (!state.row.target) {
          const result = await upgrade({ draft, execution: state.row, authorize: check });
          if (result.ready) {
            recordNativeBoundary(executionIdentity(state.row), 'targetReady', now());
            await advance({ target: result.target });
          }
          return yieldPending();
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
        return yieldPending();
      }
      if (state.row.status === 'RECOVERING') {
        return await reconcileNativeRecovery({
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
          credentials,
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
          verifyCheckpoint,
          credentials,
          observedInvoke,
          identity,
          stop,
        });
      }
      if (
        [
          'AWAITING_USER',
          'WAITING_FOR_INPUT',
          'STOPPED',
          'FAILED',
          'CANCELLED',
          'RECOVERY_REQUIRED',
        ].includes(state.row.status)
      ) {
        state.row = await store.release({ row: state.row });
        return { pending: false, status: state.row.status };
      }
      if (state.row.status !== 'RUNNING') fail('NATIVE_EXECUTION_RUNTIME_MISMATCH');
      let report;
      try {
        report = await status();
      } catch (error) {
        if (statusOwnerErrors.has(error?.code)) {
          // The SDK can retain a structured runtime rejection without using
          // its RuntimeClientError class. Gate it durably regardless of name.
          await check();
          return requireRecovery('DELIVERY_UNCERTAIN');
        }
        const failureClass = statusReadFailure(error);
        if (!failureClass) throw error;
        // Start/Continue was already acknowledged. An unreadable status does
        // not establish that its writer was lost. Recheck authority and yield
        // to the existing short status-only queue; never resend its prompt.
        await check();
        observe({
          ...observation,
          phase: 'status',
          stage: 'decision',
          code: 'STATUS_READ_RETRY',
          failureClass,
          controlStatus: state.row.status,
          dispatchPresent: Boolean(state.row.dispatch),
          checkpointPresent: Boolean(state.row.recoveryCheckpoint),
        });
        return yieldPending();
      }
      await check();
      checkReportIdentity(state.row, report);
      if (report.recovered === true && !admitted(state.row, report))
        return requireRecovery('DELIVERY_UNCERTAIN');
      if (report.sequence !== nativeTurnSequence(state.row))
        fail('NATIVE_EXECUTION_RUNTIME_MISMATCH');
      if (['preparing', 'running', 'publishing', 'cancelling'].includes(report.status))
        return yieldPending();
      if (report.status === 'publication_ready') {
        return await verifyCompletedNativeTurn({
          state,
          report,
          store,
          publications,
          interactions,
          check,
          verifyCheckpoint,
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
      await fence.cancel(executionIdentity(state.row));
      const stopped = await stop({ draft, execution: state.row });
      await advance({ status: 'FAILED', failureCode: nativeRuntimeFailureCode(report) }, stopped);
      return { pending: false, status: 'FAILED' };
    } catch (error) {
      if (error?.code === 'NATIVE_RECOVERY_MISSING')
        return requireRecovery('CHECKPOINT_UNAVAILABLE');
      if (
        ['NATIVE_EXECUTION_RUNTIME_UNAVAILABLE', 'NATIVE_EXECUTION_RUNTIME_MISMATCH'].includes(
          error?.code,
        ) ||
        ownerErrors.has(error?.code) ||
        error?.name === 'RuntimeClientError'
      ) {
        if (state.row.status === 'RECOVERING') return requireRecovery('RESTORE_FAILED');
        if (state.row.dispatch && ['DISPATCHING', 'RUNNING'].includes(state.row.status))
          return requireRecovery('DELIVERY_UNCERTAIN');
        if (state.row.status === 'DISPATCHING' && error?.name === 'RuntimeClientError')
          return requireRecovery(
            state.row.recoveryCheckpoint ? 'SESSION_LOST' : 'CHECKPOINT_UNAVAILABLE',
          );
      }
      const terminal = phaseError(error);
      if (terminal) {
        try {
          await current();
          await fence.cancel(executionIdentity(state.row));
          const stopped = await stop({ draft, execution: state.row });
          await advance({ status: 'FAILED', failureCode: terminal }, stopped);
          return { pending: false, status: 'FAILED', failureCode: terminal };
        } catch {
          /* A changed/cancelled owner wins. Retain its durable record. */
        }
      }
      if (error?.code === 'NATIVE_ACTIVITY_UNCLOSED') return requireRecovery('DELIVERY_UNCERTAIN');
      if (['NATIVE_ACTIVITY_PENDING', 'NATIVE_ACTIVITY_CONFLICT'].includes(error?.code))
        return yieldPending();
      if (shortTransportRetry(error)) {
        // SDK transport uncertainty retains the same attempt/session. Release
        // and send a fresh short-delay pointer instead of waiting for the long
        // queue visibility period reserved for a crashed Lambda invocation.
        await current({ allowCancelled: state.row.cancelRequested });
        return yieldPending();
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
      fail('NATIVE_EXECUTION_RUNTIME_MISMATCH');
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
        const projects = JSON.parse(env.NATIVE_PREPARATION_PROJECT_IDS ?? '[]');
        if (!Array.isArray(projects) || !projects.includes(identity.projectId)) continue;
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
          checkpoints: createNativeRecoveryCheckpoints({
            s3,
            bucket: env.NATIVE_EXECUTION_PUBLICATION_BUCKET,
            accountId: env.NATIVE_RUNTIME_ACCOUNT_ID,
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

export const handler = (event, context) => createNativeExecutionWorker()(event, context);
