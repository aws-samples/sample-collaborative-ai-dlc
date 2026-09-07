import { useMemo, useState } from 'react';
import {
  Box,
  Check,
  ChevronDown,
  CircleGauge,
  Info,
  Layers3,
  Loader2,
  PackagePlus,
  Plus,
  Save,
  Search,
  Settings2,
  Trash2,
  Wrench,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import type {
  EnvironmentRevision,
  ManagedEnvironment,
  ManagedTool,
  ManagedToolVersion,
} from '@/services/environments';
import { cn } from '@/lib/utils';
import {
  RUNTIME_IMAGE_LIMIT_BYTES,
  environmentIdPreview,
  protectedRuntimeVersions,
  resolvedTools,
  validateEnvironmentForm,
  type EnvironmentForm,
  type KeyValueEntry,
} from './model';
import { ProcessOverview, Section } from './ui';

interface Props {
  form: EnvironmentForm;
  onChange: (next: EnvironmentForm) => void;
  baseOptions: ManagedEnvironment[];
  baseEnvironment: ManagedEnvironment | null;
  baseRevision: EnvironmentRevision | null;
  baseLoading: boolean;
  tools: ManagedTool[];
  disabled: boolean;
  showId: boolean;
  actionLabel: string;
  actionBusy: boolean;
  actionDisabled: boolean;
  onAction: () => void;
}

const publishedVersions = (tool: ManagedTool) =>
  tool.versions.filter((version) => version.status === 'PUBLISHED');

const recommendedVersion = (tool: ManagedTool) =>
  publishedVersions(tool).find((version) => version.versionId === tool.recommendedVersionId) ??
  publishedVersions(tool)[0] ??
  null;

const distributionName = (tool: ManagedTool, version: ManagedToolVersion | null | undefined) =>
  version?.definition.distribution ?? version?.definition.publisher ?? tool.publisher;

const ENVIRONMENT_PROCESS_STEPS = [
  {
    label: 'Define',
    description: 'Choose the base, tools, and optional settings.',
  },
  {
    label: 'Build',
    description: 'CodeBuild composes the immutable environment image.',
  },
  {
    label: 'Check',
    description: 'Automatic image and package checks run.',
  },
  {
    label: 'Verify',
    description: 'The platform starts the runtime and validates its behavior.',
  },
  {
    label: 'Publish',
    description: 'Make the revision available to projects.',
  },
] as const;

function KeyValueListEditor({
  entries,
  onChange,
  nameLabel,
  valueLabel,
  namePlaceholder,
  valuePlaceholder,
  addLabel,
  disabled,
}: {
  entries: KeyValueEntry[];
  onChange: (entries: KeyValueEntry[]) => void;
  nameLabel: string;
  valueLabel: string;
  namePlaceholder: string;
  valuePlaceholder: string;
  addLabel: string;
  disabled: boolean;
}) {
  const update = (index: number, patch: Partial<KeyValueEntry>) =>
    onChange(entries.map((entry, current) => (current === index ? { ...entry, ...patch } : entry)));

  return (
    <div className="space-y-2.5">
      {entries.map((entry, index) => (
        <div
          key={index}
          className="grid gap-2 rounded-lg border bg-background p-2.5 sm:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)_auto]"
        >
          <div>
            <Label htmlFor={`${nameLabel}-${index}`} className="sr-only">
              {nameLabel} {index + 1}
            </Label>
            <Input
              id={`${nameLabel}-${index}`}
              aria-label={`${nameLabel} ${index + 1}`}
              value={entry.name}
              onChange={(event) => update(index, { name: event.target.value })}
              placeholder={namePlaceholder}
              disabled={disabled}
              className="h-8 font-mono text-xs"
            />
          </div>
          <div>
            <Label htmlFor={`${valueLabel}-${index}`} className="sr-only">
              {valueLabel} {index + 1}
            </Label>
            <Input
              id={`${valueLabel}-${index}`}
              aria-label={`${valueLabel} ${index + 1}`}
              value={entry.value}
              onChange={(event) => update(index, { value: event.target.value })}
              placeholder={valuePlaceholder}
              disabled={disabled}
              className="h-8 font-mono text-xs"
            />
          </div>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="h-8 w-8 text-muted-foreground hover:text-destructive"
            aria-label={`Remove ${nameLabel.toLowerCase()} ${index + 1}`}
            disabled={disabled}
            onClick={() => onChange(entries.filter((_, current) => current !== index))}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="gap-1.5"
        disabled={disabled}
        onClick={() => onChange([...entries, { name: '', value: '' }])}
      >
        <Plus className="h-3.5 w-3.5" />
        {addLabel}
      </Button>
    </div>
  );
}

function CommandListEditor({
  commands,
  onChange,
  disabled,
}: {
  commands: string[];
  onChange: (commands: string[]) => void;
  disabled: boolean;
}) {
  return (
    <div className="space-y-2.5">
      {commands.map((command, index) => (
        <div
          key={index}
          className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 rounded-lg border bg-background p-2.5"
        >
          <Label htmlFor={`build-command-${index}`} className="sr-only">
            Build command {index + 1}
          </Label>
          <Input
            id={`build-command-${index}`}
            aria-label={`Build command ${index + 1}`}
            value={command}
            onChange={(event) =>
              onChange(
                commands.map((value, current) => (current === index ? event.target.value : value)),
              )
            }
            placeholder="apt-get update"
            disabled={disabled}
            className="h-8 font-mono text-xs"
          />
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="h-8 w-8 text-muted-foreground hover:text-destructive"
            aria-label={`Remove build command ${index + 1}`}
            disabled={disabled}
            onClick={() => onChange(commands.filter((_, current) => current !== index))}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="gap-1.5"
        disabled={disabled || commands.length >= 20}
        onClick={() => onChange([...commands, ''])}
      >
        <Plus className="h-3.5 w-3.5" />
        Add command
      </Button>
    </div>
  );
}

export function EnvironmentBuilder({
  form,
  onChange,
  baseOptions,
  baseEnvironment,
  baseRevision,
  baseLoading,
  tools,
  disabled,
  showId,
  actionLabel,
  actionBusy,
  actionDisabled,
  onAction,
}: Props) {
  const [toolSearch, setToolSearch] = useState('');
  const [toolFilter, setToolFilter] = useState<'all' | 'included'>('all');
  const [advancedOpen, setAdvancedOpen] = useState(
    form.aptPackages.length > 0 ||
      form.environmentVariables.length > 0 ||
      form.buildCommands.length > 0,
  );

  const composition = useMemo(() => {
    const inherited = resolvedTools(baseRevision);
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

    return {
      inherited,
      inheritedById,
      selectedVersions,
      effectiveSelectedVersions,
      requiredBy,
      projectedSize,
    };
  }, [baseRevision, form.toolVersionIds, tools]);

  const protectedVersions = protectedRuntimeVersions(baseRevision);
  const setVersion = (tool: ManagedTool, versionId: string | null) => {
    const familyVersionIds = new Set(tool.versions.map((version) => version.versionId));
    const remaining = form.toolVersionIds.filter((id) => !familyVersionIds.has(id));
    onChange({
      ...form,
      toolVersionIds: versionId ? [...remaining, versionId] : remaining,
    });
  };

  const visibleTools = tools.filter((tool) => {
    const query = toolSearch.trim().toLowerCase();
    const included =
      composition.inheritedById.has(tool.toolId) ||
      composition.effectiveSelectedVersions.has(tool.toolId);
    if (toolFilter === 'included' && !included) return false;
    return (
      !query ||
      tool.name.toLowerCase().includes(query) ||
      tool.description.toLowerCase().includes(query) ||
      tool.publisher.toLowerCase().includes(query) ||
      tool.category.toLowerCase().includes(query) ||
      tool.versions.some(
        (version) =>
          version.definition.distribution?.toLowerCase().includes(query) ||
          version.definition.publisher?.toLowerCase().includes(query),
      )
    );
  });

  const customSettingCount =
    form.aptPackages.filter((entry) => entry.name.trim() || entry.value.trim()).length +
    form.environmentVariables.filter((entry) => entry.name.trim() || entry.value).length +
    form.buildCommands.filter((command) => command.trim()).length;
  const issues = validateEnvironmentForm(form, composition.projectedSize);
  const selectedSummary = tools
    .map((tool) => ({
      tool,
      version: composition.effectiveSelectedVersions.get(tool.toolId),
      inherited: composition.inheritedById.get(tool.toolId),
    }))
    .filter(({ version, inherited }) => version || inherited);
  const progress =
    composition.projectedSize === null
      ? 0
      : Math.min(100, (composition.projectedSize / RUNTIME_IMAGE_LIMIT_BYTES) * 100);

  return (
    <div className="space-y-4">
      <ProcessOverview steps={[...ENVIRONMENT_PROCESS_STEPS]} />
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_280px] xl:items-start">
        <div className="min-w-0 space-y-4">
          <Section
            title="Environment details"
            description="Use a name people will recognize when assigning this environment to a space."
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="environment-name" className="text-xs">
                  Name
                </Label>
                <Input
                  id="environment-name"
                  value={form.name}
                  onChange={(event) => onChange({ ...form, name: event.target.value })}
                  placeholder="Java services"
                  disabled={disabled}
                  className="h-9 text-sm"
                />
              </div>
              {showId && (
                <div className="space-y-1.5">
                  <Label htmlFor="environment-id" className="text-xs">
                    Environment ID{' '}
                    <span className="font-normal text-muted-foreground">(optional)</span>
                  </Label>
                  <Input
                    id="environment-id"
                    value={form.environmentId}
                    onChange={(event) => onChange({ ...form, environmentId: event.target.value })}
                    placeholder={environmentIdPreview(form.name)}
                    disabled={disabled}
                    className="h-9 font-mono text-sm"
                  />
                  <p className="text-[11px] text-muted-foreground">
                    {form.environmentId.trim()
                      ? `Saved as ${environmentIdPreview(form.environmentId)}`
                      : `Generated as ${environmentIdPreview(form.name)}`}
                  </p>
                </div>
              )}
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="environment-description" className="text-xs">
                  Description
                </Label>
                <Textarea
                  id="environment-description"
                  value={form.description}
                  onChange={(event) => onChange({ ...form, description: event.target.value })}
                  placeholder="What this environment is for and who should use it."
                  disabled={disabled}
                  className="min-h-20 resize-y text-sm"
                />
              </div>
            </div>
          </Section>

          <Section
            title="Base environment"
            description="Start from a published environment. Its runtime and tools are inherited."
          >
            <div className="space-y-3">
              <div className="max-w-md space-y-1.5">
                <Label htmlFor="environment-base" className="text-xs">
                  Base
                </Label>
                <Select
                  value={form.baseEnvironmentId}
                  onValueChange={(baseEnvironmentId) => onChange({ ...form, baseEnvironmentId })}
                  disabled={disabled}
                >
                  <SelectTrigger id="environment-base" className="h-9 text-sm">
                    <SelectValue placeholder="Choose a base environment" />
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
              {baseLoading ? (
                <Skeleton className="h-20" />
              ) : baseRevision ? (
                <div className="rounded-lg border border-primary/20 bg-primary/[0.03] p-3">
                  <div className="flex items-start gap-2.5">
                    <Layers3 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                    <div className="min-w-0">
                      <p className="text-xs font-medium">
                        Inherited from {baseEnvironment?.name ?? 'the selected base'}
                      </p>
                      <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                        Protected runtime behavior remains unchanged. Add or override catalog tools
                        below.
                      </p>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        <Badge variant="secondary" className="text-[10px]">
                          Node.js{protectedVersions.node ? ` ${protectedVersions.node}` : ''}
                        </Badge>
                        <Badge variant="secondary" className="text-[10px]">
                          Python{protectedVersions.python ? ` ${protectedVersions.python}` : ''}
                        </Badge>
                        {composition.inherited.map((tool) => (
                          <Badge key={tool.toolId} variant="outline" className="text-[10px]">
                            {tool.name} {tool.version}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
                  The selected base does not have a published revision.
                </div>
              )}
            </div>
          </Section>

          <Section
            title="Tools"
            description="Add published tools. Dependencies are included automatically."
            badge={
              <Badge variant="secondary" className="text-[10px]">
                {selectedSummary.length} included
              </Badge>
            }
          >
            <div className="space-y-3">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <div className="relative min-w-0 flex-1">
                  <Search className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
                  <Input
                    aria-label="Search tools"
                    value={toolSearch}
                    onChange={(event) => setToolSearch(event.target.value)}
                    placeholder="Search tools, publishers or categories"
                    className="h-9 pl-8 text-xs"
                  />
                </div>
                <div className="flex rounded-lg border bg-muted/30 p-0.5">
                  <Button
                    type="button"
                    size="sm"
                    variant={toolFilter === 'all' ? 'secondary' : 'ghost'}
                    className="h-7 shadow-none"
                    aria-pressed={toolFilter === 'all'}
                    onClick={() => setToolFilter('all')}
                  >
                    All
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={toolFilter === 'included' ? 'secondary' : 'ghost'}
                    className="h-7 shadow-none"
                    aria-pressed={toolFilter === 'included'}
                    onClick={() => setToolFilter('included')}
                  >
                    Included
                  </Button>
                </div>
              </div>

              <div className="grid gap-2">
                {visibleTools.map((tool) => {
                  const versions = publishedVersions(tool);
                  const inheritedTool = composition.inheritedById.get(tool.toolId) ?? null;
                  const selected = composition.selectedVersions.get(tool.toolId) ?? null;
                  const effective = composition.effectiveSelectedVersions.get(tool.toolId) ?? null;
                  const required =
                    composition.requiredBy.has(tool.toolId) &&
                    !composition.inheritedById.has(tool.toolId);
                  const recommended = recommendedVersion(tool);
                  const included = Boolean(inheritedTool || effective);
                  const showVersionSelect =
                    Boolean(inheritedTool && versions.length) ||
                    Boolean(effective && versions.length > 1);
                  const displayedPublisher =
                    effective?.definition.publisher ??
                    inheritedTool?.publisher ??
                    recommended?.definition.publisher ??
                    tool.publisher;

                  return (
                    <div
                      key={tool.toolId}
                      className={cn(
                        'rounded-xl border p-3 transition-colors',
                        included && 'border-primary/25 bg-primary/[0.025]',
                      )}
                    >
                      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                        <div className="flex min-w-0 items-start gap-3">
                          <div
                            className={cn(
                              'mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border bg-muted/40 text-muted-foreground',
                              included && 'border-primary/20 bg-primary/10 text-primary',
                            )}
                          >
                            <Wrench className="h-3.5 w-3.5" />
                          </div>
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="text-xs font-semibold">{tool.name}</span>
                              {inheritedTool && !selected && (
                                <Badge variant="secondary" className="text-[9px]">
                                  Inherited
                                </Badge>
                              )}
                              {selected && (
                                <Badge variant="outline" className="text-[9px]">
                                  Added here
                                </Badge>
                              )}
                              {required && (
                                <Badge variant="secondary" className="text-[9px]">
                                  Required
                                </Badge>
                              )}
                            </div>
                            <p className="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">
                              {required
                                ? `Added automatically for ${[
                                    ...(composition.requiredBy.get(tool.toolId) ?? []),
                                  ].join(', ')}`
                                : `${displayedPublisher} · ${tool.category}`}
                            </p>
                            <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
                              {(effective?.definition.version ||
                                inheritedTool?.version ||
                                recommended) && (
                                <span className="font-mono text-foreground">
                                  {effective
                                    ? `${distributionName(tool, effective)} ${effective.definition.version}`
                                    : inheritedTool
                                      ? `${inheritedTool.distribution ?? inheritedTool.publisher} ${inheritedTool.version}`
                                      : recommended
                                        ? `${distributionName(tool, recommended)} ${recommended.definition.version}`
                                        : null}
                                </span>
                              )}
                              {effective?.imageSizeBytes && (
                                <span>
                                  {(effective.imageSizeBytes / 1024 / 1024).toFixed(0)} MiB
                                </span>
                              )}
                            </div>
                          </div>
                        </div>

                        <div className="flex flex-wrap items-center justify-end gap-2">
                          {showVersionSelect && (
                            <Select
                              value={selected?.versionId ?? effective?.versionId ?? 'inherit'}
                              disabled={disabled}
                              onValueChange={(value) =>
                                setVersion(tool, value === 'inherit' ? null : value)
                              }
                            >
                              <SelectTrigger
                                aria-label={`${tool.name} version`}
                                className="h-8 w-48 text-xs"
                              >
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {inheritedTool && (
                                  <SelectItem value="inherit">
                                    Base · {inheritedTool.version}
                                  </SelectItem>
                                )}
                                {versions.map((version) => (
                                  <SelectItem key={version.versionId} value={version.versionId}>
                                    {distributionName(tool, version)} · {version.definition.version}
                                    {version.versionId === tool.recommendedVersionId
                                      ? ' · recommended'
                                      : ''}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          )}
                          {required ? (
                            <div className="flex h-8 items-center gap-1.5 rounded-md border bg-muted/40 px-2.5 text-[10px] font-medium text-muted-foreground">
                              <Check className="h-3 w-3" />
                              Automatic
                            </div>
                          ) : selected ? (
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              className="gap-1.5"
                              disabled={disabled}
                              aria-label={
                                inheritedTool ? `Use base ${tool.name}` : `Remove ${tool.name}`
                              }
                              onClick={() => setVersion(tool, null)}
                            >
                              {inheritedTool ? (
                                <>
                                  <Layers3 className="h-3.5 w-3.5" />
                                  Use base
                                </>
                              ) : (
                                <>
                                  <Trash2 className="h-3.5 w-3.5" />
                                  Remove
                                </>
                              )}
                            </Button>
                          ) : inheritedTool ? (
                            <div className="flex h-8 items-center gap-1.5 rounded-md border bg-muted/40 px-2.5 text-[10px] font-medium text-muted-foreground">
                              <Check className="h-3 w-3" />
                              Included
                            </div>
                          ) : (
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              className="gap-1.5"
                              disabled={disabled || !recommended}
                              aria-label={`Add ${tool.name}`}
                              onClick={() => setVersion(tool, recommended?.versionId ?? null)}
                            >
                              <PackagePlus className="h-3.5 w-3.5" />
                              Add
                            </Button>
                          )}
                        </div>
                      </div>
                      {(effective?.definition.dependencies.length ?? 0) > 0 && (
                        <div className="mt-2 flex items-start gap-1.5 border-t pt-2 text-[10px] text-muted-foreground">
                          <Info className="mt-px h-3 w-3 shrink-0" />
                          Requires {effective?.definition.dependencies.join(', ')}. Missing
                          dependencies use their recommended published version.
                        </div>
                      )}
                    </div>
                  );
                })}
                {visibleTools.length === 0 && (
                  <div className="rounded-xl border border-dashed px-4 py-8 text-center">
                    <Wrench className="mx-auto h-5 w-5 text-muted-foreground/60" />
                    <p className="mt-2 text-xs font-medium">
                      {tools.length === 0 ? 'No published tools yet' : 'No tools match this view'}
                    </p>
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      {tools.length === 0
                        ? 'Publish a tool version before composing an environment.'
                        : 'Try another search or show all tools.'}
                    </p>
                  </div>
                )}
              </div>
            </div>
          </Section>

          <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
            <section className="rounded-xl border bg-card">
              <CollapsibleTrigger asChild>
                <button
                  type="button"
                  className="flex w-full items-center justify-between gap-3 px-4 py-3.5 text-left"
                >
                  <span className="flex items-start gap-3">
                    <Settings2 className="mt-0.5 h-4 w-4 text-muted-foreground" />
                    <span>
                      <span className="block text-sm font-semibold">Advanced settings</span>
                      <span className="mt-0.5 block text-xs font-normal text-muted-foreground">
                        Exact Debian packages, non-secret variables, and restricted build commands.
                      </span>
                    </span>
                  </span>
                  <span className="flex items-center gap-2">
                    {customSettingCount > 0 && (
                      <Badge variant="secondary" className="text-[10px]">
                        {customSettingCount}
                      </Badge>
                    )}
                    <ChevronDown
                      className={cn(
                        'h-4 w-4 text-muted-foreground transition-transform',
                        advancedOpen && 'rotate-180',
                      )}
                    />
                  </span>
                </button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="space-y-5 border-t p-4">
                  <div className="space-y-2">
                    <div>
                      <h5 className="text-xs font-semibold">Debian packages</h5>
                      <p className="mt-0.5 text-[11px] text-muted-foreground">
                        Every package needs an exact version.
                      </p>
                    </div>
                    <KeyValueListEditor
                      entries={form.aptPackages}
                      onChange={(aptPackages) => onChange({ ...form, aptPackages })}
                      nameLabel="Package name"
                      valueLabel="Package version"
                      namePlaceholder="libssl-dev"
                      valuePlaceholder="3.0.17-1~deb12u2"
                      addLabel="Add package"
                      disabled={disabled}
                    />
                  </div>

                  <div className="space-y-2">
                    <div>
                      <h5 className="text-xs font-semibold">Environment variables</h5>
                      <p className="mt-0.5 text-[11px] text-muted-foreground">
                        Variables are visible to platform administrators. Do not add secrets.
                      </p>
                    </div>
                    <KeyValueListEditor
                      entries={form.environmentVariables}
                      onChange={(environmentVariables) =>
                        onChange({ ...form, environmentVariables })
                      }
                      nameLabel="Variable name"
                      valueLabel="Variable value"
                      namePlaceholder="JAVA_HOME"
                      valuePlaceholder="/opt/runtime"
                      addLabel="Add variable"
                      disabled={disabled}
                    />
                  </div>

                  <div className="space-y-2">
                    <div>
                      <h5 className="text-xs font-semibold">Build commands</h5>
                      <p className="mt-0.5 text-[11px] text-muted-foreground">
                        Commands run while the image is built. Protected runtime behavior cannot be
                        changed.
                      </p>
                    </div>
                    <CommandListEditor
                      commands={form.buildCommands}
                      onChange={(buildCommands) => onChange({ ...form, buildCommands })}
                      disabled={disabled}
                    />
                  </div>
                </div>
              </CollapsibleContent>
            </section>
          </Collapsible>
        </div>

        <aside className="space-y-3 xl:sticky xl:top-0">
          <div className="rounded-xl border bg-card p-4 shadow-sm">
            <div className="flex items-center gap-2">
              <CircleGauge className="h-4 w-4 text-primary" />
              <h4 className="text-sm font-semibold">Composition</h4>
            </div>
            <div className="mt-4 space-y-3">
              <div className="flex items-start justify-between gap-3 text-xs">
                <span className="text-muted-foreground">Base</span>
                <span className="text-right font-medium">
                  {baseEnvironment?.name ?? 'Not selected'}
                </span>
              </div>
              <div className="flex items-start justify-between gap-3 text-xs">
                <span className="text-muted-foreground">Tools</span>
                <span className="font-medium">{selectedSummary.length}</span>
              </div>
              <div className="flex items-start justify-between gap-3 text-xs">
                <span className="text-muted-foreground">Custom settings</span>
                <span className="font-medium">{customSettingCount}</span>
              </div>

              <div className="border-t pt-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-muted-foreground">Projected image</span>
                  <span
                    className={cn(
                      'font-mono text-[10px] font-medium',
                      composition.projectedSize !== null &&
                        composition.projectedSize > RUNTIME_IMAGE_LIMIT_BYTES &&
                        'text-destructive',
                    )}
                  >
                    {composition.projectedSize === null
                      ? 'Available after tool builds'
                      : `${(composition.projectedSize / 1024 / 1024).toFixed(0)} / 2048 MiB`}
                  </span>
                </div>
                <Progress
                  value={progress}
                  aria-label="Projected image size"
                  className={cn(
                    'mt-2 h-1.5',
                    composition.projectedSize !== null &&
                      composition.projectedSize > RUNTIME_IMAGE_LIMIT_BYTES &&
                      '[&>div]:bg-destructive',
                  )}
                />
              </div>

              {selectedSummary.length > 0 && (
                <div className="border-t pt-3">
                  <p className="mb-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    Effective tools
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {selectedSummary.map(({ tool, version, inherited }) => (
                      <Badge key={tool.toolId} variant="outline" className="max-w-full text-[9px]">
                        <span className="truncate">{tool.name}</span>
                        <span className="ml-1 font-mono text-muted-foreground">
                          {version
                            ? `${distributionName(tool, version)} ${version.definition.version}`
                            : `${inherited?.distribution ?? inherited?.publisher ?? ''} ${inherited?.version ?? ''}`}
                        </span>
                      </Badge>
                    ))}
                  </div>
                </div>
              )}

              {issues.length > 0 && (
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-2.5">
                  <p className="text-[11px] font-medium text-amber-800 dark:text-amber-200">
                    Before saving
                  </p>
                  <ul className="mt-1.5 space-y-1 text-[10px] leading-relaxed text-amber-800/90 dark:text-amber-200/90">
                    {issues.map((issue) => (
                      <li key={issue} className="flex items-start gap-1.5">
                        <span aria-hidden="true">•</span>
                        <span>{issue}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
            <div className="mt-4 border-t pt-4">
              <Button
                className="w-full gap-1.5"
                disabled={actionDisabled || issues.length > 0}
                aria-busy={actionBusy}
                onClick={onAction}
              >
                {actionBusy ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Save className="h-3.5 w-3.5" />
                )}
                {actionLabel}
              </Button>
            </div>
          </div>

          <div className="rounded-xl border bg-muted/20 p-3">
            <div className="flex items-start gap-2">
              <Box className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <p className="text-[10px] leading-relaxed text-muted-foreground">
                Saving creates an immutable draft revision. Build and publish it from the Revisions
                view when the definition is ready.
              </p>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
