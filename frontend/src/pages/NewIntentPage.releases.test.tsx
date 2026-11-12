import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Link, MemoryRouter, Routes, Route, useLocation } from 'react-router';

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

const create = vi.fn();
const getIntent = vi.fn();
vi.mock('@/services/intents', () => ({
  intentsService: {
    create: (...a: unknown[]) => create(...a),
    get: (...a: unknown[]) => getIntent(...a),
  },
}));

vi.mock('@/services/sourceControl', () => ({
  sourceControlService: { listBranches: vi.fn() },
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

import NewIntentPage from './NewIntentPage';

const release = (over: Record<string, unknown> = {}) => ({
  releaseId: 'aidlc:aaa111bbb222',
  sourceSha: 'aaa111bbb222',
  importerRevision: 1,
  closureDigest: 'd'.repeat(64),
  manifestKey: 'm',
  catalogKey: 'c',
  profileId: 'p',
  upstreamVersion: '1.2.0',
  upstreamChannel: 'stable',
  trustTier: 'T3',
  supportState: 'selectable',
  structurallyValid: true,
  visible: true,
  runnable: true,
  notes: null,
  registeredAt: null,
  registeredBy: null,
  updatedAt: null,
  updatedBy: null,
  certifiedAt: null,
  certifiedBy: null,
  revision: 1,
  ...over,
});

const project = {
  id: 'p1',
  name: 'P',
  gitProvider: 'github',
  gitRepo: 'owner/repo',
  agentCli: 'kiro',
  createdAt: 'T',
  trackers: [],
  repos: [],
};

const ComposePage = () => {
  const { state } = useLocation();
  const releaseSelectionFallback = (state as { releaseSelectionFallback?: boolean } | null)
    ?.releaseSelectionFallback;
  return (
    <div data-testid="compose-page">
      {releaseSelectionFallback && (
        <p role="status">
          AI-DLC version selection was disabled while this page was open. This intent will use the
          platform default.
        </p>
      )}
    </div>
  );
};

const renderPage = (initialEntry = '/space/p1/intent/new') =>
  render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/space/:projectId/intent/new" element={<NewIntentPage />} />
        <Route path="/space/:projectId/intent/:intentId/compose" element={<ComposePage />} />
      </Routes>
    </MemoryRouter>,
  );

const submitPrompt = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.type(await screen.findByLabelText('Prompt'), 'Build X');
  const submit = screen.getByRole('button', { name: /continue to compose/i });
  await waitFor(() => expect(submit).toBeEnabled());
  await user.click(submit);
  await waitFor(() => expect(create).toHaveBeenCalled());
};

describe('NewIntentPage — AI-DLC release selection', () => {
  beforeEach(() => {
    create.mockReset().mockResolvedValue({ id: 'i1' });
    getIntent.mockReset();
    useProjectCache.mockReset().mockReturnValue({ project, loading: false });
    listReleases.mockReset();
    listChannels.mockReset();
  });

  it.each(['2.3.3', '2.6.18', '2.7.0', '2.8.2', '2.9.0', '2.11.0', '2.11.1', '2.11.3'])(
    'pins the requested %s version exactly, even when it is the default',
    async (version) => {
      const releaseId = 'aidlc:' + version;
      listReleases.mockResolvedValue({
        releases: [release({ releaseId, upstreamVersion: version })],
      });
      listChannels.mockResolvedValue({
        pinningEnabled: true,
        stable: { releaseId, revision: 1 },
        candidate: null,
        preview: null,
      });
      const user = userEvent.setup();
      renderPage('/space/p1/intent/new?release=' + encodeURIComponent(releaseId));
      expect(await screen.findByLabelText('AI-DLC version')).toHaveTextContent(version);
      await submitPrompt(user);
      expect(create.mock.calls[0][1].methodologyReleaseId).toBe(releaseId);
      expect(await screen.findByTestId('compose-page')).toBeInTheDocument();
    },
  );

  it('lets the explicit admin test flow select a hidden qualified release and labels the request', async () => {
    listReleases.mockResolvedValue({ releases: [release({ visible: false })] });
    listChannels.mockResolvedValue({ pinningEnabled: true, stable: null });
    const user = userEvent.setup();
    renderPage('/space/p1/intent/new?release=aidlc%3Aaaa111bbb222&testRelease=1');
    expect(await screen.findByRole('status')).toHaveTextContent('Version validation');
    await submitPrompt(user);
    expect(create.mock.calls[0][1]).toMatchObject({
      methodologyReleaseId: 'aidlc:aaa111bbb222',
      methodologyReleaseTest: true,
    });
  });

  it('does not offer hidden or unpromoted records returned to an administrator', async () => {
    listReleases.mockResolvedValue({
      releases: [
        release(),
        release({ releaseId: 'hidden', visible: false, upstreamVersion: 'hidden-version' }),
        release({
          releaseId: 'unpromoted',
          supportState: 'structurally-valid',
          upstreamVersion: 'unpromoted-version',
        }),
      ],
    });
    listChannels.mockResolvedValue({
      pinningEnabled: true,
      stable: null,
      candidate: null,
      preview: null,
    });
    const user = userEvent.setup();
    renderPage('/space/p1/intent/new?release=unpromoted');
    expect(await screen.findByRole('alert')).toHaveTextContent('no longer available');
    await user.type(await screen.findByLabelText('Prompt'), 'Test');
    expect(screen.getByRole('button', { name: /continue to compose/i })).toBeDisabled();
    await user.click(screen.getByLabelText('AI-DLC version'));
    expect(
      screen.queryByRole('option', { name: /hidden-version|unpromoted-version/ }),
    ).not.toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();
  });

  it('blocks a requested version when release selection is disabled', async () => {
    listChannels.mockResolvedValue({ pinningEnabled: false });
    const user = userEvent.setup();
    renderPage('/space/p1/intent/new?release=aidlc%3Aaaa111bbb222');
    expect(await screen.findByRole('alert')).toHaveTextContent('release selection is disabled');
    await user.type(await screen.findByLabelText('Prompt'), 'Test');
    expect(screen.getByRole('button', { name: /continue to compose/i })).toBeDisabled();
    expect(create).not.toHaveBeenCalled();
  });

  it('never retries an explicit test-version intent without its pin', async () => {
    listReleases.mockResolvedValue({ releases: [release()] });
    listChannels.mockResolvedValue({
      pinningEnabled: true,
      stable: null,
      candidate: null,
      preview: null,
    });
    const { ApiError } = await import('@/services/api');
    create.mockRejectedValueOnce(
      new ApiError(400, 'Version selection was disabled', { code: 'release_selection_disabled' }),
    );
    const user = userEvent.setup();
    renderPage('/space/p1/intent/new?release=aidlc%3Aaaa111bbb222');
    await submitPrompt(user);
    expect(await screen.findByRole('alert')).toHaveTextContent('Version selection was disabled');
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][1].methodologyReleaseId).toBe('aidlc:aaa111bbb222');
    expect(screen.queryByTestId('compose-page')).not.toBeInTheDocument();
  });

  // Leaving an explicit version for the default page is a new lookup. Until it
  // settles nothing may be submitted, and the previous version is never pinned.
  it('drops an explicit version when the page returns to the default selection', async () => {
    const other = release({ releaseId: 'aidlc:ccc333', sourceSha: 'ccc333ddd444' });
    listReleases.mockResolvedValue({ releases: [release(), other] });
    listChannels.mockResolvedValueOnce({
      pinningEnabled: true,
      stable: { channel: 'stable', releaseId: 'aidlc:aaa111bbb222', revision: 1 },
      candidate: null,
      preview: null,
    });
    let settle: (value: unknown) => void = () => {};
    listChannels.mockReturnValueOnce(
      new Promise((resolve) => {
        settle = resolve;
      }),
    );
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/space/p1/intent/new?release=aidlc%3Accc333']}>
        <Link to="/space/p1/intent/new">Default version</Link>
        <Routes>
          <Route path="/space/:projectId/intent/new" element={<NewIntentPage />} />
          <Route path="/space/:projectId/intent/:intentId/compose" element={<ComposePage />} />
        </Routes>
      </MemoryRouter>,
    );
    await user.type(await screen.findByLabelText('Prompt'), 'Build X');
    const submit = screen.getByRole('button', { name: /continue to compose/i });
    await waitFor(() => expect(submit).toBeEnabled());

    await user.click(screen.getByRole('link', { name: 'Default version' }));
    expect(screen.getByRole('button', { name: /continue to compose/i })).toBeDisabled();

    await act(async () => {
      settle({
        pinningEnabled: true,
        stable: { channel: 'stable', releaseId: 'aidlc:aaa111bbb222', revision: 1 },
        candidate: null,
        preview: null,
      });
    });
    const ready = screen.getByRole('button', { name: /continue to compose/i });
    await waitFor(() => expect(ready).toBeEnabled());
    await user.click(ready);
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0][1].methodologyReleaseId).toBeUndefined();
  });

  it('preselects the stable channel release and leaves the pin to the platform default', async () => {
    listReleases.mockResolvedValue({
      releases: [release(), release({ releaseId: 'aidlc:ccc333', sourceSha: 'ccc333ddd444' })],
    });
    listChannels.mockResolvedValue({
      pinningEnabled: true,
      stable: { channel: 'stable', releaseId: 'aidlc:aaa111bbb222', revision: 1 },
      candidate: null,
      preview: null,
    });
    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByLabelText('AI-DLC version')).toBeInTheDocument();
    expect(screen.getAllByText('1.2.0 (stable, default)').length).toBeGreaterThan(0);
    expect(
      screen.getByText('This intent stays on this version; it is never migrated automatically.'),
    ).toBeInTheDocument();
    expect(listChannels).toHaveBeenCalledTimes(1);
    expect(listReleases).toHaveBeenCalledTimes(1);

    await submitPrompt(user);
    expect(create.mock.calls[0][1].methodologyReleaseId).toBeUndefined();
  });

  it('preserves directory selections when the user picks a non-default release', async () => {
    useProjectCache.mockReturnValue({
      project: { ...project, repos: [{ url: 'owner/repo', role: 'primary' }] },
      loading: false,
    });
    listReleases.mockResolvedValue({
      releases: [
        release(),
        release({
          releaseId: 'aidlc:ccc333',
          sourceSha: 'ccc333ddd444',
          upstreamVersion: '1.3.0',
          supportState: 'certified',
        }),
      ],
    });
    listChannels.mockResolvedValue({
      pinningEnabled: true,
      stable: { channel: 'stable', releaseId: 'aidlc:aaa111bbb222', revision: 1 },
      candidate: null,
      preview: null,
    });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByLabelText('AI-DLC version'));
    await user.click(await screen.findByRole('option', { name: /1\.3\.0/ }));
    await user.click(screen.getByText('Repository directories (optional)'));
    await user.type(screen.getByLabelText('Directories for owner/repo'), 'services/api');

    await submitPrompt(user);
    expect(create.mock.calls[0][1].methodologyReleaseId).toBe('aidlc:ccc333');
    expect(create.mock.calls[0][1].sparseCheckout).toEqual({ 'owner/repo': ['services/api'] });
  });

  it('leaves construction autonomy off unless the box is ticked', async () => {
    listReleases.mockResolvedValue({ releases: [release({ constructionAutonomy: true })] });
    listChannels.mockResolvedValue({
      pinningEnabled: true,
      stable: { channel: 'stable', releaseId: 'aidlc:aaa111bbb222', revision: 1 },
      candidate: null,
      preview: null,
    });
    const user = userEvent.setup();
    renderPage();
    const box = await screen.findByLabelText('Autonomous construction');
    expect(box).not.toBeChecked();

    await submitPrompt(user);
    expect(create.mock.calls[0][1].constructionGateAutonomy).toBeUndefined();
  });

  it('sends the autonomous grant once the box is ticked', async () => {
    listReleases.mockResolvedValue({ releases: [release({ constructionAutonomy: true })] });
    listChannels.mockResolvedValue({
      pinningEnabled: true,
      stable: { channel: 'stable', releaseId: 'aidlc:aaa111bbb222', revision: 1 },
      candidate: null,
      preview: null,
    });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByLabelText('Autonomous construction'));

    await submitPrompt(user);
    expect(create.mock.calls[0][1].constructionGateAutonomy).toBe('autonomous');
  });

  it('offers no autonomy opt-in for a release without the construction protocol', async () => {
    listReleases.mockResolvedValue({ releases: [release()] });
    listChannels.mockResolvedValue({
      pinningEnabled: true,
      stable: { channel: 'stable', releaseId: 'aidlc:aaa111bbb222', revision: 1 },
      candidate: null,
      preview: null,
    });
    const user = userEvent.setup();
    renderPage();
    await screen.findByLabelText('AI-DLC version');
    expect(screen.queryByLabelText('Autonomous construction')).not.toBeInTheDocument();

    await submitPrompt(user);
    expect(create.mock.calls[0][1].constructionGateAutonomy).toBeUndefined();
  });

  it('clears the opt-in when the selection moves to a release without the protocol', async () => {
    listReleases.mockResolvedValue({
      releases: [
        release({ constructionAutonomy: true }),
        release({
          releaseId: 'aidlc:ccc333',
          sourceSha: 'ccc333ddd444',
          upstreamVersion: '1.3.0',
          constructionAutonomy: false,
        }),
      ],
    });
    listChannels.mockResolvedValue({
      pinningEnabled: true,
      stable: { channel: 'stable', releaseId: 'aidlc:aaa111bbb222', revision: 1 },
      candidate: null,
      preview: null,
    });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByLabelText('Autonomous construction'));

    await user.click(screen.getByLabelText('AI-DLC version'));
    await user.click(await screen.findByRole('option', { name: /1\.3\.0/ }));
    expect(screen.queryByLabelText('Autonomous construction')).not.toBeInTheDocument();

    await user.click(screen.getByLabelText('AI-DLC version'));
    await user.click(await screen.findByRole('option', { name: /1\.2\.0/ }));
    expect(await screen.findByLabelText('Autonomous construction')).not.toBeChecked();

    await submitPrompt(user);
    expect(create.mock.calls[0][1].constructionGateAutonomy).toBeUndefined();
  });

  it('offers no autonomy opt-in when no release is on offer', async () => {
    listReleases.mockResolvedValue({ releases: [] });
    listChannels.mockResolvedValue({
      pinningEnabled: true,
      stable: null,
      candidate: null,
      preview: null,
    });
    renderPage();
    await screen.findByLabelText('Prompt');
    expect(screen.queryByLabelText('Autonomous construction')).not.toBeInTheDocument();
  });

  it('hides the selector and omits the field when no release is offered', async () => {
    listReleases.mockResolvedValue({ releases: [] });
    listChannels.mockResolvedValue({ stable: null, candidate: null, preview: null });
    const user = userEvent.setup();
    renderPage();
    await screen.findByLabelText('Prompt');
    expect(screen.queryByLabelText('AI-DLC version')).not.toBeInTheDocument();

    await submitPrompt(user);
    expect(create.mock.calls[0][1].methodologyReleaseId).toBeUndefined();
    expect(listChannels).toHaveBeenCalledTimes(1);
    expect(listReleases).not.toHaveBeenCalled();
  });

  it('hides the selector and omits the field when the registry is unreachable', async () => {
    listReleases.mockRejectedValue(new Error('boom'));
    listChannels.mockRejectedValue(new Error('boom'));
    const user = userEvent.setup();
    renderPage();
    await screen.findByLabelText('Prompt');
    expect(screen.queryByLabelText('AI-DLC version')).not.toBeInTheDocument();

    await submitPrompt(user);
    expect(create.mock.calls[0][1].methodologyReleaseId).toBeUndefined();
  });

  it('omits the field without preselection when the stable channel is unset', async () => {
    listReleases.mockResolvedValue({ releases: [release()] });
    listChannels.mockResolvedValue({
      pinningEnabled: true,
      stable: null,
      candidate: null,
      preview: null,
    });
    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByLabelText('AI-DLC version')).toBeInTheDocument();

    await submitPrompt(user);
    expect(create.mock.calls[0][1].methodologyReleaseId).toBeUndefined();
  });

  it('retries once without the pin when create 400s with release_selection_disabled', async () => {
    useProjectCache.mockReturnValue({
      project: { ...project, repos: [{ url: 'owner/repo', role: 'primary' }] },
      loading: false,
    });
    listReleases.mockResolvedValue({
      releases: [
        release(),
        release({ releaseId: 'aidlc:ccc333', sourceSha: 'ccc333ddd444', upstreamVersion: '1.3.0' }),
      ],
    });
    listChannels.mockResolvedValue({
      pinningEnabled: true,
      stable: { channel: 'stable', releaseId: 'aidlc:aaa111bbb222', revision: 1 },
      candidate: null,
      preview: null,
    });
    const { ApiError } = await import('@/services/api');
    create
      .mockRejectedValueOnce(
        new ApiError(400, 'Per-intent AI-DLC release selection is disabled', {
          error: 'Per-intent AI-DLC release selection is disabled',
          code: 'release_selection_disabled',
        }),
      )
      .mockResolvedValueOnce({ id: 'i1' });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByLabelText('AI-DLC version'));
    await user.click(await screen.findByRole('option', { name: /1\.3\.0/ }));
    await user.click(screen.getByText('Repository directories (optional)'));
    await user.type(screen.getByLabelText('Directories for owner/repo'), 'services/api');

    await submitPrompt(user);
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(
      await screen.findByText(/AI-DLC version selection was disabled while this page was open/i),
    ).toBeInTheDocument();
    expect(create.mock.calls[0][1].methodologyReleaseId).toBe('aidlc:ccc333');
    expect(create.mock.calls[1][1].methodologyReleaseId).toBeUndefined();
    for (const [, input] of create.mock.calls) {
      expect(input.sparseCheckout).toEqual({ 'owner/repo': ['services/api'] });
    }
    expect(await screen.findByTestId('compose-page')).toBeInTheDocument();
  });

  it('hides the selector and creates an unpinned intent when pinning is disabled', async () => {
    listReleases.mockResolvedValue({ releases: [release()] });
    listChannels.mockResolvedValue({
      pinningEnabled: false,
      stable: { channel: 'stable', releaseId: 'aidlc:aaa111bbb222', revision: 1 },
      candidate: null,
      preview: null,
    });
    const user = userEvent.setup();
    renderPage();
    await screen.findByLabelText('Prompt');
    expect(screen.queryByLabelText('AI-DLC version')).not.toBeInTheDocument();

    await submitPrompt(user);
    expect(create.mock.calls[0][1].methodologyReleaseId).toBeUndefined();
    expect(listChannels).toHaveBeenCalledTimes(1);
    expect(listReleases).not.toHaveBeenCalled();
  });
});

