import { api } from './api';
import type { StructuredQuestion, StructuredAnswer } from './questions';
import type { AgentCli, CliModels, TierModels } from './projects';

export interface AgentExecution {
  executionArn: string;
  executionId?: string;
  status?: 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'TIMED_OUT' | 'ABORTED';
  output?: string;
  outputText?: string;
  errorMessage?: string;
}

export interface AgentQuestion {
  questionId: string;
  agentTaskId: string;
  questions: StructuredQuestion[];
  status: 'pending' | 'answered';
  structuredAnswer?: StructuredAnswer;
  /** Cognito sub of the user who answered */
  answeredBy?: string;
  /** Display name of the user who answered */
  answeredByName?: string;
  /** Epoch ms of when the answer was submitted */
  answeredAt?: number;
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

/** One selectable model in the project-settings picker. */
export interface AgentModel {
  id: string;
  name: string;
  description?: string | null;
}

/** Per-CLI availability as reported by the v2 AgentCore runtime (not the ECS
 *  pool): installed in the image AND authed (credentials present). */
export interface RuntimeCliStatus {
  cli: AgentCli;
  installed: boolean;
  authed: boolean;
  available: boolean;
}

export interface AgentCapabilities {
  available: AgentCli[];
  runtimeModelOverride?: Record<AgentCli, boolean>;
  /** Present only with `?models=1`: per-CLI availability from the v2 runtime. */
  runtimeClis?: RuntimeCliStatus[] | null;
  /** Present only with `?models=1`: selectable models per CLI. Claude/OpenCode
   *  are region-valid Bedrock inference profiles; Kiro uses its own namespace. */
  models?: Partial<Record<AgentCli, AgentModel[]>>;
}

export interface AgentSettings {
  /** True when a bearer token is stored in SSM (value is never returned to the browser) */
  bedrockBearerTokenSet: boolean;
  /** True when a Kiro API key is stored in SSM */
  kiroApiKeySet: boolean;
  /** Default runtime model overrides by supported CLI */
  cliModels?: CliModels;
  /** Agent tier → model configuration: judgment/balanced/templated rows plus
   *  the fallback row (no tier resolvable) and the Quorum row (discussion/edit
   *  one-shots). Each row is a per-CLI model map. */
  tierModels?: TierModels;
  /** Derive-time graph enrichment: 'off' = deterministic projection only,
   *  'llm' = one bounded agent-CLI summary call per approved artifact.
   *  Snapshotted per intent at create — flips apply to the NEXT intent. */
  deriveEnrichment?: 'off' | 'llm';
  /** Platform-wide stage skipping: 'enabled' lets intents deselect
   *  CONDITIONAL stages at create and offers "skip to stage X" on validation
   *  gates. Projects may override; the effective value is snapshotted per
   *  intent at create. */
  stageSkipping?: 'enabled' | 'disabled';
  /** Composer LLM bypass: 'enabled' (default) lets a clean deterministic
   *  keyword match answer a front compose without an LLM call; 'disabled'
   *  routes every compose through the composer agent. */
  composeLlmBypass?: 'enabled' | 'disabled';
  /** Global custom MCP servers (raw JSON string, name-keyed JSON object)
   *  injected into every agent session; merged under a project's own set.
   *  Only returned to platform admins. */
  customMcpServers?: string;
  /** Names of the globally-provided MCP servers (no config/secrets). Returned
   *  to any authenticated caller so project-level UI can show what's already
   *  provided globally. */
  customMcpServerNames?: string[];
}

export interface McpVerifyResult {
  ok: boolean;
  tools?: string[];
  error?: string;
}

export interface McpVerifyResponse {
  /** Per-server result keyed by name (present on success). */
  results?: Record<string, McpVerifyResult>;
  /** Set when the config was invalid or the runtime couldn't be reached. */
  error?: string;
  issues?: Array<{ path: string; message: string }>;
}

export interface AgentSettingsUpdate {
  /** New bearer token value. Pass empty string to clear. Omit to leave unchanged. */
  bedrockBearerToken?: string;
  /** New Kiro API key value. Pass empty string to clear. Omit to leave unchanged. */
  kiroApiKey?: string;
  /** Default runtime model overrides by supported CLI */
  cliModels?: CliModels;
  /** Agent tier → model configuration. Omit to leave unchanged. */
  tierModels?: TierModels;
  /** Derive-time graph enrichment mode. Omit to leave unchanged. */
  deriveEnrichment?: 'off' | 'llm';
  /** Platform-wide stage skipping mode. Omit to leave unchanged. */
  stageSkipping?: 'enabled' | 'disabled';
  /** Composer LLM bypass mode. Omit to leave unchanged. */
  composeLlmBypass?: 'enabled' | 'disabled';
  /** Global custom MCP servers (raw JSON string). Omit to leave unchanged. */
  customMcpServers?: string;
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
  // Agent CLI capabilities — which CLIs are installed in the current image.
  // Pass `withModels` to also fetch the per-CLI model lists + v2 runtime CLI
  // availability (drives the project-settings model/CLI pickers).
  async getCapabilities(withModels = false): Promise<AgentCapabilities> {
    return api.get(`/agents/capabilities${withModels ? '?models=1' : ''}`);
  },

