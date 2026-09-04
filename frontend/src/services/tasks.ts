import { api } from './api';

export interface Task {
  id: string;
  title: string;
  description: string;
  status: string;
  sprintId: string;
  dependencies?: string[];
}

// v1 tasks are read-only: the write routes (and the task-level
// mcp-servers/steering-docs config) were removed with the v1 engine — only
// the GET routes remain.
export const tasksService = {
  list: (sprintId: string) => api.get<Task[]>(`/sprints/${sprintId}/tasks`),
  get: (sprintId: string, id: string) => api.get<Task>(`/sprints/${sprintId}/tasks/${id}`),
};
