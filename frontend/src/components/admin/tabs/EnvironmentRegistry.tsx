import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Archive,
  Boxes,
  CircleCheck,
  ExternalLink,
  Hammer,
  Loader2,
  Plus,
  RefreshCw,
  Rocket,
  RotateCw,
  Save,
  ShieldAlert,
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
  toolsService,
  type EnvironmentDetail,
  type EnvironmentRecipeInput,
  type EnvironmentRevision,
  type EnvironmentToolSnapshot,
  type ManagedEnvironment,
  type CatalogEnvironmentRecipe,
  type ManagedTool,
  type ManagedToolVersion,
} from '@/services/environments';
import { cn } from '@/lib/utils';

const ACTIVE_REVISION_STATUSES = new Set(['QUEUED', 'BUILDING', 'SCANNING', 'VERIFYING']);
const RUNTIME_IMAGE_LIMIT_BYTES = 2048 * 1024 * 1024;

interface EnvironmentForm {
  environmentId: string;
  name: string;
  description: string;
  baseEnvironmentId: string;
  toolVersionIds: string[];
  aptPackages: string;
  environmentVariables: string;
  buildCommands: string;
}

const emptyForm = (): EnvironmentForm => ({
  environmentId: '',
  name: '',
  description: '',
  baseEnvironmentId: 'standard',
  toolVersionIds: [],
  aptPackages: '',
  environmentVariables: '',
  buildCommands: '',
});

const isCatalogRecipe = (
  recipe: EnvironmentRevision['recipe'] | undefined,
): recipe is CatalogEnvironmentRecipe => recipe?.schemaVersion === 2;

const resolvedTools = (revision: EnvironmentRevision | null): EnvironmentToolSnapshot[] => {
  const recipe = revision?.flattenedRecipe;
  if (!isCatalogRecipe(recipe)) return [];
  return recipe.resolvedTools ?? recipe.tools;
};

const directToolVersionIds = (revision: EnvironmentRevision | null) =>
  isCatalogRecipe(revision?.recipe) ? revision.recipe.toolVersionIds : [];

const protectedRuntimeVersions = (revision: EnvironmentRevision | null) => {
  const recipe = revision?.flattenedRecipe;
  if (!recipe || recipe.schemaVersion !== 1) return { node: null, python: null };
  return {
    node: recipe.tools.node?.version ?? null,
    python: recipe.tools.python?.version ?? null,
  };
};

