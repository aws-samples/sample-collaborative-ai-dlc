import { useEffect, useState } from 'react';
import {
  aidlcReleasesService,
  releaseDisplayLabel,
  type ReleaseBlock,
} from '@/services/aidlcReleases';
import type { BlockType } from '@/services/blocks';

export interface BlockLibraryRelease {
  releaseId: string;
  label: string;
  stable: boolean;
  selectedForAuthoring: boolean;
  blocks: ReleaseBlock[];
}

interface BlockLibraryReleaseState {
  release: BlockLibraryRelease | null;
  error: string | null;
}

export function useBlockLibraryRelease(
  activeType: BlockType,
  requestedRelease: string | null,
  requestedLibraryRelease: string | null,
): BlockLibraryReleaseState {
  const [state, setState] = useState<BlockLibraryReleaseState>({
    release: null,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    setState({ release: null, error: null });

    const selectedReleaseId = requestedLibraryRelease ?? requestedRelease;
    const request = selectedReleaseId
      ? aidlcReleasesService.contents(selectedReleaseId, [activeType]).then((contents) => ({
          releaseId: selectedReleaseId,
          stable: false,
          selectedForAuthoring: Boolean(requestedLibraryRelease),
          contents,
        }))
      : aidlcReleasesService
          .stableCatalog([activeType])
          .then((stable) =>
            stable ? { ...stable, stable: true, selectedForAuthoring: true } : null,
          );

    request
      .then((found) => {
        if (!cancelled) {
          setState({
            release: found
              ? {
                  releaseId: found.releaseId,
                  label: releaseDisplayLabel(found.contents.release),
                  stable: found.stable,
                  selectedForAuthoring: found.selectedForAuthoring,
                  blocks: found.contents.blocks[activeType] ?? [],
                }
              : null,
            error: null,
          });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({
            release: null,
            error: error instanceof Error ? error.message : 'Failed to load the release',
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeType, requestedLibraryRelease, requestedRelease]);

  return state;
}
