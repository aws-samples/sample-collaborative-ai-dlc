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
  rules: ReleaseBlock[];
}

export async function loadWorkflowLibraryRelease(
  workflowReadOnly: boolean,
  requestedRelease: string | null,
): Promise<WorkflowLibraryRelease | null> {
  if (workflowReadOnly) return null;

  const catalog = requestedRelease
    ? await aidlcReleasesService.catalog(requestedRelease, ['scope', 'stage', 'rule'])
    : await aidlcReleasesService.stableCatalog(['scope', 'stage', 'rule']);
  if (!catalog) return null;

  return {
    releaseId: catalog.releaseId,
    label: releaseDisplayLabel(catalog.release),
    explicit: Boolean(requestedRelease),
    scopes: (catalog.contents.blocks.scope ?? []) as ReleaseBlock[],
    stages: (catalog.contents.blocks.stage ?? []) as ReleaseBlock[],
    rules: (catalog.contents.blocks.rule ?? []) as ReleaseBlock[],
  };
}
