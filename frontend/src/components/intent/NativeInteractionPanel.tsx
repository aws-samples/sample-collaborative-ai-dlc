import { useEffect, useRef, useState } from 'react';
import { ArtifactMarkdown } from './ArtifactMarkdown';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
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

// Kept in the publication owner, so switching Overview / Files / Graph does
// not discard a draft or the identity of an uncertain POST.
export function useNativeReply({
  intent,
  interaction,
  scopeCurrent,
  onAccessFailure,
  onRefresh,
}: {
  intent: NativeIntent;
  interaction: NativeInteractionView | null;
  scopeCurrent: () => boolean;
  onAccessFailure: (error: unknown) => void;
  onRefresh: () => Promise<void>;
}) {
  const [text, setText] = useState('');
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
  const editable = awaitingReply && state === 'idle';
  const canSubmit =
    awaitingReply &&
    ['idle', 'uncertain'].includes(state) &&
    nativeReplyTextValid(request.current?.text ?? text);

  const submit = async () => {
    if (!canSubmit || !interaction || inFlight.current || !scopeCurrent()) return;
    const requestGeneration = generation.current;
    const current = () =>
      alive.current && scopeCurrent() && requestGeneration === generation.current;
    request.current ??= {
      requestId: crypto.randomUUID(),
      interactionId: interaction.id,
      contentSha256: interaction.contentSha256,
      text,
    };
    inFlight.current = true;
    setState('sending');
    setError(null);
    try {
      const result = await nativeIntentsService.respond(
        intent.projectId,
        intent.id,
        request.current,
      );
      if (!current()) return;
      if (result.response.sequence !== interaction.sequence + 1) {
        throw new Error('Unverified reply acknowledgement');
      }
      setAccepted(result.response);
      setState('accepted');
      void onRefresh();
    } catch (err) {
      if (!current()) return;
      if (nativeAccessDenied(err)) {
        request.current = null;
        setText('');
        setAccepted(null);
        setError(null);
        onAccessFailure(err);
      } else if (err instanceof ApiError && err.status === 409) {
        setState('conflict');
        setError(
          'This interaction changed or a reply was already accepted. Refresh status to see the current turn.',
        );
        void onRefresh();
      } else {
        setState('uncertain');
        setError(
          'Reply acceptance could not be confirmed. Your text is retained; retry sends the same request.',
        );
        void onRefresh();
      }
    } finally {
      if (current()) inFlight.current = false;
    }
  };
  return {
    text: text || receipt?.text || '',
    setText,
    state,
    receipt,
    error,
    editable,
    canSubmit,
    submit,
  };
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
      <form
        aria-label="Reply to AI-DLC"
        className="space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          void reply.submit();
        }}
      >
        <Label htmlFor="native-reply">Reply to AI-DLC</Label>
        {reply.receipt && reply.text !== reply.receipt.text && (
          <div className="space-y-2 rounded-md border p-3">
            <p className="text-sm">A different reply was accepted. Your draft is retained below.</p>
            <pre aria-label="Accepted reply" className="whitespace-pre-wrap break-words text-sm">
              {reply.receipt.text}
            </pre>
          </div>
        )}
        <Textarea
          id="native-reply"
          value={reply.text}
          onChange={(event) => reply.setText(event.target.value)}
          readOnly={!reply.editable}
          aria-describedby="native-reply-help"
          rows={4}
        />
        <p id="native-reply-help" className="text-xs text-muted-foreground">
          Your reply is sent to AI-DLC to continue this session. {bytes.toLocaleString()} /{' '}
          {NATIVE_REPLY_MAX_BYTES.toLocaleString()} bytes.
        </p>
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
                    : 'Reply delivered. Waiting for the next AI-DLC response.'}
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
    </section>
  );
}
