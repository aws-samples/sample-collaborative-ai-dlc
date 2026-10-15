import { useEffect, useMemo, useRef, useState } from 'react';
import { ArtifactMarkdown } from './ArtifactMarkdown';
import { CollaborativeTextarea } from '@/components/CollaborativeTextarea';
import { useYjsDocument, type AwarenessUser } from '@/hooks/useYjsDocument';
import { nativeReplyDocument, useNativeCollaborationDigest } from '@/lib/nativeCollaboration';
import type { RealtimeScopeTarget } from '@/lib/realtimeToken';
import { generateColor } from '@/utils/colors';
import QuestionEditor from '@/components/QuestionEditor';
import {
  nativeAnswerText,
  nativeFormError,
  nativeQuestionForEditor,
  nativeSelectionPayload,
} from '@/lib/nativePendingInput';
import type { StructuredAnswer } from '@/services/questions';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { ApiError } from '@/services/api';
import { nativeAccessDenied } from '@/hooks/useNativeIntents';
import {
  nativeIntentsService,
  nativeReplyTextValid,
  NATIVE_REPLY_MAX_BYTES,
  type NativeIntent,
  type NativeInteractionView,
  type NativeReplyRequest,
  type NativeUserReply,
} from '@/services/nativeIntents';

// The shared draft for exactly one interaction/turn, in the existing Yjs
// lifecycle. The document is opened only while that turn awaits a reply; its
// token scope is minted per revision by the protected token route. A draft is
// collaboration state only: the exact text a member submits is frozen into the
// protected response request, and the server accepts one reply per turn.
// Drafts live in Yjs server memory: they survive reconnects, but not the
// last-client grace period (60 s) or a Yjs server restart.
function useSharedReplyDraft({
  intent,
  interaction,
  open,
  userName,
}: {
  intent: NativeIntent;
  interaction: NativeInteractionView | null;
  open: boolean;
  userName: string;
}) {
  const digest = useNativeCollaborationDigest(intent.projectId, intent.id);
  const revision = interaction
    ? { interactionId: interaction.id, sequence: interaction.sequence }
    : null;
  let docId: string | null = null;
  try {
    docId = open && digest && revision ? nativeReplyDocument(digest, revision) : null;
  } catch {
    // An unverifiable revision never opens a shared document; replying stays disabled.
    docId = null;
  }
  const target = useMemo<RealtimeScopeTarget | undefined>(
    () =>
      revision
        ? {
            projectId: intent.projectId,
            intentId: intent.id,
            executionBackend: 'native',
            document: { kind: 'reply', ...revision },
          }
        : undefined,
    // The doc name already encodes the revision; recreate only when it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [docId],
  );
  const { doc, synced, awareness, remoteUsers } = useYjsDocument(
    docId,
    userName || undefined,
    generateColor(userName || intent.id),
    target,
  );
  const yText = useMemo(() => doc.getText('reply'), [doc]);
  // After the document closes (a reply was accepted), keep showing this
  // member's last shared text so an unsent different draft is not lost.
  const [text, setText] = useState('');
  useEffect(() => {
    if (!docId) return;
    const update = () => setText(yText.toString());
    update();
    yText.observe(update);
    return () => yText.unobserve(update);
  }, [yText, docId]);
  return { connected: docId !== null, yText, awareness, remoteUsers, synced, text };
}

