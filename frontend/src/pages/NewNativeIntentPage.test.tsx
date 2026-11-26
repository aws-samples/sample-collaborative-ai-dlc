import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { api, ApiError } from '@/services/api';
import { NativePreparationLink } from '@/components/intent/NativePreparationLink';

const canPrepare = vi.fn();
const create = vi.fn();
const get = vi.fn();
const list = vi.fn();
const getPackageImport = vi.fn();
vi.mock('@/services/nativeIntents', () => ({
  nativeIntentsService: {
    canPrepare: (...a: unknown[]) => canPrepare(...a),
    create: (...a: unknown[]) => create(...a),
    get: (...a: unknown[]) => get(...a),
  },
}));
vi.mock('@/services/workflowSources', () => ({
  workflowSourcesService: {
    list: (...a: unknown[]) => list(...a),
    getPackageImport: (...a: unknown[]) => getPackageImport(...a),
  },
}));
import NewNativeIntentPage from './NewNativeIntentPage';

const sourceId = 'a'.repeat(64);
const jobId = '10000000-0000-4000-8000-000000000001';
const revision = '20000000-0000-4000-8000-000000000002';
const draftId = '30000000-0000-4000-8000-000000000003';
const entry = `/space/project-1/native-intent/new?sourceId=${sourceId}&packageJobId=${jobId}&bindingRevision=${revision}`;
const renderPage = (url = entry) =>
  render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/space/:projectId/native-intent/new" element={<NewNativeIntentPage />} />
        <Route
          path="/space/:projectId/native-intent/:intentId"
          element={<p>Native workspace status</p>}
        />
      </Routes>
    </MemoryRouter>,
  );
beforeEach(() => {
  vi.resetAllMocks();
  canPrepare.mockResolvedValue(true);
  list.mockResolvedValue([
    { sourceId, revision, repository: 'awslabs/aidlc-workflows', status: 'active' },
  ]);
  getPackageImport.mockResolvedValue({
    state: 'SUCCEEDED',
    package: { release: 'v2.9.0', harnesses: ['claude', 'codex', 'kiro', 'opencode'] },
  });
});
afterEach(() => vi.restoreAllMocks());

it.each([false, true])(
  'opens the creation link and submits a draft with the real capability gate and executionEnabled=%s',
  async (executionEnabled) => {
    const { nativeIntentsService } = await vi.importActual<
      typeof import('@/services/nativeIntents')
    >('@/services/nativeIntents');
    const capability = vi
      .spyOn(api, 'get')
      .mockResolvedValue({ preparationEnabled: true, executionEnabled });
    canPrepare.mockImplementation(nativeIntentsService.canPrepare);
    create.mockImplementation((_project, request) => Promise.resolve({ id: request.intentId }));
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/space/project-1/settings']}>
        <Routes>
          <Route
            path="/space/:projectId/settings"
            element={
              <NativePreparationLink
                projectId="project-1"
                sourceId={sourceId}
                packageJobId={jobId}
                bindingRevision={revision}
              />
            }
          />
          <Route path="/space/:projectId/native-intent/new" element={<NewNativeIntentPage />} />
          <Route
            path="/space/:projectId/native-intent/:intentId"
            element={<p>Native workspace status</p>}
          />
        </Routes>
      </MemoryRouter>,
    );
    const link = await screen.findByRole('link', { name: 'Create a native intent draft' });
    expect(link).toHaveAttribute('href', entry);
    expect(create).not.toHaveBeenCalled();
    await user.click(link);
    await user.type(await screen.findByRole('textbox', { name: 'Title' }), 'Fix the pipes');
    await user.click(screen.getByRole('button', { name: 'Create native draft' }));
    await screen.findByText('Native workspace status');
    expect(capability.mock.calls).toEqual([
      ['/projects/project-1/native-intents'],
      ['/projects/project-1/native-intents'],
    ]);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(
      'project-1',
      expect.objectContaining({ title: 'Fix the pipes', sourceId, packageJobId: jobId }),
    );
  },
);

it('offers all four harnesses, requires explicit creation, and never prepares automatically', async () => {
  renderPage();
  const select = await screen.findByRole('combobox', { name: 'Coding harness' });
  expect(select).toHaveValue('codex');
  for (const name of ['Claude Code', 'Codex', 'Kiro', 'OpenCode'])
    expect(screen.getByRole('option', { name })).toBeInTheDocument();
  expect(create).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Create native draft' })).toBeDisabled();
});

it('retries the same immutable draft after a lost response', async () => {
  create
    .mockRejectedValueOnce(new Error('Response lost'))
    .mockImplementationOnce((_project, request) => Promise.resolve({ id: request.intentId }));
  const user = userEvent.setup();
  renderPage();
  await user.type(await screen.findByRole('textbox', { name: 'Title' }), 'Flappy bird');
  await user.selectOptions(screen.getByRole('combobox', { name: 'Coding harness' }), 'kiro');
  await user.click(screen.getByRole('button', { name: 'Create native draft' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Response lost');
  expect(screen.getByRole('textbox', { name: 'Title' })).toBeDisabled();
  const first = create.mock.calls[0];
  await user.click(screen.getByRole('button', { name: 'Retry same draft' }));
  await screen.findByText('Native workspace status');
  expect(create.mock.calls[1]).toEqual(first);
  expect(first[1]).toMatchObject({
    sourceId,
    packageJobId: jobId,
    bindingRevision: revision,
    harness: 'kiro',
  });
});

it('recovers a committed draft by URL identity without creating another', async () => {
  get.mockResolvedValue({ id: draftId });
  renderPage(`${entry}&draftId=${draftId}`);
  await screen.findByText('Native workspace status');
  expect(get).toHaveBeenCalledWith('project-1', draftId);
  expect(create).not.toHaveBeenCalled();
  expect(getPackageImport).not.toHaveBeenCalled();
});

it('does not create a replacement draft when recovery is temporarily unavailable', async () => {
  get.mockRejectedValue(new ApiError(503, 'Recovery unavailable'));
  renderPage(`${entry}&draftId=${draftId}`);
  expect(await screen.findByRole('alert')).toHaveTextContent('Recovery unavailable');
  expect(screen.queryByRole('button', { name: 'Create native draft' })).not.toBeInTheDocument();
  expect(create).not.toHaveBeenCalled();
});

it.each(['disabled', 'source-changed', 'package-not-ready'])(
  'blocks creation for %s',
  async (scenario) => {
    if (scenario === 'disabled') canPrepare.mockResolvedValue(false);
    if (scenario === 'source-changed')
      list.mockResolvedValue([{ sourceId, revision: 'changed', status: 'active' }]);
    if (scenario === 'package-not-ready') getPackageImport.mockResolvedValue({ state: 'RUNNING' });
    renderPage();
    await screen.findByRole('alert');
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Create native draft' })).not.toBeInTheDocument(),
    );
    expect(create).not.toHaveBeenCalled();
  },
);
