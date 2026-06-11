import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useYjsDocument } from './useYjsDocument';
import { realtimeService } from '../services/realtime';
import { discussionsService } from '../services/discussions';
import type { DiscussionMessage } from '../services/discussions';
import {
  changeCursorOf,
  displayCursorOf,
  makeMessageId,
  newerOf,
  sortMessages,
} from '../lib/discussion';
import { generateColor } from '../utils/colors';

// Core discussion hook (plan §6/§9).
//
// Channel roles (D8):
//   - REST     → durability (Neptune is the source of truth)
//   - app-WS   → server-driven delivery (discussion.message / .redacted / .updated)
//   - Yjs      → live-sync optimization + typing/presence awareness ONLY
//
// All three converge into one Y.Map('messages') keyed by message id; merge
// precedence is (updatedAt, id) so redactions of already-synced messages win.
// The single render path is the Yjs observer.

export interface PendingMessage {
  id: string;
  content: string;
  status: 'sending' | 'failed';
}

interface UseDiscussionArgs {
  sprintId: string;
  discussionId: string | null;
  /** Connect only while the sheet is open. */
  open: boolean;
  user: { id: string; name: string };
}

const SEED_PAGE_SIZE = 100;

const toPlain = (m: DiscussionMessage): DiscussionMessage => ({ ...m });

