// Disposable Start repository, installed result worker and versioned download.
// The SDK ports share the controller's admitted records. Git runs independently
// against the returned bundle and the original checkout.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { buffer } from 'node:stream/consumers';
import { mock } from 'node:test';
import { nativeGitExcludedRoot } from '../lambda/shared/native-git-change-set.js';
import { captureNativeSourceBaseline } from '../lambda/agentcore/native/source-baseline.js';
import { createNativeResultStore } from '../lambda/native-runtime-control/result-store.js';
import { createNativeResultStorage } from '../lambda/native-runtime-control/result-storage.js';
import { handler } from '../lambda/native-runtime-control/result-worker.js';
import { initiator, respondent } from './native-qualification-member.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const git = (cwd, ...args) =>
  execFileSync('/usr/bin/git', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: '/usr/bin:/bin',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Qualification',
      GIT_COMMITTER_NAME: 'Qualification',
      GIT_AUTHOR_EMAIL: 'local@example.invalid',
      GIT_COMMITTER_EMAIL: 'local@example.invalid',
    },
  });
const workerEntry = realpathSync(
  new URL('../lambda/native-runtime-control/result-worker.js', import.meta.url),
);
const sdk = createRequire(workerEntry);
const { S3Client, GetObjectCommand } = sdk('@aws-sdk/client-s3');
const { DynamoDBDocumentClient } = sdk('@aws-sdk/lib-dynamodb');

const gitInventory = (cwd) =>
  new Map(
    git(cwd, 'ls-tree', '-rz', 'HEAD')
      .toString()
      .split('\0')
      .filter(Boolean)
      .map((line) => {
        const [entry, path] = line.split('\t'),
          [mode, type, id] = entry.split(' ');
        assert.equal(type, 'blob');
        const content = git(cwd, 'cat-file', 'blob', id);
        return [path, { mode, bytes: content.length, sha256: hash(content) }];
      }),
  );

async function verifyImportedBundle({
  root,
  origin,
  commit,
  delta,
  revision,
  delivery,
  bundleBytes,
}) {
  const bundle = join(root, 'result.bundle'),
    imported = join(root, 'imported');
  await fs.writeFile(bundle, bundleBytes, { flag: 'wx' });
  git(root, 'clone', '-q', '--no-local', origin, imported);
  git(imported, 'bundle', 'verify', bundle);
  git(imported, 'fetch', '-q', bundle, `refs/heads/${delivery.branch}`);
  git(imported, 'checkout', '-q', '--detach', 'FETCH_HEAD');
  assert.equal(git(imported, 'rev-parse', 'HEAD').toString().trim(), delivery.commit);
  assert.equal(git(imported, 'show', '-s', '--format=%P', 'HEAD').toString().trim(), commit);
  assert.equal(git(imported, 'rev-parse', 'HEAD^{tree}').toString().trim(), delivery.tree);
  const expected = gitInventory(origin);
  for (const change of delta.changes) {
    assert.deepEqual(expected.get(change.path) ?? null, change.before);
    if (change.after) expected.set(change.path, change.after);
    else expected.delete(change.path);
  }
  const importedTree = gitInventory(imported);
  assert.deepEqual(importedTree, expected);
  const eligible = new Map(
    revision.files
      .filter((file) => !nativeGitExcludedRoot(file.path))
      .map(({ path, mode, bytes, sha256 }) => [path, { mode, bytes, sha256 }]),
  );
  assert.deepEqual(importedTree, eligible);
  assert.ok(delta.changes.some((c) => c.path === 'obsolete.bin' && c.before && c.after === null));
  assert.equal(expected.has('obsolete.bin'), false);
  assert.equal(expected.get('run').mode, '100755');
  assert.equal(
    expected.get('counter.js').sha256,
    hash('export const increment = value => value + 1;\n'),
  );
  return expected.size;
}

