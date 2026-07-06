import { api } from './api';

export interface UserStory {
  id: string;
  title: string;
  description: string;
  storyPoints: number;
  sprintId: string;
}

// v1 user stories are read-only: the write routes were removed with the v1
// engine — only the GET routes remain.
export const userStoriesService = {
  list: (sprintId: string) => api.get<UserStory[]>(`/sprints/${sprintId}/user-stories`),
  get: (sprintId: string, id: string) =>
    api.get<UserStory>(`/sprints/${sprintId}/user-stories/${id}`),
};
