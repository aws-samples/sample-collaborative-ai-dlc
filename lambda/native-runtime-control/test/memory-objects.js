// Existing journey's versioned S3 port, shared with the installed offline tier.
// Production publication, interaction, checkpoint and fence owners validate it.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

export function memoryNativeObjects({ bucket, accountId, before = () => {} }) {
  const latest = new Map();
  const objects = new Map();
  const writes = [];
  let version = 0;
  const s3 = {
    async send(command) {
      const p = command.input;
      assert.equal(p.Bucket, bucket);
      assert.equal(p.ExpectedBucketOwner, accountId);
      await before(command);
      const current = latest.get(p.Key);
      if (command.constructor.name === 'PutObjectCommand') {
        if ((p.IfNoneMatch === '*' && current) || (p.IfMatch && p.IfMatch !== current?.etag))
          throw Object.assign(new Error('conditional conflict'), {
            name: 'PreconditionFailed',
            $metadata: { httpStatusCode: 412 },
          });
        const bytes = Buffer.from(p.Body);
        const item = {
          bytes,
          version: `immutable-${++version}`,
          etag: `"${createHash('sha256').update(bytes).digest('hex')}"`,
        };
        objects.set(`${p.Key}\0${item.version}`, item);
        latest.set(p.Key, item);
        writes.push(p.Key);
        return { VersionId: item.version, ETag: item.etag };
      }
      assert.equal(command.constructor.name, 'GetObjectCommand');
      const item = p.VersionId ? objects.get(`${p.Key}\0${p.VersionId}`) : current;
      if (!item) throw Object.assign(new Error('missing'), { name: 'NoSuchKey' });
      return {
        VersionId: item.version,
        ETag: item.etag,
        ContentLength: item.bytes.length,
        Body: Readable.from([item.bytes]),
      };
    },
  };
  return { s3, latest, objects, writes };
}
