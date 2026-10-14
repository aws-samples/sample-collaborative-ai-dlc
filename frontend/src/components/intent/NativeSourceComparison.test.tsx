import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NativeSourceComparison } from './NativeSourceComparison';
import { resetSessionExpiry } from '@/services/sessionExpiry';
import type { NativeRevision } from '@/services/nativeHistory';
const mocks = vi.hoisted(() => ({ source: vi.fn(), file: vi.fn() }));
const deferred = () => {
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
vi.mock('@/services/nativeHistory', () => ({ nativeHistoryService: mocks }));
const file = {
  id: 'nf-' + 'd'.repeat(64),
  path: 'unknown.custom',
  sha256: 'e'.repeat(64),
  bytes: 3,
  role: 'code' as const,
  mediaType: 'application/octet-stream',
};
const revision: NativeRevision = {
  id: 'a'.repeat(64),
  sequence: 2,
  createdAt: '2026-10-14T00:00:00Z',
  files: [file],
  question: null,
  outcome: 'STOPPED',
  interactionId: null,
  context: {
    projectId: 'p',
    executionId: 'e',
    attemptId: 'x',
    epoch: 1,
    packageId: 'sha256:' + 'b'.repeat(64),
  },
};
const baseline = {
  id: 'c'.repeat(64),
  repository: { commit: 'f'.repeat(40), branch: 'main' },
  inventory: 'native-public-files',
  files: [{ ...file, sha256: 'f'.repeat(64) }],
};
beforeEach(() => {
  vi.resetAllMocks();
  resetSessionExpiry();
});
afterEach(cleanup);
it('shows missing retained baseline explicitly', async () => {
  mocks.source.mockResolvedValue(null);
  render(
    <NativeSourceComparison
      projectId="p"
      executionId="e"
      revision={revision}
      onAccessFailure={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Compare with pinned source' }));
  await screen.findByText(/No authoritative source baseline/);
  expect(mocks.file).not.toHaveBeenCalled();
});
it('uses the exact source receipt for before bytes and the named publication for after bytes', async () => {
  mocks.source.mockResolvedValue(baseline);
  mocks.file.mockImplementation(async (_p, _e, _r, f, source) => ({
    ...f,
    publicationId: revision.id,
    encoding: 'utf8',
    content: source ? 'old' : 'new',
  }));
  render(
    <NativeSourceComparison
      projectId="p"
      executionId="e"
      revision={revision}
      onAccessFailure={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Compare with pinned source' }));
  fireEvent.click(await screen.findByRole('button', { name: 'changed: unknown.custom' }));
  await screen.findByLabelText('Complete file comparison');
  expect(mocks.file.mock.calls[0][4]).toBe(baseline.id);
  expect(mocks.file.mock.calls[1][4]).toBeUndefined();
});
it('ignores a late baseline from a different publication', async () => {
  const pending = deferred();
  mocks.source.mockReturnValue(pending.promise);
  const rendered = render(
    <NativeSourceComparison
      projectId="p"
      executionId="e"
      revision={revision}
      onAccessFailure={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Compare with pinned source' }));
  rendered.rerender(
    <NativeSourceComparison
      projectId="p"
      executionId="e"
      revision={{ ...revision, id: 'b'.repeat(64), sequence: 3 }}
      onAccessFailure={vi.fn()}
    />,
  );
  await act(async () => {
    pending.resolve(baseline);
  });
  expect(screen.queryByText(/Pinned source fff/)).not.toBeInTheDocument();
});
