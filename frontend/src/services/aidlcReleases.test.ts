import { describe, it, expect, vi, beforeEach } from 'vitest';

const get = vi.fn();
const post = vi.fn();
const put = vi.fn();
const patch = vi.fn();
const del = vi.fn();
vi.mock('./api', () => ({
  api: {
    get: (...a: unknown[]) => get(...a),
    post: (...a: unknown[]) => post(...a),
    put: (...a: unknown[]) => put(...a),
    patch: (...a: unknown[]) => patch(...a),
    delete: (...a: unknown[]) => del(...a),
  },
}));

import {
  aidlcReleasesService,
  isReleaseSelectable,
  SHARED_CHANNELS_TTL_MS,
  type AidlcRelease,
} from './aidlcReleases';

const release = (over: Partial<AidlcRelease> = {}): AidlcRelease => ({
  releaseId: 'aidlc:abc1234def',
  sourceSha: 'abc1234def',
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

describe('aidlcReleasesService request paths', () => {
  beforeEach(() => {
    get.mockReset().mockResolvedValue({});
    post.mockReset().mockResolvedValue({});
    put.mockReset().mockResolvedValue({});
    patch.mockReset().mockResolvedValue({});
    del.mockReset().mockResolvedValue(undefined);
  });

  it('lists releases, channels and profiles', async () => {
    await aidlcReleasesService.list();
    expect(get).toHaveBeenCalledWith('/aidlc-releases');
    await aidlcReleasesService.channels();
    expect(get).toHaveBeenCalledWith('/aidlc-release-channels');
    await aidlcReleasesService.profiles();
    expect(get).toHaveBeenCalledWith('/aidlc-release-profiles');
  });

  it('registers a profile', async () => {
    await aidlcReleasesService.register('aidlc-1.2.0');
    expect(post).toHaveBeenCalledWith('/aidlc-releases', { profileId: 'aidlc-1.2.0' });
  });

  it('percent-encodes the colon-bearing releaseId in the PATCH path', async () => {
    await aidlcReleasesService.update('aidlc:abc1234def', {
      expectedRevision: 3,
      visible: true,
    });
    expect(patch).toHaveBeenCalledWith('/aidlc-releases/aidlc%3Aabc1234def', {
      expectedRevision: 3,
      visible: true,
    });
  });

  it('moves a channel pointer with the CAS revision (null = pointer unset)', async () => {
    await aidlcReleasesService.setChannel('stable', 'aidlc:abc1234def', 2);
    expect(put).toHaveBeenCalledWith('/aidlc-release-channels/stable', {
      releaseId: 'aidlc:abc1234def',
      expectedRevision: 2,
    });

    await aidlcReleasesService.setChannel('preview', 'aidlc:abc1234def', null);
    expect(put).toHaveBeenCalledWith('/aidlc-release-channels/preview', {
      releaseId: 'aidlc:abc1234def',
      expectedRevision: null,
    });
  });

  it('clears a channel pointer via DELETE with the CAS revision body', async () => {
    await aidlcReleasesService.clearChannel('stable', 4);
    expect(del).toHaveBeenCalledWith('/aidlc-release-channels/stable', { expectedRevision: 4 });
  });
});

describe('aidlcReleasesService.sharedChannels', () => {
  const channels = { stable: null, candidate: null, preview: null, pinningEnabled: false };

  beforeEach(() => {
    vi.useRealTimers();
    aidlcReleasesService.invalidateSharedChannels();
    get.mockReset().mockResolvedValue(channels);
    put.mockReset().mockResolvedValue({});
    del.mockReset().mockResolvedValue(undefined);
  });

  it('serves every caller within the TTL from one request', async () => {
    const [first, second] = await Promise.all([
      aidlcReleasesService.sharedChannels(),
      aidlcReleasesService.sharedChannels(),
    ]);
    const third = await aidlcReleasesService.sharedChannels();

    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith('/aidlc-release-channels');
    expect(first).toBe(channels);
    expect(second).toBe(channels);
    expect(third).toBe(channels);
  });

  it('does not cache a failed lookup', async () => {
    get.mockRejectedValueOnce(new Error('offline'));
    await expect(aidlcReleasesService.sharedChannels()).rejects.toThrow('offline');

    await expect(aidlcReleasesService.sharedChannels()).resolves.toBe(channels);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('refetches once the TTL has passed', async () => {
    vi.useFakeTimers();
    await aidlcReleasesService.sharedChannels();
    vi.advanceTimersByTime(SHARED_CHANNELS_TTL_MS + 1);
    await aidlcReleasesService.sharedChannels();

    expect(get).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('drops the cached lookup after a channel pointer moves or is cleared', async () => {
    await aidlcReleasesService.sharedChannels();
    await aidlcReleasesService.setChannel('stable', 'aidlc:abc1234def', 1);
    await aidlcReleasesService.sharedChannels();
    await aidlcReleasesService.clearChannel('stable', 2);
    await aidlcReleasesService.sharedChannels();

    expect(get).toHaveBeenCalledTimes(3);
  });
});

describe('isReleaseSelectable', () => {
  it('requires runnable + visible + selectable/certified', () => {
    expect(isReleaseSelectable(release())).toBe(true);
    expect(isReleaseSelectable(release({ supportState: 'certified' }))).toBe(true);
    expect(isReleaseSelectable(release({ runnable: false }))).toBe(false);
    expect(isReleaseSelectable(release({ visible: false }))).toBe(false);
    expect(isReleaseSelectable(release({ supportState: 'structurally-valid' }))).toBe(false);
    expect(isReleaseSelectable(release({ supportState: 'existing-only' }))).toBe(false);
  });
});

// Custom forks (issue #482 follow-up). The properties under test: the fork
// payload is nested under `custom` so the backend can keep the two sources
// mutually exclusive, and a fork is never selectable.
describe('custom fork registration', () => {
  beforeEach(() => {
    post.mockReset().mockResolvedValue({});
  });

  it('nests the fork source under `custom`', async () => {
    await aidlcReleasesService.registerCustom({
      repository: 'acme/aidlc-fork',
      sha: '0123456789abcdef0123456789abcdef01234567',
      baseProfile: 'v2.9.0',
    });
    expect(post).toHaveBeenCalledWith('/aidlc-releases', {
      custom: {
        repository: 'acme/aidlc-fork',
        sha: '0123456789abcdef0123456789abcdef01234567',
        baseProfile: 'v2.9.0',
      },
    });
  });
});

describe('isReleaseSelectable for custom forks', () => {
  // The backend makes a fork runnable only when an admin promotes it through the
  // fidelity guard, so `runnable` is what decides, as for any other record.
  it('offers a fork once it is runnable, and not before', () => {
    expect(isReleaseSelectable(release({ custom: true, runnable: false }))).toBe(false);
    expect(
      isReleaseSelectable(release({ custom: true, runnable: false, supportState: 'certified' })),
    ).toBe(false);
    expect(isReleaseSelectable(release({ custom: true }))).toBe(true);
    // A record written before custom forks existed carries no flag at all.
    expect(isReleaseSelectable(release({ custom: undefined }))).toBe(true);
  });
});

describe('channel path encoding', () => {
  it('percent-encodes the channel segment on both channel mutations', async () => {
    // The three channel names are safe today, but the segment is interpolated into
    // a URL, so it must be encoded at the boundary rather than trusted by name.
    await aidlcReleasesService.setChannel(
      'sta ble/x' as unknown as Parameters<typeof aidlcReleasesService.setChannel>[0],
      'aidlc:abc1234def',
      1,
    );
    expect(put).toHaveBeenCalledWith('/aidlc-release-channels/sta%20ble%2Fx', {
      releaseId: 'aidlc:abc1234def',
      expectedRevision: 1,
    });

    await aidlcReleasesService.clearChannel(
      'sta ble/x' as unknown as Parameters<typeof aidlcReleasesService.clearChannel>[0],
      4,
    );
    expect(del).toHaveBeenCalledWith('/aidlc-release-channels/sta%20ble%2Fx', {
      expectedRevision: 4,
    });
  });
});

// ── Release contents (issue #607) ──

const contentsBody = (releaseId = 'aidlc:abc1234def') => ({
  release: { releaseId, upstreamVersion: '2.11.0' },
  workflow: null,
  blocks: { agent: [{ id: 'reviewer-agent', name: 'Reviewer', source: 'release', releaseId }] },
});

describe('aidlcReleasesService release contents', () => {
  beforeEach(() => {
    aidlcReleasesService.invalidateContents();
    aidlcReleasesService.invalidateSharedChannels();
    get.mockReset();
    patch.mockReset().mockResolvedValue({});
  });

  it('percent-encodes the release id and lists the requested types', async () => {
    get.mockResolvedValue(contentsBody());

    await aidlcReleasesService.contents('aidlc-custom:gitlab:group/fork@abc', ['agent', 'sensor']);

    expect(get).toHaveBeenCalledWith(
      '/aidlc-releases/aidlc-custom%3Agitlab%3Agroup%2Ffork%40abc/blocks?type=agent,sensor',
    );
  });

  it('lists every type when none is named', async () => {
    get.mockResolvedValue(contentsBody());

    await aidlcReleasesService.contents('aidlc:abc1234def');

    expect(get).toHaveBeenCalledWith('/aidlc-releases/aidlc%3Aabc1234def/blocks');
  });

  it('serves repeated reads of the same slice from one request', async () => {
    get.mockResolvedValue(contentsBody());

    await aidlcReleasesService.contents('aidlc:abc1234def', ['agent', 'stage']);
    await aidlcReleasesService.contents('aidlc:abc1234def', ['stage', 'agent']);

    expect(get).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failed read', async () => {
    get.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(contentsBody());

    await expect(aidlcReleasesService.contents('aidlc:abc1234def')).rejects.toThrow('offline');
    await expect(aidlcReleasesService.contents('aidlc:abc1234def')).resolves.toMatchObject({
      workflow: null,
    });
  });

  it('drops cached contents after a closure upgrade', async () => {
    get.mockResolvedValue(contentsBody());
    await aidlcReleasesService.contents('aidlc:abc1234def');

    await aidlcReleasesService.upgradeClosure('aidlc:abc1234def', {
      expectedRevision: 1,
      importerRevision: 3,
    });
    await aidlcReleasesService.contents('aidlc:abc1234def');

    expect(get).toHaveBeenCalledTimes(2);
  });

  it('reads one block by encoded type and id', async () => {
    get.mockResolvedValue({ block: {}, body: '', script: '' });

    await aidlcReleasesService.block('aidlc:abc1234def', 'agent', 'reviewer-agent');

    expect(get).toHaveBeenCalledWith(
      '/aidlc-releases/aidlc%3Aabc1234def/blocks/agent/reviewer-agent',
    );
  });
});

describe('aidlcReleasesService.stableCatalog', () => {
  const channelsWith = (over: Record<string, unknown>) => ({
    stable: { channel: 'stable', releaseId: 'aidlc:abc1234def', revision: 1 },
    candidate: null,
    preview: null,
    pinningEnabled: true,
    ...over,
  });
  const route = (channels: unknown, contents: unknown = contentsBody()) =>
    get.mockImplementation((path: string) =>
      Promise.resolve(path === '/aidlc-release-channels' ? channels : contents),
    );

  beforeEach(() => {
    aidlcReleasesService.invalidateContents();
    aidlcReleasesService.invalidateSharedChannels();
    get.mockReset();
  });

  it('returns the stable release and the requested slice of its catalog', async () => {
    route(channelsWith({}));

    const stable = await aidlcReleasesService.stableCatalog(['agent']);

    expect(stable?.releaseId).toBe('aidlc:abc1234def');
    expect(stable?.release.upstreamVersion).toBe('2.11.0');
    expect(stable?.contents.blocks.agent?.[0].id).toBe('reviewer-agent');
    expect(get).toHaveBeenCalledWith('/aidlc-releases/aidlc%3Aabc1234def/blocks?type=agent');
  });

  it('is null while pinning is off: the mutable library is what runs', async () => {
    route(channelsWith({ pinningEnabled: false }));

    await expect(aidlcReleasesService.stableCatalog(['agent'])).resolves.toBeNull();
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('is null when no stable release is set', async () => {
    route(channelsWith({ stable: null }));

    await expect(aidlcReleasesService.stableCatalog(['agent'])).resolves.toBeNull();
  });

  it('is null, not an error, when the contents cannot be read', async () => {
    get.mockImplementation((path: string) =>
      path === '/aidlc-release-channels'
        ? Promise.resolve(channelsWith({}))
        : Promise.reject(new Error('forbidden')),
    );

    await expect(aidlcReleasesService.stableCatalog(['agent'])).resolves.toBeNull();
  });
});
