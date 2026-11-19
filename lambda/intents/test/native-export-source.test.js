import { describe, expect, it, vi } from 'vitest';
import { resolveNativeExportSource } from '../native-export-source.js';
import { profileFor } from '../../shared/aidlc-compatibility-profiles.js';

const OFFICIAL_REF = '1111111111111111111111111111111111111111';
const DEPLOYMENT_REF = '2222222222222222222222222222222222222222';
const FORK_SHA = '3333333333333333333333333333333333333333';
const BASE = profileFor('v2.11.0');

const customMeta = {
  aidlcRepoRef: FORK_SHA,
  methodologyRelease: {
    releaseId: `aidlc-custom:acme/aidlc-fork@${FORK_SHA}`,
    sourceSha: FORK_SHA,
    importerRevision: '3',
    custom: true,
    sourceRepository: 'acme/aidlc-fork',
  },
};

const ownDistribution = {
  files: new Map([['.kiro/tools/data/harness.json', Buffer.from('{}')]]),
  workspaceLayout: 'spaces',
};
const noOwn = vi.fn(async () => null);

describe('native export source', () => {
  it('exports an official intent at its own pinned ref', async () => {
    const readManifest = vi.fn();
    const source = await resolveNativeExportSource({
      meta: { aidlcRepoRef: OFFICIAL_REF, methodologyRelease: { sourceSha: OFFICIAL_REF } },
      harness: 'kiro-ide',
      deploymentRef: async () => DEPLOYMENT_REF,
      loadReleaseDistribution: noOwn,
      readManifest,
    });
    expect(source).toEqual({
      upstreamRef: OFFICIAL_REF,
      warnings: [],
      omitStagesNotInDistribution: false,
      preloadedDistribution: null,
    });
    expect(readManifest).not.toHaveBeenCalled();
  });

  it('falls back to the deployment ref for a legacy intent and says so', async () => {
    const source = await resolveNativeExportSource({
      meta: {},
      harness: 'kiro-ide',
      deploymentRef: async () => DEPLOYMENT_REF,
      loadReleaseDistribution: noOwn,
      readManifest: vi.fn(),
    });
    expect(source.upstreamRef).toBe(DEPLOYMENT_REF);
    expect(source.warnings).toEqual([expect.stringContaining('legacy intent')]);
  });

  it('exports a custom release with its own distribution when it ships one', async () => {
    const readManifest = vi.fn();
    const loadReleaseDistribution = vi.fn(async () => ownDistribution);
    const source = await resolveNativeExportSource({
      meta: customMeta,
      harness: 'kiro',
      deploymentRef: async () => DEPLOYMENT_REF,
      readManifest,
      loadReleaseDistribution,
    });
    expect(loadReleaseDistribution).toHaveBeenCalledWith({
      keyArgs: {
        sha: FORK_SHA,
        importerRevision: 3,
        custom: true,
        sourceRepository: 'acme/aidlc-fork',
      },
      harness: 'kiro',
    });
    expect(source).toEqual({
      upstreamRef: FORK_SHA,
      warnings: [],
      omitStagesNotInDistribution: false,
      preloadedDistribution: ownDistribution,
    });
    expect(readManifest).not.toHaveBeenCalled();
  });

  it("exports a custom release onto its base profile's official distribution", async () => {
    const readManifest = vi.fn(async () => ({ baseProfileId: 'v2.11.0' }));
    const source = await resolveNativeExportSource({
      meta: customMeta,
      harness: 'kiro-ide',
      deploymentRef: async () => DEPLOYMENT_REF,
      loadReleaseDistribution: noOwn,
      readManifest,
    });
    expect(readManifest).toHaveBeenCalledWith({
      sha: FORK_SHA,
      importerRevision: 3,
      custom: true,
      sourceRepository: 'acme/aidlc-fork',
    });
    expect(source.upstreamRef).toBe(BASE.upstreamRef);
    expect(source.upstreamRef).not.toBe(FORK_SHA);
    expect(source.omitStagesNotInDistribution).toBe(true);
    expect(source.warnings).toEqual([
      expect.stringContaining(`acme/aidlc-fork@${FORK_SHA.slice(0, 12)}`),
    ]);
    expect(source.warnings[0]).toContain(BASE.label);
    expect(source.warnings[0]).toContain('ships no kiro-ide distribution');
    expect(source.preloadedDistribution).toBeNull();
  });

  it('returns null when the custom release manifest is missing', async () => {
    const source = await resolveNativeExportSource({
      meta: customMeta,
      harness: 'kiro-ide',
      deploymentRef: async () => DEPLOYMENT_REF,
      loadReleaseDistribution: noOwn,
      readManifest: async () => null,
    });
    expect(source).toBeNull();
  });

  it('returns null when the base profile is unknown', async () => {
    const source = await resolveNativeExportSource({
      meta: customMeta,
      harness: 'kiro-ide',
      deploymentRef: async () => DEPLOYMENT_REF,
      loadReleaseDistribution: noOwn,
      readManifest: async () => ({ baseProfileId: 'v0.0.0-unknown' }),
    });
    expect(source).toBeNull();
  });
});
