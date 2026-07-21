// GitHub OAuth and GitHub App credentials coexist at platform level. Projects
// choose one auth type when their repositories are bound.

import { useEffect, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Bot, Users } from 'lucide-react';
import { GitHubIcon } from '@/components/icons/git-providers';
import {
  githubAdminService,
  type GitHubAdminConfig,
  type GitHubAdminConfigUpdate,
} from '@/services/gitProvider';
import { SettingsCard } from '@/components/settings/SettingsCard';
import { ConfigStatusBadge } from '@/components/settings/ConfigStatusBadge';
import { SaveStatusButton, type SaveResult } from '@/components/settings/SaveStatusButton';
import { OAuthAppConfigForm } from './OAuthAppConfigForm';

interface Props {
  oauthConfigured: boolean;
  onOAuthSaved: () => void;
}

export function GitHubSourceControlCard({ oauthConfigured, onOAuthSaved }: Props) {
  const [config, setConfig] = useState<GitHubAdminConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [appId, setAppId] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<SaveResult>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    githubAdminService
      .getConfig()
      .then((next) => {
        setConfig(next);
        setAppId(next.appId ?? '');
      })
      .catch((error) => {
        console.error('Failed to load GitHub integration config:', error);
        setLoadError(error instanceof Error ? error.message : 'Failed to load configuration');
      })
      .finally(() => setLoading(false));
  }, []);

  const hasAppChanges =
    config !== null && (appId.trim() !== (config.appId ?? '') || privateKey.trim() !== '');

  const handleSaveApp = async () => {
    if (!config) return;
    setSaving(true);
    setSaveResult(null);
    setErrorMessage(null);
    try {
      const update: GitHubAdminConfigUpdate = {};
      if (appId.trim() !== (config.appId ?? '')) update.appId = appId.trim();
      if (privateKey.trim()) update.privateKey = privateKey;

      const fresh = await githubAdminService.updateConfig(update);
      setConfig(fresh);
      setAppId(fresh.appId ?? '');
      setPrivateKey('');
      setSaveResult('saved');
    } catch (error) {
      setSaveResult('error');
      const body = (error as { body?: { error?: string } })?.body;
      setErrorMessage(
        body?.error || (error instanceof Error ? error.message : 'Failed to save configuration'),
      );
    } finally {
      setSaving(false);
      setTimeout(() => setSaveResult((previous) => (previous === 'saved' ? null : previous)), 4000);
    }
  };

  return (
    <SettingsCard
      icon={<GitHubIcon />}
      title="GitHub"
      badge={
        config && (
          <ConfigStatusBadge
            ok={oauthConfigured || config.appConfigured}
            okLabel={
              oauthConfigured && config.appConfigured
                ? 'OAuth + App ready'
                : oauthConfigured
                  ? 'OAuth ready'
                  : 'App ready'
            }
            notOkLabel="Setup needed"
            notOkTone="warning"
          />
        )
      }
      description="Configure both integrations; each space chooses OAuth delegation or the GitHub App."
    >
      {loading ? (
        <div className="space-y-3">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-36 w-full" />
        </div>
      ) : loadError ? (
        <p className="text-xs text-destructive">{loadError}</p>
      ) : (
        <div className="space-y-6">
          <section className="space-y-2.5">
            <div className="flex items-center gap-2">
              <Users className="h-4 w-4 text-muted-foreground" />
              <p className="text-xs font-semibold">OAuth app</p>
              <ConfigStatusBadge ok={oauthConfigured} />
            </div>
            <p className="text-[11px] text-muted-foreground">
              Owners and admins can explicitly delegate their connected identity to a space.
            </p>
            <OAuthAppConfigForm
              providerId="github-issues"
              configured={oauthConfigured}
              onSaved={onOAuthSaved}
            />
          </section>

          <section className="space-y-3 border-t pt-5">
            <div className="flex items-center gap-2">
              <Bot className="h-4 w-4 text-muted-foreground" />
              <p className="text-xs font-semibold">GitHub App</p>
              <ConfigStatusBadge ok={Boolean(config?.appConfigured)} />
            </div>
            <p className="text-[11px] text-muted-foreground">
              Install the App on any organization or personal account. Installation and repository
              permissions are discovered and verified when a space is bound.
            </p>
            {config?.appIdentity && (
              <p className="text-[11px] text-muted-foreground">
                Authenticated as <span className="font-mono">{config.appIdentity}</span>
              </p>
            )}
            {config?.appConfigurationError && (
              <p className="text-[11px] text-destructive">{config.appConfigurationError}</p>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="github-app-id" className="text-xs">
                App ID
              </Label>
              <Input
                id="github-app-id"
                value={appId}
                onChange={(event) => setAppId(event.target.value)}
                placeholder="e.g. 123456"
                className="h-9 font-mono text-sm"
                autoComplete="off"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="github-app-private-key" className="flex items-center gap-2 text-xs">
                Private Key (PEM)
                {config?.privateKeySet && <ConfigStatusBadge ok okLabel="Set" />}
              </Label>
              <textarea
                id="github-app-private-key"
                value={privateKey}
                onChange={(event) => setPrivateKey(event.target.value)}
                placeholder={
                  config?.privateKeySet
                    ? 'Paste a new key to rotate, or leave blank'
                    : '-----BEGIN RSA PRIVATE KEY-----'
                }
                rows={4}
                className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-[11px] shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                autoComplete="off"
              />
            </div>

            <SaveStatusButton
              onClick={handleSaveApp}
              disabled={!hasAppChanges}
              saving={saving}
              label="Save GitHub App Settings"
              result={saveResult}
              savedMessage="Saved and verified"
              errorMessage={errorMessage}
            />
          </section>
        </div>
      )}
    </SettingsCard>
  );
}
