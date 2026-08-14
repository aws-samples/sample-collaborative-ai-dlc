import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CircleCheck,
  ExternalLink,
  Hammer,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Rocket,
  ShieldAlert,
  Star,
  Trash2,
  Wrench,
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
  toolsService,
  type ManagedTool,
  type ManagedToolVersion,
  type ToolExecutable,
  type ToolVerification,
  type ToolVersionDefinition,
} from '@/services/environments';
import { cn } from '@/lib/utils';

const ACTIVE_STATUSES = new Set(['QUEUED', 'BUILDING', 'SCANNING']);
const PRESETS = ['generic', 'java', 'go', 'rust', 'maven', 'gradle', 'dotnet'] as const;
type VerificationPreset = (typeof PRESETS)[number];

const RUST_INSTALLER_SCRIPT = `#!/usr/bin/env bash
set -Eeuo pipefail
staging="$TOOL_OUTPUT/.rust-installer"
archive_root="rust-\${TOOL_VERSION}-aarch64-unknown-linux-gnu"
components="rustc,rust-std-aarch64-unknown-linux-gnu,cargo,rustfmt-preview"
mkdir -p "$staging"
trap 'rm -rf "$staging"' EXIT
tar -xzf "$TOOL_SOURCE" -C "$staging" \\
  "$archive_root/install.sh" \\
  "$archive_root/components" \\
  "$archive_root/rust-installer-version" \\
  "$archive_root/rustc" \\
  "$archive_root/rust-std-aarch64-unknown-linux-gnu" \\
  "$archive_root/cargo" \\
  "$archive_root/rustfmt-preview"
installer="$staging/$archive_root/install.sh"
test -f "$installer"
"$installer" \\
  --prefix="$TOOL_OUTPUT" \\
  --disable-ldconfig \\
  --components="$components"
`;

const presetDefaults = (
  preset: VerificationPreset,
  version: string,
): {
  category: 'language-sdk' | 'build-tool' | 'cli';
  stripComponents: number;
  installerMode: 'generated' | 'script';
  installerScript: string;
  executables: ToolExecutable[];
  verification: ToolVerification;
  dependencies: string[];
  aptPackages: string;
  environmentVariables: string;
} => {
  const values: Record<
    VerificationPreset,
    {
      category: 'language-sdk' | 'build-tool' | 'cli';
      stripComponents: number;
      executables: ToolExecutable[];
      argv: string[];
      expected: string;
      dependencies?: string[];
      aptPackages?: string;
      environmentVariables?: string;
      installerScript?: string;
    }
  > = {
    generic: {
      category: 'cli',
      stripComponents: 1,
      executables: [{ name: 'tool', path: 'bin/tool' }],
      argv: ['tool', '--version'],
      expected: version,
    },
    java: {
      category: 'language-sdk',
      stripComponents: 1,
      executables: [
        { name: 'java', path: 'bin/java' },
        { name: 'javac', path: 'bin/javac' },
        { name: 'jar', path: 'bin/jar' },
      ],
      argv: ['java', '-version'],
      expected: version,
      environmentVariables: 'JAVA_HOME=${TOOL_ROOT}',
    },
    go: {
      category: 'language-sdk',
      stripComponents: 1,
      executables: [
        { name: 'go', path: 'bin/go' },
        { name: 'gofmt', path: 'bin/gofmt' },
      ],
      argv: ['go', 'version'],
      expected: `go${version}`,
      environmentVariables: 'GOROOT=${TOOL_ROOT}',
    },
    rust: {
      category: 'language-sdk',
      stripComponents: 1,
      executables: [
        { name: 'rustc', path: 'bin/rustc' },
        { name: 'cargo', path: 'bin/cargo' },
        { name: 'rustfmt', path: 'bin/rustfmt' },
      ],
      argv: ['rustc', '--version'],
      expected: version,
      aptPackages: 'build-essential=12.9',
      installerScript: RUST_INSTALLER_SCRIPT,
    },
    maven: {
      category: 'build-tool',
      stripComponents: 1,
      executables: [{ name: 'mvn', path: 'bin/mvn' }],
      argv: ['mvn', '--version'],
      expected: version,
      dependencies: ['java'],
    },
    gradle: {
      category: 'build-tool',
      stripComponents: 1,
      executables: [{ name: 'gradle', path: 'bin/gradle' }],
      argv: ['gradle', '--version'],
      expected: version,
      dependencies: ['java'],
    },
    dotnet: {
      category: 'language-sdk',
      stripComponents: 0,
      executables: [{ name: 'dotnet', path: 'dotnet' }],
      argv: ['dotnet', '--version'],
      expected: version,
      environmentVariables: 'DOTNET_ROOT=${TOOL_ROOT}',
    },
  };
  const selected = values[preset];
  return {
    category: selected.category,
    stripComponents: selected.stripComponents,
    installerMode: selected.installerScript ? 'script' : 'generated',
    installerScript: selected.installerScript ?? '',
    executables: selected.executables,
    dependencies: selected.dependencies ?? [],
    aptPackages: selected.aptPackages ?? '',
    environmentVariables: selected.environmentVariables ?? '',
    verification: {
      preset,
      versionCommand: { argv: selected.argv, expected: selected.expected },
      script: '',
      files: [],
    },
  };
};

