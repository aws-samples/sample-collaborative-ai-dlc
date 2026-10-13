// Protected control-plane state. No runtime principal may access this table.
import { createHash, randomUUID } from 'node:crypto';
import { GetCommand, PutCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { nativeExecutionKey } from './execution-store.js';
import { nativeDraftPrompt, nativePromptRequest, promptFailure } from './draft-prompt.js';
import { canonicalJson } from '../shared/workflow-checkpoint.js';
import { describeNativePackagePin } from '../shared/native-package-pin.js';
import { describeNativePackageArchiveReceipt } from '../shared/native-package-archive.js';
import { workflowSourceIdentity } from '../shared/workflow-source-bindings.js';
import {
  nativeRuntimeBindingKey,
  nativeRuntimeResourceNames,
  resolveNativeRuntimeBinding,
} from '../shared/native-runtime-binding.js';

export const UUID_V4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,255}$/;
const SHA = /^sha256:[a-f0-9]{64}$/;
export const matches = (value, pattern) =>
  typeof value === 'string' && pattern.exec(value)?.[0] === value;
export const record = (value) =>
  value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
const integer = (value, min = 0) => Number.isSafeInteger(value) && value >= min;
const hasControls = (value) =>
  [...value].some((character) => character.codePointAt(0) < 32 || character === '\x7f');
