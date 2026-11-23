import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Link, MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { api, ApiError } from '@/services/api';
import { NativePreparationLink } from '@/components/intent/NativePreparationLink';
import { notifySessionExpired, resetSessionExpiry } from '@/services/sessionExpiry';

const canPrepare = vi.fn();
const capabilities = vi.fn();
const create = vi.fn();
const get = vi.fn();
const list = vi.fn();
const getPackageImport = vi.fn();
vi.mock('@/services/nativeIntents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/nativeIntents')>()),
  nativeIntentsService: {
    canPrepare: (...a: unknown[]) => canPrepare(...a),
    capabilities: (...a: unknown[]) => capabilities(...a),
    create: (...a: unknown[]) => create(...a),
    get: (...a: unknown[]) => get(...a),
  },
}));
const createPackageImport = vi.fn();
const useProjectCache = vi.fn();
vi.mock('@/hooks/useProjectsCache', () => ({
  useProjectCache: (...a: unknown[]) => useProjectCache(...a),
}));
vi.mock('@/hooks/useAuthSession', () => ({
  useAuthSession: () => ({ userId: 'member', isAuthenticated: true, isLoading: false }),
}));
vi.mock('@/services/aidlcReleases', () => ({
  aidlcReleasesService: { sharedChannels: async () => ({ pinningEnabled: false }) },
}));
vi.mock('@/services/workflowSources', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/workflowSources')>()),
  workflowSourcesService: {
    list: (...a: unknown[]) => list(...a),
    listWithCapabilities: async (...a: unknown[]) => ({
      sources: await list(...a),
      capabilities: { packageImportsEnabled: true },
    }),
    getPackageImport: (...a: unknown[]) => getPackageImport(...a),
    createPackageImport: (...a: unknown[]) => createPackageImport(...a),
  },
}));
import NewIntentPage from './NewIntentPage';
import NewNativeIntentPage from './NewNativeIntentPage';

const sourceId = 'a'.repeat(64);
const jobId = '10000000-0000-4000-8000-000000000001';
const revision = '20000000-0000-4000-8000-000000000002';
const draftId = '30000000-0000-4000-8000-000000000003';
const entry = `/space/project-1/intent/new?backend=native&sourceId=${sourceId}&packageJobId=${jobId}&bindingRevision=${revision}`;
const rejection = () =>
  new ApiError(400, 'Invalid native preparation request', {
    code: 'NATIVE_PREPARATION_INVALID',
    draftInputRejected: true,
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
function Location() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname + location.search}</output>;
}
const renderPage = (url = entry) =>
  render(
    <MemoryRouter initialEntries={[url]}>
      <Location />
      <Link to={entry.replace('project-1', 'project-2')}>Other project</Link>
      <Link to={`${entry}&draftId=${draftId}`}>Other draft</Link>
      <Routes>
        <Route path="/space/:projectId/native-intent/new" element={<NewNativeIntentPage />} />
        <Route path="/space/:projectId/intent/new" element={<NewIntentPage />} />
        <Route
          path="/space/:projectId/native-intent/:intentId"
          element={<p>Native workspace status</p>}
        />
      </Routes>
    </MemoryRouter>,
  );
beforeEach(() => {
  vi.resetAllMocks();
  resetSessionExpiry();
  sessionStorage.clear();
  useProjectCache.mockImplementation((id) => ({
    project: {
      id,
      name: 'Test space',
      userRole: 'member',
      agentCli: 'codex',
      trackers: [],
      repos: [{ provider: 'github', url: 'owner/app', role: 'primary' }],
    },
    loading: false,
  }));
  canPrepare.mockResolvedValue(true);
  capabilities.mockResolvedValue({
    preparationEnabled: true,
    executionEnabled: true,
    unavailableHarnesses: { kiro: 'NATIVE_EXECUTION_KIRO_UNAVAILABLE' },
  });
  list.mockResolvedValue([
    {
      sourceId,
      revision,
      repository: 'awslabs/aidlc-workflows',
      provider: 'github',
      status: 'active',
      authType: 'public',
      access: 'read',
    },
  ]);
  getPackageImport.mockResolvedValue({
    state: 'SUCCEEDED',
    jobId,
    sourceId,
    requestedRelease: 'v2.11.1',
    package: {
      version: '2.11.1',
      release: 'v2.11.1',
      commit: 'b'.repeat(40),
      harnesses: ['claude', 'codex', 'kiro', 'opencode'],
    },
  });
});
afterEach(() => vi.restoreAllMocks());

