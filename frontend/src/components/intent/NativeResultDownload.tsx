import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  getNativeListing,
  nativeAccessDenied,
  useNativeListingVersion,
} from '@/hooks/useNativeIntents';
import {
  currentSessionEpoch,
  isSessionExpiryNotified,
  onSessionChanged,
} from '@/services/sessionExpiry';
import {
  nativeResultsService,
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
  onAccessFailure: (error: unknown) => void;
}
export function NativeResultDownload(props: Props) {
  useNativeListingVersion();
  const access = getNativeListing(props.projectId).accessRevision ?? 0;
  return (
    <Download
      key={`${props.projectId}:${props.executionId}:${props.target.publicationId}:${props.target.publicationSequence}:${props.file?.id}:${props.file?.sha256}:${access}:${currentSessionEpoch()}`}
      {...props}
    />
  );
}
function Download({ projectId, executionId, target, file, onAccessFailure }: Props) {
  const [result, setResult] = useState<NativeResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const alive = useRef(false);
  const epoch = useRef(currentSessionEpoch());
  const access = useRef(getNativeListing(projectId).accessRevision ?? 0);
  const request = useRef<NativeResultRequest | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const current = () =>
    alive.current &&
    epoch.current === currentSessionEpoch() &&
    !isSessionExpiryNotified() &&
    access.current === (getNativeListing(projectId).accessRevision ?? 0);
  useEffect(() => {
    alive.current = true;
    const unsubscribe = onSessionChanged(() => {
      clearTimeout(timer.current);
      setResult(null);
      setBusy(false);
      setExpired(true);
    });
    return () => {
      alive.current = false;
      clearTimeout(timer.current);
      unsubscribe();
    };
  }, []);
  const failed = (err: unknown) => {
    if (!current()) return;
    setBusy(false);
    setResult(null);
    setError(err instanceof Error ? err.message : 'Result unavailable. Retry the same request.');
    if (nativeAccessDenied(err)) onAccessFailure(err);
  };
  const accept = (value: NativeResult) => {
    if (!current()) return;
    setResult(value);
    setBusy(['pending', 'building'].includes(value.status));
    if (value.download) {
      timer.current = setTimeout(
        () => {
          if (current()) {
            setResult(null);
            setExpired(true);
          }
        },
        Math.max(0, Date.parse(value.download.expiresAt) - Date.now()),
      );
    } else if (['pending', 'building'].includes(value.status)) {
      timer.current = setTimeout(() => {
        if (current() && request.current)
          void nativeResultsService
            .status(projectId, executionId, request.current, file)
            .then(accept)
            .catch(failed);
      }, 3000);
    }
  };
  const prepare = async () => {
    if (!current() || busy) return;
    clearTimeout(timer.current);
    request.current ??= {
      requestId: crypto.randomUUID(),
      ...target,
      ...(file ? { fileId: file.id, sha256: file.sha256 } : {}),
    };
    setBusy(true);
    setError(null);
    setExpired(false);
    setResult(null);
    try {
      accept(await nativeResultsService.request(projectId, executionId, request.current, file));
    } catch (err) {
      failed(err);
    }
  };
  return (
    <div className="space-y-1 text-sm">
      {result?.download ? (
        <>
          <Button
            variant="outline"
            onClick={() => {
              if (!current() || Date.parse(result.download!.expiresAt) <= Date.now()) {
                setResult(null);
                setExpired(true);
                return;
              }
              window.location.assign(result.download!.downloadUrl);
            }}
          >
            Download {file ? 'exact file' : 'result archive'}
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
        <Button
          variant="outline"
          disabled={busy || epoch.current !== currentSessionEpoch() || isSessionExpiryNotified()}
          onClick={() => void prepare()}
        >
          {busy
            ? 'Preparing exact result…'
            : `${expired || error || result ? 'Retry' : 'Prepare'} ${file ? 'file download' : 'result archive'}`}
        </Button>
      )}
      {result && ['failed', 'retryable'].includes(result.status) && (
        <p role="status">
          Generation failed or was interrupted. No complete download is available. Retry the same
          request.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
