import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { AlertCircle, CheckCircle2, Database, Loader2, XCircle } from 'lucide-react';
import {
  projectsService,
  type TrackerMigrationResult,
  type TrackerMigrationStatus,
} from '@/services/projects';
import { SettingsCard } from '@/components/settings/SettingsCard';

// Operator-facing card for the tracker provider abstraction migration
// (#194 phase #198). Surfaces "X projects on the legacy data model" and
// promotes the bulk migration from the CLI-only `migrate-tracker-fields`
// Lambda into the Admin UI. The Lambda stays deployed permanently for
// users who prefer the shell path; both routes share the same shared core
// so they cannot drift.
export function TrackerMigrationCard() {
  const [status, setStatus] = useState<TrackerMigrationStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [lastRun, setLastRun] = useState<TrackerMigrationResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await projectsService.getTrackerMigrationStatus();
      setStatus(next);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load migration status');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const onMigrate = async () => {
    setRunning(true);
    setError(null);
    try {
      const result = await projectsService.runTrackerMigration();
      setLastRun(result);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Migration failed');
    } finally {
      setRunning(false);
    }
  };

  const projectCandidates = status?.projects.candidates ?? 0;
  const sprintCandidates = status?.sprints.candidates ?? 0;
  const allMigrated = !loading && !error && projectCandidates === 0 && sprintCandidates === 0;

  // Nothing to do: collapse to a one-line note instead of a full card so the
  // Trackers tab stays clean for the common case.
  if (allMigrated) {
    return (
      <p className="text-xs text-muted-foreground flex items-center gap-1.5 px-1">
        <CheckCircle2 className="h-3.5 w-3.5 text-agent-success" />
        {lastRun
          ? `Migrated ${lastRun.projects.applied} space binding${
              lastRun.projects.applied === 1 ? '' : 's'
            } and ${lastRun.sprints.applied} sprint${
              lastRun.sprints.applied === 1 ? '' : 's'
            } — all spaces are now on the current tracker model.`
          : 'Tracker data migration: all spaces are on the current tracker model — nothing to migrate.'}
      </p>
    );
  }

  return (
    <SettingsCard
      icon={<Database />}
      title="Tracker Migration"
      description={
        <>
          Backfills the tracker provider abstraction for spaces still on the legacy{' '}
          <code className="rounded bg-muted px-1 text-[10px]">issue_integration_enabled</code>{' '}
          shape. Idempotent — only converts what hasn't been converted yet.
        </>
      }
    >
      <div className="space-y-4">
        {loading ? (
          <div className="space-y-2">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-9 w-32" />
          </div>
        ) : status ? (
          <>
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3.5 py-2.5">
              <p className="text-xs flex items-center gap-1.5 font-medium text-amber-700 dark:text-amber-400">
                <AlertCircle className="h-3.5 w-3.5" />
                Legacy tracker data detected
              </p>
              <ul className="mt-1.5 text-xs text-muted-foreground space-y-0.5 list-disc list-inside">
                <li>
                  <span className="font-mono tabular-nums text-foreground">
                    {projectCandidates}
                  </span>{' '}
                  space{projectCandidates === 1 ? '' : 's'} on the legacy tracker model
                </li>
                <li>
                  <span className="font-mono tabular-nums text-foreground">{sprintCandidates}</span>{' '}
                  sprint{sprintCandidates === 1 ? '' : 's'} with un-backfilled tracker links
                </li>
              </ul>
            </div>
            <div className="flex items-center gap-3">
              <Button size="sm" onClick={onMigrate} disabled={running} className="gap-1.5">
                {running && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {running ? 'Migrating…' : 'Migrate all'}
              </Button>
              {lastRun && !running && (
                <span className="text-xs text-agent-success flex items-center gap-1">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  Migrated {lastRun.projects.applied} space binding
                  {lastRun.projects.applied === 1 ? '' : 's'}, {lastRun.sprints.applied} sprint
                  {lastRun.sprints.applied === 1 ? '' : 's'}
                </span>
              )}
            </div>
          </>
        ) : null}
        {error && (
          <p className="text-xs text-destructive flex items-center gap-1">
            <XCircle className="h-3.5 w-3.5 shrink-0" /> {error}
          </p>
        )}
      </div>
    </SettingsCard>
  );
}
