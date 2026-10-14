// Generated download jobs only. These rows never change execution, publication,
// recovery, or completion authority. A lease fences duplicate artifact builders.
import { randomUUID } from 'node:crypto';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { nativeRuntimeBindingKey } from '../shared/native-runtime-binding.js';
import { canonicalJson } from '../shared/workflow-checkpoint.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA = /^[a-f0-9]{64}$/;
export const RESULT_LEASE_MS = 15 * 60 * 1000;
export const RESULT_MAX_BYTES = 260 * 1024 * 1024;
export const nativeResultArtifact = (result) => {
  if (
    !result ||
    typeof result !== 'object' ||
    Object.keys(result).toSorted().join(',') !== 'bytes,sha256,versionId' ||
    !SHA.test(result.sha256 ?? '') ||
    !Number.isSafeInteger(result.bytes) ||
    result.bytes < 0 ||
    result.bytes > RESULT_MAX_BYTES ||
    typeof result.versionId !== 'string' ||
    result.versionId === 'null' ||
    !/^[A-Za-z0-9._~+/=-]{1,1024}$/.test(result.versionId)
  )
    throw resultFailure('INVALID');
  return structuredClone(result);
};
export const resultFailure = (code = 'UNAVAILABLE') =>
  Object.assign(new Error('Native result could not be obtained'), {
    code: `NATIVE_RESULT_${code}`,
  });
export const nativeResultRequest = (input) => {
  const file = input?.fileId !== undefined;
  const keys = [
    'requestId',
    'publicationId',
    'publicationSequence',
    ...(file ? ['fileId', 'sha256'] : []),
  ];
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(input, key)) ||
    !UUID.test(input.requestId ?? '') ||
    !SHA.test(input.publicationId ?? '') ||
    !Number.isSafeInteger(input.publicationSequence) ||
    input.publicationSequence < 1 ||
    (file && (!/^nf-[a-f0-9]{64}$/.test(input.fileId) || !SHA.test(input.sha256 ?? '')))
  )
    throw resultFailure('INVALID');
  return structuredClone(input);
};
export const nativeResultQuery = (event) => {
  const single = event.queryStringParameters ?? {};
  const multi = event.multiValueQueryStringParameters ?? {};
  const query = { ...single };
  for (const [name, values] of Object.entries(multi)) {
    if (
      !Array.isArray(values) ||
      values.length !== 1 ||
      typeof values[0] !== 'string' ||
      (single[name] !== undefined && single[name] !== values[0])
    )
      throw resultFailure('INVALID');
    query[name] = values[0];
  }
  if (
    Object.values(query).some((v) => typeof v !== 'string') ||
    !/^[1-9][0-9]{0,15}$/.test(query.publicationSequence ?? '')
  )
    throw resultFailure('INVALID');
  return nativeResultRequest({ ...query, publicationSequence: Number(query.publicationSequence) });
};
const key = (scope, requestId) => {
  if (!UUID.test(requestId ?? '')) throw resultFailure('INVALID');
  return { ...nativeRuntimeBindingKey(scope), sk: `RESULT#${requestId}` };
};
const identity = (execution) => ({
  scope: execution.scope,
  bindingId: execution.bindingId,
  attemptId: execution.attemptId,
  configurationSha256: execution.configurationSha256,
});
const same = (a, b) => canonicalJson(a) === canonicalJson(b);
export const resultJobMatches = (job, execution, request) =>
  Boolean(execution) &&
  job?.schemaVersion === 1 &&
  same(job.identity, identity(execution)) &&
  same(job.request, request);

export const createNativeResultStore = ({ ddb, tableName, now = Date.now, uuid = randomUUID }) => {
  const get = async (scope, requestId) => {
    const { Item } = await ddb.send(
      new GetCommand({
        TableName: tableName,
        Key: key(scope, requestId),
        ConsistentRead: true,
      }),
    );
    return Item ?? null;
  };
  const put = async (row, previous = null) => {
    try {
      await ddb.send(
        new PutCommand({
          TableName: tableName,
          Item: row,
          ConditionExpression: previous ? '#version = :version' : 'attribute_not_exists(pk)',
          ...(previous
            ? {
                ExpressionAttributeNames: { '#version': 'version' },
                ExpressionAttributeValues: { ':version': previous.version },
              }
            : {}),
        }),
      );
      return row;
    } catch (error) {
      // Exact readback also covers a committed write with a lost acknowledgement.
      const current = await get(row.identity.scope, row.request.requestId);
      if (current && same(current, row)) return current;
      if (error.name === 'ConditionalCheckFailedException') return null;
      throw resultFailure();
    }
  };
  return Object.freeze({
    get,
    async request(execution, input) {
      const request = nativeResultRequest(input);
      const row = {
        ...key(execution.scope, request.requestId),
        schemaVersion: 1,
        identity: identity(execution),
        request,
        version: uuid(),
        status: 'pending',
        updatedAt: now(),
      };
      const created = await put(row);
      const current = created ?? (await get(execution.scope, request.requestId));
      if (!resultJobMatches(current, execution, request)) throw resultFailure('CONFLICT');
      return current;
    },
    async claim(scope, requestId) {
      const row = await get(scope, requestId);
      if (!row || row.status === 'ready' || (row.status === 'building' && row.leaseUntil > now()))
        return null;
      return put(
        {
          ...row,
          version: uuid(),
          status: 'building',
          leaseUntil: now() + RESULT_LEASE_MS,
          updatedAt: now(),
        },
        row,
      );
    },
    async rebuild(job) {
      if (job.status === 'building' && job.leaseUntil > now()) return job;
      const { artifact: _artifact, leaseUntil: _lease, ...base } = job;
      return (
        (await put(
          {
            ...base,
            status: 'pending',
            version: uuid(),
            updatedAt: now(),
          },
          job,
        )) ?? (await get(job.identity.scope, job.request.requestId))
      );
    },
    async finish(claim, result) {
      const row = await get(claim.identity.scope, claim.request.requestId);
      if (row?.version !== claim.version || row.status !== 'building' || row.leaseUntil <= now())
        return false;
      if (result) {
        result = nativeResultArtifact(result);
        if (row.request.fileId && result.sha256 !== row.request.sha256)
          throw resultFailure('INVALID');
      }
      const { leaseUntil: _lease, artifact: _artifact, ...base } = row;
      const next = {
        ...base,
        version: uuid(),
        updatedAt: now(),
        status: result ? 'ready' : 'failed',
        ...(result ? { artifact: result } : {}),
      };
      return Boolean(await put(next, row));
    },
  });
};
