import { useCallback, useEffect, useState } from 'react';
import { simpleDiffStringWithCursor } from 'lib0/diff';
import { useYjsDocument } from '@/hooks/useYjsDocument';
import { generateColor } from '@/utils/colors';

export function useCollaborativeReviewFeedback({
  projectId,
  intentId,
  humanTaskId,
  userName,
  enabled,
}: {
  projectId: string;
  intentId: string;
  humanTaskId: string;
  userName: string;
  enabled: boolean;
}) {
  const docId = enabled ? `intent-review-${intentId}-${humanTaskId}` : null;
  const { doc, synced, awareness, remoteUsers, documentReadOnly } = useYjsDocument(
    docId,
    userName,
    generateColor(userName || humanTaskId),
    { intentId, projectId },
  );
  const [feedback, setFeedbackState] = useState('');

  useEffect(() => {
    setFeedbackState('');
  }, [docId]);

  useEffect(() => {
    if (!doc || !docId) return;
    const text = doc.getText('feedback');
    const update = () => setFeedbackState(text.toString());
    text.observe(update);
    update();
    return () => text.unobserve(update);
  }, [doc, docId]);

  // Native-textarea fallback for isolated tests. The production editor binds
  // directly to this Y.Text and does not call this whole-value setter.
  const setFeedback = useCallback(
    (value: string, cursorPos?: number) => {
      if (!doc || !docId) {
        setFeedbackState(value);
        return;
      }
      const text = doc.getText('feedback');
      const current = text.toString();
      if (current === value) return;
      const diff = simpleDiffStringWithCursor(current, value, cursorPos ?? value.length);
      doc.transact(() => {
        if (diff.remove > 0) text.delete(diff.index, diff.remove);
        if (diff.insert) text.insert(diff.index, diff.insert);
      });
    },
    [doc, docId],
  );

  const getFeedback = useCallback(
    () => (doc && docId ? doc.getText('feedback').toString() : feedback),
    [doc, docId, feedback],
  );

  return {
    feedback,
    documentReadOnly,
    feedbackText: docId ? doc.getText('feedback') : undefined,
    setFeedback,
    getFeedback,
    synced,
    awareness,
    remoteUsers,
  };
}