export function useDiscussion({ sprintId, discussionId, open, user }: UseDiscussionArgs) {
  const docId = open && discussionId ? `discussion-${sprintId}-${discussionId}` : null;
  const { doc, synced, awareness, remoteUsers } = useYjsDocument(
    docId,
    user.name,
    generateColor(user.id),
  );

  const [messages, setMessages] = useState<DiscussionMessage[]>([]);
  const [pending, setPending] = useState<PendingMessage[]>([]);
  const [hasMoreOlder, setHasMoreOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [seeded, setSeeded] = useState(false);

  // The latest (updatedAt, id) seen — change-delta reconciliation cursor.
  const changeCursorRef = useRef<string | null>(null);

  const messagesMap = useMemo(() => doc.getMap<DiscussionMessage>('messages'), [doc]);

  // ── Single render path: mirror Y.Map('messages') → sorted state ──
  useEffect(() => {
    if (!docId) {
      setMessages([]);
      setPending([]);
      setSeeded(false);
      setHasMoreOlder(false);
      changeCursorRef.current = null;
      return;
    }
    const update = () => {
      const all = sortMessages([...messagesMap.values()]);
      setMessages(all);
      changeCursorRef.current = changeCursorOf(all);
      // A message that arrived through ANY channel clears its pending bubble.
      setPending((prev) => prev.filter((p) => !messagesMap.has(p.id)));
    };
    messagesMap.observeDeep(update);
    update();
    return () => messagesMap.unobserveDeep(update);
  }, [docId, messagesMap]);

  // Idempotent upsert with (updatedAt, id) precedence, batched per transact.
  const upsertMessages = useCallback(
    (incoming: DiscussionMessage[]) => {
      if (incoming.length === 0) return;
      doc.transact(() => {
        for (const m of incoming) {
          const next = newerOf(messagesMap.get(m.id), toPlain(m));
          if (next !== messagesMap.get(m.id)) messagesMap.set(m.id, next);
        }
      });
    },
    [doc, messagesMap],
  );

  // ── Seeding: the latest page on sync (Yjs docs evaporate 60 s after the
  // last client leaves — Neptune reseeds, key-based merge makes concurrent
  // seeding harmless, plan §6) ──
  useEffect(() => {
    if (!docId || !discussionId || !synced || seeded) return;
    let cancelled = false;
    discussionsService
      .listMessages(sprintId, discussionId, { limit: SEED_PAGE_SIZE })
      .then((page) => {
        if (cancelled) return;
        upsertMessages(page.messages);
        setHasMoreOlder(page.hasMore);
        setSeeded(true);
      })
      .catch((err) => console.error('Discussion seed failed:', err));
    return () => {
      cancelled = true;
    };
  }, [docId, discussionId, synced, seeded, sprintId, upsertMessages]);

  // ── Older history on demand (?before= display-order keyset) ──
  const loadOlder = useCallback(async () => {
    if (!discussionId || loadingOlder) return;
    const oldest = sortMessages([...messagesMap.values()])[0];
    if (!oldest) return;
    setLoadingOlder(true);
    try {
      const page = await discussionsService.listMessages(sprintId, discussionId, {
        before: displayCursorOf(oldest),
        limit: SEED_PAGE_SIZE,
      });
      upsertMessages(page.messages);
      setHasMoreOlder(page.hasMore);
    } catch (err) {
      console.error('Load older failed:', err);
    } finally {
      setLoadingOlder(false);
    }
  }, [discussionId, loadingOlder, messagesMap, sprintId, upsertMessages]);

  // ── Change-delta reconciliation backstop (plan §6): on focus/visibility
  // regain, fetch everything with (updatedAt, id) past what we saw — new
  // messages AND redactions of older ones ──
  const reconcile = useCallback(async () => {
    if (!discussionId) return;
    const after = changeCursorRef.current;
    try {
      const page = after
        ? await discussionsService.listMessages(sprintId, discussionId, { after })
        : await discussionsService.listMessages(sprintId, discussionId, {
            limit: SEED_PAGE_SIZE,
          });
      upsertMessages(page.messages);
    } catch (err) {
      console.error('Discussion reconciliation failed:', err);
    }
  }, [discussionId, sprintId, upsertMessages]);

  useEffect(() => {
    if (!docId) return;
    const onVisible = () => {
      if (document.visibilityState === 'visible') reconcile();
    };
    window.addEventListener('focus', onVisible);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('focus', onVisible);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [docId, reconcile]);

  // ── Server-driven fanout (D8): full payloads pushed by the backend ──
  useEffect(() => {
    if (!docId || !discussionId) return;
    const unsubs = [
      realtimeService.on('discussion.message', (data) => {
        if (data.discussionId !== discussionId || !data.message) return;
        upsertMessages([data.message as DiscussionMessage]);
      }),
      realtimeService.on('discussion.message.redacted', (data) => {
        if (data.discussionId !== discussionId) return;
        const existing = messagesMap.get(data.messageId);
        if (!existing) return;
        upsertMessages([
          {
            ...existing,
            content: data.content,
            redacted: true,
            redactedByName: data.redactedBy,
            updatedAt: data.updatedAt,
          },
        ]);
      }),
    ];
    return () => unsubs.forEach((unsub) => unsub());
  }, [docId, discussionId, messagesMap, upsertMessages]);

  // ── Send (plan §6 sequence) ──
  const sendMessage = useCallback(
    async (content: string, mentions: string[] = []) => {
      if (!discussionId) return;
      const trimmed = content.trim();
      if (!trimmed) return;
      const id = makeMessageId();
      setPending((prev) => [...prev, { id, content: trimmed, status: 'sending' }]);
      try {
        const persisted = await discussionsService.postMessage(sprintId, discussionId, {
          id,
          content: trimmed,
          mentions,
        });
        // Fast path: the WS broadcast also delivers this — idempotent by id.
        upsertMessages([persisted]);
        setPending((prev) => prev.filter((p) => p.id !== id));
      } catch (err) {
        console.error('Send failed:', err);
        setPending((prev) =>
          prev.map((p) => (p.id === id ? { ...p, status: 'failed' as const } : p)),
        );
      }
    },
    [discussionId, sprintId, upsertMessages],
  );

  // Failed bubbles retry with the SAME id — idempotent on the server.
  const retryMessage = useCallback(
    async (id: string) => {
      if (!discussionId) return;
      const failed = pending.find((p) => p.id === id);
      if (!failed) return;
      setPending((prev) => prev.map((p) => (p.id === id ? { ...p, status: 'sending' } : p)));
      try {
        const persisted = await discussionsService.postMessage(sprintId, discussionId, {
          id,
          content: failed.content,
        });
        upsertMessages([persisted]);
        setPending((prev) => prev.filter((p) => p.id !== id));
      } catch (err) {
        console.error('Retry failed:', err);
        setPending((prev) =>
          prev.map((p) => (p.id === id ? { ...p, status: 'failed' as const } : p)),
        );
      }
    },
    [discussionId, pending, sprintId, upsertMessages],
  );

  // ── Typing awareness ──
  const typingTimerRef = useRef<number | null>(null);
  const setTyping = useCallback(
    (typing: boolean) => {
      awareness?.setLocalStateField('typing', typing);
      if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
      if (typing) {
        typingTimerRef.current = window.setTimeout(() => {
          awareness?.setLocalStateField('typing', false);
        }, 3000);
      }
    },
    [awareness],
  );
  useEffect(
    () => () => {
      if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    },
    [],
  );

  const typingUsers = useMemo(
    () => [...remoteUsers.values()].filter((u) => u.typing).map((u) => u.name),
    [remoteUsers],
  );

  return {
    messages,
    pending,
    synced,
    seeded,
    hasMoreOlder,
    loadingOlder,
    loadOlder,
    sendMessage,
    retryMessage,
    reconcile,
    setTyping,
    typingUsers,
    remoteUsers,
    /** Direct upsert path for locally-initiated mutations (e.g. redact). */
    applyMessages: upsertMessages,
  };
}
