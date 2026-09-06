import {
  Boxes,
  Check,
  ExternalLink,
  GitBranch,
  LoaderCircle,
  Workflow,
  XCircle,
} from 'lucide-react';
import { useIntent } from '@/contexts/IntentContext';
import { AGENT_CLI_METADATA, AGENT_CREDENTIAL_SOURCE_LABELS } from '@/lib/agentCli';
import { getIntentStageSelection } from '@/lib/intentStageSelection';
import { getTrackerProvider } from '@/lib/trackerProviders';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import type { IntentSource } from '@/services/intents';

interface IntentConfigurationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenReshape?: () => void;
}

function trackerProviderId(provider: string) {
  if (provider === 'github') return 'github-issues';
  if (provider === 'gitlab') return 'gitlab-issues';
  if (provider === 'bitbucket') return 'bitbucket-issues';
  return provider;
}

function formatSourceReference(source: IntentSource) {
  const resourceType = (source.resourceType || 'issue').toLowerCase();
  const resourceId = source.resourceId.startsWith('#')
    ? source.resourceId
    : `#${source.resourceId}`;
  return `${resourceType} ${resourceId}`;
}

function Definition({
  label,
  value,
  code = false,
  wide = false,
  secondaryValue,
}: {
  label: string;
  value: string;
  code?: boolean;
  wide?: boolean;
  secondaryValue?: string;
}) {
  return (
    <div className={cn('min-w-0 space-y-1', wide && 'sm:col-span-2')}>
      <dt className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className={cn('break-words text-sm font-medium', code && 'break-all font-mono text-xs')}>
        <span className="block">{value}</span>
        {secondaryValue && (
          <span className="mt-1 block break-all font-mono text-xs font-normal text-muted-foreground">
            {secondaryValue}
          </span>
        )}
      </dd>
    </div>
  );
}

export function IntentConfigurationDialog({
  open,
  onOpenChange,
  onOpenReshape,
}: IntentConfigurationDialogProps) {
  const { detail, compiled, initializationPhasePaths } = useIntent();
  if (!detail) return null;

  const intent = detail.intent;
  const environment = intent.environment;
  const selection = compiled
    ? getIntentStageSelection(intent, compiled, initializationPhasePaths)
    : null;
  const verification =
    typeof environment?.verification?.status === 'string'
      ? environment.verification.status
      : 'UNKNOWN';
  const intentModel =
    intent.agentCli && intent.cliModels ? intent.cliModels[intent.agentCli] : undefined;
  const sourceProvider = intent.source
    ? getTrackerProvider(trackerProviderId(intent.source.provider))
    : null;
  const waiting = intent.status === 'WAITING';
  const running = intent.status === 'RUNNING' || intent.status === 'CREATED';
  const succeeded = intent.status === 'SUCCEEDED';
  const failed = intent.status === 'FAILED';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] gap-0 overflow-y-auto p-0 sm:max-w-2xl">
        <DialogHeader className="border-b px-6 py-5">
          <DialogTitle>Intent configuration</DialogTitle>
          <DialogDescription>Configuration captured when this intent started.</DialogDescription>
        </DialogHeader>

        <div className="divide-y">
          {intent.source && (
            <section className="px-6 py-4" aria-label="Source">
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 text-sm font-semibold">
                    {sourceProvider?.icon({ className: 'h-4 w-4 shrink-0' })}
                    <span>Source: {formatSourceReference(intent.source)}</span>
                  </p>
                  <p className="mt-1 truncate text-xs text-muted-foreground">
                    {intent.title || sourceProvider?.displayName || intent.source.provider}
                  </p>
                </div>
                {intent.source.resourceUrl && (
                  <Button variant="outline" size="sm" className="shrink-0 gap-1.5" asChild>
                    <a href={intent.source.resourceUrl} target="_blank" rel="noopener noreferrer">
                      Open
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  </Button>
                )}
              </div>
            </section>
          )}

          <section className="space-y-4 px-6 py-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="flex items-center gap-1.5 text-sm font-semibold">
                  <Workflow className="h-4 w-4" />
                  Execution
                </h3>
              </div>
              <Badge
                variant="outline"
                className={cn(
                  'shrink-0 gap-1.5 text-[10px]',
                  waiting && 'border-agent-waiting/30 bg-agent-waiting/10 text-agent-waiting',
                  running && 'border-agent-running/30 bg-agent-running/10 text-agent-running',
                  succeeded && 'border-agent-success/30 bg-agent-success/10 text-agent-success',
                  failed && 'border-destructive/30 bg-destructive/10 text-destructive',
                )}
              >
                {(waiting || running) && <LoaderCircle className="h-3 w-3 animate-spin" />}
                {succeeded && <Check className="h-3 w-3" />}
                {failed && <XCircle className="h-3 w-3" />}
                {intent.status}
              </Badge>
            </div>
            <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
              <Definition label="Scope" value={intent.scope ?? 'Default'} />
              <div className="min-w-0 space-y-1">
                <dt className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Selected stages
                </dt>
                <dd className="flex items-center gap-2">
                  <span className="text-sm font-medium">
                    {selection
                      ? `${selection.selected.length} of ${selection.available.length}`
                      : 'Unavailable'}
                  </span>
                  {onOpenReshape && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 gap-1.5 px-2.5 text-xs"
                      onClick={() => {
                        onOpenChange(false);
                        onOpenReshape();
                      }}
                    >
                      <GitBranch className="h-3.5 w-3.5" />
                      Reshape
                    </Button>
                  )}
                </dd>
              </div>
              <Definition
                label="Agent"
                value={intent.agentCli ? AGENT_CLI_METADATA[intent.agentCli].label : 'Default'}
                secondaryValue={intentModel ?? 'CLI default'}
              />
              <Definition
                label="Credentials"
                value={
                  intent.credentialSource
                    ? `${AGENT_CREDENTIAL_SOURCE_LABELS[intent.credentialSource]} key`
                    : 'Default'
                }
              />
            </dl>
          </section>

          <section className="space-y-4 px-6 py-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="flex items-center gap-1.5 text-sm font-semibold">
                  <Boxes className="h-4 w-4" />
                  Environment
                </h3>
              </div>
              {environment && (
                <Badge
                  variant="outline"
                  className={cn(
                    'shrink-0 gap-1.5 font-mono text-[10px]',
                    verification === 'PASSED' &&
                      'border-agent-success/30 bg-agent-success/10 text-agent-success',
                  )}
                >
                  {verification === 'PASSED' && <Check className="h-3 w-3" />}
                  {verification}
                </Badge>
              )}
            </div>

            {environment ? (
              <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
                <Definition label="Name" value={environment.name} />
                <Definition label="Revision" value={environment.revisionId} code />
                <Definition
                  label="Image"
                  value={environment.imageDigest ?? 'Unavailable'}
                  code
                  wide
                />
                <Definition
                  label="Endpoint"
                  value={environment.runtimeEndpoint ?? 'Default'}
                  code
                />
                <Definition label="Runtime" value={environment.runtimeVersion ?? 'Legacy'} code />
                <Definition label="Compatibility" value={environment.compatibilityVersion} code />
              </dl>
            ) : (
              <p className="rounded-md border border-dashed px-3 py-4 text-sm text-muted-foreground">
                No environment snapshot was captured for this run.
              </p>
            )}
          </section>
        </div>

        <DialogFooter className="border-t px-6 py-4">
          <DialogClose asChild>
            <Button variant="outline">Close</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
