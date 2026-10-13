import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Link, MemoryRouter, Route, Routes } from 'react-router';
import { ApiError } from '@/services/api';
import type { NativeIntent } from '@/services/nativeIntents';
import {
  clearNativeIntents,
  getNativeListing,
  refreshNativeIntents,
} from '@/hooks/useNativeIntents';
const get = vi.fn();
const prepare = vi.fn();
const list = vi.fn();
// Shared drafts: in-memory Yjs relay + textarea stand-in (see test/collaborationFakes).
vi.mock('@/hooks/useYjsDocument', async () => await import('@/test/collaborationFakes'));
vi.mock(
  '@/components/CollaborativeTextarea',
  async () => await import('@/test/collaborationFakes'),
);
vi.mock('@/services/nativeIntents', () => ({
  nativeIntentsService: {
    get: (...a: unknown[]) => get(...a),
    prepare: (...a: unknown[]) => prepare(...a),
    list: (...a: unknown[]) => list(...a),
  },
}));
import NativeIntentPage from './NativeIntentPage';

const draft: NativeIntent = {
  id: 'run-1',
  projectId: 'project-1',
  executionBackend: 'native',
  title: 'Game',
  prompt: 'Build a game',
  harness: 'kiro',
  status: 'DRAFT',
  package: {
    version: '2.9.0',
    source: {
      provider: 'github',
      repository: 'awslabs/aidlc-workflows',
      release: 'v2.9.0',
    },
  },
  createdAt: '2026-09-28T12:00:00.000Z',
  updatedAt: '2026-09-28T12:00:00.000Z',
};
const renderPage = ({ navigation = false } = {}) =>
  render(
    <MemoryRouter initialEntries={['/space/project-1/native-intent/run-1']}>
      {navigation && (
        <Link to="/space/project-1/native-intent/run-2">Open another native intent</Link>
      )}
      <Routes>
        <Route path="/space/:projectId/native-intent/:intentId" element={<NativeIntentPage />} />
      </Routes>
    </MemoryRouter>,
  );
beforeEach(() => {
  vi.resetAllMocks();
  clearNativeIntents();
  get.mockResolvedValue(draft);
});
it('hides READY details on background listing denial and rejects a pre-denial detail response', async () => {
  get.mockResolvedValue({ ...draft, status: 'READY' });
  renderPage();
  await screen.findByText(draft.prompt);
  const oldGet = deferred<NativeIntent>();
  get.mockReturnValueOnce(oldGet.promise);
  await clickButton('Refresh status');
  list.mockRejectedValue(new ApiError(403, 'Not a member'));
  await act(async () => {
    await refreshNativeIntents('project-1', 'refresh', true);
  });
  expectProtectedContentCleared();
  await act(async () => {
    oldGet.resolve({ ...draft, status: 'READY' });
  });
  expectProtectedContentCleared();
  get.mockResolvedValueOnce({ ...draft, status: 'READY' });
  await clickButton('Refresh status');
  expect(screen.getByText(draft.prompt)).toBeInTheDocument();
  await act(async () => {
    await refreshNativeIntents('project-1', 'refresh', true);
  });
  expectProtectedContentCleared();
});
it.each(['DRAFT', 'READY'] as const)(
  'discards loaded %s detail after the disabled-project 403 and fences an older detail response',
  async (status) => {
    get.mockResolvedValue({ ...draft, status });
    renderPage();
    await screen.findByText(draft.prompt);
    if (status === 'DRAFT')
      expect(screen.getByRole('button', { name: 'Prepare workspace' })).toBeEnabled();
    const oldGet = deferred<NativeIntent>();
    get.mockReturnValueOnce(oldGet.promise);
    await clickButton('Refresh status');
    const previousRevision = getNativeListing('project-1').accessRevision ?? 0;
    list.mockRejectedValueOnce(
      new ApiError(403, 'Project preparation disabled', {
        code: 'NATIVE_PREPARATION_PROJECT_DISABLED',
      }),
    );
    await act(async () => {
      await refreshNativeIntents('project-1', 'refresh', true);
    });
    expect(getNativeListing('project-1')).toMatchObject({
      items: [],
      disabled: true,
      denied: false,
      error: null,
    });
    expect(getNativeListing('project-1').accessRevision).toBeGreaterThan(previousRevision);
    expectProtectedContentCleared();
    await act(async () => {
      oldGet.resolve({ ...draft, status });
    });
    expectProtectedContentCleared();
    // Dropping the cache must not reveal the old record again at revision zero.
    act(() => clearNativeIntents());
    expectProtectedContentCleared();
  },
);
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function clickButton(name: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }));
  });
}

