// Project Settings → Trackers tab: issue trackers wired to this project.
// Manages the git-issues tracker matching the project's git provider
// (github-issues / gitlab-issues), Jira Cloud connect + project binding, and
// the legacy-data migration banner.

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ClipboardList, Loader2, Plus, XCircle } from 'lucide-react';
import { projectsService, type Project, type TrackerBinding } from '@/services/projects';
import { trackersService, type TrackerConnection } from '@/services/trackers';
import {
  getGitProviderService,
  trackerIdForGitProvider,
  type GitTrackerProviderId,
} from '@/services/gitProvider';
import { getTrackerProvider, TRACKER_PROVIDERS } from '@/lib/trackerProviders';
import { useTrackerProviders } from '@/hooks/useTrackerProviders';
import { MigrateTrackerCard } from '@/components/MigrateTrackerCard';
import { JiraConnectButton } from '@/components/JiraConnectButton';
import { JiraProjectPickerDialog } from '@/components/JiraProjectPickerDialog';
import { SettingsCard } from '@/components/settings/SettingsCard';

interface Props {
  project: Project;
  canEdit: boolean;
  reload: () => Promise<void>;
}

export function TrackersTab({ project, canEdit, reload }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [togglingTracker, setTogglingTracker] = useState(false);

  // Cross-project tracker connections (Jira Cloud, GitHub, …). Drives the
  // "Connect Jira Cloud" CTA and downstream picker flows.
  const [trackerConnections, setTrackerConnections] = useState<TrackerConnection[]>([]);
  // Operator OAuth-app config — flips the Connect CTA to disabled with a
  // helper hint when the deployment hasn't populated the secret yet.
  const { providers: trackerProviders } = useTrackerProviders();
  const [connectingJira, setConnectingJira] = useState(false);
  const [showJiraProjectPicker, setShowJiraProjectPicker] = useState(false);

  // Tracker-abstraction migration (#194 Phase 1).
  const [migrating, setMigrating] = useState(false);
  const [migrationResult, setMigrationResult] = useState<{
    sprintsApplied: number;
    projectsApplied: number;
  } | null>(null);

  useEffect(() => {
    trackersService
      .listConnections()
      .then((conns) => setTrackerConnections(Array.isArray(conns) ? conns : []))
      .catch(() => setTrackerConnections([]));
  }, []);

  const bindings = project.trackers ?? [];

  // Add the git-issues tracker matching the project's git provider
  // (github-issues / gitlab-issues). Both reuse the project's git connection.
  const handleAddGitTracker = async (providerId: GitTrackerProviderId) => {
    if (!project.gitRepo) return;
    setError(null);
    setTogglingTracker(true);
    try {
      const meta = TRACKER_PROVIDERS[providerId];
      await trackersService.addToProject(project.id, {
        provider: meta.id,
        instance: meta.instance,
        externalProjectKey: project.gitRepo,
        displayName: project.gitRepo,
      });
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to enable tracker');
    } finally {
      setTogglingTracker(false);
    }
  };

  const handleConnectJira = async () => {
    setError(null);
    setConnectingJira(true);
    try {
      const { url } = await trackersService.getAuthUrl(TRACKER_PROVIDERS['jira-cloud'].id);
      window.location.href = url;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start Jira Cloud OAuth');
      setConnectingJira(false);
    }
  };

  // Triggered by the picker dialog once the user confirms a Jira project.
  const handleAddJiraBinding = async (chosen: { key: string; name: string }) => {
    setError(null);
    const jira = TRACKER_PROVIDERS['jira-cloud'];
    await trackersService.addToProject(project.id, {
      provider: jira.id,
      instance: jira.instance,
      externalProjectKey: chosen.key,
      displayName: chosen.name || chosen.key,
    });
    await reload();
  };

  const handleRemoveTracker = async (binding: TrackerBinding) => {
    setError(null);
    setTogglingTracker(true);
    try {
      await trackersService.removeFromProject(project.id, binding.id);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove tracker');
    } finally {
      setTogglingTracker(false);
    }
  };

  const handleReconnectTracker = async (binding: TrackerBinding) => {
    setError(null);
    try {
      // Store the return path so the OAuth callback redirects back here instead
      // of the create-project flow.
      sessionStorage.setItem('oauth_return_to', `/project/${project.id}/settings?tab=trackers`);
      // Git-based trackers (github-issues / gitlab-issues) share the git
      // provider's OAuth connection — reconnect via the git auth flow.
      if (binding.provider === 'github-issues' || binding.provider === 'gitlab-issues') {
        const gitProvider = binding.provider === 'gitlab-issues' ? 'gitlab' : 'github';
        const { url } = await getGitProviderService(gitProvider).getAuthUrl();
        window.location.href = url;
        return;
      }
      // Standalone tracker providers (Jira) use the trackers auth endpoint.
      const { url } = await trackersService.getAuthUrl(binding.provider);
      window.location.href = url;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start reconnection');
    }
  };

  const handleMigrateTracker = async () => {
    setError(null);
    setMigrating(true);
    try {
      const result = await projectsService.migrateTracker(project.id);
      setMigrationResult({
        sprintsApplied: result.sprints.applied,
        projectsApplied: result.projects.applied,
      });
      // Reload so the project's `trackers` array reflects the new binding,
      // which dismisses the card on next render.
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to migrate');
    } finally {
      setMigrating(false);
    }
  };

  // The "Add <git tracker>" affordance — only when the project's git provider
  // has issues support and isn't already bound for this repo.
  const gitTrackerCta = (() => {
    if (!canEdit || !project.gitRepo) return null;
    if (project.gitProvider !== 'github' && project.gitProvider !== 'gitlab') return null;
    const trackerId = trackerIdForGitProvider(project.gitProvider);
    const meta = TRACKER_PROVIDERS[trackerId];
    const alreadyBound = bindings.some(
      (b) => b.provider === meta.id && b.externalProjectKey === project.gitRepo,
    );
    if (alreadyBound) return null;
    return { trackerId, meta };
  })();

  return (
    <div className="space-y-6">
      <MigrateTrackerCard
        project={project}
        canEditProject={canEdit}
        migrating={migrating}
        migrationResult={migrationResult}
        onMigrate={handleMigrateTracker}
      />

      <SettingsCard
        icon={<ClipboardList />}
        title="Trackers"
        badge={
          <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium leading-4 text-muted-foreground">
            {bindings.length} connected
          </span>
        }
        description="Issue trackers wired to this project — sprints can start straight from their issues."
      >
        <div className="space-y-4">
          {error && (
            <p className="text-xs text-destructive flex items-center gap-1">
              <XCircle className="h-3.5 w-3.5 shrink-0" /> {error}
            </p>
          )}

          {bindings.length === 0 ? (
            <div className="rounded-lg border border-dashed px-3.5 py-6 text-center text-xs text-muted-foreground">
              No trackers connected to this project yet.
            </div>
          ) : (
            <div className="divide-y rounded-lg border">
              {bindings.map((b) => {
                const isLegacy = b.id === 'legacy-github';
                const meta = getTrackerProvider(b.provider);
                const Icon = meta.icon;
                return (
                  <div key={b.id} className="flex items-center gap-3 px-3.5 py-3">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border bg-muted/50">
                      <Icon className="h-3.5 w-3.5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">
                        {meta.displayName}
                        {isLegacy && (
                          <span className="ml-2 rounded-full bg-agent-warning/15 px-2 py-0.5 text-[10px] font-normal text-amber-600 dark:text-amber-400">
                            legacy — migrate to manage
                          </span>
                        )}
                      </p>
                      <p className="truncate text-[11px] text-muted-foreground">
                        {b.displayName || b.externalProjectKey}
                      </p>
                    </div>
                    {canEdit && !isLegacy && (
                      <div className="flex shrink-0 items-center gap-1">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 px-2.5 text-[11px]"
                          onClick={() => handleReconnectTracker(b)}
                          disabled={togglingTracker}
                        >
                          Reconnect
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2.5 text-[11px] text-muted-foreground hover:text-destructive"
                          onClick={() => handleRemoveTracker(b)}
                          disabled={togglingTracker}
                        >
                          Remove
                        </Button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {gitTrackerCta && (
            <div className="flex items-center justify-between gap-3 rounded-lg border border-dashed px-3.5 py-2.5">
              <p className="text-xs text-muted-foreground">
                Start sprints from {gitTrackerCta.meta.displayName} on{' '}
                <span className="font-mono">{project.gitRepo}</span>
              </p>
              <Button
                size="sm"
                variant="outline"
                className="h-7 shrink-0 gap-1.5 px-2.5 text-xs"
                onClick={() => handleAddGitTracker(gitTrackerCta.trackerId)}
                disabled={togglingTracker}
              >
                {togglingTracker ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Plus className="h-3 w-3" />
                )}
                Add {gitTrackerCta.meta.displayName}
              </Button>
            </div>
          )}

          {canEdit && (
            <JiraConnectButton
              jiraConnected={trackerConnections.some(
                (c) => c.provider === TRACKER_PROVIDERS['jira-cloud'].id,
              )}
              jiraConfigured={
                trackerProviders.find((p) => p.id === TRACKER_PROVIDERS['jira-cloud'].id)
                  ?.configured ?? false
              }
              togglingTracker={togglingTracker}
              connectingJira={connectingJira}
              onConnect={handleConnectJira}
              onPickProject={() => {
                setError(null);
                setShowJiraProjectPicker(true);
              }}
            />
          )}
        </div>
      </SettingsCard>

      <JiraProjectPickerDialog
        open={showJiraProjectPicker}
        onOpenChange={setShowJiraProjectPicker}
        onConfirm={handleAddJiraBinding}
      />
    </div>
  );
}