interface ToolForm {
  toolId: string;
  name: string;
  description: string;
  category: string;
  publisher: string;
  version: string;
  sourceUrl: string;
  preset: VerificationPreset;
  installerMode: 'generated' | 'script';
  stripComponents: number;
  installerScript: string;
  executables: string;
  dependencies: string[];
  aptPackages: string;
  environmentVariables: string;
  versionCommand: string;
  expectedVersion: string;
  verificationScript: string;
  verificationFiles: { path: string; content: string }[];
  publisherChecksum: string;
  publisherChecksumAlgorithm: 'sha256' | 'sha512';
  publisherEvidenceUrl: string;
}

const emptyForm = (tool?: ManagedTool | null): ToolForm => {
  const defaults = presetDefaults('generic', '');
  return {
    toolId: tool?.toolId ?? '',
    name: tool?.name ?? '',
    description: tool?.description ?? '',
    category: tool?.category ?? 'cli',
    publisher: tool?.publisher ?? '',
    version: '',
    sourceUrl: '',
    preset: 'generic',
    installerMode: defaults.installerMode,
    stripComponents: defaults.stripComponents,
    installerScript: defaults.installerScript,
    executables: defaults.executables.map((entry) => `${entry.name}=${entry.path}`).join('\n'),
    dependencies: [],
    aptPackages: defaults.aptPackages,
    environmentVariables: defaults.environmentVariables,
    versionCommand: defaults.verification.versionCommand.argv.join(' '),
    expectedVersion: '',
    verificationScript: '',
    verificationFiles: [],
    publisherChecksum: '',
    publisherChecksumAlgorithm: 'sha256',
    publisherEvidenceUrl: '',
  };
};

const formFromVersion = (tool: ManagedTool, version: ManagedToolVersion): ToolForm => ({
  toolId: tool.toolId,
  name: tool.name,
  description: tool.description,
  category: tool.category,
  publisher: tool.publisher,
  version: version.definition.version,
  sourceUrl: version.definition.source.url,
  preset: version.definition.verification.preset,
  installerMode: version.definition.installer.mode,
  stripComponents:
    version.definition.installer.mode === 'generated'
      ? version.definition.installer.stripComponents
      : 1,
  installerScript:
    version.definition.installer.mode === 'script' ? version.definition.installer.script : '',
  executables: version.definition.executables
    .map((entry) => `${entry.name}=${entry.path}`)
    .join('\n'),
  dependencies: version.definition.dependencies,
  aptPackages: version.definition.aptPackages
    .map((entry) => `${entry.name}=${entry.version}`)
    .join('\n'),
  environmentVariables: Object.entries(version.definition.environmentVariables)
    .map(([name, value]) => `${name}=${value}`)
    .join('\n'),
  versionCommand: version.definition.verification.versionCommand.argv.join(' '),
  expectedVersion: version.definition.verification.versionCommand.expected,
  verificationScript: version.definition.verification.script,
  verificationFiles: version.definition.verification.files.map((entry) => ({ ...entry })),
  publisherChecksum: version.definition.source.expectedChecksum?.value ?? '',
  publisherChecksumAlgorithm: version.definition.source.expectedChecksum?.algorithm ?? 'sha256',
  publisherEvidenceUrl: version.definition.source.expectedChecksum?.evidenceUrl ?? '',
});

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

const definitionFromForm = (form: ToolForm): ToolVersionDefinition => ({
  schemaVersion: 1,
  version: form.version.trim(),
  source: {
    type: 'https',
    url: form.sourceUrl.trim(),
    ...(form.publisherChecksum.trim()
      ? {
          expectedChecksum: {
            algorithm: form.publisherChecksumAlgorithm,
            value: form.publisherChecksum.trim().toLowerCase(),
            ...(form.publisherEvidenceUrl.trim()
              ? { evidenceUrl: form.publisherEvidenceUrl.trim() }
              : {}),
          },
        }
      : {}),
  },
  installer:
    form.installerMode === 'script'
      ? { mode: 'script', script: form.installerScript }
      : { mode: 'generated', stripComponents: form.stripComponents },
  executables: parsePairs(form.executables).map(([name, path]) => ({ name, path })),
  dependencies: form.dependencies,
  aptPackages: parsePairs(form.aptPackages).map(([name, version]) => ({ name, version })),
  environmentVariables: Object.fromEntries(parsePairs(form.environmentVariables)),
  verification: {
    preset: form.preset,
    versionCommand: {
      argv: form.versionCommand
        .split(/\s+/)
        .map((part) => part.trim())
        .filter(Boolean),
      expected: form.expectedVersion.trim(),
    },
    script: form.verificationScript,
    files: form.verificationFiles,
  },
});

const statusClass = (status: string) => {
  if (status === 'FAILED') return 'border-destructive/30 bg-destructive/10 text-destructive';
  if (status === 'PUBLISHED' || status === 'READY')
    return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300';
  if (status === 'SECURITY_REVIEW')
    return 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300';
  if (ACTIVE_STATUSES.has(status))
    return 'border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300';
  return 'bg-muted/50 text-muted-foreground';
};