function expectProtectedContentCleared() {
  expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/^Native intent$/);
  expect(screen.queryByRole('heading', { name: draft.title })).not.toBeInTheDocument();
  expect(screen.queryByText(draft.prompt)).not.toBeInTheDocument();
  expect(screen.queryByText(/awslabs\/aidlc-workflows/)).not.toBeInTheDocument();
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  expect(
    screen.queryByRole('button', {
      name: /^(Prepare workspace|Retry preparation|Requesting preparation…)$/,
    }),
  ).not.toBeInTheDocument();
}

const denialCases = (['refresh', 'poll', 'prepare'] as const).flatMap((operation) =>
  [401, 403, 404].map((status) => ({ operation, status })),
);

it.each(denialCases)(
  'clears protected content and stops polling after $operation returns $status',
  async ({ operation, status }) => {
    vi.useFakeTimers();
    get.mockResolvedValue({ ...draft, status: 'PREPARING' });
    await act(async () => {
      renderPage();
    });
    expect(screen.getByRole('heading', { name: draft.title })).toBeVisible();
    const error = new ApiError(status, 'Native intent access is no longer available');
    if (operation === 'prepare') {
      prepare.mockRejectedValueOnce(error);
      await clickButton('Retry preparation');
    } else {
      get.mockRejectedValueOnce(error);
      if (operation === 'refresh') await clickButton('Refresh status');
      else await act(async () => vi.advanceTimersByTimeAsync(3000));
    }
    expectProtectedContentCleared();
    expect(screen.getByRole('alert')).not.toHaveTextContent(/last confirmed status/i);
    const requests = get.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(15000));
    expect(get).toHaveBeenCalledTimes(requests);
    expectProtectedContentCleared();
  },
);

