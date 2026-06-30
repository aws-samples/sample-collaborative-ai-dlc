import { useAuth } from '@/contexts/AuthContext';
import { questionsService, type StructuredAnswer } from '@/services/questions';
import { timelineEventsService } from '@/services/timelineEvents';

interface UseAnswerQuestionOptions {
  sprintId: string;
  /** Refreshes sprint data after the answer/dismissal is persisted. */
  reload: () => Promise<void>;
  /**
   * Persists the answer. Defaults to the questions API (Neptune + DynamoDB
   * sync); the Agent page overrides this with the agents answer endpoint,
   * which also syncs the Neptune Question vertex server-side.
   */
  submitAnswer?: (questionId: string, answer: StructuredAnswer) => Promise<unknown>;
}

/**
 * Shared answer/dismiss flow for agent questions, used by all phase pages
 * (Inception, Construction, Review, Agent). Answering persists the answer,
 * records a `question_answered` timeline event linked to the question, and
 * reloads the sprint so the pending card clears and the Q&A history picks up
 * the responder. Collaborators are notified via the server-origin
 * `question.answered` event emitted by the questions/agents lambdas —
 * clients never broadcast it.
 */
export function useAnswerQuestion({ sprintId, reload, submitAnswer }: UseAnswerQuestionOptions) {
  const { user } = useAuth();
  const userName = user?.displayName || user?.email || '';

  const answerQuestion = async (questionId: string, answer: StructuredAnswer) => {
    try {
      if (submitAnswer) {
        await submitAnswer(questionId, answer);
      } else {
        await questionsService.update(sprintId, questionId, { structuredAnswer: answer });
      }
      timelineEventsService
        .create(sprintId, {
          type: 'question_answered',
          title: 'Answered agent question',
          userName,
          questionId,
        })
        .catch(() => {});
      await reload();
    } catch (err) {
      console.error('Failed to answer question:', err);
    }
  };

  const dismissQuestion = async (questionId: string) => {
    const dismissed: StructuredAnswer = {
      answers: [{ selectedOptions: [], freeText: '(dismissed — agent no longer running)' }],
    };
    try {
      await questionsService.update(sprintId, questionId, { structuredAnswer: dismissed });
      await reload();
    } catch (err) {
      console.error('Failed to dismiss question:', err);
    }
  };

  return { answerQuestion, dismissQuestion };
}