export async function qualificationGitResult({
  root,
  project,
  f,
  storage,
  memory,
  publications,
  tableName,
}) {
  const origin = join(root, 'start-source');
  await fs.mkdir(origin);
  git(origin, 'init', '-q', '-b', 'main');
  await fs.writeFile(
    join(origin, 'README.md'),
    '# Counter fixture\n\nImplement the counter described in the Start request.\n',
  );
  await fs.writeFile(join(origin, 'run'), '#!/bin/sh\nnode --test counter.test.mjs\n');
  await fs.writeFile(join(origin, 'obsolete.bin'), Buffer.from([0, 254]));
  await fs.writeFile(join(origin, 'unchanged.txt'), 'Retain these Start bytes.\n');
  git(origin, 'add', '.');
  git(origin, 'commit', '-qm', 'Authorized fixture Start');
  const commit = git(origin, 'rev-parse', 'HEAD').toString().trim();
  f.prepared.request.prompt =
    'Create a local integer counter that increments its input by one and prove it with a Node test. Make the starter test launcher executable and remove the obsolete sample.';
  f.configuration.promptSha256 = hash(f.prepared.request.prompt);
  Object.assign(f.configuration.repository, { repository: 'qualification/counter', commit });
  const jobs = createNativeResultStore({ ddb: f.ddb, tableName, now: f.now });
  const queue = [];
  // Local S3 download transport. Use the normal SDK presigner and follow the
  // URL given to the member. Every read names an existing immutable version.
  const { bucket, accountId } = storage;
  const server = createServer(async (req, res) => {
    try {
      const u = new URL(req.url, 'http://localhost');
      assert.equal(req.method, 'GET');
      assert.equal(
        u.searchParams.get('x-amz-expected-bucket-owner') ??
          req.headers['x-amz-expected-bucket-owner'],
        accountId,
      );
      assert.match(
        u.pathname,
        new RegExp(`^/${bucket}/native-results/v1/[a-f0-9]{64}/[a-f0-9]{64}$`),
      );
      assert.ok(u.searchParams.get('X-Amz-Signature'));
      const VersionId = u.searchParams.get('versionId');
      assert.ok(VersionId);
      const result = await storage.s3.send(
        new GetObjectCommand({
          Bucket: bucket,
          ExpectedBucketOwner: accountId,
          Key: u.pathname.slice(bucket.length + 2),
          VersionId,
        }),
      );
      res.setHeader('x-amz-version-id', result.VersionId);
      res.end(await buffer(result.Body));
    } catch {
      res.writeHead(403).end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const s3 = new S3Client({
    endpoint,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: 'fixture', secretAccessKey: 'offline-result-fixture' },
  });
  const metadataPort = mock.method(s3, 'send', storage.s3.send);
  return {
    jobs,
    results: {
      jobs,
      storage: createNativeResultStorage({ s3, bucket, accountId }),
      enqueue: async (input, format) => {
        assert.equal(format, 'git');
        queue.push(input);
      },
      now: f.now,
    },
    async checkout(identity, signal) {
      await fs.mkdir(project, { recursive: true });
      git(project, 'init', '-q', '-b', 'main');
      git(project, 'fetch', '-q', origin, commit);
      git(project, 'checkout', '-q', '--detach', commit);
      assert.equal(git(project, 'rev-parse', 'HEAD').toString().trim(), commit);
      return captureNativeSourceBaseline({
        project,
        identity,
        repository: f.configuration.repository,
        packageId: f.configuration.packageId,
        publications,
        signal,
        readTree: () => git(project, 'ls-tree', '--full-tree', '-rtz', commit).toString(),
        readCommit: () => git(project, 'cat-file', 'commit', commit),
      });
    },
    async verify(member, revision) {
      const { id: publicationId, sequence: publicationSequence } = revision;
      const target = { publicationId, publicationSequence: String(publicationSequence) };
      const source = await member.request('publication', undefined, {
        query: { ...target, source: '1' },
      });
      const delta = source.gitChangeSet;
      assert.equal(delta.terminal, 'matched');
      assert.equal(delta.review, 'not_required');
      assert.equal(delta.sha256, delta.terminalSha256);
      assert.equal(delta.repository.commit, commit);
      const request = {
        requestId: randomUUID(),
        publicationId,
        publicationSequence,
        format: 'git',
      };
      const query = { ...request, ...target };
      const pending = await member.request('results', request);
      assert.equal(pending.status, 'pending');
      assert.deepEqual(await member.request('results', request), pending);
      const event = { ...f.identity, requestId: request.requestId };
      assert.deepEqual(queue, [event, event]);
      const vars = {
        NATIVE_EXECUTION_PUBLICATION_BUCKET: bucket,
        NATIVE_RUNTIME_ACCOUNT_ID: accountId,
        NATIVE_RUNTIME_BINDINGS_TABLE: tableName,
      };
      const saved = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
      Object.assign(process.env, vars);
      const ports = [
        mock.method(S3Client.prototype, 'send', storage.s3.send),
        mock.method(DynamoDBDocumentClient.prototype, 'send', (command) => f.ddb.send(command)),
      ];
      try {
        for (const delivery of queue) await handler(delivery);
      } finally {
        for (const port of ports) port.mock.restore();
        for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
      assert.equal(memory.writes.filter((key) => key.startsWith('native-results/')).length, 1);
      const denied = await member.request('results', undefined, {
        query,
        token: 'offline-nonmember',
        status: 403,
      });
      assert.equal(denied.code, 'NATIVE_PREPARATION_FORBIDDEN');
      let ready, bundleBytes, version;
      for (const { token } of [initiator, respondent]) {
        const result = await member.request('results', undefined, { query, token });
        assert.equal(result.status, 'ready');
        assert.equal(result.requestId, request.requestId);
        assert.equal(result.publicationId, publicationId);
        assert.equal(result.publicationSequence, publicationSequence);
        assert.deepEqual(result.delivery.verification, pending.delivery.verification);
        assert.equal(result.delivery.sourceBaselineId, delta.sourceBaselineId);
        assert.equal(result.delivery.deltaSha256, delta.sha256);
        assert.equal(result.delivery.verification.terminal, 'matched');
        assert.ok(Date.parse(result.download.expiresAt) > Date.now());
        const url = new URL(result.download.downloadUrl);
        assert.equal(url.origin, endpoint);
        assert.equal(url.searchParams.get('X-Amz-Expires'), '300');
        const response = await fetch(result.download.downloadUrl, {
          headers: { 'x-amz-expected-bucket-owner': accountId },
        });
        assert.equal(response.status, 200);
        const downloaded = Buffer.from(await response.arrayBuffer());
        assert.equal(downloaded.length, result.download.bytes);
        assert.equal(hash(downloaded), result.download.sha256);
        if (ready) {
          assert.deepEqual(result.delivery, ready.delivery);
          assert.deepEqual(downloaded, bundleBytes);
          assert.equal(response.headers.get('x-amz-version-id'), version);
        }
        ready = result;
        bundleBytes = downloaded;
        version = response.headers.get('x-amz-version-id');
      }
      const retry = await member.request('results', request, { status: 200 });
      assert.equal(retry.download.sha256, ready.download.sha256);
      assert.equal(queue.length, 2);
      const treeFiles = await verifyImportedBundle({
        root,
        origin,
        commit,
        delta,
        revision,
        delivery: ready.delivery,
        bundleBytes,
      });
      return {
        requestId: request.requestId,
        pendingRetries: 1,
        workerDeliveries: queue.length,
        artifacts: 1,
        namedReaders: [initiator.actorId, respondent.actorId],
        denied: denied.code,
        readyRetry: retry.status,
        sourceBaselineId: delta.sourceBaselineId,
        startCommit: commit,
        branch: ready.delivery.branch,
        commit: ready.delivery.commit,
        tree: ready.delivery.tree,
        deltaSha256: delta.sha256,
        terminal: delta.terminal,
        changeCount: delta.changes.length,
        codeChanges: delta.changes.filter((c) =>
          ['obsolete.bin', 'run', 'counter.js', 'counter.test.mjs'].includes(c.path),
        ),
        treeFiles,
        bundleBytes: bundleBytes.length,
        bundleSha256: hash(bundleBytes),
        version,
      };
    },
    async close() {
      metadataPort.mock.restore();
      s3.destroy();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
