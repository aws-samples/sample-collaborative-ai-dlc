/**
 * Utilities for linking timeline events to the question they reference.
 *
 * Question cards across the phase pages carry a DOM id of
 * `question-{questionId}` so timeline entries (and deep links using the
 * `#question-{questionId}` URL hash) can scroll to and highlight them.
 */

export const questionAnchorId = (questionId: string) => `question-${questionId}`;

const HIGHLIGHT_CLASSES = ['ring-2', 'ring-agent-waiting', 'rounded-lg'];

/**
 * Scrolls the question card into view and briefly highlights it.
 * Returns false when the question is not rendered on the current page
 * (callers then navigate to a page that renders it).
 */
export function scrollToQuestion(questionId: string): boolean {
  const el = document.getElementById(questionAnchorId(questionId));
  if (!el) return false;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add(...HIGHLIGHT_CLASSES);
  window.setTimeout(() => el.classList.remove(...HIGHLIGHT_CLASSES), 2500);
  return true;
}