const formFromRevision = (
  environment: ManagedEnvironment,
  revision: EnvironmentRevision | null,
): EnvironmentForm => {
  const recipe = revision?.recipe;
  return {
    environmentId: environment.environmentId,
    name: environment.name,
    description: environment.description ?? '',
    baseEnvironmentId:
      environment.environmentId === 'standard'
        ? ''
        : (recipe?.base?.environmentId ?? environment.baseEnvironmentId ?? 'standard'),
    toolVersionIds: directToolVersionIds(revision),
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

const recipeFromForm = (form: EnvironmentForm): EnvironmentRecipeInput => ({
  schemaVersion: 2,
  toolVersionIds: form.toolVersionIds,
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

const severityClass = (severity: string) => {
  if (severity === 'CRITICAL') return 'border-destructive/40 bg-destructive/10 text-destructive';
  if (severity === 'HIGH')
    return 'border-orange-500/40 bg-orange-500/10 text-orange-700 dark:text-orange-300';
  if (severity === 'MEDIUM')
    return 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300';
  return 'bg-muted/50 text-muted-foreground';
};

function StatusBadge({ status }: { status: string }) {
  return (
    <Badge variant="outline" className={cn('font-mono text-[10px]', statusClass(status))}>
      {status.replaceAll('_', ' ')}
    </Badge>
  );
}

const publishedVersions = (tool: ManagedTool) =>
  tool.versions.filter((version) => version.status === 'PUBLISHED');

const recommendedVersion = (tool: ManagedTool) =>
  publishedVersions(tool).find((version) => version.versionId === tool.recommendedVersionId) ??
  publishedVersions(tool)[0] ??
  null;

function RecipeEditor({
  form,
  onChange,
  baseOptions,
  baseEnvironment,
  baseRevision,
  baseLoading,
  tools,
  disabled,
  showId,
}: {
  form: EnvironmentForm;
  onChange: (next: EnvironmentForm) => void;
  baseOptions: ManagedEnvironment[];
  baseEnvironment: ManagedEnvironment | null;
  baseRevision: EnvironmentRevision | null;
  baseLoading: boolean;
  tools: ManagedTool[];
  disabled: boolean;
  showId: boolean;
}) {
  const inherited = resolvedTools(baseRevision);
  const protectedVersions = protectedRuntimeVersions(baseRevision);
  const inheritedById = new Map(inherited.map((tool) => [tool.toolId, tool]));
  const selectedVersions = new Map<string, ManagedToolVersion>();
  for (const tool of tools) {
    const selected = tool.versions.find((version) =>
      form.toolVersionIds.includes(version.versionId),
    );
    if (selected) selectedVersions.set(tool.toolId, selected);
  }
  const toolById = new Map(tools.map((tool) => [tool.toolId, tool]));
  const effectiveSelectedVersions = new Map(selectedVersions);
  const requiredBy = new Map<string, Set<string>>();
  const resolving = new Set<string>();
  const includeDependencies = (version: ManagedToolVersion) => {
    if (resolving.has(version.toolId)) return;
    resolving.add(version.toolId);
    for (const dependencyId of version.definition.dependencies) {
      if (inheritedById.has(dependencyId)) continue;
      const owners = requiredBy.get(dependencyId) ?? new Set<string>();
      owners.add(toolById.get(version.toolId)?.name ?? version.toolId);
      requiredBy.set(dependencyId, owners);
      let dependency = effectiveSelectedVersions.get(dependencyId);
      if (!dependency) {
        const family = toolById.get(dependencyId);
        dependency = family ? (recommendedVersion(family) ?? undefined) : undefined;
        if (dependency) effectiveSelectedVersions.set(dependencyId, dependency);
      }
      if (dependency) includeDependencies(dependency);
    }
    resolving.delete(version.toolId);
  };
  for (const version of selectedVersions.values()) includeDependencies(version);

  const selectedSize = [...effectiveSelectedVersions.values()].reduce(
    (total, version) => total + Number(version.imageSizeBytes ?? 0),
    0,
  );
  const sizesKnown =
    Number(baseRevision?.imageSizeBytes ?? 0) > 0 &&
    [...effectiveSelectedVersions.values()].every(
      (version) => Number(version.imageSizeBytes ?? 0) > 0,
    );
  const projectedSize = sizesKnown
    ? Number(baseRevision?.imageSizeBytes ?? 0) + selectedSize
    : null;

  const setVersion = (tool: ManagedTool, versionId: string | null) => {
    const familyVersionIds = new Set(tool.versions.map((version) => version.versionId));
    const remaining = form.toolVersionIds.filter((id) => !familyVersionIds.has(id));
    onChange({
      ...form,
      toolVersionIds: versionId ? [...remaining, versionId] : remaining,
    });
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

      <div className="space-y-2">
        <Label htmlFor="environment-base" className="text-xs">
          Base environment
        </Label>
        <Select
          value={form.baseEnvironmentId}
          onValueChange={(baseEnvironmentId) =>
            onChange({ ...form, baseEnvironmentId, toolVersionIds: [] })
          }
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
        {baseLoading ? (
          <Skeleton className="h-14" />
        ) : baseRevision ? (
          <div className="border-l-2 border-primary/30 pl-3">
            <p className="text-[11px] text-muted-foreground">
              Inherits protected Node.js and Python plus tools in{' '}
              <span className="font-medium text-foreground">
                {baseEnvironment?.name ?? 'the base'}
              </span>
              .
            </p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              <Badge variant="outline" className="text-[10px]">
                Node.js{protectedVersions.node ? ` ${protectedVersions.node}` : ''}
              </Badge>
              <Badge variant="outline" className="text-[10px]">
                Python{protectedVersions.python ? ` ${protectedVersions.python}` : ''}
              </Badge>
              {inherited.map((tool) => (
                <Badge key={tool.toolId} variant="outline" className="text-[10px]">
                  {tool.name} {tool.version}
                </Badge>
              ))}
            </div>
          </div>
        ) : (
          <p className="text-[11px] text-destructive">Published base revision unavailable</p>
        )}
      </div>

      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="text-xs font-medium">Catalog tools</h4>
          {projectedSize ? (
            <Badge
              variant="outline"
              className={cn(
                'font-mono text-[10px]',
                projectedSize > RUNTIME_IMAGE_LIMIT_BYTES && statusClass('FAILED'),
              )}
            >
              Projected {(projectedSize / 1024 / 1024).toFixed(0)} / 2048 MiB
            </Badge>
          ) : (
            <span className="text-[11px] text-muted-foreground">
              Size available after artifacts are built
            </span>
          )}
        </div>
        <div className="divide-y rounded border">
          {tools.map((tool) => {
            const versions = publishedVersions(tool);
            const inheritedTool = inheritedById.get(tool.toolId) ?? null;
            const selected = selectedVersions.get(tool.toolId) ?? null;
            const effective = effectiveSelectedVersions.get(tool.toolId) ?? null;
            const required = requiredBy.has(tool.toolId) && !inheritedTool;
            const enabled = Boolean(effective);
            const recommended = recommendedVersion(tool);
            const showVersionSelect =
              Boolean(inheritedTool && versions.length) ||
              Boolean(effective && versions.length > 1);
            return (
              <div
                key={tool.toolId}
                className="grid min-h-20 gap-3 p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
              >
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-medium">{tool.name}</span>
                    <Badge variant="outline" className="font-mono text-[10px]">
                      {effective?.definition.version ??
                        inheritedTool?.version ??
                        recommended?.definition.version ??
                        'Unavailable'}
                    </Badge>
                    {effective?.versionId === tool.recommendedVersionId && (
                      <Badge variant="secondary" className="text-[10px]">
                        Recommended
                      </Badge>
                    )}
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    {selected
                      ? `Added by this environment · ${selected.source?.trustLevel === 'PUBLISHER_VERIFIED' ? 'publisher verified' : 'platform pinned'}`
                      : required
                        ? `Added automatically for ${[...(requiredBy.get(tool.toolId) ?? [])].join(', ')}`
                        : inheritedTool
                          ? `Inherited from ${baseEnvironment?.name ?? 'base environment'}`
                          : versions.length
                            ? tool.description
                            : 'No published version'}
                  </p>
                  {(effective?.definition.dependencies.length ?? 0) > 0 && (
                    <p className="text-[11px] text-muted-foreground">
                      Requires {effective?.definition.dependencies.join(', ')}; missing dependencies
                      are added at their recommended version.
                    </p>
                  )}
                </div>
                <div className="flex items-center justify-end gap-2">
                  {showVersionSelect && (
                    <Select
                      value={effective?.versionId ?? 'inherit'}
                      disabled={disabled}
                      onValueChange={(value) =>
                        setVersion(tool, value === 'inherit' ? null : value)
                      }
                    >
                      <SelectTrigger
                        aria-label={`${tool.name} version`}
                        className="h-8 w-52 text-xs"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {inheritedTool && (
                          <SelectItem value="inherit">Base · {inheritedTool.version}</SelectItem>
                        )}
                        {versions.map((version) => (
                          <SelectItem key={version.versionId} value={version.versionId}>
                            {version.definition.version}
                            {version.versionId === tool.recommendedVersionId
                              ? ' · recommended'
                              : ''}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                  {!inheritedTool && !required && (
                    <Switch
                      aria-label={`Include ${tool.name}`}
                      checked={enabled}
                      disabled={disabled || !recommended}
                      onCheckedChange={(checked) =>
                        setVersion(tool, checked ? (recommended?.versionId ?? null) : null)
                      }
                    />
                  )}
                  {required && (
                    <Badge variant="secondary" className="text-[10px]">
                      Required
                    </Badge>
                  )}
                  {inheritedTool && !showVersionSelect && (
                    <Badge variant="secondary" className="text-[10px]">
                      Included
                    </Badge>
                  )}
                </div>
              </div>
            );
          })}
          {tools.length === 0 && (
            <div className="p-3 text-xs text-muted-foreground">
              Publish a tool version before composing an environment.
            </div>
          )}
        </div>
        {projectedSize && projectedSize > RUNTIME_IMAGE_LIMIT_BYTES && (
          <p className="flex items-start gap-1.5 text-xs text-destructive">
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            This composition exceeds the AgentCore runtime image limit.
          </p>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-1.5">
          <Label htmlFor="environment-apt" className="text-xs">
            Additional apt packages
          </Label>
          <Textarea
            id="environment-apt"
            value={form.aptPackages}
            onChange={(event) => onChange({ ...form, aptPackages: event.target.value })}
            placeholder="package=exact-version"
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
            placeholder="NAME=value"
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
            placeholder="command"
            disabled={disabled}
            className="min-h-28 font-mono text-xs"
          />
        </div>
      </div>
    </div>
  );
}

const securityFindingsAcceptedAt = (revision: EnvironmentRevision) =>
  revision.securityFindingsAcceptedAt ?? revision.highFindingsAcknowledgedAt ?? null;
const securityFindingsAcceptedBy = (revision: EnvironmentRevision) =>
  revision.securityFindingsAcceptedBy ?? revision.highFindingsAcknowledgedBy ?? null;
const isActiveRevision = (revision: EnvironmentRevision) =>
  ACTIVE_REVISION_STATUSES.has(revision.status) ||
  (revision.status === 'SECURITY_REVIEW' && Boolean(securityFindingsAcceptedAt(revision)));

function Evidence({ revision }: { revision: EnvironmentRevision }) {
  const findings = revision.scanFindings?.findings ?? [];
  const acceptedAt = securityFindingsAcceptedAt(revision);
  const acceptedBy = securityFindingsAcceptedBy(revision);
  const critical = Number(revision.scanFindings?.severityCounts?.CRITICAL ?? 0);
  const high = Number(revision.scanFindings?.severityCounts?.HIGH ?? 0);
  const securityOnlyFailure =
    revision.failure?.reason === 'critical_vulnerability_findings' && Boolean(revision.imageDigest);
  return (
    <div className="space-y-4 border-t pt-4">
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-2">
          <h4 className="text-xs font-medium">Image</h4>
          {revision.imageDigest ? (
            <Badge
              variant="outline"
              className="gap-1 border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
            >
              <CircleCheck className="h-3 w-3" />
              Build passed
            </Badge>
          ) : (
            <span className="text-[11px] text-muted-foreground">Not built</span>
          )}
          <p className="break-all font-mono text-[11px] text-muted-foreground">
            {revision.imageDigest ?? 'No image digest'}
          </p>
          {revision.imageSizeBytes && (
            <p className="font-mono text-[11px] text-muted-foreground">
              {(revision.imageSizeBytes / 1024 / 1024).toFixed(1)} MiB
            </p>
          )}
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
          <Badge
            variant="outline"
            className={cn(
              acceptedAt || critical + high > 0
                ? statusClass('SECURITY_REVIEW')
                : revision.scanFindings
                  ? statusClass('READY')
                  : '',
            )}
          >
            {acceptedAt
              ? 'Findings accepted'
              : critical + high > 0
                ? 'Review required'
                : revision.scanFindings
                  ? 'Passed'
                  : 'Pending'}
          </Badge>
          {acceptedAt && (
            <p className="text-[11px] text-muted-foreground">
              Accepted{acceptedBy ? ` by ${acceptedBy}` : ''}{' '}
              <time dateTime={acceptedAt}>{new Date(acceptedAt).toLocaleString()}</time>
            </p>
          )}
        </div>
        <div className="space-y-2">
          <h4 className="text-xs font-medium">Runtime validation</h4>
          <p className="text-[11px] text-muted-foreground">
            {revision.verification ? 'Recorded with this revision' : 'Not completed'}
          </p>
        </div>
      </div>
      {findings.length > 0 && (
        <div className="divide-y overflow-hidden rounded border">
          {findings.map((finding, index) => (
            <div
              key={`${finding.id}-${index}`}
              className="grid gap-2 px-3 py-2 sm:grid-cols-[90px_minmax(0,1fr)_auto]"
            >
              <Badge
                variant="outline"
                className={cn('w-fit font-mono text-[10px]', severityClass(finding.severity))}
              >
                {finding.severity}
              </Badge>
              {finding.uri ? (
                <a
                  href={finding.uri}
                  target="_blank"
                  rel="noreferrer"
                  className="truncate font-mono text-[11px] text-primary hover:underline"
                >
                  {finding.id}
                </a>
              ) : (
                <span className="truncate font-mono text-[11px]">{finding.id}</span>
              )}
              <span className="font-mono text-[11px] text-muted-foreground">
                {finding.packageName ?? 'Unknown package'}
                {finding.packageVersion ? ` ${finding.packageVersion}` : ''}
              </span>
            </div>
          ))}
        </div>
      )}
      {revision.failure && !securityOnlyFailure && (
        <div className="border-l-2 border-destructive/60 pl-3 text-xs text-destructive">
          <div className="font-medium">{revision.failure.reason ?? 'Build failed'}</div>
          {revision.failure.detail && <div className="mt-1">{revision.failure.detail}</div>}
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

export function EnvironmentRegistry() {
  const [environments, setEnvironments] = useState<ManagedEnvironment[]>([]);
  const [tools, setTools] = useState<ManagedTool[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<EnvironmentDetail | null>(null);
  const [baseDetail, setBaseDetail] = useState<EnvironmentDetail | null>(null);
  const [selectedRevisionId, setSelectedRevisionId] = useState<string | null>(null);
  const [form, setForm] = useState<EnvironmentForm>(emptyForm);
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [baseLoading, setBaseLoading] = useState(false);
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
    Promise.all([loadList(), toolsService.list(true)])
      .then(([, values]) => setTools(values))
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : 'Failed to load environments'),
      )
      .finally(() => setLoading(false));
  }, [loadList]);

  useEffect(() => {
    if (!selectedId || creating) return;
    setError(null);
    void loadDetail(selectedId).catch((reason) =>
      setError(reason instanceof Error ? reason.message : 'Failed to load environment'),
    );
  }, [creating, loadDetail, selectedId]);

  useEffect(() => {
    if (!form.baseEnvironmentId) {
      setBaseDetail(null);
      return;
    }
    let active = true;
    setBaseLoading(true);
    void environmentsService
      .get(form.baseEnvironmentId)
      .then((value) => {
        if (active) setBaseDetail(value);
      })
      .catch((reason) => {
        if (active) {
          setBaseDetail(null);
          setError(reason instanceof Error ? reason.message : 'Failed to load base environment');
        }
      })
      .finally(() => {
        if (active) setBaseLoading(false);
      });
    return () => {
      active = false;
    };
  }, [form.baseEnvironmentId]);

  const selectedRevision = useMemo(
    () => detail?.revisions.find((revision) => revision.revisionId === selectedRevisionId) ?? null,
    [detail, selectedRevisionId],
  );
  const currentRevision =
    detail?.revisions.find(
      (revision) => revision.revisionId === detail.environment.currentRevisionId,
    ) ?? null;
  const fixedToolEnvironment =
    detail?.environment.environmentId !== 'standard' &&
    Boolean(currentRevision) &&
    !isCatalogRecipe(currentRevision?.recipe);

  useEffect(() => {
    if (!selectedId || !selectedRevision || !isActiveRevision(selectedRevision)) return;
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
  const updates = environments.filter((environment) => environment.updateAvailable);
  const activeBaseDetail =
    baseDetail?.environment.environmentId === form.baseEnvironmentId ? baseDetail : null;
  const baseEnvironment =
    environments.find((environment) => environment.environmentId === form.baseEnvironmentId) ??
    activeBaseDetail?.environment ??
    null;
  const baseRevision = activeBaseDetail?.publishedRevision ?? null;

  const run = async (name: string, action: () => Promise<unknown>, preferredId = selectedId) => {
    setBusy(name);
    setError(null);
    try {
      await action();
      await loadList(preferredId ?? undefined);
      if (preferredId) await loadDetail(preferredId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Environment action failed');
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
      setCreating(false);
      setSelectedId(result.environment.environmentId);
      await loadList(result.environment.environmentId);
      await loadDetail(result.environment.environmentId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Environment action failed');
    } finally {
      setBusy(null);
    }
  };

  const environment = detail?.environment ?? null;
  const findingsAcceptedAt = selectedRevision ? securityFindingsAcceptedAt(selectedRevision) : null;
  const legacySecurityFailure =
    selectedRevision?.status === 'FAILED' &&
    selectedRevision.failure?.reason === 'critical_vulnerability_findings' &&
    Boolean(selectedRevision.imageDigest);
  const requiresSecurityAcceptance =
    Boolean(selectedRevision) &&
    !findingsAcceptedAt &&
    (selectedRevision?.status === 'SECURITY_REVIEW' || legacySecurityFailure);
  const selectedCriticalFindings = Number(
    selectedRevision?.scanFindings?.severityCounts?.CRITICAL ?? 0,
  );
  const selectedHighFindings = Number(selectedRevision?.scanFindings?.severityCounts?.HIGH ?? 0);

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
      description="Compose published tools into versioned AgentCore runtimes."
      headerAction={
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
      }
    >
      {loading ? (
        <div className="grid gap-4 lg:grid-cols-[230px_minmax(0,1fr)]">
          <Skeleton className="h-72" />
          <Skeleton className="h-96" />
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
                  baseEnvironment={baseEnvironment}
                  baseRevision={baseRevision}
                  baseLoading={baseLoading}
                  tools={tools}
                  disabled={Boolean(busy)}
                  showId
                />
                <Button
                  size="sm"
                  className="gap-1.5"
                  disabled={
                    Boolean(busy) ||
                    baseLoading ||
                    !baseRevision ||
                    !form.name.trim() ||
                    !form.baseEnvironmentId
                  }
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
              <Skeleton className="h-96" />
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
                    {(environment.toolUpdates?.length ?? 0) > 0 && (
                      <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">
                        Recommended tool updates are available. Save a new revision to select them.
                      </p>
                    )}
                    {fixedToolEnvironment && (
                      <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">
                        This fixed-tool environment is read-only. Use Reset to remove it, then
                        recreate it from published catalog tools.
                      </p>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {environment.updateAvailable &&
                      environment.baseEnvironmentId &&
                      !(environment.toolUpdates?.length ?? 0) && (
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
                    <SelectTrigger aria-label="Revision" className="h-8 w-64 font-mono text-xs">
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
                    onClick={() => void loadDetail(environment.environmentId)}
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                  </Button>
                  <div className="ml-auto flex flex-wrap gap-2">
                    {selectedRevision?.status === 'DRAFT' &&
                      !environment.updateAvailable &&
                      isCatalogRecipe(selectedRevision.recipe) && (
                        <Button
                          size="sm"
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
                    {selectedRevision?.status === 'FAILED' &&
                      !environment.updateAvailable &&
                      isCatalogRecipe(selectedRevision.recipe) && (
                        <Button
                          size="sm"
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
                    {requiresSecurityAcceptance && selectedRevision && (
                      <Button
                        size="sm"
                        onClick={() => {
                          if (
                            window.confirm(
                              `Accept ${selectedCriticalFindings} Critical and ${selectedHighFindings} High security findings and continue to runtime validation? The findings will remain visible after publication.`,
                            )
                          ) {
                            void run('accept-findings', () =>
                              environmentsService.acceptFindings(
                                environment.environmentId,
                                selectedRevision.revisionId,
                              ),
                            );
                          }
                        }}
                      >
                        <ShieldAlert className="h-3.5 w-3.5" />
                        Accept Findings & Continue
                      </Button>
                    )}
                    {selectedRevision?.status === 'SECURITY_REVIEW' && findingsAcceptedAt && (
                      <Badge
                        variant="outline"
                        className={cn('gap-1.5', statusClass('SECURITY_REVIEW'))}
                      >
                        <ShieldCheck className="h-3.5 w-3.5" />
                        Accepted · validation pending
                      </Badge>
                    )}
                    {selectedRevision?.status === 'READY' &&
                      (environment.environmentId === 'standard' ||
                        isCatalogRecipe(selectedRevision.recipe)) && (
                        <Button
                          size="sm"
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

                {environment.environmentId !== 'standard' && !fixedToolEnvironment && (
                  <>
                    <RecipeEditor
                      form={form}
                      onChange={setForm}
                      baseOptions={baseOptions}
                      baseEnvironment={baseEnvironment}
                      baseRevision={baseRevision}
                      baseLoading={baseLoading}
                      tools={tools}
                      disabled={Boolean(busy)}
                      showId={false}
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-1.5"
                      disabled={Boolean(busy) || baseLoading || !baseRevision || !form.name.trim()}
                      onClick={() =>
                        void run('save', () =>
                          environmentsService.update(environment.environmentId, {
                            name: form.name.trim(),
                            description: form.description.trim(),
                            baseEnvironmentId: form.baseEnvironmentId,
                            recipe: recipeFromForm(form),
                          }),
                        )
                      }
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
              </>
            )}
            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
        </div>
      )}
    </SettingsCard>
  );
}
