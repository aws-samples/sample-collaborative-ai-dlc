import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { getNativeListing, nativeAccessDenied } from '@/hooks/useNativeIntents';
import { currentSessionEpoch, isSessionExpiryNotified } from '@/services/sessionExpiry';
import {
  nativeHistoryService,
  type NativeRevision,
  type NativeRevisionFile,
  type NativeSourceBaseline,
} from '@/services/nativeHistory';
import { compareInventory, NativeFileComparison } from './NativeFileComparison';

interface Props {
  projectId: string;
  executionId: string;
  revision: NativeRevision;
  onAccessFailure: (error: unknown) => void;
}
export function NativeSourceComparison(props: Props) {
  return (
    <Comparison
      key={`${props.projectId}:${props.executionId}:${props.revision.id}:${currentSessionEpoch()}`}
      {...props}
    />
  );
}
function Comparison({ projectId, executionId, revision, onAccessFailure }: Props) {
  const [baseline, setBaseline] = useState<NativeSourceBaseline | null>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'missing' | 'failed'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [pair, setPair] = useState<{
    path: string;
    before: NativeRevisionFile | null;
    after: NativeRevisionFile | null;
  } | null>(null);
  const live = useRef(false);
  const generation = useRef(0);
  const epoch = useRef(currentSessionEpoch());
  const access = useRef(getNativeListing(projectId).accessRevision ?? 0);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const current = (request: number) =>
    live.current &&
    generation.current === request &&
    epoch.current === currentSessionEpoch() &&
    !isSessionExpiryNotified() &&
    access.current === (getNativeListing(projectId).accessRevision ?? 0);
  const failed = (err: unknown, request: number) => {
    if (!current(request)) return;
    setPair(null);
    setBaseline(null);
    setStatus('failed');
    setError('The pinned source comparison could not be verified. No partial comparison is shown.');
    if (nativeAccessDenied(err)) onAccessFailure(err);
  };
  const load = async () => {
    const request = ++generation.current;
    setStatus('loading');
    setError(null);
    setPair(null);
    try {
      const source = await nativeHistoryService.source(projectId, executionId, {
        publicationId: revision.id,
        publicationSequence: revision.sequence,
      });
      if (current(request)) {
        setBaseline(source);
        setStatus(source ? 'ready' : 'missing');
      }
    } catch (err) {
      failed(err, request);
    }
  };
  const compare = async (change: ReturnType<typeof compareInventory>[number]) => {
    if (!baseline) return;
    const request = ++generation.current;
    setPair(null);
    try {
      const [before, after] = await Promise.all([
        change.before
          ? nativeHistoryService.file(projectId, executionId, revision, change.before, baseline.id)
          : null,
        change.after
          ? nativeHistoryService.file(projectId, executionId, revision, change.after)
          : null,
      ]);
      if (current(request)) setPair({ path: change.path, before, after });
    } catch (err) {
      failed(err, request);
    }
  };
  return (
    <section aria-label="Pinned source comparison" className="space-y-2">
      <Button variant="outline" disabled={status === 'loading'} onClick={() => void load()}>
        {status === 'loading' ? 'Loading pinned source…' : 'Compare with pinned source'}
      </Button>
      {status === 'missing' && (
        <p>
          No authoritative source baseline was retained for this publication. The pinned commit
          alone does not supply original file bytes. A source diff is unavailable.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {baseline && (
        <>
          <p className="break-all text-xs">
            Pinned source {baseline.repository.commit} · baseline {baseline.id}
          </p>
          <p className="text-xs">
            Comparison covers the complete admitted public-file inventory. Harness, Git and private
            control files are excluded.
          </p>
          <ul>
            {compareInventory(baseline.files, revision.files).map((change) => (
              <li key={change.path}>
                <Button variant="link" onClick={() => void compare(change)}>
                  {change.status}: {change.path}
                </Button>
              </li>
            ))}
          </ul>
          {pair && (
            <section aria-label={`Source change ${pair.path}`}>
              <h4>{pair.path}</h4>
              <NativeFileComparison
                before={pair.before}
                after={pair.after}
                added={pair.before === null}
              />
            </section>
          )}
        </>
      )}
    </section>
  );
}
