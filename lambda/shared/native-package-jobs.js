// Protected broker state only. The host authenticates callers, authorizes the
// source again at worker boundaries, and owns the table/queue IAM. Job records,
// lease tokens and archive receipts are not project or execution authority.
import { createHash, randomUUID } from 'node:crypto';
import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { canonicalJson } from './workflow-checkpoint.js';
import { describeNativePackagePin } from './native-package-pin.js';
import { describeNativePackageArchiveReceipt } from './native-package-archive.js';
import { workflowSourceIdentity } from './workflow-source-bindings.js';

const RECORD_BYTES = 64 * 1024;
const MAX_LEASE_MS = 24 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 100;
const CAS_TRIES = 4;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,255}$/;
const TAG = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-preview\.\d{8}\.[1-9]\d*)?$/;
const MESSAGES = Object.freeze({
  native_package_job_invalid: 'Native package job inputs or stored state are invalid',
  native_package_job_conflict: 'Native package job changed or its immutable request conflicts',
  native_package_job_lease_lost: 'Native package job lease is no longer current',
  native_package_job_unavailable: 'Native package job storage is unavailable',
  native_package_job_not_found: 'Native package job was not found',
});
const FAILURE_CODES = new Set([
  'native_package_job_failed',
  'native_package_job_attempts_exhausted',
  'native_package_worker_denied',
  'native_package_worker_invalid',
  ...Object.keys(MESSAGES),
  'WORKFLOW_SOURCE_INVALID',
  'WORKFLOW_SOURCE_FORBIDDEN',
  'WORKFLOW_SOURCE_CONFLICT',
  'WORKFLOW_SOURCE_NOT_FOUND',
  'WORKFLOW_SOURCE_UNAVAILABLE',
  'native_package_invalid',
  'native_package_not_cached',
  'native_package_busy',
  'native_package_io',
  'native_package_cleanup',
  'native_package_intake_invalid',
  'native_package_intake_failed',
  'native_package_intake_cleanup_failed',
  'native_package_archive_invalid',
  'native_package_archive_not_found',
  'native_package_archive_corrupt',
  'native_package_archive_busy',
  'native_package_archive_unavailable',
  'native_package_archive_cleanup',
  'native_package_trust_invalid',
  'native_package_trust_mismatch',
  'native_package_trust_denied',
  'native_release_invalid',
  'native_release_changed',
  'native_release_catalog_invalid',
  'native_release_catalog_unavailable',
  'native_release_catalog_incomplete',
  'native_release_catalog_unsupported',
  'native_release_assets_unavailable',
  'native_release_pin_mismatch',
  'native_release_selection_invalid',
  'native_release_discovery_incomplete',
  'native_release_not_found',
  'native_release_not_selectable',
  'native_source_request_invalid',
  'native_source_read_failed',
  'native_source_timeout',
  'native_source_limit',
  'native_source_delivery_unsupported',
  'native_source_redirect_invalid',
  'native_source_response_invalid',
  'native_source_cleanup_failed',
]);

export class NativePackageJobError extends Error {
  constructor(code = 'native_package_job_invalid') {
    const safeCode =
      typeof code === 'string' && Object.hasOwn(MESSAGES, code)
        ? code
        : 'native_package_job_invalid';
    super(MESSAGES[safeCode]);
    this.name = 'NativePackageJobError';
    this.code = safeCode;
  }
}
const fail = (suffix) => {
  throw new NativePackageJobError(`native_package_job_${suffix}`);
};
const matches = (value, pattern) => typeof value === 'string' && pattern.exec(value)?.[0] === value;
const record = (value) =>
  value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
