import { useEffect, useRef, useState } from 'react';
import { intentsService, type DeliveryPreview, type IntentDelivery } from '@/services/intents';
import { Button } from '@/components/ui/button';

const labels: Record<string, string> = {
  unknown: 'Delivery not yet verified',
  pending: 'Ready to publish',
  in_progress: 'Publishing pull requests…',
  succeeded: 'Pull requests published',
  failed: 'Delivery needs attention',
  partial: 'Some repositories need attention',
  no_change: 'No changes to publish',
};
export function DeliveryStatus({
  projectId,
  intentId,
  delivery,
  canRetry,
  reload,
}: {
  projectId: string;
  intentId: string;
  delivery?: IntentDelivery;
  canRetry: boolean;
  reload: () => Promise<unknown>;
}) {
  const [preview, setPreview] = useState<DeliveryPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const shown = preview?.delivery ?? delivery;
  const status = shown?.status ?? 'unknown';
  const check = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await intentsService.previewDelivery(projectId, intentId);
      if (alive.current) setPreview(result);
    } catch (cause) {
      if (alive.current)
        setError(cause instanceof Error ? cause.message : 'Delivery could not be checked');
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const retry = async () => {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      await intentsService.retryDelivery(projectId, intentId, preview.previewToken);
      if (alive.current) {
        setPreview(null);
        await reload();
      }
    } catch (cause) {
      if (alive.current) {
        setPreview(null);
        setError(cause instanceof Error ? cause.message : 'Delivery retry could not start');
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  return (
    <section aria-label="Final delivery" className="space-y-2 rounded border p-3 text-sm">
      <p className="font-medium">{labels[status]}</p>
      <p className="text-muted-foreground">
        Publication is separate from stage execution. Retry publishes the existing intent branch; it
        does not regenerate code, rerun stages or merge the pull request.
      </p>
      {shown?.message && <p>{shown.message}</p>}
      {shown?.repositories.map((repo) => (
        <div key={repo.repoId} className="rounded bg-muted/40 p-2">
          <p className="font-medium">
            {repo.repoId} · {labels[repo.status] ?? repo.status}
          </p>
          <p>
            {repo.branch} → {repo.baseBranch ?? 'repository default'}
          </p>
          {repo.reason && <p>{repo.reason}</p>}
          {repo.pr && (
            <a className="underline" href={repo.pr.prUrl} target="_blank" rel="noreferrer">
              View pull request #{repo.pr.prNumber}
            </a>
          )}
        </div>
      ))}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {canRetry &&
        status !== 'in_progress' &&
        !['succeeded', 'no_change'].includes(delivery?.status ?? '') && (
          <div className="flex gap-2">
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void check()}>
              {busy ? 'Checking…' : 'Check delivery'}
            </Button>
            {preview && (preview.retryable || preview.canRecord) && (
              <Button size="sm" disabled={busy} onClick={() => void retry()}>
                {preview.retryable ? 'Retry delivery' : 'Save delivery assessment'}
              </Button>
            )}
          </div>
        )}
      {preview?.historical && (
        <p className="text-muted-foreground">
          This older run has no delivery record. Review the branch and repository results above
          before confirming.
        </p>
      )}
    </section>
  );
}
