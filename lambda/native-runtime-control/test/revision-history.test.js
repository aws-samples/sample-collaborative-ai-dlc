import { describe, expect, it } from 'vitest';
import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { serialFixture } from './execution-serial-fixtures.js';
import { nativeRevisionQuery } from '../revision-query.js';
import { createNativeExecutionApi } from '../execution-api.js';
import { createNativeArtifactRevisions } from '../../shared/native-artifact-revision.js';
import { TABLE } from './fixtures.js';

const target = (receipt) => ({ publicationId: receipt.id, publicationSequence: receipt.sequence });
const history = (f, receipt) => f.api.revisionInteraction(f.prepared, target(receipt), f.recheck);
const continueTurn = async (f) => {
  await f.respond();
  const claim = await f.store.claim(f.bindingIdentity);
  await f.store.dispatched({ row: claim.row });
  return f.publish();
};

describe('native immutable decision and revision history', () => {
  it('retains exact proposals, accepted actors/context, delivery and named resulting revisions after later answers', async () => {
    const f = serialFixture();
    await f.ready();
    const first = await f.publish({ text: 'Approve the exact first proposal?' });
    const request = f.replyRequest({ text: 'No: keep the old design.' });
    await f.store.respond({
      ...f.bindingIdentity,
      actorId: 'member-one',
      request,
      member: { membershipId: 'member-edge', projectIdentity: 'project-vertex' },
    });
    let claim = await f.store.claim(f.bindingIdentity);
    // Simulate a lost transaction acknowledgement: readback can confirm only
    // the exact committed row; the observation shares that transaction.
    f.hooks.after = (command) => {
      if (command instanceof TransactWriteCommand) {
        delete f.hooks.after;
        throw new Error('lost acknowledgement');
      }
    };
    await f.store.dispatched({ row: claim.row });
    const second = await f.publish();
    await continueTurn(f);
    const result = await history(f, first.receipt);
    expect(result.interaction.messages[0].text).toBe('Approve the exact first proposal?');
    expect(result.answer).toMatchObject({
      text: request.text,
      actorId: 'member-one',
      deliveryStatus: 'delivered',
      context: { ...target(first.receipt), membershipRecorded: true },
      resultingPublication: target(second.receipt),
      applicationStatus: 'not_recorded',
      rejectionStatus: 'not_recorded',
      approvalStatus: 'not_recorded',
    });
    expect(result.answer.deliveredAt).not.toBeNull();
    expect(JSON.stringify(result)).not.toMatch(
      /versionId|runtimeSessionId|membershipId|recoveryCheckpoint|manifest/,
    );
  });

  it('does not derive historical delivery or a resulting revision from adjacent retained publications', async () => {
    const f = serialFixture();
    await f.ready();
    const first = await f.publish();
    await continueTurn(f);
    await continueTurn(f);
    for (const [key, row] of f.rows) if (row.sk.startsWith('ANSWER#')) f.rows.delete(key);
    const result = await history(f, first.receipt);
    expect(result.answer).toMatchObject({
      deliveryStatus: 'unknown',
      deliveredAt: null,
      resultingPublication: null,
      applicationStatus: 'not_recorded',
    });
  });

  it('persists uncertain delivery through cancellation, without claiming rejection or application', async () => {
    const f = serialFixture();
    await f.ready();
    const first = await f.publish();
    await f.respond();
    const claim = await f.store.claim(f.bindingIdentity);
    await f.store.recoveryRequired({ row: claim.row, reason: 'DELIVERY_UNCERTAIN' });
    await f.store.cancel(f.bindingIdentity);
    const result = await history(f, first.receipt);
    expect(result.answer).toMatchObject({
      deliveryStatus: 'uncertain',
      resultingPublication: null,
      applicationStatus: 'not_recorded',
      rejectionStatus: 'not_recorded',
    });
    expect(result.answer.uncertainAt).not.toBeNull();
  });

  it('pages beyond a batch without skipping or pulling concurrent new publications into older pages', async () => {
    const f = serialFixture();
    await f.ready();
    await f.publish();
    for (let i = 1; i < 35; i++) await continueTurn(f);
    const first = await f.api.history(f.prepared, null, f.recheck);
    expect(first.items.map((item) => item.sequence)).toEqual(
      Array.from({ length: 32 }, (_, n) => 35 - n),
    );
    expect(first.nextBefore).toBe(4);
    await continueTurn(f);
    const second = await f.api.history(f.prepared, first.nextBefore, f.recheck);
    expect(second.items.map((item) => item.sequence)).toEqual([3, 2, 1]);
    expect(second.nextBefore).toBeNull();
    expect([...first.gaps, ...second.gaps]).toEqual([]);
  });

  it('reports missing immutable history while retaining the exact head and refuses to fabricate older files', async () => {
    const f = serialFixture();
    await f.ready();
    const first = await f.publish();
    const second = await continueTurn(f);
    for (const [key, row] of f.rows) if (row.sk.startsWith('PUBLICATION#')) f.rows.delete(key);
    expect(await f.api.history(f.prepared, null, f.recheck)).toEqual({
      items: [],
      nextBefore: null,
      gaps: [{ from: 1, to: 2 }],
    });
    await expect(
      f.api.revision(f.prepared, target(second.receipt), f.recheck),
    ).resolves.toMatchObject({ id: second.receipt.id });
    await expect(
      f.api.revision(f.prepared, target(first.receipt), f.recheck),
    ).rejects.toMatchObject({ code: 'NATIVE_ARTIFACT_REVISION_INVALID' });
  });

  it('reads deleted, unknown, binary and over-limit files with exact hashes and explicit limits', async () => {
    const f = serialFixture();
    await f.ready();
    const first = await f.publish({
      files: [
        {
          path: 'notes.custom',
          role: 'artifact',
          content: Buffer.from('unregistered format\r\n🐦\n'),
        },
        { path: 'picture.bin', role: 'code', content: Buffer.from([0, 255, 128]) },
        { path: 'large.txt', role: 'artifact', content: Buffer.alloc(3 * 1024 * 1024 + 1, 65) },
      ],
    });
    const old = await f.api.revision(f.prepared, target(first.receipt), f.recheck);
    await continueTurn(f);
    const results = [];
    for (const file of old.files)
      results.push(
        await f.api.revisionFile(
          f.prepared,
          {
            ...target(first.receipt),
            fileId: file.id,
            sha256: file.sha256,
          },
          f.recheck,
        ),
      );
    expect(results.find((file) => file.path === 'notes.custom')).toMatchObject({
      content: 'unregistered format\r\n🐦\n',
      encoding: 'utf8',
      truncated: false,
    });
    expect(results.find((file) => file.path === 'picture.bin')).toMatchObject({
      content: null,
      encoding: 'binary',
      truncated: false,
    });
    expect(results.find((file) => file.path === 'large.txt')).toMatchObject({
      content: null,
      encoding: 'too_large',
      truncated: false,
    });
  });

  it.each(['scope', 'bindingId', 'attemptId', 'epoch', 'sequence'])(
    'rejects tampered historical %s ownership',
    async (field) => {
      const f = serialFixture();
      await f.ready();
      const first = await f.publish();
      await continueTurn(f);
      const saved = [...f.rows.values()].find(
        (row) => row.sk === `PUBLICATION#${'1'.padStart(16, '0')}`,
      );
      if (field === 'scope') saved.scope = { ...saved.scope, projectId: 'foreign' };
      else if (field === 'sequence') saved.publication.sequence = 20;
      else saved[field] = field === 'epoch' ? 100 : 'foreign';
      await expect(
        f.api.revision(f.prepared, target(first.receipt), f.recheck),
      ).rejects.toMatchObject({ code: 'NATIVE_ARTIFACT_REVISION_INVALID' });
    },
  );

  it('rechecks authorization after exact reads and keeps projection failures independent', async () => {
    const f = serialFixture();
    await f.ready();
    const first = await f.publish();
    const api = createNativeExecutionApi({
      store: f.store,
      publications: f.publications,
      interactions: f.interactions,
      revisions: createNativeArtifactRevisions({
        ddb: f.ddb,
        nativeTable: TABLE,
        publications: f.publications,
      }),
      projectionStatus: () => {
        throw new Error('graph cursor unavailable');
      },
    });
    await expect(api.revision(f.prepared, target(first.receipt), f.recheck)).resolves.toMatchObject(
      { id: first.receipt.id },
    );
    let calls = 0;
    const recheck = () => {
      if (++calls > 1)
        throw Object.assign(new Error('revoked'), { code: 'NATIVE_PREPARATION_FORBIDDEN' });
    };
    await expect(api.revision(f.prepared, target(first.receipt), recheck)).rejects.toMatchObject({
      code: 'NATIVE_PREPARATION_FORBIDDEN',
    });
    f.authorization.member = false;
    await expect(api.history(f.prepared, null, f.recheck)).rejects.toMatchObject({
      code: 'NATIVE_PREPARATION_FORBIDDEN',
    });
  });

  it('rejects changed file bytes and incorrect sequence even when the publication ID is current', async () => {
    const f = serialFixture();
    await f.ready();
    const first = await f.publish();
    await expect(
      f.api.revision(f.prepared, { ...target(first.receipt), publicationSequence: 2 }, f.recheck),
    ).rejects.toMatchObject({ code: 'NATIVE_ARTIFACT_REVISION_INVALID' });
    const revision = await f.api.revision(f.prepared, target(first.receipt), f.recheck);
    const file = revision.files[0];
    const read = await f.api.revisionFile(
      f.prepared,
      { ...target(first.receipt), fileId: file.id, sha256: file.sha256 },
      f.recheck,
    );
    expect(read.encoding).toBe('utf8');
    const pointer = [...f.objects.keys()].find((key) => key.includes('/files/'));
    f.objects.set(pointer, Buffer.from('modified'));
    await expect(
      f.api.revisionFile(
        f.prepared,
        { ...target(first.receipt), fileId: file.id, sha256: file.sha256 },
        f.recheck,
      ),
    ).rejects.toMatchObject({ code: 'NATIVE_ARTIFACT_REVISION_INVALID' });
  });

  it('does not leave observations behind when a stale writer loses the execution CAS', async () => {
    const f = serialFixture();
    await f.ready();
    await f.publish();
    await f.respond();
    const claim = await f.store.claim(f.bindingIdentity);
    await f.store.cancel(f.bindingIdentity);
    await expect(f.store.dispatched({ row: claim.row })).rejects.toBeTruthy();
    expect([...f.rows.values()].filter((row) => row.sk.startsWith('ANSWER#'))).toEqual([]);
  });
});

