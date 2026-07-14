import { api } from './api';
import type { GitProvider } from './gitProvider';

export type ProjectRole = 'owner' | 'admin' | 'member';
export type AgentCli = 'kiro' | 'claude' | 'opencode';
export type RuntimeModelCli = 'kiro' | 'claude' | 'opencode';
export type CliModels = Partial<Record<RuntimeModelCli, string>>;

// Agent tier → model configuration (flat-row shape, mirroring the backend's
// shared/tier-models.js). The three tier rows map upstream agents' authored
// `tier` to a concrete model per CLI; `fallback` applies when no tier
// resolves; `quorum` drives the Quorum discussion/edit one-shot surfaces.
export type TierModelRow = 'judgment' | 'balanced' | 'templated' | 'fallback' | 'quorum';
export type TierModels = Partial<Record<TierModelRow, CliModels>>;
export type RepoRole =
  | 'primary'
  | 'secondary'
  | 'frontend'
  | 'backend'
  | 'api'
  | 'infra'
  | 'shared'
  | 'docs'
  | 'unknown';

export interface ProjectRepo {
  url: string;
  provider: GitProvider;
  role: RepoRole;
  detectedStack: string;
  addedAt: string;
}

// One project ↔ tracker (Jira / GitHub Issues / …) binding. Phase 1 of #194
// only writes synthetic GitHub-issues bindings via the migration; Phase 3
// adds Jira and the connect/select UI.
export interface TrackerBinding {
  id: string;
  provider: string;
  instance: string | null;
  externalProjectKey: string | null;
  displayName: string | null;
  createdAt: string | null;
  createdBy: string | null;
}

// v1 (pre-existing projects only) ran the original sprint lifecycle; v2 runs
// the AI-DLC v2 block/workflow runtime (intents, dynamic phases/stages). New
// projects are always v2 — the backend rejects `kind: 'v1'` on create. The
// type is kept so v1 badges can still be rendered for frozen v1 projects.
export type ProjectKind = 'v1' | 'v2';

export interface Project {
  id: string;
  name: string;
  gitProvider: GitProvider;
  gitRepo: string;
  agentCli: AgentCli;
  cliModels?: CliModels;
  tierModels?: TierModels;
  issueIntegrationEnabled?: boolean;
  createdAt: string;
  // Stamped by the backend on every settings PUT; legacy projects fall back to
  // createdAt server-side. Note: intent activity does NOT bump this — use
  // projectLastActivityAt (useProjectsCache) for an activity-based recency.
  updatedAt?: string | null;
  userRole?: ProjectRole;
  trackers: TrackerBinding[];
  repos?: ProjectRepo[];
  // v2 discriminator + settings (absent/`'v1'` for v1 projects).
  kind?: ProjectKind;
  workflowId?: string;
  workflowVersion?: number | null;
  parkReleaseSeconds?: number;
  // Concurrency cap for parallel unit lanes (docs/v2-parallel.md WP5);
  // 0 = unbounded (the unit DAG is the only limit).
  maxParallelUnits?: number;
  // PR strategy at fan-in (docs/v2-parallel.md WP6). Only 'intent-pr' is
  // enabled; the other two are visible-but-disabled until WP6b.
  prStrategy?: PrStrategy;
  // Per-project stage-skipping override: 'default' inherits the platform
  // Admin setting; enabled/disabled override it for this project's intents.
  stageSkipping?: StageSkippingOverride;
}

export type PrStrategy = 'intent-pr' | 'pr-per-unit' | 'stacked';
export type StageSkippingOverride = 'default' | 'enabled' | 'disabled';

export interface TrackerMigrationResult {
  dryRun: boolean;
  projects: { candidates: number; applied: number };
  sprints: { candidates: number; applied: number };
}

// Whole-graph dry-run shape returned by /admin/tracker-migration/status.
// Same wire shape as TrackerMigrationResult — `applied` is always 0 because
// the status endpoint never mutates.
export type TrackerMigrationStatus = TrackerMigrationResult;

export interface CreateProjectInput {
  name: string;
  gitProvider: GitProvider;
  gitRepo: string;
  agentCli?: AgentCli;
  cliModels?: CliModels;
  tierModels?: TierModels;
  issueIntegrationEnabled?: boolean;
  repos?: { url: string; provider?: string; role?: RepoRole }[];
  // v2 project options. v2 is the only creatable kind: the backend rejects
  // `kind: 'v1'` (400) and treats an omitted kind as v2. workflowId falls back
  // to the canonical default workflow when omitted.
  kind?: ProjectKind;
  workflowId?: string;
  workflowVersion?: number | null;
  parkReleaseSeconds?: number;
  maxParallelUnits?: number;
  prStrategy?: PrStrategy;
}

export interface UpdateProjectInput {
  name?: string;
  gitRepo?: string;
  gitProvider?: GitProvider;
  agentCli?: AgentCli;
  cliModels?: CliModels;
  tierModels?: TierModels;
  issueIntegrationEnabled?: boolean;
  // v2 settings (owner/admin tunable).
  workflowId?: string;
  workflowVersion?: number | null;
  parkReleaseSeconds?: number;
  maxParallelUnits?: number;
  prStrategy?: PrStrategy;
  stageSkipping?: StageSkippingOverride;
}

