import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const list = vi.fn();
const channels = vi.fn();
const profiles = vi.fn();
const update = vi.fn();
const register = vi.fn();
const registerCustom = vi.fn();
const setChannel = vi.fn();
const clearChannel = vi.fn();
vi.mock('@/services/aidlcReleases', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/services/aidlcReleases')>();
  return {
    ...original,
    aidlcReleasesService: {
      list: (...a: unknown[]) => list(...a),
      channels: (...a: unknown[]) => channels(...a),
      profiles: (...a: unknown[]) => profiles(...a),
      update: (...a: unknown[]) => update(...a),
      register: (...a: unknown[]) => register(...a),
      registerCustom: (...a: unknown[]) => registerCustom(...a),
      setChannel: (...a: unknown[]) => setChannel(...a),
      clearChannel: (...a: unknown[]) => clearChannel(...a),
    },
  };
});

import { ApiError } from '@/services/api';
import { AidlcReleasesTab, isValidCustomSource } from './AidlcReleasesTab';

const release = (over: Record<string, unknown> = {}) => ({
  releaseId: 'aidlc:aaa111bbb222',
  sourceSha: 'aaa111bbb222',
  importerRevision: 1,
  closureDigest: 'd'.repeat(64),
  manifestKey: 'm',
  catalogKey: 'c',
  profileId: 'aidlc-1.2.0',
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
  revision: 4,
  ...over,
});

const profile = (over: Record<string, unknown> = {}) => ({
  profileId: 'aidlc-1.2.0',
  releaseId: 'aidlc:aaa111bbb222',
  label: 'AI-DLC 1.2.0',
  upstreamVersion: '1.2.0',
  upstreamChannel: 'stable',
  upstreamRef: 'aaa111bbb222',
  trustTier: 'T3',
  currentPlatformBaseline: true,
  runnable: true,
  published: true,
  importerRevision: 1,
  registered: true,
  supportState: 'selectable',
  revision: 4,
  ...over,
});

const emptyChannels = { stable: null, candidate: null, preview: null };

