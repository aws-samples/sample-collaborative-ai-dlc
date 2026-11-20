import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ApiError, api } from '@/services/api';
import { clearNativeIntents } from '@/hooks/useNativeIntents';
import { notifySessionExpired, resetSessionExpiry } from '@/services/sessionExpiry';
import type { NativeResultRequest } from '@/services/nativeResults';
import { NativeResultDownload } from './NativeResultDownload';

const member = vi.hoisted(() => ({ id: 'member-a' }));
vi.mock('@/contexts/AuthContext', () => ({
  useOptionalAuth: () => ({ user: { userId: member.id } }),
}));
const projectId = '11111111-1111-4111-8111-111111111111';
const executionId = '22222222-2222-4222-8222-222222222222';
const target = { publicationId: '1'.repeat(64), publicationSequence: 2 };
const repository = {
  provider: 'github',
  repository: 'owner/repo',
  branch: 'main',
  commit: '2'.repeat(40),
};
const git = { source: repository, outcome: 'WAITING_FOR_INPUT' as const };
const props = { projectId, executionId, target, git, onAccessFailure: vi.fn() };
const path = `/projects/${projectId}/native-intents/${executionId}/results`;
const commit = '3'.repeat(40);
const branch = `aidlc/native-${executionId}`;
const delivery = {
  repository,
  branch,
  sourceBaselineId: '4'.repeat(64),
  deltaSha256: '5'.repeat(64),
  publicationOutcome: git.outcome,
  changeCount: 2,
  verification: {
    terminal: 'not_recorded',
    review: 'not_verified',
    applicability: 'unknown',
    reviews: [],
    reason: 'proof_unavailable',
  },
};
const checksum = '6'.repeat(64);
const url = `https://results.s3.us-east-1.amazonaws.com/native-results/v1/${'7'.repeat(64)}/${checksum}?versionId=version1&X-Amz-Expires=300`;
function result(
  request: NativeResultRequest,
  status: 'pending' | 'building' | 'ready' | 'retryable' = 'ready',
) {
  return {
    projectId,
    executionId,
    ...request,
    status,
    updatedAt: new Date().toISOString(),
    retryAfterSeconds: 3,
    delivery: { ...delivery, ...(status === 'ready' ? { commit, tree: '8'.repeat(40) } : {}) },
    ...(status === 'ready'
      ? {
          download: {
            filename: `native-result-${target.publicationSequence}-${target.publicationId.slice(0, 12)}.bundle`,
            bytes: 1234,
            sha256: checksum,
            downloadUrl: url,
            expiresAt: new Date(Date.now() + 300_000).toISOString(),
          },
        }
      : {}),
  };
}
const post = vi.spyOn(api, 'post');
const get = vi.spyOn(api, 'get');
const namedRequest = () => post.mock.calls[0][1] as NativeResultRequest;
const click = async (name: string) => {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }));
  });
};
const query = (call: number) => {
  const [route, queryString] = get.mock.calls[call][0].split('?');
  expect(route).toBe(path);
  return Object.fromEntries(new URLSearchParams(queryString));
};
beforeEach(() => {
  resetSessionExpiry();
  member.id = 'member-a';
  props.onAccessFailure.mockReset();
  get.mockReset();
  post
    .mockReset()
    .mockImplementation(async (_path, request) => result(request as NativeResultRequest));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('prepares one named bundle, polls only its job, and downloads its verified bytes on click', async () => {
  vi.useFakeTimers();
  post.mockImplementationOnce(async (_path, request) =>
    result(request as NativeResultRequest, 'pending'),
  );
  get
    .mockImplementationOnce(async () => result(namedRequest(), 'building'))
    .mockImplementationOnce(async () => result(namedRequest()));
  render(<NativeResultDownload {...props} />);
  expect(screen.getByRole('button', { name: 'Prepare result archive' })).toBeVisible();
  expect(get).not.toHaveBeenCalled();
  expect(post).not.toHaveBeenCalled();
  await click('Prepare Git bundle');
  expect(post).toHaveBeenCalledExactlyOnceWith(path, {
    ...target,
    requestId: expect.any(String),
    format: 'git',
  });
  expect(screen.getByRole('button', { name: 'Preparing Git bundle…' })).toBeDisabled();
  expect(screen.queryByRole('button', { name: 'Compare remote branch' })).toBeNull();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(6000);
  });
  const fromRequest = { ...namedRequest(), publicationSequence: '2' };
  expect(query(0)).toEqual(fromRequest);
  expect(query(1)).toEqual(fromRequest);
  expect(screen.getByText(/github · owner\/repo · main/)).toHaveTextContent(repository.commit);
  expect(screen.getByText(branch)).toBeVisible();
  expect(screen.getByText(commit)).toBeVisible();
  expect(screen.getByText('Workflow evidence unavailable.')).toBeVisible();
  expect(screen.getByText(/1234 bytes/)).toHaveTextContent(checksum);
  const assign = vi.fn();
  vi.stubGlobal('window', Object.create(window, { location: { value: { assign } } }));
  await click('Download Git bundle');
  expect(assign).toHaveBeenCalledExactlyOnceWith(url);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(305_000);
  });
  expect(screen.queryByRole('button', { name: 'Download Git bundle' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Compare remote branch' })).toBeVisible();
  expect(get).toHaveBeenCalledTimes(2);
  await click('Retry Git bundle');
  expect(post.mock.calls[1]).toEqual(post.mock.calls[0]);
  expect(screen.getByRole('button', { name: 'Download Git bundle' })).toBeVisible();
});

it.each([
  [{ status: 'matched', commit }, 'Remote branch matched the prepared commit.'],
  [
    { status: 'different', commit: '9'.repeat(40) },
    `Remote branch pointed to a different commit · ${'9'.repeat(40)}`,
  ],
  [{ status: 'absent' }, 'Remote branch was absent.'],
  [{ status: 'unavailable' }, 'Remote branch comparison unavailable.'],
])('compares the exact prepared branch only on request (%j)', async (observation, label) => {
  render(<NativeResultDownload {...props} />);
  await click('Prepare Git bundle');
  expect(get).not.toHaveBeenCalled();
  get.mockImplementationOnce(async () => {
    const ready = result(namedRequest());
    return { ...ready, delivery: { ...ready.delivery, observation } };
  });
  await click('Compare remote branch');
  expect(get).toHaveBeenCalledOnce();
  expect(query(0)).toEqual({ ...namedRequest(), publicationSequence: '2', observe: '1' });
  expect(screen.getByRole('status')).toHaveTextContent(String(label));
  expect(screen.getByRole('button', { name: 'Download Git bundle' })).toBeVisible();
  expect(post).toHaveBeenCalledOnce();
});

it('can compare the retained prepared commit while its download is retryable', async () => {
  render(<NativeResultDownload {...props} />);
  await click('Prepare Git bundle');
  const ready = result(namedRequest());
  get.mockResolvedValueOnce({
    ...result(namedRequest(), 'retryable'),
    delivery: { ...ready.delivery, observation: { status: 'matched', commit } },
  });
  await click('Compare remote branch');
  expect(screen.getByText(/Remote branch matched/)).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Download Git bundle' })).toBeNull();
  await click('Retry Git bundle');
  expect(post.mock.calls[1]).toEqual(post.mock.calls[0]);
});

it('retries an interrupted preparation and withholds a status response for a different baseline', async () => {
  vi.useFakeTimers();
  post
    .mockRejectedValueOnce(new ApiError(503, 'Retry the same request'))
    .mockImplementationOnce(async (_path, request) =>
      result(request as NativeResultRequest, 'pending'),
    );
  render(<NativeResultDownload {...props} />);
  await click('Prepare Git bundle');
  expect(screen.getByRole('alert')).toHaveTextContent('Retry the same request');
  await click('Retry Git bundle');
  const ready = result(namedRequest());
  get.mockResolvedValueOnce({
    ...ready,
    delivery: { ...ready.delivery, sourceBaselineId: 'a'.repeat(64) },
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  expect(screen.getByRole('alert')).toHaveTextContent('could not be verified');
  expect(screen.queryByRole('button', { name: 'Download Git bundle' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Compare remote branch' })).toBeNull();
  await click('Retry Git bundle');
  expect(screen.getByText(commit)).toBeVisible();
  expect(post.mock.calls[1]).toEqual(post.mock.calls[0]);
  expect(post.mock.calls[2]).toEqual(post.mock.calls[0]);
  expect(get).toHaveBeenCalledOnce();
});

it.each([
  [
    'NATIVE_RESULT_GIT_BASE_UNAVAILABLE',
    'The Git objects for the pinned Start source were not retained',
  ],
  ['NATIVE_RESULT_GIT_DELTA_UNAVAILABLE', 'This publication has no exact Git change set'],
])(
  'reports the named historical publication failure %s and preserves its archive action',
  async (code, message) => {
    post.mockRejectedValueOnce(new ApiError(409, message, { code, error: message }));
    render(<NativeResultDownload {...props} />);
    await click('Prepare Git bundle');
    expect(screen.getByRole('alert')).toHaveTextContent(message);
    expect(screen.getByRole('button', { name: 'Prepare result archive' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Retry Git bundle' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Download Git bundle' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Compare remote branch' })).toBeNull();
    expect(get).not.toHaveBeenCalled();
    expect(props.onAccessFailure).not.toHaveBeenCalled();
  },
);

it('ignores a late denial from the previous member after the new member prepares a result', async () => {
  const view = render(<NativeResultDownload {...props} />);
  await click('Prepare Git bundle');
  let reject!: (err: unknown) => void;
  get.mockReturnValueOnce(
    new Promise((_done, fail) => {
      reject = fail;
    }),
  );
  await click('Compare remote branch');
  member.id = 'member-b';
  view.rerender(<NativeResultDownload {...props} />);
  await click('Prepare Git bundle');
  expect(post.mock.calls[1][1]).not.toEqual(namedRequest());
  await act(async () => reject(new ApiError(403, 'Access denied')));
  expect(props.onAccessFailure).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Download Git bundle' })).toBeVisible();
});

it.each([401, 403, 404])(
  'clears prepared metadata and downloads after denied observation (%s)',
  async (status) => {
    render(<NativeResultDownload {...props} />);
    await click('Prepare Git bundle');
    const denied = new ApiError(status, 'Unavailable');
    get.mockRejectedValueOnce(denied);
    await click('Compare remote branch');
    expect(props.onAccessFailure).toHaveBeenCalledExactlyOnceWith(denied);
    expect(screen.queryByRole('button', { name: 'Download Git bundle' })).toBeNull();
    expect(screen.queryByText(commit)).toBeNull();
    expect(screen.queryByText(repository.commit)).toBeNull();
  },
);

it.each(['member', 'space', 'publication', 'expiry', 'revocation'])(
  'discards a late branch check after %s changes',
  async (change) => {
    const view = render(<NativeResultDownload {...props} />);
    await click('Prepare Git bundle');
    const ready = result(namedRequest());
    let resolve!: (value: unknown) => void;
    get.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await click('Compare remote branch');
    if (change === 'member') member.id = 'member-b';
    if (change === 'expiry') act(() => notifySessionExpired());
    if (change === 'revocation') act(() => clearNativeIntents(projectId, true));
    view.rerender(
      <NativeResultDownload
        {...props}
        projectId={change === 'space' ? 'space-b' : projectId}
        target={
          change === 'publication'
            ? { publicationId: 'a'.repeat(64), publicationSequence: 3 }
            : target
        }
      />,
    );
    expect(screen.queryByText(commit)).toBeNull();
    await act(async () =>
      resolve({
        ...ready,
        delivery: { ...ready.delivery, observation: { status: 'matched', commit } },
      }),
    );
    expect(screen.queryByRole('button', { name: 'Download Git bundle' })).toBeNull();
    expect(screen.queryByText(/Remote branch matched/)).toBeNull();
    expect(post).toHaveBeenCalledOnce();
    expect(get).toHaveBeenCalledOnce();
  },
);
