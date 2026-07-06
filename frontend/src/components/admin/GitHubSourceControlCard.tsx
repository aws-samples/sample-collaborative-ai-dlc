// GitHub source-control card — platform-wide GitHub auth mode (OAuth vs GitHub
// App) with mode-specific configuration shown only for the selected mode:
//   - OAuth mode  → the shared GitHub OAuth app credentials (one OAuth app per
//                   platform; it powers repo access AND the GitHub Issues
//                   tracker — the backend stores a single secret for both).
//   - App mode    → GitHub App ID / Installation ID / private key. The backend
//                   live-probes the App installation before a flip to App mode
//                   can land.

import { useEffect, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Bot, CheckCircle2, Users } from 'lucide-react';
import { GitHubIcon } from '@/components/icons/git-providers';
import {
  githubAdminService,
  type GitHubAdminConfig,
  type GitHubAdminConfigUpdate,
  type GitHubAuthMode,
} from '@/services/gitProvider';
import { cn } from '@/lib/utils';
import { SettingsCard } from '@/components/settings/SettingsCard';
import { ConfigStatusBadge } from '@/components/settings/ConfigStatusBadge';
import { SaveStatusButton, type SaveResult } from '@/components/settings/SaveStatusButton';
import { OAuthAppConfigForm } from './OAuthAppConfigForm';

const MODE_OPTIONS: {
  value: GitHubAuthMode;
  icon: typeof Users;
  title: string;
  description: string;
}[] = [
  {
    value: 'oauth',
    icon: Users,
    title: 'OAuth (user accounts)',
    description: 'Users connect their own accounts — activity is attributed to them.',
  },
  {
    value: 'app',
    icon: Bot,
    title: 'GitHub App (bot)',
    description: 'The platform acts as an App installation — no per-user setup.',
  },
];

interface Props {
  /** Whether the shared GitHub OAuth app (github-issues secret slot) is configured. */
  oauthConfigured: boolean;
  /** Refresh provider statuses after the OAuth credentials are saved. */
  onOAuthSaved: () => void;
}

