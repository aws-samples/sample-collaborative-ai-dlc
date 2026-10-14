import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { compareInventory, NativeFileComparison } from './NativeFileComparison';
import { Button } from '@/components/ui/button';
import { useDiscussions } from '@/components/discussion/DiscussionProvider';
import { ArtifactMarkdown } from './ArtifactMarkdown';
import { NativeFileView } from './NativeFileView';
import { NativeResultDownload } from './NativeResultDownload';
import { NativeSourceComparison } from './NativeSourceComparison';
import { NativeCompletionEvidence } from './NativeCompletionEvidence';
import { getNativeListing, nativeAccessDenied } from '@/hooks/useNativeIntents';
import { currentSessionEpoch, isSessionExpiryNotified } from '@/services/sessionExpiry';
import { nativeHistorySearch, type NativeHistoryLocation } from '@/lib/nativeRevisionLinks';
import { nativeArtifactRevisionId } from '@/lib/nativeCollaboration';
import type { NativeIntent, NativePublishedFile } from '@/services/nativeIntents';
import {
  nativeHistoryService,
  type NativeDecisionHistory,
  type NativePublicationPage,
  type NativeRevision,
  type NativeRevisionFile,
} from '@/services/nativeHistory';

const target = (value: { id: string; sequence: number }) => ({
  publicationId: value.id,
  publicationSequence: value.sequence,
});

