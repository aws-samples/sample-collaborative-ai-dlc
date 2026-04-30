import { useEffect, useState, useCallback } from 'react';
import { agentsService, type PoolWorker, type PoolStatus, type AgentSettings } from '@/services/agents';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import {
  RefreshCw, Flame, Recycle, Skull,
  Server, Activity, Clock, AlertTriangle,
  CircleDot, Loader2, CheckCircle2, XCircle, Settings,
} from 'lucide-react';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const STATUS_CONFIG: Record<string, {
  label: string;
  className: string;
  dotClassName: string;
  rowClassName: string;
}> = {
  idle: {
    label: 'Idle',
    className: 'bg-agent-success/15 text-agent-success border-agent-success/30',
    dotClassName: 'bg-agent-success',
    rowClassName: '',
  },
  busy: {
    label: 'Busy',
    className: 'bg-agent-warning/15 text-agent-warning border-agent-warning/30',
    dotClassName: 'bg-agent-warning',
    rowClassName: '',
  },
  assigned: {
    label: 'Assigned',
    className: 'bg-agent-running/15 text-agent-running border-agent-running/30',
    dotClassName: 'bg-agent-running',
    rowClassName: '',
  },
  starting: {
    label: 'Starting',
    className: 'bg-muted text-muted-foreground border-border',
    dotClassName: 'bg-muted-foreground',
    rowClassName: '',
  },
  draining: {
    label: 'Draining',
    className: 'bg-agent-error/15 text-agent-error border-agent-error/30',
    dotClassName: 'bg-agent-error',
    rowClassName: '',
  },
};

// Per-CLI badge styles shown next to the job type in the worker table
const CLI_BADGE_CONFIG: Record<string, { label: string; className: string }> = {
  kiro:     { label: 'kiro',      className: 'bg-amber-100 text-amber-700 border-amber-200' },
  claude:   { label: 'claude',    className: 'bg-violet-100 text-violet-700 border-violet-200' },
  opencode: { label: 'opencode',  className: 'bg-teal-100 text-teal-700 border-teal-200' },
};

