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
  type EnvironmentDetail,
  type EnvironmentRecipe,
  type EnvironmentRevision,
  type EnvironmentTool,
  type EnvironmentToolCatalog,
  type EnvironmentToolCatalogItem,
  type ManagedEnvironment,
} from '@/services/environments';
import { cn } from '@/lib/utils';

const TOOL_GROUPS = [
  {
    key: 'tools' as const,
    label: 'Languages',
    names: ['node', 'python', 'java', 'go', 'rust'],
  },
  {
    key: 'buildTools' as const,
    label: 'Build tools',
    names: ['maven', 'gradle'],
  },
] as const;

type ToolGroupKey = (typeof TOOL_GROUPS)[number]['key'];

const toolIdentity = (tool: EnvironmentTool) =>
  [
    tool.version,
    tool.source,
    tool.url ?? '',
    tool.checksum?.algorithm ?? '',
    tool.checksum?.value ?? '',
    tool.stripComponents ?? '',
  ].join('|');

const sameTool = (left: EnvironmentTool | null, right: EnvironmentTool | null) =>
  Boolean(left && right && toolIdentity(left) === toolIdentity(right));

const cloneTool = (tool: EnvironmentTool): EnvironmentTool => structuredClone(tool);

const withoutBaseExpectations = <
  T extends EnvironmentRecipe['tools'] | EnvironmentRecipe['buildTools'],
>(
  tools: T,
): T => Object.fromEntries(Object.entries(tools).filter(([, tool]) => tool.source !== 'base')) as T;

const ACTIVE_REVISION_STATUSES = new Set(['QUEUED', 'BUILDING', 'SCANNING', 'VERIFYING']);
const securityFindingsAcceptedAt = (revision: EnvironmentRevision) =>
  revision.securityFindingsAcceptedAt ?? revision.highFindingsAcknowledgedAt ?? null;
const securityFindingsAcceptedBy = (revision: EnvironmentRevision) =>
  revision.securityFindingsAcceptedBy ?? revision.highFindingsAcknowledgedBy ?? null;
const isActiveRevision = (revision: EnvironmentRevision) =>
  ACTIVE_REVISION_STATUSES.has(revision.status) ||
  (revision.status === 'SECURITY_REVIEW' && Boolean(securityFindingsAcceptedAt(revision)));

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
    baseEnvironmentId:
      environment.environmentId === 'standard'
        ? ''
        : (recipe?.base?.environmentId ?? environment.baseEnvironmentId ?? 'standard'),
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

function ToolProvenance({
  label,
  publisher,
  tool,
}: {
  label: string;
  publisher: string;
  tool: EnvironmentTool | null;
}) {
  if (tool?.source !== 'archive' || !tool.url || !tool.checksum) return null;
  const algorithm = tool.checksum.algorithm.toUpperCase().replace('SHA', 'SHA-');
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
      <a
        href={tool.url}
        target="_blank"
        rel="noreferrer"
        aria-label={`${label} official package`}
        className="inline-flex items-center gap-1 hover:text-foreground hover:underline"
      >
        {publisher} package
        <ExternalLink className="h-3 w-3" />
      </a>
      <span
        title={`The image build verifies this exact download before installation: ${tool.checksum.value}`}
        aria-label={`${label} ${algorithm} integrity checksum ${tool.checksum.value}`}
      >
        Integrity check: {algorithm} {tool.checksum.value.slice(0, 12)}…
      </span>
    </div>
  );
}

