import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Archive,
  Boxes,
  ExternalLink,
  Hammer,
  Loader2,
  Plus,
  RefreshCw,
  Rocket,
  RotateCw,
  Save,
  ShieldCheck,
  TriangleAlert,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { SettingsCard } from '@/components/settings/SettingsCard';
import {
  environmentsService,
  type EnvironmentDetail,
  type EnvironmentRecipe,
  type EnvironmentRevision,
  type EnvironmentTool,
  type ManagedEnvironment,
} from '@/services/environments';
import { cn } from '@/lib/utils';

const TOOL_GROUPS = [
  {
    key: 'tools' as const,
    label: 'Languages',
    names: ['node', 'python', 'java', 'go', 'rust'] as const,
  },
  {
    key: 'buildTools' as const,
    label: 'Build tools',
    names: ['maven', 'gradle'] as const,
  },
];

const ACTIVE_REVISION_STATUSES = new Set(['QUEUED', 'BUILDING', 'SCANNING', 'VERIFYING']);
const isActiveRevision = (revision: EnvironmentRevision) =>
  ACTIVE_REVISION_STATUSES.has(revision.status) ||
  (revision.status === 'SECURITY_REVIEW' && Boolean(revision.highFindingsAcknowledgedAt));

interface EnvironmentForm {
  environmentId: string;
  name: string;
  description: string;
  baseEnvironmentId: string;
  tools: EnvironmentRecipe['tools'];
  buildTools: EnvironmentRecipe['buildTools'];
  aptPackages: string;
  environmentVariables: string;
  buildCommands: string;
}

const emptyForm = (): EnvironmentForm => ({
  environmentId: '',
  name: '',
  description: '',
  baseEnvironmentId: 'standard',
  tools: {},
  buildTools: {},
  aptPackages: '',
  environmentVariables: '',
  buildCommands: '',
});

const formFromRevision = (
  environment: ManagedEnvironment,
  revision: EnvironmentRevision | null,
): EnvironmentForm => {
  const recipe = revision?.recipe;
  return {
    environmentId: environment.environmentId,
    name: environment.name,
    description: environment.description ?? '',
    baseEnvironmentId: recipe?.base?.environmentId ?? environment.baseEnvironmentId ?? 'standard',
    tools: structuredClone(recipe?.tools ?? {}),
    buildTools: structuredClone(recipe?.buildTools ?? {}),
    aptPackages: (recipe?.aptPackages ?? []).map((pkg) => `${pkg.name}=${pkg.version}`).join('\n'),
    environmentVariables: Object.entries(recipe?.environmentVariables ?? {})
      .map(([name, value]) => `${name}=${value}`)
      .join('\n'),
    buildCommands: (recipe?.buildCommands ?? []).join('\n'),
  };
};

const parsePairs = (value: string) =>
  value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf('=');
      return separator > 0
        ? [line.slice(0, separator).trim(), line.slice(separator + 1).trim()]
        : [line, ''];
    });

const recipeFromForm = (form: EnvironmentForm): EnvironmentRecipe => ({
  schemaVersion: 1,
  base: null,
  tools: form.tools,
  buildTools: form.buildTools,
  aptPackages: parsePairs(form.aptPackages).map(([name, version]) => ({ name, version })),
  environmentVariables: Object.fromEntries(parsePairs(form.environmentVariables)),
  buildCommands: form.buildCommands
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean),
});

const statusClass = (status: string) => {
  if (status === 'FAILED') return 'border-destructive/30 bg-destructive/10 text-destructive';
  if (status === 'PUBLISHED' || status === 'READY')
    return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300';
  if (status === 'SECURITY_REVIEW' || status === 'UPDATE_AVAILABLE')
    return 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300';
  if (ACTIVE_REVISION_STATUSES.has(status))
    return 'border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300';
  return 'bg-muted/50 text-muted-foreground';
};

function StatusBadge({ status }: { status: string }) {
  return (
    <Badge variant="outline" className={cn('font-mono text-[10px]', statusClass(status))}>
      {status.replaceAll('_', ' ')}
    </Badge>
  );
}

