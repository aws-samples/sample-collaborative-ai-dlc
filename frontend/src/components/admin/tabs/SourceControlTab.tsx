// "Source Control" tab — platform-wide git provider configuration.
// GitHub gets the full auth-mode treatment (OAuth vs GitHub App); GitLab is
// OAuth-only. The GitHub/GitLab OAuth apps are shared with their issue
// trackers (one OAuth app per platform), which the card copy calls out.

import { Skeleton } from '@/components/ui/skeleton';
import { GitLabIcon } from '@/components/icons/git-providers';
import type { TrackerProviderStatus } from '@/services/trackers';
import { SettingsCard } from '@/components/settings/SettingsCard';
import { ConfigStatusBadge } from '@/components/settings/ConfigStatusBadge';
import { GitHubSourceControlCard } from '../GitHubSourceControlCard';
import { OAuthAppConfigForm } from '../OAuthAppConfigForm';

interface Props {
  providers: TrackerProviderStatus[];
  providersLoading: boolean;
  onProvidersChanged: () => void;
}

const isConfigured = (providers: TrackerProviderStatus[], id: string) =>
  providers.find((p) => p.id === id)?.configured ?? false;

export function SourceControlTab({ providers, providersLoading, onProvidersChanged }: Props) {
  // Skeleton only on the very first load — post-save refreshes keep the cards
  // mounted so their "Saved" feedback survives.
  if (providersLoading && providers.length === 0) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  const gitlabConfigured = isConfigured(providers, 'gitlab-issues');

  return (
    <div className="space-y-6">
      <GitHubSourceControlCard
        oauthConfigured={isConfigured(providers, 'github-issues')}
        onOAuthSaved={onProvidersChanged}
      />

      <SettingsCard
        icon={<GitLabIcon />}
        title="GitLab"
        badge={<ConfigStatusBadge ok={gitlabConfigured} notOkTone="warning" />}
        description="One OAuth app covers repo access (MRs) and the GitLab Issues tracker."
      >
        <OAuthAppConfigForm
          providerId="gitlab-issues"
          configured={gitlabConfigured}
          onSaved={onProvidersChanged}
        />
      </SettingsCard>
    </div>
  );
}
