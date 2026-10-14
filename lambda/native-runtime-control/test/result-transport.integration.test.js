import { expect, it } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { S3Client } from '@aws-sdk/client-s3';
import { DynamoDBClient, CreateTableCommand, DeleteTableCommand } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createNativeResultStorage } from '../result-storage.js';
import { createNativeResultStore, RESULT_LEASE_MS } from '../result-store.js';

it('streams upload and signed exact-version downloads over local HTTP, detecting interrupted transfers and stale versions', async () => {
  let saved;
  let interrupt = false;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'PUT') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      saved = {
        bytes,
        checksum: createHash('sha256').update(bytes).digest('base64'),
        path: url.pathname,
      };
      expect(req.headers['x-amz-checksum-sha256']).toBe(saved.checksum);
      expect(Number(req.headers['content-length'])).toBe(bytes.length);
      res.writeHead(200, { 'x-amz-version-id': 'exact-version' });
      res.end();
    } else if (
      !saved ||
      url.pathname !== saved.path ||
      url.searchParams.get('versionId') !== 'exact-version'
    ) {
      res.writeHead(404);
      res.end();
    } else {
      res.writeHead(200, {
        'content-length': saved.bytes.length,
        'x-amz-version-id': 'exact-version',
        'x-amz-checksum-sha256': saved.checksum,
      });
      if (req.method === 'HEAD') res.end();
      else if (interrupt) {
        res.write(saved.bytes.subarray(0, 2));
        setImmediate(() => res.destroy());
      } else res.end(saved.bytes);
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const client = new S3Client({
    endpoint: `http://127.0.0.1:${server.address().port}`,
    forcePathStyle: true,
    region: 'us-east-1',
    credentials: { accessKeyId: 'local-test', secretAccessKey: 'local-test' },
    maxAttempts: 1,
  });
  const storage = createNativeResultStorage({
    s3: client,
    bucket: 'local-results',
    accountId: '123456789012',
  });
  const directory = await mkdtemp(join(tmpdir(), 'result-http-'));
  const bytes = Buffer.from([0xef, 0xbb, 0xbf, 13, 10, 0, 255]);
  const job = {
    identity: {
      scope: { projectId: 'p', executionId: randomUUID() },
      bindingId: randomUUID(),
      attemptId: randomUUID(),
      configurationSha256: 'd'.repeat(64),
    },
    request: {
      requestId: randomUUID(),
      publicationId: 'a'.repeat(64),
      publicationSequence: 1,
      fileId: 'nf-' + 'b'.repeat(64),
      sha256: createHash('sha256').update(bytes).digest('hex'),
    },
  };
  try {
    const path = join(directory, 'data');
    await writeFile(path, bytes);
    job.artifact = await storage.upload(
      job,
      path,
      { bytes: bytes.length, sha256: job.request.sha256 },
      AbortSignal.timeout(5000),
    );
    const result = await storage.download(job);
    expect(new URL(result.downloadUrl).searchParams.get('versionId')).toBe('exact-version');
    expect(Buffer.from(await (await fetch(result.downloadUrl)).arrayBuffer()).equals(bytes)).toBe(
      true,
    );
    interrupt = true;
    await expect((async () => (await fetch(result.downloadUrl)).arrayBuffer())()).rejects.toThrow();
    job.artifact.versionId = 'missing-version';
    await expect(storage.download(job)).rejects.toThrow();
  } finally {
    client.destroy();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

it.skipIf(!process.env.DYNAMODB_LOCAL_ENDPOINT)(
  'fences concurrent and expired result claims with real DynamoDB conditional writes',
  async () => {
    const raw = new DynamoDBClient({
      endpoint: process.env.DYNAMODB_LOCAL_ENDPOINT,
      region: 'us-east-1',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
    const tableName = `native-results-${randomUUID()}`;
    await raw.send(
      new CreateTableCommand({
        TableName: tableName,
        BillingMode: 'PAY_PER_REQUEST',
        KeySchema: [
          { AttributeName: 'pk', KeyType: 'HASH' },
          { AttributeName: 'sk', KeyType: 'RANGE' },
        ],
        AttributeDefinitions: [
          { AttributeName: 'pk', AttributeType: 'S' },
          { AttributeName: 'sk', AttributeType: 'S' },
        ],
      }),
    );
    let time = Date.now();
    const store = createNativeResultStore({
      ddb: DynamoDBDocumentClient.from(raw),
      tableName,
      now: () => time,
    });
    const execution = {
      scope: { projectId: 'project', executionId: randomUUID() },
      bindingId: randomUUID(),
      attemptId: randomUUID(),
      configurationSha256: 'b'.repeat(64),
    };
    const request = {
      requestId: randomUUID(),
      publicationId: 'c'.repeat(64),
      publicationSequence: 2,
    };
    const artifact = { versionId: 'version-one', bytes: 10, sha256: 'e'.repeat(64) };
    try {
      await Promise.all([1, 2].map(() => store.request(execution, request)));
      const claims = await Promise.all(
        [1, 2].map(() => store.claim(execution.scope, request.requestId)),
      );
      expect(claims.filter(Boolean)).toHaveLength(1);
      time += RESULT_LEASE_MS + 1;
      const current = await store.claim(execution.scope, request.requestId);
      expect(await store.finish(claims.find(Boolean), artifact)).toBe(false);
      expect(await store.finish(current, artifact)).toBe(true);
      expect(await store.claim(execution.scope, request.requestId)).toBeNull();
      await expect(
        store.request(execution, { ...request, publicationSequence: 3 }),
      ).rejects.toThrow();
    } finally {
      await raw.send(new DeleteTableCommand({ TableName: tableName }));
      raw.destroy();
    }
  },
);