function RecipeEditor({
  form,
  onChange,
  baseOptions,
  disabled,
  showId,
}: {
  form: EnvironmentForm;
  onChange: (next: EnvironmentForm) => void;
  baseOptions: ManagedEnvironment[];
  disabled: boolean;
  showId: boolean;
}) {
  const setTool = (group: 'tools' | 'buildTools', name: string, next: EnvironmentTool | null) => {
    const values = { ...form[group] } as Record<string, EnvironmentTool>;
    if (next) values[name] = next;
    else delete values[name];
    onChange({ ...form, [group]: values });
  };

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2">
        {showId && (
          <div className="space-y-1.5">
            <Label htmlFor="environment-id" className="text-xs">
              ID
            </Label>
            <Input
              id="environment-id"
              value={form.environmentId}
              onChange={(event) => onChange({ ...form, environmentId: event.target.value })}
              placeholder="generated-from-name"
              disabled={disabled}
              className="h-9 font-mono text-sm"
            />
          </div>
        )}
        <div className="space-y-1.5">
          <Label htmlFor="environment-name" className="text-xs">
            Name
          </Label>
          <Input
            id="environment-name"
            value={form.name}
            onChange={(event) => onChange({ ...form, name: event.target.value })}
            disabled={disabled}
            className="h-9 text-sm"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="environment-base" className="text-xs">
            Base
          </Label>
          <Select
            value={form.baseEnvironmentId}
            onValueChange={(value) => onChange({ ...form, baseEnvironmentId: value })}
            disabled={disabled}
          >
            <SelectTrigger id="environment-base" className="h-9 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {baseOptions.map((environment) => (
                <SelectItem key={environment.environmentId} value={environment.environmentId}>
                  {environment.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="environment-description" className="text-xs">
            Description
          </Label>
          <Input
            id="environment-description"
            value={form.description}
            onChange={(event) => onChange({ ...form, description: event.target.value })}
            disabled={disabled}
            className="h-9 text-sm"
          />
        </div>
      </div>

      {TOOL_GROUPS.map((group) => (
        <div key={group.key} className="space-y-2">
          <h4 className="text-xs font-medium">{group.label}</h4>
          <div className="divide-y rounded border">
            {group.names.map((name) => {
              const tool = (form[group.key] as Partial<Record<string, EnvironmentTool>>)[name];
              return (
                <div key={name} className="space-y-3 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-mono text-xs">{name}</span>
                    <Switch
                      aria-label={`Include ${name}`}
                      checked={Boolean(tool)}
                      disabled={disabled}
                      onCheckedChange={(checked) =>
                        setTool(group.key, name, checked ? { version: '', source: 'base' } : null)
                      }
                    />
                  </div>
                  {tool && (
                    <div className="grid gap-2 sm:grid-cols-3">
                      <Input
                        aria-label={`${name} version`}
                        value={tool.version}
                        onChange={(event) =>
                          setTool(group.key, name, { ...tool, version: event.target.value })
                        }
                        placeholder="Exact version"
                        disabled={disabled}
                        className="h-8 font-mono text-xs"
                      />
                      <Select
                        value={tool.source}
                        disabled={disabled}
                        onValueChange={(value) =>
                          setTool(group.key, name, {
                            version: tool.version,
                            source: value as 'base' | 'archive',
                            ...(value === 'archive'
                              ? {
                                  url: tool.url ?? '',
                                  checksum: tool.checksum ?? {
                                    algorithm: 'sha256',
                                    value: '',
                                  },
                                  stripComponents: tool.stripComponents ?? 1,
                                }
                              : {}),
                          })
                        }
                      >
                        <SelectTrigger aria-label={`${name} source`} className="h-8 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="base">From base</SelectItem>
                          <SelectItem value="archive">Curated archive</SelectItem>
                        </SelectContent>
                      </Select>
                      {tool.source === 'archive' && (
                        <Input
                          aria-label={`${name} strip components`}
                          type="number"
                          min={0}
                          max={4}
                          value={tool.stripComponents ?? 1}
                          onChange={(event) =>
                            setTool(group.key, name, {
                              ...tool,
                              stripComponents: Number(event.target.value),
                            })
                          }
                          disabled={disabled}
                          className="h-8 font-mono text-xs"
                        />
                      )}
                      {tool.source === 'archive' && (
                        <>
                          <Input
                            aria-label={`${name} archive URL`}
                            value={tool.url ?? ''}
                            onChange={(event) =>
                              setTool(group.key, name, { ...tool, url: event.target.value })
                            }
                            placeholder="HTTPS archive URL"
                            disabled={disabled}
                            className="h-8 font-mono text-xs sm:col-span-2"
                          />
                          <Select
                            value={tool.checksum?.algorithm ?? 'sha256'}
                            disabled={disabled}
                            onValueChange={(value) =>
                              setTool(group.key, name, {
                                ...tool,
                                checksum: {
                                  algorithm: value as 'sha256' | 'sha512',
                                  value: tool.checksum?.value ?? '',
                                },
                              })
                            }
                          >
                            <SelectTrigger
                              aria-label={`${name} checksum algorithm`}
                              className="h-8 text-xs"
                            >
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="sha256">SHA-256</SelectItem>
                              <SelectItem value="sha512">SHA-512</SelectItem>
                            </SelectContent>
                          </Select>
                          <Input
                            aria-label={`${name} checksum`}
                            value={tool.checksum?.value ?? ''}
                            onChange={(event) =>
                              setTool(group.key, name, {
                                ...tool,
                                checksum: {
                                  algorithm: tool.checksum?.algorithm ?? 'sha256',
                                  value: event.target.value,
                                },
                              })
                            }
                            placeholder="Checksum"
                            disabled={disabled}
                            className="h-8 font-mono text-xs sm:col-span-3"
                          />
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-1.5">
          <Label htmlFor="environment-apt" className="text-xs">
            apt packages
          </Label>
          <Textarea
            id="environment-apt"
            value={form.aptPackages}
            onChange={(event) => onChange({ ...form, aptPackages: event.target.value })}
            placeholder={'package=exact-version\npackage=exact-version'}
            disabled={disabled}
            className="min-h-28 font-mono text-xs"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="environment-variables" className="text-xs">
            Environment variables
          </Label>
          <Textarea
            id="environment-variables"
            value={form.environmentVariables}
            onChange={(event) => onChange({ ...form, environmentVariables: event.target.value })}
            placeholder={'NAME=value\nNAME=value'}
            disabled={disabled}
            className="min-h-28 font-mono text-xs"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="environment-commands" className="text-xs">
            Build commands
          </Label>
          <Textarea
            id="environment-commands"
            value={form.buildCommands}
            onChange={(event) => onChange({ ...form, buildCommands: event.target.value })}
            placeholder={'command one\ncommand two'}
            disabled={disabled}
            className="min-h-28 font-mono text-xs"
          />
        </div>
      </div>
    </div>
  );
}

function Evidence({ revision }: { revision: EnvironmentRevision }) {
  const scanEntries = Object.entries(revision.scanFindings?.severityCounts ?? {}).toSorted(
    ([a], [b]) => a.localeCompare(b),
  );
  const verificationEntries = Object.entries(revision.verification ?? {}).filter(
    ([key]) => !['capabilities', 'completedAt'].includes(key),
  );
  return (
    <div className="space-y-4 border-t pt-4">
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-2">
          <h4 className="text-xs font-medium">Image</h4>
          <p className="break-all font-mono text-[11px] text-muted-foreground">
            {revision.imageDigest ?? 'Not built'}
          </p>
          {revision.buildLogUrl && (
            <a
              href={revision.buildLogUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
            >
              Build logs <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
        <div className="space-y-2">
          <h4 className="text-xs font-medium">Security scan</h4>
          <div className="flex flex-wrap gap-1.5">
            {scanEntries.length ? (
              scanEntries.map(([severity, count]) => (
                <Badge key={severity} variant="outline" className="font-mono text-[10px]">
                  {severity} {count}
                </Badge>
              ))
            ) : (
              <span className="text-[11px] text-muted-foreground">No findings recorded</span>
            )}
          </div>
        </div>
        <div className="space-y-2">
          <h4 className="text-xs font-medium">Runtime validation</h4>
          <div className="flex flex-wrap gap-1.5">
            {verificationEntries.length ? (
              verificationEntries.map(([name, value]) => (
                <Badge key={name} variant="outline" className="text-[10px]">
                  {name} {String(value)}
                </Badge>
              ))
            ) : (
              <span className="text-[11px] text-muted-foreground">Not completed</span>
            )}
          </div>
        </div>
      </div>
      {revision.failure && (
        <div className="border-l-2 border-destructive/60 pl-3 text-xs text-destructive">
          <div className="font-medium">{revision.failure.reason ?? 'Build failed'}</div>
          {revision.failure.detail && (
            <div className="mt-1 break-words">{revision.failure.detail}</div>
          )}
        </div>
      )}
      {revision.generatedDockerfile && (
        <div className="space-y-2">
          <h4 className="text-xs font-medium">Generated Dockerfile</h4>
          <pre className="max-h-96 overflow-auto rounded border bg-muted/30 p-3 font-mono text-[11px] leading-relaxed">
            {revision.generatedDockerfile}
          </pre>
        </div>
      )}
    </div>
  );
}

export function EnvironmentsTab() {
  const [environments, setEnvironments] = useState<ManagedEnvironment[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<EnvironmentDetail | null>(null);
  const [selectedRevisionId, setSelectedRevisionId] = useState<string | null>(null);
  const [form, setForm] = useState<EnvironmentForm>(emptyForm);
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadList = useCallback(async (preferredId?: string) => {
    const values = await environmentsService.list();
    setEnvironments(values);
    setSelectedId((current) => {
      const candidate = preferredId ?? current;
      return candidate && values.some((item) => item.environmentId === candidate)
        ? candidate
        : (values[0]?.environmentId ?? null);
    });
    return values;
  }, []);

  const loadDetail = useCallback(async (environmentId: string, showLoading = true) => {
    if (showLoading) setDetailLoading(true);
    try {
      const value = await environmentsService.get(environmentId);
      setDetail(value);
      const current =
        value.revisions.find(
          (revision) => revision.revisionId === value.environment.currentRevisionId,
        ) ??
        value.publishedRevision ??
        value.revisions[0] ??
        null;
      setSelectedRevisionId((selected) =>
        selected && value.revisions.some((revision) => revision.revisionId === selected)
          ? selected
          : (current?.revisionId ?? null),
      );
      setForm(formFromRevision(value.environment, current));
      return value;
    } finally {
      if (showLoading) setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    loadList()
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load environments'))
      .finally(() => setLoading(false));
  }, [loadList]);

  useEffect(() => {
    if (!selectedId || creating) return;
    setError(null);
    void loadDetail(selectedId).catch((err) =>
      setError(err instanceof Error ? err.message : 'Failed to load environment'),
    );
  }, [creating, loadDetail, selectedId]);

  const selectedRevision = useMemo(
    () => detail?.revisions.find((revision) => revision.revisionId === selectedRevisionId) ?? null,
    [detail, selectedRevisionId],
  );

  useEffect(() => {
    if (!selectedId || !selectedRevision || !isActiveRevision(selectedRevision)) {
      return;
    }
    const timer = window.setInterval(() => {
      void Promise.all([loadDetail(selectedId, false), loadList(selectedId)]).catch(
        () => undefined,
      );
    }, 8000);
    return () => window.clearInterval(timer);
  }, [loadDetail, loadList, selectedId, selectedRevision]);

  const baseOptions = environments.filter(
    (environment) =>
      environment.publishedRevisionId &&
      environment.status !== 'RETIRED' &&
      (creating || environment.environmentId !== selectedId),
  );
  const updates = environments.filter(
    (environment) => environment.updateAvailable && environment.baseEnvironmentId,
  );

  const run = async (name: string, action: () => Promise<unknown>, preferredId = selectedId) => {
    setBusy(name);
    setError(null);
    try {
      await action();
      await loadList(preferredId ?? undefined);
      if (preferredId) await loadDetail(preferredId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Environment action failed');
    } finally {
      setBusy(null);
    }
  };

  const createEnvironment = async () => {
    setBusy('create');
    setError(null);
    try {
      const result = await environmentsService.create({
        ...(form.environmentId.trim() ? { environmentId: form.environmentId.trim() } : {}),
        name: form.name.trim(),
        description: form.description.trim(),
        baseEnvironmentId: form.baseEnvironmentId,
        recipe: recipeFromForm(form),
      });
      const environmentId = result.environment.environmentId;
      setCreating(false);
      setSelectedId(environmentId);
      await loadList(environmentId);
      await loadDetail(environmentId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Environment action failed');
    } finally {
      setBusy(null);
    }
  };

  const saveRevision = () => {
    if (!detail) return;
    void run('save', () =>
      environmentsService.update(detail.environment.environmentId, {
        name: form.name.trim(),
        description: form.description.trim(),
        baseEnvironmentId: form.baseEnvironmentId,
        recipe: recipeFromForm(form),
      }),
    );
  };

  const environment = detail?.environment ?? null;
  const currentRevision =
    detail?.revisions.find((revision) => revision.revisionId === environment?.currentRevisionId) ??
    null;

  return (
    <SettingsCard
      icon={<Boxes />}
      title="Managed Environments"
      badge={
        updates.length ? (
          <Badge variant="outline" className={statusClass('UPDATE_AVAILABLE')}>
            {updates.length} update{updates.length === 1 ? '' : 's'}
          </Badge>
        ) : null
      }
      description="Versioned agent build images and runtime endpoints."
      headerAction={
        <div className="flex items-center gap-2">
          {updates.length > 0 && (
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5"
              disabled={Boolean(busy)}
              onClick={() => void run('bulk-rebuild', () => environmentsService.rebuildAll())}
            >
              <RotateCw className="h-3.5 w-3.5" />
              Rebuild Updates
            </Button>
          )}
          <Button
            size="sm"
            className="gap-1.5"
            disabled={Boolean(busy)}
            onClick={() => {
              setCreating(true);
              setDetail(null);
              setForm(emptyForm());
              setError(null);
            }}
          >
            <Plus className="h-3.5 w-3.5" />
            New
          </Button>
        </div>
      }
    >
      {loading ? (
        <div className="grid gap-4 lg:grid-cols-[230px_minmax(0,1fr)]">
          <Skeleton className="h-72 w-full" />
          <Skeleton className="h-96 w-full" />
        </div>
      ) : (
        <div className="grid min-w-0 gap-5 lg:grid-cols-[230px_minmax(0,1fr)]">
          <div className="space-y-1 border-r pr-4">
            {environments.map((item) => (
              <button
                key={item.environmentId}
                type="button"
                className={cn(
                  'flex w-full items-start justify-between gap-2 rounded px-2.5 py-2 text-left hover:bg-muted/60',
                  !creating && selectedId === item.environmentId && 'bg-muted',
                )}
                onClick={() => {
                  setCreating(false);
                  setSelectedId(item.environmentId);
                }}
              >
                <span className="min-w-0">
                  <span className="block truncate text-xs font-medium">{item.name}</span>
                  <span className="block truncate font-mono text-[10px] text-muted-foreground">
                    {item.environmentId}
                  </span>
                </span>
                {item.updateAvailable ? (
                  <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
                ) : (
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/40" />
                )}
              </button>
            ))}
          </div>

          <div className="min-w-0 space-y-5">
            {creating ? (
              <>
                <div className="flex items-center justify-between gap-3">
                  <h3 className="text-sm font-semibold">New Environment</h3>
                  <Button variant="ghost" size="sm" onClick={() => setCreating(false)}>
                    Cancel
                  </Button>
                </div>
                <RecipeEditor
                  form={form}
                  onChange={setForm}
                  baseOptions={baseOptions}
                  disabled={Boolean(busy)}
                  showId
                />
                <Button
                  size="sm"
                  className="gap-1.5"
                  disabled={Boolean(busy) || !form.name.trim() || !form.baseEnvironmentId}
                  onClick={() => void createEnvironment()}
                >
                  {busy === 'create' ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Save className="h-3.5 w-3.5" />
                  )}
                  Create Draft
                </Button>
              </>
            ) : detailLoading || !environment ? (
              <Skeleton className="h-96 w-full" />
            ) : (
              <>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-sm font-semibold">{environment.name}</h3>
                      <StatusBadge status={environment.status} />
                    </div>
                    <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                      {environment.environmentId}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    {environment.updateAvailable && environment.baseEnvironmentId && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="gap-1.5"
                        disabled={Boolean(busy)}
                        onClick={() =>
                          void run('rebuild', () =>
                            environmentsService.rebuild(environment.environmentId),
                          )
                        }
                      >
                        <RotateCw className="h-3.5 w-3.5" />
                        Rebuild on Latest Base
                      </Button>
                    )}
                    {environment.environmentId !== 'standard' && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="gap-1.5 text-destructive"
                        disabled={Boolean(busy)}
                        onClick={() => {
                          if (window.confirm(`Retire ${environment.name}?`)) {
                            void run('retire', () =>
                              environmentsService.retire(environment.environmentId),
                            );
                          }
                        }}
                      >
                        <Archive className="h-3.5 w-3.5" />
                        Retire
                      </Button>
                    )}
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2 border-y py-3">
                  <Select
                    value={selectedRevisionId ?? undefined}
                    onValueChange={setSelectedRevisionId}
                  >
                    <SelectTrigger
                      aria-label="Revision"
                      className="h-8 w-[240px] font-mono text-xs"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {detail?.revisions.map((revision) => (
                        <SelectItem key={revision.revisionId} value={revision.revisionId}>
                          {revision.revisionId} · {revision.status}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {selectedRevision && <StatusBadge status={selectedRevision.status} />}
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8"
                    title="Refresh"
                    disabled={Boolean(busy)}
                    onClick={() => void loadDetail(environment.environmentId)}
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                  </Button>
                  <div className="ml-auto flex flex-wrap gap-2">
                    {selectedRevision?.status === 'DRAFT' && (
                      <Button
                        size="sm"
                        className="gap-1.5"
                        disabled={Boolean(busy)}
                        onClick={() =>
                          void run('build', () =>
                            environmentsService.build(
                              environment.environmentId,
                              selectedRevision.revisionId,
                            ),
                          )
                        }
                      >
                        <Hammer className="h-3.5 w-3.5" />
                        Build
                      </Button>
                    )}
                    {selectedRevision?.status === 'FAILED' && (
                      <Button
                        size="sm"
                        className="gap-1.5"
                        disabled={Boolean(busy)}
                        onClick={() =>
                          void run('retry', () =>
                            environmentsService.retry(
                              environment.environmentId,
                              selectedRevision.revisionId,
                            ),
                          )
                        }
                      >
                        <RotateCw className="h-3.5 w-3.5" />
                        Retry
                      </Button>
                    )}
                    {selectedRevision?.status === 'SECURITY_REVIEW' && (
                      <Button
                        size="sm"
                        className="gap-1.5"
                        disabled={Boolean(busy)}
                        onClick={() =>
                          void run('acknowledge', () =>
                            environmentsService.acknowledge(
                              environment.environmentId,
                              selectedRevision.revisionId,
                            ),
                          )
                        }
                      >
                        <ShieldCheck className="h-3.5 w-3.5" />
                        Acknowledge High Findings
                      </Button>
                    )}
                    {selectedRevision?.status === 'READY' && (
                      <Button
                        size="sm"
                        className="gap-1.5"
                        disabled={Boolean(busy)}
                        onClick={() =>
                          void run('publish', () =>
                            environmentsService.publish(
                              environment.environmentId,
                              selectedRevision.revisionId,
                            ),
                          )
                        }
                      >
                        <Rocket className="h-3.5 w-3.5" />
                        Publish
                      </Button>
                    )}
                  </div>
                </div>

                {environment.environmentId !== 'standard' && (
                  <>
                    <RecipeEditor
                      form={form}
                      onChange={setForm}
                      baseOptions={baseOptions}
                      disabled={Boolean(busy)}
                      showId={false}
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-1.5"
                      disabled={Boolean(busy) || !form.name.trim()}
                      onClick={saveRevision}
                    >
                      {busy === 'save' ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Save className="h-3.5 w-3.5" />
                      )}
                      Save as New Revision
                    </Button>
                  </>
                )}

                {selectedRevision && <Evidence revision={selectedRevision} />}
                {currentRevision && currentRevision.revisionId !== selectedRevision?.revisionId && (
                  <p className="text-[11px] text-muted-foreground">
                    Current draft: <span className="font-mono">{currentRevision.revisionId}</span>
                  </p>
                )}
              </>
            )}

            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
        </div>
      )}
    </SettingsCard>
  );
}
