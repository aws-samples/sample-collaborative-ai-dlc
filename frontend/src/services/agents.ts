import { api } from './api';
import type { StructuredQuestion, StructuredAnswer } from './questions';
import type { AgentCli } from './projects';

export interface AgentExecution {
  executionArn: string;
  executionId?: string;
  status?: 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'TIMED_OUT' | 'ABORTED';
  output?: string;
  outputText?: string;
}

export interface AgentQuestion {
  questionId: string;
  agentTaskId: string;
  questions: StructuredQuestion[];
  status: 'pending' | 'answered';
  structuredAnswer?: StructuredAnswer;
  answeredBy?: string;
  createdAt: number;
}

export interface Requirement {
  reqId: string;
  title: string;
  description: string;
  priority: 'high' | 'medium' | 'low';
  status: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface UserStory {
  storyId: string;
  title: string;
  persona: string;
  action: string;
  benefit: string;
  acceptanceCriteria: string;
  requirementId: string;
  status: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface PoolWorker {
  workerId: string;
  status: 'idle' | 'assigned' | 'busy' | 'starting' | 'draining';
  version: string;
  availableClis: AgentCli[];
  /** CLIs installed on the worker that failed to authenticate at startup,
   *  mapped to the human-readable error message. */
  cliAuthErrors?: Partial<Record<AgentCli, string>>;
  agentCli?: AgentCli | null; // legacy
  taskArn?: string;
  lastHeartbeat?: number;
  job?: { executionId: string; projectId: string; agentType: string } | null;
}

export interface PoolStatus {
  workers: PoolWorker[];
  currentVersion: string;
  poolSize: number;
}

export interface AgentCapabilities {
  available: AgentCli[];
}

export interface AgentSettings {
  /** True when a bearer token is stored in SSM (value is never returned to the browser) */
  bedrockBearerTokenSet: boolean;
  /** True when a Kiro API key is stored in SSM */
  kiroApiKeySet: boolean;
  /** Raw JSON string of the MCP servers array */
  mcpServers: string;
}

export interface AgentSettingsUpdate {
  /** New bearer token value. Pass empty string to clear. Omit to leave unchanged. */
  bedrockBearerToken?: string;
  /** New Kiro API key value. Pass empty string to clear. Omit to leave unchanged. */
  kiroApiKey?: string;
  /** Updated MCP servers as a JSON string */
  mcpServers?: string;
}

export interface TaskAgentStatus {
  taskId: string;
  title: string;
  status: string;
  executionId: string | null;
  executionArn: string | null;
  executionStatus: string | null;
}

export const agentsService = {
  // Pool admin
  async getPool(): Promise<PoolStatus> {
    return api.get('/agents/pool');
  },

  async recyclePool(): Promise<{ drained: number; version: string }> {
    return api.post('/agents/pool/recycle', {});
  },

  async warmPool(count?: number): Promise<{ launched: { workerId: string; taskArn: string }[]; version: string }> {
    return api.post('/agents/pool/warm', { count });
  },

  async killWorker(workerId: string): Promise<void> {
    return api.delete(`/agents/pool/${encodeURIComponent(workerId)}`);
  },

  // Agent CLI capabilities — which CLIs are installed in the current image
  async getCapabilities(): Promise<AgentCapabilities> {
    return api.get('/agents/capabilities');
  },

  // Agent settings — Bedrock bearer token + extra MCP servers (SSM-backed)
  async getSettings(): Promise<AgentSettings> {
    return api.get('/agents/settings');
  },

  async updateSettings(update: AgentSettingsUpdate): Promise<{ saved: boolean }> {
    return api.put('/agents/settings', update);
  },

  // Project agents
  async startWorkflow(projectId: string, input?: Record<string, unknown>): Promise<AgentExecution> {
    return api.post(`/projects/${projectId}/agents`, input || {});
  },

  async getCurrentExecution(projectId: string, sprintId?: string): Promise<{ executionArn: string | null; executionId?: string | null; status?: string }> {
    const params = sprintId ? `?sprintId=${encodeURIComponent(sprintId)}` : '';
    return api.get(`/projects/${projectId}/agents${params}`);
  },

  async getTaskAgentStatuses(projectId: string, sprintId: string): Promise<{ tasks: TaskAgentStatus[] }> {
    return api.get(`/projects/${projectId}/agents/tasks?sprintId=${encodeURIComponent(sprintId)}`);
  },

  async getStatus(executionArn: string, executionId?: string): Promise<AgentExecution> {
    const params = executionId ? `?executionId=${encodeURIComponent(executionId)}` : '';
    return api.get(`/agents/${encodeURIComponent(executionArn)}${params}`);
  },

  async cancel(executionArn: string): Promise<void> {
    return api.delete(`/agents/${encodeURIComponent(executionArn)}`);
  },

  // Questions are keyed by executionId (stable across restarts), not ECS task ARN
  async getQuestions(executionId: string): Promise<{ questions: AgentQuestion[] }> {
    return api.get(`/agents/${encodeURIComponent(executionId)}/questions`);
  },

  async answerQuestion(executionId: string, questionId: string, structuredAnswer: StructuredAnswer): Promise<{ success: boolean; restarted?: boolean; newTaskArn?: string }> {
    return api.post(`/agents/${encodeURIComponent(executionId)}/questions/${questionId}/answer`, { structuredAnswer });
  },

  async getRequirements(projectId: string): Promise<{ requirements: Requirement[] }> {
    return api.get(`/projects/${projectId}/requirements`);
  },

  async getUserStories(projectId: string): Promise<{ stories: UserStory[] }> {
    return api.get(`/projects/${projectId}/user-stories`);
  },

  async updateRequirement(projectId: string, reqId: string, data: Partial<Requirement>): Promise<void> {
    return api.put(`/projects/${projectId}/requirements/${reqId}`, data);
  },

  async deleteRequirement(projectId: string, reqId: string): Promise<void> {
    return api.delete(`/projects/${projectId}/requirements/${reqId}`);
  },

  async updateUserStory(projectId: string, storyId: string, data: Partial<UserStory>): Promise<void> {
    return api.put(`/projects/${projectId}/user-stories/${storyId}`, data);
  },

  async deleteUserStory(projectId: string, storyId: string): Promise<void> {
    return api.delete(`/projects/${projectId}/user-stories/${storyId}`);
  },
};
