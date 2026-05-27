import { api } from './api';
import type { SteeringDoc } from './projects';

export interface Task {
  id: string;
  title: string;
  description: string;
  status: string;
  sprintId: string;
  dependencies?: string[];
}

export interface TaskConfig {
  mcpServers: string;
  steeringDocs: SteeringDoc[];
}

export interface UpdateTaskConfigInput {
  mcpServers?: string;
  steeringDocs?: Array<{ filename: string }>;
}

export const tasksService = {
  list: (sprintId: string) => api.get<Task[]>(`/sprints/${sprintId}/tasks`),
  get: (sprintId: string, id: string) => api.get<Task>(`/sprints/${sprintId}/tasks/${id}`),
  create: (
    sprintId: string,
    input: {
      title: string;
      description: string;
      status?: string;
      requirementId?: string;
      userStoryId?: string;
      dependencies?: string[];
    },
  ) => api.post<Task>(`/sprints/${sprintId}/tasks`, input),
  update: (sprintId: string, id: string, input: Partial<Task>) =>
    api.put<Task>(`/sprints/${sprintId}/tasks/${id}`, input),
  delete: (sprintId: string, id: string) => api.delete(`/sprints/${sprintId}/tasks/${id}`),

  // Task-level configuration: MCP servers and steering docs
  getConfig: (sprintId: string, taskId: string) =>
    api.get<TaskConfig>(`/sprints/${sprintId}/tasks/${taskId}/config`),
  updateConfig: (sprintId: string, taskId: string, input: UpdateTaskConfigInput) =>
    api.put<{
      saved: boolean;
      uploadUrls: Array<{ filename: string; s3Key: string; uploadUrl: string }>;
    }>(`/sprints/${sprintId}/tasks/${taskId}/config`, input),
};
