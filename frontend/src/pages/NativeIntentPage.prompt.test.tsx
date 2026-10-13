import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { Link, MemoryRouter, Route, Routes } from 'react-router';
import { ApiError } from '@/services/api';
import { clearNativeIntents } from '@/hooks/useNativeIntents';
import { notifySessionExpired, resetSessionExpiry } from '@/services/sessionExpiry';
import type { NativeIntent } from '@/services/nativeIntents';

const service = vi.hoisted(() => ({
  get: vi.fn(),
  savePrompt: vi.fn(),
  start: vi.fn(),
  prepare: vi.fn(),
}));
vi.mock('@/services/nativeIntents', async (original) => ({
  ...(await original<typeof import('@/services/nativeIntents')>()),
  nativeIntentsService: service,
}));
import NativeIntentPage from './NativeIntentPage';

const initial: NativeIntent = {
  id: 'run-1',
  projectId: 'project-1',
  executionBackend: 'native',
  title: 'A title-only draft',
  prompt: '',
  promptRevision: 0,
  harness: 'codex',
  status: 'READY',
  package: {
    version: '2.9.0',
    source: { provider: 'github', repository: 'awslabs/aidlc-workflows', release: 'v2.9.0' },
  },
  createdAt: '2026-10-13T10:00:00Z',
  updatedAt: '2026-10-13T10:00:00Z',
  executionAvailable: true,
  execution: null,
};
const started = (draft: NativeIntent): NativeIntent => ({
  ...draft,
  execution: {
    status: 'REQUESTED',
    attemptId: 'attempt',
    epoch: 1,
    revision: 0,
    startedAt: draft.updatedAt,
    updatedAt: draft.updatedAt,
    model: 'test',
    repository: { provider: 'github', repository: 'example/app', branch: null, commit: null },
    publicationId: null,
    projectionStatus: null,
  },
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
function page() {
  return render(
    <MemoryRouter initialEntries={['/space/project-1/native-intent/run-1']}>
      <Link to="/space/project-1/native-intent/run-2">Switch intent</Link>
      <Link to="/space/project-2/native-intent/run-1">Switch project</Link>
      <Routes>
        <Route path="/space/:projectId/native-intent/:intentId" element={<NativeIntentPage />} />
      </Routes>
    </MemoryRouter>,
  );
}
async function click(name: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }));
  });
}
async function edit(text: string) {
  await click(initial.prompt ? 'Edit prompt' : 'Add prompt');
  fireEvent.change(screen.getByRole('textbox'), { target: { value: text } });
}
beforeEach(() => {
  vi.resetAllMocks();
  resetSessionExpiry();
  clearNativeIntents();
  service.get.mockImplementation(async (projectId, id) => ({ ...initial, projectId, id }));
  service.savePrompt.mockImplementation(async (_project, _id, request) => ({
    ...initial,
    prompt: request.prompt,
    promptRevision: request.expectedRevision + 1,
  }));
});

it('saves and revises a title-only draft before Start, then shows the pinned prompt read-only', async () => {
  service.start.mockImplementation(async () =>
    started({ ...initial, prompt: 'Second prompt', promptRevision: 2 }),
  );
  page();
  await screen.findByRole('button', { name: 'Add prompt' });
  expect(screen.getByRole('button', { name: 'Start agent' })).toBeDisabled();
  await edit('First prompt');
  expect(screen.getByRole('button', { name: 'Start agent' })).toBeDisabled();
  await click('Save prompt');
  await click('Edit prompt');
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Second prompt' } });
  await click('Save prompt');
  await click('Start agent');
  await screen.findByText('Start requested');
  expect(service.savePrompt.mock.calls.map((call) => call[2].expectedRevision)).toEqual([0, 1]);
  expect(service.start).toHaveBeenCalledWith('project-1', 'run-1', expect.any(String), 2);
  expect(screen.getByText('Second prompt')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Edit prompt' })).not.toBeInTheDocument();
});

it.each(['', '  \n', 'bad\0text', 'x'.repeat(65537)])(
  'blocks invalid local prompt saving',
  async (text) => {
    page();
    await screen.findByRole('button', { name: 'Add prompt' });
    await edit(text);
    expect(screen.getByRole('button', { name: 'Save prompt' })).toBeDisabled();
    expect(service.savePrompt).not.toHaveBeenCalled();
  },
);

it('retains unsaved text through refresh and reloads explicitly after another member edits', async () => {
  page();
  await screen.findByRole('button', { name: 'Add prompt' });
  await edit('My unsaved work');
  service.get.mockResolvedValue({ ...initial, prompt: 'Other member saved', promptRevision: 1 });
  await click('Refresh status');
  expect(screen.getByRole('textbox')).toHaveValue('My unsaved work');
  expect(screen.getByRole('button', { name: 'Save prompt' })).toBeDisabled();
  await click('Reload saved prompt');
  expect(screen.getByText('Other member saved')).toBeInTheDocument();
  await click('Edit prompt');
  expect(screen.getByRole('textbox')).toHaveValue('Other member saved');
  await click('Save prompt');
  expect(service.savePrompt.mock.calls[0][2].expectedRevision).toBe(1);
});

it('keeps the same save identity and body after an unknown acknowledgement', async () => {
  service.savePrompt.mockRejectedValueOnce(new Error('lost'));
  page();
  await screen.findByRole('button', { name: 'Add prompt' });
  await edit('Exact submitted prompt  ');
  await click('Save prompt');
  expect(screen.getByRole('textbox')).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Reload saved prompt' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Start agent' })).toBeDisabled();
  await click('Retry prompt save');
  expect(service.savePrompt.mock.calls[1]).toEqual(service.savePrompt.mock.calls[0]);
  expect(service.savePrompt.mock.calls[1][2].prompt).toBe('Exact submitted prompt  ');
});

