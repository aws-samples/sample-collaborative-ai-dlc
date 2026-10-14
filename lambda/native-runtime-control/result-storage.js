import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  PutObjectCommand,
  HeadObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { canonicalJson } from '../shared/workflow-checkpoint.js';
import { resultFailure } from './result-store.js';
import { RESULT_ARCHIVE_BYTES } from './result-archive.js';

export const RESULT_URL_SECONDS = 300;
const SHA = /^[a-f0-9]{64}$/;
const version = (value) =>
  typeof value === 'string' && value !== 'null' && /^[A-Za-z0-9._~+/=-]{1,1024}$/.test(value);
const prefix = (job) =>
  `native-results/v1/${createHash('sha256')
    .update(
      canonicalJson({
        identity: job.identity,
        request: job.request,
      }),
    )
    .digest('hex')}/`;
const artifactKey = (job, artifact) => `${prefix(job)}${artifact.sha256}`;
const valid = (artifact) =>
  artifact &&
  SHA.test(artifact.sha256 ?? '') &&
  version(artifact.versionId) &&
  Number.isSafeInteger(artifact.bytes) &&
  artifact.bytes >= 0 &&
  artifact.bytes <= RESULT_ARCHIVE_BYTES;
export const createNativeResultStorage = ({
  s3,
  bucket,
  accountId,
  presign = getSignedUrl,
  now = Date.now,
}) => {
  const base = { Bucket: bucket, ExpectedBucketOwner: accountId };
  return {
    async upload(job, path, content, signal) {
      const stream = createReadStream(path);
      try {
        const response = await s3.send(
          new PutObjectCommand({
            ...base,
            Key: artifactKey(job, content),
            Body: stream,
            ContentLength: content.bytes,
            ContentType: job.request.fileId ? 'application/octet-stream' : 'application/zip',
            ChecksumSHA256: Buffer.from(content.sha256, 'hex').toString('base64'),
          }),
          { abortSignal: signal },
        );
        const artifact = { ...content, versionId: response.VersionId };
        if (!valid(artifact)) throw resultFailure();
        return artifact;
      } finally {
        stream.destroy();
      }
    },
    async remove(job, artifact) {
      if (!valid(artifact)) throw resultFailure();
      await s3.send(
        new DeleteObjectCommand({
          ...base,
          Key: artifactKey(job, artifact),
          VersionId: artifact.versionId,
        }),
      );
    },
    async download(job) {
      const artifact = job.artifact;
      if (!valid(artifact)) throw resultFailure();
      const object = { ...base, Key: artifactKey(job, artifact), VersionId: artifact.versionId };
      const head = await s3.send(new HeadObjectCommand({ ...object, ChecksumMode: 'ENABLED' }));
      if (
        head.VersionId !== artifact.versionId ||
        head.ContentLength !== artifact.bytes ||
        head.ChecksumSHA256 !== Buffer.from(artifact.sha256, 'hex').toString('base64')
      )
        throw resultFailure();
      const filename = job.request.fileId
        ? `${job.request.fileId}-${artifact.sha256.slice(0, 12)}.bin`
        : `native-result-${job.request.publicationSequence}-${job.request.publicationId.slice(0, 12)}.zip`;
      const downloadUrl = await presign(
        s3,
        new GetObjectCommand({
          ...object,
          ResponseContentType: job.request.fileId ? 'application/octet-stream' : 'application/zip',
          ResponseContentDisposition: `attachment; filename="${filename}"`,
          ResponseCacheControl: 'private, no-store',
        }),
        { expiresIn: RESULT_URL_SECONDS },
      );
      return {
        filename,
        downloadUrl,
        bytes: artifact.bytes,
        sha256: artifact.sha256,
        expiresAt: new Date(now() + RESULT_URL_SECONDS * 1000).toISOString(),
      };
    },
  };
};
