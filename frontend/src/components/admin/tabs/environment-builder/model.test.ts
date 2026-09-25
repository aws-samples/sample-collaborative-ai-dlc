import { describe, expect, it } from 'vitest';
import type { ManagedTool, ManagedToolVersion } from '@/services/environments';
import { formArchitecture, toolsForArchitecture } from './model';

const version = (versionId: string, architecture?: 'x86_64') =>
  ({
    toolId: 'go',
    versionId,
    status: 'PUBLISHED',
    definition: { version: '1.24.6', ...(architecture ? { architecture } : {}) },
  }) as unknown as ManagedToolVersion;

const tool = (overrides: Partial<ManagedTool>) =>
  ({
    toolId: 'go',
    name: 'Go SDK',
    recommendedVersionId: 'tv-arm',
    recommendedX86_64VersionId: 'tv-x86',
    versions: [version('tv-x86', 'x86_64'), version('tv-arm')],
    ...overrides,
  }) as ManagedTool;

describe('toolsForArchitecture', () => {
  it('keeps arm64 families shaped exactly as before', () => {
    const [arm] = toolsForArchitecture([tool({})], 'arm64');
    expect(arm.recommendedVersionId).toBe('tv-arm');
    expect(arm.versions.map((item) => item.versionId)).toEqual(['tv-arm']);
  });

  it('exposes only x86_64 builds and the x86_64 recommendation', () => {
    const [x86] = toolsForArchitecture([tool({})], 'x86_64');
    expect(x86.recommendedVersionId).toBe('tv-x86');
    expect(x86.versions.map((item) => item.versionId)).toEqual(['tv-x86']);
  });

  it('drops families with no build for the architecture', () => {
    const armOnly = tool({ recommendedX86_64VersionId: null, versions: [version('tv-arm')] });
    expect(toolsForArchitecture([armOnly], 'x86_64')).toEqual([]);
    expect(toolsForArchitecture([armOnly], 'arm64')).toHaveLength(1);
  });

  it('derives the architecture from the compute choice', () => {
    expect(formArchitecture({ compute: 'microvms' })).toBe('arm64');
    expect(formArchitecture({ compute: 'instances-x86_64' })).toBe('x86_64');
  });
});
