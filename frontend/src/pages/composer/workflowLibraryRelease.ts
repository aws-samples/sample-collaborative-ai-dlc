import {
  aidlcReleasesService,
  releaseDisplayLabel,
  type ReleaseBlock,
} from '@/services/aidlcReleases';

export interface WorkflowLibraryRelease {
  releaseId: string;
  label: string;
  explicit: boolean;
  scopes: ReleaseBlock[];
  stages: ReleaseBlock[];
}

export async function loadWorkflowLibraryRelease(
  workflowReadOnly: boolean,
  requestedRelease: string | null,
): Promise<WorkflowLibraryRelease | null> {
  if (workflowReadOnly) return null;

  const catalog = requestedRelease
    ? await aidlcReleasesService.catalog(requestedRelease, ['scope', 'stage'])
    : await aidlcReleasesService.stableCatalog(['scope', 'stage']);
  if (!catalog) return null;

  return {
    releaseId: catalog.releaseId,
    label: releaseDisplayLabel(catalog.release),
    explicit: Boolean(requestedRelease),
    scopes: (catalog.contents.blocks.scope ?? []) as ReleaseBlock[],
    stages: (catalog.contents.blocks.stage ?? []) as ReleaseBlock[],
  };
}
