import { GetObjectCommand } from '@aws-sdk/client-s3';
import { gunzipSync } from 'node:zlib';
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
  const read = async (identity, receipt, purpose = 'output') => {
    const prefix = nativeEngineObjectPrefix(identity, purpose);
    if (
      !receipt?.key?.startsWith(prefix) ||
      !/^[a-f0-9-]{36}\/[a-z][a-z0-9-]{0,63}\.json\.gz$/.test(receipt.key.slice(prefix.length)) ||
      !/^[a-f0-9]{64}$/.test(receipt.sha256 ?? '')
    )
      throw engineFailure('NATIVE_ENGINE_OBJECT_INVALID');
    return (await readVersion(receipt)).value;
  };
  return { read };
};
