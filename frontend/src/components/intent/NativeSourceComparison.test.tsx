import { createHash } from 'node:crypto';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { NativeSourceComparison } from './NativeSourceComparison';
import { clearNativeIntents } from '@/hooks/useNativeIntents';
import { ApiError } from '@/services/api';
import { resetSessionExpiry } from '@/services/sessionExpiry';
import { nativeHistoryService, type NativeRevision } from '@/services/nativeHistory';
import type { NativePublishedFile } from '@/services/nativeIntents';

const mocks = vi.hoisted(() => ({ get: vi.fn(), user: 'member-a' }));
vi.mock('@/services/api', async (load) => ({
  ...(await load<typeof import('@/services/api')>()),
  api: { get: mocks.get },
}));
vi.mock('@/contexts/AuthContext', () => ({
  useOptionalAuth: () => ({ user: { userId: mocks.user } }),
}));

const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const projectId = 'p',
  executionId = '11111111-1111-4111-8111-111111111111';
const descriptor = (
  path: string,
  content: string | Buffer,
  mode: '100644' | '100755' = '100644',
): NativePublishedFile => ({
  id: `nf-${sha(JSON.stringify({ executionId, path, projectId }))}`,
  path,
  mode,
  sha256: sha(content),
  bytes: Buffer.byteLength(content),
  role: 'code',
  mediaType: path.endsWith('.sh') ? 'text/plain' : 'application/octet-stream',
});
const baseScript = descriptor('run.sh', '#!/bin/sh\n');
const executable = { ...baseScript, mode: '100755' as const };
const oldFile = descriptor('changed.sh', 'before\n', '100755');
const newFile = descriptor('changed.sh', 'after\n');
const deleted = descriptor('removed.bin', Buffer.from([0, 255]));
const empty = descriptor('empty', '');
const diagnostic = descriptor('aidlc/work/.aidlc-engine/diagnostic.json', '{}');
const revision: NativeRevision = {
  id: sha('publication 2'),
  sequence: 2,
  createdAt: '2026-10-14T00:00:00Z',
  files: [executable, newFile, empty, diagnostic],
  question: null,
  filesystemPolicy: 'node-dependencies-v1',
  outcome: 'STOPPED',
  interactionId: null,
  context: {
    projectId,
    executionId,
    attemptId: '22222222-2222-4222-8222-222222222222',
    epoch: 1,
    packageId: `sha256:${sha('package')}`,
  },
};
const target = { publicationId: revision.id, publicationSequence: revision.sequence };
const baseline = {
  id: sha('baseline'),
  repository: { commit: 'f'.repeat(40), branch: 'main' },
  inventory: 'native-public-files',
  files: [baseScript, deleted, oldFile],
};
const change = (before: NativePublishedFile | null, after: NativePublishedFile | null) => {
  const version = (file: NativePublishedFile | null) =>
    file && { mode: file.mode, bytes: file.bytes, sha256: file.sha256 };
  const file = (before ?? after)!;
  return { path: file.path, fileId: file.id, before: version(before), after: version(after) };
};
const git = {
  ...target,
  sourceBaselineId: baseline.id,
  repository: { ...baseline.repository, provider: 'github', repository: 'org/app' },
  changes: [
    change(oldFile, newFile),
    change(null, empty),
    change(deleted, null),
    change(baseScript, executable),
  ],
  sha256: sha('delta'),
  terminalSha256: sha('delta'),
  terminal: 'matched',
  workflowCompletion: 'complete',
  applicability: 'captured',
  review: 'not_required',
  reviews: [],
};
const review = {
  reviewer: 'aidlc-product-lead-agent',
  stage: 'requirements-analysis',
  unit: null,
  class: 'advisory',
  status: 'ready',
  verdict: 'READY',
  inspectedSha256: sha('scoped'),
  coverage: 'scoped',
  freshness: 'current',
};
const source = (gitChangeSet: unknown = git) => ({
  projectId,
  executionId,
  ...target,
  baseline,
  gitChangeSet,
  status: 'captured',
  reason: null,
});
const route = `/projects/${projectId}/native-intents/${executionId}`;
const named = `publicationId=${revision.id}&publicationSequence=2`;
const fileRoute = (file: NativePublishedFile, original = false) =>
  `${route}/files/${file.id}?${named}&sha256=${file.sha256}${original ? '&source=1' : ''}`;
