// The engine choice on the New Intent page. The platform's native-execution
// flag reaches the page through the space response SpacePermissionsProvider
// polls, so these tests render the real provider over a mocked space response.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router';
import { ApiError } from '@/services/api';

// Radix Select relies on pointer-capture / scrollIntoView APIs jsdom doesn't
// implement — polyfill just enough for the trigger/option interaction below.
beforeEach(() => {
  window.HTMLElement.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
  window.HTMLElement.prototype.setPointerCapture = vi.fn();
  window.HTMLElement.prototype.releasePointerCapture = vi.fn();
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
});

const useProjectCache = vi.fn();
vi.mock('@/hooks/useProjectsCache', () => ({
  useProjectCache: (...a: unknown[]) => useProjectCache(...a),
}));

const getSpace = vi.fn();
vi.mock('@/services/projects', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/projects')>()),
  projectsService: { get: (...a: unknown[]) => getSpace(...a) },
}));

const create = vi.fn();
const getIntent = vi.fn();
vi.mock('@/services/intents', () => ({
  intentsService: {
    create: (...a: unknown[]) => create(...a),
    get: (...a: unknown[]) => getIntent(...a),
  },
}));

const listBranches = vi.fn();
vi.mock('@/services/sourceControl', () => ({
  sourceControlService: { listBranches: (...a: unknown[]) => listBranches(...a) },
}));

const listReleases = vi.fn();
const listChannels = vi.fn();
vi.mock('@/services/aidlcReleases', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/aidlcReleases')>()),
  aidlcReleasesService: {
    list: (...a: unknown[]) => listReleases(...a),
    sharedChannels: (...a: unknown[]) => listChannels(...a),
  },
}));

const listIssuePages = vi.fn();
vi.mock('@/services/trackers', () => ({
  trackersService: {
    getIssue: vi.fn(),
    listComments: vi.fn().mockResolvedValue([]),
    listIssuePages: (...a: unknown[]) => listIssuePages(...a),
  },
}));

import NewIntentPage from './NewIntentPage';
import { SpacePermissionsProvider } from '@/contexts/SpacePermissionsContext';

const REPO = { url: 'owner/repo', role: 'primary' };
const WEB = { url: 'owner/web', role: 'secondary' };

const project = (over: Record<string, unknown> = {}) => ({
  id: 'p1',
  name: 'P',
  gitProvider: 'github',
  gitRepo: 'owner/repo',
  agentCli: 'kiro',
  createdAt: 'T',
  trackers: [],
  repos: [REPO],
  ...over,
});

// The single-space response: the permissions and, for a v2 space, the flag.
// The writer is an owner, the only role the autonomy opt-in is offered to, so
// the platform form shows every control a native intent must not get.
const space = (flag?: 'enabled' | 'disabled', write = true) => ({
  ...project(),
  userRole: write ? 'owner' : 'viewer',
  permissions: { read: true, write, manage: write },
  ...(flag ? { nativeExecution: flag } : {}),
});

// A stable release that offers construction autonomy, so the platform form
// shows every release control a native intent must not get.
const offerARelease = () => {
  listReleases.mockResolvedValue({
    releases: [
      {
        releaseId: 'aidlc:aaa111bbb222',
        sourceSha: 'aaa111bbb222',
        importerRevision: 1,
        upstreamVersion: '1.2.0',
        upstreamChannel: 'stable',
        supportState: 'selectable',
        structurallyValid: true,
        visible: true,
        runnable: true,
        constructionAutonomy: true,
        revision: 1,
      },
    ],
  });
  listChannels.mockResolvedValue({
    pinningEnabled: true,
    stable: { channel: 'stable', releaseId: 'aidlc:aaa111bbb222', revision: 1 },
    candidate: null,
    preview: null,
  });
};

const ComposePage = () => {
  const { state } = useLocation();
  return <div data-testid="compose-page">{JSON.stringify(state)}</div>;
};

const renderPage = (initialEntry = '/space/p1/intent/new') =>
  render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <SpacePermissionsProvider projectId="p1">
        <Routes>
          <Route path="/space/:projectId/intent/new" element={<NewIntentPage />} />
          <Route path="/space/:projectId/intent/:intentId/compose" element={<ComposePage />} />
        </Routes>
      </SpacePermissionsProvider>
    </MemoryRouter>,
  );

const chooseNative = async (user: ReturnType<typeof userEvent.setup>) =>
  user.click(await screen.findByRole('radio', { name: /native ai-dlc/i }));

