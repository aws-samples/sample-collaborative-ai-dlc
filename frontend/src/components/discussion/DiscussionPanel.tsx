import { useEffect, useRef, useState } from 'react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Loader2, CheckCircle2, RotateCcw, ArrowLeft, AlertTriangle, X } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useDiscussion } from '@/hooks/useDiscussion';
import { discussionsService } from '@/services/discussions';
import { generateColor } from '@/utils/colors';
import { firstUnreadIndex } from '@/lib/discussion';
import { AgentStartErrorBanner } from '@/components/AgentStartErrorBanner';
import { DiscussionThread } from './DiscussionThread';
import { DiscussionInput } from './DiscussionInput';
import { ResolveDialog } from './ResolveDialog';
import { useDiscussions } from './DiscussionProvider';

// DiscussionPanel: NON-modal thread view hosted inside the right
// ActivityPanel's Discuss tab — no overlay, the rest of the app stays fully
// interactive while a discussion is open. Header with back-to-list arrow +
// anchor badge + title + presence dots + resolve control, scrollable thread
// opening at the first-unread divider, input footer with mention combobox.
//
// Read marking is VISIBILITY-gated: the cursor advances only when the newest
// message is actually on screen in a visible tab — opening the thread alone
// must not clear unread state.

const ENTITY_LABELS: Record<string, string> = {
  sprint: 'Sprint',
  inception: 'Inception',
  question: 'Question',
  requirement: 'Requirement',
  userstory: 'User Story',
  task: 'Task',
  review: 'Review',
  generalinfo: 'General Info',
  // v2 intent-scoped anchors.
  intent: 'Intent',
  artifact: 'Artifact',
};

