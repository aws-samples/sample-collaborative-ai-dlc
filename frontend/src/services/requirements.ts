import { api } from './api';

export interface Requirement {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string;
  sprintId: string;
}

export const requirementsService = {
  list: (sprintId: string) => api.get<Requirement[]>(`/sprints/${sprintId}/requirements`),
  get: (sprintId: string, id: string) => api.get<Requirement>(`/sprints/${sprintId}/requirements/${id}`),
  create: (sprintId: string, input: { title: string; description: string; acceptanceCriteria?: string; carriedFromId?: string }) =>
    api.post<Requirement>(`/sprints/${sprintId}/requirements`, input),
  update: (sprintId: string, id: string, input: Partial<Requirement>) =>
    api.put<Requirement>(`/sprints/${sprintId}/requirements/${id}`, input),
  delete: (sprintId: string, id: string) => api.delete(`/sprints/${sprintId}/requirements/${id}`),
};
