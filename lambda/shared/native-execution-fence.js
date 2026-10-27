// Controller-owned writer/cancellation fence, outside runtime-writable prefixes.
// A delayed invocation must read the latest generation before starting a model.
// CANCELLED is irreversible. A FENCED generation can only admit its successor
// after the controller has positively stopped the old AgentCore session.
import { createHash } from 'node:crypto';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { canonicalJson } from './workflow-checkpoint.js';
import { nativePublicationScope } from './native-publication.js';
import { NATIVE_WORKSPACE_RECOVERY } from './native-recovery-mode.js';

const keys = ['projectId', 'executionId', 'bindingId', 'attemptId', 'runtimeSessionId'];
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA = /^[a-f0-9]{64}$/;
const REASONS = [
  'SESSION_LOST',
  'RESTORE_FAILED',
  'CHECKPOINT_UNAVAILABLE',
  'DELIVERY_UNCERTAIN',
  'WORKSPACE_UNAVAILABLE',
  'INTAKE_UNAVAILABLE',
  'WORKFLOW_STATE_UNAVAILABLE',
];
const WORKFLOW_RESUME_STATES = ['created', 'not_created', 'unavailable'];
const integer = (value) => Number.isSafeInteger(value) && value >= 1;
const generation = (record) => record.writerGeneration ?? 1;
const precondition = (error) =>
  ['PreconditionFailed', 'ConditionalRequestConflict'].includes(error?.name) ||
  [409, 412].includes(error?.$metadata?.httpStatusCode);
