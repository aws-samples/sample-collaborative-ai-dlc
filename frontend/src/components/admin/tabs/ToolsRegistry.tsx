import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Check,
  CheckCircle2,
  ChevronDown,
  Circle,
  CircleCheck,
  ExternalLink,
  Hammer,
  Info,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Rocket,
  ShieldQuestion,
  Star,
  Trash2,
  TriangleAlert,
  Wrench,
} from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
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
import { ApiError } from '@/services/api';
import { cn } from '@/lib/utils';
import { Disclosure, ProcessOverview } from './environment-builder/ui';

const ACTIVE_STATUSES = new Set(['QUEUED', 'BUILDING', 'SCANNING']);
const PRESETS = ['generic', 'java', 'go', 'rust', 'maven', 'gradle', 'dotnet'] as const;
type VerificationPreset = (typeof PRESETS)[number];
const PRESET_LABELS: Record<VerificationPreset, string> = {
  generic: 'Other CLI',
  java: 'Java JDK',
  go: 'Go SDK',
  rust: 'Rust toolchain',
  maven: 'Apache Maven',
  gradle: 'Gradle',
  dotnet: '.NET SDK',
};
const TOOL_PROCESS_STEPS = [
  {
    label: 'Define',
    description: 'Choose the distribution, exact version, and ARM64 download.',
  },
  {
    label: 'Build',
    description: 'CodeBuild creates the reusable tool artifact.',
  },
  {
    label: 'Check',
    description: 'Automatic functional and package checks run.',
  },
  {
    label: 'Publish',
    description: 'Make the version available to environments.',
  },
  {
    label: 'Recommend',
    description: 'Optionally make it the default for new environments.',
  },
] as const;

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
  distribution: string;
  versionPublisher: string;
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

interface Confirmation {
  title: string;
  description: string;
  actionLabel: string;
  onConfirm: () => void;
}

const presetForTool = (tool?: ManagedTool | null): VerificationPreset => {
  const reference =
    tool?.versions.find((version) => version.versionId === tool.recommendedVersionId) ??
    tool?.versions[0];
  if (reference?.definition.verification.preset) {
    return reference.definition.verification.preset;
  }
  const identity = `${tool?.toolId ?? ''} ${tool?.name ?? ''}`.toLowerCase();
  if (/\b(java|jdk)\b/.test(identity)) return 'java';
  if (/\bmaven\b/.test(identity)) return 'maven';
  if (/\bgradle\b/.test(identity)) return 'gradle';
  if (/\brust\b/.test(identity)) return 'rust';
  if (/\bdotnet\b|(^|[^a-z0-9])\.net\b/.test(identity)) return 'dotnet';
  if (/\bgo\b/.test(identity)) return 'go';
  return 'generic';
};

