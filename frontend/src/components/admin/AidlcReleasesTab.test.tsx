import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const projects = vi.fn();
vi.mock('@/services/projects', () => ({
  projectsService: { list: (...a: unknown[]) => projects(...a) },
}));
const list = vi.fn();
const channels = vi.fn();
const profiles = vi.fn();
const update = vi.fn();
const register = vi.fn();
const registerCustom = vi.fn();
const setChannel = vi.fn();
const clearChannel = vi.fn();
const contents = vi.fn();
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
      contents: (...a: unknown[]) => contents(...a),
    },
  };
});

import { MemoryRouter } from 'react-router';
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

  it('keeps approval and promotion explicit and uses the returned record revision', async () => {
    channels.mockResolvedValue({ ...emptyChannels, pinningEnabled: true });
    update.mockResolvedValue({ release: release({ supportState: 'certified', revision: 5 }) });
    setChannel.mockResolvedValue({
      channel: { channel: 'stable', releaseId: 'aidlc:aaa111bbb222', revision: 1 },
    });
    profiles.mockResolvedValue({ profiles: [profile({ currentPlatformBaseline: false })] });
    const user = userEvent.setup();
    render(<AidlcReleasesTab />);
    await user.click(await screen.findByRole('button', { name: 'Manage version 1.2.0' }));
    expect(screen.queryByRole('button', { name: 'Make stable' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Approve for use' }));
    expect(update).toHaveBeenCalledWith('aidlc:aaa111bbb222', {
      expectedRevision: 4,
      supportState: 'certified',
      visible: true,
    });
    expect(setChannel).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Make stable' })).toBeEnabled());
    expect(screen.getByRole('region', { name: 'Manage AI-DLC 1.2.0' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Make stable' }));
    expect(setChannel).toHaveBeenCalledWith('stable', 'aidlc:aaa111bbb222', null);
  });

  it('automatically qualifies an optional private test without publishing the version', async () => {
    list.mockResolvedValue({
      releases: [release({ supportState: 'structurally-valid', visible: false })],
    });
    update.mockResolvedValue({ release: release({ revision: 5 }) });
    channels.mockResolvedValue({ ...emptyChannels, pinningEnabled: true });
    projects.mockResolvedValue([]);
    const user = userEvent.setup();
    render(<AidlcReleasesTab />);
    await user.click(await screen.findByRole('button', { name: 'Manage version 1.2.0' }));
    await user.click(screen.getByRole('button', { name: 'Test version' }));
    expect(update).toHaveBeenCalledWith('aidlc:aaa111bbb222', {
      expectedRevision: 4,
      supportState: 'selectable',
      visible: false,
    });
    expect(setChannel).not.toHaveBeenCalled();
  });

  // A deprecated version stays deprecated: testing would have to qualify it
  // again, which is a decision, not a side effect of opening the space picker.
  it('does not offer a test of a deprecated version', async () => {
    list.mockResolvedValue({
      releases: [release({ supportState: 'existing-only', visible: false })],
    });
    channels.mockResolvedValue({ ...emptyChannels, pinningEnabled: true });
    const user = userEvent.setup();
    render(<AidlcReleasesTab />);
    await user.click(await screen.findByRole('button', { name: 'Manage version 1.2.0' }));
    expect(screen.getByRole('button', { name: 'Test version' })).toBeDisabled();
    expect(update).not.toHaveBeenCalled();
  });

  it('opens a space chooser that preserves the exact release without writing registry state', async () => {
    channels.mockResolvedValue({ ...emptyChannels, pinningEnabled: true });
    projects.mockResolvedValue([
      { id: 'p1', name: 'Test space', kind: 'v2' },
      { id: 'old', name: 'Legacy space', kind: 'v1' },
    ]);
    const user = userEvent.setup();
    render(<AidlcReleasesTab />);
    await user.click(await screen.findByRole('button', { name: 'Manage version 1.2.0' }));
    await user.click(screen.getByRole('button', { name: 'Test version' }));
    expect(await screen.findByRole('link', { name: 'Test space' })).toHaveAttribute(
      'href',
      '/space/p1/intent/new?release=aidlc%3Aaaa111bbb222&testRelease=1',
    );
    expect(screen.queryByRole('link', { name: 'Legacy space' })).not.toBeInTheDocument();
    expect(update).not.toHaveBeenCalled();
    expect(setChannel).not.toHaveBeenCalled();
  });

  it('shows Stable and Preview immediately and assigns preview from the version row', async () => {
    channels.mockResolvedValue({
      ...emptyChannels,
      pinningEnabled: true,
      stable: { channel: 'stable', releaseId: 'aidlc:aaa111bbb222', revision: 1 },
    });
    setChannel.mockResolvedValue({
      channel: { channel: 'preview', releaseId: 'aidlc:aaa111bbb222', revision: 1 },
    });
    const user = userEvent.setup();
    render(<AidlcReleasesTab />);
    expect(await screen.findByText('Stable (default):')).toBeInTheDocument();
    expect(screen.getByText('Preview:')).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Manage version 1.2.0' }));
    await user.click(screen.getByRole('button', { name: 'Use as preview' }));
    expect(setChannel).toHaveBeenCalledWith('preview', 'aidlc:aaa111bbb222', null);
  });

  it('shows disabled selection before expanding a row and prevents a test', async () => {
    channels.mockResolvedValue({ ...emptyChannels, pinningEnabled: false });
    const user = userEvent.setup();
    render(<AidlcReleasesTab />);
    expect(
      await screen.findByText(/Version selection is disabled for this deployment/),
    ).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Manage version 1.2.0' }));
    expect(screen.getByRole('button', { name: 'Test version' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Make stable' })).toBeDisabled();
  });

  it('shows the upstream release date and source link, never the local import date', async () => {
    list.mockResolvedValue({ releases: [release({ registeredAt: '1999-01-01T00:00:00Z' })] });
    profiles.mockResolvedValue({
      profiles: [
        profile({
          sourceInfo: {
            date: '2026-11-04T06:09:40Z',
            dateKind: 'release',
            url: 'https://github.com/awslabs/aidlc-workflows/releases/tag/v2.11.3',
          },
        }),
      ],
    });
    render(<AidlcReleasesTab />);
    const source = await screen.findByRole('link', { name: 'View upstream release for 1.2.0' });
    expect(source).toHaveAttribute(
      'href',
      'https://github.com/awslabs/aidlc-workflows/releases/tag/v2.11.3',
    );
    expect(source).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getAllByTitle('Published upstream: 2026-11-04T06:09:40Z')[0]).toHaveAttribute(
      'datetime',
      '2026-11-04T06:09:40Z',
    );
    expect(screen.queryByText(/1999/)).not.toBeInTheDocument();
  });

  it('does not substitute a commit or import date for a missing GitHub release date', async () => {
    list.mockResolvedValue({ releases: [release({ registeredAt: '1999-01-01T00:00:00Z' })] });
    profiles.mockResolvedValue({
      profiles: [
        profile({
          sourceInfo: {
            date: '2026-07-10T03:22:01Z',
            dateKind: 'commit',
            url: 'https://github.com/awslabs/aidlc-workflows/commit/' + 'a'.repeat(40),
          },
        }),
      ],
    });
    const { container } = render(<AidlcReleasesTab />);
    expect(
      await screen.findByRole('link', { name: 'View pinned upstream source for 1.2.0' }),
    ).toHaveAttribute(
      'href',
      'https://github.com/awslabs/aidlc-workflows/commit/' + 'a'.repeat(40),
    );
    expect(container.querySelector('time')).toBeNull();
  });

  it('can close and reopen the space chooser without unmounting the version list', async () => {
    channels.mockResolvedValue({ ...emptyChannels, pinningEnabled: true });
    projects.mockResolvedValue([{ id: 'p1', name: 'Test space', kind: 'v2' }]);
    const user = userEvent.setup();
    render(<AidlcReleasesTab />);
    await user.click(await screen.findByRole('button', { name: 'Manage version 1.2.0' }));
    await user.click(screen.getByRole('button', { name: 'Test version' }));
    await screen.findByRole('link', { name: 'Test space' });
    await user.click(screen.getAllByRole('button', { name: 'Close' }).at(-1)!);
    expect(screen.getByText('Supported versions')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Test version' })).toHaveFocus());
    await user.click(screen.getByRole('button', { name: 'Test version' }));
    expect(await screen.findByRole('link', { name: 'Test space' })).toBeInTheDocument();
  });

  it('shows newest versions first even when the API returns registry order', async () => {
    list.mockResolvedValue({
      releases: ['2.3.3', '2.9.0', '2.11.3'].map((version) =>
        release({ releaseId: 'aidlc:' + version, upstreamVersion: version }),
      ),
    });
    render(<AidlcReleasesTab />);
    await screen.findByText('Supported versions');
    expect(
      screen.getAllByTestId(/^release-row-/).map((row) => row.getAttribute('data-testid')),
    ).toEqual(['release-row-aidlc:2.11.3', 'release-row-aidlc:2.9.0', 'release-row-aidlc:2.3.3']);
  });

  it('keeps a 20-version registry scannable and searchable across pages', async () => {
    list.mockResolvedValue({
      releases: Array.from({ length: 20 }, (_, index) => {
        const version = `2.${20 - index}.0`;
        return release({ releaseId: `aidlc:${version}`, upstreamVersion: version });
      }),
    });
    const user = userEvent.setup();
    render(<AidlcReleasesTab />);
    expect(await screen.findByText('1–5 of 20 versions')).toBeInTheDocument();
    expect(screen.getAllByTestId(/^release-row-/)).toHaveLength(5);
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('6–10 of 20 versions')).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: 'Search versions' }), '2.11.0');
    expect(screen.getByTestId('release-row-aidlc:2.11.0')).toBeInTheDocument();
    expect(screen.getAllByTestId(/^release-row-/)).toHaveLength(1);
    expect(screen.getByText('1–1 of 1 versions')).toBeInTheDocument();
  });

  it('validates custom repositories with the backend GitHub owner and repository grammar', () => {
    const sha = 'a'.repeat(40);
    expect(isValidCustomSource('valid-owner/valid.repo_name', sha, 'v2.9.0')).toBe(true);
    expect(isValidCustomSource('trailing-/repo', sha, 'v2.9.0')).toBe(false);
    expect(isValidCustomSource('two--hyphens/repo', sha, 'v2.9.0')).toBe(false);
    expect(isValidCustomSource('owner/..', sha, 'v2.9.0')).toBe(false);
  });
  it('validates GitLab project paths, including nested groups', () => {
    const sha = 'a'.repeat(40);
    expect(isValidCustomSource('gitlab:acme/platform/aidlc-fork', sha, 'v2.9.0')).toBe(true);
    expect(isValidCustomSource('gitlab:acme/aidlc.fork_1', sha, 'v2.9.0')).toBe(true);
    expect(isValidCustomSource('gitlab:acme', sha, 'v2.9.0')).toBe(false);
    expect(isValidCustomSource('gitlab:acme/../fork', sha, 'v2.9.0')).toBe(false);
    expect(isValidCustomSource('gitlab:acme/fork.git', sha, 'v2.9.0')).toBe(false);
    expect(isValidCustomSource('gitlab:acme/-fork', sha, 'v2.9.0')).toBe(false);
    expect(isValidCustomSource('gitlab:acme//fork', sha, 'v2.9.0')).toBe(false);
    expect(isValidCustomSource('gitlab:acme/fork', 'main', 'v2.9.0')).toBe(false);
  });

  it('keeps one set of actions inline and lets users switch versions without closing a dialog', async () => {
    list.mockResolvedValue({
      releases: [release(), release({ releaseId: 'aidlc:older', upstreamVersion: '1.1.0' })],
    });
    const user = userEvent.setup();
    render(<AidlcReleasesTab />);
    const first = await screen.findByRole('button', { name: 'Manage version 1.2.0' });
    await user.click(first);
    expect(first).toHaveAttribute('aria-expanded', 'true');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByText(/Let users choose this version/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Manage version 1.1.0' }));
    expect(first).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('region', { name: 'Manage AI-DLC 1.2.0' })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Manage AI-DLC 1.1.0' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Manage version 1.1.0' }));
    expect(screen.queryByRole('region', { name: 'Manage AI-DLC 1.1.0' })).not.toBeInTheDocument();
  });

  it('keeps the selected version accessible when approval changes the searched status', async () => {
    list.mockResolvedValue({
      releases: [release({ supportState: 'structurally-valid', visible: false })],
    });
    channels.mockResolvedValue({ ...emptyChannels, pinningEnabled: true });
    profiles.mockResolvedValue({ profiles: [profile({ currentPlatformBaseline: false })] });
    update.mockResolvedValue({ release: release({ supportState: 'certified', revision: 5 }) });
    const user = userEvent.setup();
    render(<AidlcReleasesTab />);
    await user.type(
      await screen.findByRole('textbox', { name: 'Search versions' }),
      'needs approval',
    );
    await user.click(screen.getByRole('button', { name: 'Manage version 1.2.0' }));
    await user.click(screen.getByRole('button', { name: 'Approve for use' }));
    expect(await screen.findByRole('button', { name: 'Make stable' })).toBeEnabled();
    expect(screen.getByRole('textbox', { name: 'Search versions' })).toHaveValue('needs approval');
    await user.click(screen.getByRole('button', { name: 'Manage version 1.2.0' }));
    expect(screen.getByText(/No versions match/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(screen.getByRole('button', { name: 'Manage version 1.2.0' })).toBeVisible();
  });

  it('opens the stable version from another page even while search excludes it', async () => {
    const versions = Array.from({ length: 20 }, (_, i) =>
      release({ releaseId: `aidlc:${i}`, upstreamVersion: `2.${i}.0` }),
    );
    list.mockResolvedValue({ releases: versions });
    channels.mockResolvedValue({
      ...emptyChannels,
      pinningEnabled: true,
      stable: { channel: 'stable', releaseId: 'aidlc:0', revision: 1 },
    });
    const user = userEvent.setup();
    render(<AidlcReleasesTab />);
    await user.type(await screen.findByRole('textbox', { name: 'Search versions' }), '2.19.0');
    await user.click(screen.getByRole('button', { name: 'Manage stable version 2.0.0' }));
    expect(screen.getByRole('textbox', { name: 'Search versions' })).toHaveValue('');
    expect(screen.getByText('16–20 of 20 versions')).toBeVisible();
    expect(screen.getByRole('region', { name: 'Manage AI-DLC 2.0.0' })).toBeVisible();
    expect(screen.getAllByTestId(/^release-row-/)).toHaveLength(5);
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });

  it.each([{ runnable: false, custom: false }, { structurallyValid: false }])(
    'explains an unusable import and prevents misleading approval or testing: %j',
    async (overrides) => {
      list.mockResolvedValue({ releases: [release(overrides)] });
      channels.mockResolvedValue({ ...emptyChannels, pinningEnabled: true });
      const user = userEvent.setup();
      render(<AidlcReleasesTab />);
      expect(await screen.findByText('Not usable')).toBeVisible();
      await user.click(screen.getByRole('button', { name: 'Manage version 1.2.0' }));
      expect(screen.getByRole('button', { name: 'Approve for use' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Test version' })).toBeDisabled();
      expect(update).not.toHaveBeenCalled();
    },
  );

  it('discloses the repository limitation without putting maintenance controls in the main view', async () => {
    const user = userEvent.setup();
    render(<AidlcReleasesTab />);
    await user.click(await screen.findByRole('button', { name: 'Manage version 1.2.0' }));
    const compatibility = screen.getByText('Compatibility and contents');
    const maintenance = screen.getByText('Maintenance');
    expect(compatibility.closest('details')).not.toHaveAttribute('open');
    expect(maintenance.closest('details')).not.toHaveAttribute('open');
    await user.click(compatibility);
    expect(screen.getByText(/repositories are fixed when an intent starts/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Browse contents' })).toBeVisible();
    expect(maintenance.closest('details')).not.toHaveAttribute('open');
  });

  it('replaces stable with an approved version before allowing deprecation', async () => {
    list.mockResolvedValue({
      releases: [
        release({ supportState: 'certified' }),
        release({
          releaseId: 'aidlc:approved',
          upstreamVersion: '1.1.0',
          supportState: 'certified',
        }),
        release({ releaseId: 'aidlc:unapproved', upstreamVersion: '1.0.0', profileId: 'other' }),
      ],
    });
    channels.mockResolvedValue({
      ...emptyChannels,
      pinningEnabled: true,
      stable: { channel: 'stable', releaseId: 'aidlc:aaa111bbb222', revision: 7 },
    });
    setChannel.mockResolvedValue({
      channel: { channel: 'stable', releaseId: 'aidlc:approved', revision: 8 },
    });
    update.mockResolvedValue({
      release: release({ supportState: 'existing-only', visible: false, revision: 5 }),
    });
    const user = userEvent.setup();
    render(<AidlcReleasesTab />);
    await user.click(await screen.findByRole('button', { name: 'Manage version 1.2.0' }));
    await user.click(screen.getByText('Maintenance'));
    expect(screen.getByRole('button', { name: 'Deprecate version' })).toBeDisabled();
    await user.click(screen.getByRole('combobox', { name: 'Replace stable with' }));
    expect(screen.queryByRole('option', { name: '1.0.0' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('option', { name: '1.1.0' }));
    expect(setChannel).toHaveBeenCalledWith('stable', 'aidlc:approved', 7);
    await user.click(await screen.findByRole('button', { name: 'Deprecate version' }));
    expect(update).toHaveBeenCalledWith('aidlc:aaa111bbb222', {
      expectedRevision: 4,
      supportState: 'existing-only',
      visible: false,
    });
    expect(await screen.findByText('Deprecated')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Approve for use' })).toBeEnabled();
  });

  it('removes preview before deprecation and preserves its channel revision', async () => {
    channels.mockResolvedValue({
      ...emptyChannels,
      pinningEnabled: true,
      preview: { channel: 'preview', releaseId: 'aidlc:aaa111bbb222', revision: 9 },
    });
    clearChannel.mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<AidlcReleasesTab />);
    await user.click(await screen.findByRole('button', { name: 'Manage version 1.2.0' }));
    await user.click(screen.getByText('Maintenance'));
    expect(screen.getByRole('button', { name: 'Deprecate version' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Remove from preview' }));
    expect(clearChannel).toHaveBeenCalledWith('preview', 9);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Deprecate version' })).toBeEnabled(),
    );
  });

  it('supports a named version without a source URL and opens from any row cell', async () => {
    list.mockResolvedValue({ releases: [release({ upstreamVersion: 'Team baseline' })] });
    const user = userEvent.setup();
    render(<AidlcReleasesTab />);
    const row = await screen.findByTestId('release-row-aidlc:aaa111bbb222');
    expect(within(row).getByRole('button', { name: 'Manage version Team baseline' })).toBeVisible();
    expect(within(row).queryByRole('link')).not.toBeInTheDocument();
    await user.click(within(row).getByText('Available to users'));
    expect(screen.getByRole('region', { name: 'Manage AI-DLC Team baseline' })).toBeVisible();
    await user.click(within(row).getByText('Available to users'));
    expect(
      screen.queryByRole('region', { name: 'Manage AI-DLC Team baseline' }),
    ).not.toBeInTheDocument();
  });

  it('renders releases, channels and profiles with state badges', async () => {
    list.mockResolvedValue({
      releases: [release(), release({ releaseId: 'aidlc:custom', runnable: false })],
    });
    render(<AidlcReleasesTab />);
    expect(await screen.findByText('Supported versions')).toBeInTheDocument();
    expect(screen.getByText('Available to users')).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(
      within(screen.getByTestId('release-row-aidlc:aaa111bbb222')).getByRole('button', {
        name: /Open details/,
      }),
    );
    expect(screen.getByRole('region', { name: 'Manage AI-DLC 1.2.0' })).toBeInTheDocument();
    await user.click(
      within(screen.getByTestId('release-row-aidlc:custom')).getByRole('button', {
        name: /Open details/,
      }),
    );
    expect(
      screen.getByText('This version is import-only and cannot run on this deployment.'),
    ).toBeInTheDocument();
  });

  it('sends expectedRevision on a visibility toggle', async () => {
    update.mockResolvedValue({ release: release({ visible: false, revision: 5 }) });
    const user = userEvent.setup();
    render(<AidlcReleasesTab />);
    await user.click(await screen.findByRole('button', { name: 'Manage version 1.2.0' }));
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
    await user.click(await screen.findByRole('button', { name: 'Manage version 1.2.0' }));

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
    const user = userEvent.setup();
    render(<AidlcReleasesTab />);
    await user.click(await screen.findByRole('button', { name: 'Manage version 1.2.0' }));

    expect(await screen.findByLabelText('Visibility for 1.2.0')).toBeDisabled();
  });

  it('identifies compatibility evidence that has not been cached on a legacy row', async () => {
    list.mockResolvedValue({
      releases: [release({ fidelityGaps: null, unhonouredValues: null })],
    });
    const user = userEvent.setup();
    render(<AidlcReleasesTab />);
    await user.click(await screen.findByRole('button', { name: 'Manage version 1.2.0' }));

    expect(
      await screen.findByTestId('release-promotion-unverified-aidlc:aaa111bbb222'),
    ).toHaveTextContent(/server will verify its immutable closure before promotion/i);
  });

  // A listing the server could not afford to recompute carries the evidence a
  // previous build stored. Blocking promotion on it would strand the admin on a
  // verdict this build no longer reaches; the server re-verifies the closure
  // before it decides, so the page states the refresh and leaves promotion open.
  it('reports stale evidence neutrally and keeps promotion available', async () => {
    list.mockResolvedValue({
      releases: [
        release({
          supportState: 'structurally-valid',
          fidelityEvidenceStale: true,
          fidelityGaps: [{ blockType: 'STAGE', field: 'mode', value: 'agent-team' }],
          unhonouredValues: [{ blockType: 'STAGE', field: 'mode', value: 'agent-team' }],
        }),
      ],
    });
    const user = userEvent.setup();
    render(<AidlcReleasesTab />);
    await user.click(await screen.findByRole('button', { name: 'Manage version 1.2.0' }));

    expect(
      await screen.findByTestId('release-evidence-refreshing-aidlc:aaa111bbb222'),
    ).toHaveTextContent(/evidence is being refreshed/i);
    expect(screen.queryByTestId('release-promotion-gaps-aidlc:aaa111bbb222')).toBeNull();
    await user.click(screen.getByLabelText('Support state for 1.2.0'));
    expect(screen.getByRole('option', { name: 'Selectable' })).not.toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('keeps blocking promotion when current evidence names unsupported behavior', async () => {
    list.mockResolvedValue({
      releases: [
        release({
          supportState: 'structurally-valid',
          fidelityEvidenceStale: false,
          unhonouredValues: [{ blockType: 'STAGE', field: 'mode', value: 'agent-team' }],
        }),
      ],
    });
    const user = userEvent.setup();
    render(<AidlcReleasesTab />);
    await user.click(await screen.findByRole('button', { name: 'Manage version 1.2.0' }));

    await user.click(await screen.findByLabelText('Support state for 1.2.0'));
    expect(screen.getByRole('option', { name: 'Selectable' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
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
    await user.click(await screen.findByRole('button', { name: 'Manage version 1.2.0' }));

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
    await user.click(await screen.findByRole('button', { name: 'Manage version 1.2.0' }));
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
    await screen.findByText('Supported versions');
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
    // Clearing Stable returns new intents to the configured baseline, so the
    // request must not leave until the admin confirms that default change.
    expect(clearChannel).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog')).toHaveTextContent(
      'New intents will return to the configured platform baseline',
    );
    await user.click(await screen.findByRole('button', { name: 'Clear channel' }));

    await waitFor(() => expect(clearChannel).toHaveBeenCalledWith('stable', 7));
    expect(screen.queryByRole('button', { name: 'Clear stable channel' })).not.toBeInTheDocument();
  });

  it('shows the platform default when no Stable version has been chosen', async () => {
    channels.mockResolvedValue({ ...emptyChannels, pinningEnabled: true });
    render(<AidlcReleasesTab />);
    const summary = await screen.findByLabelText('Current version channels');
    expect(within(summary).getByText('Platform default')).toBeVisible();
    expect(within(summary).getByText('Not set')).toBeVisible();
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
    await screen.findByText('Supported versions');
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
    expect(await screen.findByText('Supported versions')).toBeInTheDocument();
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
    await screen.findByText('Supported versions');
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
    await user.click(await screen.findByRole('button', { name: 'Manage version 1.2.0' }));
    await user.click(await screen.findByLabelText('Visibility for 1.2.0'));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /move or clear the stable channel first/i,
    );
  });
});

// Custom forks (issue #482 follow-up). The properties under test: a fork can be
// registered only with a validated owner/name plus an exact SHA, it is labelled
// import-only, and it is not offered to a channel selector until it is runnable.
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

    await (async () => {
      const user = userEvent.setup();
      await user.click(
        await screen.findByRole('button', { name: /Manage version acme\/aidlc-fork/ }),
      );
    })();
    expect(screen.getByRole('button', { name: 'Approve for use' })).toBeEnabled();
    expect(
      screen.getByRole('button', { name: /Manage version acme\/aidlc-fork/ }),
    ).toBeInTheDocument();
    expect(screen.queryByText('runnable')).not.toBeInTheDocument();
  });

  it('does not offer an unpromoted fork to a channel selector, even when visible and certified', async () => {
    list.mockResolvedValue({
      releases: [fork({ supportState: 'certified', visible: true })],
    });
    render(<AidlcReleasesTab />);

    await screen.findByText('Supported versions');
    expect(screen.getAllByText('No eligible version').length).toBe(3);
  });
  it("opens a read-only view of a release's contents", async () => {
    contents.mockResolvedValue({
      release: { releaseId: 'aidlc:aaa111bbb222', upstreamVersion: '1.2.0' },
      workflow: null,
      blocks: {
        agent: [
          { id: 'security-reviewer', name: 'Security reviewer', releaseId: 'aidlc:aaa111bbb222' },
        ],
      },
    });
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <AidlcReleasesTab />
      </MemoryRouter>,
    );

    await user.click(await screen.findByRole('button', { name: 'Manage version 1.2.0' }));
    await user.click(screen.getByText('Compatibility and contents'));
    await user.click(screen.getByRole('button', { name: 'Browse contents' }));

    expect(await screen.findByText('Security reviewer')).toBeInTheDocument();
    expect(contents).toHaveBeenCalledWith('aidlc:aaa111bbb222');
  });
});
