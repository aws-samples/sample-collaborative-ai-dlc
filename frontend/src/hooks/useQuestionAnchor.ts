import { useCallback, useEffect } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { scrollToQuestion, questionAnchorId } from '@/lib/questionAnchor';

/**
 * Scrolls to the question referenced by a `#question-{id}` URL hash once the
 * page has rendered its questions. Pass `ready` (e.g. questions loaded) so the
 * scroll happens after the target anchor exists in the DOM.
 */
export function useQuestionAnchor(ready: boolean) {
  const location = useLocation();

  useEffect(() => {
    if (!ready) return;
    const match = location.hash.match(/^#question-(.+)$/);
    if (!match) return;
    // `ready` flips when the questions are in state, but the anchors only
    // exist once React commits the render. Poll until the anchor appears,
    // giving up after a bounded number of attempts (e.g. the question was
    // deleted or the id is stale).
    const RETRY_INTERVAL_MS = 100;
    const MAX_ATTEMPTS = 20; // ~2s
    let attempts = 0;
    let timer: number | undefined;
    const tryScroll = () => {
      if (scrollToQuestion(match[1])) return;
      attempts += 1;
      if (attempts < MAX_ATTEMPTS) timer = window.setTimeout(tryScroll, RETRY_INTERVAL_MS);
    };
    timer = window.setTimeout(tryScroll, RETRY_INTERVAL_MS);
    return () => window.clearTimeout(timer);
  }, [location.hash, ready]);
}

/**
 * Returns a callback that brings a question into view: scrolls in place when
 * the question is rendered on the current page (pending questions appear on
 * every phase page), otherwise navigates to the sprint's Inception page which
 * renders all questions including the answered Q&A history.
 */
export function useQuestionLink() {
  const navigate = useNavigate();
  const { projectId, sprintId } = useParams<{ projectId: string; sprintId: string }>();

  return useCallback(
    (questionId: string) => {
      if (scrollToQuestion(questionId)) return;
      if (projectId && sprintId) {
        navigate(`/project/${projectId}/sprint/${sprintId}#${questionAnchorId(questionId)}`);
      }
    },
    [navigate, projectId, sprintId],
  );
}
