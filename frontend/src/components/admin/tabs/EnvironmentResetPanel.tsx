import { useCallback, useEffect, useState } from 'react';
import { Loader2, RefreshCw, ShieldAlert, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { SettingsCard } from '@/components/settings/SettingsCard';
import {
  environmentResetService,
  type ManagedEnvironmentResetPreview,
  type ManagedEnvironmentResetResult,
} from '@/services/environments';

const countLabels: {
  key: keyof ManagedEnvironmentResetPreview['counts'];
  pending: string;
  complete: string;
  resultKey: keyof ManagedEnvironmentResetResult;
}[] = [
  {
    key: 'projects',
    pending: 'Projects to reassign',
    complete: 'Projects reassigned',
    resultKey: 'projectsReassigned',
  },
  {
    key: 'activeIntents',
    pending: 'Active runs to cancel',
    complete: 'Active runs cancelled',
    resultKey: 'intentsCancelled',
  },
  {
    key: 'environments',
    pending: 'Environments to delete',
    complete: 'Environments deleted',
    resultKey: 'environmentsDeleted',
  },
  {
    key: 'revisions',
    pending: 'Revisions to delete',
    complete: 'Revisions deleted',
    resultKey: 'revisionsDeleted',
  },
  {
    key: 'runtimes',
    pending: 'Runtimes to delete',
    complete: 'Runtimes deleted',
    resultKey: 'runtimesDeleted',
  },
  {
    key: 'images',
    pending: 'Images to delete',
    complete: 'Images deleted',
    resultKey: 'imagesDeleted',
  },
];

export function EnvironmentResetPanel() {
  const [preview, setPreview] = useState<ManagedEnvironmentResetPreview | null>(null);
  const [confirmation, setConfirmation] = useState('');
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setPreview(await environmentResetService.preview());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to inspect managed resources');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (preview?.marker?.status !== 'IN_PROGRESS') return;
    const timer = window.setInterval(() => void load(), 3000);
    return () => window.clearInterval(timer);
  }, [load, preview?.marker?.status]);

  const execute = async () => {
    if (!preview) return;
    setRunning(true);
    setError(null);
    try {
      await environmentResetService.execute(confirmation);
      setConfirmation('');
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Managed environment reset failed');
    } finally {
      setRunning(false);
    }
  };

  const complete = preview?.marker?.status === 'COMPLETE';
  const inProgress = preview?.marker?.status === 'IN_PROGRESS';

  return (
    <SettingsCard
      icon={<ShieldAlert />}
      title="Reset Managed Environments"
      description="Remove non-Standard environments before switching this deployment to the tool catalog."
      badge={
        preview?.marker ? (
          <Badge
            variant="outline"
            className={
              preview.marker.status === 'COMPLETE'
                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                : preview.marker.status === 'FAILED'
                  ? 'border-destructive/30 bg-destructive/10 text-destructive'
                  : 'border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300'
            }
          >
            {preview.marker.status.replaceAll('_', ' ')}
          </Badge>
        ) : null
      }
      headerAction={
        <Button
          size="icon"
          variant="ghost"
          title="Refresh"
          disabled={loading || running}
          onClick={() => void load()}
        >
          <RefreshCw className="h-4 w-4" />
        </Button>
      }
    >
      {loading ? (
        <Skeleton className="h-56" />
      ) : preview ? (
        <div className="space-y-5">
          <div className="grid gap-px overflow-hidden rounded border bg-border sm:grid-cols-2 lg:grid-cols-3">
            {countLabels.map(({ key, pending, complete: completeLabel, resultKey }) => (
              <div key={key} className="bg-background p-3">
                <div className="font-mono text-lg font-semibold">
                  {complete && preview.marker?.result
                    ? preview.marker.result[resultKey]
                    : preview.counts[key]}
                </div>
                <div className="text-[11px] text-muted-foreground">
                  {complete ? completeLabel : pending}
                </div>
              </div>
            ))}
          </div>

          {preview.marker?.status === 'FAILED' && (
            <div className="border-l-2 border-destructive/60 pl-3 text-xs text-destructive">
              {preview.marker.failure?.message ?? 'The previous reset did not complete.'}
            </div>
          )}

          {complete ? (
            <div className="border-l-2 border-emerald-500/60 pl-3 text-xs">
              Reset completed
              {preview.marker?.completedBy ? ` by ${preview.marker.completedBy}` : ''}.
            </div>
          ) : (
            <div className="space-y-3 border-t pt-4">
              <div className="space-y-1.5">
                <Label htmlFor="environment-reset-confirmation" className="text-xs">
                  Type <span className="font-mono">{preview.confirmation}</span>
                </Label>
                <Input
                  id="environment-reset-confirmation"
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                  disabled={running || inProgress}
                  className="max-w-xl font-mono text-sm"
                  autoComplete="off"
                />
              </div>
              <Button
                variant="destructive"
                className="gap-1.5"
                disabled={running || inProgress || confirmation !== preview.confirmation}
                onClick={() => void execute()}
              >
                {running || inProgress ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Trash2 className="h-4 w-4" />
                )}
                {inProgress ? 'Reset in progress' : 'Reset Managed Environments'}
              </Button>
            </div>
          )}

          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
      ) : (
        <p className="text-xs text-destructive">{error ?? 'Reset status unavailable'}</p>
      )}
    </SettingsCard>
  );
}
