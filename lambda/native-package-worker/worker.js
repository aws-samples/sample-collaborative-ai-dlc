// SQS envelope checks rely on the dedicated event source and Lambda invocation
// IAM. They do not make caller-supplied event JSON an authentication mechanism.
import { canonicalJson } from '../shared/workflow-checkpoint.js';
import { WorkflowSourceError, workflowSourceIdentity } from '../shared/workflow-source-bindings.js';
import { describeNativePackagePin } from '../shared/native-package-pin.js';
import {
  describeNativePackageArchiveReceipt,
  NativePackageArchiveError,
} from '../shared/native-package-archive.js';
import { NativePackageError } from '../shared/native-runtime-package.js';
import { NativeReleaseValidationError } from '../shared/native-release-manifest.js';
import { NativePackageIntakeError } from '../shared/native-package-intake.js';

const MESSAGES = Object.freeze({
  native_package_worker_invalid: 'Native package preparation input or package is invalid',
  native_package_worker_denied: 'Native package source authorization no longer permits preparation',
  native_package_worker_timeout: 'Native package preparation exceeded its work budget',
  native_package_worker_cleanup: 'Native package preparation cleanup was not completed',
  native_package_worker_unavailable: 'Native package preparation is unavailable',
});
export class NativePackageWorkerError extends Error {
  constructor(code = 'native_package_worker_unavailable') {
    const safeCode =
      typeof code === 'string' && Object.hasOwn(MESSAGES, code)
        ? code
        : 'native_package_worker_unavailable';
    super(MESSAGES[safeCode]);
    this.name = 'NativePackageWorkerError';
    this.code = safeCode;
  }
}
const fail = (code) => {
  throw new NativePackageWorkerError(code);
};
const invalid = () => fail('native_package_worker_invalid');
const matches = (value, pattern) => typeof value === 'string' && pattern.exec(value)?.[0] === value;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,255}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SHA = /^[a-f0-9]{64}$/;
const RELEASE = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-preview\.\d{8}\.[1-9]\d*)?$/;
const QUEUE =
  /^arn:(?:aws|aws-us-gov|aws-cn):sqs:[a-z0-9-]+:\d{12}:[A-Za-z0-9_-]{1,80}(?:\.fifo)?$/;
const plain = (value) =>
  value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
const terminal = (job) => job?.state === 'SUCCEEDED' || job?.state === 'FAILED';

const readPointer = (record) => {
  if (
    typeof record.body !== 'string' ||
    record.body.length > 1024 ||
    Buffer.byteLength(record.body) > 1024
  )
    invalid();
  let body;
  try {
    body = JSON.parse(record.body);
  } catch {
    invalid();
  }
  if (
    !plain(body) ||
    Object.keys(body).length !== 3 ||
    !['schemaVersion', 'projectId', 'jobId'].every((key) => Object.hasOwn(body, key)) ||
    body.schemaVersion !== 1 ||
    !matches(body.projectId, ID) ||
    !matches(body.jobId, UUID)
  )
    invalid();
  return { projectId: body.projectId, jobId: body.jobId };
};

const readClaim = (job, pointer) => {
  if (
    !plain(job) ||
    job.projectId !== pointer.projectId ||
    job.jobId !== pointer.jobId ||
    job.state !== 'RUNNING' ||
    !matches(job.sourceId, SHA) ||
    !matches(job.actorId, ID) ||
    !matches(job.bindingRevision, UUID) ||
    !matches(job.leaseToken, UUID) ||
    (job.requestedRelease !== 'latest' && !matches(job.requestedRelease, RELEASE))
  )
    invalid();
  return structuredClone(job);
};