// Non-admins receive the reduced release projection — selection fields
// only, no sourceSha. The selector must keep working with it.
describe('NewIntentPage — reduced (non-admin) release projection', () => {
  beforeEach(() => {
    create.mockReset().mockResolvedValue({ id: 'i1' });
    getIntent.mockReset();
    useProjectCache.mockReset().mockReturnValue({ project, loading: false });
    listReleases.mockReset();
    listChannels.mockReset();
  });

  const reducedRelease = (over: Record<string, unknown> = {}) => ({
    releaseId: 'aidlc:aaa111bbb222',
    upstreamVersion: '1.2.0',
    upstreamChannel: 'stable',
    profileId: 'p',
    supportState: 'selectable',
    trustTier: 'T3',
    visible: true,
    runnable: true,
    certifiedAt: null,
    ...over,
  });

  it('offers reduced records and sends the picked id', async () => {
    listReleases.mockResolvedValue({
      releases: [
        reducedRelease(),
        reducedRelease({ releaseId: 'aidlc:ccc333', upstreamVersion: '1.3.0' }),
      ],
    });
    listChannels.mockResolvedValue({
      pinningEnabled: true,
      stable: { channel: 'stable', releaseId: 'aidlc:aaa111bbb222', revision: 1 },
      candidate: null,
      preview: null,
    });
    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByLabelText('AI-DLC version')).toBeInTheDocument();
    expect(screen.getAllByText('1.2.0 (stable, default)').length).toBeGreaterThan(0);
    await user.click(screen.getByLabelText('AI-DLC version'));
    await user.click(await screen.findByRole('option', { name: /1\.3\.0/ }));

    await submitPrompt(user);
    expect(create.mock.calls[0][1].methodologyReleaseId).toBe('aidlc:ccc333');
  });

  it('falls back to the release id when the reduced record has no version label', async () => {
    listReleases.mockResolvedValue({ releases: [reducedRelease({ upstreamVersion: null })] });
    listChannels.mockResolvedValue({
      pinningEnabled: true,
      stable: { channel: 'stable', releaseId: 'aidlc:aaa111bbb222', revision: 1 },
      candidate: null,
      preview: null,
    });
    renderPage();
    expect(await screen.findByLabelText('AI-DLC version')).toBeInTheDocument();
    expect(screen.getAllByText(/aidlc:aaa111bbb222 \(stable, default\)/).length).toBeGreaterThan(0);
  });
});

