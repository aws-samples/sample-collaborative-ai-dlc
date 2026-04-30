import { api } from './api';

export interface Task {
  id: string;
  title: string;
  description: string;
  status: string;
  sprintId: string;
  dependencies?: string[];
}

export const tasksService = {
  list: (sprintId: string) => api.get<Task[]>(`/sprints/${sprintId}/tasks`),
  get: (sprintId: string, id: string) => api.get<Task>(`/sprints/${sprintId}/tasks/${id}`),
  create: (sprintId: string, input: { title: string; description: string; status?: string; requirementId?: string; userStoryId?: string; dependencies?: string[] }) =>
    api.post<Task>(`/sprints/${sprintId}/tasks`, input),
  update: (sprintId: string, id: string, input: Partial<Task>) =>
    api.put<Task>(`/sprints/${sprintId}/tasks/${id}`, input),
  delete: (sprintId: string, id: string) => api.delete(`/sprints/${sprintId}/tasks/${id}`),
};
