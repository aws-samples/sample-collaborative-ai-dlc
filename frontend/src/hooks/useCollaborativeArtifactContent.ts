import { useCallback, useEffect, useState } from 'react';
import { simpleDiffStringWithCursor } from 'lib0/diff';
import { useYjsDocument } from './useYjsDocument';
import { useAutoSave } from './useAutoSave';
import { seedYjsDocumentIfEmpty } from '../lib/yjsSeed';

/**
 * Collaborative editing of a v2 intent artifact's markdown content (post-hoc
 * document editing). Yjs doc `intent-artifact-{intentId}-{artifactId}` with a
 * single `content` Y.Text — the v1 useCollaborativeArtifact pattern, adapted
 * for intent scope (the realtime-token endpoint is project-scoped, so the
 * scope target carries both ids; the doc name alone cannot derive it).
 *
 * Diff-based updates preserve remote cursors; `initContent` seeds the shared
 * doc only when it is still empty (the first editor wins, later joiners see
 * the live state). Auto-save (2 s debounce + unmount + beforeunload) persists
 * through `onAutoSave` — the PUT content endpoint.
 */
export function useCollaborativeArtifactContent({
  projectId,
  intentId,
  artifactId,
  userName,
  userColor,
  enabled,
  onAutoSave,
}: {
  projectId: string;
  intentId: string;
  artifactId: string;
  userName: string;
  userColor?: string;
  enabled: boolean;
  onAutoSave?: (content: string) => Promise<void>;
}) {
  const docId = enabled ? `intent-artifact-${intentId}-${artifactId}` : null;
  const { doc, synced, awareness, remoteUsers, setCursor } = useYjsDocument(
    docId,
    userName,
    userColor,
    {
      intentId,
      projectId,
    },
  );
  const [content, setContentState] = useState('');

  useEffect(() => {
    setContentState('');
  }, [docId]);

  useEffect(() => {
    if (!doc || !docId) return;
    const text = doc.getText('content');
    const update = () => setContentState(text.toString());
    text.observe(update);
    update();
    return () => text.unobserve(update);
  }, [doc, docId]);

  const setContent = useCallback(
    (value: string, cursorPos?: number) => {
      if (!doc || !docId) {
        setContentState(value);
        return;
      }
      const text = doc.getText('content');
      const current = text.toString();
      if (current === value) return;
      const cursor = cursorPos ?? value.length;
      const diff = simpleDiffStringWithCursor(current, value, cursor);
      doc.transact(() => {
        if (diff.remove > 0) text.delete(diff.index, diff.remove);
        if (diff.insert) text.insert(diff.index, diff.insert);
      });
    },
    [doc, docId],
  );

  // Seed the shared doc with the artifact's persisted content — only when the
  // Y.Text is still empty, so a later joiner never clobbers live edits.
  const initContent = useCallback(
    (initial: string) => {
      if (!doc || !docId) return;
      seedYjsDocumentIfEmpty(doc, (seed) => {
        if (initial) seed.getText('content').insert(0, initial);
      });
    },
    [doc, docId],
  );

  const getContent = useCallback(
    () => (doc && docId ? doc.getText('content').toString() : content),
    [doc, docId, content],
  );

  // Auto-save: persist the Yjs state to the backend on debounce + unmount +
  // beforeunload (the v1 useCollaborativeArtifact contract).
  const getAutoSaveData = useCallback(() => {
    if (!doc || !docId || !synced) return null;
    const value = doc.getText('content').toString();
    return value ? { content: value } : null;
  }, [doc, docId, synced]);

  const autoSaveHandler = useCallback(
    async (data: { content: string }) => {
      if (onAutoSave) await onAutoSave(data.content);
    },
    [onAutoSave],
  );

  useAutoSave(getAutoSaveData, autoSaveHandler, [content], {
    enabled: enabled && synced && !!onAutoSave,
  });

  return {
    content,
    contentText: doc.getText('content'),
    setContent,
    initContent,
    getContent,
    synced,
    awareness,
    remoteUsers,
    setCursor,
  };
}