function ToolStatus({ status }: { status: string }) {
  return (
    <Badge variant="outline" className={cn('font-mono text-[10px]', statusClass(status))}>
      {status.replaceAll('_', ' ')}
    </Badge>
  );
}

function VersionEvidence({ version }: { version: ManagedToolVersion }) {
  const findings = version.scanFindings?.findings ?? [];
  const scanUnsupported = version.scanFindings?.status === 'UNSUPPORTED';
  const scanLimitationAccepted =
    scanUnsupported &&
    (version.verification?.securityScan === 'ACCEPTED' ||
      Boolean(version.securityFindingsAcceptedAt));
  return (
    <div className="space-y-3 border-t pt-4">
      <div className="grid gap-4 sm:grid-cols-3">
        <div>
          <p className="text-[11px] text-muted-foreground">Source integrity</p>
          <p className="mt-1 text-xs font-medium">
            {version.source?.trustLevel === 'PUBLISHER_VERIFIED'
              ? 'Publisher verified'
              : version.source
                ? 'Platform pinned'
                : 'Pending'}
          </p>
          {version.source && (
            <>
              <p className="mt-1 break-all font-mono text-[10px] text-muted-foreground">
                sha256:{version.source.sha256}
              </p>
              <a
                href={version.source.requestedUrl}
                target="_blank"
                rel="noreferrer"
                className="mt-1 inline-flex items-center gap-1 text-xs text-primary hover:underline"
              >
                Official source <ExternalLink className="h-3 w-3" />
              </a>
            </>
          )}
        </div>
        <div>
          <p className="text-[11px] text-muted-foreground">Artifact</p>
          <p className="mt-1 font-mono text-[10px]">
            {version.imageSizeBytes
              ? `${(version.imageSizeBytes / 1024 / 1024).toFixed(1)} MiB`
              : 'Pending'}
          </p>
          <p className="mt-1 break-all font-mono text-[10px] text-muted-foreground">
            {version.imageDigest ?? 'No digest'}
          </p>
        </div>
        <div>
          <p className="text-[11px] text-muted-foreground">Verification</p>
          <p className="mt-1 text-xs">
            {version.verification ? 'ARM64 and functional checks passed' : 'Pending'}
          </p>
          {version.scanFindings?.status && (
            <p className="mt-1 text-[11px] text-muted-foreground">
              {scanUnsupported
                ? scanLimitationAccepted
                  ? 'ECR scan limitation accepted'
                  : 'ECR scan unavailable'
                : `ECR scan ${version.scanFindings.status.toLowerCase()}`}
            </p>
          )}
          {version.scanFindings?.description && !scanLimitationAccepted && (
            <p className="mt-1 text-[11px] text-muted-foreground">
              {version.scanFindings.description}
            </p>
          )}
          {typeof version.verification?.runtimeCompatibilityVersion === 'string' && (
            <p className="mt-1 font-mono text-[10px] text-muted-foreground">
              Runtime contract {String(version.verification.runtimeCompatibilityVersion)}
            </p>
          )}
          {version.buildLogUrl && (
            <a
              href={version.buildLogUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-1 inline-flex items-center gap-1 text-xs text-primary hover:underline"
            >
              Build logs <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
      </div>
      {findings.length > 0 && (
        <div className="divide-y overflow-hidden rounded border">
          {findings.map((finding, index) => (
            <div
              key={`${finding.id}-${index}`}
              className="grid gap-2 px-3 py-2 text-[11px] sm:grid-cols-[80px_minmax(0,1fr)_auto]"
            >
              <Badge variant="outline" className="w-fit font-mono text-[10px]">
                {finding.severity}
              </Badge>
              <span className="truncate font-mono">{finding.id}</span>
              {finding.uri ? (
                <a
                  href={finding.uri}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 font-mono text-primary hover:underline"
                >
                  {finding.packageName ?? 'Unknown package'}
                  {finding.packageVersion ? ` ${finding.packageVersion}` : ''}
                  <ExternalLink className="h-3 w-3" />
                </a>
              ) : (
                <span className="font-mono text-muted-foreground">
                  {finding.packageName ?? 'Unknown package'}
                  {finding.packageVersion ? ` ${finding.packageVersion}` : ''}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
      {version.securityFindingsAcceptedAt && (
        <p className="text-[11px] text-muted-foreground">
          {scanUnsupported ? 'Security scan limitation' : 'Security findings'} accepted by{' '}
          {version.securityFindingsAcceptedBy ?? 'an administrator'} on{' '}
          {new Date(version.securityFindingsAcceptedAt).toLocaleString()}.
        </p>
      )}
      {version.failure && (
        <div className="border-l-2 border-destructive/60 pl-3 text-xs text-destructive">
          <div className="font-medium">{version.failure.reason ?? 'Build failed'}</div>
          {version.failure.detail && <div className="mt-1">{version.failure.detail}</div>}
        </div>
      )}
    </div>
  );
}

function ToolVersionForm({
  form,
  tools,
  creatingTool,
  editing,
  disabled,
  onChange,
  onCancel,
  onSubmit,
}: {
  form: ToolForm;
  tools: ManagedTool[];
  creatingTool: boolean;
  editing: boolean;
  disabled: boolean;
  onChange: (value: ToolForm) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const applyPreset = (preset: VerificationPreset) => {
    const defaults = presetDefaults(preset, form.version);
    onChange({
      ...form,
      preset,
      ...(creatingTool ? { category: defaults.category } : {}),
      installerMode: defaults.installerMode,
      installerScript: defaults.installerScript,
      stripComponents: defaults.stripComponents,
      executables: defaults.executables.map((entry) => `${entry.name}=${entry.path}`).join('\n'),
      dependencies: defaults.dependencies,
      aptPackages: defaults.aptPackages,
      environmentVariables: defaults.environmentVariables,
      versionCommand: defaults.verification.versionCommand.argv.join(' '),
      expectedVersion: defaults.verification.versionCommand.expected,
    });
  };
  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">
          {creatingTool
            ? 'New Tool'
            : editing
              ? `Edit ${form.name} ${form.version}`
              : `Add ${form.name} Version`}
        </h3>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>

      {creatingTool && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="tool-name" className="text-xs">
              Name
            </Label>
            <Input
              id="tool-name"
              value={form.name}
              onChange={(event) => onChange({ ...form, name: event.target.value })}
              placeholder=".NET SDK"
              disabled={disabled}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tool-id" className="text-xs">
              ID
            </Label>
            <Input
              id="tool-id"
              value={form.toolId}
              onChange={(event) => onChange({ ...form, toolId: event.target.value })}
              placeholder="generated-from-name"
              disabled={disabled}
              className="font-mono"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tool-publisher" className="text-xs">
              Publisher
            </Label>
            <Input
              id="tool-publisher"
              value={form.publisher}
              onChange={(event) => onChange({ ...form, publisher: event.target.value })}
              placeholder="Microsoft"
              disabled={disabled}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tool-category" className="text-xs">
              Category
            </Label>
            <Select
              value={form.category}
              onValueChange={(category) => onChange({ ...form, category })}
              disabled={disabled}
            >
              <SelectTrigger id="tool-category">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="language-sdk">Language SDK</SelectItem>
                <SelectItem value="build-tool">Build tool</SelectItem>
                <SelectItem value="cli">CLI</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="tool-description" className="text-xs">
              Description
            </Label>
            <Input
              id="tool-description"
              value={form.description}
              onChange={(event) => onChange({ ...form, description: event.target.value })}
              disabled={disabled}
            />
          </div>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="tool-version" className="text-xs">
            Exact version
          </Label>
          <Input
            id="tool-version"
            value={form.version}
            onChange={(event) => {
              const version = event.target.value;
              const defaults = presetDefaults(form.preset, version);
              onChange({
                ...form,
                version,
                expectedVersion: defaults.verification.versionCommand.expected,
              });
            }}
            placeholder="8.0.408"
            disabled={disabled || editing}
            className="font-mono"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="tool-preset" className="text-xs">
            Verification
          </Label>
          <Select
            value={form.preset}
            onValueChange={(value) => applyPreset(value as VerificationPreset)}
            disabled={disabled}
          >
            <SelectTrigger id="tool-preset">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PRESETS.map((preset) => (
                <SelectItem key={preset} value={preset}>
                  {preset === 'generic' ? 'Generic CLI' : preset}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="tool-source" className="text-xs">
            Official ARM64 archive
          </Label>
          <Input
            id="tool-source"
            type="url"
            value={form.sourceUrl}
            onChange={(event) => onChange({ ...form, sourceUrl: event.target.value })}
            placeholder="https://publisher.example/tool-linux-arm64.tar.gz"
            disabled={disabled}
            className="font-mono text-xs"
          />
          <p className="text-[11px] text-muted-foreground">
            The platform downloads this once, validates the archive, computes SHA-256, and retains
            the immutable source and OCI artifact.
          </p>
        </div>
      </div>

      <details className="rounded border">
        <summary className="cursor-pointer px-3 py-2 text-xs font-medium">
          Publisher checksum
        </summary>
        <div className="grid gap-3 border-t p-3 sm:grid-cols-[140px_minmax(0,1fr)]">
          <Select
            value={form.publisherChecksumAlgorithm}
            onValueChange={(value) =>
              onChange({
                ...form,
                publisherChecksumAlgorithm: value as 'sha256' | 'sha512',
              })
            }
            disabled={disabled}
          >
            <SelectTrigger aria-label="Checksum algorithm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="sha256">SHA-256</SelectItem>
              <SelectItem value="sha512">SHA-512</SelectItem>
            </SelectContent>
          </Select>
          <Input
            aria-label="Publisher checksum"
            value={form.publisherChecksum}
            onChange={(event) => onChange({ ...form, publisherChecksum: event.target.value })}
            placeholder="Optional published digest"
            disabled={disabled}
            className="font-mono text-xs"
          />
          <Input
            aria-label="Checksum evidence URL"
            value={form.publisherEvidenceUrl}
            onChange={(event) => onChange({ ...form, publisherEvidenceUrl: event.target.value })}
            placeholder="https://publisher.example/checksums.txt"
            disabled={disabled}
            className="font-mono text-xs sm:col-span-2"
          />
          <p className="text-[11px] text-muted-foreground sm:col-span-2">
            When both values are supplied and independently match, the version is marked Publisher
            verified. Otherwise it is still securely pinned to the platform-computed SHA-256.
          </p>
        </div>
      </details>

      <div className="space-y-3 rounded border p-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-xs font-medium">Generated archive installation</p>
            <p className="text-[11px] text-muted-foreground">
              Extract the verified archive without executing publisher code.
            </p>
          </div>
          <Switch
            aria-label="Use custom installer"
            checked={form.installerMode === 'script'}
            onCheckedChange={(checked) =>
              onChange({ ...form, installerMode: checked ? 'script' : 'generated' })
            }
            disabled={disabled}
          />
        </div>
        {form.installerMode === 'generated' ? (
          <div className="max-w-40 space-y-1.5">
            <Label htmlFor="tool-strip-components" className="text-xs">
              Root folders to remove
            </Label>
            <Input
              id="tool-strip-components"
              type="number"
              min={0}
              max={4}
              value={form.stripComponents}
              onChange={(event) =>
                onChange({ ...form, stripComponents: Number(event.target.value) })
              }
              disabled={disabled}
            />
          </div>
        ) : (
          <div className="space-y-1.5">
            <Label htmlFor="tool-installer" className="text-xs">
              Sandboxed Bash installer
            </Label>
            <Textarea
              id="tool-installer"
              value={form.installerScript}
              onChange={(event) => onChange({ ...form, installerScript: event.target.value })}
              placeholder={'#!/usr/bin/env bash\nset -Eeuo pipefail\n...'}
              disabled={disabled}
              className="min-h-40 font-mono text-xs"
            />
            <p className="text-[11px] text-muted-foreground">
              Runs without AWS credentials, metadata access, host mounts, Docker access, or private
              network access. Public internet downloads are permitted and make the script
              non-reproducible; the resulting artifact digest remains immutable.
            </p>
          </div>
        )}
      </div>

      <details className="rounded border">
        <summary className="cursor-pointer px-3 py-2 text-xs font-medium">
          Executables, dependencies, and custom verification
        </summary>
        <div className="grid gap-4 border-t p-3 lg:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="tool-executables" className="text-xs">
              Exposed executables
            </Label>
            <Textarea
              id="tool-executables"
              value={form.executables}
              onChange={(event) => onChange({ ...form, executables: event.target.value })}
              disabled={disabled}
              className="min-h-28 font-mono text-xs"
            />
          </div>
          <div className="space-y-2">
            <Label className="text-xs">Tool dependencies</Label>
            {tools.length ? (
              <div className="flex flex-wrap gap-2">
                {tools.map((tool) => (
                  <Button
                    key={tool.toolId}
                    type="button"
                    size="sm"
                    variant={form.dependencies.includes(tool.toolId) ? 'default' : 'outline'}
                    disabled={disabled || tool.toolId === form.toolId}
                    onClick={() =>
                      onChange({
                        ...form,
                        dependencies: form.dependencies.includes(tool.toolId)
                          ? form.dependencies.filter((value) => value !== tool.toolId)
                          : [...form.dependencies, tool.toolId],
                      })
                    }
                  >
                    {tool.name}
                  </Button>
                ))}
              </div>
            ) : (
              <p className="text-[11px] text-muted-foreground">No catalog dependencies</p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tool-apt" className="text-xs">
              Required apt packages
            </Label>
            <Textarea
              id="tool-apt"
              value={form.aptPackages}
              onChange={(event) => onChange({ ...form, aptPackages: event.target.value })}
              placeholder="package=exact-version"
              disabled={disabled}
              className="min-h-24 font-mono text-xs"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tool-environment" className="text-xs">
              Environment variables
            </Label>
            <Textarea
              id="tool-environment"
              value={form.environmentVariables}
              onChange={(event) => onChange({ ...form, environmentVariables: event.target.value })}
              placeholder="TOOL_HOME=${TOOL_ROOT}"
              disabled={disabled}
              className="min-h-24 font-mono text-xs"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tool-version-command" className="text-xs">
              Version command
            </Label>
            <Input
              id="tool-version-command"
              value={form.versionCommand}
              onChange={(event) => onChange({ ...form, versionCommand: event.target.value })}
              disabled={disabled}
              className="font-mono text-xs"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tool-version-output" className="text-xs">
              Expected output
            </Label>
            <Input
              id="tool-version-output"
              value={form.expectedVersion}
              onChange={(event) => onChange({ ...form, expectedVersion: event.target.value })}
              disabled={disabled}
              className="font-mono text-xs"
            />
          </div>
          <div className="space-y-1.5 lg:col-span-2">
            <Label htmlFor="tool-verifier" className="text-xs">
              Additional networkless verification
            </Label>
            <Textarea
              id="tool-verifier"
              value={form.verificationScript}
              onChange={(event) => onChange({ ...form, verificationScript: event.target.value })}
              disabled={disabled}
              className="min-h-28 font-mono text-xs"
            />
          </div>
          <div className="space-y-1.5 lg:col-span-2">
            <div className="flex items-center justify-between gap-3">
              <Label className="text-xs">Verification fixture files</Label>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={disabled || form.verificationFiles.length >= 32}
                onClick={() =>
                  onChange({
                    ...form,
                    verificationFiles: [...form.verificationFiles, { path: '', content: '' }],
                  })
                }
              >
                <Plus className="h-3.5 w-3.5" />
                Add File
              </Button>
            </div>
            {form.verificationFiles.length ? (
              <div className="divide-y rounded border">
                {form.verificationFiles.map((file, index) => (
                  <div key={index} className="space-y-2 p-3">
                    <div className="flex items-center gap-2">
                      <Input
                        aria-label={`Verification file ${index + 1} path`}
                        value={file.path}
                        onChange={(event) =>
                          onChange({
                            ...form,
                            verificationFiles: form.verificationFiles.map((entry, entryIndex) =>
                              entryIndex === index ? { ...entry, path: event.target.value } : entry,
                            ),
                          })
                        }
                        placeholder="project/expected.txt"
                        disabled={disabled}
                        className="font-mono text-xs"
                      />
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        title="Remove fixture"
                        disabled={disabled}
                        onClick={() =>
                          onChange({
                            ...form,
                            verificationFiles: form.verificationFiles.filter(
                              (_, entryIndex) => entryIndex !== index,
                            ),
                          })
                        }
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                    <Textarea
                      aria-label={`Verification file ${index + 1} content`}
                      value={file.content}
                      onChange={(event) =>
                        onChange({
                          ...form,
                          verificationFiles: form.verificationFiles.map((entry, entryIndex) =>
                            entryIndex === index
                              ? { ...entry, content: event.target.value }
                              : entry,
                          ),
                        })
                      }
                      disabled={disabled}
                      className="min-h-28 font-mono text-xs"
                    />
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-[11px] text-muted-foreground">
                Optional text files mounted read-only for custom networkless verification.
              </p>
            )}
          </div>
        </div>
      </details>

      <Button
        size="sm"
        className="gap-1.5"
        disabled={
          disabled ||
          !form.name.trim() ||
          !form.version.trim() ||
          !form.sourceUrl.trim() ||
          !form.executables.trim() ||
          !form.versionCommand.trim() ||
          !form.expectedVersion.trim()
        }
        onClick={onSubmit}
      >
        {disabled ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Hammer />}
        {editing ? 'Save and Build' : 'Create and Build'}
      </Button>
    </div>
  );
}

export function ToolsRegistry() {
  const [tools, setTools] = useState<ManagedTool[]>([]);
  const [selectedToolId, setSelectedToolId] = useState<string | null>(null);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [creatingTool, setCreatingTool] = useState(false);
  const [creatingVersion, setCreatingVersion] = useState(false);
  const [editingVersionId, setEditingVersionId] = useState<string | null>(null);
  const [form, setForm] = useState<ToolForm>(emptyForm());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (preferredToolId?: string, preferredVersionId?: string) => {
    const values = await toolsService.list();
    setTools(values);
    setSelectedToolId((current) => {
      const candidate = preferredToolId ?? current;
      return candidate && values.some((tool) => tool.toolId === candidate)
        ? candidate
        : (values[0]?.toolId ?? null);
    });
    if (preferredVersionId) setSelectedVersionId(preferredVersionId);
    return values;
  }, []);

  useEffect(() => {
    void load()
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : 'Failed to load tools'),
      )
      .finally(() => setLoading(false));
  }, [load]);

  const selectedTool = useMemo(
    () => tools.find((tool) => tool.toolId === selectedToolId) ?? null,
    [selectedToolId, tools],
  );
  const selectedVersion = useMemo(
    () =>
      selectedTool?.versions.find((version) => version.versionId === selectedVersionId) ??
      selectedTool?.versions[0] ??
      null,
    [selectedTool, selectedVersionId],
  );
  const missingDependencies = useMemo(
    () =>
      (selectedVersion?.definition.dependencies ?? []).filter((toolId) => {
        const dependency = tools.find((tool) => tool.toolId === toolId);
        return !dependency?.versions.some(
          (version) =>
            version.versionId === dependency.recommendedVersionId && version.status === 'PUBLISHED',
        );
      }),
    [selectedVersion, tools],
  );

  useEffect(() => {
    if (!selectedTool) return;
    if (
      !selectedVersionId ||
      !selectedTool.versions.some((item) => item.versionId === selectedVersionId)
    ) {
      setSelectedVersionId(selectedTool.versions[0]?.versionId ?? null);
    }
  }, [selectedTool, selectedVersionId]);

  useEffect(() => {
    if (!selectedVersion || !ACTIVE_STATUSES.has(selectedVersion.status)) return;
    const timer = window.setInterval(() => void load(selectedToolId ?? undefined), 8000);
    return () => window.clearInterval(timer);
  }, [load, selectedToolId, selectedVersion]);

  const run = async (name: string, action: () => Promise<unknown>) => {
    setBusy(name);
    setError(null);
    try {
      await action();
      await load(selectedToolId ?? undefined, selectedVersionId ?? undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Tool action failed');
    } finally {
      setBusy(null);
    }
  };

  const createAndBuild = async () => {
    setBusy('create');
    setError(null);
    let persistedToolId = selectedTool?.toolId ?? null;
    let persistedVersionId = editingVersionId;
    try {
      let tool = selectedTool;
      if (creatingTool) {
        tool = await toolsService.create({
          ...(form.toolId.trim() ? { toolId: form.toolId.trim() } : {}),
          name: form.name.trim(),
          description: form.description.trim(),
          category: form.category,
          publisher: form.publisher.trim(),
        });
        persistedToolId = tool.toolId;
        setSelectedToolId(tool.toolId);
        setCreatingTool(false);
        setCreatingVersion(true);
      }
      if (!tool) throw new Error('Tool is unavailable');
      const definition = definitionFromForm(form);
      if (editingVersionId) {
        const current = tool.versions.find((version) => version.versionId === editingVersionId);
        const updated = await toolsService.updateVersion(tool.toolId, editingVersionId, definition);
        persistedVersionId = updated.version.versionId;
        if (current?.status === 'FAILED') {
          await toolsService.retry(tool.toolId, updated.version.versionId);
        } else {
          await toolsService.build(tool.toolId, updated.version.versionId);
        }
      } else {
        const created = await toolsService.createVersion(tool.toolId, definition);
        persistedVersionId = created.version.versionId;
        setSelectedVersionId(created.version.versionId);
        setCreatingVersion(false);
        await toolsService.build(tool.toolId, created.version.versionId);
      }
      setCreatingTool(false);
      setCreatingVersion(false);
      setEditingVersionId(null);
      await load(tool.toolId, persistedVersionId ?? undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to create tool version');
      if (persistedToolId) {
        await load(persistedToolId, persistedVersionId ?? undefined).catch(() => undefined);
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <SettingsCard
      icon={<Wrench />}
      title="Tool Catalog"
      description="Verified ARM64 tool artifacts available to managed environments."
      headerAction={
        <Button
          size="sm"
          className="gap-1.5"
          disabled={Boolean(busy)}
          onClick={() => {
            setCreatingTool(true);
            setCreatingVersion(false);
            setEditingVersionId(null);
            setForm(emptyForm());
            setError(null);
          }}
        >
          <Plus className="h-3.5 w-3.5" />
          Add Tool
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
            {tools.map((tool) => (
              <button
                key={tool.toolId}
                type="button"
                className={cn(
                  'flex w-full items-start justify-between gap-2 rounded px-2.5 py-2 text-left hover:bg-muted/60',
                  !creatingTool && selectedToolId === tool.toolId && 'bg-muted',
                )}
                onClick={() => {
                  setCreatingTool(false);
                  setCreatingVersion(false);
                  setEditingVersionId(null);
                  setSelectedToolId(tool.toolId);
                }}
              >
                <span className="min-w-0">
                  <span className="block truncate text-xs font-medium">{tool.name}</span>
                  <span className="block truncate font-mono text-[10px] text-muted-foreground">
                    {tool.toolId}
                  </span>
                </span>
                {tool.recommendedVersionId && (
                  <Star className="mt-0.5 h-3.5 w-3.5 fill-amber-400 text-amber-500" />
                )}
              </button>
            ))}
          </div>

          <div className="min-w-0 space-y-5">
            {creatingTool || creatingVersion ? (
              <ToolVersionForm
                form={form}
                tools={tools}
                creatingTool={creatingTool}
                editing={Boolean(editingVersionId)}
                disabled={Boolean(busy)}
                onChange={setForm}
                onCancel={() => {
                  setCreatingTool(false);
                  setCreatingVersion(false);
                  setEditingVersionId(null);
                }}
                onSubmit={() => void createAndBuild()}
              />
            ) : selectedTool ? (
              <>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-semibold">{selectedTool.name}</h3>
                      {selectedTool.system && <Badge variant="secondary">Platform</Badge>}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {selectedTool.publisher || 'Administrator managed'}
                    </p>
                    {selectedTool.description && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {selectedTool.description}
                      </p>
                    )}
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1.5"
                    onClick={() => {
                      setCreatingVersion(true);
                      setEditingVersionId(null);
                      setForm(emptyForm(selectedTool));
                    }}
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Add Version
                  </Button>
                </div>

                {selectedTool.versions.length ? (
                  <>
                    <div className="flex flex-wrap items-center gap-2 border-y py-3">
                      <Select
                        value={selectedVersion?.versionId}
                        onValueChange={setSelectedVersionId}
                      >
                        <SelectTrigger
                          aria-label="Tool version"
                          className="h-8 w-72 font-mono text-xs"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {selectedTool.versions.map((version) => (
                            <SelectItem key={version.versionId} value={version.versionId}>
                              {version.definition.version} · {version.status}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {selectedVersion && <ToolStatus status={selectedVersion.status} />}
                      {selectedVersion?.versionId === selectedTool.recommendedVersionId && (
                        <Badge variant="outline" className="gap-1 text-[10px]">
                          <Star className="h-3 w-3 fill-amber-400 text-amber-500" />
                          Recommended
                        </Badge>
                      )}
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8"
                        title="Refresh"
                        onClick={() => void load(selectedTool.toolId)}
                      >
                        <RefreshCw className="h-3.5 w-3.5" />
                      </Button>
                      <div className="ml-auto flex flex-wrap gap-2">
                        {selectedVersion &&
                          ['DRAFT', 'FAILED'].includes(selectedVersion.status) && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => {
                                setCreatingVersion(true);
                                setEditingVersionId(selectedVersion.versionId);
                                setForm(formFromVersion(selectedTool, selectedVersion));
                              }}
                            >
                              <Pencil className="h-3.5 w-3.5" />
                              Edit
                            </Button>
                          )}
                        {selectedVersion?.status === 'DRAFT' && (
                          <Button
                            size="sm"
                            disabled={missingDependencies.length > 0}
                            onClick={() =>
                              void run('build', () =>
                                toolsService.build(selectedTool.toolId, selectedVersion.versionId),
                              )
                            }
                          >
                            <Hammer className="h-3.5 w-3.5" />
                            Build
                          </Button>
                        )}
                        {selectedVersion?.status === 'FAILED' && (
                          <Button
                            size="sm"
                            disabled={missingDependencies.length > 0}
                            onClick={() =>
                              void run('retry', () =>
                                toolsService.retry(selectedTool.toolId, selectedVersion.versionId),
                              )
                            }
                          >
                            <RefreshCw className="h-3.5 w-3.5" />
                            Retry
                          </Button>
                        )}
                        {selectedVersion?.status === 'SECURITY_REVIEW' && (
                          <Button
                            size="sm"
                            onClick={() => {
                              const scanUnsupported =
                                selectedVersion.scanFindings?.status === 'UNSUPPORTED';
                              const counts = selectedVersion.scanFindings?.severityCounts ?? {};
                              const critical = counts.CRITICAL ?? 0;
                              const high = counts.HIGH ?? 0;
                              if (
                                !window.confirm(
                                  scanUnsupported
                                    ? 'ECR could not scan this artifact. Accept the scan limitation and continue verification?'
                                    : `Accept ${critical} Critical and ${high} High findings and continue verification?`,
                                )
                              ) {
                                return;
                              }
                              void run('accept', () =>
                                toolsService.acceptFindings(
                                  selectedTool.toolId,
                                  selectedVersion.versionId,
                                ),
                              );
                            }}
                          >
                            <ShieldAlert className="h-3.5 w-3.5" />
                            {selectedVersion.scanFindings?.status === 'UNSUPPORTED'
                              ? 'Accept Scan Limitation'
                              : 'Accept Findings'}
                          </Button>
                        )}
                        {selectedVersion?.status === 'READY' && (
                          <Button
                            size="sm"
                            onClick={() =>
                              void run('publish', () =>
                                toolsService.publish(
                                  selectedTool.toolId,
                                  selectedVersion.versionId,
                                ),
                              )
                            }
                          >
                            <Rocket className="h-3.5 w-3.5" />
                            Publish
                          </Button>
                        )}
                        {selectedVersion?.status === 'PUBLISHED' &&
                          selectedVersion.versionId !== selectedTool.recommendedVersionId && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() =>
                                void run('recommend', () =>
                                  toolsService.recommend(
                                    selectedTool.toolId,
                                    selectedVersion.versionId,
                                  ),
                                )
                              }
                            >
                              <Star className="h-3.5 w-3.5" />
                              Recommend
                            </Button>
                          )}
                      </div>
                    </div>
                    {missingDependencies.length > 0 &&
                      selectedVersion &&
                      ['DRAFT', 'FAILED'].includes(selectedVersion.status) && (
                        <div className="border-l-2 border-amber-500/60 pl-3 text-xs text-amber-700 dark:text-amber-300">
                          Publish and recommend{' '}
                          {missingDependencies
                            .map(
                              (toolId) =>
                                tools.find((tool) => tool.toolId === toolId)?.name ?? toolId,
                            )
                            .join(', ')}{' '}
                          before building this version.
                        </div>
                      )}
                    {selectedVersion && (
                      <>
                        <div className="grid gap-3 text-xs sm:grid-cols-3">
                          <div>
                            <p className="text-muted-foreground">Version</p>
                            <p className="mt-1 font-mono">{selectedVersion.definition.version}</p>
                          </div>
                          <div>
                            <p className="text-muted-foreground">Preset</p>
                            <p className="mt-1">{selectedVersion.definition.verification.preset}</p>
                          </div>
                          <div>
                            <p className="text-muted-foreground">Executables</p>
                            <p className="mt-1 font-mono">
                              {selectedVersion.definition.executables
                                .map((entry) => entry.name)
                                .join(', ')}
                            </p>
                          </div>
                        </div>
                        <VersionEvidence version={selectedVersion} />
                      </>
                    )}
                  </>
                ) : (
                  <div className="border-l-2 border-muted pl-3 text-xs text-muted-foreground">
                    No versions have been added.
                  </div>
                )}
              </>
            ) : (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <CircleCheck className="h-4 w-4" />
                Add a tool to begin.
              </div>
            )}
            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
        </div>
      )}
    </SettingsCard>
  );
}
