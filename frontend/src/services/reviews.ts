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

// v1 reviews are read-only: create/update were removed with the v1 engine —
// only the GET route remains.
export const reviewsService = {
  get: (sprintId: string) => api.get<Review | null>(`/sprints/${sprintId}/review`),
};