it('explains native settings before creating a draft without loading current private settings', async () => {
  renderPage();
  await screen.findByLabelText('Coding harness');
  await userEvent.click(screen.getByText('Settings that apply to native execution'));
  expect(
    screen.getByText(
      /managed environments, custom MCP servers and uploaded custom rules do not apply/,
    ),
  ).toBeVisible();
  expect(screen.getByText(/Agent tier assignments do not apply/)).toBeVisible();
  expect(create).not.toHaveBeenCalled();
});

it('withholds fresh creation when the current space capability read denies the inspecting member', async () => {
  capabilities.mockRejectedValueOnce(new ApiError(403, 'Space access revoked'));
  renderPage('/space/project-1/intent/new?backend=native&chooseRepository=1');
  expect(await screen.findByRole('alert')).toHaveTextContent('Space access revoked');
  expect(capabilities).toHaveBeenCalledExactlyOnceWith('project-1');
  expect(screen.queryByLabelText('Application repository')).toBeNull();
  expect(create).not.toHaveBeenCalled();
});

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
    capabilities.mockImplementation(nativeIntentsService.capabilities);
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
          <Route path="/space/:projectId/intent/new" element={<NewIntentPage />} />
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

it('shows Kiro as temporarily unavailable before creation and leaves the other harnesses selectable', async () => {
  renderPage();
  const select = await screen.findByRole('combobox', { name: 'Coding harness' });
  expect(select).toHaveValue('codex');
  for (const name of ['Claude Code', 'Codex', 'OpenCode'])
    expect(screen.getByRole('option', { name })).toBeEnabled();
  expect(screen.getByRole('option', { name: 'Kiro (temporarily unavailable)' })).toBeDisabled();
  expect(
    screen.getByText(/Kiro is temporarily unavailable for new native executions while/),
  ).toBeVisible();
  expect(select).toHaveAccessibleDescription(/AI-DLC input and authentication qualification/);
  fireEvent.change(select, { target: { value: 'kiro' } });
  expect(select).toHaveValue('codex');
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
  await user.selectOptions(screen.getByRole('combobox', { name: 'Coding harness' }), 'claude');
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
    harness: 'claude',
  });
});

