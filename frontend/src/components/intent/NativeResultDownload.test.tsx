import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NativeResultDownload } from './NativeResultDownload';
import { notifySessionExpired, resetSessionExpiry } from '@/services/sessionExpiry';
import { ApiError } from '@/services/api';
const mocks = vi.hoisted(() => ({ request: vi.fn(), status: vi.fn() }));
const deferred = () => {
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
vi.mock('@/services/nativeResults', () => ({ nativeResultsService: mocks }));
const props = {
  projectId: 'project',
  executionId: 'run',
  target: { publicationId: 'a'.repeat(64), publicationSequence: 1 },
  onAccessFailure: vi.fn(),
};
const ready = {
  status: 'ready',
  download: {
    downloadUrl: 'https://result.example/file',
    bytes: 8,
    sha256: 'b'.repeat(64),
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
  },
};
beforeEach(() => {
  vi.clearAllMocks();
  resetSessionExpiry();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
it('prepares and polls an immutable archive without changing workflow state', async () => {
  vi.useFakeTimers();
  mocks.request.mockResolvedValue({ status: 'pending' });
  mocks.status.mockResolvedValue(ready);
  render(<NativeResultDownload {...props} />);
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Prepare result archive' }));
  });
  expect(mocks.request.mock.calls[0][2]).toMatchObject(props.target);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  expect(screen.getByRole('button', { name: 'Download result archive' })).toBeInTheDocument();
  expect(screen.getByText(/Anyone holding/)).toBeInTheDocument();
});
it('ignores an old result after revision navigation', async () => {
  const pending = deferred();
  mocks.request.mockReturnValue(pending.promise);
  const rendered = render(<NativeResultDownload {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Prepare result archive' }));
  rendered.rerender(
    <NativeResultDownload
      {...props}
      target={{ publicationId: 'c'.repeat(64), publicationSequence: 2 }}
    />,
  );
  await act(async () => {
    pending.resolve(ready);
  });
  expect(screen.queryByRole('button', { name: 'Download result archive' })).not.toBeInTheDocument();
});
it('clears downloads on account/session expiry, including late preparation callbacks', async () => {
  const pending = deferred();
  mocks.request.mockReturnValue(pending.promise);
  render(<NativeResultDownload {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Prepare result archive' }));
  act(() => notifySessionExpired());
  await act(async () => {
    pending.resolve(ready);
  });
  expect(screen.queryByRole('button', { name: 'Download result archive' })).not.toBeInTheDocument();
});
it('expires issued URLs and retries the same immutable request', async () => {
  vi.useFakeTimers();
  mocks.request.mockResolvedValue(ready);
  render(<NativeResultDownload {...props} />);
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Prepare result archive' }));
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(301_000);
  });
  expect(screen.queryByRole('button', { name: 'Download result archive' })).not.toBeInTheDocument();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Retry result archive' }));
  });
  expect(mocks.request.mock.calls[1][2]).toEqual(mocks.request.mock.calls[0][2]);
});
it('propagates denied access and exposes no download', async () => {
  mocks.request.mockRejectedValue(
    new ApiError(403, 'Denied', { code: 'NATIVE_PREPARATION_FORBIDDEN' }),
  );
  render(<NativeResultDownload {...props} />);
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Prepare result archive' }));
  });
  expect(props.onAccessFailure).toHaveBeenCalledOnce();
  expect(screen.queryByRole('button', { name: 'Download result archive' })).not.toBeInTheDocument();
});
