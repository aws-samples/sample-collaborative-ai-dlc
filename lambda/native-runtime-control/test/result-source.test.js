import { expect, it, vi } from 'vitest';
import { serialFixture, SERIAL_SOURCE } from './execution-serial-fixtures.js';
import { executionIdentity } from '../execution-runtime.js';
import { createNativeArtifactRevisions } from '../../shared/native-artifact-revision.js';
import { TABLE } from './fixtures.js';
import { verifyCompletedNativeTurn } from '../execution-lifecycle.js';

it('retains the real pre-turn baseline separately from generated publications, including deleted and binary bytes', async () => {
  const f = serialFixture();
  await f.ready();
  const identity = executionIdentity(f.row());
  const files = [
    { path: 'deleted.txt', role: 'code', content: Buffer.from('\ufefforiginal\r\n') },
    { path: 'binary', role: 'code', content: Buffer.from([0, 255]) },
    { path: 'same', role: 'code', content: Buffer.alloc(0) },
    { path: 'large', role: 'code', content: Buffer.alloc(3 * 1024 * 1024 + 1, 10) },
  ];
  const receipt = await f.publications.write({
    identity,
    packageId: f.configuration.packageId,
    repository: SERIAL_SOURCE,
    outcome: 'STOPPED',
    nativeSessionId: null,
    files,
  });
  const first = await f.publish({
    sourceBaseline: { epoch: identity.epoch, receipt },
    files: [files[1], files[2], { path: 'added.txt', role: 'code', content: Buffer.from('new') }],
  });
  const target = { publicationId: first.receipt.id, publicationSequence: 1, source: true };
  const source = await f.api.revision(f.prepared, target, f.recheck);
  expect(source).toMatchObject({
    status: 'captured',
    baseline: { id: receipt.id, repository: SERIAL_SOURCE },
  });
  expect(source.baseline.files.map((file) => file.path)).toEqual(files.map((file) => file.path));
  const results = [];
  for (const file of source.baseline.files)
    results.push(
      await f.api.revisionFile(
        f.prepared,
        {
          ...target,
          fileId: file.id,
          sha256: file.sha256,
        },
        f.recheck,
      ),
    );
  expect(results[0]).toMatchObject({
    content: '\ufefforiginal\r\n',
    sourceBaselineId: receipt.id,
    publicationId: target.publicationId,
    publicationSequence: 1,
  });
  expect(results[1].encoding).toBe('binary');
  expect(results[2].content).toBe('');
  expect(results[3].encoding).toBe('too_large');
  expect(JSON.stringify(source)).not.toMatch(/versionId|nativeSessionId|object/);
  const revisions = createNativeArtifactRevisions({
    ddb: f.ddb,
    nativeTable: TABLE,
    publications: f.publications,
  });
  await expect(
    revisions.read(
      f.row(),
      { ...target, fileId: source.baseline.files[0].id, sha256: 'a'.repeat(64) },
      { maxBytes: 100, sourceBaseline: true },
    ),
  ).rejects.toThrow();
});

it('does not manufacture baseline data from a retained first publication or an unreadable source', async () => {
  const f = serialFixture();
  await f.ready();
  const first = await f.publish();
  expect(
    await f.api.revision(
      f.prepared,
      {
        publicationId: first.receipt.id,
        publicationSequence: 1,
        source: true,
      },
      f.recheck,
    ),
  ).toMatchObject({ status: 'not_retained', baseline: null });
});

it.each(['preserved', 'replaced', 'dropped'])(
  'admits a subsequent result only with its original source baseline: %s',
  async (change) => {
    const f = serialFixture();
    await f.ready();
    const identity = executionIdentity(f.row());
    const baseline = async (content) => ({
      epoch: identity.epoch,
      receipt: await f.publications.write({
        identity,
        packageId: f.configuration.packageId,
        repository: SERIAL_SOURCE,
        outcome: 'STOPPED',
        nativeSessionId: null,
        files: [{ path: 'source.txt', role: 'code', content: Buffer.from(content) }],
      }),
    });
    const original = await baseline('original');
    await f.publish({ sourceBaseline: original });
    await f.respond();
    const sourceBaseline =
      change === 'preserved' ? original : change === 'replaced' ? await baseline('other') : null;
    const report = await f.turn(undefined, { sourceBaseline });
    const publish = vi.fn(async () => f.row());
    const completed = verifyCompletedNativeTurn({
      state: { row: f.row() },
      report,
      store: { publish },
      publications: f.publications,
      check: async () => {},
      yieldPending: async () => {},
    });
    if (change === 'preserved') {
      await completed;
      expect(publish).toHaveBeenCalledOnce();
    } else {
      await expect(completed).rejects.toMatchObject({ code: 'NATIVE_PUBLICATION_INVALID' });
      expect(publish).not.toHaveBeenCalled();
    }
  },
);

it('refuses first admission when the captured original source bytes are corrupt', async () => {
  const f = serialFixture();
  await f.ready();
  const identity = executionIdentity(f.row());
  const receipt = await f.publications.write({
    identity,
    packageId: f.configuration.packageId,
    repository: SERIAL_SOURCE,
    outcome: 'STOPPED',
    nativeSessionId: null,
    files: [{ path: 'original.txt', role: 'code', content: Buffer.from('original') }],
  });
  const source = await f.publications.read(identity, receipt);
  const object = source.files[0].object;
  f.objects.set(`${object.key}\0${object.versionId}`, Buffer.from('tampered'));
  const report = await f.turn(undefined, { sourceBaseline: { epoch: identity.epoch, receipt } });
  const publish = vi.fn();
  await expect(
    verifyCompletedNativeTurn({
      state: { row: f.row() },
      report,
      store: { publish },
      publications: f.publications,
      check: async () => {},
      yieldPending: async () => {},
    }),
  ).rejects.toMatchObject({ code: 'NATIVE_PUBLICATION_INVALID' });
  expect(publish).not.toHaveBeenCalled();
});
