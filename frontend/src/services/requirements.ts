import { api } from './api';

export interface Requirement {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string;
  sprintId: string;
}

// v1 requirements are read-only: the write routes were removed with the v1
// engine — only the GET routes remain.
export const requirementsService = {
  list: (sprintId: string) => api.get<Requirement[]>(`/sprints/${sprintId}/requirements`),
  get: (sprintId: string, id: string) =>
    api.get<Requirement>(`/sprints/${sprintId}/requirements/${id}`),
};