const emptyForm = (tool?: ManagedTool | null): ToolForm => {
  const preset = presetForTool(tool);
  const defaults = presetDefaults(preset, '');
  const reference =
    tool?.versions.find((version) => version.versionId === tool.recommendedVersionId) ??
    tool?.versions[0];
  return {
    toolId: tool?.toolId ?? '',
    name: tool?.name ?? '',
    description: tool?.description ?? '',
    category: tool?.category ?? 'cli',
    publisher: tool?.publisher ?? '',
    version: '',
    distribution: reference?.definition.distribution ?? tool?.publisher ?? '',
    versionPublisher: reference?.definition.publisher ?? tool?.publisher ?? '',
    sourceUrl: '',
    preset,
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
  distribution: version.definition.distribution ?? tool.publisher,
  versionPublisher: version.definition.publisher ?? tool.publisher,
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
  ...(form.distribution.trim() || form.name.trim()
    ? { distribution: form.distribution.trim() || form.name.trim() }
    : {}),
  ...(form.versionPublisher.trim() || form.publisher.trim()
    ? { publisher: form.versionPublisher.trim() || form.publisher.trim() }
    : {}),
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

const VERSION_PATTERN = /^[0-9][0-9A-Za-z.+:~_-]*$/;
const CHECKSUM_PATTERN = {
  sha256: /^[a-f0-9]{64}$/i,
  sha512: /^[a-f0-9]{128}$/i,
};

const validateToolForm = (form: ToolForm, creatingTool: boolean) => {
  const issues: string[] = [];
  if (creatingTool && !form.name.trim()) issues.push('Give the tool family a name.');
  if (!form.version.trim()) {
    issues.push('Enter the exact version.');
  } else if (!VERSION_PATTERN.test(form.version.trim())) {
    issues.push('The version must start with a number, for example 21.0.8.9.1.');
  }
  if (!creatingTool && !form.distribution.trim()) {
    issues.push('Name the distribution, for example Amazon Corretto.');
  }
  if (!form.sourceUrl.trim()) {
    issues.push('Add the Linux ARM64 download URL.');
  } else {
    try {
      const source = new URL(form.sourceUrl.trim());
      if (source.protocol !== 'https:') issues.push('The download URL must use HTTPS.');
      if (source.username || source.password || source.hash || source.search) {
        issues.push('Use a direct download URL without credentials, fragments, or query values.');
      }
    } catch {
      issues.push('Enter a valid download URL.');
    }
  }
  if (
    form.publisherChecksum.trim() &&
    !CHECKSUM_PATTERN[form.publisherChecksumAlgorithm].test(form.publisherChecksum.trim())
  ) {
    issues.push(
      `The optional ${form.publisherChecksumAlgorithm.toUpperCase()} checksum must contain only the digest characters.`,
    );
  }
  if (!form.executables.trim()) issues.push('Advanced options need at least one executable.');
  if (!form.versionCommand.trim()) issues.push('Advanced options need a version command.');
  if (!form.expectedVersion.trim()) issues.push('Advanced options need expected version output.');
  if (form.installerMode === 'script' && !form.installerScript.trim()) {
    issues.push('Add the custom installer script or use standard archive extraction.');
  }
  return [...new Set(issues)];
};

const issueLabel = (path: string) => {
  if (path === 'version') return 'Version';
  if (path === 'distribution') return 'Distribution';
  if (path === 'publisher') return 'Publisher';
  if (path.startsWith('source.url')) return 'Download URL';
  if (path.startsWith('source.expectedChecksum')) return 'Publisher checksum';
  if (path.startsWith('installer')) return 'Archive installation';
  if (path.startsWith('executables')) return 'Executables';
  if (path.startsWith('dependencies')) return 'Dependencies';
  if (path.startsWith('aptPackages')) return 'Required packages';
  if (path.startsWith('environmentVariables')) return 'Environment variables';
  if (path.startsWith('verification')) return 'Verification';
  return path;
};

const toolErrorMessage = (reason: unknown) => {
  if (reason instanceof ApiError && Array.isArray(reason.body?.issues)) {
    const details = reason.body.issues
      .filter((entry): entry is { path: string; message: string } =>
        Boolean(
          entry &&
          typeof entry === 'object' &&
          typeof (entry as { path?: unknown }).path === 'string' &&
          typeof (entry as { message?: unknown }).message === 'string',
        ),
      )
      .map((entry) => `${issueLabel(entry.path)}: ${entry.message}`);
    if (details.length)
      return `Check these fields:\n${details.map((item) => `• ${item}`).join('\n')}`;
  }
  return reason instanceof Error ? reason.message : 'Unable to save the tool version';
};

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

const toolStatusLabel = (version: ManagedToolVersion) => {
  if (version.status === 'SECURITY_REVIEW') {
    return version.scanFindings?.status === 'UNSUPPORTED' ? 'Scan unavailable' : 'Review required';
  }
  const labels: Record<string, string> = {
    DRAFT: 'Draft',
    QUEUED: 'Queued',
    BUILDING: 'Building',
    SCANNING: 'Checking image',
    READY: 'Ready to publish',
    PUBLISHED: 'Published',
    FAILED: 'Needs attention',
  };
  return labels[version.status] ?? version.status.replaceAll('_', ' ');
};

function ToolStatus({ version }: { version: ManagedToolVersion }) {
  const scanUnavailable =
    version.status === 'SECURITY_REVIEW' && version.scanFindings?.status === 'UNSUPPORTED';
  return (
    <Badge
      variant="outline"
      className={cn(
        'text-[10px] font-medium',
        scanUnavailable
          ? 'border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300'
          : statusClass(version.status),
      )}
    >
      {toolStatusLabel(version)}
    </Badge>
  );
}

const ecrConsoleUrl = (imageUri?: string | null) => {
  const match = imageUri?.match(
    /^(?<account>\d{12})\.dkr\.ecr\.(?<region>[a-z0-9-]+)\.amazonaws\.com\/(?<repository>[^:@]+)/,
  );
  if (!match?.groups) return null;
  return `https://${match.groups.region}.console.aws.amazon.com/ecr/repositories/private/${match.groups.account}/${match.groups.repository}?region=${match.groups.region}`;
};

function ToolLifecycle({
  version,
  recommended,
}: {
  version: ManagedToolVersion;
  recommended: boolean;
}) {
  const scanUnsupported = version.scanFindings?.status === 'UNSUPPORTED';
  const counts = version.scanFindings?.severityCounts ?? {};
  const critical = Number(counts.CRITICAL ?? 0);
  const high = Number(counts.HIGH ?? 0);
  const waiting = ACTIVE_STATUSES.has(version.status);
  const activeIndex =
    version.status === 'DRAFT'
      ? 0
      : ['QUEUED', 'BUILDING'].includes(version.status)
        ? 1
        : ['SCANNING', 'SECURITY_REVIEW'].includes(version.status)
          ? 2
          : version.status === 'READY'
            ? 3
            : version.status === 'PUBLISHED' && !recommended
              ? 4
              : version.status === 'FAILED'
                ? version.imageDigest
                  ? 2
                  : 1
                : -1;
  const completed = [
    version.status !== 'DRAFT',
    Boolean(version.imageDigest),
    ['READY', 'PUBLISHED'].includes(version.status),
    version.status === 'PUBLISHED',
    recommended,
  ];
  const stages = TOOL_PROCESS_STEPS;
  const ecrUrl = ecrConsoleUrl(version.imageUri);

  const statusMessage =
    version.status === 'DRAFT'
      ? 'The definition is ready. Start the build when the download URL and version look correct.'
      : ['QUEUED', 'BUILDING'].includes(version.status)
        ? 'CodeBuild is downloading the source and creating the reusable tool artifact.'
        : version.status === 'SCANNING'
          ? 'The image was built. ECR is checking its operating-system packages.'
          : version.status === 'SECURITY_REVIEW' && scanUnsupported
            ? 'ECR could not inspect this image format. This is a scan limitation, not a detected vulnerability.'
            : version.status === 'SECURITY_REVIEW'
              ? `ECR found ${critical} Critical and ${high} High package findings. Review them before continuing.`
              : version.status === 'READY'
                ? 'Build and checks are complete. Publish this version to make it available.'
                : version.status === 'PUBLISHED' && !recommended
                  ? 'Published versions can be selected explicitly. Make this recommended to use it by default.'
                  : version.status === 'PUBLISHED'
                    ? 'This is the recommended published version for the tool family.'
                    : version.failure?.detail ||
                      'The last attempt needs attention before continuing.';

  return (
    <div className="rounded-xl border bg-card px-3 py-3">
      <div className="grid grid-cols-5 gap-1">
        {stages.map((stage, index) => {
          const active = activeIndex === index;
          return (
            <div key={stage.label} className="relative min-w-0 px-1 text-center">
              {index > 0 && <span className="absolute right-1/2 top-3.5 h-px w-full bg-border" />}
              <span
                className={cn(
                  'relative z-10 mx-auto flex h-6 w-6 items-center justify-center rounded-full border bg-background',
                  completed[index] && 'border-emerald-500 bg-emerald-500 text-white',
                  active &&
                    !completed[index] &&
                    'border-primary bg-primary text-primary-foreground',
                )}
              >
                {completed[index] ? (
                  <Check className="h-3.5 w-3.5" />
                ) : active && waiting ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Circle className="h-3 w-3" />
                )}
              </span>
              <span
                className={cn(
                  'mt-1.5 block truncate text-[10px] text-muted-foreground',
                  active && 'font-medium text-foreground',
                )}
              >
                {stage.label}
              </span>
            </div>
          );
        })}
      </div>

      <div
        className={cn(
          'mt-3 flex flex-col gap-3 rounded-lg bg-muted/20 p-2.5 sm:flex-row sm:items-center sm:justify-between',
          version.status === 'FAILED' && 'border-destructive/30 bg-destructive/5',
          version.status === 'SECURITY_REVIEW' &&
            !scanUnsupported &&
            'border-amber-500/30 bg-amber-500/5',
          version.status === 'SECURITY_REVIEW' &&
            scanUnsupported &&
            'border-blue-500/30 bg-blue-500/5',
        )}
      >
        <div className="flex min-w-0 items-start gap-2.5">
          {waiting ? (
            <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-primary" />
          ) : version.status === 'SECURITY_REVIEW' ? (
            scanUnsupported ? (
              <Info className="mt-0.5 h-4 w-4 shrink-0 text-blue-600" />
            ) : (
              <ShieldQuestion className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
            )
          ) : version.status === 'FAILED' ? (
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          ) : (
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
          )}
          <div>
            <p className="text-xs font-semibold">{toolStatusLabel(version)}</p>
            <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
              {statusMessage}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {version.buildLogUrl && (
            <Button size="sm" variant="outline" asChild>
              <a href={version.buildLogUrl} target="_blank" rel="noreferrer">
                CodeBuild logs <ExternalLink className="h-3.5 w-3.5" />
              </a>
            </Button>
          )}
          {ecrUrl && version.imageDigest && (
            <Button size="sm" variant="outline" asChild>
              <a href={ecrUrl} target="_blank" rel="noreferrer">
                Open ECR <ExternalLink className="h-3.5 w-3.5" />
              </a>
            </Button>
          )}
        </div>
      </div>
    </div>
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
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl border p-3">
          <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Source
          </p>
          <p className="mt-2 text-xs font-medium">
            {version.source ? 'Download complete' : 'Waiting for build'}
          </p>
          {version.source && (
            <a
              href={version.source.requestedUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-1 inline-flex items-center gap-1 text-[11px] text-primary hover:underline"
            >
              View download <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
        <div className="rounded-xl border p-3">
          <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Artifact
          </p>
          <p className="mt-2 text-xs font-medium">
            {version.imageDigest ? 'Image created' : 'Waiting for build'}
          </p>
          {version.imageSizeBytes && (
            <p className="mt-1 font-mono text-[10px] text-muted-foreground">
              {(version.imageSizeBytes / 1024 / 1024).toFixed(1)} MiB
            </p>
          )}
        </div>
        <div className="rounded-xl border p-3">
          <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Functional check
          </p>
          <p className="mt-2 text-xs font-medium">
            {version.verification ? 'Passed' : 'Waiting for checks'}
          </p>
          {scanUnsupported && scanLimitationAccepted && (
            <p className="mt-1 text-[10px] text-muted-foreground">
              Automated package scan was unavailable and reviewed.
            </p>
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
          {scanUnsupported ? 'Automated scan limitation' : 'Package findings'} reviewed by{' '}
          {version.securityFindingsAcceptedBy ?? 'an administrator'} on{' '}
          {new Date(version.securityFindingsAcceptedAt).toLocaleString()}.
        </p>
      )}
      {(version.source || version.imageDigest || version.scanFindings) && (
        <Disclosure
          title="Technical details"
          contentClassName="space-y-2 font-mono text-[10px] text-muted-foreground"
        >
          {version.source && <p className="break-all">Source SHA-256: {version.source.sha256}</p>}
          {version.imageDigest && <p className="break-all">Image: {version.imageDigest}</p>}
          {version.scanFindings?.status && <p>Scan status: {version.scanFindings.status}</p>}
          {typeof version.verification?.runtimeCompatibilityVersion === 'string' && (
            <p>Runtime contract: {String(version.verification.runtimeCompatibilityVersion)}</p>
          )}
        </Disclosure>
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

function VersionDetails({ tool, version }: { tool: ManagedTool; version: ManagedToolVersion }) {
  const needsEvidence =
    version.status === 'FAILED' ||
    (version.status === 'SECURITY_REVIEW' && version.scanFindings?.status !== 'UNSUPPORTED');
  const [open, setOpen] = useState(needsEvidence);

  useEffect(() => {
    if (needsEvidence) setOpen(true);
  }, [needsEvidence]);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="overflow-hidden rounded-xl border">
        <CollapsibleTrigger asChild>
          <button
            type="button"
            aria-label="Details and evidence"
            className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left"
          >
            <span>
              <span className="block text-xs font-semibold">Details and evidence</span>
              <span className="mt-0.5 block text-[10px] text-muted-foreground">
                Source, image, checks, and technical metadata.
              </span>
            </span>
            <ChevronDown
              className={cn(
                'h-4 w-4 shrink-0 text-muted-foreground transition-transform',
                open && 'rotate-180',
              )}
            />
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="space-y-3 border-t bg-muted/[0.03] p-3">
            <div className="grid gap-3 rounded-lg border bg-background p-3 text-xs sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <p className="text-muted-foreground">Distribution</p>
                <p className="mt-1 font-medium">
                  {version.definition.distribution ??
                    version.definition.publisher ??
                    tool.publisher}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground">Publisher</p>
                <p className="mt-1 font-medium">{version.definition.publisher ?? tool.publisher}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Version</p>
                <p className="mt-1 font-mono">{version.definition.version}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Tool type</p>
                <p className="mt-1 font-medium">
                  {PRESET_LABELS[version.definition.verification.preset]}
                </p>
              </div>
            </div>
            <VersionEvidence version={version} />
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
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
  const [advancedOpen, setAdvancedOpen] = useState(editing);
  const issues = validateToolForm(form, creatingTool);
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
            ? 'New tool family'
            : editing
              ? `Edit ${form.name} ${form.version}`
              : `Add a ${form.name} distribution or version`}
        </h3>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>

      <ProcessOverview steps={[...TOOL_PROCESS_STEPS]} />

      {!creatingTool && !editing && (
        <div className="flex items-start gap-2 rounded-lg border border-blue-500/25 bg-blue-500/5 p-3">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-blue-600" />
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Alternatives that provide the same capability belong in this tool family. For example,
            add Amazon Corretto here as another Java JDK distribution, then publish it and make it
            recommended. {PRESET_LABELS[form.preset]} settings are applied automatically.
          </p>
        </div>
      )}

      {creatingTool && (
        <div className="space-y-3">
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
          </div>
          <Disclosure
            title="Family details (optional)"
            contentClassName="grid gap-3 sm:grid-cols-2"
          >
            <div className="space-y-1.5">
              <Label htmlFor="tool-id" className="text-xs">
                ID
              </Label>
              <Input
                id="tool-id"
                value={form.toolId}
                onChange={(event) => onChange({ ...form, toolId: event.target.value })}
                placeholder="Generated from the name"
                disabled={disabled}
                className="font-mono"
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
          </Disclosure>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        {!creatingTool && (
          <>
            <div className="space-y-1.5">
              <Label htmlFor="tool-distribution" className="text-xs">
                Distribution
              </Label>
              <Input
                id="tool-distribution"
                value={form.distribution}
                onChange={(event) => onChange({ ...form, distribution: event.target.value })}
                placeholder="Amazon Corretto"
                disabled={disabled}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tool-version-publisher" className="text-xs">
                Publisher
              </Label>
              <Input
                id="tool-version-publisher"
                value={form.versionPublisher}
                onChange={(event) => onChange({ ...form, versionPublisher: event.target.value })}
                placeholder="Amazon Web Services"
                disabled={disabled}
              />
            </div>
          </>
        )}
        {(creatingTool || editing) && (
          <div className="space-y-1.5">
            <Label htmlFor="tool-preset" className="text-xs">
              Tool type
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
                    {PRESET_LABELS[preset]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
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
            placeholder="21.0.8.9.1"
            disabled={disabled || editing}
            className="font-mono"
          />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="tool-source" className="text-xs">
            Linux ARM64 download URL
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
            Use the publisher's direct `.tar.gz` or `.zip` download. The platform stores the exact
            file, builds it, and runs the checks automatically.
          </p>
        </div>
      </div>

      <div className="flex items-start gap-2 rounded-lg border bg-muted/15 p-3">
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          For standard Java, Go, Rust, Maven, Gradle, and .NET archives, these fields are normally
          enough. Open Advanced options only when the archive layout or verification is unusual.
        </p>
      </div>

      <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
        <section className="rounded-xl border">
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
            >
              <span>
                <span className="block text-xs font-semibold">Advanced options</span>
                <span className="mt-0.5 block text-[11px] text-muted-foreground">
                  Only for non-standard archives or custom runtime requirements.
                </span>
              </span>
              <ChevronDown
                className={cn(
                  'h-4 w-4 text-muted-foreground transition-transform',
                  advancedOpen && 'rotate-180',
                )}
              />
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="space-y-4 border-t p-4">
              <Disclosure
                title="Publisher integrity details (optional)"
                contentClassName="grid gap-3 sm:grid-cols-[140px_minmax(0,1fr)]"
              >
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
                  onChange={(event) =>
                    onChange({ ...form, publisherEvidenceUrl: event.target.value })
                  }
                  placeholder="https://publisher.example/checksums.txt"
                  disabled={disabled}
                  className="font-mono text-xs sm:col-span-2"
                />
                <p className="text-[11px] text-muted-foreground sm:col-span-2">
                  When both values are supplied and independently match, the version is marked
                  Publisher verified. Otherwise it is still securely pinned to the platform-computed
                  SHA-256.
                </p>
              </Disclosure>

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
                      onChange={(event) =>
                        onChange({ ...form, installerScript: event.target.value })
                      }
                      placeholder={'#!/usr/bin/env bash\nset -Eeuo pipefail\n...'}
                      disabled={disabled}
                      className="min-h-40 font-mono text-xs"
                    />
                    <p className="text-[11px] text-muted-foreground">
                      Runs without AWS credentials, metadata access, host mounts, Docker access, or
                      private network access. Public internet downloads are permitted and make the
                      script non-reproducible; the resulting artifact digest remains immutable.
                    </p>
                  </div>
                )}
              </div>

              <Disclosure
                title="Executables, dependencies, and custom verification"
                contentClassName="grid gap-4 lg:grid-cols-2"
              >
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
                    onChange={(event) =>
                      onChange({ ...form, environmentVariables: event.target.value })
                    }
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
                    onChange={(event) =>
                      onChange({ ...form, verificationScript: event.target.value })
                    }
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
                                  verificationFiles: form.verificationFiles.map(
                                    (entry, entryIndex) =>
                                      entryIndex === index
                                        ? { ...entry, path: event.target.value }
                                        : entry,
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
                                verificationFiles: form.verificationFiles.map(
                                  (entry, entryIndex) =>
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
              </Disclosure>
            </div>
          </CollapsibleContent>
        </section>
      </Collapsible>

      {issues.length > 0 && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
          <p className="text-xs font-medium text-amber-800 dark:text-amber-200">
            Before starting the build
          </p>
          <ul className="mt-1.5 space-y-1 text-[11px] text-amber-800/90 dark:text-amber-200/90">
            {issues.map((issue) => (
              <li key={issue} className="flex items-start gap-1.5">
                <span aria-hidden="true">•</span>
                <span>{issue}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <Button
        size="sm"
        className="gap-1.5"
        disabled={disabled || issues.length > 0}
        onClick={onSubmit}
      >
        {disabled ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Hammer />}
        {editing ? 'Save and rebuild' : 'Create and start build'}
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
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);

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
      setError(toolErrorMessage(reason));
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
      setError(toolErrorMessage(reason));
      if (persistedToolId) {
        await load(persistedToolId, persistedVersionId ?? undefined).catch(() => undefined);
      }
    } finally {
      setBusy(null);
    }
  };

  const requestSecurityReview = (tool: ManagedTool, version: ManagedToolVersion) => {
    const scanUnsupported = version.scanFindings?.status === 'UNSUPPORTED';
    const counts = version.scanFindings?.severityCounts ?? {};
    const critical = Number(counts.CRITICAL ?? 0);
    const high = Number(counts.HIGH ?? 0);
    setConfirmation({
      title: scanUnsupported ? 'Continue without an automated package scan?' : 'Review findings?',
      description: scanUnsupported
        ? 'ECR could not inspect this image format. This does not mean a vulnerability was found. Continue only when you trust the publisher and download source.'
        : `ECR found ${critical} Critical and ${high} High package findings. Continuing records your review and allows this version to be published.`,
      actionLabel: scanUnsupported ? 'Continue after review' : 'Accept findings',
      onConfirm: () =>
        void run('accept', () => toolsService.acceptFindings(tool.toolId, version.versionId)),
    });
  };

  const requestRecommendation = (tool: ManagedTool, version: ManagedToolVersion) => {
    const current = tool.versions.find((item) => item.versionId === tool.recommendedVersionId);
    const candidateName =
      version.definition.distribution ?? version.definition.publisher ?? tool.publisher;
    const currentName =
      current?.definition.distribution ?? current?.definition.publisher ?? tool.publisher;
    setConfirmation({
      title: current ? `Replace ${currentName} as recommended?` : `Recommend ${candidateName}?`,
      description: current
        ? `${candidateName} ${version.definition.version} will replace ${currentName} ${current.definition.version} as the default for ${tool.name}. Existing environments remain unchanged until an administrator creates a new revision.`
        : `${candidateName} ${version.definition.version} will become the default version offered for ${tool.name}.`,
      actionLabel: current ? 'Replace recommendation' : 'Make recommended',
      onConfirm: () =>
        void run('recommend', () => toolsService.recommend(tool.toolId, version.versionId)),
    });
  };

  return (
    <>
      <SettingsCard
        icon={<Wrench />}
        title="Tool Catalog"
        description="Add a distribution, let the platform build and check it, then publish it for environments."
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
            New tool family
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
                  aria-pressed={!creatingTool && selectedToolId === tool.toolId}
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
                    <span className="mt-0.5 shrink-0 text-amber-500">
                      <Star className="h-3.5 w-3.5 fill-amber-400" />
                      <span className="sr-only">Has a recommended version</span>
                    </span>
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
                  onChange={(value) => {
                    setForm(value);
                    setError(null);
                  }}
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
                        Versions and distributions for this capability.
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-1.5"
                      disabled={Boolean(busy)}
                      onClick={() => {
                        setCreatingVersion(true);
                        setEditingVersionId(null);
                        setForm(emptyForm(selectedTool));
                      }}
                    >
                      <Plus className="h-3.5 w-3.5" />
                      Add distribution or version
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
                                {version.definition.distribution ??
                                  version.definition.publisher ??
                                  selectedTool.publisher}{' '}
                                {version.definition.version} · {toolStatusLabel(version)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        {selectedVersion && <ToolStatus version={selectedVersion} />}
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
                          aria-label="Refresh tool status"
                          disabled={Boolean(busy)}
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
                                disabled={Boolean(busy)}
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
                              disabled={Boolean(busy) || missingDependencies.length > 0}
                              onClick={() =>
                                void run('build', () =>
                                  toolsService.build(
                                    selectedTool.toolId,
                                    selectedVersion.versionId,
                                  ),
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
                              disabled={Boolean(busy) || missingDependencies.length > 0}
                              onClick={() =>
                                void run('retry', () =>
                                  toolsService.retry(
                                    selectedTool.toolId,
                                    selectedVersion.versionId,
                                  ),
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
                              variant="outline"
                              disabled={Boolean(busy)}
                              onClick={() => requestSecurityReview(selectedTool, selectedVersion)}
                            >
                              {selectedVersion.scanFindings?.status === 'UNSUPPORTED' ? (
                                <Info className="h-3.5 w-3.5" />
                              ) : (
                                <ShieldQuestion className="h-3.5 w-3.5" />
                              )}
                              {selectedVersion.scanFindings?.status === 'UNSUPPORTED'
                                ? 'Continue without scan'
                                : 'Review package findings'}
                            </Button>
                          )}
                          {selectedVersion?.status === 'READY' && (
                            <Button
                              size="sm"
                              disabled={Boolean(busy)}
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
                                disabled={Boolean(busy)}
                                onClick={() => requestRecommendation(selectedTool, selectedVersion)}
                              >
                                <Star className="h-3.5 w-3.5" />
                                {selectedTool.recommendedVersionId
                                  ? 'Replace recommendation'
                                  : 'Make recommended'}
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
                          <ToolLifecycle
                            version={selectedVersion}
                            recommended={
                              selectedVersion.versionId === selectedTool.recommendedVersionId
                            }
                          />
                          <VersionDetails
                            key={selectedVersion.versionId}
                            tool={selectedTool}
                            version={selectedVersion}
                          />
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
                  Add a tool family to begin.
                </div>
              )}
              {error && (
                <div className="whitespace-pre-line rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
                  {error}
                </div>
              )}
            </div>
          </div>
        )}
      </SettingsCard>

      <AlertDialog
        open={Boolean(confirmation)}
        onOpenChange={(open) => {
          if (!open) setConfirmation(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmation?.title}</AlertDialogTitle>
            <AlertDialogDescription>{confirmation?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const action = confirmation?.onConfirm;
                setConfirmation(null);
                action?.();
              }}
            >
              {confirmation?.actionLabel}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
