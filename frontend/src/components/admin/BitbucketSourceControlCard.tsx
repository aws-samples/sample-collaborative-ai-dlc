import { useEffect, useState } from 'react';
import { BitbucketIcon } from '@/components/icons/git-providers';
import { bitbucketAdminService } from '@/services/gitProvider';
import { SettingsCard } from '@/components/settings/SettingsCard';
import { ConfigStatusBadge } from '@/components/settings/ConfigStatusBadge';
import { Skeleton } from '@/components/ui/skeleton';
import { OAuthAppConfigForm } from './OAuthAppConfigForm';

export function BitbucketSourceControlCard() {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    bitbucketAdminService
      .getConfig()
      .then((config) => setConfigured(config.configured))
      .catch((error) => {
        console.error('Failed to load Bitbucket integration config:', error);
        setLoadError(error instanceof Error ? error.message : 'Failed to load configuration');
      });
  }, []);

  const reload = async () => {
    const config = await bitbucketAdminService.getConfig();
    setConfigured(config.configured);
  };

  return (
    <SettingsCard
      icon={<BitbucketIcon />}
      title="Bitbucket"
      badge={configured !== null && <ConfigStatusBadge ok={configured} notOkTone="warning" />}
      description="OAuth credentials for Bitbucket repository access and pull requests."
    >
      {configured === null && !loadError ? (
        <Skeleton className="h-24 w-full" />
      ) : loadError ? (
        <p className="text-xs text-destructive">{loadError}</p>
      ) : (
        <OAuthAppConfigForm
          providerId="bitbucket"
          configured={configured ?? false}
          onSaved={reload}
          saveCredentials={bitbucketAdminService.setOAuthConfig}
        />
      )}
    </SettingsCard>
  );
}
