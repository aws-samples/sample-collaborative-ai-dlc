import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { AlertCircle } from 'lucide-react';
import type { Project } from '@/services/projects';

// Tracker-abstraction migration banner. Appears only when the project still
// uses the legacy issue_integration boolean and has no HAS_TRACKER edge yet.
// Disappears once migrated. See parent issue #194 (Jira / tracker provider
// abstraction).
interface Props {
  project: Project;
  canEditProject: boolean;
  migrating: boolean;
  migrationResult: { sprintsApplied: number; projectsApplied: number } | null;
  onMigrate: () => void;
}

export function MigrateTrackerCard({
  project,
  canEditProject,
  migrating,
  migrationResult,
  onMigrate,
}: Props) {
  // A project still needs migration when issueIntegrationEnabled is true and
  // it has no real trackers — the legacy synthetic binding (`id:
  // 'legacy-github'`) the backend appends doesn't count, since it isn't
  // backed by a graph edge.
  const hasRealTracker = project.trackers.some((t) => t.id !== 'legacy-github');
  const needsMigration = project.issueIntegrationEnabled === true && !hasRealTracker;
  if (!needsMigration) return null;

  return (
    <Card className="mb-6 border-amber-500/40 bg-amber-500/5">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <AlertCircle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
          Migrate to the new tracker data model
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          This space uses the legacy issue-tracker data model. Migrating updates this space and its
          sprints to the new model so you'll be able to add Jira and other tracker providers (per{' '}
          <code>#194</code>) when they ship.
        </p>
        <p className="text-xs text-muted-foreground">
          Your existing GitHub-issue links stay intact. No data is deleted; this is a one-time
          backfill that takes a few seconds.
        </p>
        {migrationResult && (
          <p className="text-xs text-emerald-700 dark:text-emerald-400">
            Migrated: {migrationResult.projectsApplied} space binding(s),{' '}
            {migrationResult.sprintsApplied} sprint(s).
          </p>
        )}
        {canEditProject ? (
          <div className="flex justify-end">
            <Button size="sm" onClick={onMigrate} disabled={migrating}>
              {migrating ? 'Migrating…' : 'Migrate now'}
            </Button>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            Only owners and admins can run the migration.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
