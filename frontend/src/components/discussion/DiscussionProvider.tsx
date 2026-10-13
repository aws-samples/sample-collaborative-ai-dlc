import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { ReactNode } from 'react';
import { useParams } from 'react-router';
import { discussionsService } from '@/services/discussions';
import type { Discussion, DiscussionEntityType, DiscussionScope } from '@/services/discussions';
import { projectsService } from '@/services/projects';
import type { AgentCli, Member } from '@/services/projects';
import { realtimeService } from '@/services/realtime';
import { useAuth } from '@/contexts/AuthContext';
import { ApiError } from '@/services/api';
import { currentSessionEpoch, isSessionActive, onSessionChanged } from '@/services/sessionExpiry';
import {
  clearNativeIntents,
  getNativeListing,
  useNativeListingVersion,
} from '@/hooks/useNativeIntents';
import { useNativeCollaborationDigest } from '@/lib/nativeCollaboration';
import { MentionToasts } from './MentionToasts';
import type { MentionToast } from './MentionToasts';

// DiscussionProvider — mounted once in AppShell so both the sprint
// pages (entry-point buttons) and the ActivityPanel-hosted thread share the
// same state. The thread renders NON-modally inside the right ActivityPanel;
// `onDiscussionOpen` lets the shell pop that panel open. Owns:
//   - the single open thread (one at a time) + lazy get-or-create
//   - the sprint's discussions list incl. per-caller unreadCounts, refreshed
//     on discussion.message / discussion.updated fanout
//   - project members (mention combobox + the caller's role for redaction)
//   - mention toasts (online users, in-app only) with jump-to-thread

export interface OpenDiscussionArgs {
  entityType: DiscussionEntityType;
  /** Omitted for sprint/inception threads — the sprint is the anchor. */
  entityId?: string;
  /** Display fallback while the thread loads. */
  entityTitle?: string;
  /** Native artifact threads: the publication containing the exact revision. */
  publicationId?: string;
  publicationSequence?: number;
}

interface DiscussionContextValue {
  /** The active discussion scope (sprint or intent), or null off a scoped route. */
  scope: DiscussionScope | null;
  openDiscussion: (args: OpenDiscussionArgs) => void;
  openDiscussionById: (discussionId: string) => void;
  close: () => void;
  activeDiscussion: Discussion | null;
  /** Replace the active thread after a status change (resolve/reopen). */
  setActiveDiscussion: (d: Discussion) => void;
  /** True while a thread is open in the activity panel (incl. while loading). */
  isOpen: boolean;
  loading: boolean;
  error: string | null;
  /** Display fallback while the thread loads. */
  fallbackTitle: string;
  discussions: Discussion[];
  reloadDiscussions: () => Promise<void>;
  /** Per-entity unread lookup for badges. */
  unreadFor: (entityType: DiscussionEntityType, entityId?: string) => number;
  /** Per-entity thread lookup (ongoing-discussion indicator). */
  discussionFor: (entityType: DiscussionEntityType, entityId?: string) => Discussion | null;
  members: Member[];
  /** The caller's project role (redact is admin/owner only). */
  role: Member['role'] | null;
  /** Explicit CLI selected on the DRAFT compose page for Quorum assists. */
  assistAgentCli: AgentCli | null;
  setAssistAgentCli: (cli: AgentCli | null) => void;
  onAccessFailure: (error: unknown) => void;
}

const DiscussionContext = createContext<DiscussionContextValue | null>(null);

/**
 * Null-safe accessor: components like ArtifactCard render their Discuss
 * affordance only when a provider is mounted.
 */
export function useDiscussions(): DiscussionContextValue | null {
  return useContext(DiscussionContext);
}

const TOAST_TTL_MS = 8000;
// Trailing-debounce window for fanout-triggered list refreshes (see below).
const RELOAD_DEBOUNCE_MS = 600;