// Persist only the pin and scope needed for crash reconciliation. Neither a
// loader's paths, inventory/trust claims, nor source credentials enter the job.
const candidateFor = (job, value, attestation, materializationId) => {
  const pin = describeNativePackagePin(value, attestation);
  if (
    pin.materializationId !== materializationId ||
    (job.requestedRelease === 'latest' && pin.identity.version.includes('-preview.')) ||
    workflowSourceIdentity(pin.identity.source.provider, pin.identity.source.repository)
      .sourceId !== job.sourceId ||
    (job.requestedRelease !== 'latest' && job.requestedRelease !== pin.identity.source.release)
  )
    invalid();
  return {
    schemaVersion: 1,
    projectId: job.projectId,
    sourceId: job.sourceId,
    bindingRevision: job.bindingRevision,
    requestedRelease: job.requestedRelease,
    packagePin: { ...pin.identity, packageId: pin.packageId },
    attestation: pin.attestation,
    materializationId: pin.materializationId,
  };
};
const readCandidate = (job, value) => {
  if (
    !plain(value) ||
    value.schemaVersion !== 1 ||
    value.projectId !== job.projectId ||
    value.sourceId !== job.sourceId ||
    value.bindingRevision !== job.bindingRevision ||
    value.requestedRelease !== job.requestedRelease
  )
    invalid();
  return candidateFor(job, value.packagePin, value.attestation, value.materializationId);
};

const terminalCode = (error) => {
  if (
    error instanceof WorkflowSourceError &&
    [
      'WORKFLOW_SOURCE_FORBIDDEN',
      'WORKFLOW_SOURCE_CONFLICT',
      'WORKFLOW_SOURCE_NOT_FOUND',
      'WORKFLOW_SOURCE_INVALID',
    ].includes(error.code)
  )
    return 'native_package_worker_denied';
  if (
    error instanceof NativePackageError ||
    error instanceof NativeReleaseValidationError ||
    (error instanceof NativePackageArchiveError &&
      ['native_package_archive_invalid', 'native_package_archive_corrupt'].includes(error.code)) ||
    (error instanceof NativePackageIntakeError && error.code === 'native_package_intake_invalid') ||
    (error instanceof NativePackageWorkerError && error.code === 'native_package_worker_invalid')
  )
    return 'native_package_worker_invalid';
  return null;
};

/**
 * createAttempt({job, signal, guard, wrapArchive}) returns intake, cleanup,
 * authorizeCompletion and finish ports. After cleanup fully drains attempt
 * resources, authorizeCompletion freshly checks source authority. finish keeps
 * the host's idle completion connection on success, or closes/drains it on
 * failure. No resource close separates final authorization from the success CAS.
 * A typed source error from cleanup may reject only after cleanup has completed.
 * No timeout race detaches the intake: an uncooperative port keeps this
 * invocation pending, with an aborted signal and lease guards fencing writes.
 */
