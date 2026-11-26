// In-memory, versioned SDK port only. Package fixtures and materialization use
// the real verifier/loader separately. No network, credentials, or AWS calls.
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';

const failure = (name, status) =>
  Object.assign(new Error(`Authored S3 fixture failure: ${name}`), {
    name,
    $metadata: { httpStatusCode: status },
  });

export const createNativePackageS3 = ({ bucket, expectedBucketOwner } = {}) => {
  const objects = new Map();
  const operations = [];
  let sequence = 0;
  const putVersion = (key, bytes, versionId = `archive-version-${++sequence}`) => {
    if (!objects.has(key)) objects.set(key, new Map());
    const stored = { versionId, bytes: Buffer.from(bytes) };
    objects.get(key).set(versionId, stored);
    return stored;
  };
  const latest = (key) => [...(objects.get(key)?.values() ?? [])].at(-1);
  const fixture = {
    objects,
    operations,
    putVersion,
    latest,
    // Hooks receive {name,input,signal,command}; afterSend also gets response.
    // Returning undefined uses the ordinary implementation/response.
    beforeSend: undefined,
    afterSend: undefined,
  };
  fixture.s3 = {
    async send(command, { abortSignal: signal } = {}) {
      const { input } = command;
      const name = command.constructor.name;
      const context = { name, input, signal, command };
      operations.push({
        name,
        input: { ...input, ...(input.Body ? { Body: Buffer.from(input.Body) } : {}) },
        signal,
      });
      if (signal?.aborted) throw failure('AbortError', 499);
      const intercepted = await fixture.beforeSend?.(context);
      if (intercepted !== undefined) return intercepted;
      if (signal?.aborted) throw failure('AbortError', 499);
      if (
        (bucket && input.Bucket !== bucket) ||
        (expectedBucketOwner && input.ExpectedBucketOwner !== expectedBucketOwner)
      )
        throw failure('AccessDenied', 403);
      let response;
      if (command instanceof PutObjectCommand) {
        if (!Buffer.isBuffer(input.Body))
          throw new Error('Fixture requires immutable Buffer input');
        if (
          input.IfNoneMatch !== '*' ||
          input.ContentLength !== input.Body.length ||
          input.ChecksumSHA256 !== createHash('sha256').update(input.Body).digest('base64')
        )
          throw new Error('Fixture requires a bounded conditional checksum-bearing put');
        if (latest(input.Key)) throw failure('PreconditionFailed', 412);
        const stored = putVersion(input.Key, input.Body);
        response = { VersionId: stored.versionId };
      } else if (command instanceof GetObjectCommand) {
        const stored =
          input.VersionId === undefined
            ? latest(input.Key)
            : objects.get(input.Key)?.get(input.VersionId);
        if (!stored)
          throw failure(input.VersionId === undefined ? 'NoSuchKey' : 'NoSuchVersion', 404);
        response = {
          VersionId: stored.versionId,
          ContentLength: stored.bytes.length,
          ChecksumSHA256: createHash('sha256').update(stored.bytes).digest('base64'),
          Body: Readable.from([Buffer.from(stored.bytes)]),
        };
      } else {
        throw new Error('Unexpected S3 fixture command');
      }
      return (await fixture.afterSend?.({ ...context, response })) ?? response;
    },
  };
  return fixture;
};
