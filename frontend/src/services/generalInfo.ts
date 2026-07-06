import { api } from './api';

export interface GeneralInfo {
  id: string;
  type: string;
  title: string;
  content: string;
  sprintId: string;
  createdAt: string;
}

// v1 general info is read-only: the write routes were removed with the v1
// engine — only the GET routes remain.
export const generalInfoService = {
  list: (sprintId: string) => api.get<GeneralInfo[]>(`/sprints/${sprintId}/general-info`),
  get: (sprintId: string, id: string) =>
    api.get<GeneralInfo>(`/sprints/${sprintId}/general-info/${id}`),
};
