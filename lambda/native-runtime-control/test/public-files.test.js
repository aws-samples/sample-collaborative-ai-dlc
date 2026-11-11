import { expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { snapshotNativeExecutionFiles } from '../../agentcore/native/execution-files.js';
import { captureNativeSourceBaseline } from '../../agentcore/native/source-baseline.js';
import { createNativeArtifactRevisions } from '../../shared/native-artifact-revision.js';
import { NATIVE_DEPENDENCY_POLICY } from '../../shared/native-project-files.js';
import { serialFixture, SERIAL_SOURCE } from './execution-serial-fixtures.js';
import { executionIdentity } from '../execution-runtime.js';
import { verifyCompletedNativeTurn } from '../execution-lifecycle.js';
import { createNativeResultStore } from '../result-store.js';
import { createNativeResultApi } from '../result-api.js';
import { createNativeResultWorker } from '../result-worker.js';
import { TABLE } from './fixtures.js';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

it('keeps one repository inventory from capture and admission through source, graph, files and stopped-runtime downloads', async () => {
  const f = serialFixture();
  await f.ready();
  const project = await realpath(await mkdtemp(join(tmpdir(), 'native-public-files-')));
  const original = new Map([
    ['.env', Buffer.from('PASSWORD=repository-owned-value\r\n')],
    ['.npmrc', Buffer.from('//registry.example/:_authToken=${NPM_TOKEN}\n')],
    ['.env.example', Buffer.alloc(0)],
    ['.aws/credentials', Buffer.from('[repository-example]\nregion=us-east-1\n')],
    ['.ssh/config', Buffer.from('Host repository-example\n')],
    ['binary.dat', Buffer.from([0, 255, 128])],
    ['page.html', Buffer.from('<script>throw new Error("untrusted repository text")</script>')],
    ['aidlc/spaces/team/intents/example/.env.md', Buffer.from('## Repository configuration\n')],
  ]);
  const privatePaths = [
    '.git/config',
    '.native-control/authority.json',
    '.native-homes/auth.json',
    '.aidlc/references/input.txt',
    '.agents/runtime.json',
    'node_modules/pkg/index.js',
    'aidlc/.aidlc-sessions/session.md',
  ];
  const forbiddenBytes = ['platform-issued-test-key'];
  const write = async (path, bytes) => {
    await mkdir(dirname(join(project, path)), { recursive: true });
    await writeFile(join(project, path), bytes);
  };
  try {
    for (const [path, bytes] of original) await write(path, bytes);
    for (const path of privatePaths) await write(path, forbiddenBytes[0]);
    const sourceBaseline = await captureNativeSourceBaseline({
      project,
      identity: executionIdentity(f.row()),
      repository: SERIAL_SOURCE,
      packageId: f.configuration.packageId,
      publications: f.publications,
      forbiddenBytes,
    });
    expect(sourceBaseline).toHaveProperty('receipt');
    const current = new Map(original);
    current.set('.env', Buffer.from('PASSWORD=updated-repository-owned-value\r\n'));
    current.set('added.txt', Buffer.from('\ufeffExact generated text\r\n'));
    current.delete('.ssh/config');
    await write('.env', current.get('.env'));
    await write('added.txt', current.get('added.txt'));
    await rm(join(project, '.ssh/config'));
    const snapshot = await snapshotNativeExecutionFiles({
      project,
      filesystemPolicy: NATIVE_DEPENDENCY_POLICY,
      forbiddenBytes,
    });
    expect(snapshot.files.map((file) => file.path).toSorted()).toEqual(
      [...current.keys()].toSorted(),
    );
    const report = await f.turn(undefined, { ...snapshot, sourceBaseline });
    const claim = await f.store.claim(f.bindingIdentity);
    const state = { row: claim.row };
    await verifyCompletedNativeTurn({
      state,
      report: { receipt: report.receipt, interaction: report.interactionReceipt },
      store: f.store,
      publications: f.publications,
      interactions: f.interactions,
      check: f.recheck,
      yieldPending: async () => {
        state.row = await f.store.release({ row: state.row });
      },
    });
    await f.store.cancel(f.bindingIdentity);
    await rm(project, { recursive: true, force: true });

    const target = {
      publicationId: report.receipt.id,
      publicationSequence: report.receipt.sequence,
    };
    const publication = await f.api.publication(f.prepared, f.recheck);
    expect(publication.files.map((file) => file.path).toSorted()).toEqual(
      [...current.keys()].toSorted(),
    );
    for (const file of publication.files) {
      const content = await f.api.file(f.prepared, file.id, f.recheck);
      expect(Buffer.from(content.content, content.encoding)).toEqual(current.get(file.path));
      expect(content.sha256).toBe(sha256(current.get(file.path)));
      const historical = await f.api.revisionFile(
        f.prepared,
        { ...target, fileId: file.id, sha256: file.sha256 },
        f.recheck,
      );
      expect(historical.encoding).toBe(file.path === 'binary.dat' ? 'binary' : 'utf8');
      expect(historical.content).toBe(
        file.path === 'binary.dat' ? null : current.get(file.path).toString(),
      );
    }
    const source = await f.api.revision(f.prepared, { ...target, source: true }, f.recheck);
    expect(source.status).toBe('captured');
    expect(source.baseline.files.map((file) => file.path).toSorted()).toEqual(
      [...original.keys()].toSorted(),
    );
    for (const file of source.baseline.files) {
      const previous = await f.api.revisionFile(
        f.prepared,
        { ...target, source: true, fileId: file.id, sha256: file.sha256 },
        f.recheck,
      );
      expect(previous.sha256).toBe(sha256(original.get(file.path)));
      if (file.path !== 'binary.dat')
        expect(previous.content).toBe(original.get(file.path).toString());
    }
    const graph = await f.api.graph(f.prepared, f.recheck);
    expect(
      graph.nodes.some(
        (node) => node.type === 'Section' && node.label === 'Repository configuration',
      ),
    ).toBe(true);

    const revisions = createNativeArtifactRevisions({
      ddb: f.ddb,
      nativeTable: TABLE,
      publications: f.publications,
    });
    const jobs = createNativeResultStore({ ddb: f.ddb, tableName: TABLE });
    let archive;
    const storage = {
      upload: vi.fn(async (_job, path, content) => {
        archive = await readFile(path);
        expect(sha256(archive)).toBe(content.sha256);
        expect(archive.length).toBe(content.bytes);
        return { ...content, versionId: 'derived-result-version' };
      }),
      download: vi.fn(async (job) => ({
        ...job.artifact,
        downloadUrl: 'https://download.example/result',
      })),
      remove: vi.fn(),
    };
    const results = createNativeResultApi({
      read: async (_draft, recheck) => {
        await recheck(f.prepared);
        return f.store.get(f.row().scope);
      },
      revisions,
      jobs,
      storage,
      enqueue: vi.fn(),
    });
    const worker = createNativeResultWorker({ executions: f.store, jobs, revisions, storage });
    const request = { ...target, requestId: randomUUID() };
    await results.requestResult(f.prepared, request, f.recheck);
    await worker({ ...f.row().scope, requestId: request.requestId });
    expect((await results.result(f.prepared, request, f.recheck)).status).toBe('ready');
    const entries = JSON.parse(
      execFileSync(
        'python3',
        [
          '-c',
          'import sys,io,zipfile,json,base64; z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); print(json.dumps({n:base64.b64encode(z.read(n)).decode() for n in z.namelist()}))',
        ],
        { input: archive },
      ).toString(),
    );
    expect(Object.keys(entries).toSorted()).toEqual(
      [...current.keys()]
        .map((path) => `files/${path}`)
        .concat('result-manifest.json')
        .toSorted(),
    );
    for (const [path, bytes] of current)
      expect(Buffer.from(entries[`files/${path}`], 'base64')).toEqual(bytes);
    const manifest = JSON.parse(Buffer.from(entries['result-manifest.json'], 'base64'));
    expect(manifest).toMatchObject({
      inventory: 'native-public-files',
      completeWorkspace: false,
      filesystemPolicy: NATIVE_DEPENDENCY_POLICY,
      ...target,
    });
    expect([...f.objects.values()].some((bytes) => bytes.includes(forbiddenBytes[0]))).toBe(false);
    f.authorization.member = false;
    await expect(results.result(f.prepared, request, f.recheck)).rejects.toMatchObject({
      code: 'NATIVE_PREPARATION_FORBIDDEN',
    });
    await expect(f.api.file(f.prepared, publication.files[0].id, f.recheck)).rejects.toMatchObject({
      code: 'NATIVE_PREPARATION_FORBIDDEN',
    });
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});
