// Controller-only, best-effort metadata. Never serialize an SDK error or a
// runtime report: both can contain credentials, prompts and provider bodies.
import { createHash } from 'node:crypto';
import { NATIVE_RUNTIME_FAILURE_CODES } from '../shared/native-execution-failure.js';

const PHASES = new Set(['start', 'continue', 'status', 'recover', 'unknown']);
const STAGES = new Set(['sdk', 'http', 'body', 'report', 'call', 'decision']);
const CODES = new Set([
  'SDK_FAILURE',
  'CONTENT_TYPE_INVALID',
  'BODY_TOO_LARGE',
  'BODY_READ_FAILED',
  'BODY_JSON_INVALID',
  'OWNER_REJECTED',
  'HTTP_NON_200',
  'REPORT_OBSERVED',
  'CALL_FAILED',
  'RECOVERY_REQUIRED',
  'RUNTIME_TERMINAL',
  'STATUS_READ_RETRY',
  'IMAGE_REVOKED',
]);
const READ_FAILURES = new Set([
  'SDK_FAILURE',
  'CONTENT_TYPE_INVALID',
  'BODY_TOO_LARGE',
  'BODY_READ_FAILED',
  'BODY_JSON_INVALID',
  'HTTP_NON_200',
]);
const STATUSES = new Set([
  'preparing',
  'running',
  'publishing',
  'publication_ready',
  'failed',
  'cancelled',
  'cancelling',
  'stopped_needs_review',
  'recovering',
  'recovery_ready',
]);
const RUNTIME_CODES = new Set(NATIVE_RUNTIME_FAILURE_CODES);
const ERROR_CODES = new Set([
  'NATIVE_EXECUTION_RUNTIME_UNAVAILABLE',
  'NATIVE_EXECUTION_RUNTIME_MISMATCH',
  'NATIVE_EXECUTION_LEASE_LOST',
  'NATIVE_EXECUTION_STOP_UNCONFIRMED',
  'NATIVE_EXECUTION_CANCELLED',
  'NATIVE_EXECUTION_FENCE_INVALID',
  'NATIVE_EXECUTION_FENCE_CONFLICT',
  'NATIVE_EXECUTION_CREDENTIALS_UNAVAILABLE',
  'NATIVE_EXECUTION_IMAGE_REVOKED',
  'NATIVE_EXECUTION_RETRY',
  'NATIVE_RECOVERY_INVALID',
  'NATIVE_RECOVERY_MISSING',
  'NATIVE_RECOVERY_UNAVAILABLE',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  ...RUNTIME_CODES,
]);
const ERROR_NAMES = new Set([
  'Error',
  'TypeError',
  'SyntaxError',
  'AbortError',
  'TimeoutError',
  'RuntimeClientError',
  'AccessDeniedException',
  'AccessDenied',
  'ResourceNotFoundException',
  'ValidationException',
  'ConflictException',
  'RetryableConflictException',
  'ThrottlingException',
  'TooManyRequestsException',
  'ServiceUnavailableException',
  'InternalServerException',
  'NoSuchKey',
  'NotFound',
]);
const REASONS = new Set([
  'SESSION_LOST',
  'RESTORE_FAILED',
  'CHECKPOINT_UNAVAILABLE',
  'DELIVERY_UNCERTAIN',
]);
const IDENTITY_FIELDS = [
  'projectId',
  'executionId',
  'bindingId',
  'attemptId',
  'epoch',
  'runtimeSessionId',
  'writerGeneration',
];
const CONTROL_STATUSES = new Set([
  'REQUESTED',
  'UPGRADING',
  'DISPATCHING',
  'RUNNING',
  'RECOVERING',
  'RECOVERY_REQUIRED',
  'FAILED',
  'CANCEL_REQUESTED',
  'CANCELLED',
]);
const own = (value, key) => {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
};
const errorName = (error) => {
  try {
    for (let depth = 0; error && depth < 3; depth++, error = Object.getPrototypeOf(error)) {
      const descriptor = Object.getOwnPropertyDescriptor(error, 'name');
      if (descriptor) return Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
    }
  } catch {
    // A hostile accessor/proxy is never evaluated for logging.
  }
  return undefined;
};
const enumeration = (values, value) =>
  typeof value === 'string' && values.has(value) ? value : 'unknown';
const counter = (value) =>
  Number.isSafeInteger(value) && value >= 1 && value <= 2_147_483_647 ? value : undefined;
const httpStatus = (value) =>
  Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined;
const requestId = (value) =>
  typeof value === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)
    ? value
    : undefined;

export const nativeDiagnosticPhase = (command) =>
  enumeration(
    PHASES,
    typeof command === 'string' && command.startsWith('native-')
      ? command.slice('native-'.length)
      : undefined,
  );

export const nativeDiagnosticError = (error) => {
  const metadata = own(error, '$metadata');
  return {
    errorName: enumeration(ERROR_NAMES, errorName(error)),
    errorCode: enumeration(ERROR_CODES, own(error, 'code')),
    ...(httpStatus(own(metadata, 'httpStatusCode')) !== undefined
      ? { httpStatus: httpStatus(own(metadata, 'httpStatusCode')) }
      : {}),
    ...(requestId(own(metadata, 'requestId'))
      ? { awsRequestId: requestId(own(metadata, 'requestId')) }
      : {}),
  };
};