const submit = async (user: ReturnType<typeof userEvent.setup>, name: RegExp) => {
  const button = screen.getByRole('button', { name });
  await waitFor(() => expect(button).toBeEnabled());
  await user.click(button);
  await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
  return create.mock.calls[0][1];
};

beforeEach(() => {
  create.mockReset().mockResolvedValue({ id: 'i1' });
  getIntent.mockReset();
  getSpace.mockReset().mockResolvedValue(space('enabled'));
  listBranches
    .mockReset()
    .mockResolvedValue({ branches: ['main', 'develop'], defaultBranch: 'main' });
  listReleases.mockReset().mockResolvedValue({ releases: [] });
  listChannels.mockReset().mockResolvedValue({ pinningEnabled: false });
  listIssuePages.mockReset();
  useProjectCache.mockReset().mockReturnValue({ project: project(), loading: false });
});

describe('NewIntentPage — native execution disabled', () => {
  it.each([
    ['reports it as disabled', 'disabled' as const],
    ['does not report it', undefined],
  ])('offers no engine choice when the space %s', async (_label, flag) => {
    getSpace.mockResolvedValue(space(flag));
    const user = userEvent.setup();
    renderPage();
    await user.type(await screen.findByLabelText('Prompt'), 'Build X');
    await waitFor(() => expect(getSpace).toHaveBeenCalled());

    expect(screen.queryByTestId('engine-choice')).not.toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    const payload = await submit(user, /continue to compose/i);
    expect(payload).not.toHaveProperty('engine');
    expect(payload.primaryRepo).toBeUndefined();
  });
});

