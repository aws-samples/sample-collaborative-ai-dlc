import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import { discussionsService } from '@/services/discussions';
import type { Discussion, DiscussionEntityType } from '@/services/discussions';
import { DiscussionSheet } from './DiscussionSheet';

// DiscussionProvider (plan §9) — mounted once in SprintLayout. Owns the single
// open DiscussionSheet (one at a time) and the lazy get-or-create call: a
// thread vertex only exists once somebody actually opens the discussion.

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
}

const DiscussionContext = createContext<DiscussionContextValue | null>(null);

/**
 * Null-safe accessor: components like ArtifactCard render their Discuss
 * affordance only when a provider is mounted (i.e. inside a sprint).
 */
export function useDiscussions(): DiscussionContextValue | null {
  return useContext(DiscussionContext);
}

export function DiscussionProvider({ children }: { children: ReactNode }) {
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
    [sprintId],
  );

  const close = useCallback(() => {
    setOpen(false);
    setDiscussion(null);
    setError(null);
  }, []);

  const value = useMemo(
    () => ({ openDiscussion, close, activeDiscussion: discussion }),
    [openDiscussion, close, discussion],
  );

  return (
    <DiscussionContext.Provider value={value}>
      {children}
      <DiscussionSheet
        open={open}
        loading={loading}
        error={error}
        discussion={discussion}
        fallbackTitle={pendingTitle}
        sprintId={sprintId}
        onClose={close}
      />
    </DiscussionContext.Provider>
  );
}