// Kept in the publication owner, so switching Overview / Files / Graph does
// not discard a draft or the identity of an uncertain POST.
export function useNativeReply({
  intent,
  interaction,
  scopeCurrent,
  onAccessFailure,
  onRefresh,
  userName = '',
}: {
  intent: NativeIntent;
  interaction: NativeInteractionView | null;
  scopeCurrent: () => boolean;
  onAccessFailure: (error: unknown) => void;
  onRefresh: () => Promise<void>;
  userName?: string;
}) {
  const [state, setState] = useState<'idle' | 'sending' | 'uncertain' | 'accepted' | 'conflict'>(
    'idle',
  );
  const [accepted, setAccepted] = useState<NativeUserReply | null>(null);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<NativeReplyRequest | null>(null);
  const inFlight = useRef(false);
  const generation = useRef(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      generation.current += 1;
      request.current = null;
    };
  }, []);
  // A publication reload may temporarily clear the displayed interaction.
  // Keep this draft/request until the head owner unmounts for a new interaction
  // or an access/session boundary. Never persist it to a browser cache.
  const receipt = interaction?.response ?? accepted;
  const awaitingReply =
    intent.executionAvailable === true &&
    intent.execution?.status === 'AWAITING_USER' &&
    !['revoked', 'unapproved', 'unavailable'].includes(intent.execution.imageStatus ?? '') &&
    intent.execution.responsePending !== true &&
    interaction !== null &&
    interaction.id === intent.execution.interactionId &&
    interaction.publicationId === intent.execution.publicationId &&
    interaction.sequence === intent.execution.turnSequence &&
    interaction.harness === intent.harness &&
    (!request.current ||
      (request.current.interactionId === interaction.id &&
        request.current.contentSha256 === interaction.contentSha256)) &&
    !receipt;
  // Keep the shared document for the life of this unanswered interaction, so
  // transient status (image policy, refresh) never drops the draft; editing
  // and submission are still gated on awaitingReply.
  const shared = useSharedReplyDraft({
    intent,
    interaction,
    open:
      interaction !== null &&
      !interaction.pendingInput &&
      interaction.id === intent.execution?.interactionId &&
      !receipt &&
      state !== 'accepted',
    userName,
  });
  // Task-3: the structured question this turn presented (display data only),
  // edited together in a revision-specific answer document.
  const structured = interaction?.pendingInput ?? null;
  const answerDigest = useNativeCollaborationDigest(intent.projectId, intent.id);
  const answerEditor =
    structured && interaction && answerDigest
      ? {
          question: nativeQuestionForEditor(structured, interaction.id, interaction.createdAt),
          scope: {
            kind: 'native' as const,
            id: intent.id,
            projectId: intent.projectId,
            digest: answerDigest,
            interactionId: interaction.id,
            sequence: interaction.sequence,
          },
          userName,
        }
      : null;
  const text = shared.text;
  const editable = awaitingReply && state === 'idle';
  const canSubmit =
    awaitingReply &&
    ['idle', 'uncertain'].includes(state) &&
    nativeReplyTextValid(request.current?.text ?? text);
  const setText = (next: string) => {
    shared.yText.doc?.transact(() => {
      shared.yText.delete(0, shared.yText.length);
      shared.yText.insert(0, next);
    });
  };

  // Returns the outcome so a structured editor can report failure in place.
  const submit = async (
    selection?: StructuredAnswer,
  ): Promise<'accepted' | 'conflict' | 'uncertain' | 'denied' | 'skipped'> => {
    if (
      !awaitingReply ||
      !['idle', 'uncertain'].includes(state) ||
      !interaction ||
      inFlight.current ||
      !scopeCurrent()
    )
      return 'skipped';
    const requestGeneration = generation.current;
    const current = () =>
      alive.current && scopeCurrent() && requestGeneration === generation.current;
    // Freeze the answer at submission. Later collaborator edits do not change
    // this request; a retry resends exactly these bytes (and selection).
    if (!request.current) {
      const base = {
        requestId: crypto.randomUUID(),
        interactionId: interaction.id,
        contentSha256: interaction.contentSha256,
      };
      let next: NativeReplyRequest;
      if (selection && structured) {
        const payload = nativeSelectionPayload(selection);
        next = { ...base, text: nativeAnswerText(structured, payload), selection: payload };
      } else {
        next = { ...base, text: shared.yText.toString() };
      }
      if (!nativeReplyTextValid(next.text)) return 'skipped';
      request.current = next;
    }
    inFlight.current = true;
    setState('sending');
    setError(null);
    try {
      const result = await nativeIntentsService.respond(
        intent.projectId,
        intent.id,
        request.current,
      );
      if (!current()) return 'skipped';
      if (result.response.sequence !== interaction.sequence + 1) {
        throw new Error('Unverified reply acknowledgement');
      }
      setAccepted(result.response);
      setState('accepted');
      void onRefresh();
      return 'accepted';
    } catch (err) {
      if (!current()) return 'skipped';
      if (nativeAccessDenied(err)) {
        // Stop editing locally; the shared draft is not cleared for members
        // who still have access.
        request.current = null;
        setAccepted(null);
        setError(null);
        onAccessFailure(err);
        return 'denied';
      } else if (err instanceof ApiError && err.status === 409) {
        setState('conflict');
        setError(
          'This interaction changed or a reply was already accepted. Refresh status to see the current turn.',
        );
        void onRefresh();
        return 'conflict';
      } else {
        setState('uncertain');
        setError(
          'Reply acceptance could not be confirmed. Your text is retained; retry sends the same request.',
        );
        void onRefresh();
        return 'uncertain';
      }
    } finally {
      if (current()) inFlight.current = false;
    }
  };
  return {
    text: request.current?.text ?? (text || receipt?.text || ''),
    setText,
    state,
    receipt,
    error,
    editable,
    canSubmit,
    awaitingReply,
    errorFor: (outcome: string) =>
      outcome === 'conflict'
        ? 'This question changed or another member already answered. Refresh status to see the current turn.'
        : outcome === 'uncertain'
          ? 'Your answer could not be confirmed. Submitting again sends the same answer.'
          : 'Answering is not available for this turn.',
    submit,
    structured,
    answerEditor,
    shared: {
      yText: shared.yText,
      awareness: shared.awareness,
      remoteUsers: shared.remoteUsers,
      synced: shared.synced,
      connected: shared.connected,
      // Collaborators may keep editing after this tab froze its request.
      diverged: request.current !== null && request.current.text !== text,
    },
  };
}

