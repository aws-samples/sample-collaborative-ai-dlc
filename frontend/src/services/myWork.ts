import { api } from './api';

export type PendingQuestionKind = 'question' | 'approval' | 'review-verdict' | 'validation';

/** One human task waiting for an answer, as listed by GET /users/me/pending-questions. */
export interface PendingQuestion {
  id: string;
  type: 'question';
  kind: PendingQuestionKind;
  projectId: string;
  projectName: string | null;
  intentId: string;
  intentTitle: string | null;
  humanTaskId: string;
  stageInstanceId: string | null;
  stageId: string | null;
  phase: string | null;
  unitSlug: string | null;
  sectionIndex: number | null;
  summary: string | null;
  questionCount: number | null;
  checkpoint: string | null;
  createdAt: string | null;
  /** `assignment: 'open'` means open to every eligible member, not assigned to this user. */
  eligibility: { basis: string; assignment: string };
  target: {
    view: 'gate' | 'review';
    projectId: string;
    intentId: string;
    humanTaskId: string;
  };
}

/** A space whose questions may be missing from the response. */
export interface UnavailableSpace {
  projectId: string;
  projectName: string | null;
  reason: 'READ_FAILED' | 'LIMIT_EXCEEDED';
}

export interface PendingQuestionsPage {
  items: PendingQuestion[];
  nextCursor: string | null;
  unavailable: UnavailableSpace[];
  generatedAt: string;
}

export interface ListPendingQuestionsParams {
  limit?: number;
  cursor?: string | null;
  projectId?: string | null;
  kinds?: PendingQuestionKind[] | null;
}

export const myWorkService = {
  listPendingQuestions({ limit, cursor, projectId, kinds }: ListPendingQuestionsParams = {}) {
    const query = new URLSearchParams();
    if (limit !== undefined) query.set('limit', String(limit));
    if (cursor) query.set('cursor', cursor);
    if (projectId) query.set('projectId', projectId);
    if (kinds && kinds.length > 0) query.set('kind', kinds.join(','));
    const qs = query.toString();
    return api.get<PendingQuestionsPage>(`/users/me/pending-questions${qs ? `?${qs}` : ''}`);
  },
};
