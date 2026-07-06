import { useEffect, useState, useCallback } from 'react';
import { agentsService, type AgentSettings } from '@/services/agents';
import type { CliModels, RuntimeModelCli } from '@/services/projects';
import { trackersService, type TrackerProviderStatus } from '@/services/trackers';
import { OAuthProviderCard } from '@/components/admin/OAuthProviderCard';
import { TrackerMigrationCard } from '@/components/admin/TrackerMigrationCard';
import { GitHubIntegrationCard } from '@/components/admin/GitHubIntegrationCard';
import { UserManagementCard } from '@/components/admin/UserManagementCard';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Loader2, CheckCircle2, XCircle, Settings, Plug, ExternalLink } from 'lucide-react';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const MODEL_CLI_LABELS: Record<RuntimeModelCli, string> = {
  kiro: 'Kiro',
  claude: 'Claude',
  opencode: 'OpenCode',
};

const MODEL_CLI_KEYS = Object.keys(MODEL_CLI_LABELS) as RuntimeModelCli[];

const MODEL_ID_HELP: Record<RuntimeModelCli, { label: string; url: string }> = {
  kiro: {
    label: 'Kiro model IDs',
    url: 'https://kiro.dev/docs/',
  },
  claude: {
    label: 'Bedrock model IDs',
    url: 'https://docs.aws.amazon.com/bedrock/latest/userguide/models-supported.html',
  },
  opencode: {
    label: 'Bedrock model IDs',
    url: 'https://docs.aws.amazon.com/bedrock/latest/userguide/models-supported.html',
  },
};

