import { Boxes, ExternalLink } from 'lucide-react';
import { useIntent } from '@/contexts/IntentContext';
import { AGENT_CLI_METADATA, AGENT_CREDENTIAL_SOURCE_LABELS } from '@/lib/agentCli';
import { getIntentStageSelection } from '@/lib/intentStageSelection';
import { formatTrackerSourceLabel } from '@/lib/trackerSourceLabel';
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

interface IntentConfigurationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
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

export function IntentConfigurationDialog({ open, onOpenChange }: IntentConfigurationDialogProps) {
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] gap-0 overflow-y-auto p-0 sm:max-w-2xl">
        <DialogHeader className="border-b px-6 py-5">
          <DialogTitle>Intent configuration</DialogTitle>
          <DialogDescription>Configuration captured when this intent started.</DialogDescription>
        </DialogHeader>

        <div className="divide-y">
          <section className="space-y-4 px-6 py-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-sm font-semibold">Execution</h3>
              </div>
              <Badge variant="outline" className="shrink-0 text-[10px]">
                {intent.status}
              </Badge>
            </div>
            <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
              <Definition label="Scope" value={intent.scope ?? 'Default'} />
              <Definition
                label="Selected steps"
                value={
                  selection
                    ? `${selection.selected.length} of ${selection.available.length}`
                    : 'Unavailable'
                }
              />
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

          {intent.source && (
            <section className="space-y-4 px-6 py-5">
              <div>
                <h3 className="text-sm font-semibold">Source</h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  The tracker item that created the intent.
                </p>
              </div>
              <div className="flex items-center gap-3 rounded-md border bg-muted/20 p-3">
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-background text-sm font-semibold">
                  #
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold">{formatTrackerSourceLabel(intent.source)}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {intent.title || intent.source.provider}
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
                  <Boxes className="h-4 w-4" />
                  Environment
                </h3>
              </div>
              {environment && (
                <Badge
                  variant="outline"
                  className={cn(
                    'shrink-0 font-mono text-[10px]',
                    verification === 'PASSED' &&
                      'border-agent-success/30 bg-agent-success/10 text-agent-success',
                  )}
                >
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
                <Definition label="Verification" value={verification} code />
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
