import { Fragment, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Button } from '@/components/ui/button';
import { useOptionalAuth } from '@/contexts/AuthContext';
import { ApiError } from '@/services/api';
import {
  getNativeListing,
  nativeAccessDenied,
  useNativeListingVersion,
} from '@/hooks/useNativeIntents';
import { currentSessionEpoch, isSessionActive, onSessionChanged } from '@/services/sessionExpiry';
import {
  nativeResultsService,
  type NativeGitDelivery,
  type NativeGitResultContext,
  type NativeResult,
  type NativeResultRequest,
} from '@/services/nativeResults';
import type { NativePublishedFile } from '@/services/nativeIntents';
import type { NativeRevisionTarget } from '@/services/nativeHistory';

interface Props {
  projectId: string;
  executionId: string;
  target: NativeRevisionTarget;
  file?: NativePublishedFile;
  git?: Omit<NativeGitResultContext, 'previous'>;
  onAccessFailure: (error: unknown) => void;
}
export function NativeResultDownload({ git, ...props }: Props) {
  useNativeListingVersion();
  const session = useSyncExternalStore(onSessionChanged, currentSessionEpoch);
  const auth = useOptionalAuth();
  const listing = getNativeListing(props.projectId);
  if (!isSessionActive() || listing.denied) return null;
  return (
    <Fragment
      key={JSON.stringify([
        props.projectId,
        props.executionId,
        props.target.publicationId,
        props.target.publicationSequence,
        props.file?.id,
        props.file?.sha256,
        git,
        auth?.user?.userId,
        listing.accessRevision,
        session,
      ])}
    >
      <Download {...props} />
      {git && !props.file && <Download {...props} git={git} />}
    </Fragment>
  );
}