export function NativeHistoryView({
  intent,
  selection,
  onAccessFailure,
}: {
  intent: NativeIntent;
  selection: NativeHistoryLocation;
  onAccessFailure: (error: unknown) => void;
}) {
  const { search } = useLocation();
  const [pages, setPages] = useState<NativePublicationPage[]>([]);
  const [revision, setRevision] = useState<NativeRevision | null>(null);
  const [comparison, setComparison] = useState<NativeRevision | null>(null);
  const [decision, setDecision] = useState<NativeDecisionHistory | null>(null);
  const [file, setFile] = useState<NativeRevisionFile | null>(null);
  const [comparedFile, setComparedFile] = useState<NativeRevisionFile | null>(null);
  const [deletedFile, setDeletedFile] = useState<NativeRevisionFile | null>(null);
  const [deletionLoading, setDeletionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [reload, setReload] = useState(0);
  const alive = useRef(false);
  const generation = useRef(0);
  const epoch = useRef(currentSessionEpoch());
  const access = useRef(getNativeListing(intent.projectId).accessRevision ?? 0);
  const discussions = useDiscussions();
  const closeDiscussion = discussions?.close;
  const opened = useRef(false);
  const current = useCallback(
    (request: number) =>
      alive.current &&
      generation.current === request &&
      epoch.current === currentSessionEpoch() &&
      !isSessionExpiryNotified() &&
      access.current === (getNativeListing(intent.projectId).accessRevision ?? 0),
    [intent.projectId],
  );
  const failed = useCallback(
    (err: unknown, request: number) => {
      if (!current(request)) return;
      generation.current += 1;
      setPages([]);
      setRevision(null);
      setComparison(null);
      setDecision(null);
      setFile(null);
      setComparedFile(null);
      setDeletedFile(null);
      setDeletionLoading(false);
      setLoading(false);
      closeDiscussion?.();
      setError(
        'This revision or its history is unavailable or could not be verified. The link has not been redirected to newer content.',
      );
      if (nativeAccessDenied(err)) onAccessFailure(err);
    },
    [current, closeDiscussion, onAccessFailure],
  );

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      generation.current += 1;
      closeDiscussion?.();
    };
  }, [closeDiscussion]);

  const loadPage = useCallback(
    async (before: number | null) => {
      const request = generation.current;
      setLoading(true);
      try {
        const page = await nativeHistoryService.list(intent.projectId, intent.id, before);
        if (current(request)) {
          setPages((previous) => (before === null ? [page] : [...previous, page]));
          setLoading(false);
        }
      } catch (err) {
        failed(err, request);
      }
    },
    [intent.projectId, intent.id, current, failed],
  );

  useEffect(() => {
    if (selection.mode === 'invalid') return;
    void loadPage(null);
  }, [selection.mode, loadPage, reload]);

  useEffect(() => {
    if (!selection.revision) return;
    const request = generation.current;
    const load = async () => {
      const value = await nativeHistoryService.revision(
        intent.projectId,
        intent.id,
        selection.revision!,
      );
      if (value.context.attemptId !== intent.execution?.attemptId)
        throw new Error('Execution changed');
      if (
        selection.file &&
        !value.files.some((f) => f.id === selection.file!.id && f.sha256 === selection.file!.sha256)
      )
        throw new Error('The named file is absent from this publication');
      if (!current(request)) return;
      setRevision(value);
      const history = await nativeHistoryService.decision(intent.projectId, intent.id, value);
      if (history.interaction && history.interaction.harness !== intent.harness)
        throw new Error('Harness changed');
      if (current(request)) setDecision(history);
    };
    void load().catch((err) => failed(err, request));
  }, [
    intent.projectId,
    intent.id,
    intent.execution?.attemptId,
    intent.harness,
    selection,
    current,
    failed,
    reload,
  ]);

  useEffect(() => {
    if (!revision || !selection.compare) return;
    const request = generation.current;
    nativeHistoryService
      .revision(intent.projectId, intent.id, selection.compare)
      .then((value) => {
        if (!current(request)) return;
        if (
          value.context.attemptId !== revision.context.attemptId ||
          value.context.packageId !== revision.context.packageId
        )
          throw new Error('Comparison scope changed');
        setComparison(value);
      })
      .catch((err) => failed(err, request));
  }, [revision, selection.compare, intent.projectId, intent.id, current, failed]);

  const descriptor = revision?.files.find((f) => f.id === selection.file?.id);
  const oldDescriptor = comparison?.files.find((f) => f.path === descriptor?.path);
  useEffect(() => {
    if (!revision || !descriptor) return;
    const request = generation.current;
    nativeHistoryService
      .file(intent.projectId, intent.id, revision, descriptor)
      .then((value) => {
        if (current(request)) setFile(value);
      })
      .catch((err) => failed(err, request));
  }, [revision, descriptor, intent.projectId, intent.id, current, failed]);
  useEffect(() => {
    if (!comparison || !oldDescriptor) return;
    const request = generation.current;
    nativeHistoryService
      .file(intent.projectId, intent.id, comparison, oldDescriptor)
      .then((value) => {
        if (current(request)) setComparedFile(value);
      })
      .catch((err) => failed(err, request));
  }, [comparison, oldDescriptor, intent.projectId, intent.id, current, failed]);

  // A direct discussion link opens only an existing exact anchor. Visiting a
  // shareable URL never creates a thread or substitutes another publication.
  useEffect(() => {
    if (!selection.discussion || !revision || !file || !discussions?.scope || opened.current)
      return;
    const thread = discussions.discussionFor(
      'artifact',
      nativeArtifactRevisionId(file.id, file.sha256),
      revision.id,
      revision.sequence,
    );
    if (thread) {
      opened.current = true;
      discussions.openDiscussionById(thread.id);
    }
  }, [selection.discussion, revision, file, discussions]);

  const href = (value: Parameters<typeof nativeHistorySearch>[1]) => ({
    search: nativeHistorySearch(search, value),
  });
  const items = pages.flatMap((page) => page.items);
  const nextBefore = pages.at(-1)?.nextBefore ?? null;
  const changed = comparison && revision ? compareInventory(comparison.files, revision.files) : [];
  const compareDeletion = async (deletedDescriptor: NativePublishedFile) => {
    if (!comparison || deletionLoading) return;
    const request = generation.current;
    setDeletedFile(null);
    setDeletionLoading(true);
    try {
      const value = await nativeHistoryService.file(
        intent.projectId,
        intent.id,
        comparison,
        deletedDescriptor,
      );
      if (current(request)) {
        setDeletedFile(value);
        setDeletionLoading(false);
      }
    } catch (err) {
      failed(err, request);
    }
  };
  if (selection.mode === 'invalid')
    return (
      <p role="alert">This revision link is invalid. Check the complete link or open History.</p>
    );
  return (
    <section aria-label="Native decision and revision history" className="space-y-4">
      {error ? (
        <div className="space-y-2">
          <p role="alert">{error}</p>
          <Button
            onClick={() => {
              setError(null);
              setReload((n) => n + 1);
            }}
          >
            Retry history
          </Button>
        </div>
      ) : (
        <>
          {revision && (
            <>
              <div className="space-y-1">
                <h2 className="font-semibold">Publication {revision.sequence} · historical view</h2>
                <p className="text-xs text-muted-foreground">
                  {new Date(revision.createdAt).toLocaleString()} · {revision.files.length} files ·
                  epoch {revision.context.epoch}
                </p>
                <p className="text-xs break-all">
                  Publication {revision.id} · Package {revision.context.packageId}
                </p>
                <NativeResultDownload
                  projectId={intent.projectId}
                  executionId={intent.id}
                  target={target(revision)}
                  onAccessFailure={onAccessFailure}
                />
                <NativeCompletionEvidence
                  projectId={intent.projectId}
                  executionId={intent.id}
                  attemptId={revision.context.attemptId}
                  target={target(revision)}
                  onAccessFailure={onAccessFailure}
                />
                <NativeSourceComparison
                  projectId={intent.projectId}
                  executionId={intent.id}
                  revision={revision}
                  onAccessFailure={onAccessFailure}
                />
                <p className="text-sm">
                  Read-only proposal and answer history.
                  {intent.execution?.status === 'AWAITING_USER' &&
                    ' Return to Current to answer the current question.'}
                </p>
                <Link
                  className="text-sm underline"
                  to={href({
                    revision: target(revision),
                    file: descriptor,
                    compare: selection.compare,
                  })}
                >
                  Link to this revision
                </Link>
              </div>
              {decision ? (
                <section aria-label="Historical proposal and decision" className="space-y-3">
                  {decision.interaction ? (
                    decision.interaction.messages.map((message, index) => (
                      <div
                        key={index}
                        className="prose prose-sm max-w-none break-words dark:prose-invert"
                      >
                        <ArtifactMarkdown content={message.text} />
                      </div>
                    ))
                  ) : (
                    <p>No assistant proposal was recorded with this publication.</p>
                  )}
                  {decision.interaction?.pendingInput && (
                    <section aria-label="Published question choices" className="space-y-2">
                      {decision.interaction.pendingInput.questions.map((question) => (
                        <div key={question.id}>
                          {question.header && <h3 className="font-medium">{question.header}</h3>}
                          <p className="whitespace-pre-wrap">{question.prompt}</p>
                          <ul className="list-disc pl-5">
                            {question.options.map((option, index) => (
                              <li key={index}>
                                {option.label}
                                {option.description ? ` — ${option.description}` : ''}
                              </li>
                            ))}
                          </ul>
                          <p className="text-xs">
                            {question.multiSelect
                              ? 'Multiple selections were allowed.'
                              : 'One selection was allowed.'}
                          </p>
                        </div>
                      ))}
                    </section>
                  )}
                  {decision.answer ? (
                    <div className="space-y-2 rounded-md border p-3">
                      <h3 className="font-medium">Accepted human answer</h3>
                      <p className="text-xs">
                        {decision.answer.actorId} ·{' '}
                        {new Date(decision.answer.acceptedAt).toLocaleString()}
                      </p>
                      <pre className="whitespace-pre-wrap break-words text-sm">
                        {decision.answer.text}
                      </pre>
                      <p className="text-sm">
                        Runtime delivery: {decision.answer.deliveryStatus}
                        {decision.answer.deliveredAt
                          ? ` · ${new Date(decision.answer.deliveredAt).toLocaleString()}`
                          : ''}
                      </p>
                      {decision.answer.uncertainAt && (
                        <p className="text-sm">
                          Delivery uncertainty recorded at{' '}
                          {new Date(decision.answer.uncertainAt).toLocaleString()}.
                        </p>
                      )}
                      <p className="text-sm">
                        Engine application, rejection and verified approval/completion: not
                        recorded.
                      </p>
                      {decision.answer.resultingPublication ? (
                        <Link
                          className="underline"
                          to={href({ revision: decision.answer.resultingPublication })}
                        >
                          Open resulting publication{' '}
                          {decision.answer.resultingPublication.publicationSequence}
                        </Link>
                      ) : (
                        <p className="text-sm">
                          A resulting publication is not recorded for this answer.
                        </p>
                      )}
                    </div>
                  ) : (
                    <p>
                      No accepted answer is recorded for this proposal. Rejection or supersession is
                      not established.
                    </p>
                  )}
                </section>
              ) : (
                <p>Loading proposal and answer receipts…</p>
              )}
              <div className="space-y-2">
                <h3 className="font-medium">Files in publication {revision.sequence}</h3>
                {revision.files.map((item) => (
                  <Link
                    className="block break-all text-sm underline"
                    key={item.id}
                    to={href({
                      revision: target(revision),
                      file: item,
                      compare: selection.compare,
                    })}
                  >
                    {item.path}
                  </Link>
                ))}
                {!revision.files.length && <p>This publication contains no files.</p>}
              </div>
              {descriptor &&
                (file ? (
                  <>
                    <NativeFileView
                      file={file}
                      descriptor={descriptor}
                      createdAt={revision.createdAt}
                      publicationSequence={revision.sequence}
                      resultScope={{
                        projectId: intent.projectId,
                        executionId: intent.id,
                        onAccessFailure,
                      }}
                    />
                    <Link
                      className="text-sm underline"
                      to={href({ revision: target(revision), file: descriptor, discussion: true })}
                    >
                      Link to this revision and discussion
                    </Link>
                    {selection.discussion && !opened.current && (
                      <p>
                        No discussion for this exact publication is available yet. Use Discuss to
                        start one.
                      </p>
                    )}
                  </>
                ) : (
                  <p>Loading exact file bytes…</p>
                ))}
              {comparison && (
                <>
                  <h3 className="font-medium">
                    Compare publication {comparison.sequence} → {revision.sequence}
                  </h3>
                  <ul className="space-y-1">
                    {changed.map((change) => (
                      <li key={change.path} className="text-sm">
                        <span>{change.status}: </span>
                        <Link
                          className="underline"
                          to={
                            change.after
                              ? href({
                                  revision: target(revision),
                                  file: change.after,
                                  compare: target(comparison),
                                })
                              : href({ revision: target(comparison), file: change.before })
                          }
                        >
                          {change.path}
                        </Link>
                        {change.status === 'deleted' && ' (open deleted revision)'}
                        {change.status === 'deleted' && (
                          <Button
                            variant="link"
                            disabled={deletionLoading}
                            onClick={() => void compareDeletion(change.before!)}
                          >
                            Compare deletion of {change.path}
                          </Button>
                        )}
                      </li>
                    ))}
                  </ul>
                  {deletionLoading && <p>Loading deleted file bytes…</p>}
                  {deletedFile && (
                    <section aria-label={`Deleted file ${deletedFile.path}`}>
                      <h4>{deletedFile.path} · deleted</h4>
                      <NativeFileComparison before={deletedFile} after={null} added={false} />
                    </section>
                  )}
                  {descriptor &&
                    file &&
                    (oldDescriptor && !comparedFile ? (
                      <p>Loading comparison bytes…</p>
                    ) : (
                      <NativeFileComparison
                        before={comparedFile}
                        after={file}
                        added={!oldDescriptor}
                      />
                    ))}
                </>
              )}
            </>
          )}
          {selection.mode === 'revision' && !revision && <p>Loading the named publication…</p>}
          <section aria-label="Publication history" className="space-y-2">
            <h2 className="font-semibold">Publication history</h2>
            <p className="text-sm">
              Admitted immutable publications. A stopped turn does not verify workflow completion.
            </p>
            {items.map((item) => (
              <div key={item.id} className="flex flex-wrap gap-3 rounded-md border p-2 text-sm">
                <Link className="underline" to={href({ revision: target(item) })}>
                  Open publication {item.sequence}
                </Link>
                <span>
                  {item.filesCount} files · epoch {item.epoch}
                  {item.admittedAt !== null
                    ? ` · admitted ${new Date(item.admittedAt).toLocaleString()}`
                    : ' · admission time not recorded'}
                </span>
                {revision && item.id !== revision.id && (
                  <Link
                    className="underline"
                    to={href({
                      revision: target(revision),
                      file: descriptor,
                      compare: target(item),
                    })}
                  >
                    Compare with {item.sequence}
                  </Link>
                )}
              </div>
            ))}
            {pages
              .flatMap((page) => page.gaps)
              .map((gap) => (
                <p key={`${gap.from}-${gap.to}`} className="text-sm">
                  Immutable history unavailable for publications {gap.from}–{gap.to}. Retained
                  current content remains available in Current.
                </p>
              ))}
            {!loading && pages.length > 0 && !items.length && (
              <p>No immutable publication history is retained.</p>
            )}
            {loading && <p>Loading publication history…</p>}
            {nextBefore !== null && (
              <Button
                variant="outline"
                disabled={loading}
                onClick={() => void loadPage(nextBefore)}
              >
                Earlier publications
              </Button>
            )}
          </section>
        </>
      )}
    </section>
  );
}

export { compareInventory, NativeFileComparison } from './NativeFileComparison';
