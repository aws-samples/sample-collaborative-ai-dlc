import { createHash } from 'node:crypto';
import { beforeEach, expect, it, vi } from 'vitest';
import { nativeHistoryService, type NativeRevision } from './nativeHistory';
const get = vi.hoisted(() => vi.fn());
vi.mock('./api', () => ({ api: { get } }));
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const target = { publicationId: 'a'.repeat(64), publicationSequence: 1 };
const text = '\ufeff# exact\r\n🐦\n';
const descriptor = {
  id: `nf-${'b'.repeat(64)}`,
  sha256: sha(text),
  path: 'plan.custom',
  bytes: Buffer.byteLength(text),
  mediaType: 'application/octet-stream',
  role: 'artifact' as const,
};
const revision: NativeRevision = {
  id: target.publicationId,
  sequence: 1,
  createdAt: '2026-10-01T12:00:00Z',
  files: [descriptor],
  question: null,
  context: {
    projectId: 'project',
    executionId: 'run',
    attemptId: '11111111-1111-4111-8111-111111111111',
    epoch: 1,
    packageId: `sha256:${'f'.repeat(64)}`,
  },
  outcome: 'STOPPED',
  interactionId: null,
};
const content = () => ({
  ...descriptor,
  ...target,
  fileId: descriptor.id,
  encoding: 'utf8',
  content: text,
  truncated: false,
});
beforeEach(() => {
  get.mockReset();
});
it('uses authenticated domain routes and preserves verified BOM, Unicode and line endings', async () => {
  get.mockResolvedValueOnce(revision).mockResolvedValueOnce(content());
  expect(await nativeHistoryService.revision('project', 'run', target)).toEqual(revision);
  const read = await nativeHistoryService.file('project', 'run', revision, descriptor);
  expect(read.content).toBe(text);
  expect(get.mock.calls[1][0]).toContain(
    `/files/${descriptor.id}?publicationId=${target.publicationId}&publicationSequence=1&sha256=${descriptor.sha256}`,
  );
});
it.each([
  { content: '# replacement' },
  { truncated: true },
  { fileId: `nf-${'c'.repeat(64)}` },
  { publicationId: 'c'.repeat(64) },
  { publicationSequence: 2 },
  { sha256: 'c'.repeat(64) },
  { path: 'another-path' },
  { bytes: 10 },
  { encoding: 'base64', content: 'YQ==' },
])('rejects mismatched or partial bytes %j', async (patch) => {
  get.mockResolvedValue({ ...content(), ...patch });
  await expect(nativeHistoryService.file('project', 'run', revision, descriptor)).rejects.toThrow(
    'could not be verified',
  );
});
it.each(['projectId', 'executionId', 'attemptId', 'packageId', 'epoch'])(
  'rejects foreign or invalid revision context %s',
  async (field) => {
    get.mockResolvedValue({ ...revision, context: { ...revision.context, [field]: 'foreign' } });
    await expect(nativeHistoryService.revision('project', 'run', target)).rejects.toThrow();
  },
);
it.each([
  { encoding: 'binary', content: null },
  { encoding: 'too_large', content: null, bytes: 3 * 1024 * 1024 + 1 },
])('describes unavailable previews without transporting bytes: %j', async (patch) => {
  const file = { ...descriptor, ...(patch.bytes ? { bytes: patch.bytes } : {}) };
  get.mockResolvedValue({ ...content(), ...patch });
  expect(await nativeHistoryService.file('project', 'run', revision, file)).toMatchObject({
    encoding: patch.encoding,
    content: null,
  });
});
it('validates page ordering and strict continuation without turning a failed read into empty history', async () => {
  const item = {
    id: target.publicationId,
    sequence: 1,
    filesCount: 1,
    epoch: 1,
    outcome: 'STOPPED',
    admittedAt: null,
    interactionId: null,
  };
  get.mockResolvedValue({ items: [item], nextBefore: null, gaps: [] });
  expect((await nativeHistoryService.list('project', 'run', 2)).items).toEqual([item]);
  get.mockResolvedValue({ items: [item, item], nextBefore: null, gaps: [] });
  await expect(nativeHistoryService.list('project', 'run')).rejects.toThrow();
  get.mockResolvedValue({ items: [item], nextBefore: 3, gaps: [] });
  await expect(nativeHistoryService.list('project', 'run')).rejects.toThrow();
  get.mockRejectedValue(new Error('unavailable'));
  await expect(nativeHistoryService.list('project', 'run')).rejects.toThrow('unavailable');
});
it('keeps a retained missing interaction explicit', async () => {
  get.mockResolvedValue({ interaction: null, answer: null });
  expect(await nativeHistoryService.decision('project', 'run', revision)).toEqual({
    interaction: null,
    answer: null,
  });
  await expect(
    nativeHistoryService.decision('project', 'run', { ...revision, interactionId: 'd'.repeat(64) }),
  ).rejects.toThrow();
});

const turn = {
  id: 'e'.repeat(64),
  sequence: 1,
  kind: 'assistant_turn',
  harness: 'codex',
  publicationId: target.publicationId,
  createdAt: revision.createdAt,
  messages: [{ text: 'Exact proposal', type: 'text' }],
  contentSha256: sha(JSON.stringify([{ text: 'Exact proposal', type: 'text' }])),
};
const accepted = () => ({
  id: '22222222-2222-4222-8222-222222222222',
  interactionId: turn.id,
  sequence: 2,
  actorId: 'member',
  text: 'Request changes',
  acceptedAt: revision.createdAt,
  context: { ...target, contentSha256: turn.contentSha256, epoch: 1, membershipRecorded: true },
  deliveryStatus: 'unknown',
  deliveredAt: null,
  uncertainAt: null,
  resultingPublication: null,
  applicationStatus: 'not_recorded',
  rejectionStatus: 'not_recorded',
  approvalStatus: 'not_recorded',
});
it('keeps accepted, uncertain and delivered records separate from missing engine application', async () => {
  for (const deliveryStatus of ['unknown', 'pending', 'uncertain', 'delivered']) {
    get.mockResolvedValue({ interaction: turn, answer: { ...accepted(), deliveryStatus } });
    const value = await nativeHistoryService.decision('project', 'run', {
      ...revision,
      interactionId: turn.id,
    });
    expect(value.answer).toMatchObject({
      deliveryStatus,
      applicationStatus: 'not_recorded',
      rejectionStatus: 'not_recorded',
    });
  }
});
it.each([
  { interactionId: 'f'.repeat(64) },
  { sequence: 3 },
  { acceptedAt: 'unknown' },
  { applicationStatus: 'applied' },
  { approvalStatus: 'approved' },
  { rejectionStatus: 'rejected' },
  { context: { ...accepted().context, publicationId: 'f'.repeat(64) } },
  {
    resultingPublication: {
      publicationId: 'f'.repeat(64),
      publicationSequence: 3,
      recordedAt: revision.createdAt,
    },
  },
])('rejects mismatched answer provenance or invented outcome %j', async (patch) => {
  get.mockResolvedValue({ interaction: turn, answer: { ...accepted(), ...patch } });
  await expect(
    nativeHistoryService.decision('project', 'run', { ...revision, interactionId: turn.id }),
  ).rejects.toThrow();
});
