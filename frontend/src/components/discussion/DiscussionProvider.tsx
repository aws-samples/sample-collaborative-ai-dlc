import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import { discussionsService } from '@/services/discussions';
import type { Discussion, DiscussionEntityType } from '@/services/discussions';

// DiscussionProvider (plan §9) — mounted once in AppShell so the entry-point
// buttons (routed pages) and the ActivityPanel-hosted DiscussionPanel share
// one state. Owns the single open thread (one at a time) and the lazy
// get-or-create call: a thread vertex only exists once somebody actually
// opens the discussion. The thread renders NON-modally inside the right
// ActivityPanel; `onDiscussionOpen` lets the shell pop that panel open.

export interface OpenDiscussionArgs {
  entityType: DiscussionEntityType;
  /** Omitted for sprint/inception threads — the sprint is the anchor. */
  entityId?: string;
  /** Display fallback while the thread loads. */
  entityTitle?: string;
}

interface DiscussionContextValue {
  openDiscussion: (args: OpenDiscussionArgs) => void;
  close: () => void;
  /** The currently open thread (null while loading/closed). */
  activeDiscussion: Discussion | null;
  /** True while a thread is open in the activity panel (incl. while loading). */
  isOpen: boolean;
  loading: boolean;
  error: string | null;
  /** Display fallback while the thread loads. */
  fallbackTitle: string;
}

const DiscussionContext = createContext<DiscussionContextValue | null>(null);

/**
 * Null-safe accessor: components like ArtifactCard render their Discuss
 * affordance only when a provider is mounted (i.e. inside a sprint).
 */
export function useDiscussions(): DiscussionContextValue | null {
  return useContext(DiscussionContext);
}

export function DiscussionProvider({
  children,
  onDiscussionOpen,
}: {
  children: ReactNode;
  /** Called whenever a thread opens — the shell uses it to show the activity panel. */
  onDiscussionOpen?: () => void;
}) {
  const { sprintId = '' } = useParams<{ sprintId: string }>();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [discussion, setDiscussion] = useState<Discussion | null>(null);
  const [pendingTitle, setPendingTitle] = useState('');

  const openDiscussion = useCallback(
    (args: OpenDiscussionArgs) => {
      if (!sprintId) return;
      setOpen(true);
      setLoading(true);
      setError(null);
      setDiscussion(null);
      setPendingTitle(args.entityTitle || '');
      onDiscussionOpen?.();
      discussionsService
        .getOrCreate(sprintId, {
          entityType: args.entityType,
          entityId: args.entityId,
          entityTitle: args.entityTitle,
        })
        .then(setDiscussion)
        .catch((err) => {
          console.error('Failed to open discussion:', err);
          setError(err instanceof Error ? err.message : 'Failed to open discussion');
        })
        .finally(() => setLoading(false));
    },
    [sprintId, onDiscussionOpen],
  );

  const close = useCallback(() => {
    setOpen(false);
    setDiscussion(null);
    setError(null);
  }, []);

  // Leaving the sprint closes the thread.
  useEffect(() => {
    if (!sprintId) close();
  }, [sprintId, close]);

  const value = useMemo(
    () => ({
      openDiscussion,
      close,
      activeDiscussion: discussion,
      isOpen: open,
      loading,
      error,
      fallbackTitle: pendingTitle,
    }),
    [openDiscussion, close, discussion, open, loading, error, pendingTitle],
  );

  return <DiscussionContext.Provider value={value}>{children}</DiscussionContext.Provider>;
}
