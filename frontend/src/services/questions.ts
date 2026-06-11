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

export const questionsService = {
  list: (sprintId: string) => api.get<Question[]>(`/sprints/${sprintId}/questions`),
  get: (sprintId: string, id: string) => api.get<Question>(`/sprints/${sprintId}/questions/${id}`),
  create: (sprintId: string, input: { agent: string; questions: StructuredQuestion[] }) =>
    api.post<Question>(`/sprints/${sprintId}/questions`, input),
  update: (
    sprintId: string,
    id: string,
    input: {
      structuredAnswer?: StructuredAnswer;
      draftAnswer?: StructuredAnswer;
      influencesRequirementIds?: string[];
      influencesUserStoryIds?: string[];
      influencesTaskIds?: string[];
    },
  ) => api.put<Question>(`/sprints/${sprintId}/questions/${id}`, input),
};
