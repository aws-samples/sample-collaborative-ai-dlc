import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { ApiError } from '@/services/api';
import { realtimeService } from '@/services/realtime';
import {
  myWorkService,
  type PendingQuestion,
  type PendingQuestionKind,
  type UnavailableSpace,
} from '@/services/myWork';

const PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 50;
// Focus/online/visibility refreshes are skipped within this window of the last
// request, so quick tab switches don't hammer the API (useProjectsCache does
// the same with its own TTL).
const RESUME_TTL_MS = 15_000;
const POLL_MS = 60_000;

export type PendingQuestionsStatus = 'loading' | 'ready' | 'error';

interface State {
  /** Identity and filters the state belongs to; anything else reads as initial. */
  scopeKey: string;
  items: PendingQuestion[];
  unavailable: UnavailableSpace[];
  nextCursor: string | null;
  status: PendingQuestionsStatus;
  error: string | null;
  /** The last refresh failed; `items` are from the last successful load. */
  stale: boolean;
  accessLost: boolean;
  loadingMore: boolean;
}

const initialState = (scopeKey: string): State => ({
  scopeKey,
  items: [],
  unavailable: [],
  nextCursor: null,
  status: 'loading',
  error: null,
  stale: false,
  accessLost: false,
  loadingMore: false,
});

const errorMessage = (error: unknown) =>
  error instanceof Error && error.message ? error.message : 'Request failed';

/**
 * Pending questions across the signed-in user's spaces. State lives in the
 * hook only, so nothing survives logout or an account change; responses for a
 * previous identity, filter or superseded request are dropped.
 */
export function usePendingQuestions({
  projectId = null,
  kinds = null,
}: {
  projectId?: string | null;
  kinds?: PendingQuestionKind[] | null;
}) {
  const userId = useAuth().user?.userId ?? null;
  const kindsKey = kinds && kinds.length > 0 ? kinds.join(',') : '';
  const scopeKey = JSON.stringify([userId, projectId, kindsKey]);

  const [state, setState] = useState<State>(() => initialState(scopeKey));
  // A change of user or filters resets synchronously, before any effect runs.
  const view = state.scopeKey === scopeKey ? state : initialState(scopeKey);

  const generation = useRef(0);
  const lastRequestAt = useRef(0);
  const latest = useRef({ scopeKey, userId, projectId, kindsKey, view });
  useEffect(() => {
    latest.current = { scopeKey, userId, projectId, kindsKey, view };
  });

  const fetchFirstPage = useCallback((limit: number) => {
    const {
      scopeKey: stampScope,
      userId: stampUser,
      projectId: pid,
      kindsKey: kk,
    } = latest.current;
    if (!stampUser) return;
    generation.current += 1;
    const stamp = generation.current;
    lastRequestAt.current = Date.now();
    const current = () => generation.current === stamp && latest.current.scopeKey === stampScope;
    myWorkService
      .listPendingQuestions({
        limit,
        projectId: pid,
        kinds: kk ? (kk.split(',') as PendingQuestionKind[]) : null,
      })
      .then((page) => {
        if (!current()) return;
        setState({
          ...initialState(stampScope),
          items: page.items,
          unavailable: page.unavailable,
          nextCursor: page.nextCursor,
          status: 'ready',
        });
      })
      .catch((error: unknown) => {
        if (!current()) return;
        if (
          pid &&
          error instanceof ApiError &&
          error.status === 403 &&
          error.body?.code === 'NOT_A_MEMBER'
        ) {
          setState({ ...initialState(stampScope), status: 'ready', accessLost: true });
          return;
        }
        // A failed background refresh keeps the list already shown and reports
        // the error inline; only a first load with nothing to show is a page error.
        setState((prev) =>
          prev.scopeKey === stampScope && prev.status === 'ready' && prev.items.length > 0
            ? { ...prev, loadingMore: false, stale: true, error: errorMessage(error) }
            : { ...initialState(stampScope), status: 'error', error: errorMessage(error) },
        );
      });
  }, []);

  const refresh = useCallback(() => {
    const loaded = latest.current.view.items.length;
    fetchFirstPage(Math.min(MAX_PAGE_SIZE, Math.max(PAGE_SIZE, loaded)));
  }, [fetchFirstPage]);

  const loadMore = useCallback(() => {
    const {
      scopeKey: stampScope,
      userId: stampUser,
      projectId: pid,
      kindsKey: kk,
      view: v,
    } = latest.current;
    if (!stampUser || !v.nextCursor || v.loadingMore || v.status !== 'ready') return;
    const stamp = generation.current;
    const current = () => generation.current === stamp && latest.current.scopeKey === stampScope;
    setState((prev) => (prev.scopeKey === stampScope ? { ...prev, loadingMore: true } : prev));
    myWorkService
      .listPendingQuestions({
        limit: PAGE_SIZE,
        cursor: v.nextCursor,
        projectId: pid,
        kinds: kk ? (kk.split(',') as PendingQuestionKind[]) : null,
      })
      .then((page) => {
        if (!current()) return;
        setState((prev) => {
          const seen = new Set(prev.items.map((item) => item.id));
          return {
            ...prev,
            items: [...prev.items, ...page.items.filter((item) => !seen.has(item.id))],
            unavailable: page.unavailable,
            nextCursor: page.nextCursor,
            loadingMore: false,
          };
        });
      })
      .catch((error: unknown) => {
        if (!current()) return;
        setState((prev) => ({ ...prev, loadingMore: false, error: errorMessage(error) }));
      });
  }, []);

  // Mount, identity change and filter change: invalidate older requests, then
  // load the first page (none while signed out).
  useEffect(() => {
    generation.current += 1;
    if (userId) fetchFirstPage(PAGE_SIZE);
  }, [scopeKey, userId, fetchFirstPage]);

  // Refresh triggers. There is no user-level realtime channel, so focus,
  // `online`, visibility and the poll are the guaranteed paths; a reconnect
  // seen on the shared socket is an opportunistic extra.
  useEffect(() => {
    if (!userId) return;
    const visible = () => document.visibilityState === 'visible';
    const onResume = () => {
      if (!visible() || Date.now() - lastRequestAt.current < RESUME_TTL_MS) return;
      refresh();
    };
    window.addEventListener('focus', onResume);
    window.addEventListener('online', onResume);
    document.addEventListener('visibilitychange', onResume);
    const poll = setInterval(() => {
      if (visible()) refresh();
    }, POLL_MS);

    // onStatusChange calls back synchronously with the current status; that
    // first call is not a transition. A real reconnect goes disconnected (or
    // error) → connecting → connected.
    let initial = true;
    let wasDown = false;
    const unsubscribe = realtimeService.onStatusChange((status) => {
      if (initial) return;
      if (status === 'disconnected' || status === 'error') wasDown = true;
      else if (status === 'connected' && wasDown) {
        wasDown = false;
        refresh();
      }
    });
    initial = false;

    return () => {
      window.removeEventListener('focus', onResume);
      window.removeEventListener('online', onResume);
      document.removeEventListener('visibilitychange', onResume);
      clearInterval(poll);
      unsubscribe();
    };
  }, [userId, refresh]);

  return {
    items: view.items,
    unavailable: view.unavailable,
    status: view.status,
    error: view.error,
    stale: view.stale,
    accessLost: view.accessLost,
    hasMore: Boolean(view.nextCursor),
    loadingMore: view.loadingMore,
    refresh,
    loadMore,
  };
}
