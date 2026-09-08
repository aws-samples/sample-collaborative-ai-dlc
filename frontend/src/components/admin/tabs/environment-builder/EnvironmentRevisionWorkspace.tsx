import { useEffect, useState } from 'react';
import {
  CheckCircle2,
  ChevronDown,
  Circle,
  CircleCheck,
  ExternalLink,
  FileCode2,
  Hammer,
  Loader2,
  RefreshCw,
  Rocket,
  RotateCw,
  ShieldAlert,
  ShieldCheck,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type {
  EnvironmentDetail,
  EnvironmentRevision,
  ManagedEnvironment,
} from '@/services/environments';
import { environmentsService } from '@/services/environments';
import { cn } from '@/lib/utils';
import { isCatalogRecipe } from './model';
import {
  ACTIVE_REVISION_STATUSES,
  Disclosure,
  severityClass,
  statusClass,
  StatusBadge,
} from './ui';

const securityFindingsAcceptedAt = (revision: EnvironmentRevision) =>
  revision.securityFindingsAcceptedAt ?? revision.highFindingsAcknowledgedAt ?? null;
const securityFindingsAcceptedBy = (revision: EnvironmentRevision) =>
  revision.securityFindingsAcceptedBy ?? revision.highFindingsAcknowledgedBy ?? null;

const ecrConsoleUrl = (imageUri: string | null) => {
  const match = imageUri?.match(
    /^(?<account>\d{12})\.dkr\.ecr\.(?<region>[a-z0-9-]+)\.amazonaws\.com\/(?<repository>[^:@]+)/,
  );
  if (!match?.groups) return null;
  return `https://${match.groups.region}.console.aws.amazon.com/ecr/repositories/private/${match.groups.account}/${match.groups.repository}?region=${match.groups.region}`;
};

export const isActiveRevision = (revision: EnvironmentRevision) =>
  ACTIVE_REVISION_STATUSES.has(revision.status) ||
  (revision.status === 'SECURITY_REVIEW' && Boolean(securityFindingsAcceptedAt(revision)));

function Lifecycle({ revision }: { revision: EnvironmentRevision }) {
  const failed = revision.status === 'FAILED';
  const buildComplete =
    Boolean(revision.imageDigest) ||
    ['SCANNING', 'SECURITY_REVIEW', 'VERIFYING', 'READY', 'PUBLISHED', 'SUPERSEDED'].includes(
      revision.status,
    );
  const checkComplete = ['VERIFYING', 'READY', 'PUBLISHED', 'SUPERSEDED'].includes(revision.status);
  const verificationComplete =
    Boolean(revision.verification) ||
    ['READY', 'PUBLISHED', 'SUPERSEDED'].includes(revision.status);
  const stages = [
    {
      label: 'Define',
      complete: revision.status !== 'DRAFT',
      active: revision.status === 'DRAFT',
    },
    {
      label: 'Build',
      complete: buildComplete,
      active: ['QUEUED', 'BUILDING'].includes(revision.status),
    },
    {
      label: 'Check',
      complete:
        checkComplete &&
        !(
          failed &&
          revision.failure?.reason === 'critical_vulnerability_findings' &&
          !securityFindingsAcceptedAt(revision)
        ),
      active:
        ['SCANNING', 'SECURITY_REVIEW'].includes(revision.status) ||
        (failed && revision.failure?.reason === 'critical_vulnerability_findings'),
    },
    {
      label: 'Verify',
      complete: verificationComplete,
      active: revision.status === 'VERIFYING',
    },
    {
      label: 'Publish',
      complete: revision.status === 'PUBLISHED' || revision.status === 'SUPERSEDED',
      active: revision.status === 'READY',
    },
  ];
  const waiting = ['QUEUED', 'BUILDING', 'SCANNING', 'VERIFYING'].includes(revision.status);
  const ecrUrl = ecrConsoleUrl(revision.imageUri);
  const statusMessage =
    revision.status === 'DRAFT'
      ? 'The definition is ready. Start the build when the composition looks correct.'
      : ['QUEUED', 'BUILDING'].includes(revision.status)
        ? 'CodeBuild is composing and validating the environment image.'
        : revision.status === 'SCANNING'
          ? 'The image is built. ECR is inspecting its operating-system packages.'
          : revision.status === 'SECURITY_REVIEW'
            ? 'The image is built, but package findings need an administrator decision.'
            : revision.status === 'VERIFYING'
              ? 'AgentCore is starting the runtime and checking its behavior.'
              : revision.status === 'READY'
                ? 'All checks are complete. Publish this revision when it is ready for projects.'
                : ['PUBLISHED', 'SUPERSEDED'].includes(revision.status)
                  ? 'This immutable revision has completed the lifecycle.'
                  : revision.failure?.detail || 'This revision needs attention before continuing.';

  return (
    <div className="rounded-lg bg-muted/20 p-2.5">
      <div className="grid grid-cols-5 gap-1">
        {stages.map((stage, index) => (
          <div key={stage.label} className="relative min-w-0 px-1 py-1.5 text-center">
            {index > 0 && (
              <span className="absolute right-1/2 top-[13px] -z-0 h-px w-full bg-border" />
            )}
            <span
              aria-label={`${stage.label}: ${
                stage.complete ? 'complete' : stage.active ? 'current' : 'pending'
              }`}
              className={cn(
                'relative z-10 mx-auto flex h-5 w-5 items-center justify-center rounded-full border bg-background',
                stage.complete && 'border-emerald-500 bg-emerald-500 text-white',
                stage.active && 'border-primary bg-primary text-primary-foreground',
              )}
            >
              {stage.complete ? (
                <CheckCircle2 className="h-3 w-3" />
              ) : stage.active && waiting ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Circle className="h-2.5 w-2.5" />
              )}
            </span>
            <span
              className={cn(
                'mt-1 block truncate text-[9px] text-muted-foreground',
                stage.active && 'font-medium text-foreground',
              )}
            >
              {stage.label}
            </span>
          </div>
        ))}
      </div>
      <div
        role="status"
        className="mt-2 flex flex-col gap-2 border-t px-1 pt-2 text-[11px] text-muted-foreground sm:flex-row sm:items-center sm:justify-between"
      >
        <div className="flex min-w-0 items-start gap-2">
          {waiting && <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-primary" />}
          <span>{statusMessage}</span>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {revision.buildLogUrl && (
            <Button size="sm" variant="outline" asChild>
              <a href={revision.buildLogUrl} target="_blank" rel="noreferrer">
                CodeBuild logs <ExternalLink className="h-3.5 w-3.5" />
              </a>
            </Button>
          )}
          {ecrUrl && revision.imageDigest && (
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

const revisionRole = (environment: ManagedEnvironment, revision: EnvironmentRevision): string => {
  const current = environment.currentRevisionId === revision.revisionId;
  const published = environment.publishedRevisionId === revision.revisionId;
  if (current && published) return 'Current published revision';
  if (current) return 'Current revision';
  if (published) return 'Published revision';
  return 'Previous revision';
};

function EvidenceContent({ revision }: { revision: EnvironmentRevision }) {
  const findings = revision.scanFindings?.findings ?? [];
  const acceptedAt = securityFindingsAcceptedAt(revision);
  const acceptedBy = securityFindingsAcceptedBy(revision);
  const critical = Number(revision.scanFindings?.severityCounts?.CRITICAL ?? 0);
  const high = Number(revision.scanFindings?.severityCounts?.HIGH ?? 0);
  const securityOnlyFailure =
    revision.failure?.reason === 'critical_vulnerability_findings' && Boolean(revision.imageDigest);

  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-3">
        <div className="rounded-xl border p-3">
          <div className="flex items-center justify-between gap-2">
            <h4 className="text-xs font-semibold">Image</h4>
            {revision.imageDigest && <CircleCheck className="h-4 w-4 text-emerald-600" />}
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground">
            {revision.imageDigest ? 'Built successfully' : 'Not built yet'}
          </p>
          {revision.imageSizeBytes && (
            <p className="mt-1 font-mono text-[10px] text-muted-foreground">
              {(revision.imageSizeBytes / 1024 / 1024).toFixed(1)} MiB
            </p>
          )}
        </div>
        <div className="rounded-xl border p-3">
          <div className="flex items-center justify-between gap-2">
            <h4 className="text-xs font-semibold">Image check</h4>
            {acceptedAt ? (
              <ShieldAlert className="h-4 w-4 text-amber-600" />
            ) : revision.scanFindings && critical + high === 0 ? (
              <ShieldCheck className="h-4 w-4 text-emerald-600" />
            ) : null}
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground">
            {acceptedAt
              ? 'Findings accepted'
              : critical + high > 0
                ? `${critical} Critical · ${high} High`
                : revision.scanFindings
                  ? 'Scan passed'
                  : 'Not scanned yet'}
          </p>
          {acceptedAt && (
            <p className="mt-1 text-[10px] text-muted-foreground">
              Accepted{acceptedBy ? ` by ${acceptedBy}` : ''}{' '}
              <time dateTime={acceptedAt}>{new Date(acceptedAt).toLocaleString()}</time>
            </p>
          )}
        </div>
        <div className="rounded-xl border p-3">
          <div className="flex items-center justify-between gap-2">
            <h4 className="text-xs font-semibold">Runtime</h4>
            {revision.verification && <CircleCheck className="h-4 w-4 text-emerald-600" />}
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground">
            {revision.verification ? 'Validation recorded' : 'Not validated yet'}
          </p>
          {revision.runtimeVersion && (
            <p className="mt-1 font-mono text-[10px] text-muted-foreground">
              Version {revision.runtimeVersion}
            </p>
          )}
        </div>
      </div>

      {revision.imageDigest && (
        <Disclosure
          title="Technical image details"
          contentClassName="font-mono text-[10px] text-muted-foreground"
        >
          <p className="break-all">{revision.imageDigest}</p>
        </Disclosure>
      )}

      {findings.length > 0 && (
        <div className="overflow-hidden rounded-xl border">
          <div className="border-b bg-muted/20 px-3 py-2">
            <h4 className="text-xs font-semibold">Security findings</h4>
          </div>
          <div className="divide-y">
            {findings.map((finding, index) => (
              <div
                key={`${finding.id}-${index}`}
                className="grid gap-2 px-3 py-2.5 sm:grid-cols-[90px_minmax(0,1fr)_auto]"
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
        </div>
      )}

      {revision.failure && !securityOnlyFailure && (
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
          <div className="font-medium">{revision.failure.reason ?? 'Build failed'}</div>
          {revision.failure.detail && <div className="mt-1">{revision.failure.detail}</div>}
        </div>
      )}

      {revision.generatedDockerfile && (
        <Disclosure
          title="Generated Dockerfile"
          icon={<FileCode2 className="h-3.5 w-3.5 text-muted-foreground" />}
          contentClassName="p-0"
        >
          <pre className="max-h-96 overflow-auto bg-muted/20 p-3 font-mono text-[11px] leading-relaxed">
            {revision.generatedDockerfile}
          </pre>
        </Disclosure>
      )}
    </div>
  );
}

function Evidence({ revision }: { revision: EnvironmentRevision }) {
  const needsEvidence = revision.status === 'FAILED' || revision.status === 'SECURITY_REVIEW';
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
                Image, package checks, runtime verification, and generated Dockerfile.
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
          <div className="border-t bg-muted/[0.03] p-3">
            <EvidenceContent revision={revision} />
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

export function EnvironmentRevisionWorkspace({
  environment,
  detail,
  selectedRevisionId,
  onSelectRevision,
  busy,
  onRefresh,
  onRun,
  onRequestAccept,
}: {
  environment: ManagedEnvironment;
  detail: EnvironmentDetail;
  selectedRevisionId: string | null;
  onSelectRevision: (revisionId: string) => void;
  busy: string | null;
  onRefresh: () => void;
  onRun: (name: string, action: () => Promise<unknown>) => void;
  onRequestAccept: (revision: EnvironmentRevision, critical: number, high: number) => void;
}) {
  const selectedRevision =
    detail.revisions.find((revision) => revision.revisionId === selectedRevisionId) ??
    detail.revisions[0] ??
    null;
  if (!selectedRevision) {
    return (
      <div className="rounded-xl border border-dashed px-4 py-12 text-center text-xs text-muted-foreground">
        No revisions are available for this environment.
      </div>
    );
  }

  const findingsAcceptedAt = securityFindingsAcceptedAt(selectedRevision);
  const legacySecurityFailure =
    selectedRevision.status === 'FAILED' &&
    selectedRevision.failure?.reason === 'critical_vulnerability_findings' &&
    Boolean(selectedRevision.imageDigest);
  const requiresSecurityAcceptance =
    !findingsAcceptedAt && (selectedRevision.status === 'SECURITY_REVIEW' || legacySecurityFailure);
  const critical = Number(selectedRevision.scanFindings?.severityCounts?.CRITICAL ?? 0);
  const high = Number(selectedRevision.scanFindings?.severityCounts?.HIGH ?? 0);

  return (
    <div className="min-w-0 space-y-3">
      <div className="rounded-xl border bg-card p-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <Select value={selectedRevision.revisionId} onValueChange={onSelectRevision}>
                <SelectTrigger aria-label="Revision" className="h-9 w-full max-w-sm bg-background">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {detail.revisions.map((revision) => (
                    <SelectItem key={revision.revisionId} value={revision.revisionId}>
                      <span className="flex min-w-0 items-center gap-2">
                        <span>{revisionRole(environment, revision)}</span>
                        <span className="truncate font-mono text-[10px] text-muted-foreground">
                          {revision.revisionId}
                        </span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <StatusBadge status={selectedRevision.status} technical />
              <Button
                size="icon"
                variant="ghost"
                className="h-8 w-8"
                title="Refresh revisions"
                aria-label="Refresh revisions"
                onClick={onRefresh}
              >
                <RefreshCw className="h-3.5 w-3.5" />
              </Button>
            </div>
            <p className="mt-1.5 flex flex-wrap gap-x-2 text-[10px] text-muted-foreground">
              <span>{revisionRole(environment, selectedRevision)}</span>
              <span aria-hidden="true">·</span>
              <span className="font-mono">{selectedRevision.revisionId}</span>
              <span aria-hidden="true">·</span>
              <span>Created {new Date(selectedRevision.createdAt).toLocaleString()}</span>
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {selectedRevision.status === 'DRAFT' &&
              !environment.updateAvailable &&
              isCatalogRecipe(selectedRevision.recipe) && (
                <Button
                  size="sm"
                  className="gap-1.5"
                  disabled={Boolean(busy)}
                  onClick={() =>
                    onRun('build', () =>
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
            {selectedRevision.status === 'FAILED' &&
              !environment.updateAvailable &&
              isCatalogRecipe(selectedRevision.recipe) &&
              !legacySecurityFailure && (
                <Button
                  size="sm"
                  className="gap-1.5"
                  disabled={Boolean(busy)}
                  onClick={() =>
                    onRun('retry', () =>
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
            {requiresSecurityAcceptance && (
              <Button
                size="sm"
                className="gap-1.5"
                disabled={Boolean(busy)}
                onClick={() => onRequestAccept(selectedRevision, critical, high)}
              >
                <ShieldAlert className="h-3.5 w-3.5" />
                Review findings
              </Button>
            )}
            {selectedRevision.status === 'SECURITY_REVIEW' && findingsAcceptedAt && (
              <Badge
                variant="outline"
                className={cn('gap-1.5 py-1.5', statusClass('SECURITY_REVIEW'))}
              >
                <ShieldCheck className="h-3.5 w-3.5" />
                Accepted · validation pending
              </Badge>
            )}
            {selectedRevision.status === 'READY' &&
              (environment.environmentId === 'standard' ||
                isCatalogRecipe(selectedRevision.recipe)) && (
                <Button
                  size="sm"
                  className="gap-1.5"
                  disabled={Boolean(busy)}
                  onClick={() =>
                    onRun('publish', () =>
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
        <div className="mt-3 border-t pt-3">
          <Lifecycle revision={selectedRevision} />
        </div>
      </div>

      <Evidence key={selectedRevision.revisionId} revision={selectedRevision} />
    </div>
  );
}