const epoch = (value) => Number.isSafeInteger(value) && value >= 0;
const hash = (value) => `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
const same = (left, right) => canonicalJson(left) === canonicalJson(right);
const bounded = (value) => {
  try {
    if (Buffer.byteLength(JSON.stringify(value)) < RECORD_BYTES) return;
  } catch {
    // Cycles, BigInt and serialization failures never reach DynamoDB.
  }
  fail('invalid');
};
const keyFor = (input) => {
  if (!matches(input?.projectId, ID) || !matches(input?.jobId, UUID)) fail('invalid');
  return { projectId: input.projectId, jobId: input.jobId };
};
const release = (value) =>
  value === 'latest' || (typeof value === 'string' && value.length <= 256 && matches(value, TAG));
const requestFor = (input) => {
  const key = keyFor(input);
  const requestedRelease = input.requestedRelease === undefined ? 'latest' : input.requestedRelease;
  if (
    !matches(input.sourceId, /^[a-f0-9]{64}$/) ||
    !matches(input.actorId, ID) ||
    !matches(input.bindingRevision, UUID) ||
    !release(requestedRelease)
  )
    fail('invalid');
  return {
    ...key,
    sourceId: input.sourceId,
    actorId: input.actorId,
    bindingRevision: input.bindingRevision,
    requestedRelease,
  };
};
const requestDigest = (request) => hash({ schemaVersion: 1, ...request });

const candidateFor = (value) => {
  try {
    if (
      value?.schemaVersion !== 1 ||
      !matches(value.projectId, ID) ||
      !matches(value.sourceId, /^[a-f0-9]{64}$/) ||
      !matches(value.bindingRevision, UUID) ||
      !release(value.requestedRelease)
    )
      fail('invalid');
    const pin = describeNativePackagePin(value.packagePin, value.attestation);
    const source = workflowSourceIdentity(
      pin.identity.source.provider,
      pin.identity.source.repository,
    );
    if (
      source.sourceId !== value.sourceId ||
      value.materializationId !== pin.materializationId ||
      (value.requestedRelease === 'latest'
        ? pin.identity.version.includes('-preview.')
        : value.requestedRelease !== pin.identity.source.release)
    )
      fail('invalid');
    // Deliberate projection: full verifier reports are accepted but inventories,
    // trust, credentials, local paths and caller-supplied archive receipts are not.
    return {
      schemaVersion: 1,
      projectId: value.projectId,
      sourceId: value.sourceId,
      bindingRevision: value.bindingRevision,
      requestedRelease: value.requestedRelease,
      packagePin: { ...pin.identity, packageId: pin.packageId },
      attestation: pin.attestation,
      materializationId: pin.materializationId,
    };
  } catch {
    fail('invalid');
  }
};
const receiptFor = (value, materializationId = value?.materializationId) => {
  try {
    return describeNativePackageArchiveReceipt(value, materializationId);
  } catch {
    fail('invalid');
  }
};
const assertCandidateScope = (candidate, job) => {
  if (
    ['projectId', 'sourceId', 'bindingRevision', 'requestedRelease'].some(
      (field) => candidate[field] !== job[field],
    )
  )
    fail('conflict');
};
const FIELDS = new Set([
  'schemaVersion',
  'projectId',
  'jobId',
  'sourceId',
  'actorId',
  'bindingRevision',
  'requestedRelease',
  'requestDigest',
  'state',
  'attempts',
  'revision',
  'createdAt',
  'updatedAt',
  'leaseToken',
  'leaseExpiresAt',
  'candidate',
  'candidateDigest',
  'archiveReceipt',
  'errorCode',
]);
const validateJob = (value, key) => {
  try {
    bounded(value);
    if (
      !record(value) ||
      !Object.hasOwn(value, 'requestedRelease') ||
      Object.keys(value).some((field) => !FIELDS.has(field))
    )
      fail('invalid');
    const request = requestFor(value);
    if (
      value.schemaVersion !== 1 ||
      request.projectId !== key.projectId ||
      request.jobId !== key.jobId ||
      value.requestDigest !== requestDigest(request) ||
      !matches(value.revision, UUID) ||
      !['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED'].includes(value.state) ||
      !Number.isSafeInteger(value.attempts) ||
      value.attempts < 0 ||
      value.attempts > MAX_ATTEMPTS ||
      !epoch(value.createdAt) ||
      !epoch(value.updatedAt) ||
      value.updatedAt < value.createdAt
    )
      fail('invalid');
    if (value.state === 'RUNNING') {
      if (
        value.attempts < 1 ||
        !matches(value.leaseToken, UUID) ||
        !epoch(value.leaseExpiresAt) ||
        value.leaseExpiresAt <= value.updatedAt ||
        Object.hasOwn(value, 'errorCode')
      )
        fail('invalid');
    } else if (Object.hasOwn(value, 'leaseToken') || Object.hasOwn(value, 'leaseExpiresAt')) {
      fail('invalid');
    }
    if (value.state === 'QUEUED') {
      if (
        value.attempts !== 0 ||
        ['candidate', 'candidateDigest', 'archiveReceipt', 'errorCode'].some((field) =>
          Object.hasOwn(value, field),
        )
      )
        fail('invalid');
    } else if (value.attempts < 1) fail('invalid');
    if (value.state === 'FAILED') {
      if (!FAILURE_CODES.has(value.errorCode)) fail('invalid');
    } else if (Object.hasOwn(value, 'errorCode')) fail('invalid');
    if (Object.hasOwn(value, 'candidate')) {
      const candidate = candidateFor(value.candidate);
      assertCandidateScope(candidate, request);
      if (!same(candidate, value.candidate) || value.candidateDigest !== hash(candidate))
        fail('invalid');
    } else if (Object.hasOwn(value, 'candidateDigest') || Object.hasOwn(value, 'archiveReceipt')) {
      fail('invalid');
    }
    if (Object.hasOwn(value, 'archiveReceipt')) {
      receiptFor(value.archiveReceipt, value.candidate.materializationId);
    }
    if (value.state === 'SUCCEEDED' && !Object.hasOwn(value, 'archiveReceipt')) fail('invalid');
    return structuredClone(value);
  } catch {
    fail('invalid');
  }
};

/**
 * Defaults and upper bounds are internal domain safety limits, not approved
 * deployment sizing. No TTL, deletion, membership fallback or queue I/O.
 * Every update uses an opaque row revision as well as state/attempt/lease CAS.
 * Lease time is compared with the trusted host clock sampled after the read.
 */
export const createNativePackageJobs = ({
  ddb,
  tableName,
  now = Date.now,
  leaseMs = 660000,
  maxAttempts = 3,
} = {}) => {
  if (
    typeof ddb?.send !== 'function' ||
    !matches(tableName, /^[A-Za-z0-9_.-]{3,255}$/) ||
    typeof now !== 'function' ||
    !Number.isSafeInteger(leaseMs) ||
    leaseMs <= 0 ||
    leaseMs > MAX_LEASE_MS ||
    !Number.isSafeInteger(maxAttempts) ||
    maxAttempts <= 0 ||
    maxAttempts > MAX_ATTEMPTS
  )
    fail('invalid');
  const clock = () => {
    let time;
    try {
      time = now();
    } catch {
      fail('unavailable');
    }
    if (!epoch(time) || !epoch(time + leaseMs)) fail('invalid');
    return time;
  };
  const read = async (key) => {
    let response;
    try {
      response = await ddb.send(
        new GetCommand({ TableName: tableName, Key: key, ConsistentRead: true }),
      );
    } catch {
      fail('unavailable');
    }
    if (!record(response)) fail('unavailable');
    return response.Item === undefined ? null : validateJob(response.Item, key);
  };
  const requireLease = (job, leaseToken, time) => {
    if (!job) fail('not_found');
    if (job.state !== 'RUNNING' || job.leaseToken !== leaseToken || job.leaseExpiresAt <= time)
      fail('lease_lost');
    if (time < job.updatedAt) fail('unavailable');
  };
  const leaseInput = (input) => {
    const key = keyFor(input);
    if (!matches(input.leaseToken, UUID)) fail('invalid');
    return { key, leaseToken: input.leaseToken };
  };
  const nextJob = (job, time, fields) => {
    if (time < job.updatedAt) fail('unavailable');
    const next = { ...job, ...fields, revision: randomUUID(), updatedAt: time };
    if (next.state !== 'RUNNING') {
      delete next.leaseToken;
      delete next.leaseExpiresAt;
    }
    return validateJob(next, keyFor(job));
  };
  const update = async (previous, next, time, leaseCondition) => {
    const names = {
      '#revision': 'revision',
      '#request': 'requestDigest',
      '#state': 'state',
      '#attempts': 'attempts',
      '#token': 'leaseToken',
      '#expires': 'leaseExpiresAt',
    };
    const values = {
      ':revision': previous.revision,
      ':request': previous.requestDigest,
      ':state': previous.state,
      ':attempts': previous.attempts,
    };
    const conditions = [
      '#revision = :revision',
      '#request = :request',
      '#state = :state',
      '#attempts = :attempts',
    ];
    if (previous.state === 'RUNNING') {
      values[':token'] = previous.leaseToken;
      values[':expires'] = previous.leaseExpiresAt;
      values[':now'] = time;
      conditions.push('#token = :token', '#expires = :expires', `#expires ${leaseCondition} :now`);
    } else {
      conditions.push('attribute_not_exists(#token)', 'attribute_not_exists(#expires)');
    }
    const assignments = [];
    const removals = [];
    for (const [index, field] of [
      'state',
      'attempts',
      'revision',
      'updatedAt',
      'leaseToken',
      'leaseExpiresAt',
      'candidate',
      'candidateDigest',
      'archiveReceipt',
      'errorCode',
    ].entries()) {
      if (same(previous[field], next[field])) continue;
      const name = `#field${index}`;
      names[name] = field;
      if (next[field] === undefined) removals.push(name);
      else {
        const value = `:value${index}`;
        values[value] = next[field];
        assignments.push(`${name} = ${value}`);
      }
    }
    const input = {
      TableName: tableName,
      Key: keyFor(previous),
      ConditionExpression: conditions.join(' AND '),
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      UpdateExpression: `SET ${assignments.join(', ')}${removals.length ? ` REMOVE ${removals.join(', ')}` : ''}`,
      ReturnValues: 'ALL_NEW',
    };
    try {
      const response = await ddb.send(new UpdateCommand(input));
      const saved = validateJob(response?.Attributes, input.Key);
      if (!same(saved, next)) fail('unavailable');
      return { written: saved };
    } catch (error) {
      // SDK retries can see a conditional failure after an acknowledged-lost
      // write. Recover only our exact opaque revision and complete next state.
      const current = await read(input.Key);
      if (current && same(current, next)) return { written: current };
      if (error?.name === 'ConditionalCheckFailedException') return { current };
      fail('unavailable');
    }
  };
  const mutate = async (input, transform) => {
    const { key, leaseToken } = leaseInput(input);
    for (let attempt = 0; attempt < CAS_TRIES; attempt += 1) {
      const job = await read(key);
      const time = clock();
      requireLease(job, leaseToken, time);
      const fields = transform(job);
      if (fields === null) return job;
      const next = nextJob(job, time, fields);
      const outcome = await update(job, next, time, '>');
      if (outcome.written) {
        if (outcome.written.state === 'RUNNING') requireLease(outcome.written, leaseToken, clock());
        return outcome.written;
      }
    }
    fail('conflict');
  };

  return Object.freeze({
    async create(input) {
      const request = requestFor(input);
      const time = clock();
      const job = {
        schemaVersion: 1,
        ...request,
        requestDigest: requestDigest(request),
        state: 'QUEUED',
        attempts: 0,
        revision: randomUUID(),
        createdAt: time,
        updatedAt: time,
      };
      bounded(job);
      try {
        await ddb.send(
          new PutCommand({
            TableName: tableName,
            Item: job,
            ConditionExpression: 'attribute_not_exists(#project) AND attribute_not_exists(#job)',
            ExpressionAttributeNames: { '#project': 'projectId', '#job': 'jobId' },
          }),
        );
        return structuredClone(job);
      } catch {
        const current = await read(keyFor(request));
        if (!current) fail('unavailable');
        if (current.requestDigest !== job.requestDigest) fail('conflict');
        return current;
      }
    },

    get: async (input) => read(keyFor(input)),

    async claim(input) {
      const key = keyFor(input);
      for (let attempt = 0; attempt < CAS_TRIES; attempt += 1) {
        const job = await read(key);
        if (!job) return { kind: 'missing' };
        if (job.state === 'SUCCEEDED' || job.state === 'FAILED') return { kind: 'terminal', job };
        const time = clock();
        if (job.state === 'RUNNING' && job.leaseExpiresAt > time) return { kind: 'busy', job };
        const exhausted = job.attempts >= maxAttempts;
        const fields = exhausted
          ? { state: 'FAILED', errorCode: 'native_package_job_attempts_exhausted' }
          : {
              state: 'RUNNING',
              attempts: job.attempts + 1,
              leaseToken: randomUUID(),
              leaseExpiresAt: time + leaseMs,
            };
        const next = nextJob(job, time, fields);
        const outcome = await update(job, next, time, '<=');
        if (outcome.written) {
          if (exhausted) return { kind: 'terminal', job: outcome.written };
          requireLease(outcome.written, next.leaseToken, clock());
          return { kind: 'claimed', job: outcome.written };
        }
      }
      fail('conflict');
    },

    async assertLease(input) {
      const { key, leaseToken } = leaseInput(input);
      const job = await read(key);
      requireLease(job, leaseToken, clock());
      return job;
    },

    async saveCandidate(input) {
      const candidate = candidateFor(input?.candidate);
      const candidateDigest = hash(candidate);
      return mutate(input, (job) => {
        assertCandidateScope(candidate, job);
        if (job.candidate) {
          if (job.candidateDigest !== candidateDigest) fail('conflict');
          return null;
        }
        return { candidate, candidateDigest };
      });
    },

    async saveReceipt(input) {
      const archiveReceipt = receiptFor(input?.receipt);
      return mutate(input, (job) => {
        if (!job.candidate) fail('conflict');
        receiptFor(archiveReceipt, job.candidate.materializationId);
        if (job.archiveReceipt) {
          if (!same(job.archiveReceipt, archiveReceipt)) fail('conflict');
          return null;
        }
        return { archiveReceipt };
      });
    },

    async succeed(input) {
      return mutate(input, (job) => {
        if (!job.archiveReceipt) fail('conflict');
        return { state: 'SUCCEEDED' };
      });
    },

    async fail(input) {
      const errorCode = FAILURE_CODES.has(input?.code) ? input.code : 'native_package_job_failed';
      return mutate(input, () => ({ state: 'FAILED', errorCode }));
    },
  });
};