  // Agent settings — Bedrock bearer token, Kiro API key + default CLI models
  // (SSM-backed)
  async getSettings(): Promise<AgentSettings> {
    return api.get('/agents/settings');
  },

  async updateSettings(update: AgentSettingsUpdate): Promise<{ saved: boolean }> {
    return api.put('/agents/settings', update);
  },

  // Probe custom MCP servers inside the AgentCore container (same image/egress
  // the real agent uses). `mcpServers` is the name-keyed author object (raw JSON
  // string or object). Authorization is derived on the backend from the caller's
  // identity: with `projectId` → project owner/admin; without → platform admin.
  async verifyMcpServers(
    mcpServers: string | Record<string, unknown>,
    projectId?: string,
  ): Promise<McpVerifyResponse> {
    return api.post('/agents/verify-mcp', { mcpServers, ...(projectId ? { projectId } : {}) });
  },

  // Project agents (v1 read-only: dispatch/cancel/answer routes are gone —
  // only the status/question GETs remain).
  async getCurrentExecution(
    projectId: string,
    sprintId?: string,
  ): Promise<{ executionArn: string | null; executionId?: string | null; status?: string }> {
    const params = sprintId ? `?sprintId=${encodeURIComponent(sprintId)}` : '';
    return api.get(`/projects/${projectId}/agents${params}`);
  },

  async getTaskAgentStatuses(
    projectId: string,
    sprintId: string,
  ): Promise<{ tasks: TaskAgentStatus[] }> {
    return api.get(`/projects/${projectId}/agents/tasks?sprintId=${encodeURIComponent(sprintId)}`);
  },

  async getStatus(executionArn: string, executionId?: string): Promise<AgentExecution> {
    const params = executionId ? `?executionId=${encodeURIComponent(executionId)}` : '';
    return api.get(`/agents/${encodeURIComponent(executionArn)}${params}`);
  },

  // Questions are keyed by executionId (stable across restarts), not ECS task ARN
  async getQuestions(executionId: string): Promise<{ questions: AgentQuestion[] }> {
    return api.get(`/agents/${encodeURIComponent(executionId)}/questions`);
  },

  async getRequirements(projectId: string): Promise<{ requirements: Requirement[] }> {
    return api.get(`/projects/${projectId}/requirements`);
  },

  async getUserStories(projectId: string): Promise<{ stories: UserStory[] }> {
    return api.get(`/projects/${projectId}/user-stories`);
  },

  async updateRequirement(
    projectId: string,
    reqId: string,
    data: Partial<Requirement>,
  ): Promise<void> {
    return api.put(`/projects/${projectId}/requirements/${reqId}`, data);
  },

  async deleteRequirement(projectId: string, reqId: string): Promise<void> {
    return api.delete(`/projects/${projectId}/requirements/${reqId}`);
  },

  async updateUserStory(
    projectId: string,
    storyId: string,
    data: Partial<UserStory>,
  ): Promise<void> {
    return api.put(`/projects/${projectId}/user-stories/${storyId}`, data);
  },

  async deleteUserStory(projectId: string, storyId: string): Promise<void> {
    return api.delete(`/projects/${projectId}/user-stories/${storyId}`);
  },
};