const bytes = (file: NativePublishedFile, content: string | null, original = false) => ({
  ...target,
  fileId: file.id,
  path: file.path,
  bytes: file.bytes,
  sha256: file.sha256,
  mediaType: file.mediaType,
  encoding: content === null ? 'binary' : 'utf8',
  content,
  truncated: false,
  ...(original && { sourceBaselineId: baseline.id }),
});
const props = { projectId, executionId, revision, onAccessFailure: vi.fn() };
const load = () =>
  fireEvent.click(screen.getByRole('button', { name: 'Compare with pinned source' }));
const clickFile = async (name: string) =>
  fireEvent.click(await screen.findByRole('button', { name }));
beforeEach(() => {
  vi.resetAllMocks();
  resetSessionExpiry();
  mocks.user = 'member-a';
});

it('compares only the captured Git paths and reads the exact source and publication versions on demand', async () => {
  mocks.get.mockResolvedValueOnce(revision).mockResolvedValueOnce(source());
  const selected = await nativeHistoryService.revision(projectId, executionId, target);
  render(<NativeSourceComparison {...props} revision={selected} />);
  load();
  await screen.findByText('Captured Git changes');
  expect(mocks.get.mock.calls.map(([url]) => url)).toEqual([
    `${route}/publication?${named}`,
    `${route}/publication?${named}&source=1`,
  ]);
  expect(screen.queryByText(/diagnostic\.json/)).not.toBeInTheDocument();
  expect(screen.getByText('Exact match')).toBeVisible();
  expect(screen.getByText('No reviewer required')).toBeVisible();
  expect(screen.getByText('Not assessed')).toBeVisible();

  mocks.get
    .mockResolvedValueOnce(bytes(baseScript, '#!/bin/sh\n', true))
    .mockResolvedValueOnce(bytes(executable, '#!/bin/sh\n'));
  await clickFile('Mode changed (regular → executable): run.sh');
  expect(await screen.findByText('Identical verified bytes.')).toBeVisible();
  expect(mocks.get.mock.calls.slice(-2)).toEqual([
    [fileRoute(baseScript, true)],
    [fileRoute(executable)],
  ]);

  mocks.get
    .mockResolvedValueOnce(bytes(oldFile, 'before\n', true))
    .mockResolvedValueOnce(bytes(newFile, 'after\n'));
  await clickFile('Bytes and mode changed (executable → regular): changed.sh');
  const compared = await screen.findByRole('region', { name: 'Complete file comparison' });
  expect(compared.querySelector('del')).toHaveTextContent('before');
  expect(compared.querySelector('ins')).toHaveTextContent('after');

  mocks.get.mockResolvedValueOnce(bytes(deleted, null, true));
  await clickFile('Deleted (regular): removed.bin');
  expect(await screen.findByText(/file is binary/)).toBeVisible();
  expect(mocks.get.mock.lastCall).toEqual([fileRoute(deleted, true)]);

  mocks.get.mockResolvedValueOnce(bytes(empty, ''));
  await clickFile('Added (regular): empty');
  expect(await screen.findByText('Before (file absent)')).toBeVisible();
  expect(screen.getByText('After')).toBeVisible();
  expect(mocks.get.mock.lastCall).toEqual([fileRoute(empty)]);
});

