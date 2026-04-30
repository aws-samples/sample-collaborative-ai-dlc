import { api } from './api';

export interface GeneralInfo {
  id: string;
  type: string;
  title: string;
  content: string;
  sprintId: string;
  createdAt: string;
}

export const generalInfoService = {
  list: (sprintId: string) => api.get<GeneralInfo[]>(`/sprints/${sprintId}/general-info`),
  get: (sprintId: string, id: string) => api.get<GeneralInfo>(`/sprints/${sprintId}/general-info/${id}`),
  create: (sprintId: string, input: { type: string; title: string; content: string }) =>
    api.post<GeneralInfo>(`/sprints/${sprintId}/general-info`, input),
  update: (sprintId: string, id: string, input: Partial<GeneralInfo>) =>
    api.put<GeneralInfo>(`/sprints/${sprintId}/general-info/${id}`, input),
  delete: (sprintId: string, id: string) => api.delete(`/sprints/${sprintId}/general-info/${id}`),
};