// C2 opt-in migration: "?fromIntent=<id>" prefills from an existing intent.
// The source intent is never modified — this only seeds the create form.
describe('NewIntentPage — start from an existing intent (?fromIntent)', () => {
  beforeEach(() => {
    create.mockReset().mockResolvedValue({ id: 'i1' });
    getIntent.mockReset();
    useProjectCache.mockReset().mockReturnValue({ project, loading: false });
    listReleases.mockReset().mockResolvedValue({ releases: [release()] });
    listChannels.mockReset().mockResolvedValue({
      pinningEnabled: true,
      stable: { channel: 'stable', releaseId: 'aidlc:aaa111bbb222', revision: 1 },
      candidate: null,
      preview: null,
    });
  });

  const sourceDetail = {
    intent: {
      id: 'i0',
      title: 'Ship search',
      prompt: 'Original prompt body',
      methodologyRelease: {
        releaseId: 'aidlc:old111',
        sourceSha: 'old111abc222',
        importerRevision: 1,
        closureDigest: 'e'.repeat(64),
        upstreamVersion: '1.1.0',
      },
    },
  };

  it('prefills title (with the preselected version) and prompt, and explains the migration', async () => {
    getIntent.mockResolvedValue(sourceDetail);
    renderPage('/space/p1/intent/new?fromIntent=i0');

    await waitFor(() => expect(getIntent).toHaveBeenCalledWith('p1', 'i0'));
    expect(await screen.findByDisplayValue('Ship search (AI-DLC 1.2.0)')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Original prompt body')).toBeInTheDocument();
    expect(screen.getByText(/The original intent is unchanged/)).toBeInTheDocument();
    expect(screen.getByText(/recomputes its plan/)).toBeInTheDocument();
  });

  it('creates the new intent on the stable default while the source stays untouched', async () => {
    getIntent.mockResolvedValue(sourceDetail);
    const user = userEvent.setup();
    renderPage('/space/p1/intent/new?fromIntent=i0');
    await screen.findByDisplayValue('Ship search (AI-DLC 1.2.0)');

    await user.click(screen.getByRole('button', { name: /continue to compose/i }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0][1]).toMatchObject({
      title: 'Ship search (AI-DLC 1.2.0)',
      prompt: 'Original prompt body',
    });
    expect(create.mock.calls[0][1].methodologyReleaseId).toBeUndefined();
  });

  it('degrades to a blank form with a notice when the source intent cannot be loaded', async () => {
    getIntent.mockRejectedValue(new Error('gone'));
    renderPage('/space/p1/intent/new?fromIntent=i0');

    expect(await screen.findByText(/Could not load the source intent/)).toBeInTheDocument();
    expect(screen.getByLabelText('Title')).toHaveValue('');
  });

  it('does not fetch any intent without the parameter', async () => {
    renderPage();
    await screen.findByLabelText('Prompt');
    expect(getIntent).not.toHaveBeenCalled();
  });
});