it('preserves the submitted save after a later validation rejection following uncertainty', async () => {
  service.savePrompt
    .mockRejectedValueOnce(new Error('lost'))
    .mockRejectedValueOnce(new ApiError(400, 'Invalid', { code: 'NATIVE_PROMPT_INVALID' }));
  page();
  await screen.findByRole('button', { name: 'Add prompt' });
  await edit('Exact saved body');
  await click('Save prompt');
  await click('Retry prompt save');
  expect(screen.getByRole('textbox')).toBeDisabled();
  await click('Retry prompt save');
  expect(service.savePrompt.mock.calls[2]).toEqual(service.savePrompt.mock.calls[0]);
});

it('rejects stale save and fetch responses without replacing newer saved content', async () => {
  const pendingSave = deferred<NativeIntent>();
  const pendingRead = deferred<NativeIntent>();
  service.savePrompt.mockReturnValueOnce(pendingSave.promise);
  page();
  await screen.findByRole('button', { name: 'Add prompt' });
  service.get.mockReturnValueOnce(pendingRead.promise);
  await click('Refresh status');
  await edit('My save');
  await click('Save prompt');
  service.get.mockResolvedValue({ ...initial, prompt: 'Newer saved prompt', promptRevision: 2 });
  await click('Refresh status');
  await act(async () => pendingSave.resolve({ ...initial, prompt: 'My save', promptRevision: 1 }));
  await act(async () => pendingRead.resolve(initial));
  expect(screen.getByText('Newer saved prompt')).toBeInTheDocument();
  expect(screen.queryByText('My save')).not.toBeInTheDocument();
});

it('refreshes after a save conflict without silently replacing local edits', async () => {
  service.savePrompt.mockRejectedValueOnce(
    new ApiError(409, 'conflict', {
      code: 'NATIVE_PROMPT_CONFLICT',
      error: 'The prompt or native intent changed. Refresh before editing or starting',
    }),
  );
  page();
  await screen.findByRole('button', { name: 'Add prompt' });
  await edit('Unsaved local task');
  await click('Save prompt');
  expect(screen.getByRole('textbox')).toHaveValue('Unsaved local task');
  expect(screen.getByRole('alert')).toHaveTextContent('Refresh');
  service.get.mockResolvedValue({ ...initial, prompt: 'Winning prompt', promptRevision: 1 });
  await click('Reload saved prompt');
  expect(screen.getByText('Winning prompt')).toBeInTheDocument();
});

it('pins an uncertain Start retry to the same revision', async () => {
  service.get.mockResolvedValue({ ...initial, prompt: 'Ready prompt', promptRevision: 1 });
  service.start
    .mockRejectedValueOnce(new Error('lost'))
    .mockResolvedValueOnce(started({ ...initial, prompt: 'Ready prompt', promptRevision: 1 }));
  page();
  await screen.findByRole('button', { name: 'Edit prompt' });
  await click('Start agent');
  expect(screen.getByRole('button', { name: 'Edit prompt' })).toBeEnabled();
  await click('Start agent');
  expect(service.start.mock.calls[1]).toEqual(service.start.mock.calls[0]);
});

