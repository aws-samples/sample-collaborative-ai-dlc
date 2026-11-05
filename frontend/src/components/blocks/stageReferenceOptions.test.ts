import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Block } from '@/services/blocks';
import type { ReleaseBlock } from '@/services/aidlcReleases';

const list = vi.fn();
const stableCatalog = vi.fn();
const catalog = vi.fn();

vi.mock('@/services/blocks', () => ({
  blocksService: { list: (...a: unknown[]) => list(...a) },
}));
vi.mock('@/services/aidlcReleases', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/services/aidlcReleases')>();
  return {
    ...original,
    aidlcReleasesService: {
      stableCatalog: (...a: unknown[]) => stableCatalog(...a),
      catalog: (...a: unknown[]) => catalog(...a),
    },
  };
});

import {
  loadStageReferenceOptions,
  mergeReferenceBlocks,
  mergeReleaseLibraryBlocks,
} from './stageReferenceOptions';

const block = (id: string, tenantId: string, name = id): Block => ({
  id,
  blockId: id,
  blockType: 'AGENT',
  tenantId,
  name,
  version: 1,
  readOnly: tenantId === 'SYSTEM',
  hasBody: false,
  bodyBytes: 0,
  hasScript: false,
  scriptBytes: 0,
  createdAt: '',
  updatedAt: '',
});
const releaseBlock = (id: string, name = id): ReleaseBlock => ({
  ...block(id, 'SYSTEM', name),
  source: 'release',
  releaseId: 'aidlc:abc',
});

describe('mergeReferenceBlocks', () => {
  it('keeps the library unchanged and unlabelled without a release', () => {
    const options = mergeReferenceBlocks([block('a', 'default'), block('b', 'SYSTEM')]);

    expect(options).toEqual([
      { id: 'a', label: 'a', description: undefined },
      { id: 'b', label: 'b', description: undefined },
    ]);
  });

  it('resolves each id the way a pinned intent does, and names the source', () => {
    const options = mergeReferenceBlocks(
      [
        block('shared', 'default', 'Team copy'),
        block('system-only', 'SYSTEM'),
        block('both', 'SYSTEM'),
      ],
      [
        releaseBlock('shared', 'Release copy'),
        releaseBlock('both', 'Release both'),
        releaseBlock('security-reviewer'),
      ],
      'AI-DLC 2.11.0',
    );

    expect(options.map(({ id, label, source }) => ({ id, label, source }))).toEqual([
      // The user library shadows the release…
      { id: 'shared', label: 'Team copy', source: 'library' },
      // …the release replaces the SYSTEM baseline…
      { id: 'both', label: 'Release both', source: 'AI-DLC 2.11.0' },
      { id: 'security-reviewer', label: 'security-reviewer', source: 'AI-DLC 2.11.0' },
      // …and a SYSTEM-only block is still offered, labelled as such.
      { id: 'system-only', label: 'system-only', source: 'SYSTEM' },
    ]);
  });
});

describe('mergeReleaseLibraryBlocks', () => {
  it('keeps library overrides, applies the selected release over SYSTEM, and labels release blocks read-only', () => {
    const blocks = mergeReleaseLibraryBlocks(
      [
        block('library-only', 'default'),
        block('shared', 'default', 'Library copy'),
        block('shared', 'SYSTEM', 'System copy'),
        block('system-only', 'SYSTEM'),
      ],
      [{ ...releaseBlock('shared', 'Release copy') }, { ...releaseBlock('release-only') }],
    );

    expect(blocks.map(({ id, name, tenantId }) => ({ id, name, tenantId }))).toEqual([
      { id: 'library-only', name: 'library-only', tenantId: 'default' },
      { id: 'shared', name: 'Library copy', tenantId: 'default' },
      { id: 'release-only', name: 'release-only', tenantId: 'SYSTEM' },
      { id: 'system-only', name: 'system-only', tenantId: 'SYSTEM' },
    ]);
    expect(blocks.find(({ id }) => id === 'release-only')).toMatchObject({
      readOnly: true,
      source: 'release',
      releaseId: 'aidlc:abc',
    });
  });
});

describe('loadStageReferenceOptions', () => {
  beforeEach(() => {
    list
      .mockReset()
      .mockImplementation((type: string) =>
        Promise.resolve({ blocks: type === 'stage' ? [block('this-stage', 'default')] : [] }),
      );
    stableCatalog.mockReset();
    catalog.mockReset();
  });

  it('adds the stable release to every picker', async () => {
    stableCatalog.mockResolvedValue({
      releaseId: 'aidlc:abc',
      release: { releaseId: 'aidlc:abc', upstreamVersion: '2.11.0' },
      contents: {
        release: { releaseId: 'aidlc:abc', upstreamVersion: '2.11.0' },
        workflow: null,
        blocks: {
          agent: [releaseBlock('security-reviewer')],
          artifact: [releaseBlock('threat-model')],
          sensor: [releaseBlock('lint-sensor')],
          stage: [releaseBlock('code-review')],
        },
      },
    });

    const { options, release } = await loadStageReferenceOptions('this-stage');

    expect(stableCatalog).toHaveBeenCalledWith(['agent', 'artifact', 'sensor', 'stage']);
    expect(release).toEqual({ releaseId: 'aidlc:abc', label: 'AI-DLC 2.11.0' });
    expect(options.agents?.map((option) => option.id)).toEqual(['security-reviewer']);
    expect(options.artifacts?.map((option) => option.id)).toEqual(['threat-model']);
    expect(options.sensors?.map((option) => option.id)).toEqual(['lint-sensor']);
    // The stage being edited is never offered as its own dependency.
    expect(options.stages?.map((option) => option.id)).toEqual(['code-review']);
    expect(options.agents?.[0].source).toBe('AI-DLC 2.11.0');
  });

  it('falls back to the library alone when no stable release is in force', async () => {
    stableCatalog.mockResolvedValue(null);

    const { options, release } = await loadStageReferenceOptions('other');

    expect(release).toBeNull();
    expect(options.stages).toEqual([
      { id: 'this-stage', label: 'this-stage', description: undefined },
    ]);
  });

  it('loads the requested release exactly and propagates a failed read', async () => {
    catalog.mockResolvedValue({
      releaseId: 'aidlc:old',
      release: { releaseId: 'aidlc:old', upstreamVersion: '2.9.0' },
      contents: {
        release: { releaseId: 'aidlc:old', upstreamVersion: '2.9.0' },
        workflow: null,
        blocks: { agent: [releaseBlock('old-reviewer')] },
      },
    });

    const { options, release } = await loadStageReferenceOptions(undefined, 'aidlc:old');

    expect(catalog).toHaveBeenCalledWith('aidlc:old', ['agent', 'artifact', 'sensor', 'stage']);
    expect(stableCatalog).not.toHaveBeenCalled();
    expect(release).toEqual({ releaseId: 'aidlc:old', label: 'AI-DLC 2.9.0' });
    expect(options.agents?.[0]).toMatchObject({ id: 'old-reviewer', source: 'AI-DLC 2.9.0' });

    catalog.mockRejectedValueOnce(new Error('release unavailable'));
    await expect(loadStageReferenceOptions(undefined, 'aidlc:old')).rejects.toThrow(
      'release unavailable',
    );
  });
});
