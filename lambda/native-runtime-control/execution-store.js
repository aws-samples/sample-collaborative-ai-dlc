// Control-plane authority only. Runtime/graph flags must never be passed as
// authorization. Membership, credential resolution, image qualification, and
// manifest/file verification remain the caller's responsibility.
import { createHash, randomUUID } from 'node:crypto';
import { NATIVE_RUNTIME_FAILURE_CODES } from '../shared/native-execution-failure.js';
import { GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import {
  nativeRuntimeBindingKey,
  nativeRuntimeResourceNames,
} from '../shared/native-runtime-binding.js';
import { canonicalJson } from '../shared/workflow-checkpoint.js';
import { nativeDraftPrompt } from './draft-prompt.js';
import { nativeExecutionHistory } from './execution-history.js';
import { answerHistoryKey, answerObservation, nativeAnswerHistory } from './answer-history.js';
import {
  nativeInteractionReceipt,
  NATIVE_INTERACTION_LIMITS,
} from '../shared/native-interaction.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const REVISION = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,255}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const MAX_ROW_BYTES = 32 * 1024;
const MAX_TIME = 8640000000000000;
const STATES = [
  'REQUESTED',
  'UPGRADING',
  'DISPATCHING',
  'RUNNING',
  'RECOVERING',
  'RECOVERY_REQUIRED',
  'AWAITING_USER',
  'WAITING_FOR_INPUT',
  'STOPPED',
  'FAILED',
  'CANCEL_REQUESTED',
  'CANCELLED',
];
const TRANSITIONS = {
  REQUESTED: ['UPGRADING', 'DISPATCHING', 'FAILED'],
  UPGRADING: ['DISPATCHING', 'FAILED'],
  DISPATCHING: ['RUNNING', 'FAILED'],
  RUNNING: ['FAILED'],
  RECOVERING: ['FAILED'],
  RECOVERY_REQUIRED: [],
  AWAITING_USER: ['FAILED'],
  WAITING_FOR_INPUT: [],
  STOPPED: [],
  FAILED: [],
  CANCEL_REQUESTED: ['CANCELLED'],
  CANCELLED: [],
};
const FAILURE_CODES = [
  ...NATIVE_RUNTIME_FAILURE_CODES,
  'native_execution_access_denied',
  'native_execution_source_changed',
  'native_execution_runtime_mismatch',
  'native_execution_publication_invalid',
  'native_execution_image_revoked',
];
const MESSAGES = {
  INVALID: 'Invalid native execution record or request',
  CONFLICT: 'Native execution changed or its immutable configuration conflicts',
  NOT_FOUND: 'Native execution not found',
  NOT_READY: 'A ready native workspace is required',
  UNAVAILABLE: 'Native execution storage is unavailable',
  LEASE_LOST: 'Native execution ownership changed',
  CANCELLED: 'Native execution cancellation fences this operation',
};
export class NativeExecutionError extends Error {
  constructor(suffix = 'INVALID') {
    const safe = Object.hasOwn(MESSAGES, suffix) ? suffix : 'INVALID';
    super(MESSAGES[safe]);
    this.name = 'NativeExecutionError';
    this.code = `NATIVE_EXECUTION_${safe}`;
  }
}
const fail = (suffix) => {
  throw new NativeExecutionError(suffix);
};
const check = (condition) => {
  if (!condition) fail('INVALID');
};
const matches = (value, pattern) => typeof value === 'string' && pattern.exec(value)?.[0] === value;
const integer = (value, min = 0) => Number.isSafeInteger(value) && value >= min;
const timeValue = (value) => integer(value) && value <= MAX_TIME;
const text = (value, max) =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.trim() === value &&
  Buffer.byteLength(value) <= max &&
  ![...value].some((character) => character.codePointAt(0) < 32 || character === '\x7f');
const same = (left, right) => canonicalJson(left) === canonicalJson(right);
const sha = (value) => createHash('sha256').update(value).digest('hex');
const clone = (value) => structuredClone(value);

// Reject unknown keys, undefined values, accessors and non-JSON properties
// rather than silently stripping possible credentials or caller authority.
const shape = (value, required, optional = []) => {
  check(
    value !== null &&
      typeof value === 'object' &&
      Object.getPrototypeOf(value) === Object.prototype,
  );
  const descriptors = Object.getOwnPropertyDescriptors(value);
  check(
    Reflect.ownKeys(value).every(
      (key) =>
        typeof key === 'string' &&
        (required.includes(key) || optional.includes(key)) &&
        descriptors[key].enumerable &&
        Object.hasOwn(descriptors[key], 'value') &&
        descriptors[key].value !== undefined,
    ) && required.every((key) => Object.hasOwn(value, key)),
  );
};
const scope = (value) => {
  shape(value, ['projectId', 'executionId']);
  check(matches(value.projectId, ID) && matches(value.executionId, UUID));
  return clone(value);
};
const identity = (value) => {
  shape(value, ['projectId', 'executionId', 'bindingId']);
  check(matches(value.bindingId, UUID));
  return scope({ projectId: value.projectId, executionId: value.executionId });
};
export const nativeExecutionKey = (value) => ({
  ...nativeRuntimeBindingKey(scope(value)),
  sk: 'EXECUTION',
});
const image = (value, accountId) => {
  shape(value, ['uri', 'digest']);
  check(
    matches(value.digest, DIGEST) &&
      text(value.uri, 1024) &&
      matches(
        value.uri,
        /^[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com(?:\.cn)?\/[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$/,
      ) &&
      value.uri.startsWith(`${accountId}.`) &&
      value.uri.endsWith(`@${value.digest}`),
  );
};
const relativePath = (value, max = 1024) =>
  text(value, max) &&
  !value.includes('\\') &&
  !value.startsWith('/') &&
  value.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
const bucket = (value) =>
  matches(value, /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/) &&
  !value.includes('..') &&
  !value.includes('.-') &&
  !value.includes('-.') &&
  !matches(value, /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/);
const branch = (value) =>
  value === null ||
  (text(value, 255) &&
    !/[ ~^:?*[\]\\]/.test(value) &&
    !value.includes('..') &&
    !value.includes('@{') &&
    value !== '@' &&
    !value.startsWith('-') &&
    !value.endsWith('.') &&
    value
      .split('/')
      .every((part) => part !== '' && !part.startsWith('.') && !part.endsWith('.lock')));

export const nativeExecutionConfiguration = (value) => {
  shape(value, [
    'harness',
    'model',
    'promptSha256',
    'packageId',
    'materializationId',
    'source',
    'repository',
    'credentialBinding',
    'image',
    'publicationBucket',
    'packageBucket',
    'accountId',
  ]);
  check(
    ['claude', 'codex', 'kiro', 'opencode'].includes(value.harness) &&
      (value.model === null || matches(value.model, /^[A-Za-z0-9][A-Za-z0-9_.:/()-]{0,255}$/)) &&
      matches(value.promptSha256, SHA256) &&
      matches(value.packageId, DIGEST) &&
      matches(value.materializationId, DIGEST) &&
      matches(value.accountId, /^[0-9]{12}$/) &&
      bucket(value.publicationBucket) &&
      bucket(value.packageBucket),
  );
  shape(value.source, ['sourceId', 'bindingRevision', 'packageJobId']);
  check(
    matches(value.source.sourceId, SHA256) &&
      matches(value.source.bindingRevision, REVISION) &&
      matches(value.source.packageJobId, REVISION),
  );
  shape(value.repository, ['provider', 'repository', 'branch', 'bindingRevision']);
  check(
    ['github', 'gitlab', 'bitbucket'].includes(value.repository.provider) &&
      text(value.repository.repository, 512) &&
      value.repository.repository.split('/').length >= 2 &&
      value.repository.repository
        .split('/')
        .every((part) => matches(part, /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/) && !part.endsWith('.')) &&
      branch(value.repository.branch) &&
      matches(value.repository.bindingRevision, REVISION),
  );
  shape(value.credentialBinding, ['provider', 'source'], ['userId']);
  check(
    value.credentialBinding.provider === (value.harness === 'kiro' ? 'kiro' : 'bedrock') &&
      ['user', 'space', 'platform'].includes(value.credentialBinding.source) &&
      (value.credentialBinding.source === 'user'
        ? matches(value.credentialBinding.userId, ID)
        : !Object.hasOwn(value.credentialBinding, 'userId')),
  );
  image(value.image, value.accountId);
  return clone(value);
};

const PREPARATION_FIELDS = [
  'bindingId',
  'version',
  'requestFingerprint',
  'image',
  'executionRoleArn',
  'accessPointArn',
  'fileSystemId',
  'rootDirectory',
  'mountPath',
  'runtimeArn',
  'runtimeVersion',
  'runtimeEndpoint',
];
const preparation = (value, row) => {
  shape(value, PREPARATION_FIELDS, ['promptRevision']);
  check(value.promptRevision === undefined || integer(value.promptRevision));
  const names = nativeRuntimeResourceNames({ ...row.scope, bindingId: row.bindingId });
  const runtime =
    typeof value.runtimeArn === 'string'
      ? /^arn:(aws(?:-[a-z]+)*):bedrock-agentcore:([a-z0-9-]+):([0-9]{12}):runtime\/([A-Za-z0-9_-]+)$/.exec(
          value.runtimeArn,
        )
      : null;
  check(runtime !== null);
  const [, partition, region, accountId, runtimeId] = runtime;
  image(value.image, row.configuration.accountId);
  check(
    value.bindingId === row.bindingId &&
      integer(value.version, 1) &&
      matches(value.requestFingerprint, DIGEST) &&
      accountId === row.configuration.accountId &&
      matches(runtimeId, new RegExp(`^${names.runtimeName}-[A-Za-z0-9]+$`)) &&
      value.executionRoleArn ===
        `arn:${partition}:iam::${accountId}:role/native-runs/${names.roleName}` &&
      matches(
        value.accessPointArn,
        new RegExp(
          `^arn:${partition}:elasticfilesystem:${region}:${accountId}:access-point/fsap-[a-f0-9]{17}$`,
        ),
      ) &&
      matches(value.fileSystemId, /^fs-[a-f0-9]{8}(?:[a-f0-9]{9})?$/) &&
      value.rootDirectory === names.rootDirectory &&
      value.mountPath === '/mnt/native' &&
      matches(value.runtimeVersion, /^[1-9][0-9]{0,19}$/) &&
      value.runtimeEndpoint === names.endpointName &&
      value.image.uri.startsWith(`${accountId}.dkr.ecr.${region}.`) &&
      row.configuration.image.uri.startsWith(`${accountId}.dkr.ecr.${region}.`),
  );
};
const target = (value, row) => {
  shape(value, [
    'runtimeArn',
    'runtimeId',
    'runtimeVersion',
    'endpoint',
    'endpointArn',
    'imageDigest',
    'rolePolicySha256',
  ]);
  const endpoint = `exec_${sha(row.attemptId).slice(0, 32)}`;
  check(
    value.runtimeArn === row.preparation.runtimeArn &&
      value.runtimeId === row.preparation.runtimeArn.split('/').at(-1) &&
      matches(value.runtimeVersion, /^[1-9][0-9]{0,19}$/) &&
      value.endpoint === endpoint &&
      value.endpointArn === `${value.runtimeArn}/runtime-endpoint/${endpoint}` &&
      value.imageDigest === row.configuration.image.digest &&
      matches(value.rolePolicySha256, SHA256) &&
      BigInt(value.runtimeVersion) >= BigInt(row.preparation.runtimeVersion) &&
      (row.configuration.image.digest === row.preparation.image.digest ||
        BigInt(value.runtimeVersion) > BigInt(row.preparation.runtimeVersion)),
  );
};
const publicationValue = (value) => {
  shape(value, [
    'id',
    'sequence',
    'manifest',
    'question',
    'outcome',
    'nativeSessionId',
    'filesCount',
  ]);
  check(
    matches(value.id, SHA256) &&
      integer(value.sequence, 1) &&
      ['WAITING_FOR_INPUT', 'STOPPED'].includes(value.outcome) &&
      (matches(value.nativeSessionId, ID) ||
        (value.outcome === 'STOPPED' && value.nativeSessionId === null)) &&
      integer(value.filesCount) &&
      value.filesCount <= 100000,
  );
  shape(value.manifest, ['key', 'versionId', 'sha256', 'bytes']);
  check(
    relativePath(value.manifest.key) &&
      text(value.manifest.versionId, 1024) &&
      value.manifest.versionId !== 'null' &&
      matches(value.manifest.sha256, SHA256) &&
      integer(value.manifest.bytes, 1) &&
      value.manifest.bytes <= 16 * 1024 * 1024,
  );
  if (value.question !== null) {
    shape(value.question, ['path', 'sha256']);
    check(relativePath(value.question.path) && matches(value.question.sha256, SHA256));
  }
  check(
    value.outcome === 'WAITING_FOR_INPUT'
      ? value.question !== null && value.filesCount > 0
      : value.question === null,
  );
  return clone(value);
};
export const nativeTurnSequence = (row) => row.turnSequence ?? 1;
// Runtime replacement is independent of both cancellation epoch and the
// supervisor's short-lived lease fence. Historical records keep their identity.
export const nativeWriterGeneration = (row) => row.writerGeneration ?? 1;
const RECOVERY_REASONS = [
  'SESSION_LOST',
  'RESTORE_FAILED',
  'CHECKPOINT_UNAVAILABLE',
  'DELIVERY_UNCERTAIN',
];
const recoveryCheckpointValue = (value) => {
  shape(value, ['id', 'sequence', 'manifest']);
  shape(value.manifest, ['key', 'versionId', 'sha256', 'bytes']);
  check(
    matches(value.id, SHA256) &&
      integer(value.sequence, 1) &&
      value.manifest.sha256 === value.id &&
      relativePath(value.manifest.key, 4096) &&
      value.manifest.key.startsWith('native-recovery/v1/') &&
      text(value.manifest.versionId, 1024) &&
      value.manifest.versionId !== 'null' &&
      integer(value.manifest.bytes, 1) &&
      value.manifest.bytes <= 16 * 1024 * 1024,
  );
  return clone(value);
};
const recoverableBoundary = (row) =>
  !!row.recoveryCheckpoint &&
  row.recoveryCheckpoint.sequence === row.publication?.sequence &&
  row.interaction?.sequence === row.publication.sequence &&
  row.publication.sequence + 1 === nativeTurnSequence(row) &&
  row.response?.deliveryStatus === 'pending' &&
  !row.dispatch;
const interactionIdentity = (row, epoch = row.epoch) => ({
  ...row.scope,
  bindingId: row.bindingId,
  attemptId: row.attemptId,
  epoch,
  runtimeSessionId: row.runtimeSessionId,
});
const interactionValue = (value, row, epoch = row.epoch) => {
  shape(value, ['id', 'sequence', 'nativeSessionId', 'publicationId', 'object']);
  check(
    matches(value.id, SHA256) &&
      integer(value.sequence, 1) &&
      (value.nativeSessionId === null || matches(value.nativeSessionId, ID)) &&
      matches(value.publicationId, SHA256),
  );
  shape(value.object, ['key', 'versionId', 'sha256', 'bytes']);
  check(
    relativePath(value.object.key) &&
      text(value.object.versionId, 1024) &&
      value.object.versionId !== 'null' &&
      value.object.sha256 === value.id &&
      integer(value.object.bytes, 1) &&
      value.object.bytes <= NATIVE_INTERACTION_LIMITS.envelopeBytes,
  );
  return nativeInteractionReceipt(value, interactionIdentity(row, epoch));
};
const responseText = (value) =>
  typeof value === 'string' &&
  value.trim().length > 0 &&
  Buffer.byteLength(value) <= NATIVE_INTERACTION_LIMITS.responseBytes &&
  ![...value].some((character) => {
    const code = character.codePointAt(0);
    return (code < 32 && ![9, 10, 13].includes(code)) || code === 127;
  }) &&
  value.isWellFormed();
export const nativeReplyRequest = (value) => {
  shape(value, [
    'requestId',
    'interactionId',
    'contentSha256',
    'text',
    ...(Object.hasOwn(value ?? {}, 'selection') ? ['selection'] : []),
  ]);
  check(
    matches(value.requestId, UUID) &&
      matches(value.interactionId, SHA256) &&
      matches(value.contentSha256, SHA256) &&
      responseText(value.text),
  );
  return clone(value);
};
const RESPONSE_FIELDS = [
  'commandId',
  'interactionId',
  'contentSha256',
  'sequence',
  'actorId',
  'requestId',
  'textSha256',
  'acceptedAt',
];
const responseValue = (value) => {
  shape(value, [...RESPONSE_FIELDS, 'deliveryStatus']);
  check(
    matches(value.commandId, UUID) &&
      matches(value.interactionId, SHA256) &&
      matches(value.contentSha256, SHA256) &&
      integer(value.sequence, 2) &&
      matches(value.actorId, ID) &&
      matches(value.requestId, UUID) &&
      matches(value.textSha256, SHA256) &&
      timeValue(value.acceptedAt) &&
      ['pending', 'delivered'].includes(value.deliveryStatus),
  );
  return clone(value);
};
const responseMember = (value) => {
  shape(value, ['membershipId', 'projectIdentity']);
  check(
    [value.membershipId, value.projectIdentity].every(
      (part) =>
        typeof part === 'string' &&
        part.length > 0 &&
        Buffer.byteLength(part) <= 512 &&
        part.trim() === part &&
        ![...part].some((c) => c.codePointAt(0) < 32 || c === '\x7f'),
    ),
  );
  return clone(value);
};
export const nativeResponseKey = (value, interactionId) => {
  check(matches(interactionId, SHA256));
  return { ...nativeExecutionKey(value), sk: `RESPONSE#${interactionId}` };
};
const responseRequestKey = (value, actorId, requestId) => ({
  ...nativeExecutionKey(value),
  sk: `RESPONSE_REQUEST#${sha(canonicalJson([actorId, requestId]))}`,
});
export const publicationHistoryKey = (value, sequence) => ({
  ...nativeExecutionKey(value),
  sk: `PUBLICATION#${String(sequence).padStart(16, '0')}`,
});
const ROW_FIELDS = [
  'pk',
  'sk',
  'schemaVersion',
  'scope',
  'bindingId',
  'version',
  'epoch',
  'attemptId',
  'runtimeSessionId',
  'startedBy',
  'requestId',
  'configuration',
  'configurationSha256',
  'preparation',
  'status',
  'cancelRequested',
  'startedAt',
  'updatedAt',
  'fence',
];
const ROW_OPTIONAL = [
  'leaseToken',
  'leaseExpiresAt',
  'sourceCommit',
  'sourceBranch',
  'target',
  'failureCode',
  'publication',
  'publicationEpoch',
  'projectionStatus',
  'stop',
  'turnSequence',
  'interaction',
  'interactionEpoch',
  'interactionContentSha256',
  'response',
  'writerGeneration',
  'recoveryCheckpoint',
  'dispatch',
  'recovery',
  'lastRecoveryId',
  'stopConfirmation',
];
const validateStopConfirmation = (row) => {
  if (!Object.hasOwn(row, 'stopConfirmation')) return;
  shape(row.stopConfirmation, ['runtimeSessionId', 'writerGeneration', 'confirmedAt']);
  check(
    !!row.target &&
      row.stopConfirmation.runtimeSessionId === row.runtimeSessionId &&
      integer(row.stopConfirmation.writerGeneration, 1) &&
      row.stopConfirmation.writerGeneration <= nativeWriterGeneration(row) &&
      timeValue(row.stopConfirmation.confirmedAt) &&
      row.stopConfirmation.confirmedAt >= row.startedAt &&
      row.stopConfirmation.confirmedAt <= row.updatedAt,
  );
};
const validate = (row, expectedScope) => {
  shape(row, ROW_FIELDS, ROW_OPTIONAL);
  const rowScope = scope(row.scope);
  const key = nativeExecutionKey(rowScope);
  check(
    (!expectedScope || same(rowScope, expectedScope)) &&
      row.pk === key.pk &&
      row.sk === key.sk &&
      row.schemaVersion === 1 &&
      matches(row.bindingId, UUID) &&
      integer(row.version, 1) &&
      matches(row.attemptId, UUID) &&
      matches(row.runtimeSessionId, UUID) &&
      matches(row.startedBy, ID) &&
      matches(row.requestId, ID) &&
      STATES.includes(row.status) &&
      typeof row.cancelRequested === 'boolean' &&
      row.epoch === (row.cancelRequested ? 2 : 1) &&
      timeValue(row.startedAt) &&
      timeValue(row.updatedAt) &&
      row.updatedAt >= row.startedAt &&
      integer(row.fence),
  );
  nativeExecutionConfiguration(row.configuration);
  check(integer(nativeTurnSequence(row), 1));
  check(integer(nativeWriterGeneration(row), 1));
  validateStopConfirmation(row);
  check(
    row.configurationSha256 === sha(canonicalJson(row.configuration)) &&
      (row.configuration.credentialBinding.source !== 'user' ||
        row.configuration.credentialBinding.userId === row.startedBy),
  );
  preparation(row.preparation, row);
  if (Object.hasOwn(row, 'leaseToken') || Object.hasOwn(row, 'leaseExpiresAt')) {
    check(
      matches(row.leaseToken, UUID) &&
        timeValue(row.leaseExpiresAt) &&
        row.leaseExpiresAt > row.updatedAt &&
        row.fence > 0 &&
        row.status !== 'CANCELLED',
    );
  }
  if (Object.hasOwn(row, 'sourceCommit')) check(matches(row.sourceCommit, COMMIT));
  if (Object.hasOwn(row, 'sourceBranch')) {
    check(
      row.sourceBranch !== null &&
        branch(row.sourceBranch) &&
        (row.configuration.repository.branch === null ||
          row.sourceBranch === row.configuration.repository.branch),
    );
  }
  if (Object.hasOwn(row, 'target')) target(row.target, row);
  if (
    [
      'DISPATCHING',
      'RUNNING',
      'RECOVERING',
      'RECOVERY_REQUIRED',
      'AWAITING_USER',
      'WAITING_FOR_INPUT',
      'STOPPED',
    ].includes(row.status)
  ) {
    check(
      Object.hasOwn(row, 'sourceCommit') &&
        Object.hasOwn(row, 'sourceBranch') &&
        Object.hasOwn(row, 'target'),
    );
  }
  check(
    row.status === 'FAILED'
      ? FAILURE_CODES.includes(row.failureCode)
      : !Object.hasOwn(row, 'failureCode'),
  );
  if (row.cancelRequested) {
    check(['CANCEL_REQUESTED', 'CANCELLED'].includes(row.status));
    shape(row.stop, ['state', 'requestedAt'], ['completedAt']);
    check(
      timeValue(row.stop.requestedAt) &&
        row.stop.requestedAt >= row.startedAt &&
        row.stop.requestedAt <= row.updatedAt &&
        (row.status === 'CANCELLED'
          ? row.stop.state === 'COMPLETED' &&
            timeValue(row.stop.completedAt) &&
            row.stop.completedAt >= row.stop.requestedAt &&
            row.stop.completedAt <= row.updatedAt
          : row.stop.state === 'PENDING' && !Object.hasOwn(row.stop, 'completedAt')),
    );
  } else {
    check(!Object.hasOwn(row, 'stop') && !['CANCEL_REQUESTED', 'CANCELLED'].includes(row.status));
  }
  if (
    Object.hasOwn(row, 'publication') ||
    Object.hasOwn(row, 'publicationEpoch') ||
    Object.hasOwn(row, 'projectionStatus')
  ) {
    publicationValue(row.publication);
    check(
      row.sourceCommit !== undefined &&
        row.sourceBranch !== undefined &&
        row.target !== undefined &&
        integer(row.publicationEpoch, 1) &&
        row.publicationEpoch === row.epoch - (row.cancelRequested ? 1 : 0) &&
        ['pending', 'complete'].includes(row.projectionStatus) &&
        row.publication.sequence <= nativeTurnSequence(row) &&
        (row.cancelRequested ||
          row.status === row.publication.outcome ||
          (row.interaction &&
            (row.status === 'AWAITING_USER' ||
              row.status === 'FAILED' ||
              row.status === 'RECOVERING' ||
              row.status === 'RECOVERY_REQUIRED' ||
              row.publication.sequence < nativeTurnSequence(row)))),
    );
  } else {
    check(!['WAITING_FOR_INPUT', 'STOPPED', 'AWAITING_USER'].includes(row.status));
  }
  if (
    Object.hasOwn(row, 'interaction') ||
    Object.hasOwn(row, 'interactionEpoch') ||
    Object.hasOwn(row, 'interactionContentSha256')
  ) {
    interactionValue(row.interaction, row, row.interactionEpoch);
    check(
      row.publication !== undefined &&
        row.interaction.publicationId === row.publication.id &&
        row.interaction.sequence === row.publication.sequence &&
        row.interaction.nativeSessionId === row.publication.nativeSessionId &&
        row.interactionEpoch === row.publicationEpoch &&
        matches(row.interactionContentSha256, SHA256),
    );
  }
  if (row.status === 'AWAITING_USER') check(row.interaction?.sequence === nativeTurnSequence(row));
  if (Object.hasOwn(row, 'response')) {
    responseValue(row.response);
    check(
      row.response.sequence === nativeTurnSequence(row) &&
        row.response.acceptedAt >= row.startedAt &&
        row.response.acceptedAt <= row.updatedAt &&
        (row.response.deliveryStatus !== 'pending' ||
          row.cancelRequested ||
          row.status === 'FAILED' ||
          row.status === 'RECOVERING' ||
          row.status === 'RECOVERY_REQUIRED' ||
          row.status === 'DISPATCHING'),
    );
    if (row.response.deliveryStatus === 'pending')
      check(
        row.interaction?.id === row.response.interactionId &&
          row.interactionContentSha256 === row.response.contentSha256 &&
          row.interaction.sequence + 1 === row.response.sequence,
      );
  }
  if (Object.hasOwn(row, 'recoveryCheckpoint')) {
    recoveryCheckpointValue(row.recoveryCheckpoint);
    check(row.recoveryCheckpoint.sequence === row.publication?.sequence);
  }
  if (Object.hasOwn(row, 'dispatch')) {
    shape(row.dispatch, ['sequence', 'writerGeneration', 'commandId', 'attemptedAt']);
    check(
      row.dispatch.sequence === nativeTurnSequence(row) &&
        row.dispatch.writerGeneration === nativeWriterGeneration(row) &&
        timeValue(row.dispatch.attemptedAt) &&
        row.dispatch.attemptedAt >= row.startedAt &&
        row.dispatch.attemptedAt <= row.updatedAt &&
        (row.dispatch.sequence === 1
          ? row.dispatch.commandId === null
          : row.dispatch.commandId === row.response?.commandId) &&
        [
          'DISPATCHING',
          'RUNNING',
          'FAILED',
          'RECOVERY_REQUIRED',
          'CANCEL_REQUESTED',
          'CANCELLED',
        ].includes(row.status),
    );
  }
  if (Object.hasOwn(row, 'recovery')) {
    shape(
      row.recovery,
      ['id', 'reason', 'canRecover'],
      ['phase', 'previousGeneration', 'writerGeneration', 'checkpointId'],
    );
    check(matches(row.recovery.id, UUID) && RECOVERY_REASONS.includes(row.recovery.reason));
    check(typeof row.recovery.canRecover === 'boolean');
    if (row.status === 'RECOVERING') {
      check(
        recoverableBoundary(row) &&
          !row.recovery.canRecover &&
          ['FENCING', 'RESTORING'].includes(row.recovery.phase) &&
          integer(row.recovery.previousGeneration, 1) &&
          row.recovery.writerGeneration === row.recovery.previousGeneration + 1 &&
          row.recovery.checkpointId === row.recoveryCheckpoint.id &&
          nativeWriterGeneration(row) ===
            (row.recovery.phase === 'FENCING'
              ? row.recovery.previousGeneration
              : row.recovery.writerGeneration),
      );
    } else {
      check(
        ['RECOVERY_REQUIRED', 'CANCEL_REQUESTED', 'CANCELLED'].includes(row.status) &&
          Object.keys(row.recovery).length === 3 &&
          (!row.recovery.canRecover ||
            (row.recovery.reason === 'RESTORE_FAILED' && recoverableBoundary(row))),
      );
    }
  } else check(!['RECOVERING', 'RECOVERY_REQUIRED'].includes(row.status));
  if (Object.hasOwn(row, 'lastRecoveryId')) check(matches(row.lastRecoveryId, UUID));
  check(Buffer.byteLength(JSON.stringify(row)) <= MAX_ROW_BYTES);
  return clone(row);
};
const retryableConflict = (error) =>
  error?.name === 'ConditionalCheckFailedException' ||
  (error?.name === 'TransactionCanceledException' &&
    (!error.CancellationReasons ||
      error.CancellationReasons.some((reason) =>
        ['ConditionalCheckFailed', 'TransactionConflict'].includes(reason.Code),
      )));
const runnable = (row) =>
  ['REQUESTED', 'UPGRADING', 'DISPATCHING', 'RUNNING', 'RECOVERING', 'CANCEL_REQUESTED'].includes(
    row.status,
  ) ||
  (!row.cancelRequested && row.projectionStatus === 'pending');
const unlease = (row) => {
  delete row.leaseToken;
  delete row.leaseExpiresAt;
  return row;
};

/**
 * All identities use {projectId, executionId}; claim/cancel also require
 * bindingId. start returns {row, created}; claim returns {kind, row?}.
 * advance/release/publish/projected take the FULL last returned row and return
 * the committed row. advance accepts only status, sourceCommit (Git SHA),
 * sourceBranch (resolved non-null branch), target {runtimeArn,runtimeId,
 * runtimeVersion,endpoint,endpointArn,imageDigest,rolePolicySha256} and an
 * enumerated failureCode. Empty advance renews a worker lease.
 *
 * REQUESTED -> [UPGRADING ->] DISPATCHING -> RUNNING; only publish can enter
 * WAITING_FOR_INPUT/STOPPED. DISPATCHING is durably recorded BEFORE invoking.
 * Retrying/reclaiming it MUST reconcile the SAME attemptId/runtimeSessionId:
 * storage fencing cannot make an external model invocation exactly-once.
 *
 * publish atomically stores the current turn, immutable receipt history,
 * publicationEpoch=current epoch, and projectionStatus='pending'. Legacy rows
 * without turnSequence remain sequence 1. A verified ordinary interaction
 * enters AWAITING_USER; it is not a verified workflow question or approval.
 * projected acknowledges trusted ingestion with projectionStatus='complete'
 * under ownership. Cancellation retains publicationEpoch and historical
 * publication metadata, but forbids its pending projection acknowledgement.
 * Authorized member readers must validate committed manifest/file scope against
 * publicationEpoch, not the current cancellation-fenced execution epoch.
 * cancel immediately fences owners/publications and records stop=PENDING.
 * A newly claimed stop worker marks CANCELLED only after confirming the stop.
 *
 * respond atomically accepts one exact user message against an interaction's
 * message digest, persists an immutable RESPONSE ledger and request-ID index,
 * and advances turnSequence to DISPATCHING. It does not change epoch, owner,
 * credentials, or confer approval authority. dispatched acknowledges runtime
 * acceptance of the same command; its delivery marker is separate from the
 * immutable human response. response(row, interactionId) reads that ledger.
 */
export const createNativeExecutionStore = ({
  ddb,
  tableName,
  preparationStore,
  now = Date.now,
  leaseMs = 120000,
} = {}) => {
  if (
    typeof ddb?.send !== 'function' ||
    !matches(tableName, /^[A-Za-z0-9_.-]{3,255}$/) ||
    typeof preparationStore?.get !== 'function' ||
    typeof now !== 'function' ||
    !integer(leaseMs, 1) ||
    leaseMs > 3600000
  )
    fail('UNAVAILABLE');
  const clock = () => {
    const value = now();
    if (!timeValue(value) || !timeValue(value + leaseMs)) fail('UNAVAILABLE');
    return value;
  };
  // Only the execution observer can submit this acknowledgement. The worker
  // first closes the writer fence and validates the provider's exact response.
  // Derive generation/time here; never accept a client-selected proof scope.
  const stopConfirmation = (row, runtimeSessionId) => {
    check(!!row.target && runtimeSessionId === row.runtimeSessionId);
    return {
      runtimeSessionId,
      writerGeneration: nativeWriterGeneration(row),
      confirmedAt: clock(),
    };
  };
  const get = async (input) => {
    const currentScope = scope(input);
    let result;
    try {
      result = await ddb.send(
        new GetCommand({
          TableName: tableName,
          Key: nativeExecutionKey(currentScope),
          ConsistentRead: true,
        }),
      );
    } catch {
      fail('UNAVAILABLE');
    }
    if (!result || typeof result !== 'object' || Array.isArray(result)) fail('UNAVAILABLE');
    return result.Item === undefined ? null : validate(result.Item, currentScope);
  };
  const commit = async (before, candidate, leaseMode = 'owned', additions = []) => {
    const time = clock();
    if (time < before.updatedAt) fail('UNAVAILABLE');
    const next = validate(
      {
        ...candidate,
        version: before.version + 1,
        updatedAt: time,
      },
      before.scope,
    );
    const fields = [
      'version',
      'bindingId',
      'epoch',
      'cancelRequested',
      'status',
      'fence',
      'attemptId',
      'runtimeSessionId',
      'configurationSha256',
    ];
    const names = Object.fromEntries(fields.map((key) => [`#${key}`, key]));
    const values = Object.fromEntries(fields.map((key) => [`:${key}`, before[key]]));
    const conditions = fields.map((key) => `#${key} = :${key}`);
    for (const key of ['leaseToken', 'leaseExpiresAt']) {
      names[`#${key}`] = key;
      if (Object.hasOwn(before, key)) {
        values[`:${key}`] = before[key];
        conditions.push(`#${key} = :${key}`);
      } else conditions.push(`attribute_not_exists(#${key})`);
    }
    if (!['cancel', 'response'].includes(leaseMode) && before.leaseToken) {
      values[':now'] = time;
      conditions.push(`#leaseExpiresAt ${leaseMode === 'expired' ? '<=' : '>'} :now`);
      if (leaseMode === 'owned' && before.leaseExpiresAt <= time) fail('LEASE_LOST');
    }
    try {
      await ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: tableName,
                Item: next,
                ConditionExpression: conditions.join(' AND '),
                ExpressionAttributeNames: names,
                ExpressionAttributeValues: values,
              },
            },
            ...additions,
            ...historyWrite(before, next),
            ...nativeAnswerHistory(before, next).map((Item) => ({
              Put: { TableName: tableName, Item, ConditionExpression: 'attribute_not_exists(pk)' },
            })),
          ],
        }),
      );
      return next;
    } catch (error) {
      // An ambiguous transport result is success only for the EXACT full row.
      // Never adopt a later owner's write as the acknowledgement for ours.
      const current = await get(before.scope);
      if (current && same(current, next)) return current;
      if (current && !same(current, before)) fail('CONFLICT');
      if (retryableConflict(error)) fail('CONFLICT');
      fail('UNAVAILABLE');
    }
  };
  const historyWrite = (before, row) => {
    const Item = nativeExecutionHistory(before, row);
    return Item
      ? [{ Put: { TableName: tableName, Item, ConditionExpression: 'attribute_not_exists(pk)' } }]
      : [];
  };
  const owned = async (candidate, { allowCancelled = false } = {}) => {
    validate(candidate);
    const current = await get(candidate.scope);
    if (!current) fail('NOT_FOUND');
    if (current.cancelRequested && !allowCancelled) fail('CANCELLED');
    if (
      !same(current, candidate) ||
      !matches(current.leaseToken, UUID) ||
      current.leaseExpiresAt <= clock() ||
      !runnable(current)
    )
      fail('LEASE_LOST');
    return current;
  };
  const retryStart = (row, configuration, promptRevision = 0) => {
    if (
      !same(row.configuration, configuration) ||
      (row.preparation.promptRevision ?? 0) !== promptRevision
    )
      fail('CONFLICT');
    return { row, created: false };
  };
  const readRecord = async (key) => {
    try {
      return (
        (
          await ddb.send(
            new GetCommand({
              TableName: tableName,
              Key: key,
              ConsistentRead: true,
            }),
          )
        ).Item ?? null
      );
    } catch {
      fail('UNAVAILABLE');
    }
  };
  const acceptedResponse = (value, row) => {
    // Task-2 ledgers also freeze the accepting membership snapshot and the
    // publication presented. Earlier accepted ledgers remain valid without them.
    const attributed = Object.hasOwn(value ?? {}, 'member');
    shape(value, [
      'pk',
      'sk',
      'schemaVersion',
      'scope',
      'bindingId',
      'attemptId',
      'epoch',
      'runtimeSessionId',
      ...RESPONSE_FIELDS,
      'text',
      ...(attributed ? ['member', 'publicationId'] : []),
      ...(Object.hasOwn(value ?? {}, 'selection') ? ['selection'] : []),
    ]);
    if (attributed) {
      responseMember(value.member);
      check(matches(value.publicationId, SHA256));
    }
    const fields = Object.fromEntries(RESPONSE_FIELDS.map((key) => [key, value[key]]));
    responseValue({ ...fields, deliveryStatus: 'pending' });
    check(
      value.schemaVersion === 1 &&
        same(value.scope, row.scope) &&
        same({ pk: value.pk, sk: value.sk }, nativeResponseKey(row.scope, value.interactionId)) &&
        value.bindingId === row.bindingId &&
        value.attemptId === row.attemptId &&
        value.runtimeSessionId === row.runtimeSessionId &&
        value.epoch === (row.cancelRequested ? row.epoch - 1 : row.epoch) &&
        responseText(value.text) &&
        sha(value.text) === value.textSha256,
    );
    return clone(value);
  };
  const getResponse = async (row, interactionId) => {
    validate(row);
    const value = await readRecord(nativeResponseKey(row.scope, interactionId));
    return value ? acceptedResponse(value, row) : null;
  };

  return Object.freeze({
    get,
    response: getResponse,
    async historicalAnswer(row, found) {
      const interactionId = found.interaction?.id;
      if (!interactionId) return null;
      const value = await readRecord(nativeResponseKey(row.scope, interactionId));
      if (!value) return null;
      const response = acceptedResponse(value, {
        ...row,
        attemptId: found.identity.attemptId,
        epoch: found.identity.epoch,
        runtimeSessionId: found.runtimeSessionId,
        cancelRequested: false,
      });
      check(
        response.sequence === found.receipt.sequence + 1 &&
          response.contentSha256 === found.interactionContentSha256 &&
          (!response.publicationId || response.publicationId === found.receipt.id),
      );
      const observations = await Promise.all(
        ['delivered', 'uncertain', 'publication'].map(async (kind) =>
          answerObservation(
            await readRecord(answerHistoryKey(row, interactionId, kind)),
            row,
            response,
            kind,
          ),
        ),
      );
      return {
        response,
        delivered: observations[0],
        uncertain: observations[1],
        publication: observations[2],
      };
    },
    async start(input) {
      shape(
        input,
        ['projectId', 'executionId', 'actorId', 'requestId', 'configuration'],
        ['promptRevision'],
      );
      const currentScope = scope({ projectId: input.projectId, executionId: input.executionId });
      check(matches(input.actorId, ID) && matches(input.requestId, ID));
      const configuration = nativeExecutionConfiguration(input.configuration);
      const current = await get(currentScope);
      if (current) {
        if ((current.preparation.promptRevision ?? 0) !== (input.promptRevision ?? 0))
          fail('CONFLICT');
        return retryStart(current, configuration, input.promptRevision);
      }
      if (
        configuration.credentialBinding.source === 'user' &&
        configuration.credentialBinding.userId !== input.actorId
      )
        fail('INVALID');
      let prepared;
      try {
        prepared = await preparationStore.get(currentScope);
      } catch {
        fail('UNAVAILABLE');
      }
      if (!prepared) fail('NOT_FOUND');
      if (prepared.status !== 'READY') fail('NOT_READY');
      const prompt = nativeDraftPrompt(prepared);
      if (prompt.revision !== (input.promptRevision ?? 0)) fail('CONFLICT');
      check(
        prepared.projectId === currentScope.projectId &&
          prepared.executionId === currentScope.executionId &&
          prepared.pk === nativeRuntimeBindingKey(currentScope).pk &&
          prepared.sk === 'RUNTIME' &&
          configuration.harness === prepared.request?.harness &&
          typeof prompt.text === 'string' &&
          Boolean(prompt.text.trim()) &&
          configuration.promptSha256 === sha(prompt.text) &&
          configuration.packageId === prepared.candidate?.packagePin?.packageId &&
          configuration.materializationId === prepared.candidate?.materializationId &&
          configuration.source.sourceId === prepared.request.sourceId &&
          configuration.source.bindingRevision === prepared.request.bindingRevision &&
          configuration.source.packageJobId === prepared.request.packageJobId,
      );
      const pins = Object.fromEntries(
        PREPARATION_FIELDS.map((key) => [
          key,
          key === 'image'
            ? { uri: prepared.imageUri, digest: prepared.imageDigest }
            : prepared[key],
        ]),
      );
      if (prompt.revision > 0) pins.promptRevision = prompt.revision;
      const time = clock();
      const row = validate(
        {
          ...nativeExecutionKey(currentScope),
          schemaVersion: 1,
          scope: currentScope,
          bindingId: prepared.bindingId,
          version: 1,
          epoch: 1,
          attemptId: randomUUID(),
          runtimeSessionId: randomUUID(),
          startedBy: input.actorId,
          requestId: input.requestId,
          configuration,
          configurationSha256: sha(canonicalJson(configuration)),
          preparation: pins,
          status: 'REQUESTED',
          cancelRequested: false,
          startedAt: time,
          updatedAt: time,
          fence: 0,
          turnSequence: 1,
          writerGeneration: 1,
        },
        currentScope,
      );
      try {
        await ddb.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                ConditionCheck: {
                  TableName: tableName,
                  Key: nativeRuntimeBindingKey(currentScope),
                  ConditionExpression:
                    '#status = :ready AND #bindingId = :bindingId AND #version = :version AND #requestFingerprint = :requestFingerprint',
                  ExpressionAttributeNames: {
                    '#status': 'status',
                    '#bindingId': 'bindingId',
                    '#version': 'version',
                    '#requestFingerprint': 'requestFingerprint',
                  },
                  ExpressionAttributeValues: {
                    ':ready': 'READY',
                    ':bindingId': pins.bindingId,
                    ':version': pins.version,
                    ':requestFingerprint': pins.requestFingerprint,
                  },
                },
              },
              {
                Put: {
                  TableName: tableName,
                  Item: row,
                  ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
                },
              },
              ...historyWrite(null, row),
            ],
          }),
        );
        return { row, created: true };
      } catch (error) {
        const stored = await get(currentScope);
        if (stored) return retryStart(stored, configuration, input.promptRevision);
        if (retryableConflict(error)) fail('CONFLICT');
        fail('UNAVAILABLE');
      }
    },
    async claim(input) {
      const currentScope = identity(input);
      for (let retry = 0; retry < 4; retry += 1) {
        const row = await get(currentScope);
        if (!row) return { kind: 'missing' };
        if (row.bindingId !== input.bindingId) fail('CONFLICT');
        if (!runnable(row)) return { kind: 'terminal', row };
        const time = clock();
        if (row.leaseToken && row.leaseExpiresAt > time) return { kind: 'busy', row };
        try {
          const claimed = await commit(
            row,
            {
              ...row,
              leaseToken: randomUUID(),
              leaseExpiresAt: time + leaseMs,
              fence: row.fence + 1,
            },
            'expired',
          );
          return { kind: 'claimed', row: claimed };
        } catch (error) {
          if (error.code !== 'NATIVE_EXECUTION_CONFLICT') throw error;
        }
      }
      fail('CONFLICT');
    },
    async advance(input) {
      shape(input, ['row', 'patch'], ['stoppedSessionId']);
      shape(input.patch, [], ['status', 'sourceCommit', 'sourceBranch', 'target', 'failureCode']);
      const row = await owned(input.row, { allowCancelled: true });
      if (row.cancelRequested && Object.keys(input.patch).some((key) => key !== 'status'))
        fail('CANCELLED');
      // Validate nested objects before structuredClone can flatten a prototype
      // or invoke an accessor. Never silently turn malformed patches into pins.
      if (Object.hasOwn(input.patch, 'target')) target(input.patch.target, row);
      if (Object.hasOwn(input.patch, 'sourceCommit'))
        check(matches(input.patch.sourceCommit, COMMIT));
      if (Object.hasOwn(input.patch, 'sourceBranch'))
        check(input.patch.sourceBranch !== null && branch(input.patch.sourceBranch));
      if (Object.hasOwn(input.patch, 'status')) check(STATES.includes(input.patch.status));
      if (Object.hasOwn(input.patch, 'failureCode'))
        check(FAILURE_CODES.includes(input.patch.failureCode));
      const patch = clone(input.patch);
      if (
        patch.status !== undefined &&
        patch.status !== row.status &&
        !TRANSITIONS[row.status].includes(patch.status)
      )
        fail('CONFLICT');
      for (const key of ['sourceCommit', 'sourceBranch', 'target']) {
        if (!Object.hasOwn(patch, key)) continue;
        if (Object.hasOwn(row, key)) {
          if (!same(row[key], patch[key])) fail('CONFLICT');
        } else if (!['REQUESTED', 'UPGRADING'].includes(row.status)) fail('CONFLICT');
      }
      const next = { ...row, ...patch, leaseExpiresAt: clock() + leaseMs };
      if (Object.hasOwn(input, 'stoppedSessionId')) {
        check(['FAILED', 'CANCELLED'].includes(patch.status));
        next.stopConfirmation = stopConfirmation(row, input.stoppedSessionId);
      }
      if (next.status === 'FAILED') {
        next.failureCode ??= 'native_execution_failed';
        delete next.recovery;
        unlease(next);
      }
      if (next.status === 'CANCELLED') {
        next.stop = { ...row.stop, state: 'COMPLETED', completedAt: clock() };
        unlease(next);
      }
      return commit(row, next);
    },
    async release(input) {
      shape(input, ['row']);
      const row = await owned(input.row, { allowCancelled: true });
      return commit(row, unlease({ ...row }));
    },
    async respond(input) {
      const attributed = Object.hasOwn(input ?? {}, 'member');
      shape(input, [
        'projectId',
        'executionId',
        'bindingId',
        'actorId',
        'request',
        ...(attributed ? ['member'] : []),
      ]);
      const member = attributed ? responseMember(input.member) : null;
      const currentScope = identity({
        projectId: input.projectId,
        executionId: input.executionId,
        bindingId: input.bindingId,
      });
      check(matches(input.actorId, ID));
      const request = nativeReplyRequest(input.request);
      const requestKey = responseRequestKey(currentScope, input.actorId, request.requestId);
      for (let retry = 0; retry < 4; retry += 1) {
        const row = await get(currentScope);
        if (!row) fail('NOT_FOUND');
        if (row.bindingId !== input.bindingId) fail('CONFLICT');
        if (row.cancelRequested) fail('CANCELLED');
        const priorRequest = await readRecord(requestKey);
        if (priorRequest && priorRequest.interactionId !== request.interactionId) fail('CONFLICT');
        const existing = await getResponse(row, request.interactionId);
        if (existing) {
          if (
            existing.actorId !== input.actorId ||
            existing.requestId !== request.requestId ||
            existing.contentSha256 !== request.contentSha256 ||
            existing.text !== request.text ||
            canonicalJson(existing.selection ?? null) !== canonicalJson(request.selection ?? null)
          )
            fail('CONFLICT');
          const latest = await get(currentScope);
          if (!latest) fail('NOT_FOUND');
          if (latest.cancelRequested) fail('CANCELLED');
          if (
            latest.bindingId !== row.bindingId ||
            latest.attemptId !== row.attemptId ||
            latest.runtimeSessionId !== row.runtimeSessionId
          )
            fail('CONFLICT');
          return { row: latest, response: existing, created: false };
        }
        if (
          priorRequest ||
          row.status !== 'AWAITING_USER' ||
          row.interaction?.id !== request.interactionId ||
          row.interactionContentSha256 !== request.contentSha256 ||
          row.interaction.sequence !== nativeTurnSequence(row)
        )
          fail('CONFLICT');
        const sequence = nativeTurnSequence(row) + 1;
        check(integer(sequence, 2));
        const response = {
          ...nativeResponseKey(currentScope, request.interactionId),
          schemaVersion: 1,
          ...interactionIdentity(row),
          scope: row.scope,
          commandId: randomUUID(),
          interactionId: request.interactionId,
          contentSha256: request.contentSha256,
          sequence,
          actorId: input.actorId,
          requestId: request.requestId,
          text: request.text,
          textSha256: sha(request.text),
          acceptedAt: clock(),
          // The exact accepting member and presented publication, frozen with
          // the answer. Authority is checked by the API before this commit.
          ...(member ? { member, publicationId: row.interaction.publicationId } : {}),
          // The structured selection the member submitted (validated by the API
          // against the committed interaction); text remains the delivered reply.
          ...(request.selection ? { selection: request.selection } : {}),
        };
        // Scope is nested in protected records, as it is on the execution row.
        delete response.projectId;
        delete response.executionId;
        const pointer = {
          ...Object.fromEntries(RESPONSE_FIELDS.map((key) => [key, response[key]])),
          deliveryStatus: 'pending',
        };
        const additions = [
          response,
          {
            ...requestKey,
            interactionId: request.interactionId,
            commandId: response.commandId,
          },
        ].map((Item) => ({
          Put: {
            TableName: tableName,
            Item,
            ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
          },
        }));
        try {
          const next = await commit(
            row,
            unlease({
              ...row,
              status: 'DISPATCHING',
              turnSequence: sequence,
              response: pointer,
            }),
            'response',
            additions,
          );
          return { row: next, response, created: true };
        } catch (error) {
          if (error.code !== 'NATIVE_EXECUTION_CONFLICT') throw error;
        }
      }
      fail('CONFLICT');
    },
    async dispatched(input) {
      shape(input, ['row']);
      const row = await owned(input.row);
      if (row.status !== 'DISPATCHING' || row.response?.deliveryStatus !== 'pending')
        fail('CONFLICT');
      const response = await getResponse(row, row.response.interactionId);
      if (!response || response.commandId !== row.response.commandId) fail('CONFLICT');
      return commit(row, {
        ...row,
        status: 'RUNNING',
        response: { ...row.response, deliveryStatus: 'delivered' },
        leaseExpiresAt: clock() + leaseMs,
      });
    },
    async dispatchAttempted(input) {
      shape(input, ['row']);
      const row = await owned(input.row);
      if (
        row.status !== 'DISPATCHING' ||
        (nativeTurnSequence(row) > 1 && row.response?.deliveryStatus !== 'pending')
      )
        fail('CONFLICT');
      if (row.dispatch) return row;
      return commit(row, {
        ...row,
        dispatch: {
          sequence: nativeTurnSequence(row),
          writerGeneration: nativeWriterGeneration(row),
          commandId: row.response?.commandId ?? null,
          attemptedAt: clock(),
        },
        leaseExpiresAt: clock() + leaseMs,
      });
    },
    async beginRecovery(input) {
      shape(input, ['row']);
      const row = await owned(input.row);
      if (row.status !== 'DISPATCHING' || !recoverableBoundary(row)) fail('CONFLICT');
      return commit(row, {
        ...row,
        status: 'RECOVERING',
        recovery: {
          id: randomUUID(),
          reason: 'SESSION_LOST',
          canRecover: false,
          phase: 'FENCING',
          previousGeneration: nativeWriterGeneration(row),
          writerGeneration: nativeWriterGeneration(row) + 1,
          checkpointId: row.recoveryCheckpoint.id,
        },
        leaseExpiresAt: clock() + leaseMs,
      });
    },
    async recoveryStopped(input) {
      shape(input, ['row']);
      const row = await owned(input.row);
      if (row.status !== 'RECOVERING' || row.recovery.phase !== 'FENCING') fail('CONFLICT');
      // The caller must have fenced and positively stopped the old runtime.
      // Persist this boundary before issuing admission to the next generation.
      return commit(row, {
        ...row,
        writerGeneration: row.recovery.writerGeneration,
        recovery: { ...row.recovery, phase: 'RESTORING' },
        leaseExpiresAt: clock() + leaseMs,
      });
    },
    async recovered(input) {
      shape(input, ['row']);
      const row = await owned(input.row);
      if (row.status !== 'RECOVERING' || row.recovery.phase !== 'RESTORING') fail('CONFLICT');
      const next = {
        ...row,
        status: 'DISPATCHING',
        lastRecoveryId: row.recovery.id,
        leaseExpiresAt: clock() + leaseMs,
      };
      delete next.recovery;
      return commit(row, next);
    },
    async recoveryRequired(input) {
      shape(input, ['row', 'reason'], ['recoveryId', 'stoppedSessionId']);
      check(RECOVERY_REASONS.includes(input.reason));
      if (Object.hasOwn(input, 'recoveryId')) check(matches(input.recoveryId, UUID));
      const row = await owned(input.row);
      if (!['DISPATCHING', 'RUNNING', 'RECOVERING'].includes(row.status)) fail('CONFLICT');
      return commit(
        row,
        unlease({
          ...row,
          status: 'RECOVERY_REQUIRED',
          ...(Object.hasOwn(input, 'stoppedSessionId')
            ? { stopConfirmation: stopConfirmation(row, input.stoppedSessionId) }
            : {}),
          recovery: {
            id: input.recoveryId ?? randomUUID(),
            reason: input.reason,
            canRecover: input.reason === 'RESTORE_FAILED' && recoverableBoundary(row),
          },
        }),
      );
    },
    async recover(input) {
      shape(input, ['projectId', 'executionId', 'bindingId', 'request']);
      const currentScope = identity({
        projectId: input.projectId,
        executionId: input.executionId,
        bindingId: input.bindingId,
      });
      shape(input.request, ['requestId', 'recoveryId']);
      check(matches(input.request.requestId, UUID) && matches(input.request.recoveryId, UUID));
      for (let retry = 0; retry < 4; retry++) {
        const row = await get(currentScope);
        if (!row) fail('NOT_FOUND');
        if (row.bindingId !== input.bindingId) fail('CONFLICT');
        if (row.cancelRequested) fail('CANCELLED');
        // The server-issued episode deduplicates recovery across members and
        // tabs. A lost response must not start another writer generation.
        if (
          (row.status === 'RECOVERING' && row.recovery.id === input.request.recoveryId) ||
          row.lastRecoveryId === input.request.recoveryId
        )
          return row;
        if (
          row.status !== 'RECOVERY_REQUIRED' ||
          row.recovery.id !== input.request.recoveryId ||
          !row.recovery.canRecover ||
          !recoverableBoundary(row)
        )
          fail('CONFLICT');
        const next = unlease({
          ...row,
          status: 'RECOVERING',
          recovery: {
            id: row.recovery.id,
            reason: row.recovery.reason,
            canRecover: false,
            phase: 'FENCING',
            previousGeneration: nativeWriterGeneration(row),
            writerGeneration: nativeWriterGeneration(row) + 1,
            checkpointId: row.recoveryCheckpoint.id,
          },
        });
        try {
          return await commit(row, next, 'response');
        } catch (error) {
          if (error.code !== 'NATIVE_EXECUTION_CONFLICT') throw error;
        }
      }
      fail('CONFLICT');
    },
    async cancel(input) {
      const currentScope = identity(input);
      for (let retry = 0; retry < 4; retry += 1) {
        const row = await get(currentScope);
        if (!row) fail('NOT_FOUND');
        if (row.bindingId !== input.bindingId) fail('CONFLICT');
        if (row.cancelRequested) return row;
        const next = unlease({
          ...row,
          epoch: row.epoch + 1,
          cancelRequested: true,
          status: 'CANCEL_REQUESTED',
          stop: { state: 'PENDING', requestedAt: clock() },
        });
        delete next.failureCode;
        if (next.recovery)
          next.recovery = {
            id: row.recovery.id,
            reason: row.recovery.reason,
            canRecover: false,
          };
        try {
          return await commit(row, next, 'cancel');
        } catch (error) {
          if (error.code !== 'NATIVE_EXECUTION_CONFLICT') throw error;
        }
      }
      fail('CONFLICT');
    },
    async publish(input) {
      shape(
        input,
        ['row', 'publication'],
        ['interaction', 'interactionContentSha256', 'checkpoint'],
      );
      const publication = publicationValue(input.publication);
      const row = await owned(input.row);
      const interaction = input.interaction ? interactionValue(input.interaction, row) : null;
      const checkpoint = input.checkpoint ? recoveryCheckpointValue(input.checkpoint) : null;
      if (checkpoint) check(interaction !== null && checkpoint.sequence === publication.sequence);
      if (interaction) {
        check(
          matches(input.interactionContentSha256, SHA256) &&
            interaction.publicationId === publication.id &&
            interaction.sequence === publication.sequence &&
            interaction.nativeSessionId === publication.nativeSessionId,
        );
      } else check(!Object.hasOwn(input, 'interactionContentSha256'));
      if (row.publication?.sequence === publication.sequence) {
        if (
          !same(row.publication, publication) ||
          !same(row.interaction ?? null, interaction) ||
          !same(row.recoveryCheckpoint ?? null, checkpoint) ||
          (interaction && row.interactionContentSha256 !== input.interactionContentSha256)
        )
          fail('CONFLICT');
        return row;
      }
      if (
        !['DISPATCHING', 'RUNNING'].includes(row.status) ||
        publication.sequence !== nativeTurnSequence(row) ||
        (row.publication && row.publication.sequence + 1 !== publication.sequence)
      )
        fail('CONFLICT');
      const next = {
        ...row,
        status: interaction ? 'AWAITING_USER' : publication.outcome,
        publication,
        publicationEpoch: row.epoch,
        projectionStatus: 'pending',
        leaseExpiresAt: clock() + leaseMs,
      };
      delete next.dispatch;
      if (checkpoint) next.recoveryCheckpoint = checkpoint;
      else delete next.recoveryCheckpoint;
      if (interaction) {
        next.interaction = interaction;
        next.interactionEpoch = row.epoch;
        next.interactionContentSha256 = input.interactionContentSha256;
      } else {
        delete next.interaction;
        delete next.interactionEpoch;
        delete next.interactionContentSha256;
      }
      const Item = {
        ...publicationHistoryKey(row.scope, publication.sequence),
        schemaVersion: 1,
        ...interactionIdentity(row),
        scope: row.scope,
        publication,
        interaction,
        interactionContentSha256: input.interactionContentSha256 ?? null,
        admittedAt: clock(),
        ...(checkpoint ? { recoveryCheckpoint: checkpoint } : {}),
      };
      delete Item.projectId;
      delete Item.executionId;
      return commit(row, next, 'owned', [
        {
          Put: {
            TableName: tableName,
            Item,
            ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
          },
        },
      ]);
    },
    async projected(input) {
      shape(input, ['row']);
      const row = await owned(input.row);
      if (!row.publication || row.projectionStatus !== 'pending') fail('CONFLICT');
      return commit(row, unlease({ ...row, projectionStatus: 'complete' }));
    },
  });
};