describe('NewIntentPage — native execution enabled', () => {
  it('offers both engines and keeps the platform one selected', async () => {
    offerARelease();
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByRole('radio', { name: /platform workflow/i })).toBeChecked();
    expect(screen.getByRole('radio', { name: /native ai-dlc/i })).not.toBeChecked();
    await user.type(screen.getByLabelText('Prompt'), 'Build X');
    const payload = await submit(user, /continue to compose/i);
    // The platform request is the one the page sent before the choice existed.
    expect(payload).not.toHaveProperty('engine');
    expect(payload.primaryRepo).toBeUndefined();
  });

  it('removes the release, autonomy and directory controls for a native intent', async () => {
    offerARelease();
    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByLabelText('AI-DLC version')).toBeInTheDocument();
    expect(screen.getByLabelText('Autonomous construction')).toBeInTheDocument();
    expect(screen.getByText('Repository directories (optional)')).toBeInTheDocument();

    await chooseNative(user);

    expect(screen.queryByLabelText('AI-DLC version')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Autonomous construction')).not.toBeInTheDocument();
    expect(screen.queryByText('Repository directories (optional)')).not.toBeInTheDocument();
    // The base branch is still chosen per repository.
    expect(screen.getByText('Base branch')).toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: /platform workflow/i }));
    expect(screen.getByLabelText('AI-DLC version')).toBeInTheDocument();
    expect(screen.getByText('Repository directories (optional)')).toBeInTheDocument();
  });

  it('creates a native draft with none of the plan inputs and opens it', async () => {
    offerARelease();
    const user = userEvent.setup();
    renderPage();
    // Inputs of the platform form that a native create must not carry.
    await user.click(await screen.findByLabelText('Autonomous construction'));
    await user.click(screen.getByText('Repository directories (optional)'));
    await user.type(screen.getByLabelText('Directories for owner/repo'), 'services/api');

    await chooseNative(user);
    await user.type(screen.getByLabelText('Title'), 'Add auth');
    await user.type(screen.getByLabelText('Prompt'), 'Build X');
    const payload = await submit(user, /create draft/i);

    // One repository: the server takes it as the primary one.
    expect(payload).toEqual({ engine: 'native', title: 'Add auth', prompt: 'Build X' });
    for (const field of [
      'scope',
      'composedGrid',
      'skipStageIds',
      'aidlcSettings',
      'methodologyReleaseId',
      'methodologyReleaseTest',
      'constructionGateAutonomy',
      'sparseCheckout',
    ]) {
      expect(payload).not.toHaveProperty(field);
    }
    expect(await screen.findByTestId('compose-page')).toBeInTheDocument();
  });

  it('does not wait for the release lookup', async () => {
    listChannels.mockReturnValue(new Promise(() => {}));
    const user = userEvent.setup();
    renderPage();
    await chooseNative(user);
    await user.type(screen.getByLabelText('Prompt'), 'Build X');
    expect((await submit(user, /create draft/i)).engine).toBe('native');
  });

  it('sends the base branch picked for a native intent', async () => {
    const user = userEvent.setup();
    renderPage();
    await chooseNative(user);
    await user.type(screen.getByLabelText('Prompt'), 'Build X');
    await user.click(screen.getByText('Base branch'));
    await user.click(await screen.findByLabelText('owner/repo'));
    await user.click(await screen.findByRole('option', { name: 'develop' }));

    const payload = await submit(user, /create draft/i);
    expect(payload).toEqual({
      engine: 'native',
      title: '',
      prompt: 'Build X',
      baseBranches: { 'owner/repo': 'develop' },
    });
  });

  describe('in a space with several repositories', () => {
    beforeEach(() => {
      // The space's primary repository is not the first of the list.
      useProjectCache.mockReturnValue({
        project: project({ repos: [WEB, REPO] }),
        loading: false,
      });
    });

    it('asks for the primary repository only for a native intent', async () => {
      const user = userEvent.setup();
      renderPage();
      await screen.findByTestId('engine-choice');
      expect(screen.queryByLabelText('Primary repository')).not.toBeInTheDocument();
      await chooseNative(user);
      expect(screen.getByLabelText('Primary repository')).toBeInTheDocument();
    });

    it('starts with the primary repository of the space', async () => {
      const user = userEvent.setup();
      renderPage();
      await chooseNative(user);
      expect(screen.getByLabelText('Primary repository')).toHaveTextContent('owner/repo');
      await user.type(screen.getByLabelText('Prompt'), 'Build X');

      const payload = await submit(user, /create draft/i);
      expect(payload).toEqual({
        engine: 'native',
        title: '',
        prompt: 'Build X',
        primaryRepo: 'owner/repo',
      });
    });

    it('sends the repository the member picked', async () => {
      const user = userEvent.setup();
      renderPage();
      await chooseNative(user);
      await user.click(screen.getByLabelText('Primary repository'));
      await user.click(await screen.findByRole('option', { name: 'owner/web' }));
      await user.type(screen.getByLabelText('Prompt'), 'Build X');

      expect((await submit(user, /create draft/i)).primaryRepo).toBe('owner/web');
    });

    it('falls back to the first repository when the space marks none as primary', async () => {
      useProjectCache.mockReturnValue({
        project: project({ repos: [WEB, { url: 'owner/api', role: 'backend' }] }),
        loading: false,
      });
      const user = userEvent.setup();
      renderPage();
      await chooseNative(user);
      await user.type(screen.getByLabelText('Prompt'), 'Build X');

      expect((await submit(user, /create draft/i)).primaryRepo).toBe('owner/web');
    });
  });

  it('holds a native create back in a space without a repository', async () => {
    useProjectCache.mockReturnValue({ project: project({ repos: [] }), loading: false });
    const user = userEvent.setup();
    renderPage();
    await chooseNative(user);
    await user.type(screen.getByLabelText('Prompt'), 'Build X');

    expect(screen.getByRole('status')).toHaveTextContent('A native intent needs a repository');
    expect(screen.getByRole('button', { name: /create draft/i })).toBeDisabled();
    // The platform engine has no such requirement.
    await user.click(screen.getByRole('radio', { name: /platform workflow/i }));
    expect(screen.getByRole('button', { name: /continue to compose/i })).toBeEnabled();
    expect(create).not.toHaveBeenCalled();
  });

  it('imports a tracker issue into a native intent as into a platform one', async () => {
    const issue = {
      resourceId: 'PROJ-1',
      resourceType: 'issue',
      resourceUrl: 'https://tracker.example/PROJ-1',
      title: 'PROJ-1',
      body: 'Issue text',
      labels: [],
      author: { handle: 'Author' },
      createdAt: '2026-01-01T00:00:00Z',
    };
    listIssuePages.mockImplementation(async function* () {
      yield { items: [issue], done: true };
    });
    useProjectCache.mockReturnValue({
      project: project({
        trackers: [
          { id: 'gh', provider: 'github', instance: null, externalProjectKey: 'owner/repo' },
        ],
      }),
      loading: false,
    });
    const user = userEvent.setup();
    renderPage();
    await chooseNative(user);
    await user.click(await screen.findByRole('button', { name: /PROJ-1/ }));
    await waitFor(() =>
      expect(screen.getByLabelText('Prompt')).toHaveValue('# PROJ-1\n\nIssue text'),
    );

    const payload = await submit(user, /create draft/i);
    expect(payload).toEqual({
      engine: 'native',
      title: 'PROJ-1',
      prompt: '# PROJ-1\n\nIssue text',
      source: {
        bindingId: 'gh',
        resourceType: 'issue',
        resourceId: 'PROJ-1',
        resourceUrl: 'https://tracker.example/PROJ-1',
      },
    });
    // The draft page imports the issue's attachments, as for a platform intent.
    expect(await screen.findByTestId('compose-page')).toHaveTextContent(
      '{"importTrackerAttachments":true}',
    );
  });

  it.each([
    ['asks for a release', '?release=aidlc:aaa111bbb222'],
    ['tests a release', '?testRelease=1'],
    ['starts from another intent', '?fromIntent=i0'],
  ])('offers no engine choice on a page that %s', async (_label, query) => {
    offerARelease();
    getIntent.mockResolvedValue({ intent: { id: 'i0', title: 'Old', prompt: 'Build X' } });
    renderPage(`/space/p1/intent/new${query}`);
    await screen.findByLabelText('Prompt');
    await waitFor(() => expect(getSpace).toHaveBeenCalled());
    await act(async () => {});

    expect(screen.queryByTestId('engine-choice')).not.toBeInTheDocument();
  });

  // The flag the browser sees can read `disabled` for a minute after a failed
  // read. It decides what is offered, never what the member has chosen.
  const flagReadsDisabled = async () => {
    const polls = getSpace.mock.calls.length;
    getSpace.mockResolvedValue(space('disabled'));
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(getSpace.mock.calls.length).toBeGreaterThan(polls));
    await act(async () => {});
  };

  it('withdraws the choice when the flag is switched off and the member kept the platform engine', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByTestId('engine-choice');
    await user.type(screen.getByLabelText('Prompt'), 'Build X');

    await flagReadsDisabled();

    expect(screen.queryByTestId('engine-choice')).not.toBeInTheDocument();
    expect(await submit(user, /continue to compose/i)).not.toHaveProperty('engine');
  });

  it('keeps a chosen native form when the flag reads disabled, and never creates a platform intent for it', async () => {
    offerARelease();
    create.mockRejectedValue(
      new ApiError(409, 'Native execution is disabled', { code: 'native_execution_disabled' }),
    );
    const user = userEvent.setup();
    renderPage();
    await chooseNative(user);
    await user.type(screen.getByLabelText('Prompt'), 'Build X');

    await flagReadsDisabled();

    // Still the native form: the choice is on screen and nothing of the
    // platform form came back.
    expect(screen.getByRole('radio', { name: /native ai-dlc/i })).toBeChecked();
    expect(screen.queryByLabelText('AI-DLC version')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /continue to compose/i })).not.toBeInTheDocument();
    // The server reads the flag itself and answers by name.
    expect(await submit(user, /create draft/i)).toMatchObject({ engine: 'native' });
    expect(await screen.findByRole('alert')).toHaveTextContent('Native execution is disabled');

    // Going back to the platform engine is the member's own step, and the
    // choice is then gone with the flag.
    create.mockReset().mockResolvedValue({ id: 'i1' });
    await user.click(screen.getByRole('radio', { name: /platform workflow/i }));
    expect(screen.queryByTestId('engine-choice')).not.toBeInTheDocument();
    expect(await submit(user, /continue to compose/i)).not.toHaveProperty('engine');
  });

  it('shows the refusal of the server and stays on the page', async () => {
    create.mockRejectedValue(
      new ApiError(409, 'Native execution is disabled', { code: 'native_execution_disabled' }),
    );
    const user = userEvent.setup();
    renderPage();
    await chooseNative(user);
    await user.type(screen.getByLabelText('Prompt'), 'Build X');
    await submit(user, /create draft/i);

    expect(await screen.findByRole('alert')).toHaveTextContent('Native execution is disabled');
    expect(screen.queryByTestId('compose-page')).not.toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /native ai-dlc/i })).toBeChecked();
  });

  it('lets a viewer see the choice but not make it', async () => {
    getSpace.mockResolvedValue(space('enabled', false));
    renderPage();
    const choice = await screen.findByTestId('engine-choice');
    for (const radio of within(choice).getAllByRole('radio')) expect(radio).toBeDisabled();
  });
});