export function DiscussionProvider({
  children,
  onDiscussionOpen,
  backend = 'platform',
}: {
  children: ReactNode;
  onDiscussionOpen?: () => void;
  backend?: 'platform' | 'native';
}) {
  const { projectId, intentId, sprintId } = useParams();
  const { user } = useAuth();
  const epoch = useSyncExternalStore(onSessionChanged, currentSessionEpoch);
  useNativeListingVersion();
  const listing = backend === 'native' && projectId ? getNativeListing(projectId) : null;
  const accessDenied = listing?.denied || (listing?.disabled && !!listing.accessRevision);
  // The provider and its thread share one lifetime. Replacing identity/access
  // detaches drafts, pending mutations, member roles and every old callback.
  return (
    <ScopedDiscussionProvider
      key={JSON.stringify([backend, projectId, intentId, sprintId, user?.userId, epoch])}
      backend={backend}
      enabled={!!user && isSessionActive() && !accessDenied}
      onDiscussionOpen={onDiscussionOpen}
    >
      {children}
    </ScopedDiscussionProvider>
  );
}

function ScopedDiscussionProvider({
  children,
  onDiscussionOpen,
  backend = 'platform',
  enabled,
}: {
  children: ReactNode;
  /** Called whenever a thread opens — the shell uses it to show the activity panel. */
  onDiscussionOpen?: () => void;
  /** Native routes use protected native ownership and their own API paths. */
  backend?: 'platform' | 'native';
  enabled: boolean;
}) {
  const {
    sprintId = '',
    projectId = '',
    intentId = '',
  } = useParams<{
    sprintId: string;
    projectId: string;
    intentId: string;
  }>();
  // Derive the discussion scope from the route: sprint pages carry sprintId;
  // the intent page carries projectId + intentId.
  const digest = useNativeCollaborationDigest(
    backend === 'native' ? projectId : null,
    backend === 'native' ? intentId : null,
  );
  const scope = useMemo<DiscussionScope | null>(() => {
    if (!enabled) return null;
    if (backend === 'native') {
      // Never fall back to the platform intent scope for a native route.
      return intentId && projectId && digest
        ? { kind: 'native', projectId, intentId, digest }
        : null;
    }
    if (sprintId) return { kind: 'sprint', sprintId };
    if (intentId && projectId) return { kind: 'intent', projectId, intentId };
    return null;
  }, [backend, digest, sprintId, intentId, projectId, enabled]);
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [discussion, setDiscussion] = useState<Discussion | null>(null);
  const [pendingTitle, setPendingTitle] = useState('');
  const [discussions, setDiscussions] = useState<Discussion[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [toasts, setToasts] = useState<MentionToast[]>([]);
  const [assistAgentCli, setAssistAgentCli] = useState<AgentCli | null>(null);
  const alive = useRef(true);
  const epoch = useRef(currentSessionEpoch()).current;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const scopeCurrent = useCallback(
    () =>
      alive.current &&
      scope !== null &&
      scopeRef.current === scope &&
      epoch === currentSessionEpoch() &&
      isSessionActive(),
    [scope, epoch],
  );
  const openGeneration = useRef(0);
  const listGeneration = useRef(0);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      openGeneration.current++;
      listGeneration.current++;
    };
  }, []);
  const onAccessFailure = useCallback(
    (err: unknown) => {
      if (
        !alive.current ||
        epoch !== currentSessionEpoch() ||
        !isSessionActive() ||
        !(err instanceof ApiError) ||
        ![401, 403, 404].includes(err.status)
      )
        return;
      openGeneration.current++;
      listGeneration.current++;
      setDiscussion(null);
      setDiscussions([]);
      setMembers([]);
      setToasts([]);
      setOpen(false);
      if (backend === 'native') clearNativeIntents(projectId, true);
    },
    [backend, projectId, epoch],
  );

  useEffect(() => {
    setAssistAgentCli(null);
  }, [projectId, intentId]);

  // ── Discussions list (badges + ActivityPanel tab) ──
  const reloadDiscussions = useCallback(async () => {
    const generation = ++listGeneration.current;
    if (!scope || !scopeCurrent()) return;
    try {
      const all = await discussionsService.list(scope);
      if (scopeCurrent() && generation === listGeneration.current) setDiscussions(all);
    } catch (err) {
      if (scopeCurrent() && generation === listGeneration.current) onAccessFailure(err);
    }
  }, [scope, onAccessFailure, scopeCurrent]);

  useEffect(() => {
    setDiscussions([]);
    reloadDiscussions();
  }, [reloadDiscussions]);

  // Coalesce bursts of fan-out events into a single list query. A sprint-wide
  // message broadcasts to every connected member, and each would otherwise
  // fire its own GET /discussions (a non-trivial Neptune traversal): N members
  // chatting in parallel turn one message into N list queries, multiplied
  // across concurrent sprints. Trailing debounce collapses rapid chatter into
  // one refresh per window (lower the delay if it feels laggy).
  const reloadTimerRef = useRef<number | null>(null);
  const scheduleReload = useCallback(() => {
    if (reloadTimerRef.current) clearTimeout(reloadTimerRef.current);
    reloadTimerRef.current = window.setTimeout(() => {
      reloadTimerRef.current = null;
      reloadDiscussions();
    }, RELOAD_DEBOUNCE_MS);
  }, [reloadDiscussions]);

  // Refresh on server fanout — covers other users' messages, resolves and
  // redactions. Debounced so a burst of messages costs one list query.
  useEffect(() => {
    if (!scope) return;
    const unsubs = [
      realtimeService.on('discussion.message', () => scheduleReload()),
      realtimeService.on('discussion.updated', () => scheduleReload()),
    ];
    return () => {
      unsubs.forEach((u) => u());
      if (reloadTimerRef.current) clearTimeout(reloadTimerRef.current);
    };
  }, [scope, scheduleReload]);

  // ── Project members (mention combobox + caller role) ──
  useEffect(() => {
    if (!projectId || !enabled) {
      setMembers([]);
      return;
    }
    let cancelled = false;
    projectsService
      .listMembers(projectId)
      .then((value) => {
        if (!cancelled) setMembers(value);
      })
      .catch((err) => {
        if (!cancelled) {
          setMembers([]);
          onAccessFailure(err);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, enabled, onAccessFailure]);

  const role = useMemo(
    () => members.find((m) => m.userId === user?.userId)?.role ?? null,
    [members, user?.userId],
  );

  // ── Mention toasts ──
  useEffect(() => {
    if (!enabled) setToasts([]);
    if (!scope) return;
    const unsub = realtimeService.on('notification', (data) => {
      if (!scopeCurrent()) return;
      if (data.type !== 'discussion.mention') return;
      const id = `${data.messageId}-${Date.now()}`;
      setToasts((prev) => [
        ...prev.slice(-2),
        {
          id,
          discussionId: data.discussionId,
          byName: data.byName || 'Someone',
          excerpt: data.excerpt || '',
        },
      ]);
      setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), TOAST_TTL_MS);
    });
    return unsub;
  }, [scope, scopeCurrent, enabled]);

  const dismissToast = useCallback(
    (id: string) => setToasts((prev) => prev.filter((t) => t.id !== id)),
    [],
  );

  // ── Thread open/close ──
  const openDiscussion = useCallback(
    (args: OpenDiscussionArgs) => {
      if (!scope || !scopeCurrent()) return;
      const generation = ++openGeneration.current;
      const current = () => scopeCurrent() && generation === openGeneration.current;
      setOpen(true);
      setLoading(true);
      setError(null);
      setDiscussion(null);
      setPendingTitle(args.entityTitle || '');
      onDiscussionOpen?.();
      if (scope.kind === 'sprint') {
        // v1 sprint discussions are read-only — thread creation is gone from
        // the backend, so only an EXISTING thread can be opened for viewing.
        discussionsService
          .list(scope)
          .then((all) => {
            if (!current()) return;
            const existing = all.find(
              (d) =>
                d.entityType === args.entityType &&
                (args.entityId === undefined || d.entityId === args.entityId),
            );
            if (!existing) throw new Error('v1 discussions are read-only.');
            setDiscussion(existing);
            setDiscussions(all);
          })
          .catch((err) => {
            if (!current()) return;
            onAccessFailure(err);
            console.error('Failed to open discussion:', err);
            setError(err instanceof Error ? err.message : 'Failed to open discussion');
          })
          .finally(() => {
            if (current()) setLoading(false);
          });
        return;
      }
      discussionsService
        .getOrCreate(scope, {
          entityType: args.entityType,
          entityId: args.entityId,
          entityTitle: args.entityTitle,
          ...(args.publicationId ? { publicationId: args.publicationId } : {}),
          ...(args.publicationSequence ? { publicationSequence: args.publicationSequence } : {}),
        })
        .then((d) => {
          if (!current()) return;
          setDiscussion(d);
          reloadDiscussions();
        })
        .catch((err) => {
          if (!current()) return;
          onAccessFailure(err);
          console.error('Failed to open discussion:', err);
          setError(err instanceof Error ? err.message : 'Failed to open discussion');
        })
        .finally(() => {
          if (current()) setLoading(false);
        });
    },
    [scope, reloadDiscussions, onDiscussionOpen, onAccessFailure, scopeCurrent],
  );

  const openDiscussionById = useCallback(
    async (discussionId: string) => {
      if (!scope || !scopeCurrent()) return;
      const generation = ++openGeneration.current;
      const current = () => scopeCurrent() && generation === openGeneration.current;
      setOpen(true);
      setLoading(true);
      setError(null);
      setDiscussion(null);
      setPendingTitle('');
      onDiscussionOpen?.();
      try {
        const known =
          discussions.find((d) => d.id === discussionId) ||
          (await discussionsService.list(scope)).find((d) => d.id === discussionId);
        if (!current()) return;
        if (!known) throw new Error('Discussion not found');
        setDiscussion(known);
      } catch (err) {
        if (!current()) return;
        onAccessFailure(err);
        console.error('Failed to open discussion:', err);
        setError(err instanceof Error ? err.message : 'Failed to open discussion');
      } finally {
        if (current()) setLoading(false);
      }
    },
    [scope, discussions, onDiscussionOpen, onAccessFailure, scopeCurrent],
  );

  const close = useCallback(() => {
    openGeneration.current++;
    setOpen(false);
    setDiscussion(null);
    setError(null);
    // Pick up the read-cursor advance the thread made while open.
    reloadDiscussions();
  }, [reloadDiscussions]);

  const setActiveDiscussion = useCallback(
    (d: Discussion) => {
      if (!alive.current) return;
      setDiscussion((current) => (current?.id === d.id ? d : current));
      reloadDiscussions();
    },
    [reloadDiscussions],
  );

  const discussionFor = useCallback(
    (entityType: DiscussionEntityType, entityId?: string) =>
      discussions.find(
        (d) => d.entityType === entityType && (entityId === undefined || d.entityId === entityId),
      ) ?? null,
    [discussions],
  );

  const unreadFor = useCallback(
    (entityType: DiscussionEntityType, entityId?: string) =>
      discussionFor(entityType, entityId)?.unreadCount ?? 0,
    [discussionFor],
  );

  // Leaving the scoped route closes the thread.
  useEffect(() => {
    if (!scope) close();
  }, [scope, close]);

  const value = useMemo(
    () => ({
      scope,
      openDiscussion,
      openDiscussionById,
      close,
      activeDiscussion: discussion,
      setActiveDiscussion,
      isOpen: open,
      loading,
      error,
      fallbackTitle: pendingTitle,
      discussions,
      reloadDiscussions,
      unreadFor,
      discussionFor,
      members,
      role,
      assistAgentCli,
      setAssistAgentCli,
      onAccessFailure,
    }),
    [
      scope,
      openDiscussion,
      openDiscussionById,
      close,
      discussion,
      setActiveDiscussion,
      open,
      loading,
      error,
      pendingTitle,
      discussions,
      reloadDiscussions,
      unreadFor,
      discussionFor,
      members,
      role,
      assistAgentCli,
      onAccessFailure,
    ],
  );

  return (
    <DiscussionContext.Provider value={value}>
      {children}
      <MentionToasts toasts={toasts} onOpen={openDiscussionById} onDismiss={dismissToast} />
    </DiscussionContext.Provider>
  );
}