export function DiscussionPanel() {
  const ctx = useDiscussions();
  // The discussion scope (sprint or intent) comes from the provider, derived
  // from the route. A null scope (off a scoped route) disables the hook's I/O.
  const scope = ctx?.scope ?? null;
  const { user } = useAuth();
  const currentUser = {
    id: user?.username || '',
    name: user?.displayName || user?.email || '',
  };

  const discussion = ctx?.activeDiscussion ?? null;
  const role = ctx?.role ?? null;
  const canRedact = role === 'admin' || role === 'owner';

  const {
    messages,
    pending,
    synced,
    hasMoreOlder,
    loadingOlder,
    loadOlder,
    sendMessage,
    retryMessage,
    setTyping,
    typingUsers,
    remoteUsers,
    applyMessages,
    invokeAssist,
    assistState,
    streamingReply,
    assistError,
    clearAssistError,
  } = useDiscussion({
    scope,
    discussionId: discussion?.id || null,
    open: !!ctx?.isOpen,
    user: currentUser,
  });

  const [resolveOpen, setResolveOpen] = useState(false);
  const [statusBusy, setStatusBusy] = useState(false);
  // Redaction is a security / legal / compliance action — a silent failure
  // would leave the operator believing sensitive content was removed when it
  // wasn't, so surface failures in a dismissible banner.
  const [redactError, setRedactError] = useState<string | null>(null);

  // ── First-unread divider: pinned to the message that WAS first unread when
  // the thread opened (newer arrivals stay below it) ──
  const [dividerId, setDividerId] = useState<string | null>(null);
  const initialUnreadRef = useRef(0);
  useEffect(() => {
    setDividerId(null);
    setRedactError(null);
    initialUnreadRef.current = discussion?.unreadCount ?? 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [discussion?.id]);
  useEffect(() => {
    if (dividerId !== null || messages.length === 0) return;
    const idx = firstUnreadIndex(messages.length, initialUnreadRef.current);
    setDividerId(idx === null ? '' : messages[idx].id);
  }, [messages, dividerId]);
  const dividerIndex =
    dividerId && dividerId !== '' ? messages.findIndex((m) => m.id === dividerId) : null;

  // ── Visibility-gated read marking (per-thread composite cursor:
  // lastReadAt + lastReadMessageId) ──
  const lastMarkedRef = useRef<string>('');
  const markRead = () => {
    if (!ctx || !discussion || !scope || document.visibilityState !== 'visible') return;
    const newest = messages[messages.length - 1];
    if (!newest) return;
    const cursor = `${newest.createdAt},${newest.id}`;
    if (cursor === lastMarkedRef.current) return;
    lastMarkedRef.current = cursor;
    discussionsService
      .markRead(scope, discussion.id, {
        lastReadAt: newest.createdAt,
        lastReadMessageId: newest.id,
      })
      .then(() => ctx.reloadDiscussions())
      .catch(() => {
        lastMarkedRef.current = '';
      });
  };

  const setStatus = async (input: {
    status: 'open' | 'resolved';
    resolutionSummary?: string;
    outcomeMessageId?: string;
  }) => {
    if (!ctx || !discussion || !scope) return;
    setStatusBusy(true);
    try {
      const updated = await discussionsService.update(scope, discussion.id, input);
      ctx.setActiveDiscussion(updated);
    } finally {
      setStatusBusy(false);
    }
  };

  const redact = async (messageId: string) => {
    if (!discussion || !scope) return;
    setRedactError(null);
    try {
      const redacted = await discussionsService.redact(scope, discussion.id, messageId);
      applyMessages([redacted]);
    } catch (err) {
      console.error('Redact failed:', err);
      setRedactError(
        err instanceof Error
          ? `Couldn't redact the message: ${err.message}. The content was NOT removed — please try again.`
          : "Couldn't redact the message. The content was NOT removed — please try again.",
      );
    }
  };

  if (!ctx) return null;
  const { loading, error, fallbackTitle, close, members } = ctx;

  const title = discussion?.entityTitle || fallbackTitle || 'Discussion';
  const resolved = discussion?.status === 'resolved';

  return (
    <div className="flex min-h-0 flex-1 w-full flex-col">
      <div className="border-b px-3 py-2 space-y-1">
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 shrink-0"
            onClick={close}
            aria-label="Back to discussions"
          >
            <ArrowLeft className="h-3 w-3" />
          </Button>
          {discussion && (
            <Badge variant="outline" className="text-[10px] shrink-0">
              {ENTITY_LABELS[discussion.entityType] || discussion.entityType}
            </Badge>
          )}
          <h2 className="text-sm font-semibold truncate flex-1">{title}</h2>
          {/* Presence dots — who else has this thread open. */}
          <div className="flex -space-x-1 shrink-0">
            {[...remoteUsers.values()].slice(0, 5).map((u, i) => (
              <div
                key={`${u.name}-${i}`}
                className="h-4 w-4 rounded-full ring-1 ring-background"
                style={{ backgroundColor: u.color || generateColor(u.name) }}
                title={u.name}
              />
            ))}
          </div>
          {discussion &&
            (resolved ? (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 text-xs shrink-0"
                disabled={statusBusy}
                onClick={() => setStatus({ status: 'open' })}
              >
                <RotateCcw className="h-3 w-3 mr-1" />
                Reopen
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 text-xs shrink-0 text-agent-success"
                disabled={statusBusy}
                onClick={() => setResolveOpen(true)}
              >
                <CheckCircle2 className="h-3 w-3 mr-1" />
                Resolve
              </Button>
            ))}
        </div>
        <p className="text-xs text-muted-foreground">
          {resolved
            ? `Resolved${discussion?.resolvedByName ? ` by ${discussion.resolvedByName}` : ''}`
            : 'Team discussion — messages are saved to the sprint graph.'}
        </p>
      </div>

      {loading && (
        <div className="flex-1 flex items-center justify-center text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      )}

      {error && !loading && (
        <div className="flex-1 flex items-center justify-center px-6">
          <p className="text-xs text-destructive text-center">{error}</p>
        </div>
      )}

      {discussion && !loading && !error && (
        <>
          {resolved && discussion.resolutionSummary && (
            <div className="border-b bg-muted/50 px-3 py-2">
              <p className="text-[10px] font-medium text-muted-foreground uppercase">Resolution</p>
              <p className="text-xs">{discussion.resolutionSummary}</p>
            </div>
          )}
          <ScrollArea className="flex-1 min-h-0">
            <DiscussionThread
              messages={messages}
              pending={pending}
              currentUserId={currentUser.id}
              hasMoreOlder={hasMoreOlder}
              loadingOlder={loadingOlder}
              onLoadOlder={loadOlder}
              onRetry={retryMessage}
              typingUsers={typingUsers}
              dividerIndex={dividerIndex === -1 ? null : dividerIndex}
              canRedact={canRedact}
              onRedact={redact}
              onBottomVisible={markRead}
              assistState={assistState}
              streamingReply={streamingReply}
            />
          </ScrollArea>
          {!synced && (
            <p className="px-3 py-1 text-[10px] text-muted-foreground border-t">
              Connecting live sync…
            </p>
          )}
          {assistError && (
            <div className="px-3 pt-2">
              <AgentStartErrorBanner error={assistError} onDismiss={clearAssistError} />
            </div>
          )}
          {redactError && (
            <div className="px-3 pt-2">
              <div
                role="alert"
                className="flex items-start gap-2 rounded-md border border-agent-error/30 bg-agent-error/10 px-3 py-2 text-sm text-agent-error"
              >
                <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                <div className="flex-1 min-w-0 break-words">{redactError}</div>
                <button
                  onClick={() => setRedactError(null)}
                  className="shrink-0 opacity-60 hover:opacity-100"
                  aria-label="Dismiss"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          )}
          <DiscussionInput
            onSend={sendMessage}
            onTyping={setTyping}
            members={members}
            // Assist runs as a v1 sprint pool-worker phase — the backend
            // rejects it for intent-scoped threads, so hide the menu there.
            onAssist={scope?.kind === 'sprint' ? invokeAssist : undefined}
            canSuggestAnswer={discussion.entityType === 'question'}
            assistRunning={assistState !== null}
          />
          <ResolveDialog
            open={resolveOpen}
            onOpenChange={setResolveOpen}
            messages={messages}
            onResolve={(input) => setStatus({ status: 'resolved', ...input })}
          />
        </>
      )}
    </div>
  );
}