export const createNativePackageWorker = ({
  jobs,
  expectedQueueArn,
  createAttempt,
  attemptTimeoutMs = 120_000,
  cleanupReserveMs = 10_000,
  maxRecords = 10,
  now = Date.now,
  logger = console,
} = {}) => {
  if (
    !matches(expectedQueueArn, QUEUE) ||
    typeof createAttempt !== 'function' ||
    typeof now !== 'function' ||
    !Number.isSafeInteger(attemptTimeoutMs) ||
    attemptTimeoutMs < 1 ||
    attemptTimeoutMs > 840_000 ||
    !Number.isSafeInteger(cleanupReserveMs) ||
    cleanupReserveMs < 1 ||
    cleanupReserveMs > 60_000 ||
    !Number.isSafeInteger(maxRecords) ||
    maxRecords < 1 ||
    maxRecords > 10 ||
    ['get', 'claim', 'assertLease', 'saveCandidate', 'saveReceipt', 'succeed', 'fail'].some(
      (method) => typeof jobs?.[method] !== 'function',
    )
  )
    invalid();

  const remaining = (context) => {
    if (typeof context?.getRemainingTimeInMillis !== 'function') return Infinity;
    const value = context.getRemainingTimeInMillis();
    if (!Number.isFinite(value) || value < 0) invalid();
    return value;
  };

  const processPointer = async (pointer, context) => {
    const budget = Math.min(attemptTimeoutMs, remaining(context) - cleanupReserveMs);
    if (budget <= 0) return false;
    const controller = new AbortController();
    const deadline = now() + budget;
    const timer = setTimeout(() => controller.abort(), budget);
    let lease;
    let attempt;
    let job;
    let candidate;
    let archiveReceipt;
    let failure;
    let cleaned = false;
    const checkBudget = () => {
      if (
        controller.signal.aborted ||
        now() >= deadline ||
        remaining(context) <= cleanupReserveMs
      ) {
        controller.abort();
        fail('native_package_worker_timeout');
      }
    };
    const guard = async () => {
      checkBudget();
      if (!lease) invalid();
      await jobs.assertLease(lease);
      checkBudget();
    };
    const saveReceipt = async (receipt) => {
      const safe = describeNativePackageArchiveReceipt(receipt, candidate?.materializationId);
      if (archiveReceipt && canonicalJson(archiveReceipt) !== canonicalJson(safe)) invalid();
      await guard();
      await jobs.saveReceipt({ ...lease, receipt: safe });
      checkBudget();
      archiveReceipt = safe;
      return safe;
    };
    const guardedCallback = (callback) => {
      if (typeof callback !== 'function') invalid();
      return async () => {
        await guard();
        await callback();
        await guard();
      };
    };
    const checkArchiveRequest = (request) => {
      if (
        !candidate ||
        request?.projectId !== job.projectId ||
        request.sourceId !== job.sourceId ||
        canonicalJson(
          candidateFor(job, request.pin, request.attestation, request.materializationId),
        ) !== canonicalJson(candidate)
      )
        invalid();
    };
    const wrapArchive = (archive) => {
      if (
        ['publish', 'restore', 'recoverReceipt'].some(
          (method) => typeof archive?.[method] !== 'function',
        )
      )
        invalid();
      return Object.freeze({
        async publish(request) {
          await guard();
          if (request?.projectId !== job.projectId || request.sourceId !== job.sourceId) invalid();
          const selected = candidateFor(
            job,
            request.materialization?.package,
            request.materialization?.attestation,
            request.materialization?.materializationId,
          );
          if (candidate && canonicalJson(candidate) !== canonicalJson(selected)) invalid();
          // This awaited CAS precedes even the first S3 asset write.
          await jobs.saveCandidate({ ...lease, candidate: selected });
          checkBudget();
          candidate = selected;
          const receipt = await archive.publish({
            ...request,
            beforeCommit: guardedCallback(request.beforeCommit),
          });
          return saveReceipt(receipt);
        },
        async restore(request) {
          await guard();
          checkArchiveRequest(request);
          if (
            !archiveReceipt ||
            canonicalJson(
              describeNativePackageArchiveReceipt(request.receipt, candidate.materializationId),
            ) !== canonicalJson(archiveReceipt)
          )
            invalid();
          return archive.restore({
            ...request,
            beforeMaterialize: guardedCallback(request.beforeMaterialize),
          });
        },
        async recoverReceipt(request) {
          await guard();
          checkArchiveRequest(request);
          if (archiveReceipt) invalid();
          return archive.recoverReceipt({
            ...request,
            beforeReturn: guardedCallback(request.beforeReturn),
          });
        },
      });
    };

    try {
      checkBudget();
      const existing = await jobs.get(pointer);
      checkBudget();
      if (!existing || terminal(existing)) return true;
      const claimed = await jobs.claim(pointer);
      checkBudget();
      if (claimed?.kind === 'missing') return true;
      if (claimed?.kind === 'terminal') {
        if (claimed.job?.state === 'FAILED')
          logger.warn(
            JSON.stringify({ event: 'native_package_worker_terminal_failure', ...pointer }),
          );
        return true;
      }
      if (claimed?.kind === 'busy') return 'busy';
      if (claimed?.kind !== 'claimed') invalid();
      job = readClaim(claimed.job, pointer);
      lease = { ...pointer, leaseToken: job.leaseToken };
      if (job.candidate !== undefined && job.candidate !== null)
        candidate = readCandidate(job, job.candidate);
      if (job.archiveReceipt !== undefined && job.archiveReceipt !== null) {
        if (!candidate) invalid();
        archiveReceipt = describeNativePackageArchiveReceipt(
          job.archiveReceipt,
          candidate.materializationId,
        );
      }
      await guard();
      attempt = await createAttempt({
        job: structuredClone(job),
        signal: controller.signal,
        guard,
        wrapArchive,
      });
      if (
        typeof attempt?.cleanup !== 'function' ||
        typeof attempt?.authorizeCompletion !== 'function' ||
        typeof attempt?.finish !== 'function' ||
        ['prepare', 'recoverPreparation', 'loadPinned'].some(
          (method) => typeof attempt?.intake?.[method] !== 'function',
        )
      )
        invalid();
      await guard();
      if (!candidate) {
        const resolution = await attempt.intake.prepare({
          projectId: job.projectId,
          actorId: job.actorId,
          sourceId: job.sourceId,
          expectedRevision: job.bindingRevision,
          requestedRelease: job.requestedRelease,
        });
        await guard();
        const prepared = readCandidate(job, resolution);
        if (
          !candidate ||
          !archiveReceipt ||
          canonicalJson(prepared) !== canonicalJson(candidate) ||
          canonicalJson(
            describeNativePackageArchiveReceipt(
              resolution.archiveReceipt,
              candidate.materializationId,
            ),
          ) !== canonicalJson(archiveReceipt)
        )
          invalid();
      } else {
        if (!archiveReceipt) {
          const recovered = await attempt.intake.recoverPreparation({
            actorId: job.actorId,
            resolution: structuredClone(candidate),
          });
          await guard();
          if (canonicalJson(readCandidate(job, recovered)) !== canonicalJson(candidate)) invalid();
          await saveReceipt(recovered.archiveReceipt);
        }
        await attempt.intake.loadPinned({
          actorId: job.actorId,
          resolution: { ...structuredClone(candidate), archiveReceipt },
        });
        await guard();
      }
    } catch (error) {
      failure = error;
    } finally {
      try {
        if (attempt) {
          await attempt.cleanup({ authorizeCompletion: failure === undefined });
          cleaned = true;
        } else {
          // A host that throws during construction must clean its own partial
          // resources before rejecting createAttempt.
          cleaned = true;
        }
      } catch (error) {
        if (error instanceof WorkflowSourceError) {
          // The host preserves this type only after completing all cleanup.
          cleaned = true;
          failure = error;
        } else {
          controller.abort();
          failure = new NativePackageWorkerError('native_package_worker_cleanup');
        }
      }
      // Keep the budget active during resource cleanup and the final CAS.
      if (!lease) clearTimeout(timer);
    }
    let succeeded = false;
    let handled = false;
    try {
      if (lease && cleaned) {
        await guard();
        if (!failure) {
          try {
            await attempt.authorizeCompletion();
            await guard();
          } catch (error) {
            failure = error;
          }
        }
        if (failure) {
          await attempt?.finish({ success: false });
          await guard();
          const code = terminalCode(failure);
          if (code) {
            await jobs.fail({ ...lease, code });
            logger.warn(
              JSON.stringify({ event: 'native_package_worker_terminal_failure', ...pointer }),
            );
            handled = true;
          }
        } else {
          await jobs.succeed(lease);
          succeeded = true;
          handled = true;
        }
      }
    } catch {
      handled = false;
    }
    try {
      await attempt?.finish({ success: succeeded });
    } catch {
      handled = false;
    } finally {
      controller.abort();
      clearTimeout(timer);
    }
    return handled;
  };

  return async (event, context) => {
    if (
      !plain(event) ||
      Object.hasOwn(event, 'operation') ||
      !Array.isArray(event.Records) ||
      event.Records.length === 0 ||
      event.Records.length > maxRecords
    )
      invalid();
    const seen = new Set();
    // Validate the whole trusted envelope before claiming anything. A malformed
    // record without a usable message ID cannot form a safe partial response.
    for (const record of event.Records) {
      if (
        !plain(record) ||
        record.eventSource !== 'aws:sqs' ||
        record.eventSourceARN !== expectedQueueArn ||
        !matches(record.messageId, /^[A-Za-z0-9_-]{1,128}$/) ||
        seen.has(record.messageId)
      )
        invalid();
      seen.add(record.messageId);
    }
    const batchItemFailures = [];
    let fifoFailed = false;
    for (const record of event.Records) {
      let complete = false;
      let busy = false;
      if (!fifoFailed) {
        try {
          const outcome = await processPointer(readPointer(record), context);
          complete = outcome === true;
          busy = outcome === 'busy';
        } catch {
          // No raw job/provider/SDK errors or input bodies are logged/returned.
        }
      }
      if (!complete) {
        // Duplicate delivery during a live lease is expected retry work.
        // It must not page the incident destination as a worker failure.
        if (!busy && !fifoFailed)
          logger.warn(
            JSON.stringify({ event: 'native_package_worker_retry', messageId: record.messageId }),
          );
        batchItemFailures.push({ itemIdentifier: record.messageId });
        if (expectedQueueArn.endsWith('.fifo')) fifoFailed = true;
      }
    }
    return { batchItemFailures };
  };
};