function ReplyPresence({ users }: { users: Map<number, AwarenessUser> }) {
  if (users.size === 0) return null;
  const names = Array.from(users.values())
    .map((user) => user.name)
    .filter(Boolean);
  return (
    <div className="flex items-center gap-1" aria-label={`Also editing: ${names.join(', ')}`}>
      {Array.from(users.entries()).map(([id, user]) => (
        <div
          key={id}
          title={user.name}
          className="flex h-5 w-5 items-center justify-center rounded-full text-[10px] text-white"
          style={{ backgroundColor: user.color }}
        >
          {user.name?.charAt(0)}
        </div>
      ))}
      <span className="text-xs text-primary">collaborating…</span>
    </div>
  );
}

export function NativePresentationNotice({ interaction }: { interaction: NativeInteractionView }) {
  if (interaction.presentation?.status !== 'degraded') return null;
  return (
    <div role="status" className="rounded-md border p-3 text-sm">
      <p>
        The structured question form is unavailable for this turn. The response and checkpoint are
        saved.
      </p>
      <p>
        Review the published response and files. If the choices or question are unclear, ask AI-DLC
        to present the current questions again when this turn is open for a reply. Nothing has been
        answered or approved automatically.
      </p>
    </div>
  );
}

export function NativeInteractionPanel({
  interaction,
  reply,
  executionStatus,
}: {
  interaction: NativeInteractionView;
  reply: ReturnType<typeof useNativeReply>;
  executionStatus: NonNullable<NativeIntent['execution']>['status'];
}) {
  const bytes = new TextEncoder().encode(reply.text).length;
  const stopped = ['CANCELLED', 'STOPPED', 'FAILED'].includes(executionStatus);
  const recovery = ['RECOVERY_REQUIRED', 'RECOVERING'].includes(executionStatus);
  return (
    <section aria-label="Published AI-DLC response" className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">AI-DLC response</CardTitle>
          <p className="text-xs text-muted-foreground">
            Turn {interaction.sequence} · {new Date(interaction.createdAt).toLocaleString()}
          </p>
        </CardHeader>
        <CardContent className="min-w-0 space-y-4 overflow-x-auto">
          {interaction.messages.map((message, index) => (
            <div key={index} className="prose prose-sm max-w-none break-words dark:prose-invert">
              <ArtifactMarkdown content={message.text} />
            </div>
          ))}
        </CardContent>
      </Card>
      <NativePresentationNotice interaction={interaction} />
      {reply.structured && !reply.receipt ? (
        <section aria-label="Answer AI-DLC" className="space-y-2">
          {reply.answerEditor ? (
            <QuestionEditor
              key={reply.answerEditor.question.id}
              question={reply.answerEditor.question}
              scope={reply.answerEditor.scope}
              userName={reply.answerEditor.userName}
              disabled={!['idle', 'uncertain'].includes(reply.state) || !reply.awaitingReply}
              discussable={false}
              validateAnswer={(selection) => nativeFormError(reply.structured!, selection)}
              onAnswer={async (selection) => {
                const outcome = await reply.submit(selection);
                if (outcome !== 'accepted' && outcome !== 'denied')
                  throw new Error(reply.errorFor(outcome));
              }}
            />
          ) : (
            <p className="text-sm text-muted-foreground">Loading the shared answer…</p>
          )}
          <p className="text-xs text-muted-foreground">
            Answer the questions together in this form. Project members can edit together; one
            member submits the complete answer set to AI-DLC.
          </p>
          {reply.error && (
            <p role="alert" className="text-sm text-destructive">
              {reply.error}
            </p>
          )}
        </section>
      ) : (
        <form
          aria-label="Reply to AI-DLC"
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            void reply.submit();
          }}
        >
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="native-reply">Reply to AI-DLC</Label>
            <ReplyPresence users={reply.shared.remoteUsers} />
          </div>
          {reply.receipt && reply.text !== reply.receipt.text && (
            <div className="space-y-2 rounded-md border p-3">
              <p className="text-sm">
                A different reply was accepted. Your draft is retained below.
              </p>
              <pre aria-label="Accepted reply" className="whitespace-pre-wrap break-words text-sm">
                {reply.receipt.text}
              </pre>
            </div>
          )}
          {/* One field for every state: the shared draft while this turn is
            editable, otherwise the frozen request or the accepted reply. */}
          <CollaborativeTextarea
            id="native-reply"
            aria-label="Reply to AI-DLC"
            {...(reply.editable && reply.shared.connected
              ? { yText: reply.shared.yText, awareness: reply.shared.awareness }
              : { value: reply.text })}
            disabled={!reply.editable || !reply.shared.connected}
            rows={4}
          />
          <p id="native-reply-help" className="text-xs text-muted-foreground">
            Project members edit this draft together; one member sends it to continue this session.{' '}
            {bytes.toLocaleString()} / {NATIVE_REPLY_MAX_BYTES.toLocaleString()} bytes. Drafts are
            kept while someone has this turn open, not after everyone leaves.
          </p>
          {reply.shared.diverged && (
            <p role="status" className="text-xs text-muted-foreground">
              The shared draft changed after you sent. Retry sends the text shown here.
            </p>
          )}
          {bytes > NATIVE_REPLY_MAX_BYTES && (
            <p role="alert" className="text-sm text-destructive">
              Shorten your reply to 16 KiB or less.
            </p>
          )}
          {reply.error && (
            <p role="alert" className="text-sm text-destructive">
              {reply.error}
            </p>
          )}
          {reply.receipt && (
            <p role="status" className="text-sm text-muted-foreground">
              {recovery
                ? 'Your reply is saved.'
                : stopped
                  ? 'Reply accepted. Execution is no longer continuing.'
                  : executionStatus === 'CANCEL_REQUESTED'
                    ? 'Reply accepted. Cancellation requested.'
                    : reply.receipt.deliveryStatus === 'pending'
                      ? 'Reply accepted. Delivery pending.'
                      : reply.receipt.deliveryStatus === 'delivered'
                        ? 'Reply delivered. Waiting for the next AI-DLC response.'
                        : 'Reply accepted. Historical delivery confirmation is unavailable.'}
            </p>
          )}
          {!reply.receipt && !reply.editable && reply.state === 'idle' && (
            <p className="text-sm text-muted-foreground">
              {recovery
                ? 'Replying is paused while this session needs recovery.'
                : 'Replying is unavailable for this turn. Refresh status to see the current execution.'}
            </p>
          )}
          <Button type="submit" disabled={!reply.canSubmit}>
            {reply.state === 'sending'
              ? 'Sending reply…'
              : reply.state === 'uncertain'
                ? 'Retry same reply'
                : 'Send reply'}
          </Button>
        </form>
      )}
    </section>
  );
}
