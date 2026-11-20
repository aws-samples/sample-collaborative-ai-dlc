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

it('reads a named source baseline and binds original bytes to its exact receipt', async () => {
  get.mockResolvedValue({
    projectId: 'project',
    executionId: 'run',
    ...target,
    status: 'captured',
    baseline: {
      id: 'b'.repeat(64),
      inventory: 'native-public-files',
      repository: { commit: 'c'.repeat(40), branch: 'main' },
      files: [descriptor],
    },
  });
  const source = await nativeHistoryService.source('project', 'run', revision);
  expect(source?.id).toBe('b'.repeat(64));
  expect(get.mock.calls[0][0]).toContain('&source=1');
  get.mockResolvedValue({ ...content(), sourceBaselineId: source!.id });
  expect(
    (await nativeHistoryService.file('project', 'run', revision, descriptor, source!.id)).content,
  ).toBe(text);
  get.mockResolvedValue({ ...content(), sourceBaselineId: 'c'.repeat(64) });
  await expect(
    nativeHistoryService.file('project', 'run', revision, descriptor, source!.id),
  ).rejects.toThrow();
});
it('distinguishes an unretained source baseline from an unreadable one', async () => {
  get.mockResolvedValue({
    projectId: 'project',
    executionId: 'run',
    ...target,
    status: 'not_retained',
    baseline: null,
  });
  expect(await nativeHistoryService.source('project', 'run', revision)).toBeNull();
  get.mockRejectedValue(new Error('Unavailable'));
  await expect(nativeHistoryService.source('project', 'run', revision)).rejects.toThrow(
    'Unavailable',
  );
});

const baselineId = 'b'.repeat(64);
const pin = { commit: 'c'.repeat(40), branch: 'main' };
const executable = { ...descriptor, mode: '100755' as const };
const gitRevision = { ...revision, files: [executable] };
const change = {
  fileId: descriptor.id,
  path: descriptor.path,
  before: { bytes: descriptor.bytes, sha256: descriptor.sha256, mode: '100644' },
  after: { bytes: descriptor.bytes, sha256: descriptor.sha256, mode: '100755' },
};
const git = {
  ...target,
  sourceBaselineId: baselineId,
  repository: { ...pin, provider: 'gitlab', repository: 'group/team/repo' },
  changes: [change],
  sha256: '1'.repeat(64),
  terminalSha256: '1'.repeat(64),
  terminal: 'matched',
  workflowCompletion: 'complete',
  applicability: 'captured',
  review: 'not_required',
  reviews: [],
};
const sourceView = {
  projectId: 'project',
  executionId: 'run',
  ...target,
  status: 'captured',
  reason: null,
  baseline: {
    id: baselineId,
    repository: pin,
    inventory: 'native-public-files',
    files: [{ ...descriptor, mode: '100644' }],
  },
  gitChangeSet: git,
};
const readGit = () => nativeHistoryService.source('project', 'run', gitRevision);

it('requires the selected revision context and a valid baseline ID before a read', async () => {
  await expect(nativeHistoryService.source('other', 'run', gitRevision)).rejects.toThrow();
  await expect(nativeHistoryService.source('project', 'other', gitRevision)).rejects.toThrow();
  await expect(
    nativeHistoryService.file('project', 'run', gitRevision, executable, ''),
  ).rejects.toThrow();
  expect(get).not.toHaveBeenCalled();
});
it.each([
  { publicationId: 'c'.repeat(64) },
  { publicationSequence: 2 },
  { sourceBaselineId: 'c'.repeat(64) },
  { repository: { ...git.repository, commit: 'e'.repeat(40) } },
  { repository: { ...git.repository, branch: 'different' } },
  { repository: { ...git.repository, provider: 'unknown' } },
  { changes: [change, change] },
  { changes: [{ ...change, path: 'foreign.txt' }] },
  { changes: [{ ...change, fileId: `nf-${'9'.repeat(64)}` }] },
  { changes: [{ ...change, before: null }] },
  { changes: [{ ...change, after: null }] },
  { changes: [{ ...change, after: { ...change.after, bytes: 0 } }] },
  { changes: [{ ...change, before: { ...change.before, sha256: '1'.repeat(64) } }] },
  { changes: [{ ...change, before: { ...change.before, mode: '100755' } }] },
  { changes: [{ ...change, after: { ...change.after, mode: '120000' } }] },
  { terminalSha256: '2'.repeat(64) },
  { applicability: 'unknown' },
  { review: 'recorded' },
])(
  'rejects Git changes or claims that do not bind to the selected inventories: %j',
  async (patch) => {
    get.mockResolvedValue({ ...sourceView, gitChangeSet: { ...git, ...patch } });
    await expect(readGit()).rejects.toThrow('could not be verified');
  },
);
it.each([
  { publicationId: 'c'.repeat(64) },
  { publicationSequence: 2 },
  { executionId: 'other' },
  { projectId: 'other' },
  { baseline: null, status: 'not_retained' },
])('rejects a mismatched source response before exposing its evidence: %j', async (patch) => {
  get.mockResolvedValue({ ...sourceView, ...patch });
  await expect(readGit()).rejects.toThrow();
});
it.each([
  'proof_not_recorded',
  'git_observations_not_retained',
  'proof_mismatch',
  'proof_unavailable',
])('keeps captured changes visible when protected proof reports %s', async (reason) => {
  const {
    sha256: _sha,
    terminalSha256: _terminal,
    workflowCompletion: _completion,
    ...unverified
  } = git;
  get.mockResolvedValue({
    ...sourceView,
    gitChangeSet: {
      ...unverified,
      reason,
      terminal: 'not_recorded',
      applicability: 'unknown',
      review: 'not_verified',
    },
  });
  expect((await readGit())?.gitChangeSet).toMatchObject({
    terminal: 'not_recorded',
    review: 'not_verified',
    reviews: [],
    changes: [{ path: descriptor.path, before: { mode: '100644' }, after: { mode: '100755' } }],
  });
});
it('retains the changes from the original Git API without inferring a reviewer requirement', async () => {
  get.mockResolvedValue({
    ...sourceView,
    gitChangeSet: {
      ...target,
      sourceBaselineId: baselineId,
      repository: git.repository,
      changes: [change],
      review: 'not_verified',
    },
  });
  expect((await readGit())?.gitChangeSet).toMatchObject({
    review: 'not_verified',
    applicability: 'unknown',
  });
});