export function GitHubSourceControlCard({ oauthConfigured, onOAuthSaved }: Props) {
  const [config, setConfig] = useState<GitHubAdminConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [selectedMode, setSelectedMode] = useState<GitHubAuthMode>('oauth');
  const [appId, setAppId] = useState('');
  const [installationId, setInstallationId] = useState('');
  const [privateKey, setPrivateKey] = useState('');

  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<SaveResult>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [installationAccount, setInstallationAccount] = useState<string | null>(null);

  useEffect(() => {
    githubAdminService
      .getConfig()
      .then((c) => {
        setConfig(c);
        setSelectedMode(c.mode);
        setAppId(c.appId ?? '');
        setInstallationId(c.installationId ?? '');
      })
      .catch((e) => {
        console.error('Failed to load GitHub integration config:', e);
        setLoadError(e instanceof Error ? e.message : 'Failed to load configuration');
      })
      .finally(() => setLoading(false));
  }, []);

  const hasChanges =
    config !== null &&
    (selectedMode !== config.mode ||
      (selectedMode === 'app' &&
        (appId.trim() !== (config.appId ?? '') ||
          installationId.trim() !== (config.installationId ?? '') ||
          privateKey.trim() !== '')));

  const handleSave = async () => {
    if (!config) return;
    setSaving(true);
    setSaveResult(null);
    setErrorMessage(null);
    setInstallationAccount(null);
    try {
      const update: GitHubAdminConfigUpdate = {};
      if (selectedMode !== config.mode) update.mode = selectedMode;
      if (selectedMode === 'app') {
        if (appId.trim() !== (config.appId ?? '')) update.appId = appId.trim();
        if (installationId.trim() !== (config.installationId ?? ''))
          update.installationId = installationId.trim();
        if (privateKey.trim() !== '') update.privateKey = privateKey;
      }

      const fresh = await githubAdminService.updateConfig(update);
      setConfig(fresh);
      setSelectedMode(fresh.mode);
      setAppId(fresh.appId ?? '');
      setInstallationId(fresh.installationId ?? '');
      setPrivateKey('');
      if (fresh.installationAccount) setInstallationAccount(fresh.installationAccount);
      setSaveResult('saved');
    } catch (err) {
      setSaveResult('error');
      const body = (err as { body?: { error?: string } })?.body;
      setErrorMessage(
        body?.error || (err instanceof Error ? err.message : 'Failed to save configuration'),
      );
    } finally {
      setSaving(false);
      setTimeout(() => setSaveResult((prev) => (prev === 'saved' ? null : prev)), 4000);
    }
  };

  return (
    <SettingsCard
      icon={<GitHubIcon />}
      title="GitHub"
      badge={
        config && (
          <ConfigStatusBadge
            ok={config.mode === 'oauth' ? oauthConfigured : config.appConfigured}
            okLabel={config.mode === 'app' ? 'App mode' : 'OAuth mode'}
            notOkLabel={config.mode === 'app' ? 'App mode · setup needed' : 'Setup needed'}
            notOkTone="warning"
          />
        )
      }
      description="Controls how the platform talks to GitHub — repos, PRs and issues."
    >
      {loading ? (
        <div className="space-y-3">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      ) : loadError ? (
        <p className="text-xs text-destructive">{loadError}</p>
      ) : (
        <div className="space-y-5">
          {/* Mode selector */}
          <div className="grid gap-3 sm:grid-cols-2">
            {MODE_OPTIONS.map((opt) => {
              const selected = selectedMode === opt.value;
              const Icon = opt.icon;
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setSelectedMode(opt.value)}
                  className={cn(
                    'relative rounded-xl border p-3.5 text-left transition-all',
                    selected
                      ? 'border-primary/60 bg-primary/[0.04] shadow-sm ring-1 ring-primary/40'
                      : 'border-border hover:border-primary/25 hover:bg-muted/40',
                  )}
                >
                  {selected && (
                    <CheckCircle2 className="absolute right-3 top-3 h-4 w-4 text-primary" />
                  )}
                  <Icon
                    className={cn('h-4 w-4', selected ? 'text-primary' : 'text-muted-foreground')}
                  />
                  <p className="mt-2 text-xs font-semibold text-foreground">{opt.title}</p>
                  <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                    {opt.description}
                  </p>
                </button>
              );
            })}
          </div>

          {/* OAuth-mode configuration — the shared GitHub OAuth app. */}
          {selectedMode === 'oauth' && (
            <div className="space-y-2.5">
              <div className="flex items-center gap-2">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  OAuth app
                </p>
                <ConfigStatusBadge ok={oauthConfigured} />
              </div>
              <p className="text-[11px] text-muted-foreground">
                One OAuth app covers repo access and the GitHub Issues tracker.
              </p>
              <OAuthAppConfigForm
                providerId="github-issues"
                configured={oauthConfigured}
                onSaved={onOAuthSaved}
              />
            </div>
          )}

          {/* App-mode configuration — only relevant when App mode is selected. */}
          {selectedMode === 'app' && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  GitHub App
                </p>
                <ConfigStatusBadge ok={!!config?.appConfigured} />
              </div>
              <p className="text-[11px] text-muted-foreground">
                Create a GitHub App with Contents, Pull requests and Issues permissions, install it
                on your organization, then paste its details.
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="github-app-id" className="text-xs">
                    App ID
                  </Label>
                  <Input
                    id="github-app-id"
                    value={appId}
                    onChange={(e) => setAppId(e.target.value)}
                    placeholder="e.g. 123456"
                    className="font-mono text-sm h-9"
                    autoComplete="off"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="github-installation-id" className="text-xs">
                    Installation ID
                  </Label>
                  <Input
                    id="github-installation-id"
                    value={installationId}
                    onChange={(e) => setInstallationId(e.target.value)}
                    placeholder="e.g. 7654321"
                    className="font-mono text-sm h-9"
                    autoComplete="off"
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="github-app-private-key" className="text-xs flex items-center gap-2">
                  Private Key (PEM)
                  {config?.privateKeySet && <ConfigStatusBadge ok okLabel="Set" />}
                </Label>
                <textarea
                  id="github-app-private-key"
                  value={privateKey}
                  onChange={(e) => setPrivateKey(e.target.value)}
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
            </div>
          )}

          {/* Mode / App-config save. OAuth credentials save via their own form. */}
          {(selectedMode === 'app' || selectedMode !== config?.mode) && (
            <SaveStatusButton
              onClick={handleSave}
              disabled={!hasChanges}
              saving={saving}
              label={
                selectedMode !== config?.mode
                  ? selectedMode === 'app'
                    ? 'Save & switch to App mode'
                    : 'Switch to OAuth mode'
                  : 'Save GitHub App Settings'
              }
              result={saveResult}
              savedMessage={
                installationAccount
                  ? `Saved — installation verified (@${installationAccount})`
                  : 'Saved'
              }
              errorMessage={errorMessage}
            />
          )}
          {selectedMode === 'app' && config?.mode !== 'app' && (
            <p className="text-[11px] text-amber-600 dark:text-amber-400">
              The switch is validated live against GitHub before it takes effect. Users then no
              longer connect personal accounts; all git activity is attributed to the App.
            </p>
          )}
        </div>
      )}
    </SettingsCard>
  );
}
