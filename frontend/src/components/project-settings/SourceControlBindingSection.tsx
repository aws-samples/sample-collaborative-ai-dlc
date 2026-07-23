import { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  GitBranch,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Unplug,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SettingsCard } from '@/components/settings/SettingsCard';
import { GitConnectButton } from '@/components/GitConnectButton';
import { useGitProviderStatus } from '@/hooks/useGitProviderStatus';
import type { GitProvider } from '@/services/gitProvider';
import type { Project } from '@/services/projects';
import {
  SOURCE_CONTROL_AUTH_OPTIONS,
  sourceControlService,
  type ProjectSourceControlStatus,
  type SourceControlAuthType,
  type SourceControlProviderSelection,
} from '@/services/sourceControl';

interface Props {
  project: Project;
  canEdit: boolean;
}

const AUTH_TYPE_LABELS: Record<SourceControlAuthType, string> = {
  'github-app': 'GitHub App',
  'github-oauth': 'Delegated GitHub OAuth',
  'gitlab-oauth': 'Delegated GitLab OAuth',
  'bitbucket-oauth': 'Delegated Bitbucket OAuth',
};

const readableReason = (reason: string | null) =>
  reason ? reason.replaceAll('_', ' ').replace(/^\w/, (value) => value.toUpperCase()) : null;