it('displays each applicable reviewer, stage, verdict, scope and freshness independently', async () => {
  mocks.get.mockResolvedValue(
    source({
      ...git,
      review: 'recorded',
      reviews: [
        review,
        {
          ...review,
          reviewer: 'aidlc-code-reviewer',
          stage: 'construction',
          unit: 'web',
          class: 'adversarial',
          coverage: 'full',
          inspectedSha256: git.sha256,
          status: 'concerns',
          verdict: 'NOT-READY',
        },
      ],
    }),
  );
  render(<NativeSourceComparison {...props} />);
  load();
  const rows = within(await screen.findByRole('list', { name: 'Reviewer coverage' })).getAllByRole(
    'listitem',
  );
  expect(rows[0]).toHaveTextContent('aidlc-product-lead-agent · requirements-analysis · advisory');
  expect(rows[0]).toHaveTextContent('Stage-scoped changes · Verdict READY · Freshness current');
  expect(rows[1]).toHaveTextContent('aidlc-code-reviewer · construction / web · adversarial');
  expect(rows[1]).toHaveTextContent('Full change set · Verdict NOT-READY · Freshness current');
  expect(screen.getByText('Reviews recorded')).toBeVisible();
  expect(
    screen.queryByRole('button', { name: /deliver|pull request|approve/i }),
  ).not.toBeInTheDocument();
});
it('shows a stale terminal and stale reviewer verdict even when workflow completion is complete', async () => {
  mocks.get.mockResolvedValue(
    source({
      ...git,
      terminalSha256: sha('earlier'),
      terminal: 'stale',
      review: 'not_verified',
      reviews: [{ ...review, coverage: 'unknown', freshness: 'stale' }],
    }),
  );
  render(<NativeSourceComparison {...props} />);
  load();
  await screen.findByText('Coverage unknown · Verdict READY · Freshness stale');
  expect(screen.getByText('complete')).toBeVisible();
  expect(screen.getByText('Stale')).toBeVisible();
  expect(screen.getByText('Not verified')).toBeVisible();
  expect(screen.getByText('Not assessed')).toBeVisible();
});
it('distinguishes unknown reviewer requirements from a captured plan requiring no reviewer', async () => {
  mocks.get.mockResolvedValue(
    source({
      ...git,
      applicability: 'unknown',
      review: 'not_verified',
      terminal: 'not_recorded',
      terminalSha256: null,
      workflowCompletion: 'not_verified',
    }),
  );
  render(<NativeSourceComparison {...props} />);
  load();
  expect(await screen.findByText('Not recorded')).toBeVisible();
  expect(screen.getByText('Requirements unknown')).toBeVisible();
  expect(screen.queryByText('No reviewer required')).not.toBeInTheDocument();
});
it('shows a byte-only edit and reads only the original bytes of a text deletion', async () => {
  const modified = descriptor(baseScript.path, 'edited\n');
  const namedRevision = { ...revision, files: [modified] };
  mocks.get.mockResolvedValueOnce({
    ...source({ ...git, changes: [change(oldFile, null), change(baseScript, modified)] }),
    baseline: { ...baseline, files: [oldFile, baseScript] },
  });
  render(<NativeSourceComparison {...props} revision={namedRevision} />);
  load();
  expect(await screen.findByRole('button', { name: 'Bytes changed: run.sh' })).toBeVisible();
  mocks.get.mockResolvedValueOnce(bytes(oldFile, 'before\n', true));
  await clickFile('Deleted (executable): changed.sh');
  expect(await screen.findByText('After (file absent)')).toBeVisible();
  expect(screen.getByLabelText('Complete file comparison').querySelector('del')).toHaveTextContent(
    'before',
  );
  expect(mocks.get.mock.calls.slice(1)).toEqual([[fileRoute(oldFile, true)]]);
});
it('keeps the newer file selection when an earlier read finishes last', async () => {
  let resolve!: (value: unknown) => void;
  mocks.get
    .mockResolvedValueOnce(source())
    .mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    )
    .mockResolvedValueOnce(bytes(deleted, null, true));
  render(<NativeSourceComparison {...props} />);
  load();
  await clickFile('Added (regular): empty');
  await clickFile('Deleted (regular): removed.bin');
  await screen.findByText(/file is binary/);
  await act(async () => resolve(bytes(empty, '')));
  expect(screen.getByLabelText('Source change removed.bin')).toBeVisible();
  expect(screen.queryByLabelText('Source change empty')).not.toBeInTheDocument();
});
it('keeps an empty captured change set distinct from a legacy public file inventory', async () => {
  mocks.get.mockResolvedValueOnce({
    ...source({ ...git, changes: [] }),
    baseline: { ...baseline, files: revision.files },
  });
  render(<NativeSourceComparison {...props} />);
  load();
  await screen.findByText('No Git changes were captured.');
  expect(screen.queryByRole('button', { name: /run\.sh/ })).not.toBeInTheDocument();
  mocks.get.mockResolvedValueOnce(source(null));
  load();
  expect(await screen.findByRole('button', { name: 'identical: run.sh' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'deleted: removed.bin' })).toBeVisible();
  expect(screen.queryByLabelText('Git change set evidence')).not.toBeInTheDocument();
  mocks.get
    .mockResolvedValueOnce(bytes(oldFile, 'before\n', true))
    .mockResolvedValueOnce(bytes(newFile, 'after\n'));
  await clickFile('changed: changed.sh');
  expect(await screen.findByLabelText('Complete file comparison')).toBeVisible();
});
it('shows a missing baseline without requesting file bytes', async () => {
  mocks.get.mockResolvedValue({
    ...source(null),
    status: 'not_retained',
    reason: 'not_recorded',
    baseline: null,
  });
  render(<NativeSourceComparison {...props} />);
  load();
  expect(await screen.findByText(/No authoritative source baseline/)).toBeVisible();
  expect(mocks.get).toHaveBeenCalledOnce();
});
it('withholds all rows and file requests on a nested baseline mismatch', async () => {
  mocks.get.mockResolvedValue(source({ ...git, sourceBaselineId: sha('foreign') }));
  render(<NativeSourceComparison {...props} />);
  load();
  await screen.findByRole('alert');
  expect(screen.queryByText(/run\.sh/)).not.toBeInTheDocument();
  expect(screen.queryByText('No reviewer required')).not.toBeInTheDocument();
  expect(mocks.get).toHaveBeenCalledOnce();
});
it('clears the evidence and propagates a denied file read to the member view', async () => {
  const error = new ApiError(403, 'Access denied');
  mocks.get.mockResolvedValueOnce(source()).mockRejectedValueOnce(error);
  render(<NativeSourceComparison {...props} />);
  load();
  await clickFile('Deleted (regular): removed.bin');
  await screen.findByRole('alert');
  expect(props.onAccessFailure).toHaveBeenCalledWith(error);
  expect(screen.queryByText('Captured Git changes')).not.toBeInTheDocument();
});
it.each(['publication', 'sequence', 'account', 'session', 'revocation'])(
  'removes displayed evidence and discards a pending file on %s change',
  async (scope) => {
    let resolve!: (value: unknown) => void;
    mocks.get.mockResolvedValueOnce(source()).mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const ui = render(<NativeSourceComparison {...props} />);
    load();
    await clickFile('Added (regular): empty');
    if (scope === 'account') mocks.user = 'member-b';
    if (scope === 'session') act(() => resetSessionExpiry());
    if (scope === 'revocation') act(() => clearNativeIntents(projectId, true));
    ui.rerender(
      <NativeSourceComparison
        {...props}
        revision={{
          ...revision,
          id: scope === 'publication' ? sha('new') : revision.id,
          sequence: scope === 'sequence' ? 3 : revision.sequence,
        }}
      />,
    );
    await act(async () => resolve(bytes(empty, '')));
    expect(screen.queryByText('Captured Git changes')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Source change empty')).not.toBeInTheDocument();
    expect(props.onAccessFailure).not.toHaveBeenCalled();
  },
);
it('ignores a late baseline from a different publication', async () => {
  let resolve!: (v: unknown) => void;
  mocks.get.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const ui = render(<NativeSourceComparison {...props} />);
  load();
  ui.rerender(
    <NativeSourceComparison {...props} revision={{ ...revision, id: sha('new'), sequence: 3 }} />,
  );
  await act(async () => resolve(source()));
  expect(screen.queryByLabelText('Git change set evidence')).not.toBeInTheDocument();
});
