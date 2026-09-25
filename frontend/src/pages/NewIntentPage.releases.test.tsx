import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router';

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
vi.mock('@/services/aidlcReleases', () => ({
  aidlcReleasesService: {
    list: (...a: unknown[]) => listReleases(...a),
    channels: (...a: unknown[]) => listChannels(...a),
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

  it('preselects the stable channel release and sends its id', async () => {
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

    await submitPrompt(user);
    expect(create.mock.calls[0][1].methodologyReleaseId).toBe('aidlc:aaa111bbb222');
  });

  it('lets the user pick a non-default release', async () => {
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

    await submitPrompt(user);
    expect(create.mock.calls[0][1].methodologyReleaseId).toBe('aidlc:ccc333');
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
    listReleases.mockResolvedValue({ releases: [release()] });
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
    await screen.findByLabelText('AI-DLC version');

    await submitPrompt(user);
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(
      await screen.findByText(/AI-DLC version selection was disabled while this page was open/i),
    ).toBeInTheDocument();
    expect(create.mock.calls[0][1].methodologyReleaseId).toBe('aidlc:aaa111bbb222');
    expect(create.mock.calls[1][1].methodologyReleaseId).toBeUndefined();
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
    listReleases.mockResolvedValue({ releases: [reducedRelease()] });
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

    await submitPrompt(user);
    expect(create.mock.calls[0][1].methodologyReleaseId).toBe('aidlc:aaa111bbb222');
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

  it('creates the new intent with the selected release while the source stays untouched', async () => {
    getIntent.mockResolvedValue(sourceDetail);
    const user = userEvent.setup();
    renderPage('/space/p1/intent/new?fromIntent=i0');
    await screen.findByDisplayValue('Ship search (AI-DLC 1.2.0)');

    await user.click(screen.getByRole('button', { name: /continue to compose/i }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0][1]).toMatchObject({
      title: 'Ship search (AI-DLC 1.2.0)',
      prompt: 'Original prompt body',
      methodologyReleaseId: 'aidlc:aaa111bbb222',
    });
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