function ProviderBindingControl({
  provider,
  authType,
  confirmed,
  disabled,
  onAuthTypeChange,
  onConfirmedChange,
}: {
  provider: GitProvider;
  authType: SourceControlAuthType;
  confirmed: boolean;
  disabled: boolean;
  onAuthTypeChange: (value: SourceControlAuthType) => void;
  onConfirmedChange: (value: boolean) => void;
}) {
  const { status, loading, error, refresh } = useGitProviderStatus(provider);
  const oauth = authType.endsWith('-oauth');

  return (
    <div className="space-y-3 border-t pt-3 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-16 text-xs font-semibold capitalize">{provider}</span>
        <Select
          value={authType}
          onValueChange={(value) => onAuthTypeChange(value as SourceControlAuthType)}
          disabled={disabled}
        >
          <SelectTrigger className="h-8 w-56 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SOURCE_CONTROL_AUTH_OPTIONS[provider].options.map((option) => (
              <SelectItem key={option} value={option}>
                {AUTH_TYPE_LABELS[option]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {oauth && !loading && (
          <Badge variant={status?.connected ? 'secondary' : 'outline'} className="text-[10px]">
            {status?.connected ? 'Identity connected' : 'Connection required'}
          </Badge>
        )}
      </div>

      {oauth && (
        <div className="ml-0 space-y-2 sm:ml-18">
          {error ? (
            <p className="text-xs text-destructive">{error}</p>
          ) : (
            <GitConnectButton
              provider={provider}
              connected={status?.connected ?? false}
              reauthorizationRequired={status?.reauthorizationRequired}
              missingScopes={status?.missingScopes}
              onDisconnect={refresh}
            />
          )}
          <label className="flex items-start gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => onConfirmedChange(event.target.checked)}
              disabled={disabled}
              className="mt-0.5 h-4 w-4"
            />
            Delegate my connected identity to all {provider} repositories in this space.
          </label>
        </div>
      )}
    </div>
  );
}

export function SourceControlBindingSection({ project, canEdit }: Props) {
  const [status, setStatus] = useState<ProjectSourceControlStatus | null>(null);
  const [authTypes, setAuthTypes] = useState<Partial<Record<GitProvider, SourceControlAuthType>>>(
    {},
  );
  const [confirmed, setConfirmed] = useState<Partial<Record<GitProvider, boolean>>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const providers = useMemo(
    () =>
      [
        ...new Set((project.repos ?? []).map((repo) => repo.provider || project.gitProvider)),
      ] as GitProvider[],
    [project.gitProvider, project.repos],
  );
  const repositoryKey = (project.repos ?? [])
    .map((repo) => `${repo.provider}:${repo.url}`)
    .toSorted()
    .join('|');

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await sourceControlService.getStatus(project.id);
      setStatus(next);
      setAuthTypes((current) => {
        const updated = { ...current };
        for (const provider of providers) {
          const existing = next.repositories.find(
            (repository) => repository.provider === provider && repository.authType,
          );
          updated[provider] =
            existing?.authType ?? SOURCE_CONTROL_AUTH_OPTIONS[provider].defaultAuthType;
        }
        return updated;
      });
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Failed to load source control');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // repositoryKey deliberately refreshes status after repository add/remove.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, repositoryKey]);

  const bind = async () => {
    const selections: SourceControlProviderSelection = {};
    for (const provider of providers) {
      const authType = authTypes[provider];
      if (!authType) return;
      if (authType.endsWith('-oauth') && !confirmed[provider]) {
        setError(`Confirm ${provider} OAuth delegation before binding.`);
        return;
      }
      selections[provider] = {
        authType,
        ...(authType.endsWith('-oauth') ? { confirmDelegation: true } : {}),
      };
    }
    setSaving(true);
    setError(null);
    try {
      setStatus(await sourceControlService.bind(project.id, selections));
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Failed to bind source control');
    } finally {
      setSaving(false);
    }
  };

  const unbind = async () => {
    setSaving(true);
    setError(null);
    try {
      await sourceControlService.unbind(project.id);
      await load();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'Failed to remove bindings');
    } finally {
      setSaving(false);
    }
  };

  const ready = status?.ready ?? providers.length === 0;

  return (
    <SettingsCard
      icon={<ShieldCheck />}
      title="Project source control"
      badge={
        <Badge variant={ready ? 'secondary' : 'destructive'} className="text-[10px]">
          {ready ? 'Ready' : 'Setup required'}
        </Badge>
      }
      description="Authentication delegated to this space for repository automation."
    >
      {loading ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking bindings...
        </p>
      ) : providers.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          This space has no repositories and does not require a source-control binding.
        </p>
      ) : (
        <div className="space-y-4">
          {!ready && (
            <p className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-300">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              Source control setup required. Starts remain blocked until every repository is
              verified.
            </p>
          )}

          <div className="divide-y rounded-md border">
            {(status?.repositories ?? []).map((repository) => (
              <div
                key={`${repository.provider}:${repository.repo}`}
                className="flex flex-wrap items-center gap-2 px-3 py-2.5 text-xs"
              >
                {repository.status === 'active' ? (
                  <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />
                ) : (
                  <AlertCircle className="h-3.5 w-3.5 text-amber-600" />
                )}
                <GitBranch className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate font-mono">{repository.repo}</span>
                <Badge variant="outline" className="text-[10px]">
                  {repository.authType ? AUTH_TYPE_LABELS[repository.authType] : 'Unbound'}
                </Badge>
                {repository.capabilities.repositoryWrite && (
                  <Badge variant="secondary" className="text-[10px]">
                    Write verified
                  </Badge>
                )}
                {repository.status === 'active' &&
                  repository.authType === 'github-app' &&
                  repository.capabilities.workflows !== 'write' && (
                    <span className="flex w-full items-start gap-1.5 pl-5 text-[11px] text-amber-700 dark:text-amber-300">
                      <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
                      The GitHub App installation does not grant Workflows read &amp; write — the
                      agent cannot create or modify files under .github/workflows/.
                    </span>
                  )}
                {(repository.delegatedBy || repository.installationAccount || repository.actor) && (
                  <span className="text-muted-foreground">
                    {repository.delegatedBy || repository.installationAccount || repository.actor}
                  </span>
                )}
                {repository.invalidReason && (
                  <span className="w-full pl-5 text-[11px] text-destructive">
                    {readableReason(repository.invalidReason)}
                  </span>
                )}
              </div>
            ))}
          </div>

          {canEdit && (
            <>
              <div className="space-y-3">
                {providers.map((provider) => (
                  <ProviderBindingControl
                    key={provider}
                    provider={provider}
                    authType={
                      authTypes[provider] ?? SOURCE_CONTROL_AUTH_OPTIONS[provider].defaultAuthType
                    }
                    confirmed={Boolean(confirmed[provider])}
                    disabled={saving}
                    onAuthTypeChange={(value) =>
                      setAuthTypes((current) => ({ ...current, [provider]: value }))
                    }
                    onConfirmedChange={(value) =>
                      setConfirmed((current) => ({ ...current, [provider]: value }))
                    }
                  />
                ))}
              </div>

              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={bind} disabled={saving}>
                  {saving ? (
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                  )}
                  {ready ? 'Rebind and verify' : 'Bind and verify'}
                </Button>
                {status?.repositories.some((repository) => repository.authType) && (
                  <Button size="sm" variant="outline" onClick={unbind} disabled={saving}>
                    <Unplug className="mr-1.5 h-3.5 w-3.5" />
                    Remove bindings
                  </Button>
                )}
              </div>
            </>
          )}

          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
      )}
    </SettingsCard>
  );
}
