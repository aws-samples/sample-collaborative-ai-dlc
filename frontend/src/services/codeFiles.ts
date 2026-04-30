import { api } from './api';

export interface CodeFile {
  id: string;
  filePath: string;
  commitRef: string;
  summary: string;
  sprintId: string;
}

export const codeFilesService = {
  list: (sprintId: string) => api.get<CodeFile[]>(`/sprints/${sprintId}/code-files`),
  get: (sprintId: string, id: string) => api.get<CodeFile>(`/sprints/${sprintId}/code-files/${id}`),
  create: (sprintId: string, input: { filePath: string; commitRef?: string; summary?: string; taskId?: string; userStoryId?: string }) =>
    api.post<CodeFile>(`/sprints/${sprintId}/code-files`, input),
  update: (sprintId: string, id: string, input: Partial<CodeFile>) =>
    api.put<CodeFile>(`/sprints/${sprintId}/code-files/${id}`, input),
  delete: (sprintId: string, id: string) => api.delete(`/sprints/${sprintId}/code-files/${id}`),
};
