import { api } from './api';

export interface CodeFile {
  id: string;
  filePath: string;
  commitRef: string;
  summary: string;
  sprintId: string;
}

// v1 code files are read-only: the write routes were removed with the v1
// engine — only the GET routes remain.
export const codeFilesService = {
  list: (sprintId: string) => api.get<CodeFile[]>(`/sprints/${sprintId}/code-files`),
  get: (sprintId: string, id: string) => api.get<CodeFile>(`/sprints/${sprintId}/code-files/${id}`),
};
