import { expect, it, vi } from 'vitest';
import { api } from './api';
import { decodeNativeResult, nativeResultsService } from './nativeResults';
const request = {
  requestId: '10000000-0000-4000-8000-000000000001',
  publicationId: 'a'.repeat(64),
  publicationSequence: 2,
};
const valid = () => ({
  projectId: 'project',
  executionId: 'run',
  ...request,
  status: 'ready',
  download: {
    filename: 'result.zip',
    bytes: 10,
    sha256: 'c'.repeat(64),
    downloadUrl: `https://results.s3.us-east-1.amazonaws.com/native-results/v1/${'b'.repeat(64)}/${'c'.repeat(64)}?signature=example`,
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
  },
});
it('accepts an exact scope-bound result without caching its bearer URL', () => {
  expect(decodeNativeResult(valid(), 'project', 'run', request).status).toBe('ready');
});
it.each([
  { projectId: 'other' },
  { executionId: 'other' },
  { publicationId: 'd'.repeat(64) },
  { publicationSequence: 3 },
  { requestId: 'another' },
])('rejects stale or foreign result identity %j', (patch) => {
  expect(() => decodeNativeResult({ ...valid(), ...patch }, 'project', 'run', request)).toThrow();
});
it.each([
  { sha256: 'wrong' },
  { bytes: 261 * 1024 * 1024 },
  { expiresAt: 'invalid' },
  { expiresAt: '2020-01-01T00:00:00Z' },
  { expiresAt: '2100-01-01T00:00:00Z' },
  { downloadUrl: 'javascript:alert(1)' },
  { downloadUrl: 'https://foreign.example/file' },
  { filename: '../escape' },
])('rejects an invalid, expired or redirected download %j', (patch) => {
  const value = valid();
  Object.assign(value.download, patch);
  expect(() => decodeNativeResult(value, 'project', 'run', request)).toThrow();
});
it('binds a binary download checksum and length to the selected file', () => {
  const file = {
    id: 'nf-' + 'd'.repeat(64),
    path: 'file.bin',
    bytes: 10,
    sha256: 'c'.repeat(64),
    role: 'code' as const,
    mediaType: 'application/octet-stream',
  };
  const named = { ...request, fileId: file.id, sha256: file.sha256 };
  const response = { ...valid(), ...named };
  expect(decodeNativeResult(response, 'project', 'run', named, file).download?.bytes).toBe(10);
  expect(() =>
    decodeNativeResult(response, 'project', 'run', named, { ...file, bytes: 5 }),
  ).toThrow();
});

const executionId = '11111111-1111-4111-8111-111111111111';
const gitRequest = { ...request, format: 'git' as const };
const branch = `aidlc/native-${executionId}`;
const source = {
  provider: 'gitlab',
  repository: 'group/team/repo',
  branch,
  commit: '1'.repeat(64),
};
const delta = '2'.repeat(64);
const prepared = '3'.repeat(64);
const gitResult = () => {
  const archive = valid();
  return {
    ...archive,
    executionId,
    format: 'git',
    download: {
      ...archive.download,
      filename: `native-result-2-${request.publicationId.slice(0, 12)}.bundle`,
    },
    updatedAt: new Date().toISOString(),
    retryAfterSeconds: 3,
    delivery: {
      repository: source,
      sourceBaselineId: '4'.repeat(64),
      branch: `${branch}-result`,
      commit: prepared,
      tree: '5'.repeat(64),
      deltaSha256: delta,
      changeCount: 3,
      publicationOutcome: 'STOPPED',
      verification: {
        sha256: delta,
        terminalSha256: '6'.repeat(64),
        terminal: 'stale',
        workflowCompletion: 'failed',
        applicability: 'captured',
        review: 'not_required',
        reviews: [],
      },
    },
  };
};

it('accepts a SHA-256 bundle on the derived collision branch with stale workflow proof', () => {
  const value = decodeNativeResult(gitResult(), 'project', executionId, gitRequest, { source });
  expect(value.delivery).toMatchObject({
    branch: `${branch}-result`,
    commit: prepared,
    repository: source,
    verification: { terminal: 'stale', workflowCompletion: 'failed' },
  });
  expect(value.download).toBeDefined();
});
it.each([
  { branch },
  { commit: 'a'.repeat(40) },
  { commit: undefined },
  { tree: 'unverified' },
  { repository: { ...source, commit: 'a'.repeat(64) } },
  { repository: { ...source, branch: 'main' } },
  { repository: { ...source, provider: 'github' } },
  { repository: { ...source, repository: 'other/repo' } },
  { deltaSha256: 'a'.repeat(64) },
  { sourceBaselineId: 'bad' },
  { verification: null },
  { observation: { status: 'matched', commit: prepared } },
  { publicationOutcome: 'WAITING_FOR_INPUT' },
])('withholds the bundle on invalid target, proof or unsolicited observation %j', (patch) => {
  const value = gitResult();
  expect(() =>
    decodeNativeResult(
      { ...value, delivery: { ...value.delivery, ...patch } },
      'project',
      executionId,
      gitRequest,
      { source, outcome: 'STOPPED' },
    ),
  ).toThrow();
});
it.each([
  { commit: 'a'.repeat(64) },
  { tree: 'a'.repeat(64) },
  { sourceBaselineId: 'a'.repeat(64) },
  { observation: { status: 'matched', commit: 'a'.repeat(64) } },
  { observation: { status: 'different', commit: prepared } },
  { observation: { status: 'different', commit: 'invalid' } },
  { observation: { status: 'absent', commit: prepared } },
  { observation: { status: 'unknown' } },
  { observation: undefined },
])('rejects an observation of a different prepared result or an inconsistent ref %j', (patch) => {
  const value = gitResult();
  const previous = decodeNativeResult(value, 'project', executionId, gitRequest, {
    source,
  }).delivery;
  expect(() =>
    decodeNativeResult(
      {
        ...value,
        delivery: {
          ...value.delivery,
          observation: { status: 'absent' },
          ...patch,
        },
      },
      'project',
      executionId,
      gitRequest,
      { source, previous },
      true,
    ),
  ).toThrow();
});
it('keeps file, archive and exact Git response formats distinct', () => {
  const git = gitResult();
  expect(() => decodeNativeResult(git, 'project', executionId, request)).toThrow();
  expect(() =>
    decodeNativeResult({ ...git, format: undefined }, 'project', executionId, request),
  ).toThrow();
  expect(() =>
    decodeNativeResult({ ...git, download: valid().download }, 'project', executionId, gitRequest, {
      source,
    }),
  ).toThrow();
});
it('rejects an unnamed publication or unsolicited branch check before issuing a request', async () => {
  const post = vi.spyOn(api, 'post').mockResolvedValue(null);
  const get = vi.spyOn(api, 'get').mockResolvedValue(null);
  try {
    await expect(
      nativeResultsService.request(
        'project',
        executionId,
        { ...gitRequest, publicationId: '' },
        { source },
      ),
    ).rejects.toThrow();
    await expect(
      nativeResultsService.observe(decodeNativeResult(valid(), 'project', 'run', request), {
        source,
      }),
    ).rejects.toThrow();
    const unsolicited = { ...gitRequest, observe: '1' };
    await expect(
      nativeResultsService.status('project', executionId, unsolicited, { source }),
    ).rejects.toThrow();
    expect(post).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  } finally {
    get.mockRestore();
    post.mockRestore();
  }
});
