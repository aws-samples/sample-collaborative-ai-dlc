import { api } from './api';

export type ReviewStatus = 'PENDING' | 'PASSED' | 'FAILED';

export interface Review {
  id: string;
  status: ReviewStatus;
  comments: string;
  blindReview: string;
  fullReview: string;
  riskScore: string | null;
  riskReasoning: string;
  stale: boolean;
  staleAt: string | null;
  sprintId: string;
}

export const reviewsService = {
  get: (sprintId: string) => api.get<Review | null>(`/sprints/${sprintId}/review`),
  create: (sprintId: string, input?: { comments?: string }) => api.post<Review>(`/sprints/${sprintId}/review`, input || {}),
  update: (sprintId: string, input: { status?: ReviewStatus; comments?: string; blindReview?: string; fullReview?: string; codeFileIds?: string[]; requirementIds?: string[]; userStoryIds?: string[] }) =>
    api.put<Review>(`/sprints/${sprintId}/review`, input),
};