describe('AidlcReleasesTab', () => {
  beforeAll(() => {
    Object.defineProperties(Element.prototype, {
      hasPointerCapture: { configurable: true, value: () => false },
      setPointerCapture: { configurable: true, value: () => undefined },
      releasePointerCapture: { configurable: true, value: () => undefined },
      scrollIntoView: { configurable: true, value: () => undefined },
    });
  });

  beforeEach(() => {
    list.mockReset().mockResolvedValue({ releases: [release()] });
    channels.mockReset().mockResolvedValue(emptyChannels);
    profiles.mockReset().mockResolvedValue({ profiles: [profile()] });
    update.mockReset();
    register.mockReset();
    registerCustom.mockReset();
    setChannel.mockReset();
    clearChannel.mockReset();
  });

  it('validates custom repositories with the backend GitHub owner and repository grammar', () => {
    const sha = 'a'.repeat(40);
    expect(isValidCustomSource('valid-owner/valid.repo_name', sha, 'v2.9.0')).toBe(true);
    expect(isValidCustomSource('trailing-/repo', sha, 'v2.9.0')).toBe(false);
    expect(isValidCustomSource('two--hyphens/repo', sha, 'v2.9.0')).toBe(false);
    expect(isValidCustomSource('owner/..', sha, 'v2.9.0')).toBe(false);
  });

  it('renders releases, channels and profiles with state badges', async () => {
    list.mockResolvedValue({
      releases: [release(), release({ releaseId: 'aidlc:custom', runnable: false })],
    });
    render(<AidlcReleasesTab />);
    expect(await screen.findByText('Registered releases')).toBeInTheDocument();
    expect(screen.getByText('runnable')).toBeInTheDocument();
    expect(screen.getAllByText('import-only, not runnable').length).toBeGreaterThan(0);
    expect(screen.getAllByText('stable').length).toBeGreaterThan(0);
  });

  it('sends expectedRevision on a visibility toggle', async () => {
    update.mockResolvedValue({ release: release({ visible: false, revision: 5 }) });
    const user = userEvent.setup();
    render(<AidlcReleasesTab />);
    await user.click(await screen.findByLabelText('Visibility for 1.2.0'));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update).toHaveBeenCalledWith('aidlc:aaa111bbb222', {
      expectedRevision: 4,
      visible: false,
    });
  });

  it('explains unsupported authored behavior and disables promotion choices', async () => {
    list.mockResolvedValue({
      releases: [
        release({
          supportState: 'structurally-valid',
          fidelityGaps: [{ blockType: 'STAGE', field: 'mode', value: 'agent-team' }],
          unhonouredValues: [{ blockType: 'STAGE', field: 'mode', value: 'agent-team' }],
        }),
      ],
    });
    const user = userEvent.setup();
    render(<AidlcReleasesTab />);

    expect(
      await screen.findByTestId('release-promotion-gaps-aidlc:aaa111bbb222'),
    ).toHaveTextContent('STAGE.mode=agent-team');
    await user.click(screen.getByLabelText('Support state for 1.2.0'));
    expect(screen.getByRole('option', { name: 'Selectable' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(screen.getByRole('option', { name: 'Certified' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('disables visibility activation when it would expose an unsupported release', async () => {
    list.mockResolvedValue({
      releases: [
        release({
          supportState: 'selectable',
          visible: false,
          unhonouredValues: [{ blockType: 'STAGE', field: 'mode', value: 'agent-team' }],
        }),
      ],
    });
    render(<AidlcReleasesTab />);

    expect(await screen.findByLabelText('Visibility for 1.2.0')).toBeDisabled();
  });

  it('identifies compatibility evidence that has not been cached on a legacy row', async () => {
    list.mockResolvedValue({
      releases: [release({ fidelityGaps: null, unhonouredValues: null })],
    });
    render(<AidlcReleasesTab />);

    expect(
      await screen.findByTestId('release-promotion-unverified-aidlc:aaa111bbb222'),
    ).toHaveTextContent(/server will verify its immutable closure before promotion/i);
  });

  it('shows the readable API reason when promotion is refused', async () => {
    list.mockResolvedValue({ releases: [release({ supportState: 'structurally-valid' })] });
    update.mockRejectedValue(
      new ApiError(400, 'authored behavior is unsupported', {
        code: 'release_capability_unhandled',
        details: {
          gaps: [{ blockType: 'STAGE', field: 'mode', value: 'agent-team' }],
        },
      }),
    );
    const user = userEvent.setup();
    render(<AidlcReleasesTab />);

    await user.click(await screen.findByLabelText('Support state for 1.2.0'));
    await user.click(screen.getByRole('option', { name: 'Selectable' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /this build cannot honour: STAGE\.mode=agent-team/i,
    );
  });

  it('shows a conflict message and refetches on a 409 (stale revision)', async () => {
    update.mockRejectedValue(
      new ApiError(409, 'modified concurrently', { code: 'release_revision_conflict' }),
    );
    const user = userEvent.setup();
    render(<AidlcReleasesTab />);
    await user.click(await screen.findByLabelText('Visibility for 1.2.0'));
    expect(await screen.findByRole('alert')).toHaveTextContent(/changed this record/i);
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  });

  it('registers a published, unregistered profile', async () => {
    profiles.mockResolvedValue({
      profiles: [profile({ registered: false, supportState: null, revision: null })],
    });
    register.mockResolvedValue({ status: 'registered', release: release() });
    const user = userEvent.setup();
    render(<AidlcReleasesTab />);
    await user.click(await screen.findByRole('button', { name: 'Register' }));
    await waitFor(() => expect(register).toHaveBeenCalledWith('aidlc-1.2.0'));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  });

  it('disables Register for an unpublished profile', async () => {
    profiles.mockResolvedValue({
      profiles: [profile({ published: false, registered: false, supportState: null })],
    });
    render(<AidlcReleasesTab />);
    expect(await screen.findByRole('button', { name: 'Register' })).toBeDisabled();
  });

  it('explains publication for an unpublished profile with a copyable seed-lambda command', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    profiles.mockResolvedValue({
      profiles: [profile({ published: false, registered: false, supportState: null })],
    });
    render(<AidlcReleasesTab />);

    expect(await screen.findByText('How a profile becomes published')).toBeInTheDocument();
    expect(screen.getByText(/"importRelease":true,"profile":"aidlc-1\.2\.0"/)).toBeInTheDocument();
    expect(screen.getByText(/docs\/concepts\/aidlc-release-compatibility\.md/)).toBeInTheDocument();

    // Direct userEvent API (no setup()) — setup() would replace the clipboard
    // stub installed above with testing-library's own.
    await userEvent.click(
      screen.getByRole('button', { name: 'Copy publish command for aidlc-1.2.0' }),
    );
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining('"importRelease":true,"profile":"aidlc-1.2.0","dryRun":true'),
    );
  });

  it('hides the publication hint when every profile is published', async () => {
    render(<AidlcReleasesTab />);
    await screen.findByText('Registered releases');
    expect(screen.queryByText('How a profile becomes published')).not.toBeInTheDocument();
  });

  it('clears a channel pointer with its CAS revision, after confirmation', async () => {
    channels.mockResolvedValue({
      ...emptyChannels,
      stable: { channel: 'stable', releaseId: 'aidlc:aaa111bbb222', revision: 7 },
    });
    clearChannel.mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<AidlcReleasesTab />);

    await user.click(await screen.findByRole('button', { name: 'Clear stable channel' }));
    // Clearing `stable` stops every new intent from resolving a release, so the
    // request must not leave until the admin confirms.
    expect(clearChannel).not.toHaveBeenCalled();
    await user.click(await screen.findByRole('button', { name: 'Clear channel' }));

    await waitFor(() => expect(clearChannel).toHaveBeenCalledWith('stable', 7));
    expect(screen.queryByRole('button', { name: 'Clear stable channel' })).not.toBeInTheDocument();
  });

  it('leaves the pointer untouched when the confirmation is cancelled', async () => {
    channels.mockResolvedValue({
      ...emptyChannels,
      stable: { channel: 'stable', releaseId: 'aidlc:aaa111bbb222', revision: 7 },
    });
    const user = userEvent.setup();
    render(<AidlcReleasesTab />);

    await user.click(await screen.findByRole('button', { name: 'Clear stable channel' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));

    expect(clearChannel).not.toHaveBeenCalled();
    expect(await screen.findByRole('button', { name: 'Clear stable channel' })).toBeInTheDocument();
  });

  it('warns when a channel pointer targets a release that is no longer selectable', async () => {
    list.mockResolvedValue({ releases: [release({ supportState: 'existing-only' })] });
    channels.mockResolvedValue({
      ...emptyChannels,
      stable: { channel: 'stable', releaseId: 'aidlc:aaa111bbb222', revision: 2 },
    });
    render(<AidlcReleasesTab />);
    expect(await screen.findByText(/Stale pointer/)).toBeInTheDocument();
  });

  it('warns when a channel pointer targets a release missing from the registry', async () => {
    channels.mockResolvedValue({
      ...emptyChannels,
      stable: { channel: 'stable', releaseId: 'aidlc:gone', revision: 2 },
    });
    render(<AidlcReleasesTab />);
    expect(await screen.findByText(/Stale pointer/)).toBeInTheDocument();
  });

  it('shows no stale warning for a healthy pointer', async () => {
    channels.mockResolvedValue({
      ...emptyChannels,
      stable: { channel: 'stable', releaseId: 'aidlc:aaa111bbb222', revision: 2 },
    });
    render(<AidlcReleasesTab />);
    await screen.findByText('Registered releases');
    expect(screen.queryByText(/Stale pointer/)).not.toBeInTheDocument();
  });

  it('shows the error with a Retry (never the empty states) when the load fails', async () => {
    list.mockRejectedValue(new Error('registry unavailable'));
    const user = userEvent.setup();
    render(<AidlcReleasesTab />);

    expect(await screen.findByRole('alert')).toHaveTextContent('registry unavailable');
    expect(
      screen.queryByText('No release registered yet — register a published profile below.'),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('No allowlisted profile.')).not.toBeInTheDocument();

    list.mockResolvedValue({ releases: [release()] });
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Registered releases')).toBeInTheDocument();
  });

  it('shows a disabled-pinning notice when the API reports the flag off', async () => {
    channels.mockResolvedValue({ ...emptyChannels, pinningEnabled: false });
    render(<AidlcReleasesTab />);
    expect(
      await screen.findByText(/Per-intent release selection is currently disabled/),
    ).toBeInTheDocument();
  });

  it('shows no pinning state when the API does not expose the flag', async () => {
    render(<AidlcReleasesTab />);
    await screen.findByText('Registered releases');
    expect(screen.queryByText(/AIDLC_RELEASE_PINNING/)).not.toBeInTheDocument();
  });

  it('explains a release_channel_pinned 409 with the channel to move or clear', async () => {
    channels.mockResolvedValue({
      ...emptyChannels,
      stable: { channel: 'stable', releaseId: 'aidlc:aaa111bbb222', revision: 2 },
    });
    update.mockRejectedValue(
      new ApiError(409, 'release is a channel target', {
        code: 'release_channel_pinned',
        channel: 'stable',
      }),
    );
    const user = userEvent.setup();
    render(<AidlcReleasesTab />);
    await user.click(await screen.findByLabelText('Visibility for 1.2.0'));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /move or clear the stable channel first/i,
    );
  });
});

// Custom forks (issue #482 follow-up). The properties under test: a fork can be
// registered only with a validated owner/name plus an exact SHA, it is labelled
// import-only, and it is never offered to a channel selector.
describe('AidlcReleasesTab custom forks', () => {
  // Radix Select needs the pointer-capture APIs jsdom does not implement.
  beforeAll(() => {
    Object.defineProperties(Element.prototype, {
      hasPointerCapture: { configurable: true, value: () => false },
      setPointerCapture: { configurable: true, value: () => undefined },
      releasePointerCapture: { configurable: true, value: () => undefined },
      scrollIntoView: { configurable: true, value: () => undefined },
    });
  });

  const FORK_SHA = '0123456789abcdef0123456789abcdef01234567';
  const fork = (over: Record<string, unknown> = {}) =>
    release({
      releaseId: 'aidlc-custom:acme/aidlc-fork@' + FORK_SHA,
      sourceSha: FORK_SHA,
      profileId: 'custom:acme/aidlc-fork@' + FORK_SHA,
      sourceRepository: 'acme/aidlc-fork',
      custom: true,
      trustTier: 'T0',
      runnable: false,
      visible: true,
      upstreamVersion: 'custom (1.2.0 dialect)',
      upstreamChannel: 'custom',
      supportState: 'structurally-valid',
      ...over,
    });

  beforeEach(() => {
    list.mockReset().mockResolvedValue({ releases: [release()] });
    channels.mockReset().mockResolvedValue(emptyChannels);
    profiles.mockReset().mockResolvedValue({ profiles: [profile()] });
    update.mockReset();
    register.mockReset();
    registerCustom.mockReset();
    setChannel.mockReset();
    clearChannel.mockReset();
  });

  const fillForm = async (
    user: ReturnType<typeof userEvent.setup>,
    { repository = 'acme/aidlc-fork', sha = FORK_SHA } = {},
  ) => {
    await user.type(await screen.findByLabelText('Custom fork repository'), repository);
    await user.type(screen.getByLabelText('Custom fork commit SHA'), sha);
    await user.click(screen.getByLabelText('Custom fork base dialect'));
    await user.click(await screen.findByRole('option', { name: '1.2.0' }));
  };

  it('registers a fork with the repository, SHA and base dialect', async () => {
    registerCustom.mockResolvedValue({ status: 'registered', release: fork() });
    const user = userEvent.setup();
    render(<AidlcReleasesTab />);
    await fillForm(user);
    await user.click(screen.getByRole('button', { name: 'Register fork' }));

    await waitFor(() =>
      expect(registerCustom).toHaveBeenCalledWith({
        repository: 'acme/aidlc-fork',
        sha: FORK_SHA,
        baseProfile: 'aidlc-1.2.0',
      }),
    );
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  });

  it('keeps Register fork disabled until the source is a valid owner/name plus exact SHA', async () => {
    const user = userEvent.setup();
    render(<AidlcReleasesTab />);
    const button = await screen.findByRole('button', { name: 'Register fork' });
    expect(button).toBeDisabled();

    await fillForm(user, { sha: FORK_SHA.slice(0, 7) });
    expect(button).toBeDisabled();

    await user.clear(screen.getByLabelText('Custom fork commit SHA'));
    await user.type(screen.getByLabelText('Custom fork commit SHA'), FORK_SHA);
    expect(button).toBeEnabled();
  });

  it('refuses the official repository and a traversal attempt client-side', async () => {
    const user = userEvent.setup();
    render(<AidlcReleasesTab />);
    const button = await screen.findByRole('button', { name: 'Register fork' });

    for (const repository of ['awslabs/aidlc-workflows', 'acme/..', 'acme', 'acme/fork/extra']) {
      await user.clear(screen.getByLabelText('Custom fork repository'));
      await user.clear(screen.getByLabelText('Custom fork commit SHA'));
      await user.type(screen.getByLabelText('Custom fork repository'), repository);
      await user.type(screen.getByLabelText('Custom fork commit SHA'), FORK_SHA);
      if (repository === 'awslabs/aidlc-workflows') {
        await user.click(screen.getByLabelText('Custom fork base dialect'));
        await user.click(await screen.findByRole('option', { name: '1.2.0' }));
      }
      expect(button).toBeDisabled();
    }
    expect(registerCustom).not.toHaveBeenCalled();
  });

  it('labels a fork import-only and shows its source repository', async () => {
    list.mockResolvedValue({ releases: [fork()] });
    render(<AidlcReleasesTab />);

    expect(await screen.findByText('import-only, not runnable')).toBeInTheDocument();
    expect(screen.getByText(/custom fork acme\/aidlc-fork/)).toBeInTheDocument();
    expect(screen.queryByText('runnable')).not.toBeInTheDocument();
  });

  it('never offers a fork to a channel selector, even when visible and certified', async () => {
    list.mockResolvedValue({
      releases: [fork({ supportState: 'certified', visible: true })],
    });
    render(<AidlcReleasesTab />);

    await screen.findByText('Registered releases');
    expect(screen.getAllByText('No offerable release').length).toBe(3);
  });
});