const absent = (error) => ['NoSuchKey', 'NotFound'].includes(error?.name);
const fail = (code = 'NATIVE_EXECUTION_FENCE_INVALID') => {
  throw Object.assign(new Error(code), { code });
};
const scope = (identity) => {
  nativePublicationScope(identity);
  if (
    keys.some(
      (key) =>
        typeof identity[key] !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(identity[key]),
    )
  )
    fail();
  return Object.fromEntries(keys.map((key) => [key, identity[key]]));
};
export const nativeExecutionFenceKey = (identity) => {
  const value = scope(identity);
  const hash = createHash('sha256')
    .update(
      canonicalJson({
        projectId: value.projectId,
        executionId: value.executionId,
      }),
    )
    .digest('hex');
  return `native-execution-control/v1/${hash}/${value.attemptId}/state.json`;
};
export const createNativeExecutionFence = ({ s3, bucket, accountId }) => {
  if (
    !s3?.send ||
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket ?? '') ||
    !/^[0-9]{12}$/.test(accountId ?? '')
  )
    fail();
  const parameters = (identity) => ({
    Bucket: bucket,
    Key: nativeExecutionFenceKey(identity),
    ExpectedBucketOwner: accountId,
  });
  const readVersion = async (identity) => {
    const expected = scope(identity);
    const result = await s3.send(new GetObjectCommand(parameters(identity)), {
      abortSignal: AbortSignal.timeout(10000),
    });
    try {
      if (
        !result.VersionId ||
        result.VersionId === 'null' ||
        !Number.isSafeInteger(result.ContentLength) ||
        result.ContentLength < 1 ||
        result.ContentLength > 2048
      )
        fail();
      const chunks = [];
      let size = 0;
      for await (const chunk of result.Body) {
        size += chunk.length;
        if (size > 2048) fail();
        chunks.push(Buffer.from(chunk));
      }
      if (size !== result.ContentLength) fail();
      const record = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
      );
      if (!record || keys.some((key) => record[key] !== expected[key])) fail();
      const fields = [...keys, 'schemaVersion', 'state'];
      if (record.schemaVersion === 1) {
        if (!['ACTIVE', 'CANCELLED'].includes(record.state)) fail();
      } else if ([2, 3].includes(record.schemaVersion)) {
        fields.push('writerGeneration', 'recoveryId', 'checkpointId', 'reason');
        if (Object.hasOwn(record, 'workflowResumeState')) {
          fields.push('workflowResumeState');
          if (
            record.state !== 'FENCED' ||
            !WORKFLOW_RESUME_STATES.includes(record.workflowResumeState)
          )
            fail();
        }
        if (record.schemaVersion === 3) {
          fields.push('recoveryMode');
          if (record.recoveryMode !== NATIVE_WORKSPACE_RECOVERY) fail();
        }
        if (
          !integer(record.writerGeneration) ||
          !['ACTIVE', 'FENCED', 'CANCELLED'].includes(record.state) ||
          !(
            record.recoveryId === null ||
            (typeof record.recoveryId === 'string' && UUID.test(record.recoveryId))
          ) ||
          !(
            record.checkpointId === null ||
            (typeof record.checkpointId === 'string' && SHA.test(record.checkpointId))
          ) ||
          !(record.reason === null || REASONS.includes(record.reason)) ||
          (record.state === 'FENCED' && record.recoveryId === null) ||
          (record.state === 'FENCED' && record.reason === null) ||
          (record.state === 'FENCED' && record.checkpointId !== null) ||
          (record.state === 'ACTIVE' &&
            (record.writerGeneration === 1
              ? record.recoveryId !== null || record.checkpointId !== null || record.reason !== null
              : record.recoveryId === null ||
                (record.schemaVersion === 3
                  ? record.checkpointId !== null
                  : record.checkpointId === null) ||
                record.reason === null))
        )
          fail();
      } else fail();
      if (Object.keys(record).toSorted().join(',') !== fields.toSorted().join(',')) fail();
      return { record, etag: result.ETag };
    } catch (error) {
      if (error?.code === 'NATIVE_EXECUTION_FENCE_INVALID') throw error;
      fail();
    } finally {
      result.Body?.destroy?.();
    }
  };
  const read = async (identity) => (await readVersion(identity)).record;
  const put = async (identity, record, previous) => {
    if (previous && (typeof previous.etag !== 'string' || !/^"[^"\r\n]+"$/.test(previous.etag)))
      fail();
    const body = Buffer.from(
      canonicalJson({ schemaVersion: record.recoveryMode ? 3 : 2, ...scope(identity), ...record }),
    );
    const result = await s3.send(
      new PutObjectCommand({
        ...parameters(identity),
        Body: body,
        ContentType: 'application/json',
        ChecksumSHA256: createHash('sha256').update(body).digest('base64'),
        ...(previous ? { IfMatch: previous.etag } : { IfNoneMatch: '*' }),
      }),
      { abortSignal: AbortSignal.timeout(10000) },
    );
    if (!result.VersionId || result.VersionId === 'null') fail();
  };
  const conflict = () => fail('NATIVE_EXECUTION_FENCE_CONFLICT');
  const transition = async (identity, update) => {
    for (let retry = 0; retry < 4; retry++) {
      let previous;
      try {
        previous = await readVersion(identity);
      } catch (error) {
        if (!absent(error)) throw error;
      }
      const next = update(previous?.record);
      if (!next) return previous.record;
      try {
        await put(identity, next, previous);
      } catch (error) {
        if (precondition(error)) continue;
        throw error;
      }
      // Read latest, never our own stale version; cancellation or a competing
      // transition that won after Put must be observed before returning.
      const latest = await readVersion(identity);
      if (
        canonicalJson(latest.record) ===
        canonicalJson({
          schemaVersion: next.recoveryMode ? 3 : 2,
          ...scope(identity),
          ...next,
        })
      )
        return latest.record;
      if (latest.record.state === 'CANCELLED') fail('NATIVE_EXECUTION_CANCELLED');
    }
    conflict();
  };
  return Object.freeze({
    read,
    async ensureActive(identity, { writerGeneration = 1 } = {}) {
      if (!integer(writerGeneration)) fail();
      return transition(identity, (record) => {
        if (record?.state === 'CANCELLED') fail('NATIVE_EXECUTION_CANCELLED');
        if (record) {
          if (record.state !== 'ACTIVE' || generation(record) !== writerGeneration) conflict();
          return null;
        }
        if (writerGeneration !== 1) conflict();
        return {
          state: 'ACTIVE',
          writerGeneration: 1,
          recoveryId: null,
          checkpointId: null,
          reason: null,
        };
      });
    },
    async cancel(identity) {
      return transition(identity, (record) =>
        record?.state === 'CANCELLED'
          ? null
          : {
              state: 'CANCELLED',
              writerGeneration: record ? generation(record) : 1,
              recoveryId: record?.recoveryId ?? null,
              checkpointId: record?.checkpointId ?? null,
              reason: record?.reason ?? null,
              ...(record?.recoveryMode ? { recoveryMode: record.recoveryMode } : {}),
            },
      );
    },
    async suspend(
      identity,
      { writerGeneration, recoveryId, reason = 'SESSION_LOST', workflowResumeState },
    ) {
      if (
        !integer(writerGeneration) ||
        typeof recoveryId !== 'string' ||
        !UUID.test(recoveryId) ||
        !REASONS.includes(reason) ||
        (workflowResumeState !== undefined && !WORKFLOW_RESUME_STATES.includes(workflowResumeState))
      )
        fail();
      return transition(identity, (record) => {
        if (record?.state === 'CANCELLED') fail('NATIVE_EXECUTION_CANCELLED');
        if (!record || generation(record) !== writerGeneration) conflict();
        if (record.state === 'FENCED') {
          if (record.recoveryId === recoveryId) {
            if (record.reason !== reason || record.workflowResumeState !== workflowResumeState)
              conflict();
            return null;
          }
          // Only the controller can start another stopped-writer episode.
          // Remaining FENCED invalidates the old activation CAS/token without
          // ever admitting the predecessor or incrementing its generation.
        }
        if (!['ACTIVE', 'FENCED'].includes(record.state)) conflict();
        return {
          state: 'FENCED',
          writerGeneration,
          recoveryId,
          checkpointId: null,
          reason,
          ...(workflowResumeState === undefined ? {} : { workflowResumeState }),
          ...(record.recoveryMode ? { recoveryMode: record.recoveryMode } : {}),
        };
      });
    },
    async activate(identity, { writerGeneration, recoveryId, checkpointId, recoveryMode }) {
      const workspace = recoveryMode === NATIVE_WORKSPACE_RECOVERY;
      if (
        !integer(writerGeneration) ||
        writerGeneration === 1 ||
        typeof recoveryId !== 'string' ||
        !UUID.test(recoveryId) ||
        (recoveryMode !== undefined && !workspace) ||
        (workspace
          ? checkpointId !== null
          : typeof checkpointId !== 'string' || !SHA.test(checkpointId))
      )
        fail();
      return transition(identity, (record) => {
        if (record?.state === 'CANCELLED') fail('NATIVE_EXECUTION_CANCELLED');
        if (
          record?.state === 'ACTIVE' &&
          record.writerGeneration === writerGeneration &&
          record.recoveryId === recoveryId &&
          record.checkpointId === checkpointId &&
          record.recoveryMode === recoveryMode
        )
          return null;
        if (
          record?.state !== 'FENCED' ||
          record.writerGeneration !== writerGeneration - 1 ||
          record.recoveryId !== recoveryId ||
          (workspace && record.workflowResumeState !== 'created') ||
          (!workspace && record.workflowResumeState !== undefined) ||
          (record.recoveryMode !== undefined && record.recoveryMode !== recoveryMode)
        )
          conflict();
        return {
          state: 'ACTIVE',
          writerGeneration,
          recoveryId,
          checkpointId,
          reason: record.reason,
          ...(workspace ? { recoveryMode } : {}),
        };
      });
    },
  });
};