it('replaces an uncertain Start only after an accepted save fences the previous prompt', async () => {
  service.get.mockResolvedValue({ ...initial, prompt: 'Original prompt', promptRevision: 1 });
  service.start.mockRejectedValueOnce(new Error('lost'));
  page();
  await screen.findByRole('button', { name: 'Edit prompt' });
  await click('Start agent');
  const originalStart = service.start.mock.calls[0];
  await click('Edit prompt');
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'New saved prompt' } });
  await click('Save prompt');
  service.start.mockResolvedValueOnce(
    started({ ...initial, prompt: 'New saved prompt', promptRevision: 2 }),
  );
  await click('Start agent');
  expect(service.start.mock.calls[1][3]).toBe(2);
  expect(service.start.mock.calls[1][2]).not.toBe(originalStart[2]);
});

it('can save after access is restored without an older save clearing the new submission guard', async () => {
  const oldSave = deferred<NativeIntent>();
  const newSave = deferred<NativeIntent>();
  service.savePrompt.mockReturnValueOnce(oldSave.promise).mockReturnValueOnce(newSave.promise);
  page();
  await screen.findByRole('button', { name: 'Add prompt' });
  await edit('Before denial');
  await click('Save prompt');
  service.get.mockRejectedValueOnce(new ApiError(403, 'Denied'));
  await click('Refresh status');
  service.get.mockResolvedValue(initial);
  await click('Refresh status');
  await screen.findByRole('button', { name: 'Add prompt' });
  await edit('After access restored');
  await click('Save prompt');
  await act(async () =>
    oldSave.resolve({ ...initial, prompt: 'Before denial', promptRevision: 1 }),
  );
  expect(screen.getByRole('button', { name: 'Saving prompt…' })).toBeDisabled();
  expect(service.savePrompt).toHaveBeenCalledTimes(2);
  await act(async () =>
    newSave.resolve({ ...initial, prompt: 'After access restored', promptRevision: 1 }),
  );
  expect(screen.getByRole('button', { name: 'Edit prompt' })).toBeEnabled();
});

it('requires refresh after Start conflicts with a newer prompt', async () => {
  service.get.mockResolvedValue({ ...initial, prompt: 'Earlier prompt', promptRevision: 1 });
  service.start.mockRejectedValueOnce(
    new ApiError(409, 'conflict', { code: 'NATIVE_PROMPT_CONFLICT' }),
  );
  page();
  await screen.findByRole('button', { name: 'Edit prompt' });
  await click('Start agent');
  expect(screen.getByRole('button', { name: 'Start agent' })).toBeDisabled();
  service.get.mockResolvedValue({ ...initial, prompt: 'Latest prompt', promptRevision: 2 });
  await click('Refresh status');
  service.start.mockResolvedValueOnce(
    started({ ...initial, prompt: 'Latest prompt', promptRevision: 2 }),
  );
  await click('Start agent');
  expect(service.start.mock.calls.map((call) => call[3])).toEqual([1, 2]);
});

it.each(['Switch intent', 'Switch project', 'account', 'expiry', 'denial', 'unmount'])(
  'clears prompt edits and rejects delayed saves after %s',
  async (change) => {
    const pending = deferred<NativeIntent>();
    service.savePrompt.mockReturnValueOnce(pending.promise);
    const view = page();
    await screen.findByRole('button', { name: 'Add prompt' });
    await edit('Private submitted text');
    await click('Save prompt');
    if (change === 'account') act(() => resetSessionExpiry());
    else if (change === 'expiry') act(() => notifySessionExpired());
    else if (change === 'unmount') view.unmount();
    else if (change === 'denial') {
      service.get.mockRejectedValueOnce(new ApiError(403, 'Denied'));
      await click('Refresh status');
    } else await act(async () => fireEvent.click(screen.getByRole('link', { name: change })));
    await act(async () =>
      pending.resolve({ ...initial, prompt: 'Private submitted text', promptRevision: 1 }),
    );
    expect(screen.queryByDisplayValue('Private submitted text')).not.toBeInTheDocument();
    expect(screen.queryByText('Private submitted text')).not.toBeInTheDocument();
  },
);

it('suppresses duplicate save submissions while awaiting acknowledgement', async () => {
  const pending = deferred<NativeIntent>();
  service.savePrompt.mockReturnValueOnce(pending.promise);
  page();
  await screen.findByRole('button', { name: 'Add prompt' });
  await edit('Only once');
  const button = screen.getByRole('button', { name: 'Save prompt' });
  act(() => {
    fireEvent.click(button);
    fireEvent.click(button);
  });
  expect(service.savePrompt).toHaveBeenCalledTimes(1);
  await act(async () => pending.resolve({ ...initial, prompt: 'Only once', promptRevision: 1 }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Edit prompt' })).toBeEnabled());
});
