import { createHash } from 'node:crypto';
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
import { createNativeRuntimeStore, ID, UUID_V4, matches } from './store.js';
import {
  createNativeExecutionStore,
  nativeTurnSequence,
  nativeWriterGeneration,
} from './execution-store.js';
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
import { nativeFileExclusion } from '../shared/native-project-files.js';
import { createWorkflowSourceService } from '../shared/workflow-source-service.js';
import { fetchWorkflowSourceMembership } from '../shared/workflow-source-membership.js';
import { projectNativePublication, readNativePublicationInteraction } from './publication-graph.js';
import { createNativeRuntimeImagePolicy } from './runtime-images.js';
import {
  createNativeExecutionDiagnostics,
  emitNativeExecutionDiagnostic,
  nativeDiagnosticError,
  nativeDiagnosticPhase,
  nativeDiagnosticReport,
  nativeDiagnosticResponse,
} from './execution-diagnostics.js';

const fail = (code) => {
  throw Object.assign(new Error(code), { code });
};
const hash = (value) => createHash('sha256').update(value).digest('hex');
const recoveryStopId = (row, reason) => {
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
const writerOptions = (row) => ({ writerGeneration: nativeWriterGeneration(row) });
const excludedProjectPath = (path) => {
  // The publisher applies its predicate before descending into directories.
  // Apply it to ancestors too so children of private lock directories retain
  // exactly that same visibility when verifying a flat checkpoint inventory.
  let prefix = '';
  for (const part of path.split('/')) {
    prefix = prefix ? `${prefix}/${part}` : part;
    if (nativeFileExclusion(prefix)) return true;
  }
  return false;
};
const verifyPublicProjectFiles = (checkpoint, publication) => {
  if (!Array.isArray(checkpoint.files) || !Array.isArray(publication.files))
    fail('NATIVE_RECOVERY_INVALID');
  const files = new Map();
  const published = new Set();
  try {
    for (const file of checkpoint.files) {
      if (file.scope !== 'project' || excludedProjectPath(file.path)) continue;
      if (files.has(file.path)) fail('NATIVE_RECOVERY_INVALID');
      files.set(file.path, file);
    }
    if (files.size !== publication.files.length) fail('NATIVE_RECOVERY_INVALID');
    for (const file of publication.files) {
      const restored = files.get(file.path);
      if (
        excludedProjectPath(file.path) ||
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
const writerPayload = (row) => ({
  ...executionIdentity(row),
  ...(row.writerGeneration === undefined ? {} : writerOptions(row)),
});
const checkReportIdentity = (row, report) => {
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
const admitted = (row, report) =>
  report?.sequence === nativeTurnSequence(row) &&
  (!row.response || report.requestId === row.response.commandId) &&
  ['preparing', 'running', 'publishing', 'publication_ready'].includes(report.status) &&
  (report.recovered !== true || report.status === 'publication_ready');
const priorBoundary = (row, report) =>
  report?.sequence === row.publication?.sequence &&
  report?.nativeSessionId === row.publication?.nativeSessionId &&
  ((report.status === 'publication_ready' &&
    report.receipt?.id === row.publication.id &&
    report.interaction?.id === row.interaction?.id) ||
    (report.status === 'recovery_ready' &&
      report.recoveryId === row.lastRecoveryId &&
      report.checkpointId === row.recoveryCheckpoint?.id &&
      report.recovered === false));
const ownerErrors = new Set([
  'native_execution_existing_owner',
  'native_execution_owner_conflict',
  'native_execution_reply_conflict',
  'native_execution_local_record_unavailable',
  'native_execution_reply_admission_unconfirmed',
]);
const statusOwnerErrors = new Set([
  ...ownerErrors,
  'native_execution_scope_mismatch',
  'native_execution_owner_invalid',
  'native_execution_local_record_invalid',
  'native_execution_cancelled',
]);
// Transport provenance is local controller state, never an agent-supplied
// property or a diagnostic logger result. Keep the original thrown error so
// dispatch/recovery behavior outside acknowledged RUNNING status reads stays
// unchanged.
const runtimeReadFailures = new WeakMap();
const markRuntimeReadFailure = (error, kind) => {
  if (error && (typeof error === 'object' || typeof error === 'function'))
    runtimeReadFailures.set(error, kind);
  return error;
};
const failRuntimeRead = (code, kind) => {
  throw markRuntimeReadFailure(Object.assign(new Error(code), { code }), kind);
};
const shortTransportRetry = (error) =>
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
const statusReadFailure = (error) => {
  if (statusOwnerErrors.has(error?.code)) return null;
  const kind = runtimeReadFailures.get(error);
  if (kind === 'OWNER_REJECTED') return null;
  if (kind) return kind;
  // Injected SDK ports can throw the same transport errors without going
  // through our adapter. A report-identity mismatch is never in this set.
  if (error?.name === 'RuntimeClientError' || shortTransportRetry(error)) return 'SDK_FAILURE';
  return null;
};
const phaseError = (error) => {
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
const checkedCredentials = (row, material) => {
  if (!material?.ok) {
    const code = material?.code;
    if (code === 'NATIVE_EXECUTION_CREDENTIALS_FORBIDDEN') fail('NATIVE_EXECUTION_FORBIDDEN');
    if (code === 'NATIVE_EXECUTION_CREDENTIALS_IMAGE_REVOKED') fail('NATIVE_EXECUTION_IMAGE_REVOKED');
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
    project,
    fence,
    diagnostics,
    imagePolicy,
    now = Date.now,
  }) =>
  async (identity) => {
    const initial = await store.get(identity);
    if (!initial) return { pending: false, status: 'missing' };
    const claim = await store.claim({ ...identity, bindingId: initial.bindingId });
    if (claim.kind !== 'claimed') return { pending: claim.kind === 'busy', status: claim.kind };
    let row = claim.row;
    const draft = await preparationStore.get(identity);
    let observation = {};
    const observe = (value) => emitNativeExecutionDiagnostic(diagnostics, value);
    const observedInvoke = async (input) => {
      const phase = nativeDiagnosticPhase(input.payload.command);
      try {
        const report = await invoke(input);
        observation = { phase, ...nativeDiagnosticReport(row, report) };
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
        latest.bindingId !== row.bindingId ||
        latest.version !== row.version ||
        latest.epoch !== row.epoch ||
        latest.leaseToken !== row.leaseToken ||
        latest.leaseExpiresAt <= now() ||
        (!allowCancelled && latest.cancelRequested)
      )
        fail('NATIVE_EXECUTION_LEASE_LOST');
      if (!draft || draft.bindingId !== row.bindingId) fail('NATIVE_EXECUTION_SOURCE_CHANGED');
      return latest;
    };
    const check = async () => {
      await current();
      await authorize({ draft, execution: row });
      await current();
    };
    const advance = async (patch) => {
      row = await store.advance({ row, patch });
    };
    const yieldPending = async (status = row.status) => {
      row = await store.release({ row });
      return { pending: true, status };
    };
    const requireRecovery = async (reason) => {
      observe({
        ...observation,
        stage: 'decision',
        code: 'RECOVERY_REQUIRED',
        reason,
        controlStatus: row.status,
        dispatchPresent: Boolean(row.dispatch),
        checkpointPresent: Boolean(row.recoveryCheckpoint),
      });
      try {
        await check();
        const recoveryId = recoveryStopId(row, reason);
        if (
          reason === 'CHECKPOINT_UNAVAILABLE' &&
          row.status === 'RECOVERING' &&
          row.recovery.phase === 'RESTORING'
        ) {
          const predecessor = await fence.read(executionIdentity(row));
          await check();
          if (
            predecessor.state === 'FENCED' &&
            predecessor.writerGeneration === row.recovery.previousGeneration &&
            row.recovery.previousGeneration + 1 === nativeWriterGeneration(row) &&
            ((predecessor.recoveryId === row.recovery.id &&
              predecessor.reason === row.recovery.reason) ||
              (predecessor.recoveryId === recoveryId && predecessor.reason === reason))
          ) {
            // RESTORING is protected proof that this predecessor was positively
            // stopped. No successor was admitted by this closed fence. Keep its
            // generation closed and replace only the admission episode so a
            // delayed activation CAS cannot reopen it after we block recovery.
            // The deterministic ID also resumes a crash before the table commit.
            await fence.suspend(executionIdentity(row), {
              writerGeneration: row.recovery.previousGeneration,
              recoveryId,
              reason,
            });
            await check();
            row = await store.recoveryRequired({ row, reason, recoveryId });
            return { pending: false, status: row.status, reason };
          }
        }
        await fence.suspend(executionIdentity(row), { ...writerOptions(row), recoveryId, reason });
        await check();
        const stopped = await stop({ draft, execution: row, recoveryId });
        await check();
        if (stopped?.confirmed !== true || stopped.runtimeSessionId !== row.runtimeSessionId)
          fail('NATIVE_EXECUTION_STOP_UNCONFIRMED');
        row = await store.recoveryRequired({ row, reason, recoveryId });
        return { pending: false, status: row.status, reason };
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
      const manifest = await checkpoints.read(executionIdentity(row), receipt, {
        verifyFiles: true,
      });
      if (
        !Number.isSafeInteger(manifest.writerGeneration) ||
        manifest.writerGeneration < 1 ||
        manifest.writerGeneration > nativeWriterGeneration(row) ||
        (generation !== undefined && manifest.writerGeneration !== generation) ||
        manifest.sequence !== publication.sequence ||
        manifest.publicationId !== publication.id ||
        manifest.interactionId !== interaction.id ||
        manifest.nativeSessionId !== publication.nativeSessionId ||
        manifest.harness !== row.configuration.harness ||
        manifest.packageId !== row.configuration.packageId ||
        manifest.imageDigest !== row.configuration.image.digest ||
        manifest.configurationSha256 !==
          hash(JSON.stringify(executionRuntimeConfiguration(draft, row)))
      )
        fail('NATIVE_RECOVERY_INVALID');
      await check();
      let publicManifest = verifiedPublication;
      if (!publicManifest) {
        try {
          publicManifest = await publications.read(
            { ...executionIdentity(row), epoch: row.publicationEpoch ?? row.epoch },
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
        publicManifest.packageId !== row.configuration.packageId ||
        publicManifest.repository?.commit !== row.sourceCommit ||
        publicManifest.repository?.branch !== row.sourceBranch
      )
        fail('NATIVE_RECOVERY_INVALID');
      verifyPublicProjectFiles(manifest, publicManifest);
      await check();
      return manifest;
    };
    const status = () =>
      observedInvoke({
        execution: row,
        payload: { command: 'native-status', ...writerPayload(row) },
      });
    try {
      if (row.cancelRequested) {
        await current({ allowCancelled: true });
        // A transport accepted before cancellation can arrive after Stop.
        // This controller-only fence also denies that late start in a new VM.
        await fence.cancel(executionIdentity(row));
        // The original session ID remains fixed even after cancellation fences
        // the epoch. Stop uses protected runtime/session pins, never agent text.
        await stop({ draft, execution: row });
        await advance({ status: 'CANCELLED' });
        return { pending: false, status: 'CANCELLED' };
      }
      await check();
      // An administrator revocation fences active execution before any status
      // read, dispatch or recovery step. Committed results stay readable and a
      // pending graph projection of already-published content still completes.
      if (
        imagePolicy &&
        ['REQUESTED', 'UPGRADING', 'DISPATCHING', 'RUNNING', 'RECOVERING'].includes(row.status) &&
        (await imagePolicy.revocation(row.configuration.image.digest))
      ) {
        observe({ stage: 'decision', code: 'IMAGE_REVOKED', controlStatus: row.status });
        await current();
        await fence.cancel(executionIdentity(row));
        await stop({ draft, execution: row });
        await advance({ status: 'FAILED', failureCode: 'native_execution_image_revoked' });
        return { pending: false, status: 'FAILED', failureCode: 'native_execution_image_revoked' };
      }
      if (['DISPATCHING', 'RUNNING', 'RECOVERING'].includes(row.status) && fence.read) {
        let savedFence;
        try {
          savedFence = await fence.read(executionIdentity(row));
        } catch (error) {
          if (!['NoSuchKey', 'NotFound'].includes(error?.name)) throw error;
        }
        if (
          savedFence?.state === 'FENCED' &&
          savedFence.writerGeneration === nativeWriterGeneration(row) &&
          savedFence.recoveryId === recoveryStopId(row, savedFence.reason)
        )
          return requireRecovery(savedFence.reason);
      }
      if (row.projectionStatus === 'pending') {
        const manifest = await publications.read(
          {
            ...executionIdentity(row),
            epoch: row.publicationEpoch,
          },
          row.publication,
          {
            verifyFiles: true,
          },
        );
        if (manifest.packageId !== row.configuration.packageId) fail('NATIVE_PUBLICATION_INVALID');
        const interaction = await readNativePublicationInteraction({
          draft,
          row,
          manifest,
          interactions,
        });
        await check();
        await project({
          draft,
          publication: row.publication,
          manifest,
          interaction,
          authorize: check,
        });
        row = await store.projected({ row });
        return {
          pending: ['DISPATCHING', 'RUNNING', 'RECOVERING'].includes(row.status),
          status: row.status,
        };
      }
      if (row.status === 'REQUESTED') {
        await advance({ status: 'UPGRADING' });
        return yieldPending();
      }
      if (row.status === 'UPGRADING') {
        if (!row.target) {
          const result = await upgrade({ draft, execution: row, authorize: check });
          if (result.ready) await advance({ target: result.target });
          return yieldPending();
        }
        const material = checkedCredentials(row, await credentials(row));
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
      if (row.status === 'RECOVERING') {
        const recovery = row.recovery;
        try {
          await verifyCheckpoint(row.recoveryCheckpoint, row.publication, row.interaction);
        } catch (error) {
          if (['NATIVE_RECOVERY_INVALID', 'NATIVE_RECOVERY_MISSING'].includes(error.code))
            return requireRecovery('CHECKPOINT_UNAVAILABLE');
          throw error;
        }
        if (recovery.phase === 'FENCING') {
          await fence.suspend(executionIdentity(row), {
            writerGeneration: recovery.previousGeneration,
            recoveryId: recovery.id,
            reason: recovery.reason,
          });
          await check();
          // Same AWS session IDs are reusable. A stable per-episode stop token
          // prevents an old retry from stopping a replacement generation.
          const stopped = await stop({ draft, execution: row, recoveryId: recovery.id });
          await check();
          if (stopped?.confirmed !== true || stopped.runtimeSessionId !== row.runtimeSessionId)
            fail('NATIVE_EXECUTION_STOP_UNCONFIRMED');
          row = await store.recoveryStopped({ row });
          return yieldPending();
        }
        await fence.activate(executionIdentity(row), {
          writerGeneration: nativeWriterGeneration(row),
          recoveryId: recovery.id,
          checkpointId: row.recoveryCheckpoint.id,
        });
        await check();
        const ack = await observedInvoke({
          execution: row,
          payload: {
            command: 'native-recover',
            schemaVersion: 1,
            ...writerPayload(row),
            recoveryId: recovery.id,
            sequence: row.publication.sequence,
            checkpoint: row.recoveryCheckpoint,
            publication: row.publication,
            interaction: row.interaction,
            configuration: executionRuntimeConfiguration(draft, row),
            imageDigest: row.configuration.image.digest,
            package: { candidate: draft.candidate, archiveReceipt: draft.archiveReceipt },
          },
        });
        await check();
        checkReportIdentity(row, ack);
        const report = ack.status === 'recovery_ready' ? ack : await status();
        await check();
        checkReportIdentity(row, report);
        if (
          report.recoveryId !== recovery.id ||
          report.checkpointId !== row.recoveryCheckpoint.id ||
          report.sequence !== row.publication.sequence
        )
          return requireRecovery('RESTORE_FAILED');
        if (report.status === 'recovering' && report.recovered === false) return yieldPending();
        if (
          report.status !== 'recovery_ready' ||
          report.recovered !== false ||
          report.nativeSessionId !== row.publication.nativeSessionId
        )
          return requireRecovery('RESTORE_FAILED');
        row = await store.recovered({ row });
        return yieldPending();
      }
      if (row.status === 'DISPATCHING') {
        await fence.ensureActive(executionIdentity(row), writerOptions(row));
        // Once delivery has been attempted, never blindly replay a model turn.
        // Status may prove admission/completion; a cold or conflicting owner
        // cannot prove that a lost command was never executed.
        if (row.dispatch) {
          const report = await status();
          await check();
          checkReportIdentity(row, report);
          if (!admitted(row, report)) return requireRecovery('DELIVERY_UNCERTAIN');
          if (row.response) row = await store.dispatched({ row });
          else await advance({ status: 'RUNNING' });
          return yieldPending();
        }
        if (nativeTurnSequence(row) > 1) {
          const report = await status();
          await check();
          checkReportIdentity(row, report);
          if (!priorBoundary(row, report)) return requireRecovery('DELIVERY_UNCERTAIN');
          if (report.recovered === true) {
            if (!row.recoveryCheckpoint) return requireRecovery('CHECKPOINT_UNAVAILABLE');
            try {
              await verifyCheckpoint(row.recoveryCheckpoint, row.publication, row.interaction);
            } catch (error) {
              if (['NATIVE_RECOVERY_INVALID', 'NATIVE_RECOVERY_MISSING'].includes(error.code))
                return requireRecovery('CHECKPOINT_UNAVAILABLE');
              throw error;
            }
            row = await store.beginRecovery({ row });
            return yieldPending();
          }
        }
        const material = checkedCredentials(row, await credentials(row));
        if (
          !material?.ok ||
          material.source?.commit !== row.sourceCommit ||
          material.source?.branch !== row.sourceBranch
        )
          fail('NATIVE_EXECUTION_SOURCE_CHANGED');
        await check();
        const configuration = executionRuntimeConfiguration(draft, row);
        let payload = {
          command: 'native-start',
          schemaVersion: 1,
          ...writerPayload(row),
          imageDigest: row.configuration.image.digest,
          sequence: nativeTurnSequence(row),
          configuration,
          package: { candidate: draft.candidate, archiveReceipt: draft.archiveReceipt },
          credentials: { model: material.model, git: material.git },
        };
        let response;
        if (nativeTurnSequence(row) > 1) {
          if (row.response?.deliveryStatus !== 'pending' || !row.interaction)
            fail('NATIVE_EXECUTION_RUNTIME_MISMATCH');
          response = await store.response(row, row.response.interactionId);
          if (
            !response ||
            response.commandId !== row.response.commandId ||
            response.sequence !== nativeTurnSequence(row) ||
            response.interactionId !== row.interaction.id ||
            response.contentSha256 !== row.interactionContentSha256
          )
            fail('NATIVE_EXECUTION_RUNTIME_MISMATCH');
          payload = {
            command: 'native-continue',
            schemaVersion: 1,
            ...writerPayload(row),
            sequence: response.sequence,
            requestId: response.commandId,
            priorInteractionId: response.interactionId,
            priorPublicationId: row.publication.id,
            text: response.text,
            configuration,
            credentials: { model: material.model, git: material.git },
          };
        }
        await check();
        row = await store.dispatchAttempted({ row });
        await check();
        const result = await observedInvoke({ execution: row, payload });
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
        checkReportIdentity(row, result);
        if (!admitted(row, result)) fail('NATIVE_EXECUTION_RUNTIME_MISMATCH');
        if (response) row = await store.dispatched({ row });
        else await advance({ status: 'RUNNING' });
        return yieldPending();
      }
      if (row.status !== 'RUNNING') fail('NATIVE_EXECUTION_RUNTIME_MISMATCH');
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
          controlStatus: row.status,
          dispatchPresent: Boolean(row.dispatch),
          checkpointPresent: Boolean(row.recoveryCheckpoint),
        });
        return yieldPending();
      }
      await check();
      checkReportIdentity(row, report);
      if (report.recovered === true && !admitted(row, report))
        return requireRecovery('DELIVERY_UNCERTAIN');
      if (report.sequence !== nativeTurnSequence(row)) fail('NATIVE_EXECUTION_RUNTIME_MISMATCH');
      if (['preparing', 'running', 'publishing', 'cancelling'].includes(report.status))
        return yieldPending();
      if (report.status === 'publication_ready') {
        const receipt = report.receipt;
        const manifest = await publications.read(executionIdentity(row), receipt, {
          verifyFiles: true,
        });
        if (
          manifest.packageId !== row.configuration.packageId ||
          manifest.repository.commit !== row.sourceCommit ||
          manifest.repository.branch !== row.sourceBranch ||
          receipt.sequence !== nativeTurnSequence(row)
        )
          fail('NATIVE_PUBLICATION_INVALID');
        await check();
        const interaction = report.interaction;
        let interactionContentSha256;
        if (interaction) {
          if (!interactions) fail('NATIVE_INTERACTION_INVALID');
          const body = await interactions.read(executionIdentity(row), interaction);
          if (
            body.packageId !== row.configuration.packageId ||
            body.harness !== row.configuration.harness ||
            body.sequence !== nativeTurnSequence(row) ||
            body.publicationId !== receipt.id ||
            body.nativeSessionId !== receipt.nativeSessionId
          )
            fail('NATIVE_INTERACTION_INVALID');
          interactionContentSha256 = body.contentSha256;
          await check();
        }
        const checkpoint = report.checkpoint;
        if (checkpoint) {
          await verifyCheckpoint(
            checkpoint,
            receipt,
            interaction,
            nativeWriterGeneration(row),
            manifest,
          );
        }
        row = await store.publish({
          row,
          publication: receipt,
          ...(interaction ? { interaction, interactionContentSha256 } : {}),
          ...(checkpoint ? { checkpoint } : {}),
        });
        return yieldPending();
      }
      // Unknown/cold/stale ownership is not success and never starts a new
      // writer. Recovery is an explicit subsequent control-plane operation.
      observe({
        ...observation,
        stage: 'decision',
        code: 'RUNTIME_TERMINAL',
        controlStatus: row.status,
      });
      await fence.cancel(executionIdentity(row));
      await stop({ draft, execution: row });
      await advance({ status: 'FAILED', failureCode: 'native_execution_failed' });
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
        if (row.status === 'RECOVERING') return requireRecovery('RESTORE_FAILED');
        if (row.dispatch && ['DISPATCHING', 'RUNNING'].includes(row.status))
          return requireRecovery('DELIVERY_UNCERTAIN');
        if (row.status === 'DISPATCHING' && error?.name === 'RuntimeClientError')
          return requireRecovery(
            row.recoveryCheckpoint ? 'SESSION_LOST' : 'CHECKPOINT_UNAVAILABLE',
          );
      }
      const terminal = phaseError(error);
      if (terminal) {
        try {
          await current();
          await fence.cancel(executionIdentity(row));
          await stop({ draft, execution: row });
          await advance({ status: 'FAILED', failureCode: terminal });
          return { pending: false, status: 'FAILED', failureCode: terminal };
        } catch {
          /* A changed/cancelled owner wins. Retain its durable record. */
        }
      }
      if (shortTransportRetry(error)) {
        // SDK transport uncertainty retains the same attempt/session. Release
        // and send a fresh short-delay pointer instead of waiting for the long
        // queue visibility period reserved for a crashed Lambda invocation.
        await current();
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
        const preparationStore = createNativeRuntimeStore({
          ddb,
          tableName: env.NATIVE_RUNTIME_BINDINGS_TABLE,
          deployment,
        });
        const store = createNativeExecutionStore({
          ddb,
          tableName: env.NATIVE_RUNTIME_BINDINGS_TABLE,
          preparationStore,
          leaseMs: 180000,
        });
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
          project: async (args) => projectNativePublication({ ...args, g: await graph() }),
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
