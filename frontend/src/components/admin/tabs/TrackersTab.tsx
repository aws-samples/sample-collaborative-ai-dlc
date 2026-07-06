// "Trackers" tab — issue-tracker configuration. Jira Cloud is the only
// tracker with its own OAuth app; GitHub Issues and GitLab Issues reuse the
// source-control OAuth apps, so they appear here as read-only status rows
// pointing at the Source Control tab. Tracker data migration lives at the
// bottom.

import { Link } from 'react-router-dom';
import { Skeleton } from '@/components/ui/skeleton';
import { ArrowRight, Link2 } from 'lucide-react';
import { getTrackerProvider } from '@/lib/trackerProviders';
import type { TrackerProviderStatus } from '@/services/trackers';
import { AdminCard } from '../shared/AdminCard';
import { ConfigStatusBadge } from '../shared/ConfigStatusBadge';
import { OAuthAppConfigForm } from '../OAuthAppConfigForm';
import { TrackerMigrationCard } from '../TrackerMigrationCard';

interface Props {
  providers: TrackerProviderStatus[];
  providersLoading: boolean;
  onProvidersChanged: () => void;
}

// Trackers that piggyback on a source-control OAuth app instead of having
// credentials of their own.
const GIT_BACKED_TRACKERS = new Set(['github-issues', 'gitlab-issues']);

export function TrackersTab({ providers, providersLoading, onProvidersChanged }: Props) {
  // Skeleton only on the very first load — post-save refreshes keep the cards
  // mounted so their "Saved" feedback survives.
  if (providersLoading && providers.length === 0) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  const jira = providers.find((p) => p.id === 'jira-cloud');
  const gitBacked = providers.filter((p) => GIT_BACKED_TRACKERS.has(p.id));
  const JiraIcon = getTrackerProvider('jira-cloud').icon;

  return (
    <div className="space-y-6">
      {jira && (
        <AdminCard
          icon={<JiraIcon />}
          title={jira.label}
          badge={<ConfigStatusBadge ok={jira.configured} notOkTone="warning" />}
          description="Users connect their Atlassian accounts from Project Settings → Trackers."
        >
          <OAuthAppConfigForm
            providerId="jira-cloud"
            configured={jira.configured}
            onSaved={onProvidersChanged}
          />
        </AdminCard>
      )}

      {gitBacked.length > 0 && (
        <AdminCard
          icon={<Link2 />}
          title="Source-control trackers"
          description="These reuse the source-control OAuth apps — one connection covers repos and issues."
        >
          <div className="divide-y rounded-lg border">
            {gitBacked.map((p) => {
              const meta = getTrackerProvider(p.id);
              const Icon = meta.icon;
              return (
                <div key={p.id} className="flex items-center gap-3 px-3.5 py-3">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border bg-muted/50">
                    <Icon className="h-3.5 w-3.5" />
                  </div>
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                    {p.label}
                  </span>
                  <ConfigStatusBadge ok={p.configured} />
                  <Link
                    to="/admin?tab=source-control"
                    className="inline-flex shrink-0 items-center gap-1 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
                  >
                    Configure in Source Control <ArrowRight className="h-3 w-3" />
                  </Link>
                </div>
              );
            })}
          </div>
        </AdminCard>
      )}

      <TrackerMigrationCard />
    </div>
  );
}