function canonicalCliModels(models: CliModels = {}) {
  return MODEL_CLI_KEYS.reduce<CliModels>((acc, cli) => {
    const value = models[cli]?.trim();
    if (value) acc[cli] = value;
    return acc;
  }, {});
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function Admin() {
  // Tracker OAuth-app config (one entry per supported provider)
  const [trackerProviders, setTrackerProviders] = useState<TrackerProviderStatus[]>([]);
  const [trackerProvidersLoading, setTrackerProvidersLoading] = useState(true);

  // Agent settings
  const [settings, setSettings] = useState<AgentSettings | null>(null);
  const [settingsLoading, setSettingsLoading] = useState(true);
  const [bearerToken, setBearerToken] = useState('');
  const [kiroApiKey, setKiroApiKey] = useState('');
  const [cliModels, setCliModels] = useState<CliModels>({});
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [clearingSecret, setClearingSecret] = useState<'bedrockBearerToken' | 'kiroApiKey' | null>(
    null,
  );
  const [settingsSaveResult, setSettingsSaveResult] = useState<'saved' | 'error' | null>(null);
  const cliModelsChanged =
    JSON.stringify(canonicalCliModels(cliModels)) !==
    JSON.stringify(canonicalCliModels(settings?.cliModels || {}));
  const hasSettingsChanges = bearerToken !== '' || kiroApiKey !== '' || cliModelsChanged;

  useEffect(() => {
    agentsService
      .getSettings()
      .then((s) => {
        setSettings(s);
        setCliModels(s.cliModels || {});
      })
      .catch((e) => console.error('Failed to load settings:', e))
      .finally(() => setSettingsLoading(false));
  }, []);

  const loadTrackerProviders = useCallback(async () => {
    try {
      const list = await trackersService.listProviders();
      setTrackerProviders(list);
    } catch (e) {
      console.error('Failed to load tracker providers:', e);
    } finally {
      setTrackerProvidersLoading(false);
    }
  }, []);

  useEffect(() => {
    loadTrackerProviders();
  }, [loadTrackerProviders]);

  const saveSettings = async () => {
    setSettingsSaving(true);
    setSettingsSaveResult(null);
    try {
      const update: {
        bedrockBearerToken?: string;
        kiroApiKey?: string;
        cliModels: CliModels;
      } = {
        cliModels,
      };
      // Only send secret fields if the user typed something
      if (bearerToken !== '') update.bedrockBearerToken = bearerToken;
      if (kiroApiKey !== '') update.kiroApiKey = kiroApiKey;
      await agentsService.updateSettings(update);
      setSettingsSaveResult('saved');
      // Reload to get fresh flags; clear the secret inputs
      const fresh = await agentsService.getSettings();
      setSettings(fresh);
      setCliModels(fresh.cliModels || {});
      setBearerToken('');
      setKiroApiKey('');
    } catch (e) {
      console.error('Failed to save settings:', e);
      setSettingsSaveResult('error');
    } finally {
      setSettingsSaving(false);
      setTimeout(() => setSettingsSaveResult(null), 4000);
    }
  };

  // Clear a stored secret by sending an empty string; the backend resets the
  // SSM parameter to its "placeholder" sentinel (treated as not configured).
  const clearSecret = async (field: 'bedrockBearerToken' | 'kiroApiKey') => {
    setClearingSecret(field);
    setSettingsSaveResult(null);
    try {
      await agentsService.updateSettings({ [field]: '' });
      const fresh = await agentsService.getSettings();
      setSettings(fresh);
      setCliModels(fresh.cliModels || {});
      if (field === 'bedrockBearerToken') setBearerToken('');
      else setKiroApiKey('');
      setSettingsSaveResult('saved');
    } catch (e) {
      console.error('Failed to clear secret:', e);
      setSettingsSaveResult('error');
    } finally {
      setClearingSecret(null);
      setTimeout(() => setSettingsSaveResult(null), 4000);
    }
  };

  const updateCliModel = (cli: RuntimeModelCli, value: string) => {
    setCliModels((current) => ({ ...current, [cli]: value }));
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-6xl mx-auto p-6 space-y-6">
        {/* Header */}
        <div>
          <h1 className="text-xl font-bold tracking-tight">Admin</h1>
          <p className="text-sm text-muted-foreground">
            Manage users, agent settings, integrations, and data migrations
          </p>
        </div>

        {/* User management — grant/revoke the platform-admin role. */}
        <UserManagementCard />

        {/* Agent Settings */}
        <Card>
          <CardHeader className="pb-3 pt-5 px-5">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Settings className="h-4 w-4 text-muted-foreground" />
              Agent Settings
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              Stored in AWS SSM Parameter Store. Changes take effect on the next agent container
              startup.
            </p>
          </CardHeader>
          <CardContent className="px-5 pb-5 space-y-5">
            {settingsLoading ? (
              <div className="space-y-3">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-9 w-full" />
                <Skeleton className="h-4 w-40 mt-4" />
                <Skeleton className="h-28 w-full" />
              </div>
            ) : (
              <>
                {/* Bedrock Bearer Token */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <label className="text-xs font-medium text-foreground flex items-center gap-2">
                      Bedrock Bearer Token
                      {settings?.bedrockBearerTokenSet ? (
                        <span className="inline-flex items-center gap-1 text-[10px] text-agent-success font-normal">
                          <CheckCircle2 className="h-3 w-3" /> Set
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground font-normal">
                          <XCircle className="h-3 w-3" /> Not set — Claude/OpenCode agents won't
                          start
                        </span>
                      )}
                    </label>
                    {settings?.bedrockBearerTokenSet && (
                      <button
                        type="button"
                        onClick={() => clearSecret('bedrockBearerToken')}
                        disabled={clearingSecret !== null || settingsSaving}
                        className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-destructive disabled:opacity-50"
                      >
                        {clearingSecret === 'bedrockBearerToken' ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <XCircle className="h-3 w-3" />
                        )}
                        Clear
                      </button>
                    )}
                  </div>
                  <Input
                    type="password"
                    placeholder={
                      settings?.bedrockBearerTokenSet
                        ? 'Enter new token to rotate, or leave blank'
                        : 'Enter AWS_BEARER_TOKEN_BEDROCK value'
                    }
                    value={bearerToken}
                    onChange={(e) => setBearerToken(e.target.value)}
                    className="font-mono text-sm h-9"
                    autoComplete="off"
                  />
                  <p className="text-[11px] text-muted-foreground">
                    Required for Claude Code and OpenCode agents. Agents use this as{' '}
                    <code className="bg-muted px-1 rounded text-[10px]">
                      AWS_BEARER_TOKEN_BEDROCK
                    </code>{' '}
                    to authenticate to Bedrock. Use Clear to remove a stored token.
                  </p>
                </div>

                {/* Kiro API Key */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <label className="text-xs font-medium text-foreground flex items-center gap-2">
                      Kiro API Key
                      {settings?.kiroApiKeySet ? (
                        <span className="inline-flex items-center gap-1 text-[10px] text-agent-success font-normal">
                          <CheckCircle2 className="h-3 w-3" /> Set
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground font-normal">
                          <XCircle className="h-3 w-3" /> Not set
                        </span>
                      )}
                    </label>
                    {settings?.kiroApiKeySet && (
                      <button
                        type="button"
                        onClick={() => clearSecret('kiroApiKey')}
                        disabled={clearingSecret !== null || settingsSaving}
                        className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-destructive disabled:opacity-50"
                      >
                        {clearingSecret === 'kiroApiKey' ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <XCircle className="h-3 w-3" />
                        )}
                        Clear
                      </button>
                    )}
                  </div>
                  <Input
                    type="password"
                    placeholder={
                      settings?.kiroApiKeySet
                        ? 'Enter new key to rotate, or leave blank'
                        : 'Enter KIRO_API_KEY value'
                    }
                    value={kiroApiKey}
                    onChange={(e) => setKiroApiKey(e.target.value)}
                    className="font-mono text-sm h-9"
                    autoComplete="off"
                  />
                  <p className="text-[11px] text-muted-foreground">
                    Required for Kiro CLI. Obtain from your Kiro account settings. Use Clear to
                    remove a stored key.
                  </p>
                </div>

                {/* Default Models */}
                <div className="space-y-3">
                  <div>
                    <label className="text-xs font-medium text-foreground">Default Models</label>
                    <p className="text-[11px] text-muted-foreground mt-0.5">
                      Used when a project does not set its own model override. Changes apply to new
                      agent runs.
                    </p>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {MODEL_CLI_KEYS.map((cli) => (
                      <div key={cli} className="space-y-1.5">
                        <div className="flex items-center justify-between gap-3">
                          <label className="text-xs font-medium text-muted-foreground">
                            {MODEL_CLI_LABELS[cli]}
                          </label>
                          <a
                            href={MODEL_ID_HELP[cli].url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                          >
                            {MODEL_ID_HELP[cli].label}
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        </div>
                        <Input
                          value={cliModels[cli] || ''}
                          onChange={(e) => updateCliModel(cli, e.target.value)}
                          placeholder={
                            cli === 'opencode'
                              ? 'amazon-bedrock/us.anthropic.claude-sonnet-4-6'
                              : cli === 'claude'
                                ? 'us.anthropic.claude-sonnet-4-6'
                                : 'Model ID'
                          }
                          className="font-mono text-sm h-9"
                        />
                      </div>
                    ))}
                  </div>
                </div>

                {/* Save */}
                <div className="flex items-center gap-3 pt-1">
                  <Button
                    size="sm"
                    onClick={saveSettings}
                    disabled={settingsSaving || !hasSettingsChanges}
                    className="gap-1.5"
                  >
                    {settingsSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                    {settingsSaving ? 'Saving\u2026' : 'Save Settings'}
                  </Button>
                  {settingsSaveResult === 'saved' && (
                    <span className="text-xs text-agent-success flex items-center gap-1">
                      <CheckCircle2 className="h-3.5 w-3.5" /> Saved
                    </span>
                  )}
                  {settingsSaveResult === 'error' && (
                    <span className="text-xs text-destructive flex items-center gap-1">
                      <XCircle className="h-3.5 w-3.5" /> Failed to save — check console
                    </span>
                  )}
                </div>
              </>
            )}
          </CardContent>
        </Card>

        {/* GitHub Integration — platform-wide auth mode (OAuth vs GitHub App)
            + GitHub App configuration. Admin-switchable at runtime; the
            backend live-probes the App installation before any flip to App
            mode can land. */}
        <GitHubIntegrationCard />

        {/* Tracker OAuth Apps — operator-facing OAuth credential editor.
            Replaces the per-provider `aws secretsmanager put-secret-value`
            CLI step from earlier docs. Per provider, an `OAuthProviderCard`
            shows configured status and accepts new client_id / client_secret
            pairs. Adding a new tracker provider is a backend-side change;
            this section just iterates whatever the API returns. */}
        <Card>
          <CardHeader className="pb-3 pt-5 px-5">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Plug className="h-4 w-4 text-muted-foreground" />
              Tracker OAuth Apps
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              Connect external tracker providers (Jira Cloud, GitHub Issues, GitLab Issues) by
              registering an OAuth app with each provider and pasting its credentials below. Users
              then connect their personal accounts from Project Settings → Trackers.
            </p>
          </CardHeader>
          <CardContent className="px-5 pb-5 space-y-4">
            {trackerProvidersLoading ? (
              <div className="space-y-3">
                <Skeleton className="h-24 w-full" />
                <Skeleton className="h-24 w-full" />
              </div>
            ) : trackerProviders.length === 0 ? (
              <p className="text-xs text-muted-foreground">No tracker providers available.</p>
            ) : (
              trackerProviders.map((p) => (
                <OAuthProviderCard
                  key={p.id}
                  providerId={p.id}
                  label={p.label}
                  configured={p.configured}
                  onSaved={loadTrackerProviders}
                />
              ))
            )}
          </CardContent>
        </Card>

        {/* Tracker abstraction migration (#194 phase #198). UI counterpart
            of the migrate-tracker-fields Lambda. Legacy data + tooling stay
            deployed permanently — this card just makes the migration
            actionable from the UI for installs without shell access. */}
        <TrackerMigrationCard />
      </div>
    </div>
  );
}