function timeAgo(ts?: number) {
  if (!ts) return '\u2014';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function Admin() {
  const [pool, setPool] = useState<PoolStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState<string | null>(null);
  const [warmCount, setWarmCount] = useState(5);

  // Agent settings
  const [settings, setSettings] = useState<AgentSettings | null>(null);
  const [settingsLoading, setSettingsLoading] = useState(true);
  const [bearerToken, setBearerToken] = useState('');
  const [kiroApiKey, setKiroApiKey] = useState('');
  const [mcpServers, setMcpServers] = useState('[]');
  const [mcpError, setMcpError] = useState('');
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsSaveResult, setSettingsSaveResult] = useState<'saved' | 'error' | null>(null);

  const refresh = useCallback(async () => {
    try {
      setPool(await agentsService.getPool());
    } catch (e) {
      console.error('Failed to load pool:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, [refresh]);

  useEffect(() => {
    agentsService.getSettings()
      .then(s => {
        setSettings(s);
        setMcpServers(s.mcpServers);
      })
      .catch(e => console.error('Failed to load settings:', e))
      .finally(() => setSettingsLoading(false));
  }, []);

  const saveSettings = async () => {
    // Validate MCP JSON before sending
    try {
      JSON.parse(mcpServers);
      setMcpError('');
    } catch {
      setMcpError('Invalid JSON — fix the syntax before saving');
      return;
    }
    setSettingsSaving(true);
    setSettingsSaveResult(null);
    try {
      const update: { bedrockBearerToken?: string; kiroApiKey?: string; mcpServers?: string } = {
        mcpServers,
      };
      // Only send secret fields if the user typed something
      if (bearerToken !== '') update.bedrockBearerToken = bearerToken;
      if (kiroApiKey !== '') update.kiroApiKey = kiroApiKey;
      await agentsService.updateSettings(update);
      setSettingsSaveResult('saved');
      // Reload to get fresh flags; clear the secret inputs
      const fresh = await agentsService.getSettings();
      setSettings(fresh);
      setMcpServers(fresh.mcpServers);
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

  const act = async (label: string, fn: () => Promise<unknown>) => {
    setActing(label);
    try {
      await fn();
      await refresh();
    } catch (e) {
      console.error(e);
    } finally {
      setActing(null);
    }
  };

  const workers = pool?.workers || [];
  const currentVersion = pool?.currentVersion || '\u2014';
  const idle = workers.filter(w => w.status === 'idle');
  const busy = workers.filter(w => w.status === 'busy' || w.status === 'assigned');
  const stale = workers.filter(w => w.version !== pool?.currentVersion);

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-6xl mx-auto p-6 space-y-6">
        {/* Header */}
        <div>
          <h1 className="text-xl font-bold tracking-tight">Agent Pool</h1>
          <p className="text-sm text-muted-foreground">
            Manage worker pool, recycle stale instances, and monitor health
          </p>
        </div>

        {/* Summary cards */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
          <SummaryCard
            label="Total Workers"
            value={loading ? null : workers.length}
            icon={<Server className="h-3.5 w-3.5" />}
          />
          <SummaryCard
            label="Idle"
            value={loading ? null : idle.length}
            icon={<CircleDot className="h-3.5 w-3.5" />}
            valueClassName="text-agent-success"
          />
          <SummaryCard
            label="Busy"
            value={loading ? null : busy.length}
            icon={<Activity className="h-3.5 w-3.5" />}
            valueClassName="text-agent-warning"
          />
          <SummaryCard
            label="Stale Version"
            value={loading ? null : stale.length}
            icon={<AlertTriangle className="h-3.5 w-3.5" />}
            valueClassName={stale.length ? 'text-agent-error' : 'text-muted-foreground/40'}
          />
          <SummaryCard
            label="Current Version"
            value={loading ? null : currentVersion}
            icon={<Clock className="h-3.5 w-3.5" />}
            small
          />
        </div>

        {/* Actions bar */}
        <Card>
          <CardContent className="p-3 flex flex-wrap items-center gap-3">
            <Button
              variant="destructive"
              size="sm"
              className="gap-1.5"
              onClick={() => act('recycle', () => agentsService.recyclePool())}
              disabled={!!acting}
            >
              {acting === 'recycle' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Recycle className="h-3.5 w-3.5" />
              )}
              {acting === 'recycle' ? 'Recycling\u2026' : 'Recycle Pool'}
            </Button>

            <div className="flex items-center gap-2">
              <Input
                type="number"
                min={1}
                max={10}
                value={warmCount}
                onChange={e => setWarmCount(Number(e.target.value))}
                className="w-16 h-8 text-sm"
              />
              <Button
                size="sm"
                className="gap-1.5 bg-agent-success hover:bg-agent-success/90 text-white"
                onClick={() => act('warm', () => agentsService.warmPool(warmCount))}
                disabled={!!acting}
              >
                {acting === 'warm' ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Flame className="h-3.5 w-3.5" />
                )}
                {acting === 'warm' ? 'Warming\u2026' : 'Warm Pool'}
              </Button>
            </div>

            <Button
              variant="outline"
              size="sm"
              className="gap-1.5 ml-auto"
              onClick={refresh}
              disabled={!!acting}
            >
              <RefreshCw className={cn('h-3.5 w-3.5', acting && 'animate-spin')} />
              Refresh
            </Button>
          </CardContent>
        </Card>

        {/* Workers table */}
        {loading ? (
          <Card>
            <CardContent className="p-4 space-y-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="flex items-center gap-4">
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-5 w-16 rounded-full" />
                  <Skeleton className="h-4 w-20" />
                  <Skeleton className="h-4 flex-1" />
                  <Skeleton className="h-4 w-16" />
                  <Skeleton className="h-7 w-14" />
                </div>
              ))}
            </CardContent>
          </Card>
        ) : workers.length === 0 ? (
          <Card className="border-dashed">
            <CardContent className="flex flex-col items-center justify-center py-16 gap-4">
              <Server className="h-10 w-10 text-muted-foreground/30" />
              <div className="text-center">
                <p className="text-sm font-medium">No workers in the pool</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Warm up some workers to get started
                </p>
              </div>
              <Button
                size="sm"
                className="gap-1.5 bg-agent-success hover:bg-agent-success/90 text-white"
                onClick={() => act('warm', () => agentsService.warmPool(5))}
                disabled={!!acting}
              >
                <Flame className="h-3.5 w-3.5" /> Warm Up 5 Workers
              </Button>
            </CardContent>
          </Card>
        ) : (
          <Card className="overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                      Worker
                    </th>
                    <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                      Status
                    </th>
                    <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                      Version
                    </th>
                    <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                      Current Job
                    </th>
                    <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                      Heartbeat
                    </th>
                    <th className="px-4 py-2.5 text-right text-xs font-medium text-muted-foreground uppercase tracking-wider">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {workers.map(w => (
                    <WorkerRow
                      key={w.workerId}
                      worker={w}
                      currentVersion={pool?.currentVersion || ''}
                      acting={acting}
                      onKill={() =>
                        act(`kill-${w.workerId}`, () =>
                          agentsService.killWorker(w.workerId),
                        )
                      }
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}

        {/* Agent Settings */}
        <Card>
          <CardHeader className="pb-3 pt-5 px-5">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Settings className="h-4 w-4 text-muted-foreground" />
              Agent Settings
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              Stored in AWS SSM Parameter Store. Changes take effect on the next agent container startup.
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
                  <label className="text-xs font-medium text-foreground flex items-center gap-2">
                    Bedrock Bearer Token
                    {settings?.bedrockBearerTokenSet ? (
                      <span className="inline-flex items-center gap-1 text-[10px] text-agent-success font-normal">
                        <CheckCircle2 className="h-3 w-3" /> Set
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground font-normal">
                        <XCircle className="h-3 w-3" /> Not set — using IAM role
                      </span>
                    )}
                  </label>
                  <Input
                    type="password"
                    placeholder={settings?.bedrockBearerTokenSet ? 'Enter new token to rotate, or leave blank' : 'Enter AWS_BEARER_TOKEN_BEDROCK value'}
                    value={bearerToken}
                    onChange={e => setBearerToken(e.target.value)}
                    className="font-mono text-sm h-9"
                    autoComplete="off"
                  />
                  <p className="text-[11px] text-muted-foreground">
                    Optional. When set, agents use this as <code className="bg-muted px-1 rounded text-[10px]">AWS_BEARER_TOKEN_BEDROCK</code> instead of the ECS task IAM role. Clear by saving an empty value.
                  </p>
                </div>

                {/* Kiro API Key */}
                <div className="space-y-1.5">
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
                  <Input
                    type="password"
                    placeholder={settings?.kiroApiKeySet ? 'Enter new key to rotate, or leave blank' : 'Enter KIRO_API_KEY value'}
                    value={kiroApiKey}
                    onChange={e => setKiroApiKey(e.target.value)}
                    className="font-mono text-sm h-9"
                    autoComplete="off"
                  />
                  <p className="text-[11px] text-muted-foreground">
                    Required for Kiro CLI. Obtain from your Kiro account settings. Clear by saving an empty value.
                  </p>
                </div>

                {/* Extra MCP Servers */}
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-foreground">
                    Extra MCP Servers
                  </label>
                  <Textarea
                    value={mcpServers}
                    onChange={e => {
                      setMcpServers(e.target.value);
                      setMcpError('');
                    }}
                    className={cn(
                      'font-mono text-xs min-h-[140px] resize-y',
                      mcpError && 'border-destructive focus-visible:ring-destructive',
                    )}
                    spellCheck={false}
                  />
                  {mcpError ? (
                    <p className="text-[11px] text-destructive flex items-center gap-1">
                      <XCircle className="h-3 w-3 shrink-0" /> {mcpError}
                    </p>
                  ) : (
                    <p className="text-[11px] text-muted-foreground">
                      JSON array of MCP server definitions injected into every agent session. Example:
                      {' '}<code className="bg-muted px-1 rounded text-[10px]">{'[{"name":"my-tool","command":"npx","args":["-y","my-mcp-server"]}]'}</code>
                    </p>
                  )}
                </div>

                {/* Save */}
                <div className="flex items-center gap-3 pt-1">
                  <Button
                    size="sm"
                    onClick={saveSettings}
                    disabled={settingsSaving}
                    className="gap-1.5"
                  >
                    {settingsSaving ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : null}
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
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Summary card
// ---------------------------------------------------------------------------

function SummaryCard({
  label,
  value,
  icon,
  valueClassName,
  small,
}: {
  label: string;
  value: string | number | null;
  icon: React.ReactNode;
  valueClassName?: string;
  small?: boolean;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center gap-1.5 text-muted-foreground mb-1.5">
          {icon}
          <span className="text-[10px] uppercase font-medium tracking-wider">{label}</span>
        </div>
        {value === null ? (
          <Skeleton className={small ? 'h-4 w-20' : 'h-7 w-12'} />
        ) : (
          <div
            className={cn(
              small ? 'text-xs font-mono truncate' : 'text-2xl font-bold tabular-nums',
              valueClassName || 'text-foreground',
            )}
          >
            {value}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Worker row
// ---------------------------------------------------------------------------

function WorkerRow({
  worker: w,
  currentVersion,
  acting,
  onKill,
}: {
  worker: PoolWorker;
  currentVersion: string;
  acting: string | null;
  onKill: () => void;
}) {
  const isStale = w.version !== currentVersion;
  const cfg = STATUS_CONFIG[w.status] || STATUS_CONFIG.starting;

  return (
    <tr
      className={cn(
        'group transition-colors hover:bg-muted/50',
        isStale && 'bg-agent-error/5',
        cfg.rowClassName,
      )}
    >
      {/* Worker ID */}
      <td className="px-4 py-2.5">
        <span className="font-mono text-xs truncate block max-w-[180px]" title={w.taskArn || w.workerId}>
          {w.workerId}
        </span>
        {w.taskArn && (
          <span className="text-[10px] text-muted-foreground/60 font-mono block truncate max-w-[180px]" title={w.taskArn}>
            ECS: {w.taskArn.split('/').pop()}
          </span>
        )}
      </td>

      {/* Status */}
      <td className="px-4 py-2.5">
        <Badge variant="outline" className={cn('text-[10px] h-5 gap-1', cfg.className)}>
          <span className={cn('h-1.5 w-1.5 rounded-full', cfg.dotClassName)} />
          {cfg.label}
        </Badge>
      </td>

      {/* Version */}
      <td className="px-4 py-2.5">
        <span className={cn('text-xs font-mono', isStale ? 'text-agent-error' : 'text-agent-success')}>
          {w.version}
        </span>
        {isStale && (
          <Badge variant="outline" className="ml-1.5 text-[9px] h-4 px-1 border-agent-error/30 text-agent-error bg-agent-error/10">
            stale
          </Badge>
        )}
      </td>

      {/* Current Job */}
      <td className="px-4 py-2.5 text-xs text-muted-foreground">
        {w.job ? (
          <span className="inline-flex items-center gap-1 font-mono text-[11px]">
            {/* CLI badges — one per available CLI */}
            {(w.availableClis?.length ? w.availableClis : [w.agentCli || 'kiro']).map(cli => {
              const cliBadge = CLI_BADGE_CONFIG[cli] || { label: cli, className: 'bg-gray-100 text-gray-600 border-gray-200' };
              return (
                <span key={cli} className={cn('text-[9px] px-1.5 py-0.5 rounded border font-sans font-medium', cliBadge.className)}>
                  {cliBadge.label}
                </span>
              );
            })}
            {w.job.agentType}
            <span className="text-muted-foreground/50 mx-0.5">&middot;</span>
            {w.job.projectId.slice(0, 12)}&hellip;
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 flex-wrap">
            {/* Show available CLIs */}
            {(w.availableClis || []).map(cli => {
              const cliBadge = CLI_BADGE_CONFIG[cli] || { label: cli, className: 'bg-gray-100 text-gray-600 border-gray-200' };
              return (
                <span key={cli} className={cn('text-[9px] px-1.5 py-0.5 rounded border font-sans font-medium', cliBadge.className)}>
                  {cliBadge.label}
                </span>
              );
            })}
            {/* Show CLIs that failed to authenticate on this worker, with
                the error message on hover so admins can see the real cause. */}
            {Object.entries(w.cliAuthErrors || {}).map(([cli, errMsg]) => {
              const cliBadge = CLI_BADGE_CONFIG[cli as keyof typeof CLI_BADGE_CONFIG] || { label: cli };
              return (
                <span
                  key={`err-${cli}`}
                  title={errMsg as string}
                  className="text-[9px] px-1.5 py-0.5 rounded border font-sans font-medium bg-agent-error/10 text-agent-error border-agent-error/30 cursor-help"
                >
                  {cliBadge.label} &middot; auth failed
                </span>
              );
            })}
            {!w.availableClis?.length && !Object.keys(w.cliAuthErrors || {}).length && (
              <span className="text-muted-foreground/40">&mdash;</span>
            )}
          </span>
        )}
      </td>

      {/* Heartbeat */}
      <td className="px-4 py-2.5 text-xs text-muted-foreground">
        {timeAgo(w.lastHeartbeat)}
      </td>

      {/* Actions */}
      <td className="px-4 py-2.5 text-right">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-agent-error hover:text-agent-error hover:bg-agent-error/10 opacity-0 group-hover:opacity-100 transition-opacity"
          onClick={onKill}
          disabled={acting === `kill-${w.workerId}`}
        >
          {acting === `kill-${w.workerId}` ? (
            <Loader2 className="h-3 w-3 animate-spin mr-1" />
          ) : (
            <Skull className="h-3 w-3 mr-1" />
          )}
          <span className="text-xs">Kill</span>
        </Button>
      </td>
    </tr>
  );
}