export const nativeDiagnosticResponse = (response) => ({
  ...(httpStatus(own(response, 'statusCode')) !== undefined
    ? { httpStatus: httpStatus(own(response, 'statusCode')) }
    : {}),
  ...(requestId(own(own(response, '$metadata'), 'requestId'))
    ? { awsRequestId: requestId(own(own(response, '$metadata'), 'requestId')) }
    : {}),
});

export const nativeDiagnosticReport = (row, report) => {
  const rowScope = own(row, 'scope');
  const storedGeneration = own(row, 'writerGeneration');
  const reportedGeneration = own(report, 'writerGeneration');
  // Match checkReportIdentity: only both absent use the legacy exception;
  // otherwise the report must echo the stored generation, defaulting to 1.
  const legacyGeneration = storedGeneration === undefined && reportedGeneration === undefined;
  const expected = {
    projectId: own(rowScope, 'projectId'),
    executionId: own(rowScope, 'executionId'),
    bindingId: own(row, 'bindingId'),
    attemptId: own(row, 'attemptId'),
    epoch: own(row, 'epoch'),
    runtimeSessionId: own(row, 'runtimeSessionId'),
    writerGeneration: storedGeneration ?? 1,
  };
  const response = own(row, 'response');
  return {
    status: enumeration(STATUSES, own(report, 'status')),
    runtimeCode: enumeration(RUNTIME_CODES, own(report, 'code')),
    ...(own(report, 'recoveryFailureCode') !== undefined
      ? { recoveryFailureCode: enumeration(RUNTIME_CODES, own(report, 'recoveryFailureCode')) }
      : {}),
    sequence: counter(own(report, 'sequence')),
    expectedSequence: counter(own(row, 'turnSequence') ?? 1),
    writerGeneration: counter(reportedGeneration),
    expectedWriterGeneration: counter(storedGeneration ?? 1),
    recovered: own(report, 'recovered'),
    recoveredPresent: own(report, 'recovered') !== undefined,
    sequenceMatches: own(report, 'sequence') === (own(row, 'turnSequence') ?? 1),
    requestIdMatches: !response || own(report, 'requestId') === own(response, 'commandId'),
    identityMismatches: IDENTITY_FIELDS.filter(
      (key) =>
        !(key === 'writerGeneration' && legacyGeneration) && own(report, key) !== expected[key],
    ),
  };
};

// This boundary is used even with an injected diagnostic sink. Whitelisted
// primitives only; no getters, coercion, arbitrary field names or toJSON calls.
export const emitNativeExecutionDiagnostic = (sink, input) => {
  try {
    if (typeof sink !== 'function') return;
    const value = {
      phase: enumeration(PHASES, own(input, 'phase')),
      stage: enumeration(STAGES, own(input, 'stage')),
      code: enumeration(CODES, own(input, 'code')),
    };
    for (const [key, values] of [
      ['status', STATUSES],
      ['runtimeCode', RUNTIME_CODES],
      ['recoveryFailureCode', RUNTIME_CODES],
      ['errorCode', ERROR_CODES],
      ['errorName', ERROR_NAMES],
      ['reason', REASONS],
      ['controlStatus', CONTROL_STATUSES],
      ['failureClass', READ_FAILURES],
    ]) {
      if (own(input, key) !== undefined) value[key] = enumeration(values, own(input, key));
    }
    for (const key of [
      'sequence',
      'expectedSequence',
      'writerGeneration',
      'expectedWriterGeneration',
    ]) {
      const number = counter(own(input, key));
      if (number !== undefined) value[key] = number;
    }
    const status = httpStatus(own(input, 'httpStatus'));
    if (status !== undefined) value.httpStatus = status;
    const id = requestId(own(input, 'awsRequestId'));
    if (id !== undefined) value.awsRequestId = id;
    for (const key of [
      'recovered',
      'recoveredPresent',
      'sequenceMatches',
      'requestIdMatches',
      'dispatchPresent',
      'checkpointPresent',
    ]) {
      if (typeof own(input, key) === 'boolean') value[key] = own(input, key);
    }
    const mismatches = own(input, 'identityMismatches');
    if (Array.isArray(mismatches)) {
      const fields = [];
      for (let index = 0; index < IDENTITY_FIELDS.length; index++)
        fields.push(own(mismatches, String(index)));
      value.identityMismatches = IDENTITY_FIELDS.filter((field) => fields.includes(field));
    }
    sink(value);
  } catch {
    // Logging must never admit, cancel, retry, fence or fail an execution.
  }
};

export const createNativeExecutionDiagnostics = ({ logger, scope }) => {
  const projectId = own(scope, 'projectId');
  const executionId = own(scope, 'executionId');
  if (
    typeof projectId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(projectId) ||
    typeof executionId !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(executionId)
  )
    return () => {};
  const scopeHash = createHash('sha256')
    .update(JSON.stringify({ projectId, executionId }))
    .digest('hex');
  return (input) =>
    emitNativeExecutionDiagnostic((value) => {
      logger.info(JSON.stringify({ event: 'native_execution_diagnostic', scopeHash, ...value }));
    }, input);
};
