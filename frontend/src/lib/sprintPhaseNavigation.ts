const PHASE_URL_SUFFIX: Record<string, string> = {
  INCEPTION: '',
  CONSTRUCTION: '/construction',
  REVIEW: '/review',
  COMPLETED: '/review',
};

export function getSprintPhasePath(
  projectId: string,
  sprintId: string,
  phase: string,
): string | null {
  const suffix = PHASE_URL_SUFFIX[phase];
  if (suffix === undefined) return null;
  return `/project/${projectId}/sprint/${sprintId}${suffix}`;
}
