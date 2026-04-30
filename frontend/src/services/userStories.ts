import { api } from './api';

export interface UserStory {
  id: string;
  title: string;
  description: string;
  storyPoints: number;
  sprintId: string;
}

export const userStoriesService = {
  list: (sprintId: string) => api.get<UserStory[]>(`/sprints/${sprintId}/user-stories`),
  get: (sprintId: string, id: string) => api.get<UserStory>(`/sprints/${sprintId}/user-stories/${id}`),
  create: (sprintId: string, input: { title: string; description: string; storyPoints?: number; requirementId?: string }) =>
    api.post<UserStory>(`/sprints/${sprintId}/user-stories`, input),
  update: (sprintId: string, id: string, input: Partial<UserStory>) =>
    api.put<UserStory>(`/sprints/${sprintId}/user-stories/${id}`, input),
  delete: (sprintId: string, id: string) => api.delete(`/sprints/${sprintId}/user-stories/${id}`),
};