it('prepares only on an explicit action and shows only supported controls', async () => {
  prepare.mockResolvedValue({ ...draft, status: 'PREPARING' });
  const user = userEvent.setup();
  renderPage();
  await screen.findByRole('status');
  expect(prepare).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Start agent' })).toBeDisabled();
  for (const name of ['Edit artifacts', 'Create unit PR', 'Delete intent']) {
    expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
  }
  await user.click(screen.getByRole('button', { name: 'Prepare workspace' }));
  expect(await screen.findByText('Preparing workspace')).toBeInTheDocument();
  expect(prepare).toHaveBeenCalledWith('project-1', 'run-1');
});
it('does not equate workspace readiness with an agent run', async () => {
  get.mockResolvedValue({ ...draft, status: 'READY' });
  renderPage();
  expect(await screen.findByRole('status')).toHaveTextContent('Workspace ready');
  expect(screen.getByText(/The agent has not started/)).toBeVisible();
  expect(screen.getByRole('button', { name: 'Start agent' })).toBeDisabled();
  expect(screen.queryByRole('button', { name: 'Prepare workspace' })).not.toBeInTheDocument();
});
it('allows a retry after preparation acknowledgement is lost', async () => {
  prepare
    .mockRejectedValueOnce(new Error('Response lost'))
    .mockResolvedValueOnce({ ...draft, status: 'PREPARING' });
  const user = userEvent.setup();
  renderPage();
  await user.click(await screen.findByRole('button', { name: 'Prepare workspace' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Preparation could not be confirmed. Retry the same intent.',
  );
  await user.click(screen.getByRole('button', { name: 'Prepare workspace' }));
  expect(await screen.findByRole('status')).toHaveTextContent('Preparing workspace');
  expect(prepare.mock.calls).toEqual([
    ['project-1', 'run-1'],
    ['project-1', 'run-1'],
  ]);
});

const lateCases = (['GET', 'prepare'] as const).flatMap((operation) =>
  (['success', 'network error', 'access error'] as const).map((outcome) => ({
    operation,
    outcome,
  })),
);

it.each(lateCases)(
  'ignores late $operation $outcome after another request denies access',
  async ({ operation, outcome }) => {
    const pending = deferred<NativeIntent>();
    await act(async () => {
      renderPage();
    });
    const denied = new ApiError(403, 'Native intent access denied');
    if (operation === 'GET') {
      get.mockReturnValueOnce(pending.promise);
      await clickButton('Refresh status');
      prepare.mockRejectedValueOnce(denied);
      await clickButton('Prepare workspace');
    } else {
      prepare.mockReturnValueOnce(pending.promise);
      await clickButton('Prepare workspace');
      get.mockRejectedValueOnce(denied);
      await clickButton('Refresh status');
    }
    expectProtectedContentCleared();
    const denialMessage = screen.getByRole('alert').textContent;
    expect(denialMessage).toBeTruthy();

    await act(async () => {
      if (outcome === 'success') pending.resolve({ ...draft, status: 'READY' });
      else if (outcome === 'access error')
        pending.reject(new ApiError(404, 'Late request reports a different error'));
      else pending.reject(new Error('Late transport failure'));
    });

    expectProtectedContentCleared();
    expect(screen.getByRole('alert').textContent).toBe(denialMessage);
  },
);

it('recovers only through a new explicit GET and ignores a pre-denial response afterward', async () => {
  const oldGet = deferred<NativeIntent>();
  const recovered: NativeIntent = {
    ...draft,
    title: 'Newly authorized game',
    prompt: 'Fresh authorized content',
    status: 'READY',
  };
  await act(async () => {
    renderPage();
  });
  get.mockReturnValueOnce(oldGet.promise);
  await clickButton('Refresh status');
  prepare.mockRejectedValueOnce(new ApiError(403, 'Native intent access denied'));
  await clickButton('Prepare workspace');
  expectProtectedContentCleared();
  expect(get).toHaveBeenCalledTimes(2);

  get.mockResolvedValueOnce(recovered);
  await clickButton('Refresh status');
  expect(get.mock.calls).toEqual([
    ['project-1', 'run-1'],
    ['project-1', 'run-1'],
    ['project-1', 'run-1'],
  ]);
  expect(screen.getByRole('heading', { name: recovered.title })).toBeVisible();
  expect(screen.getByText(recovered.prompt)).toBeVisible();
  expect(screen.getByRole('status')).toHaveTextContent('Workspace ready');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();

  await act(async () => {
    oldGet.resolve(draft);
  });
  expect(screen.getByRole('heading', { name: recovered.title })).toBeVisible();
  expect(screen.queryByText(draft.prompt)).not.toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent('Workspace ready');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(prepare).toHaveBeenCalledTimes(1);
});

const transientCases = (['refresh', 'poll', 'prepare'] as const).flatMap((operation) =>
  (['network', '503'] as const).map((failure) => ({ operation, failure })),
);

it.each(transientCases)(
  'retains confirmed data and permits retry after $operation encounters $failure',
  async ({ operation, failure }) => {
    vi.useFakeTimers();
    get.mockResolvedValue({ ...draft, status: 'PREPARING' });
    await act(async () => {
      renderPage();
    });
    const error =
      failure === '503'
        ? new ApiError(503, 'Preparation is temporarily unavailable')
        : new Error('Connection interrupted');
    if (operation === 'prepare') {
      prepare.mockRejectedValueOnce(error);
      await clickButton('Retry preparation');
    } else {
      get.mockRejectedValueOnce(error);
      if (operation === 'refresh') await clickButton('Refresh status');
      else await act(async () => vi.advanceTimersByTimeAsync(3000));
    }

    expect(screen.getByRole('heading', { name: draft.title })).toBeVisible();
    expect(screen.getByText(draft.prompt)).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent('Preparing workspace');
    expect(screen.getByRole('button', { name: 'Retry preparation' })).toBeEnabled();
    expect(screen.getByRole('alert')).toBeVisible();

    if (operation === 'prepare') {
      prepare.mockResolvedValueOnce({ ...draft, status: 'READY' });
      await clickButton('Retry preparation');
      expect(prepare.mock.calls).toEqual([
        ['project-1', 'run-1'],
        ['project-1', 'run-1'],
      ]);
    } else {
      get.mockResolvedValueOnce({ ...draft, status: 'READY' });
      if (operation === 'refresh') await clickButton('Refresh status');
      else await act(async () => vi.advanceTimersByTimeAsync(3000));
      expect(get).toHaveBeenCalledTimes(3);
    }
    expect(screen.getByRole('status')).toHaveTextContent('Workspace ready');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    const requests = get.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(15000));
    expect(get).toHaveBeenCalledTimes(requests);
  },
);

it.each(['success', 'error'] as const)(
  'ignores an old-route GET %s after another native intent loads',
  async (outcome) => {
    const oldGet = deferred<NativeIntent>();
    const other: NativeIntent = {
      ...draft,
      id: 'run-2',
      title: 'Another native intent',
      prompt: 'Another run has separate content',
      status: 'READY',
    };
    await act(async () => {
      renderPage({ navigation: true });
    });
    get.mockReturnValueOnce(oldGet.promise);
    await clickButton('Refresh status');
    get.mockResolvedValueOnce(other);
    await act(async () => {
      fireEvent.click(screen.getByRole('link', { name: 'Open another native intent' }));
    });
    expect(get).toHaveBeenLastCalledWith('project-1', 'run-2');
    expect(screen.getByRole('heading', { name: other.title })).toBeVisible();

    await act(async () => {
      if (outcome === 'success') oldGet.resolve(draft);
      else oldGet.reject(new ApiError(403, 'Old route access denied'));
    });
    expect(screen.getByRole('heading', { name: other.title })).toBeVisible();
    expect(screen.getByText(other.prompt)).toBeVisible();
    expect(screen.queryByText(draft.prompt)).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Workspace ready');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  },
);

it.each(['success', 'error'] as const)(
  'does not restart polling after outstanding GET and prepare %s on unmount',
  async (outcome) => {
    vi.useFakeTimers();
    const oldGet = deferred<NativeIntent>();
    const oldPrepare = deferred<NativeIntent>();
    get
      .mockResolvedValueOnce({ ...draft, status: 'PREPARING' })
      .mockReturnValueOnce(oldGet.promise);
    let view!: ReturnType<typeof renderPage>;
    await act(async () => {
      view = renderPage();
    });
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(get).toHaveBeenCalledTimes(2);
    prepare.mockReturnValueOnce(oldPrepare.promise);
    await clickButton('Retry preparation');
    expect(prepare).toHaveBeenCalledTimes(1);

    view.unmount();
    await act(async () => {
      if (outcome === 'success') {
        oldGet.resolve({ ...draft, status: 'PREPARING' });
        oldPrepare.resolve({ ...draft, status: 'PREPARING' });
      } else {
        oldGet.reject(new ApiError(403, 'Unmounted GET access denied'));
        oldPrepare.reject(new ApiError(404, 'Unmounted prepare no longer exists'));
      }
    });
    await act(async () => vi.advanceTimersByTimeAsync(30000));
    expect(get).toHaveBeenCalledTimes(2);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  },
);