export interface AddRepoInput {
  url: string;
  provider?: GitProvider;
  role?: RepoRole;
  detectedStack?: string;
}

export interface Member {
  userId: string;
  email?: string;
  role: ProjectRole;
}

export interface AddMemberInput {
  userId: string;
  email?: string;
  role: ProjectRole;
}

export interface CognitoUser {
  userId: string;
  email: string;
  displayName: string;
  enabled: boolean;
  status: string;
}

// A project custom agent rule (user-uploaded .md reference doc). `s3Key` is the
// artifacts-bucket key; `downloadUrl`/`uploadUrl` are presigned per request.
export interface CustomRule {
  filename: string;
  s3Key: string;
  downloadUrl?: string;
  uploadUrl?: string;
}

export const projectsService = {
  list: () => api.get<Project[]>('/projects'),
  get: (id: string) => api.get<Project>(`/projects/${id}`),
  create: (input: CreateProjectInput) => api.post<Project>('/projects', input),
  update: (id: string, input: UpdateProjectInput) => api.put<Project>(`/projects/${id}`, input),
  delete: (id: string) => api.delete(`/projects/${id}`),

  // Repos
  listRepos: (projectId: string) => api.get<ProjectRepo[]>(`/projects/${projectId}/repos`),
  addRepo: (projectId: string, input: AddRepoInput) =>
    api.post<ProjectRepo>(`/projects/${projectId}/repos`, input),
  removeRepo: (projectId: string, repoUrl: string) =>
    api.delete(`/projects/${projectId}/repos?url=${encodeURIComponent(repoUrl)}`),

  // Members
  listMembers: (projectId: string) => api.get<Member[]>(`/projects/${projectId}/members`),
  addMember: (projectId: string, input: AddMemberInput) =>
    api.post<Member>(`/projects/${projectId}/members`, input),
  updateMemberRole: (projectId: string, userId: string, role: ProjectRole) =>
    api.put<Member>(`/projects/${projectId}/members/${userId}`, { role }),
  removeMember: (projectId: string, userId: string) =>
    api.delete(`/projects/${projectId}/members/${userId}`),

  // Cognito users
  listCognitoUsers: () => api.get<CognitoUser[]>('/users'),

  // Tracker abstraction migration (#194 Phase 1). Owner/admin only. Idempotent.
  migrateTracker: (projectId: string, dryRun = false) =>
    api.post<TrackerMigrationResult>(`/projects/${projectId}/migrate-tracker`, {
      dryRun,
    }),

  // Whole-graph admin counterparts of /projects/{id}/migrate-tracker.
  // Authenticated-only — drives the Admin page's Tracker Migration card and
  // shares the same shared core as the per-project endpoint and the bulk CLI
  // lambda. Idempotent. See parent issue #194 phase #198.
  getTrackerMigrationStatus: () =>
    api.get<TrackerMigrationStatus>('/admin/tracker-migration/status'),
  runTrackerMigration: (dryRun = false) =>
    api.post<TrackerMigrationResult>('/admin/tracker-migration', { dryRun }),

  // Project-level custom MCP servers (raw JSON string, name-keyed JSON object)
  getCustomMcpServers: (projectId: string) =>
    api.get<{ customMcpServers: string }>(`/projects/${projectId}/custom-mcp-servers`),
  updateCustomMcpServers: (projectId: string, customMcpServers: string) =>
    api.put<{ saved: boolean }>(`/projects/${projectId}/custom-mcp-servers`, {
      customMcpServers,
    }),

  // Project-level MCP secrets (per-var SecureStrings). GET returns set-state only
  // (never values); PUT rotates (non-empty value) or clears (empty string).
  getMcpSecrets: (projectId: string) =>
    api.get<{ mcpSecretsSet: Record<string, boolean> }>(
      `/projects/${projectId}/custom-mcp-servers/secrets`,
    ),
  updateMcpSecrets: (projectId: string, mcpSecrets: Record<string, string>) =>
    api.put<{ saved: boolean }>(`/projects/${projectId}/custom-mcp-servers/secrets`, {
      mcpSecrets,
    }),

  // Project-level custom agent rules (uploaded .md reference docs).
  // Two-phase write so metadata is only persisted for objects that uploaded:
  //   presignCustomRules — get upload URLs (no persist), then upload to S3
  //   commitCustomRules  — persist the final set (after uploads / on delete)
  getCustomRules: (projectId: string) =>
    api.get<{ customRules: CustomRule[] }>(`/projects/${projectId}/custom-rules`),
  presignCustomRules: (projectId: string, customRules: Array<{ filename: string }>) =>
    api.put<{
      uploadUrls: Array<{ filename: string; s3Key: string; uploadUrl: string }>;
    }>(`/projects/${projectId}/custom-rules`, { customRules, mode: 'presign' }),
  commitCustomRules: (projectId: string, customRules: Array<{ filename: string }>) =>
    api.put<{ saved: boolean }>(`/projects/${projectId}/custom-rules`, {
      customRules,
      mode: 'commit',
    }),
};
