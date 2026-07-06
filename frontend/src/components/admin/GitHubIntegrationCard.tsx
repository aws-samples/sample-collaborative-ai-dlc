// Admin "GitHub Integration" card — the platform-wide GitHub auth mode switch
// (OAuth vs GitHub App) plus the GitHub App configuration (App ID,
// Installation ID, private key). Backed by GET/PUT /github/admin/config
// (platform-admin gated; switching to App mode is validated with a live
// installation probe before it takes effect).

import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { CheckCircle2, XCircle, Loader2, Github } from 'lucide-react';
import {
  githubAdminService,
  type GitHubAdminConfig,
  type GitHubAdminConfigUpdate,
  type GitHubAuthMode,
} from '@/services/gitProvider';
import { cn } from '@/lib/utils';

const MODE_OPTIONS: { value: GitHubAuthMode; title: string; description: string }[] = [
  {
    value: 'oauth',
    title: 'OAuth (user accounts)',
    description:
      'Each user connects their own GitHub account. Commits, PRs and comments are attributed to the user who started the work.',
  },
  {
    value: 'app',
    title: 'GitHub App (bot)',
    description:
      'The platform authenticates as a GitHub App installation. No per-user connection needed; all activity is attributed to the App.',
  },
];

export function GitHubIntegrationCard() {
  const [config, setConfig] = useState<GitHubAdminConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [selectedMode, setSelectedMode] = useState<GitHubAuthMode>('oauth');
  const [appId, setAppId] = useState('');
  const [installationId, setInstallationId] = useState('');
  const [privateKey, setPrivateKey] = useState('');

  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<'saved' | 'error' | null>(null);
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
      appId.trim() !== (config.appId ?? '') ||
      installationId.trim() !== (config.installationId ?? '') ||
      privateKey.trim() !== '');

  const handleSave = async () => {
    if (!config) return;
    setSaving(true);
    setSaveResult(null);
    setErrorMessage(null);
    setInstallationAccount(null);
    try {
      const update: GitHubAdminConfigUpdate = {};
      if (selectedMode !== config.mode) update.mode = selectedMode;
      if (appId.trim() !== (config.appId ?? '')) update.appId = appId.trim();
      if (installationId.trim() !== (config.installationId ?? ''))
        update.installationId = installationId.trim();
      if (privateKey.trim() !== '') update.privateKey = privateKey;

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
    <Card>
      <CardHeader className="pb-3 pt-5 px-5">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Github className="h-4 w-4 text-muted-foreground" />
          GitHub Integration
          {config &&
            (config.mode === 'app' ? (
              <span className="inline-flex items-center gap-1 text-[10px] text-agent-success font-normal">
                <CheckCircle2 className="h-3 w-3" /> GitHub App mode
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground font-normal">
                OAuth mode
              </span>
            ))}
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Platform-wide authentication mode for all GitHub operations (repo browsing, clone/push,
          PRs, issues). Switching takes effect immediately for new work; in-flight runs finish under
          the mode they started with.
        </p>
      </CardHeader>
      <CardContent className="px-5 pb-5 space-y-4">
        {loading ? (
          <div className="space-y-3">
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-9 w-full" />
          </div>
        ) : loadError ? (
          <p className="text-xs text-destructive">{loadError}</p>
        ) : (
          <>
            {/* Mode selector */}
            <div className="grid gap-3 sm:grid-cols-2">
              {MODE_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setSelectedMode(opt.value)}
                  className={cn(
                    'text-left border rounded-md p-3 transition-colors',
                    selectedMode === opt.value
                      ? 'border-primary bg-primary/5'
                      : 'border-border hover:bg-muted/40',
                  )}
                >
                  <p className="text-xs font-medium text-foreground">{opt.title}</p>
                  <p className="text-[11px] text-muted-foreground mt-1">{opt.description}</p>
                </button>
              ))}
            </div>

            {/* GitHub App configuration */}
            <div className="space-y-3 border rounded-md p-3 bg-muted/20">
              <div className="flex items-center gap-2">
                <p className="text-xs font-medium text-foreground">GitHub App configuration</p>
                {config?.appConfigured ? (
                  <span className="inline-flex items-center gap-1 text-[10px] text-agent-success">
                    <CheckCircle2 className="h-3 w-3" /> Configured
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
                    <XCircle className="h-3 w-3" /> Not configured
                  </span>
                )}
              </div>
              <p className="text-[11px] text-muted-foreground">
                Create a GitHub App (with Contents, Pull requests and Issues permissions), install
                it on the organization/repos this platform should access, then paste its details
                here. Required before switching to GitHub App mode.
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
                  {config?.privateKeySet && (
                    <span className="inline-flex items-center gap-1 text-[10px] text-agent-success font-normal">
                      <CheckCircle2 className="h-3 w-3" /> Set
                    </span>
                  )}
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

            {/* Save */}
            <div className="flex items-center gap-3 pt-1">
              <Button
                size="sm"
                onClick={handleSave}
                disabled={saving || !hasChanges}
                className="gap-1.5"
              >
                {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {saving ? 'Saving…' : 'Save GitHub Settings'}
              </Button>
              {saveResult === 'saved' && (
                <span className="text-xs text-agent-success flex items-center gap-1">
                  <CheckCircle2 className="h-3.5 w-3.5" /> Saved
                  {installationAccount ? ` — installation verified (@${installationAccount})` : ''}
                </span>
              )}
              {saveResult === 'error' && (
                <span className="text-xs text-destructive flex items-center gap-1">
                  <XCircle className="h-3.5 w-3.5" /> {errorMessage || 'Failed to save'}
                </span>
              )}
            </div>
            {selectedMode === 'app' && config?.mode !== 'app' && (
              <p className="text-[11px] text-amber-700 dark:text-amber-400">
                Switching to GitHub App mode is validated live against GitHub before it takes
                effect. Afterwards, users no longer connect personal accounts and all git activity
                is attributed to the App.
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
