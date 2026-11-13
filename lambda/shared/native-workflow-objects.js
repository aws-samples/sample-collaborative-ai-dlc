import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
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

export const createNativeEngineObjects = ({ s3, bucket, accountId }) => {
  const read = async (identity, receipt, purpose = 'state') => {
    const prefix = nativeEngineObjectPrefix(identity, purpose);
    if (
      !receipt ||
      !receipt.key?.startsWith(prefix) ||
      !/^[a-f0-9-]{36}\/[a-z][a-z0-9-]{0,63}\.json\.gz$/.test(receipt.key.slice(prefix.length)) ||
      !version(receipt.versionId) ||
      !/^[a-f0-9]{64}$/.test(receipt.sha256 ?? '') ||
      !Number.isSafeInteger(receipt.bytes) ||
      receipt.bytes < 1 ||
      receipt.bytes > MAX_COMPRESSED
    )
      throw engineFailure('NATIVE_ENGINE_OBJECT_INVALID');
    const result = await s3.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: receipt.key,
        VersionId: receipt.versionId,
        ExpectedBucketOwner: accountId,
      }),
      { abortSignal: AbortSignal.timeout(120_000) },
    );
    if (result.VersionId !== receipt.versionId || result.ContentLength !== receipt.bytes)
      throw engineFailure('NATIVE_ENGINE_OBJECT_INVALID');
    const chunks = [];
    let count = 0;
    try {
      for await (const chunk of result.Body) {
        count += chunk.length;
        if (count > receipt.bytes) throw engineFailure('NATIVE_ENGINE_OBJECT_INVALID');
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks);
      if (count !== receipt.bytes || engineDigest(bytes) !== receipt.sha256)
        throw engineFailure('NATIVE_ENGINE_OBJECT_INVALID');
      return JSON.parse(gunzipSync(bytes, { maxOutputLength: MAX_DECODED }).toString('utf8'));
    } catch {
      result.Body?.destroy?.();
      throw engineFailure('NATIVE_ENGINE_OBJECT_INVALID');
    }
  };
  return {
    read,
    async observeJobResult(identity, jobId) {
      if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(jobId))
        throw engineFailure();
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
      if (
        !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(requestId) ||
        !/^[a-z][a-z0-9-]{0,63}$/.test(name)
      )
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
