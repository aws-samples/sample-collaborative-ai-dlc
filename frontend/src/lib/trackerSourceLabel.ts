export interface TrackerSourceLabelInput {
  provider: string;
  resourceId: string;
  entityType?: string | null;
}

// GitHub and GitLab use issue numbers, while Jira keys already identify their
// project. Jira's subtype is available while selecting a source but is not
// persisted on intent provenance.
export function formatTrackerSourceLabel({
  provider,
  resourceId,
  entityType,
}: TrackerSourceLabelInput): string {
  if (provider === 'jira-cloud') {
    return entityType ? `${entityType} ${resourceId}` : resourceId;
  }
  return `Issue #${resourceId}`;
}
