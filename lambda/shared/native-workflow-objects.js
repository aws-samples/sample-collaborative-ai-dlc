import { GetObjectCommand, ListObjectVersionsCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { gunzipSync, gzipSync } from 'node:zlib';
import { canonicalJson } from './workflow-checkpoint.js';
import {
  engineDigest,
  engineFailure,
  nativeEngineObjectPrefix,
} from './native-workflow-protocol.js';

const MAX_COMPRESSED = 128 * 1024 * 1024;
const MAX_DECODED = 256 * 1024 * 1024;
const version = (value) =>
  typeof value === 'string' && value !== 'null' && /^[A-Za-z0-9._~+/=-]{1,1024}$/.test(value);
const requestUuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export const createNativeEngineObjects = ({ s3, bucket, accountId }) => {
  const readVersion = async ({ key, versionId, bytes, sha256 }) => {
    if (!version(versionId) || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_COMPRESSED)
      throw engineFailure('NATIVE_ENGINE_OBJECT_INVALID');
    const result = await s3.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        VersionId: versionId,
        ...(sha256 ? {} : { ChecksumMode: 'ENABLED' }),
        ExpectedBucketOwner: accountId,
      }),
      { abortSignal: AbortSignal.timeout(120_000) },
    );
    const chunks = [];
    let count = 0;
    try {
      if (result.VersionId !== versionId || result.ContentLength !== bytes)
        throw engineFailure('NATIVE_ENGINE_OBJECT_INVALID');
      for await (const chunk of result.Body) {
        count += chunk.length;
        if (count > bytes) throw engineFailure('NATIVE_ENGINE_OBJECT_INVALID');
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);
      const digest = engineDigest(body);
      if (
        count !== bytes ||
        (sha256
          ? digest !== sha256
          : Buffer.from(digest, 'hex').toString('base64') !== result.ChecksumSHA256)
      )
        throw engineFailure('NATIVE_ENGINE_OBJECT_INVALID');
      return {
        receipt: { key, versionId, bytes, sha256: digest },
        value: JSON.parse(gunzipSync(body, { maxOutputLength: MAX_DECODED }).toString('utf8')),
      };
    } catch {
      result.Body?.destroy?.();
      throw engineFailure('NATIVE_ENGINE_OBJECT_INVALID');
    }
  };
  const read = async (identity, receipt, purpose = 'state') => {
    const prefix = nativeEngineObjectPrefix(identity, purpose);
    if (
      !receipt?.key?.startsWith(prefix) ||
      !/^[a-f0-9-]{36}\/[a-z][a-z0-9-]{0,63}\.json\.gz$/.test(receipt.key.slice(prefix.length)) ||
      !/^[a-f0-9]{64}$/.test(receipt.sha256 ?? '')
    )
      throw engineFailure('NATIVE_ENGINE_OBJECT_INVALID');
    return (await readVersion(receipt)).value;
  };
  return {
    read,
    async observeOperationObject(identity, requestId, name) {
      if (!requestUuid.test(requestId) || !['result', 'snapshot'].includes(name))
        throw engineFailure();
      const purpose = name === 'result' ? 'output' : 'state';
      const key = `${nativeEngineObjectPrefix(identity, purpose)}${requestId}/${name}.json.gz`;
      // Only the admitted engine invocation writes this key. A successful
      // empty lookup distinguishes absence from a denied or interrupted read.
      const found = await s3.send(
        new ListObjectVersionsCommand({
          Bucket: bucket,
          Prefix: key,
          MaxKeys: 1,
          ExpectedBucketOwner: accountId,
        }),
        { abortSignal: AbortSignal.timeout(120_000) },
      );
      const latest = found.Versions?.[0];
      if (!latest && found.IsTruncated === false && !found.DeleteMarkers?.length) return null;
      if (latest?.Key !== key || latest.IsLatest !== true || found.DeleteMarkers?.length)
        throw engineFailure('NATIVE_ENGINE_OBJECT_INVALID');
      return readVersion({ key, versionId: latest.VersionId, bytes: latest.Size });
    },
    async observeJobResult(identity, jobId) {
      if (!requestUuid.test(jobId)) throw engineFailure();
      const key = `${nativeEngineObjectPrefix(identity, 'job')}${jobId}/result.json.gz`;
      const result = await s3.send(
        new GetObjectCommand({
          Bucket: bucket,
          Key: key,
          ExpectedBucketOwner: accountId,
        }),
        { abortSignal: AbortSignal.timeout(120_000) },
      );
      if (
        !version(result.VersionId) ||
        !Number.isSafeInteger(result.ContentLength) ||
        result.ContentLength < 1 ||
        result.ContentLength > 8 * 1024 * 1024
      )
        throw engineFailure('NATIVE_ENGINE_JOB_RESULT_INVALID');
      const chunks = [];
      let length = 0;
      try {
        for await (const chunk of result.Body) {
          length += chunk.length;
          if (length > result.ContentLength)
            throw engineFailure('NATIVE_ENGINE_JOB_RESULT_INVALID');
          chunks.push(chunk);
        }
        if (length !== result.ContentLength)
          throw engineFailure('NATIVE_ENGINE_JOB_RESULT_INVALID');
        const receipt = {
          key,
          versionId: result.VersionId,
          bytes: length,
          sha256: engineDigest(Buffer.concat(chunks)),
        };
        // The job can write only this object. Freeze one observed version and
        // read it by version before any engine verdict can consume it.
        return { receipt, value: await read(identity, receipt, 'job') };
      } finally {
        result.Body?.destroy?.();
      }
    },
    async write(identity, requestId, name, value, purpose = 'state') {
      if (!requestUuid.test(requestId) || !/^[a-z][a-z0-9-]{0,63}$/.test(name))
        throw engineFailure();
      const json = Buffer.from(canonicalJson(value));
      if (json.length > MAX_DECODED) throw engineFailure('NATIVE_ENGINE_OBJECT_LIMIT');
      const body = gzipSync(json);
      if (body.length > MAX_COMPRESSED) throw engineFailure('NATIVE_ENGINE_OBJECT_LIMIT');
      const key = `${nativeEngineObjectPrefix(identity, purpose)}${requestId}/${name}.json.gz`;
      const sha256 = engineDigest(body);
      const result = await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ExpectedBucketOwner: accountId,
          ContentType: 'application/gzip',
          ChecksumSHA256: Buffer.from(sha256, 'hex').toString('base64'),
          ServerSideEncryption: 'AES256',
        }),
        { abortSignal: AbortSignal.timeout(120_000) },
      );
      if (!version(result.VersionId)) throw engineFailure('NATIVE_ENGINE_OBJECT_INVALID');
      const receipt = { key, versionId: result.VersionId, sha256, bytes: body.length };
      // Persistence readback precedes the authority-table head commit.
      await read(identity, receipt, purpose);
      return receipt;
    },
  };
};
