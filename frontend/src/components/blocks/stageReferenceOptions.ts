import { blocksService, type Block } from '@/services/blocks';
import {
  aidlcReleasesService,
  releaseDisplayLabel,
  type ReleaseBlock,
} from '@/services/aidlcReleases';
import type { ReferenceOption, StageReferenceOptions } from './StageEditor';

// The stage editor's picker options: the mutable library plus, when release
// pinning is on, the stable release's catalog (issue #607).
//
// One entry per id, in the precedence a pinned intent resolves them: the user
// library (`default`) shadows the release, and the release replaces the SYSTEM
// baseline, which only an unpinned intent still reads. Each option names its
// source when a release is in play, so an author can tell a release agent from
// a library copy of it.

export interface StageReferenceRelease {
  releaseId: string;
  label: string;
}

const toOption = (block: Block, source?: string): ReferenceOption => ({
  id: block.id,
  label: block.name || block.id,
  description: typeof block.description === 'string' ? block.description : undefined,
  ...(source ? { source } : {}),
});

export const mergeReferenceBlocks = (
  library: Block[],
  release: ReleaseBlock[] | null = null,
  releaseLabel = 'release',
): ReferenceOption[] => {
  if (!release) return library.map((block) => toOption(block));
  const byId = new Map<string, ReferenceOption>();
  const add = (block: Block, source: string) => {
    if (!byId.has(block.id)) byId.set(block.id, toOption(block, source));
  };
  for (const block of library) if (block.tenantId !== 'SYSTEM') add(block, 'library');
  for (const block of release) add(block, releaseLabel);
  for (const block of library) if (block.tenantId === 'SYSTEM') add(block, 'SYSTEM');
  return [...byId.values()];
};

export const loadStageReferenceOptions = async (
  excludeStageId?: string,
): Promise<{ options: StageReferenceOptions; release: StageReferenceRelease | null }> => {
  const [agents, artifacts, sensors, stages, stable] = await Promise.all([
    blocksService.list('agent'),
    blocksService.list('artifact'),
    blocksService.list('sensor'),
    blocksService.list('stage'),
    aidlcReleasesService.stableCatalog(['agent', 'artifact', 'sensor', 'stage']),
  ]);
  const label = stable ? releaseDisplayLabel(stable.release) : 'release';
  const merge = (library: Block[], type: 'agent' | 'artifact' | 'sensor' | 'stage') =>
    mergeReferenceBlocks(library, stable ? (stable.contents.blocks[type] ?? []) : null, label);
  return {
    options: {
      agents: merge(agents.blocks, 'agent'),
      artifacts: merge(artifacts.blocks, 'artifact'),
      sensors: merge(sensors.blocks, 'sensor'),
      stages: merge(stages.blocks, 'stage').filter((stage) => stage.id !== excludeStageId),
    },
    release: stable ? { releaseId: stable.releaseId, label } : null,
  };
};
