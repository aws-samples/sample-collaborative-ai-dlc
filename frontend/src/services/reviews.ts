import { api } from './api';

export type ReviewStatus = 'PENDING' | 'PASSED' | 'FAILED' | 'PARTIAL';

export interface Review {
  id: string;
  status: ReviewStatus;
  comments: string;
  blindReview: string | null;
  blindStatus: ReviewStatus;
  blindRiskScore: string | null;
  blindRiskReasoning: string;
  fullReview: string | null;
  fullStatus: ReviewStatus;
  fullRiskScore: string | null;
  fullRiskReasoning: string;
  stale: boolean;
  staleAt: string | null;
  sprintId: string;
}

export const reviewsService = {
  get: (sprintId: string) => api.get<Review | null>(`/sprints/${sprintId}/review`),
  create: (sprintId: string, input?: { comments?: string }) =>
    api.post<Review>(`/sprints/${sprintId}/review`, input || {}),
  update: (
    sprintId: string,
    input: {
      status?: ReviewStatus;
      comments?: string;
      blindReview?: string;
      fullReview?: string;
      blindStatus?: ReviewStatus;
      blindRiskScore?: string;
      blindRiskReasoning?: string;
      fullStatus?: ReviewStatus;
      fullRiskScore?: string;
      fullRiskReasoning?: string;
      codeFileIds?: string[];
      requirementIds?: string[];
      userStoryIds?: string[];
    },
  ) => api.put<Review>(`/sprints/${sprintId}/review`, input),
};
