import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Button } from '@/components/ui/button';
import { useOptionalAuth } from '@/contexts/AuthContext';
import {
  getNativeListing,
  nativeAccessDenied,
  useNativeListingVersion,
} from '@/hooks/useNativeIntents';
import { currentSessionEpoch, isSessionActive, onSessionChanged } from '@/services/sessionExpiry';
import type { NativeGitChange, NativeGitChangeSet } from '@/services/nativeGitChangeSet';
import type { NativePublishedFile } from '@/services/nativeIntents';
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
  useNativeListingVersion();
  const session = useSyncExternalStore(onSessionChanged, currentSessionEpoch);
  const auth = useOptionalAuth();
  const listing = getNativeListing(props.projectId);
  if (!isSessionActive() || listing.denied) return null;
  return (
    <Comparison
      key={JSON.stringify([
        props.projectId,
        props.executionId,
        props.revision.context.attemptId,
        props.revision.id,
        props.revision.sequence,
        auth?.user?.userId,
        session,
        listing.accessRevision,
      ])}
      {...props}
    />
  );
}

const modeName = (file: NonNullable<NativeGitChange['before']>) =>
  file.mode === '100755' ? 'executable' : 'regular';
function gitChangeLabel({ before, after }: NativeGitChange): string {
  if (!before) return `Added (${modeName(after!)})`;
  if (!after) return `Deleted (${modeName(before)})`;
  const bytesChanged = before.sha256 !== after.sha256;
  if (before.mode === after.mode) return 'Bytes changed';
  return `${bytesChanged ? 'Bytes and mode changed' : 'Mode changed'} (${modeName(before)} → ${modeName(after)})`;
}

function GitEvidence({ git }: { git: NativeGitChangeSet }) {
  const terminalLabel = {
    matched: 'Exact match',
    stale: 'Stale',
    not_recorded:
      git.reason === 'proof_unavailable'
        ? 'Evidence unavailable'
        : git.reason === 'proof_mismatch'
          ? 'Evidence mismatch'
          : 'Not recorded',
  };
  const reviewLabel = {
    recorded: 'Reviews recorded',
    not_required: 'No reviewer required',
    not_verified: git.applicability === 'unknown' ? 'Requirements unknown' : 'Not verified',
  };
  return (
    <section aria-label="Git change set evidence" className="space-y-2 text-sm">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <dt>Workflow completion</dt>
        <dd>{git.workflowCompletion?.replace('_', ' ') ?? 'Unavailable in this comparison'}</dd>
        <dt>Terminal Git change set</dt>
        <dd>{terminalLabel[git.terminal]}</dd>
        <dt>Workflow reviewers</dt>
        <dd>{reviewLabel[git.review]}</dd>
        <dt>Delivery / PR readiness</dt>
        <dd>Not assessed</dd>
      </dl>
      {git.reviews.length > 0 && (
        <ul aria-label="Reviewer coverage" className="space-y-1">
          {git.reviews.map((review, index) => (
            <li key={index} className="break-words">
              <span className="font-medium">{review.reviewer}</span>
              {' · '}
              {review.stage}
              {review.unit && ` / ${review.unit}`} · {review.class}
              <p>
                {review.coverage === 'full'
                  ? 'Full change set'
                  : review.coverage === 'scoped'
                    ? 'Stage-scoped changes'
                    : 'Coverage unknown'}
                {' · '}Verdict {review.verdict ?? 'not recorded'}
                {' · '}Freshness {review.freshness.replace('_', ' ')}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
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
    isSessionActive() &&
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
    if (!current(generation.current)) return;
    const request = ++generation.current;
    setStatus('loading');
    setError(null);
    setBaseline(null);
    setPair(null);
    try {
      const source = await nativeHistoryService.source(projectId, executionId, revision);
      if (current(request)) {
        setBaseline(source);
        setStatus(source ? 'ready' : 'missing');
      }
    } catch (err) {
      failed(err, request);
    }
  };
  const compare = async (change: {
    path: string;
    before?: NativePublishedFile | null;
    after?: NativePublishedFile | null;
  }) => {
    if (!baseline || !current(generation.current)) return;
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
  const git = baseline?.gitChangeSet;
  const changes = git
    ? git.changes.map((change) => ({ ...change, status: gitChangeLabel(change) }))
    : baseline
      ? compareInventory(baseline.files, revision.files)
      : [];
  return (
    <section aria-label="Pinned source comparison" className="space-y-2">
      <Button variant="outline" disabled={status === 'loading'} onClick={() => void load()}>
        {status === 'loading' ? 'Loading pinned source…' : 'Compare with pinned source'}
      </Button>
      {status === 'missing' && (
        <p>No authoritative source baseline was retained for this publication.</p>
      )}
      {error && <p role="alert">{error}</p>}
      {baseline && (
        <>
          <p className="break-all text-xs">
            Pinned source {git && `${git.repository.repository} · `}
            {baseline.repository.branch} · {baseline.repository.commit} · baseline {baseline.id}
          </p>
          {git && <GitEvidence git={git} />}
          <h4 className="font-medium text-sm">
            {git ? 'Captured Git changes' : 'Public file inventory'}
          </h4>
          {git && !changes.length && <p>No Git changes were captured.</p>}
          <ul>
            {changes.map((change) => (
              <li key={change.path}>
                <Button
                  variant="link"
                  className="h-auto max-w-full whitespace-normal break-all text-left"
                  onClick={() => void compare(change)}
                >
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
