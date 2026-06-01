import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import type { Project, TrackerBinding } from '@/services/projects';

// Provider-agnostic issue trackers wired to a project. Phase 2 (#196) only
// manages github-issues here; Phase 3 adds Jira via the same surface.
interface Props {
  project: Project;
  canEditProject: boolean;
  togglingTracker: boolean;
  onAddGithubTracker: () => void;
  onRemoveTracker: (binding: TrackerBinding) => void;
}

export function TrackersCard({
  project,
  canEditProject,
  togglingTracker,
  onAddGithubTracker,
  onRemoveTracker,
}: Props) {
  const trackers = project.trackers ?? [];
  const hasGithubBindingForRepo = trackers.some(
    (b) => b.provider === 'github-issues' && b.externalProjectKey === project.gitRepo,
  );
  const canAddGithub =
    canEditProject &&
    project.gitProvider === 'github' &&
    !!project.gitRepo &&
    !hasGithubBindingForRepo;

  return (
    <Card className="mb-6">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Trackers</CardTitle>
        <p className="text-sm text-muted-foreground">
          Connect issue trackers so sprints can be started from their issues.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {trackers.length === 0 ? (
          <p className="text-sm text-muted-foreground">No trackers connected to this project.</p>
        ) : (
          <div className="space-y-2">
            {trackers.map((b) => (
              <div
                key={b.id}
                className="flex items-center justify-between gap-3 border rounded-md p-3"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    {b.provider === 'github-issues' ? 'GitHub Issues' : b.provider}
                  </p>
                  <p className="text-xs text-muted-foreground truncate">
                    {b.displayName || b.externalProjectKey}
                  </p>
                </div>
                {canEditProject && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onRemoveTracker(b)}
                    disabled={togglingTracker}
                  >
                    Remove
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}

        {canAddGithub && (
          <div className="flex justify-end pt-2">
            <Button size="sm" onClick={onAddGithubTracker} disabled={togglingTracker}>
              {togglingTracker ? 'Saving…' : `Add GitHub Issues for ${project.gitRepo}`}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
