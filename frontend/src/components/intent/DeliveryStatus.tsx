import { useEffect, useRef, useState } from 'react';
import { useIntentOptional } from '@/contexts/IntentContext';
import {
  intentsService,
  type DeliveryPreview,
  type IntentDelivery,
  type IntentPullRequest,
} from '@/services/intents';
import { gitRepoSlug } from '@/services/gitProvider';
import { LoaderCircle, TriangleAlert } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { TONE_CLASSES } from '@/lib/statusModel';

const spinner = (
  <LoaderCircle aria-hidden className="inline size-4 animate-spin motion-reduce:animate-none" />
);

const labels: Record<string, string> = {
  unknown: 'Pull request status unknown',
  pending: 'Ready to open a pull request',
  in_progress: 'Opening pull requests…',
  succeeded: 'Pull request created',
  failed: 'Couldn’t open a pull request',
  partial: 'Some repositories need a pull request',
  no_change: 'No changes to merge',
  uncertain: 'Couldn’t identify the pull request for these changes',
};
const repoShortName = (repository: string | null | undefined) =>
  repository ? (gitRepoSlug(repository).split('/').pop() ?? repository) : null;

export function DeliveryStatus({
  projectId,
  intentId,
  delivery,
  pullRequests,
  canRetry,
  reload,
}: {
  projectId: string;
  intentId: string;
  delivery?: IntentDelivery;
  /** Run-level pull requests the engine already recorded (fan-in). */
  pullRequests?: IntentPullRequest[];
  canRetry: boolean;
  reload: () => Promise<unknown>;
}) {
  const intentContext = useIntentOptional();
  const recordedPrs = (pullRequests ?? intentContext?.detail?.pullRequests ?? []).filter(
    (pr) => pr.prUrl,
  );
  const [preview, setPreview] = useState<DeliveryPreview | null>(null);
  const [busy, setBusy] = useState<'check' | 'retry' | null>(null);
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
    setBusy('check');
    setError(null);
    try {
      const result = await intentsService.previewDelivery(projectId, intentId);
      if (alive.current) setPreview(result);
    } catch (cause) {
      if (alive.current)
        setError(cause instanceof Error ? cause.message : 'Couldn’t check for pull requests.');
    } finally {
      if (alive.current) setBusy(null);
    }
  };
  const retry = async () => {
    setBusy('retry');
    setError(null);
    try {
      const checked = preview ?? (await intentsService.previewDelivery(projectId, intentId));
      if (!alive.current) return;
      setPreview(checked);
      if (!checked.retryable) return;
      // Show newly eligible repositories before opening anything on their branches.
      if (
        checked.delivery.repositories.some(
          (r) =>
            r.retryable &&
            !retryableRows.some(
              (previous) =>
                previous.repoId === r.repoId &&
                previous.branch === r.branch &&
                previous.baseBranch === r.baseBranch,
            ),
        )
      )
        return;
      await intentsService.retryDelivery(projectId, intentId, checked.previewToken);
      if (alive.current) {
        setPreview(null);
        await reload();
      }
    } catch (cause) {
      if (alive.current) {
        setPreview(null);
        setError(cause instanceof Error ? cause.message : 'Couldn’t open the pull request.');
      }
    } finally {
      if (alive.current) setBusy(null);
    }
  };
  const rows = shown?.repositories ?? [];
  // No delivery record yet, but the engine recorded the pull requests: say so
  // instead of "status unknown".
  const recordedOnly = status === 'unknown' && rows.length === 0 && recordedPrs.length > 0;
  const settled =
    status === 'succeeded' ||
    status === 'no_change' ||
    (rows.length > 0 &&
      rows.every(
        (r) =>
          r.status === 'succeeded' ||
          r.status === 'no_change' ||
          (r.pr && ['closed', 'merged'].includes(r.prState ?? '')),
      ));
  const recovering = !settled && status !== 'in_progress';
  const retryableRows = status === 'unknown' ? [] : rows.filter((repo) => repo.retryable);
  const openAction = retryableRows.every((r) => r.status === 'pending') ? 'Open' : 'Retry opening';
  const retryButton = canRetry && recovering && retryableRows.length > 0 && (
    <Button size="sm" disabled={!!busy} onClick={() => void retry()}>
      {busy === 'retry' ? (
        <>{spinner} Opening pull requests…</>
      ) : (
        `${openAction} pull request${retryableRows.length > 1 ? 's' : ''}`
      )}
    </Button>
  );
  return (
    <Card role="region" aria-label="Pull requests">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">Pull requests</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {recordedOnly &&
          recordedPrs.map((pr) => (
            <div key={pr.id}>
              <p>
                <a
                  className="underline"
                  href={pr.prUrl ?? undefined}
                  target="_blank"
                  rel="noreferrer"
                >
                  Pull request{pr.prNumber ? ` #${pr.prNumber}` : ''}
                </a>{' '}
                was created in {repoShortName(pr.repository) ?? 'the repository'}.
              </p>
              {pr.branch && (
                <p>
                  Branch: {pr.branch}
                  {pr.baseBranch && ` → ${pr.baseBranch}`}
                </p>
              )}
            </div>
          ))}
        {!recordedOnly &&
          (rows.length === 0 ||
            status === 'in_progress' ||
            (status === 'unknown' && shown?.leaseUntil)) && (
            <p role="status" className="flex items-center gap-2">
              {status === 'in_progress' && spinner}
              {status === 'unknown' && (
                <TriangleAlert aria-hidden className={`size-4 ${TONE_CLASSES.warning.text}`} />
              )}
              {shown?.leaseUntil && status === 'unknown'
                ? 'Opening pull requests timed out. Status unknown.'
                : labels[status]}
            </p>
          )}
        {rows.map((repo) => {
          const terminalPr = repo.pr && ['closed', 'merged'].includes(repo.prState ?? '');
          return (
            <div key={repo.repoId}>
              {repo.pr && (
                <p>
                  <a className="underline" href={repo.pr.prUrl} target="_blank" rel="noreferrer">
                    Pull request #{repo.pr.prNumber}
                  </a>{' '}
                  {repo.prState === 'closed'
                    ? 'was closed without merging'
                    : repo.prState === 'merged'
                      ? 'was merged'
                      : 'was created'}{' '}
                  in {repo.repoId}.
                </p>
              )}
              {!terminalPr && (!repo.pr || repo.status !== 'succeeded') && (
                <>
                  <p>
                    {repo.repoId} · {labels[repo.status] ?? 'Check the pull request'}
                  </p>
                  {recovering && (
                    <>
                      {repo.branch && (
                        <p>
                          Branch: {repo.branch}
                          {repo.baseBranch && ` → ${repo.baseBranch}`}
                        </p>
                      )}
                      {repo.conflictingPrUrls?.map((url) => (
                        <p key={url}>
                          <a className="underline" href={url} target="_blank" rel="noreferrer">
                            {url}
                          </a>
                        </p>
                      ))}
                      {repo.reason &&
                        !['pending', 'succeeded', 'no_change'].includes(repo.status) && (
                          <p>{repo.reason}</p>
                        )}
                    </>
                  )}
                </>
              )}
              {repo.retryable && retryableRows.length === 1 && retryButton}
            </div>
          );
        })}
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
        {canRetry && recovering && retryableRows.length === 0 && (
          <Button size="sm" variant="outline" disabled={!!busy} onClick={() => void check()}>
            {busy === 'check' ? (
              <>{spinner} Looking for pull requests…</>
            ) : (
              'Check for pull requests'
            )}
          </Button>
        )}
        {retryableRows.length > 1 && retryButton}
      </CardContent>
    </Card>
  );
}
