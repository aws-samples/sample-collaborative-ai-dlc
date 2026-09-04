import { api } from './api';

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface StructuredQuestion {
  text: string;
  type: 'single' | 'multi';
  options: QuestionOption[];
}

export interface QuestionAnswer {
  selectedOptions: number[];
  freeText?: string;
}

export interface StructuredAnswer {
  answers: QuestionAnswer[];
}

export interface Question {
  id: string;
  agent: string;
  questions: StructuredQuestion[];
  structuredAnswer?: StructuredAnswer;
  draftAnswer?: StructuredAnswer;
  sprintId: string;
  createdAt: string;
  /** Cognito sub of the user who answered (empty for unanswered/legacy questions) */
  answeredBy?: string;
  /** Display name of the user who answered */
  answeredByName?: string;
  /** ISO timestamp of when the answer was submitted */
  answeredAt?: string;
}

// v1 questions are read-only: create/update were removed with the v1 engine —
// only the GET routes remain. The Structured* types stay: the v2 question
// gates (QuestionEditor, collaborative answer drafts) share them.
export const questionsService = {
  list: (sprintId: string) => api.get<Question[]>(`/sprints/${sprintId}/questions`),
  get: (sprintId: string, id: string) => api.get<Question>(`/sprints/${sprintId}/questions/${id}`),
};
