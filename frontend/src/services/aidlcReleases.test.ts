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

import { aidlcReleasesService, isReleaseSelectable, type AidlcRelease } from './aidlcReleases';

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
  it('refuses a custom record whatever else it claims', () => {
    expect(isReleaseSelectable(release({ custom: true }))).toBe(false);
    expect(isReleaseSelectable(release({ custom: true, supportState: 'certified' }))).toBe(false);
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