function GitDetails({ delivery }: { delivery: NativeGitDelivery }) {
  const { repository, branch, commit, verification, observation } = delivery;
  return (
    <>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
        <dt>Pinned source</dt>
        <dd className="break-all">
          {repository.provider} · {repository.repository} · {repository.branch} ·{' '}
          <code>{repository.commit}</code>
        </dd>
        {commit && (
          <>
            <dt>Bundle branch</dt>
            <dd className="break-all">
              <code>{branch}</code>
            </dd>
            <dt>Prepared commit</dt>
            <dd className="break-all">
              <code>{commit}</code>
            </dd>
          </>
        )}
      </dl>
      {verification.reason && (
        <p className="text-xs text-muted-foreground">
          {verification.reason === 'proof_unavailable'
            ? 'Workflow evidence unavailable.'
            : verification.reason === 'proof_mismatch'
              ? 'Workflow evidence does not match this publication.'
              : 'Git verification was not recorded for this publication.'}
        </p>
      )}
      {observation && (
        <p role="status" className="break-all">
          {observation.status === 'matched' && 'Remote branch matched the prepared commit.'}
          {observation.status === 'different' && (
            <>
              Remote branch pointed to a different commit · <code>{observation.commit}</code>
            </>
          )}
          {observation.status === 'absent' && 'Remote branch was absent.'}
          {observation.status === 'unavailable' && 'Remote branch comparison unavailable.'}
        </p>
      )}
    </>
  );
}
function Download({ projectId, executionId, target, file, git, onAccessFailure }: Props) {
  const [result, setResult] = useState<NativeResult | null>(null);
  const [activity, setActivity] = useState<'idle' | 'preparing' | 'checking'>('idle');
  const [error, setError] = useState<{ message: string; unavailable: boolean } | null>(null);
  const alive = useRef(false);
  const epoch = useRef(currentSessionEpoch());
  const access = useRef(getNativeListing(projectId).accessRevision ?? 0);
  const request = useRef<NativeResultRequest | null>(null);
  const previous = useRef<NativeGitDelivery | undefined>(undefined);
  const context = () => (git ? { ...git, previous: previous.current } : file);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const current = () =>
    alive.current &&
    epoch.current === currentSessionEpoch() &&
    isSessionActive() &&
    access.current === (getNativeListing(projectId).accessRevision ?? 0);
  useLayoutEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      clearTimeout(timer.current);
    };
  }, []);
  const failed = (err: unknown) => {
    if (!current()) return;
    clearTimeout(timer.current);
    setActivity('idle');
    setResult(null);
    const denied = nativeAccessDenied(err);
    const unavailable =
      !!git &&
      err instanceof ApiError &&
      err.status === 409 &&
      (err.body?.code === 'NATIVE_RESULT_GIT_BASE_UNAVAILABLE' ||
        err.body?.code === 'NATIVE_RESULT_GIT_DELTA_UNAVAILABLE');
    setError({
      message: err instanceof Error ? err.message : 'Result unavailable. Retry the same request.',
      unavailable: denied || unavailable,
    });
    if (denied) {
      previous.current = undefined;
      onAccessFailure(err);
    }
  };
  const accept = (value: NativeResult) => {
    if (!current()) return;
    clearTimeout(timer.current);
    previous.current = value.delivery;
    setResult(value);
    const pending =
      !value.delivery?.observation && (value.status === 'pending' || value.status === 'building');
    setActivity(pending ? 'preparing' : 'idle');
    if (value.download) {
      timer.current = setTimeout(
        () => {
          if (current()) {
            setResult((prior) => prior && { ...prior, download: undefined });
          }
        },
        Math.max(0, Date.parse(value.download.expiresAt) - Date.now()),
      );
    } else if (pending) {
      timer.current = setTimeout(() => {
        if (current() && request.current)
          void nativeResultsService
            .status(projectId, executionId, request.current, context())
            .then(accept)
            .catch(failed);
      }, 3000);
    }
  };
  const prepare = async () => {
    if (!current() || activity !== 'idle') return;
    clearTimeout(timer.current);
    request.current ??= {
      requestId: crypto.randomUUID(),
      publicationId: target.publicationId,
      publicationSequence: target.publicationSequence,
      ...(git ? { format: 'git' } : {}),
      ...(file ? { fileId: file.id, sha256: file.sha256 } : {}),
    };
    setActivity('preparing');
    setError(null);
    setResult(null);
    try {
      accept(
        await nativeResultsService.request(projectId, executionId, request.current, context()),
      );
    } catch (err) {
      failed(err);
    }
  };
  const observe = async () => {
    if (!current() || activity !== 'idle' || !git || !result?.delivery?.commit) return;
    setActivity('checking');
    setResult({ ...result, delivery: { ...result.delivery, observation: undefined } });
    try {
      accept(await nativeResultsService.observe(result, git));
    } catch (err) {
      failed(err);
    }
  };
  const name = git ? 'Git bundle' : file ? 'file download' : 'result archive';
  return (
    <div className="space-y-1 text-sm">
      {!git && (
        <p className="text-xs text-muted-foreground">
          {file ? (
            <>
              Exact bytes of <code>{file.path}</code> from published revision{' '}
              {target.publicationSequence}.
            </>
          ) : (
            <>
              ZIP of the published files from revision {target.publicationSequence}, with a checksum
              manifest. Unpublished workspace changes and excluded files are not included.
            </>
          )}
        </p>
      )}
      {result?.delivery && <GitDetails delivery={result.delivery} />}
      {result?.download ? (
        <>
          <Button
            variant="outline"
            onClick={() => {
              if (!current() || Date.parse(result.download!.expiresAt) <= Date.now()) {
                setResult((prior) => prior && { ...prior, download: undefined });
                return;
              }
              window.location.assign(result.download!.downloadUrl);
            }}
          >
            Download {file ? 'exact file' : name}
          </Button>
          <p className="break-all text-xs">
            {result.download.bytes} bytes · SHA-256 {result.download.sha256}
          </p>
          <p className="text-xs text-muted-foreground">
            Download link expires after five minutes. Anyone holding the issued link can use it
            until expiry; access changes prevent issuing a new link.
          </p>
        </>
      ) : (
        !error?.unavailable && (
          <Button variant="outline" disabled={activity !== 'idle'} onClick={() => void prepare()}>
            {activity === 'preparing'
              ? git
                ? 'Preparing Git bundle…'
                : 'Preparing exact result…'
              : `${error || result ? 'Retry' : 'Prepare'} ${name}`}
          </Button>
        )
      )}
      {result?.delivery?.commit && (
        <Button variant="outline" disabled={activity !== 'idle'} onClick={() => void observe()}>
          {activity === 'checking' ? 'Comparing remote branch…' : 'Compare remote branch'}
        </Button>
      )}
      {result && ['failed', 'retryable'].includes(result.status) && (
        <p role="status">
          {result.status === 'failed' ? 'Preparation failed.' : 'Download unavailable.'} Retry the
          same request.
        </p>
      )}
      {error && <p role="alert">{error.message}</p>}
    </div>
  );
}