const same = (a, b) => canonicalJson(a) === canonicalJson(b);
const hash = (value) => `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
const MESSAGES = {
  NATIVE_PREPARATION_INVALID: 'Invalid native preparation request',
  NATIVE_PREPARATION_CONFLICT: 'Native intent changed or its immutable request conflicts',
  NATIVE_PREPARATION_NOT_FOUND: 'Native intent not found',
  NATIVE_PREPARATION_UNAVAILABLE: 'Native preparation is unavailable',
  NATIVE_PREPARATION_LEASE_LOST: 'Native preparation ownership changed',
  NATIVE_PREPARATION_PACKAGE_INVALID: 'A matching completed package import is required',
  NATIVE_PREPARATION_FORBIDDEN: 'Native intent access denied',
};
export class NativePreparationError extends Error {
  constructor(code = 'NATIVE_PREPARATION_INVALID') {
    const safe = Object.hasOwn(MESSAGES, code) ? code : 'NATIVE_PREPARATION_INVALID';
    super(MESSAGES[safe]);
    this.code = safe;
  }
}
export const fail = (suffix) => {
  throw new NativePreparationError(`NATIVE_PREPARATION_${suffix}`);
};
const REQUEST_FIELDS = [
  'intentId',
  'title',
  'prompt',
  'harness',
  'sourceId',
  'packageJobId',
  'bindingRevision',
];
export const nativeDraftRequest = (value) => {
  if (
    !record(value) ||
    Object.keys(value).length !== REQUEST_FIELDS.length ||
    !REQUEST_FIELDS.every((key) => Object.hasOwn(value, key)) ||
    !matches(value.intentId, UUID_V4) ||
    !matches(value.sourceId, /^[a-f0-9]{64}$/) ||
    !matches(value.packageJobId, UUID) ||
    !matches(value.bindingRevision, UUID) ||
    !['claude', 'codex', 'kiro', 'opencode'].includes(value.harness) ||
    typeof value.title !== 'string' ||
    Buffer.byteLength(value.title) > 256 ||
    hasControls(value.title) ||
    typeof value.prompt !== 'string' ||
    (!value.title.trim() && !value.prompt.trim()) ||
    Buffer.byteLength(value.prompt) > 65536 ||
    value.prompt.includes('\0')
  )
    fail('INVALID');
  return Object.fromEntries(REQUEST_FIELDS.map((key) => [key, value[key]]));
};
const scope = (value) => {
  if (!matches(value?.projectId, ID) || !matches(value?.executionId, UUID_V4)) fail('INVALID');
  return { projectId: value.projectId, executionId: value.executionId };
};
const graphId = (value) =>
  typeof value === 'string' &&
  value.trim() === value &&
  value.length > 0 &&
  Buffer.byteLength(value) <= 1024 &&
  !hasControls(value);
const fingerprint = (row) =>
  hash({
    projectId: row.projectId,
    actorId: row.createdBy,
    projectIdentity: row.projectIdentity,
    request: row.request,
  });

export const pinPackageJob = (job, { projectId, request, binding }) => {
  try {
    if (
      job?.state !== 'SUCCEEDED' ||
      job.projectId !== projectId ||
      job.jobId !== request.packageJobId ||
      job.sourceId !== request.sourceId ||
      job.bindingRevision !== request.bindingRevision ||
      binding.projectId !== projectId ||
      binding.sourceId !== request.sourceId ||
      binding.revision !== request.bindingRevision
    )
      fail('PACKAGE_INVALID');
    const candidate = job.candidate;
    const pin = describeNativePackagePin(candidate.packagePin, candidate.attestation);
    const source = workflowSourceIdentity(binding.provider, binding.repository);
    if (
      candidate.schemaVersion !== 1 ||
      candidate.projectId !== projectId ||
      candidate.sourceId !== request.sourceId ||
      candidate.bindingRevision !== request.bindingRevision ||
      candidate.requestedRelease !== job.requestedRelease ||
      candidate.materializationId !== pin.materializationId ||
      source.sourceId !== request.sourceId ||
      pin.identity.source.provider !== source.provider ||
      pin.identity.source.repository !== source.repository ||
      (candidate.requestedRelease === 'latest'
        ? pin.identity.version.includes('-preview.')
        : candidate.requestedRelease !== pin.identity.source.release) ||
      !pin.identity.harnesses.includes(request.harness)
    )
      fail('PACKAGE_INVALID');
    return {
      candidate: {
        schemaVersion: 1,
        projectId,
        sourceId: request.sourceId,
        bindingRevision: request.bindingRevision,
        requestedRelease: candidate.requestedRelease,
        packagePin: { ...pin.identity, packageId: pin.packageId },
        attestation: pin.attestation,
        materializationId: pin.materializationId,
      },
      archiveReceipt: describeNativePackageArchiveReceipt(
        job.archiveReceipt,
        pin.materializationId,
      ),
    };
  } catch {
    fail('PACKAGE_INVALID');
  }
};

const RESOURCE_FIELDS = [
  'executionRoleArn',
  'accessPointArn',
  'fileSystemId',
  'rootDirectory',
  'mountPath',
  'runtimeArn',
  'runtimeId',
  'runtimeVersion',
  'runtimeEndpoint',
  'runtimeEndpointArn',
];
const FAILURE_CODES = new Set([
  'native_provisioning_failed',
  'native_provisioning_configuration_invalid',
  'native_provisioning_access_denied',
  'native_provisioning_resource_mismatch',
  'native_provisioning_verification_failed',
  'native_provisioning_source_changed',
]);

export const createNativeRuntimeStore = ({
  ddb,
  tableName = process.env.NATIVE_RUNTIME_BINDINGS_TABLE,
  deployment,
  now = Date.now,
  leaseMs = 120000,
} = {}) => {
  if (
    !ddb?.send ||
    !matches(tableName, /^[A-Za-z0-9_.-]{3,255}$/) ||
    !matches(deployment?.accountId, /^[0-9]{12}$/) ||
    !matches(deployment?.region, /^[a-z0-9-]+$/) ||
    !matches(deployment?.partition, /^aws(?:-[a-z]+)*$/) ||
    !matches(deployment?.fileSystemId, /^fs-[a-f0-9]{8}(?:[a-f0-9]{9})?$/) ||
    !integer(leaseMs, 1) ||
    leaseMs > 3600000
  )
    fail('UNAVAILABLE');
  const clock = () => {
    const time = now();
    if (!integer(time) || !integer(time + leaseMs) || time + leaseMs > 8640000000000000)
      fail('UNAVAILABLE');
    return time;
  };
  const resourcePatch = (row, patch) => {
    if (!record(patch) || Object.keys(patch).some((key) => !RESOURCE_FIELDS.includes(key)))
      fail('INVALID');
    const names = nativeRuntimeResourceNames(row);
    const prefix = `arn:${deployment?.partition ?? 'aws'}`;
    const regionAccount = `${deployment?.region}:${deployment?.accountId}`;
    const expected = {
      executionRoleArn: `${prefix}:iam::${deployment?.accountId}:role/native-runs/${names.roleName}`,
      fileSystemId: deployment?.fileSystemId,
      rootDirectory: names.rootDirectory,
      mountPath: '/mnt/native',
      runtimeEndpoint: names.endpointName,
    };
    for (const [key, value] of Object.entries(patch)) {
      if (Object.hasOwn(expected, key)) {
        if (value !== expected[key] || typeof value !== 'string') fail('INVALID');
      } else if (key === 'accessPointArn') {
        if (
          !matches(
            value,
            new RegExp(
              `^${prefix}:elasticfilesystem:${regionAccount}:access-point/fsap-[0-9a-f]{17}$`,
            ),
          )
        )
          fail('INVALID');
      } else if (key === 'runtimeVersion') {
        if (!matches(value, /^[1-9][0-9]*$/)) fail('INVALID');
      } else if (key === 'runtimeId') {
        if (!matches(value, new RegExp(`^${names.runtimeName}-[A-Za-z0-9]+$`))) fail('INVALID');
      } else if (key === 'runtimeArn') {
        if (
          !matches(
            value,
            new RegExp(
              `^${prefix}:bedrock-agentcore:${regionAccount}:runtime/${names.runtimeName}-[A-Za-z0-9]+$`,
            ),
          )
        )
          fail('INVALID');
      } else if (key === 'runtimeEndpointArn') {
        if (
          !matches(
            value,
            new RegExp(
              `^${prefix}:bedrock-agentcore:${regionAccount}:runtime/${names.runtimeName}-[A-Za-z0-9]+/runtime-endpoint/${names.endpointName}$`,
            ),
          )
        )
          fail('INVALID');
      }
      if (row[key] !== undefined && row[key] !== value) fail('CONFLICT');
    }
    const combined = { ...row, ...patch };
    if (
      combined.runtimeId &&
      combined.runtimeArn &&
      !combined.runtimeArn.endsWith(`/${combined.runtimeId}`)
    )
      fail('INVALID');
    if (
      combined.runtimeEndpointArn &&
      combined.runtimeArn &&
      combined.runtimeEndpointArn !==
        `${combined.runtimeArn}/runtime-endpoint/${names.endpointName}`
    )
      fail('INVALID');
    return structuredClone(patch);
  };
  const validate = async (row, identity) => {
    try {
      if (
        !record(row) ||
        Buffer.byteLength(JSON.stringify(row)) > (row.promptDraft ? 256 : 128) * 1024
      )
        fail('INVALID');
      nativeDraftPrompt(row);
      const bindingKey = nativeRuntimeBindingKey(identity);
      const request = nativeDraftRequest(row.request);
      if (
        row.pk !== bindingKey.pk ||
        row.sk !== bindingKey.sk ||
        row.projectId !== identity.projectId ||
        row.executionId !== identity.executionId ||
        request.intentId !== identity.executionId ||
        row.schemaVersion !== 1 ||
        row.executionBackend !== 'native' ||
        row.isolation !== 'execution' ||
        !matches(row.bindingId, UUID_V4) ||
        !matches(row.createdBy, ID) ||
        !graphId(row.projectIdentity) ||
        row.requestFingerprint !== fingerprint(row) ||
        row.harness !== request.harness ||
        !integer(row.version, 1) ||
        !integer(row.fence) ||
        !integer(row.createdAt) ||
        !integer(row.updatedAt) ||
        row.updatedAt < row.createdAt ||
        row.updatedAt > 8640000000000000 ||
        !['DRAFT', 'PREPARING', 'READY', 'FAILED'].includes(row.status) ||
        !matches(row.imageDigest, SHA) ||
        !matches(
          row.imageUri,
          /^[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com(?:\.cn)?\/[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$/,
        ) ||
        !row.imageUri.endsWith(`@${row.imageDigest}`)
      )
        fail('INVALID');
      const pin = describeNativePackagePin(row.candidate.packagePin, row.candidate.attestation);
      const pins = pinPackageJob(
        {
          state: 'SUCCEEDED',
          projectId: row.projectId,
          jobId: request.packageJobId,
          sourceId: request.sourceId,
          bindingRevision: request.bindingRevision,
          requestedRelease: row.candidate.requestedRelease,
          candidate: row.candidate,
          archiveReceipt: row.archiveReceipt,
        },
        {
          projectId: row.projectId,
          request,
          binding: {
            projectId: row.projectId,
            sourceId: request.sourceId,
            revision: request.bindingRevision,
            ...pin.identity.source,
          },
        },
      );
      if (!same(pins.candidate, row.candidate) || !same(pins.archiveReceipt, row.archiveReceipt))
        fail('INVALID');
      const resources = Object.fromEntries(
        RESOURCE_FIELDS.filter((key) => Object.hasOwn(row, key)).map((key) => [key, row[key]]),
      );
      resourcePatch(row, resources);
      if (row.leaseToken !== undefined || row.leaseExpiresAt !== undefined) {
        if (
          row.status !== 'PREPARING' ||
          !matches(row.leaseToken, UUID_V4) ||
          !integer(row.leaseExpiresAt, 1) ||
          row.fence < 1
        )
          fail('INVALID');
      }
      if (row.status === 'DRAFT' && (row.fence !== 0 || Object.keys(resources).length))
        fail('INVALID');
      if (
        row.status === 'FAILED'
          ? !FAILURE_CODES.has(row.failureCode)
          : row.failureCode !== undefined
      )
        fail('INVALID');
      if (row.status === 'READY') {
        // Reuse the dispatch reader's full tuple validation. Its fake port here
        // validates this prospective row only; it performs no AWS verification.
        await resolveNativeRuntimeBinding({
          ddb: { send: async () => ({ Item: row }) },
          tableName,
          ...identity,
          deployment,
        });
      }
      return structuredClone(row);
    } catch {
      fail('INVALID');
    }
  };
  const get = async (input) => {
    const identity = scope(input);
    let result;
    try {
      result = await ddb.send(
        new GetCommand({
          TableName: tableName,
          Key: nativeRuntimeBindingKey(identity),
          ConsistentRead: true,
        }),
      );
    } catch {
      fail('UNAVAILABLE');
    }
    if (!record(result)) fail('UNAVAILABLE');
    return result.Item === undefined ? null : validate(result.Item, identity);
  };
  const write = async (before, fields, lease = null) => {
    const time = clock();
    if (time < before.updatedAt) fail('UNAVAILABLE');
    const next = { ...before, ...fields, version: before.version + 1, updatedAt: time };
    if (next.status !== 'PREPARING' || lease === 'release') {
      delete next.leaseToken;
      delete next.leaseExpiresAt;
    }
    if (next.status !== 'FAILED') delete next.failureCode;
    await validate(next, scope(next));
    const names = {
      '#v': 'version',
      '#b': 'bindingId',
      '#s': 'status',
      '#f': 'fence',
      '#r': 'requestFingerprint',
    };
    const values = {
      ':v': before.version,
      ':b': before.bindingId,
      ':s': before.status,
      ':f': before.fence,
      ':r': before.requestFingerprint,
    };
    const conditions = ['#v = :v', '#b = :b', '#s = :s', '#f = :f', '#r = :r'];
    if (before.leaseToken) {
      names['#l'] = 'leaseToken';
      names['#e'] = 'leaseExpiresAt';
      values[':l'] = before.leaseToken;
      values[':e'] = before.leaseExpiresAt;
      values[':now'] = time;
      conditions.push('#l = :l', '#e = :e', `#e ${lease === 'expired' ? '<=' : '>'} :now`);
      if (lease !== 'expired' && before.leaseExpiresAt <= time) fail('LEASE_LOST');
    }
    try {
      await ddb.send(
        new PutCommand({
          TableName: tableName,
          Item: next,
          ConditionExpression: conditions.join(' AND '),
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
        }),
      );
      return structuredClone(next);
    } catch (error) {
      // Recover an acknowledged-lost write only if the complete committed row
      // matches ours. A newer owner's version must never be mistaken for ours.
      const current = await get(scope(before));
      if (current && same(current, next)) return current;
      if (error?.name === 'ConditionalCheckFailedException') fail('CONFLICT');
      fail('UNAVAILABLE');
    }
  };
  const owned = async (input) => {
    const row = await get(input);
    if (!row) fail('NOT_FOUND');
    if (
      row.status !== 'PREPARING' ||
      row.bindingId !== input.bindingId ||
      row.version !== input.version ||
      row.fence !== input.fence ||
      row.leaseToken !== input.leaseToken ||
      row.leaseExpiresAt <= clock() ||
      !matches(input.leaseToken, UUID_V4)
    )
      fail('LEASE_LOST');
    return row;
  };
  const promptReceipt = async (identity, actorId, projectIdentity, request) => {
    let result;
    try {
      result = await ddb.send(
        new GetCommand({
          TableName: tableName,
          Key: { ...nativeRuntimeBindingKey(identity), sk: `PROMPT#${request.requestId}` },
          ConsistentRead: true,
        }),
      );
    } catch {
      promptFailure('UNAVAILABLE');
    }
    if (!record(result)) promptFailure('UNAVAILABLE');
    if (result.Item === undefined) return null;
    const receipt = result.Item;
    if (
      receipt.schemaVersion !== 1 ||
      receipt.actorId !== actorId ||
      receipt.projectIdentity !== projectIdentity ||
      !same(receipt.request, request) ||
      receipt.revision !== request.expectedRevision + 1
    )
      promptFailure('CONFLICT');
    return { requestId: request.requestId, revision: receipt.revision, prompt: request.prompt };
  };
  const savePrompt = async ({ projectId, executionId, actorId, projectIdentity, request: raw }) => {
    const identity = scope({ projectId, executionId });
    const request = nativePromptRequest(raw);
    if (!matches(actorId, ID) || !graphId(projectIdentity)) fail('INVALID');
    const before = await get(identity);
    if (!before) fail('NOT_FOUND');
    if (before.projectIdentity !== projectIdentity) fail('FORBIDDEN');
    const prior = await promptReceipt(identity, actorId, projectIdentity, request);
    if (prior) return { row: before, promptAcceptance: prior };
    if (nativeDraftPrompt(before).revision !== request.expectedRevision) promptFailure('CONFLICT');
    const time = clock();
    if (time < before.updatedAt) fail('UNAVAILABLE');
    const next = {
      ...before,
      version: before.version + 1,
      updatedAt: time,
      promptDraft: { text: request.prompt, revision: request.expectedRevision + 1 },
    };
    await validate(next, identity);
    try {
      await ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              ConditionCheck: {
                TableName: tableName,
                Key: nativeExecutionKey(identity),
                ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
              },
            },
            {
              Put: {
                TableName: tableName,
                Item: next,
                ConditionExpression:
                  '#version = :version AND #binding = :binding AND #fingerprint = :fingerprint',
                ExpressionAttributeNames: {
                  '#version': 'version',
                  '#binding': 'bindingId',
                  '#fingerprint': 'requestFingerprint',
                },
                ExpressionAttributeValues: {
                  ':version': before.version,
                  ':binding': before.bindingId,
                  ':fingerprint': before.requestFingerprint,
                },
              },
            },
            {
              Put: {
                TableName: tableName,
                Item: {
                  ...nativeRuntimeBindingKey(identity),
                  sk: `PROMPT#${request.requestId}`,
                  schemaVersion: 1,
                  actorId,
                  projectIdentity,
                  request,
                  revision: next.promptDraft.revision,
                },
                ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
              },
            },
          ],
        }),
      );
    } catch (error) {
      const accepted = await promptReceipt(identity, actorId, projectIdentity, request);
      if (accepted) return { row: await get(identity), promptAcceptance: accepted };
      if (
        error?.name === 'TransactionCanceledException' &&
        error.CancellationReasons?.some((reason) => reason.Code === 'ConditionalCheckFailed')
      )
        promptFailure('CONFLICT');
      promptFailure('UNAVAILABLE');
    }
    return {
      row: next,
      promptAcceptance: {
        requestId: request.requestId,
        revision: next.promptDraft.revision,
        prompt: request.prompt,
      },
    };
  };
  return Object.freeze({
    get,
    savePrompt,
    async create({
      projectId,
      actorId,
      projectIdentity,
      request: raw,
      candidate,
      archiveReceipt,
      image,
    }) {
      const request = nativeDraftRequest(raw);
      const identity = scope({ projectId, executionId: request.intentId });
      const time = clock();
      const row = {
        ...nativeRuntimeBindingKey(identity),
        ...identity,
        schemaVersion: 1,
        executionBackend: 'native',
        isolation: 'execution',
        bindingId: randomUUID(),
        createdBy: actorId,
        projectIdentity,
        request,
        harness: request.harness,
        candidate: structuredClone(candidate),
        archiveReceipt: structuredClone(archiveReceipt),
        imageUri: image?.uri,
        imageDigest: image?.digest,
        status: 'DRAFT',
        version: 1,
        fence: 0,
        createdAt: time,
        updatedAt: time,
      };
      row.requestFingerprint = fingerprint(row);
      await validate(row, identity);
      try {
        await ddb.send(
          new PutCommand({
            TableName: tableName,
            Item: row,
            ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
          }),
        );
        return { row, created: true };
      } catch {
        const current = await get(identity);
        if (!current) fail('UNAVAILABLE');
        if (
          current.requestFingerprint !== row.requestFingerprint ||
          !same(current.candidate, candidate) ||
          !same(current.archiveReceipt, archiveReceipt)
        )
          fail('CONFLICT');
        return { row: current, created: false };
      }
    },
    async prepare(input) {
      for (let retry = 0; retry < 4; retry += 1) {
        const row = await get(input);
        if (!row) fail('NOT_FOUND');
        if (row.status === 'PREPARING' || row.status === 'READY') return row;
        if (row.status !== 'DRAFT' && row.status !== 'FAILED') fail('CONFLICT');
        try {
          return await write(row, { status: 'PREPARING' });
        } catch (error) {
          if (error.code !== 'NATIVE_PREPARATION_CONFLICT') throw error;
        }
      }
      fail('CONFLICT');
    },
    async claim(input) {
      const row = await get(input);
      if (!row) return { kind: 'missing' };
      if (row.bindingId !== input.bindingId) fail('CONFLICT');
      if (row.status === 'READY' || row.status === 'FAILED') return { kind: 'terminal', row };
      if (row.status !== 'PREPARING') fail('CONFLICT');
      const time = clock();
      if (row.leaseToken && row.leaseExpiresAt > time) return { kind: 'busy', row };
      const claimed = await write(
        row,
        {
          leaseToken: randomUUID(),
          leaseExpiresAt: time + leaseMs,
          fence: row.fence + 1,
        },
        'expired',
      );
      return { kind: 'claimed', row: claimed };
    },
    async advance(input) {
      const row = await owned(input);
      return write(row, { ...resourcePatch(row, input.patch), leaseExpiresAt: clock() + leaseMs });
    },
    async release(input) {
      // A completed readiness pass may yield early, but only its current
      // owner can release the lease. Resource pins and the fence are retained;
      // the next claim increments the fence before doing any further work.
      const row = await owned(input);
      return write(row, {}, 'release');
    },
    async fail(input) {
      const row = await owned(input);
      return write(row, {
        status: 'FAILED',
        failureCode: FAILURE_CODES.has(input.code) ? input.code : 'native_provisioning_failed',
      });
    },
    async ready(input) {
      const row = await owned(input);
      // Only a trusted provisioner may call this after independent AWS checks.
      // An HTTP or agent-supplied proof is not accepted by the API.
      return write(row, { ...resourcePatch(row, input.resources), status: 'READY' });
    },
  });
};
