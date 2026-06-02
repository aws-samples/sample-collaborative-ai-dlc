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

  // Task-level MCP servers (raw JSON string)
  getMcpServers: (sprintId: string, taskId: string) =>
    api.get<{ mcpServers: string }>(`/sprints/${sprintId}/tasks/${taskId}/mcp-servers`),
  updateMcpServers: (sprintId: string, taskId: string, mcpServers: string) =>
    api.put<{ saved: boolean }>(`/sprints/${sprintId}/tasks/${taskId}/mcp-servers`, { mcpServers }),

  // Task-level steering docs
  getSteeringDocs: (sprintId: string, taskId: string) =>
    api.get<{ steeringDocs: SteeringDoc[] }>(`/sprints/${sprintId}/tasks/${taskId}/steering-docs`),
  updateSteeringDocs: (
    sprintId: string,
    taskId: string,
    steeringDocs: Array<{ filename: string }>,
  ) =>
    api.put<{
      saved: boolean;
      uploadUrls: Array<{ filename: string; s3Key: string; uploadUrl: string }>;
    }>(`/sprints/${sprintId}/tasks/${taskId}/steering-docs`, { steeringDocs }),
};
