import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const list = vi.fn();
const channels = vi.fn();
const profiles = vi.fn();
const upgradeClosure = vi.fn();
vi.mock('@/services/aidlcReleases', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/services/aidlcReleases')>();
  return {
    ...original,
    aidlcReleasesService: {
      list: (...a: unknown[]) => list(...a),
      channels: (...a: unknown[]) => channels(...a),
      profiles: (...a: unknown[]) => profiles(...a),
      upgradeClosure: (...a: unknown[]) => upgradeClosure(...a),
      update: vi.fn(),
      register: vi.fn(),
      registerCustom: vi.fn(),
      setChannel: vi.fn(),
      clearChannel: vi.fn(),
    },
  };
});

import { ApiError } from '@/services/api';
import { AidlcReleasesTab } from './AidlcReleasesTab';

const RELEASE_ID = 'aidlc:aaa111bbb222';

const release = (over: Record<string, unknown> = {}) => ({
  releaseId: RELEASE_ID,
  sourceSha: 'aaa111bbb222',
  importerRevision: 1,
  closureDigest: 'd'.repeat(64),
  manifestKey: 'm',
  catalogKey: 'c',
  profileId: 'v2.9.0',
  upstreamVersion: '2.9.0',
  upstreamChannel: 'stable',
  trustTier: 'T2',
  supportState: 'selectable',
  structurallyValid: true,
  visible: true,
  runnable: true,
  notes: null,
  importerStale: true,
  importerHistory: [],
  revision: 4,
  ...over,
});

const profile = (over: Record<string, unknown> = {}) => ({
  profileId: 'v2.9.0',
  releaseId: RELEASE_ID,
  label: 'AI-DLC 2.9.0',
  upstreamVersion: '2.9.0',
  upstreamChannel: 'stable',
  upstreamRef: 'aaa111bbb222',
  trustTier: 'T2',
  currentPlatformBaseline: false,
  runnable: true,
  published: true,
  importerRevision: 2,
  registered: true,
  registeredImporterRevision: 1,
  importerStale: true,
  supportState: 'selectable',
  revision: 4,
  ...over,
});

describe('AidlcReleasesTab closure upgrades', () => {
  beforeEach(() => {
    list.mockReset().mockResolvedValue({ releases: [release()], currentImporterRevision: 2 });
    channels.mockReset().mockResolvedValue({ stable: null, candidate: null, preview: null });
    profiles.mockReset().mockResolvedValue({ profiles: [profile()] });
    upgradeClosure.mockReset();
  });

  it('flags a stale closure and upgrades it with the CAS revision and the current importer revision', async () => {
    upgradeClosure.mockResolvedValue({
      status: 'upgraded',
      release: release({ importerRevision: 2, importerStale: false, revision: 5 }),
    });
    const user = userEvent.setup();
    render(<AidlcReleasesTab />);

    expect(await screen.findByText('stale closure (importer i1)')).toBeInTheDocument();
    expect(screen.getByTestId(`release-stale-${RELEASE_ID}`)).toHaveTextContent(
      /existing intents keep their closure/i,
    );
    await user.click(screen.getByRole('button', { name: 'Upgrade closure for 2.9.0' }));
    // Nothing is sent until the admin confirms that only new intents change.
    expect(upgradeClosure).not.toHaveBeenCalled();
    expect(await screen.findByRole('alertdialog')).toHaveTextContent(/only new intents change/i);
    await user.click(screen.getByRole('button', { name: 'Upgrade closure' }));

    await waitFor(() =>
      expect(upgradeClosure).toHaveBeenCalledWith(RELEASE_ID, {
        expectedRevision: 4,
        importerRevision: 2,
      }),
    );
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  });

  it('sends nothing when the admin cancels the confirmation', async () => {
    const user = userEvent.setup();
    render(<AidlcReleasesTab />);
    await user.click(await screen.findByRole('button', { name: 'Upgrade closure for 2.9.0' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(upgradeClosure).not.toHaveBeenCalled();
  });

  it('shows no upgrade affordance for a current closure', async () => {
    list.mockResolvedValue({
      releases: [release({ importerRevision: 2, importerStale: false })],
      currentImporterRevision: 2,
    });
    render(<AidlcReleasesTab />);

    expect(await screen.findByText('Registered releases')).toBeInTheDocument();
    expect(screen.queryByText(/stale closure/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Upgrade closure/ })).not.toBeInTheDocument();
  });

  it('keeps the upgrade disabled and shows the publish command until the new closure is published', async () => {
    profiles.mockResolvedValue({ profiles: [profile({ published: false })] });
    render(<AidlcReleasesTab />);

    const button = await screen.findByRole('button', { name: 'Upgrade closure for 2.9.0' });
    expect(button).toBeDisabled();
    expect(screen.getByTestId(`release-stale-${RELEASE_ID}`)).toHaveTextContent(
      '"importRelease":true,"profile":"v2.9.0","importerRevision":2',
    );
  });

  it('surfaces a refused upgrade instead of swallowing it', async () => {
    upgradeClosure.mockRejectedValue(
      new ApiError(400, 'no published manifest at importer revision 2', {
        code: 'release_not_published',
      }),
    );
    const user = userEvent.setup();
    render(<AidlcReleasesTab />);

    await user.click(await screen.findByRole('button', { name: 'Upgrade closure for 2.9.0' }));
    await user.click(await screen.findByRole('button', { name: 'Upgrade closure' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/no published manifest/);
  });
});