function RecipeEditor({
  form,
  onChange,
  baseOptions,
  baseEnvironment,
  baseRevision,
  baseLoading,
  catalog,
  disabled,
  showId,
}: {
  form: EnvironmentForm;
  onChange: (next: EnvironmentForm) => void;
  baseOptions: ManagedEnvironment[];
  baseEnvironment: ManagedEnvironment | null;
  baseRevision: EnvironmentRevision | null;
  baseLoading: boolean;
  catalog: EnvironmentToolCatalog | null;
  disabled: boolean;
  showId: boolean;
}) {
  const setTool = (group: ToolGroupKey, name: string, next: EnvironmentTool | null) => {
    const values = { ...form[group] } as Record<string, EnvironmentTool>;
    if (next) values[name] = next;
    else delete values[name];
    onChange({ ...form, [group]: values });
  };

  const inheritedEntries = TOOL_GROUPS.flatMap((group) => {
    const values = baseRevision?.flattenedRecipe[group.key] as
      | Partial<Record<string, EnvironmentTool>>
      | undefined;
    const groupCatalog = catalog?.[group.key] as
      | Record<string, EnvironmentToolCatalogItem>
      | undefined;
    return group.names.flatMap((name) => {
      const tool = values?.[name];
      return tool
        ? [
            {
              name,
              label: groupCatalog?.[name]?.label ?? name,
              version: tool.version,
            },
          ]
        : [];
    });
  });

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
          onValueChange={(value) =>
            onChange({
              ...form,
              baseEnvironmentId: value,
              tools: withoutBaseExpectations(form.tools),
              buildTools: withoutBaseExpectations(form.buildTools),
            })
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
          <Skeleton className="h-12 w-full" />
        ) : baseRevision ? (
          <div className="border-l-2 border-primary/30 pl-3">
            <p className="text-[11px] text-muted-foreground">
              Published revision{' '}
              <span className="font-mono text-foreground">{baseRevision.revisionId}</span>
            </p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {inheritedEntries.map((entry) => (
                <Badge key={entry.name} variant="outline" className="text-[10px]">
                  {entry.label} {entry.version}
                </Badge>
              ))}
            </div>
          </div>
        ) : (
          <p className="text-[11px] text-destructive">Published base revision unavailable</p>
        )}
      </div>

      {TOOL_GROUPS.map((group) => {
        const inheritedValues = baseRevision?.flattenedRecipe[group.key] as
          | Partial<Record<string, EnvironmentTool>>
          | undefined;
        const configuredValues = form[group.key] as Partial<Record<string, EnvironmentTool>>;
        const groupCatalog = catalog?.[group.key] as
          | Record<string, EnvironmentToolCatalogItem>
          | undefined;
        return (
          <div key={group.key} className="space-y-2">
            <h4 className="text-xs font-medium">{group.label}</h4>
            <div className="divide-y rounded border">
              {group.names.map((name) => {
                const catalogItem = groupCatalog?.[name];
                const inheritedTool = inheritedValues?.[name] ?? null;
                const configuredTool = configuredValues[name] ?? null;
                const configuredArchive =
                  configuredTool?.source === 'archive' ? configuredTool : null;
                const catalogArchives =
                  catalogItem?.versions.filter((tool) => tool.source === 'archive') ?? [];
                const archiveChoices =
                  configuredArchive &&
                  !catalogArchives.some((tool) => sameTool(tool, configuredArchive))
                    ? [configuredArchive, ...catalogArchives]
                    : catalogArchives;
                const inheritedMode = Boolean(inheritedTool && !configuredArchive);
                const selectedTool =
                  configuredArchive ?? inheritedTool ?? configuredTool ?? archiveChoices[0] ?? null;
                const optionalEnabled = Boolean(!inheritedTool && configuredTool);
                const inheritedAlternatives = archiveChoices.filter(
                  (tool) => !sameTool(tool, inheritedTool),
                );
                const showVersionSelect = Boolean(
                  selectedTool &&
                  ((inheritedTool && (configuredArchive || inheritedAlternatives.length > 0)) ||
                    (!inheritedTool && optionalEnabled && archiveChoices.length > 1)),
                );
                const platformPackage = Boolean(
                  selectedTool && catalogArchives.some((tool) => sameTool(tool, selectedTool)),
                );
                const sourceLabel = inheritedMode
                  ? `Inherited from ${baseEnvironment?.name ?? 'base environment'}`
                  : configuredArchive
                    ? platformPackage
                      ? 'Platform package'
                      : 'Existing custom package'
                    : configuredTool?.source === 'base'
                      ? 'Not present in selected base'
                      : archiveChoices.length
                        ? 'Available platform package'
                        : 'Not available';
                const label = catalogItem?.label ?? name;

                return (
                  <div
                    key={name}
                    className="grid min-h-20 gap-3 p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
                  >
                    <div className="min-w-0 space-y-1.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs font-medium">{label}</span>
                        {selectedTool && (
                          <Badge variant="outline" className="font-mono text-[10px]">
                            {selectedTool.version}
                          </Badge>
                        )}
                      </div>
                      <p
                        className={cn(
                          'text-[11px] text-muted-foreground',
                          configuredTool?.source === 'base' && !inheritedTool && 'text-destructive',
                        )}
                      >
                        {sourceLabel}
                      </p>
                      <ToolProvenance
                        label={label}
                        publisher={catalogItem?.publisher ?? 'Official'}
                        tool={selectedTool}
                      />
                    </div>

                    <div className="flex items-center justify-end gap-2">
                      {showVersionSelect && (
                        <Select
                          value={
                            inheritedMode
                              ? 'inherit'
                              : configuredArchive
                                ? `archive:${toolIdentity(configuredArchive)}`
                                : undefined
                          }
                          disabled={disabled}
                          onValueChange={(value) => {
                            if (value === 'inherit') {
                              setTool(group.key, name, null);
                              return;
                            }
                            const selected = archiveChoices.find(
                              (tool) => `archive:${toolIdentity(tool)}` === value,
                            );
                            if (selected) setTool(group.key, name, cloneTool(selected));
                          }}
                        >
                          <SelectTrigger
                            aria-label={`${label} version`}
                            className="h-8 w-[180px] text-xs"
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {inheritedTool && (
                              <SelectItem value="inherit">
                                Base · {inheritedTool.version}
                              </SelectItem>
                            )}
                            {archiveChoices.map((tool) => (
                              <SelectItem
                                key={toolIdentity(tool)}
                                value={`archive:${toolIdentity(tool)}`}
                              >
                                {catalogArchives.some((entry) => sameTool(entry, tool))
                                  ? 'Platform'
                                  : 'Existing'}{' '}
                                · {tool.version}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                      {inheritedTool ? (
                        !showVersionSelect && (
                          <Badge variant="secondary" className="text-[10px]">
                            Included
                          </Badge>
                        )
                      ) : (
                        <Switch
                          aria-label={`Include ${label}`}
                          checked={optionalEnabled}
                          disabled={disabled || baseLoading || archiveChoices.length === 0}
                          onCheckedChange={(checked) =>
                            setTool(
                              group.key,
                              name,
                              checked && archiveChoices[0] ? cloneTool(archiveChoices[0]) : null,
                            )
                          }
                        />
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}

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
  const severityRank: Record<string, number> = {
    CRITICAL: 0,
    HIGH: 1,
    MEDIUM: 2,
    LOW: 3,
    INFORMATIONAL: 4,
    UNDEFINED: 5,
  };
  const scanEntries = Object.entries(revision.scanFindings?.severityCounts ?? {}).toSorted(
    ([left], [right]) =>
      (severityRank[left] ?? 99) - (severityRank[right] ?? 99) || left.localeCompare(right),
  );
  const findings = revision.scanFindings?.findings ?? [];
  const acceptedAt = securityFindingsAcceptedAt(revision);
  const acceptedBy = securityFindingsAcceptedBy(revision);
  const critical = Number(revision.scanFindings?.severityCounts?.CRITICAL ?? 0);
  const high = Number(revision.scanFindings?.severityCounts?.HIGH ?? 0);
  const elevatedFindings = critical + high > 0;
  const securityOnlyFailure =
    revision.failure?.reason === 'critical_vulnerability_findings' && Boolean(revision.imageDigest);
  const verificationEntries = Object.entries(revision.verification ?? {}).filter(
    ([key]) => !['capabilities', 'completedAt'].includes(key),
  );
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
          ) : revision.failure?.reason === 'image_build_failed' ? (
            <Badge variant="outline" className={statusClass('FAILED')}>
              Build failed
            </Badge>
          ) : (
            <span className="text-[11px] text-muted-foreground">Not built</span>
          )}
          <p className="break-all font-mono text-[11px] text-muted-foreground">
            {revision.imageDigest ?? 'No image digest'}
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
          {revision.scanFindings ? (
            acceptedAt ? (
              <Badge variant="outline" className={statusClass('SECURITY_REVIEW')}>
                Findings accepted
              </Badge>
            ) : elevatedFindings ? (
              <Badge variant="outline" className={statusClass('SECURITY_REVIEW')}>
                Review required
              </Badge>
            ) : (
              <Badge
                variant="outline"
                className="border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
              >
                Passed
              </Badge>
            )
          ) : (
            <span className="text-[11px] text-muted-foreground">Not completed</span>
          )}
          <div className="flex flex-wrap gap-1.5">
            {scanEntries.length ? (
              scanEntries.map(([severity, count]) => (
                <Badge
                  key={severity}
                  variant="outline"
                  className={cn('font-mono text-[10px]', severityClass(severity))}
                >
                  {severity} {count}
                </Badge>
              ))
            ) : (
              <span className="text-[11px] text-muted-foreground">No findings recorded</span>
            )}
          </div>
          {acceptedAt && (
            <p className="text-[11px] text-muted-foreground">
              Accepted{acceptedBy ? ` by ${acceptedBy}` : ''}{' '}
              <time dateTime={acceptedAt}>{new Date(acceptedAt).toLocaleString()}</time>
            </p>
          )}
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
      {findings.length > 0 && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="text-xs font-medium">Identified security issues</h4>
            <span className="text-[11px] text-muted-foreground">
              {findings.length} finding{findings.length === 1 ? '' : 's'}
              {revision.scanFindings?.findingsTruncated ? ' shown' : ''}
            </span>
          </div>
          <div className="divide-y overflow-hidden rounded border">
            {findings.map((finding, index) => (
              <div
                key={`${finding.id}-${finding.packageName ?? 'package'}-${index}`}
                className="grid min-w-0 gap-2 px-3 py-2 sm:grid-cols-[90px_minmax(0,1fr)_minmax(150px,auto)] sm:items-center"
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
                    className="inline-flex min-w-0 items-center gap-1 font-mono text-[11px] text-primary hover:underline"
                  >
                    <span className="truncate">{finding.id}</span>
                    <ExternalLink className="h-3 w-3 shrink-0" />
                  </a>
                ) : (
                  <span className="truncate font-mono text-[11px]">{finding.id}</span>
                )}
                <span className="break-words font-mono text-[11px] text-muted-foreground">
                  {finding.packageName ?? 'Unknown package'}
                  {finding.packageVersion ? ` ${finding.packageVersion}` : ''}
                </span>
              </div>
            ))}
          </div>
          {revision.scanFindings?.findingsTruncated && (
            <p className="text-[11px] text-muted-foreground">
              Additional findings are available in the image registry scan.
            </p>
          )}
        </div>
      )}
      {revision.failure && !securityOnlyFailure && (
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
  const [catalog, setCatalog] = useState<EnvironmentToolCatalog | null>(null);
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
    Promise.all([loadList(), environmentsService.catalog()])
      .then(([, value]) => setCatalog(value))
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

  useEffect(() => {
    const baseEnvironmentId = form.baseEnvironmentId;
    if (!baseEnvironmentId) {
      setBaseDetail(null);
      setBaseLoading(false);
      return;
    }
    let active = true;
    setBaseLoading(true);
    void environmentsService
      .get(baseEnvironmentId)
      .then((value) => {
        if (active) setBaseDetail(value);
      })
      .catch((err) => {
        if (active) {
          setBaseDetail(null);
          setError(err instanceof Error ? err.message : 'Failed to load base environment');
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
  const activeBaseDetail =
    baseDetail?.environment.environmentId === form.baseEnvironmentId ? baseDetail : null;
  const baseEnvironment =
    environments.find((environment) => environment.environmentId === form.baseEnvironmentId) ??
    activeBaseDetail?.environment ??
    null;
  const baseRevision =
    activeBaseDetail?.publishedRevision ??
    activeBaseDetail?.revisions.find(
      (revision) => revision.revisionId === activeBaseDetail.environment.publishedRevisionId,
    ) ??
    null;

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
  const selectedFindingsAcceptedAt = selectedRevision
    ? securityFindingsAcceptedAt(selectedRevision)
    : null;
  const selectedLegacySecurityFailure =
    selectedRevision?.status === 'FAILED' &&
    selectedRevision.failure?.reason === 'critical_vulnerability_findings' &&
    Boolean(selectedRevision.imageDigest);
  const selectedRequiresSecurityAcceptance =
    Boolean(selectedRevision) &&
    !selectedFindingsAcceptedAt &&
    (selectedRevision?.status === 'SECURITY_REVIEW' || selectedLegacySecurityFailure);

  const acceptSelectedSecurityFindings = () => {
    if (!environment || !selectedRevision || !selectedRequiresSecurityAcceptance) return;
    const critical = Number(selectedRevision.scanFindings?.severityCounts?.CRITICAL ?? 0);
    const high = Number(selectedRevision.scanFindings?.severityCounts?.HIGH ?? 0);
    const findingSummary =
      [critical > 0 ? `${critical} Critical` : null, high > 0 ? `${high} High` : null]
        .filter(Boolean)
        .join(' and ') || 'the recorded';
    if (
      !window.confirm(
        `Accept ${findingSummary} security findings and continue to runtime validation? The findings will remain visible after publication.`,
      )
    ) {
      return;
    }
    void run('accept-findings', () =>
      environmentsService.acceptFindings(environment.environmentId, selectedRevision.revisionId),
    );
  };

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
                  baseEnvironment={baseEnvironment}
                  baseRevision={baseRevision}
                  baseLoading={baseLoading}
                  catalog={catalog}
                  disabled={Boolean(busy)}
                  showId
                />
                <Button
                  size="sm"
                  className="gap-1.5"
                  disabled={
                    Boolean(busy) ||
                    baseLoading ||
                    !catalog ||
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
                    {selectedRequiresSecurityAcceptance && (
                      <Button
                        size="sm"
                        className="gap-1.5"
                        disabled={Boolean(busy)}
                        onClick={acceptSelectedSecurityFindings}
                      >
                        <ShieldAlert className="h-3.5 w-3.5" />
                        Accept Findings &amp; Continue
                      </Button>
                    )}
                    {selectedRevision?.status === 'SECURITY_REVIEW' &&
                      selectedFindingsAcceptedAt && (
                        <Badge
                          variant="outline"
                          className={cn('gap-1.5', statusClass('SECURITY_REVIEW'))}
                        >
                          <ShieldCheck className="h-3.5 w-3.5" />
                          Accepted · validation pending
                        </Badge>
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
                      baseEnvironment={baseEnvironment}
                      baseRevision={baseRevision}
                      baseLoading={baseLoading}
                      catalog={catalog}
                      disabled={Boolean(busy)}
                      showId={false}
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-1.5"
                      disabled={
                        Boolean(busy) ||
                        baseLoading ||
                        !catalog ||
                        !baseRevision ||
                        !form.name.trim()
                      }
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