it.each([
  ['validation', rejection()],
  [
    'request size',
    new ApiError(413, 'Native draft request is too large', {
      code: 'NATIVE_PREPARATION_BODY_TOO_LARGE',
      draftInputRejected: true,
    }),
  ],
])(
  'allows correction after authoritative %s rejection with the same identity',
  async (_label, error) => {
    const { nativeIntentsService } = await vi.importActual<
      typeof import('@/services/nativeIntents')
    >('@/services/nativeIntents');
    create.mockImplementation(nativeIntentsService.create);
    vi.spyOn(api, 'post')
      .mockRejectedValueOnce(error)
      .mockImplementationOnce((_path, body) => {
        const request = body as {
          intentId: string;
          title: string;
          prompt: string;
          harness: string;
        };
        return Promise.resolve({
          ...request,
          id: request.intentId,
          projectId: 'project-1',
          executionBackend: 'native',
          status: 'DRAFT',
          package: {
            version: '2.9.0',
            source: {
              provider: 'github',
              repository: 'awslabs/aidlc-workflows',
              release: 'v2.9.0',
            },
          },
          createdAt: '2026-10-13T10:00:00Z',
          updatedAt: '2026-10-13T10:00:00Z',
        });
      });
    const user = userEvent.setup();
    renderPage();
    const title = await screen.findByRole('textbox', { name: 'Title' });
    fireEvent.change(title, { target: { value: 'x'.repeat(257) } });
    await user.click(screen.getByRole('button', { name: 'Create native draft' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(error.message);
    expect(title).toBeEnabled();
    expect(screen.getByRole('textbox', { name: 'Prompt' })).toBeEnabled();
    expect(screen.getByRole('combobox', { name: 'Coding harness' })).toBeEnabled();
    expect(screen.getByTestId('location')).toHaveTextContent(entry);
    expect(screen.getByTestId('location').textContent).not.toContain('draftId');
    const original = structuredClone(create.mock.calls[0][1]);
    await user.clear(title);
    await user.type(title, 'Corrected title');
    await user.type(screen.getByRole('textbox', { name: 'Prompt' }), 'A game');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Coding harness' }), 'claude');
    await user.click(screen.getByRole('button', { name: 'Create native draft' }));
    await screen.findByText('Native workspace status');
    expect(create.mock.calls[1]).toEqual([
      'project-1',
      { ...original, title: 'Corrected title', prompt: 'A game', harness: 'claude' },
    ]);
    expect(create.mock.calls[0][1]).toEqual(original);
  },
);

it.each([
  new Error('Response lost'),
  new ApiError(400, 'Generic validation', { code: 'NATIVE_PREPARATION_INVALID' }),
  new ApiError(409, 'Conflict', { code: 'NATIVE_PREPARATION_CONFLICT' }),
  new ApiError(403, 'Membership changed', { code: 'NATIVE_PREPARATION_FORBIDDEN' }),
  new ApiError(503, 'Unavailable'),
  new SyntaxError('Unreadable success response'),
])('retains the request after $message and a subsequent validation rejection', async (error) => {
  create
    .mockRejectedValueOnce(error)
    .mockRejectedValueOnce(rejection())
    .mockImplementationOnce((_project, request) => Promise.resolve({ id: request.intentId }));
  const user = userEvent.setup();
  renderPage();
  const title = await screen.findByRole('textbox', { name: 'Title' });
  await user.type(title, 'Original');
  await user.click(screen.getByRole('button', { name: 'Create native draft' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(error.message);
  await user.click(screen.getByRole('button', { name: 'Retry same draft' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Invalid native preparation request');
  expect(title).toBeDisabled();
  expect(screen.getByTestId('location').textContent).toContain(
    `draftId=${create.mock.calls[0][1].intentId}`,
  );
  await user.click(screen.getByRole('button', { name: 'Retry same draft' }));
  await screen.findByText('Native workspace status');
  expect(create.mock.calls[1]).toEqual(create.mock.calls[0]);
  expect(create.mock.calls[2]).toEqual(create.mock.calls[0]);
});

it('does not submit twice while the first response is delayed', async () => {
  const pending = deferred<{ id: string }>();
  create.mockReturnValue(pending.promise);
  renderPage();
  const title = await screen.findByRole('textbox', { name: 'Title' });
  fireEvent.change(title, { target: { value: 'Original' } });
  const form = title.closest('form')!;
  act(() => {
    fireEvent.submit(form);
    fireEvent.submit(form);
  });
  expect(create).toHaveBeenCalledTimes(1);
  await act(async () => pending.resolve({ id: create.mock.calls[0][1].intentId }));
  await screen.findByText('Native workspace status');
});

it('allows a fresh editable form when reloading after known rejection', async () => {
  create.mockRejectedValueOnce(rejection());
  const user = userEvent.setup();
  const page = renderPage();
  await user.type(await screen.findByRole('textbox', { name: 'Title' }), 'Rejected');
  await user.click(screen.getByRole('button', { name: 'Create native draft' }));
  await screen.findByRole('alert');
  const url = screen.getByTestId('location').textContent!;
  page.unmount();
  renderPage(url);
  expect(await screen.findByRole('textbox', { name: 'Title' })).toBeEnabled();
  expect(get).not.toHaveBeenCalled();
});

it('only refreshes the original identity after an uncertain reload and an absent read', async () => {
  create.mockRejectedValueOnce(new Error('Response lost'));
  get.mockRejectedValueOnce(new ApiError(404, 'Not found'));
  const user = userEvent.setup();
  const page = renderPage(`${entry}&chooseRepository=1`);
  await user.type(await screen.findByRole('textbox', { name: 'Title' }), 'Original');
  await user.selectOptions(
    screen.getByLabelText('Application repository'),
    screen.getByRole('option', { name: 'owner/app (github)' }),
  );
  await user.click(screen.getByRole('button', { name: 'Create native draft' }));
  await screen.findByRole('alert');
  const url = screen.getByTestId('location').textContent!;
  const id = create.mock.calls[0][1].intentId;
  page.unmount();
  renderPage(url);
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'original submitted fields are unavailable',
  );
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  get.mockResolvedValueOnce({ id });
  await user.click(screen.getByRole('button', { name: 'Refresh draft status' }));
  await screen.findByText('Native workspace status');
  expect(get.mock.calls).toEqual([
    ['project-1', id],
    ['project-1', id],
  ]);
  expect(create).toHaveBeenCalledTimes(1);
});

it.each(['Other project', 'Other draft', 'account', 'expiry', 'unmount'])(
  'ignores a late creation rejection after %s changes',
  async (change) => {
    const pending = deferred<{ id: string }>();
    create.mockReturnValue(pending.promise);
    get.mockRejectedValue(new ApiError(404, 'Not found'));
    const user = userEvent.setup();
    const page = renderPage();
    await user.type(await screen.findByRole('textbox', { name: 'Title' }), 'Old private title');
    await user.click(screen.getByRole('button', { name: 'Create native draft' }));
    if (change === 'account') act(() => resetSessionExpiry());
    else if (change === 'expiry') act(() => notifySessionExpired());
    else if (change === 'unmount') page.unmount();
    else await user.click(screen.getByRole('link', { name: change }));
    const location = screen.queryByTestId('location')?.textContent;
    await act(async () => pending.reject(rejection()));
    expect(screen.queryByText('Invalid native preparation request')).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue('Old private title')).not.toBeInTheDocument();
    expect(screen.queryByTestId('location')?.textContent).toBe(location);
    expect(create).toHaveBeenCalledTimes(1);
  },
);

it('ignores a late successful creation after navigating to another draft', async () => {
  const pending = deferred<{ id: string }>();
  create.mockReturnValue(pending.promise);
  get.mockRejectedValue(new ApiError(404, 'Not found'));
  const user = userEvent.setup();
  renderPage();
  await user.type(await screen.findByRole('textbox', { name: 'Title' }), 'Original');
  await user.click(screen.getByRole('button', { name: 'Create native draft' }));
  await user.click(screen.getByRole('link', { name: 'Other draft' }));
  await screen.findByRole('alert');
  await act(async () => pending.resolve({ id: create.mock.calls[0][1].intentId }));
  expect(screen.queryByText('Native workspace status')).not.toBeInTheDocument();
  expect(screen.getByTestId('location').textContent).toBe(`${entry}&draftId=${draftId}`);
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

it('disables each platform-disabled CLI while retaining the temporary Kiro restriction', async () => {
  capabilities.mockResolvedValue({
    preparationEnabled: true,
    executionEnabled: true,
    unavailableHarnesses: {
      codex: 'agent_cli_disabled',
      opencode: 'agent_cli_disabled',
      kiro: 'NATIVE_EXECUTION_KIRO_UNAVAILABLE',
    },
  });
  renderPage();
  expect(await screen.findByRole('option', { name: 'Codex' })).toBeDisabled();
  expect(screen.getByRole('option', { name: 'OpenCode' })).toBeDisabled();
  expect(screen.getByRole('option', { name: /Kiro/ })).toBeDisabled();
  expect(screen.getByRole('option', { name: 'Claude Code' })).toBeEnabled();
  expect(create).not.toHaveBeenCalled();
});

it.each(['disabled', 'source-changed', 'package-not-ready'])(
  'blocks creation for %s',
  async (scenario) => {
    if (scenario === 'disabled')
      capabilities.mockResolvedValue({
        preparationEnabled: false,
        executionEnabled: false,
        unavailableHarnesses: { kiro: 'NATIVE_EXECUTION_KIRO_UNAVAILABLE' },
      });
    if (scenario === 'source-changed')
      list.mockResolvedValue([{ sourceId, revision: 'changed', status: 'active' }]);
    if (scenario === 'package-not-ready') getPackageImport.mockResolvedValue({ state: 'RUNNING' });
    renderPage();
    await screen.findByRole('alert');
    await waitFor(() => {
      const button = screen.queryByRole('button', { name: 'Create native draft' });
      if (scenario === 'disabled') expect(button).not.toBeInTheDocument();
      else expect(button).toBeDisabled();
    });
    expect(create).not.toHaveBeenCalled();
  },
);

it('uses normal New intent, retains written work across backend choice and imports a package inline as a member', async () => {
  create.mockImplementation((_project, request) => Promise.resolve({ id: request.intentId }));
  createPackageImport.mockImplementation((_project, source, request) =>
    Promise.resolve({
      jobId: request.jobId,
      sourceId: source,
      requestedRelease: request.requestedRelease,
      state: 'SUCCEEDED',
      package: {
        version: '2.11.1',
        release: 'v2.11.1',
        commit: 'b'.repeat(40),
        harnesses: ['claude', 'codex', 'kiro', 'opencode'],
      },
    }),
  );
  const user = userEvent.setup();
  const { container } = renderPage('/space/project-1/intent/new');
  expect(screen.getByLabelText('Execution backend')).toHaveValue('platform');
  await user.type(screen.getByLabelText('Title'), 'Shared request');
  await user.type(screen.getByLabelText('Prompt'), 'Keep the written request.');
  await user.selectOptions(screen.getByLabelText('Execution backend'), 'native');
  expect(await screen.findByLabelText('Coding harness')).toHaveValue('codex');
  expect(screen.getByLabelText('Title')).toHaveValue('Shared request');
  expect(screen.getByLabelText('Prompt')).toHaveValue('Keep the written request.');
  expect(await screen.findByLabelText('Release version')).toHaveValue('v2.11.1');
  expect(screen.queryByText('Add a workflow source')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Create native draft' })).toBeDisabled();
  expect(container.querySelector('form form')).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Import package' }));
  expect(create).not.toHaveBeenCalled();
  await user.click(await screen.findByRole('button', { name: 'Use this package' }));
  expect(screen.getByRole('region', { name: 'Selected workflow package' })).toHaveTextContent(
    'v2.11.1',
  );
  await user.click(screen.getByRole('button', { name: 'Create native draft' }));
  await screen.findByText('Native workspace status');
  expect(createPackageImport).toHaveBeenCalledTimes(1);
  expect(create).toHaveBeenCalledTimes(1);
  expect(create.mock.calls[0][1]).toMatchObject({
    title: 'Shared request',
    prompt: 'Keep the written request.',
    packageJobId: createPackageImport.mock.calls[0][2].jobId,
    applicationSource: { provider: 'github', repository: 'owner/app' },
  });
  expect(create.mock.calls[0][1]).not.toHaveProperty('constructionGateAutonomy');
});

it('requires one application choice and locks backend, package and repository after an uncertain create', async () => {
  useProjectCache.mockReturnValue({
    project: {
      id: 'project-1',
      userRole: 'member',
      trackers: [],
      repos: [
        { provider: 'github', url: 'owner/first' },
        { provider: 'gitlab', url: 'group/selected' },
        { provider: 'codecommit', url: 'excluded' },
      ],
    },
    loading: false,
  });
  create.mockRejectedValue(new Error('Response lost'));
  const user = userEvent.setup();
  renderPage();
  await user.type(await screen.findByLabelText('Title'), 'Selected application');
  const repository = screen.getByLabelText('Application repository');
  expect(repository).toHaveValue('');
  expect(screen.queryByRole('option', { name: /excluded/ })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Create native draft' })).toBeDisabled();
  await user.selectOptions(repository, JSON.stringify(['gitlab', 'group/selected']));
  await user.click(screen.getByRole('button', { name: 'Create native draft' }));
  await screen.findByRole('alert');
  expect(create.mock.calls[0][1].applicationSource).toEqual({
    provider: 'gitlab',
    repository: 'group/selected',
  });
  expect(repository).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Choose another package' })).toBeDisabled();
  const backend = screen.getByLabelText('Execution backend');
  expect(backend).toBeDisabled();
  fireEvent.change(backend, { target: { value: 'platform' } });
  expect(backend).toHaveValue('native');
  expect(create).toHaveBeenCalledTimes(1);
});

it('does not advertise another imported methodology version as native support', async () => {
  getPackageImport.mockResolvedValue({ state: 'SUCCEEDED', package: { version: '2.12.0' } });
  renderPage();
  expect(await screen.findByRole('alert')).toHaveTextContent('supports AI-DLC 2.11.1');
  expect(screen.getByRole('button', { name: 'Create native draft' })).toBeDisabled();
  expect(create).not.toHaveBeenCalled();
});

it('recovers only the original draft even without package query fields', async () => {
  get.mockResolvedValue({ id: draftId });
  renderPage(`/space/project-1/intent/new?draftId=${draftId}`);
  await screen.findByText('Native workspace status');
  expect(get).toHaveBeenCalledExactlyOnceWith('project-1', draftId);
  expect(capabilities).not.toHaveBeenCalled();
  expect(create).not.toHaveBeenCalled();
});

it('redirects the previous creation link to the normal entry without submitting', async () => {
  renderPage(entry.replace('/intent/new?backend=native&', '/native-intent/new?'));
  await screen.findByLabelText('Coding harness');
  const url = new URL(screen.getByTestId('location').textContent!, 'https://example.test');
  expect(url.pathname).toBe('/space/project-1/intent/new');
  expect(url.searchParams.get('backend')).toBe('native');
  expect(url.searchParams.get('packageJobId')).toBe(jobId);
  expect(create).not.toHaveBeenCalled();
});