describe('revision query boundary', () => {
  const valid = { publicationId: 'a'.repeat(64), publicationSequence: '1' };
  it.each([
    { publicationId: valid.publicationId },
    { ...valid, publicationSequence: '01' },
    { ...valid, sha256: 'a'.repeat(64) },
    { ...valid, publicationSequence: '9007199254740992' },
    { ...valid, token: 'foreign' },
    { history: '1', ...valid },
  ])('rejects partial or ambiguous publication identity %j', (queryStringParameters) => {
    expect(() => nativeRevisionQuery({ queryStringParameters }, 'publication')).toThrow();
  });
  it('rejects duplicates and accepts explicit pagination and exact file scope', () => {
    expect(() =>
      nativeRevisionQuery(
        {
          queryStringParameters: valid,
          multiValueQueryStringParameters: {
            publicationId: [valid.publicationId, valid.publicationId],
          },
        },
        'publication',
      ),
    ).toThrow();
    expect(
      nativeRevisionQuery(
        { queryStringParameters: { history: '1', beforeSequence: '4' } },
        'publication',
      ),
    ).toEqual({ history: true, before: 4 });
    expect(
      nativeRevisionQuery(
        {
          queryStringParameters: { ...valid, sha256: 'b'.repeat(64) },
          pathParameters: { fileId: 'nf-test' },
        },
        'file',
      ),
    ).toMatchObject({ ...target({ id: valid.publicationId, sequence: 1 }), fileId: 'nf-test' });
  });
});
