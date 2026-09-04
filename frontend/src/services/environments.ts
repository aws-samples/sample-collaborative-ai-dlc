import { api } from './api';

export type EnvironmentStatus =
  | 'DRAFT'
  | 'BUILDING'
  | 'SECURITY_REVIEW'
  | 'VERIFYING'
  | 'READY'
  | 'PUBLISHED'
  | 'UPDATE_AVAILABLE'
  | 'FAILED'
  | 'RETIRED';

export type EnvironmentRevisionStatus =
  | 'DRAFT'
  | 'QUEUED'
  | 'BUILDING'
  | 'SCANNING'
  | 'SECURITY_REVIEW'
  | 'VERIFYING'
  | 'READY'
  | 'PUBLISHED'
  | 'SUPERSEDED'
  | 'FAILED'
  | 'RETIRED';

export interface EnvironmentChecksum {
  algorithm: 'sha256' | 'sha512';
  value: string;
}

export interface FixedToolEnvironmentTool {
  version: string;
  source: 'base' | 'archive';
  url?: string;
  checksum?: EnvironmentChecksum;
  stripComponents?: number;
}

export interface FixedToolEnvironmentRecipe {
  schemaVersion: 1;
  base?: {
    environmentId: string;
    revisionId: string;
    imageUri: string;
    imageDigest: string;
  } | null;
  tools: Partial<Record<'node' | 'python' | 'java' | 'go' | 'rust', FixedToolEnvironmentTool>>;
  buildTools: Partial<Record<'maven' | 'gradle', FixedToolEnvironmentTool>>;
  aptPackages: { name: string; version: string }[];
  environmentVariables: Record<string, string>;
  buildCommands: string[];
}

export interface EnvironmentToolSnapshot {
  toolId: string;
  name: string;
  category: string;
  publisher: string;
  versionId: string;
  version: string;
  imageUri: string;
  imageDigest: string;
  imageSizeBytes?: number | null;
  trustLevel: 'PLATFORM_PINNED' | 'PUBLISHER_VERIFIED';
  source?: ToolSourceResult | null;
  executables: ToolExecutable[];
  dependencies: string[];
  aptPackages: { name: string; version: string }[];
  environmentVariables: Record<string, string>;
  verification: ToolVerification;
  scanFindings?: EnvironmentRevision['scanFindings'];
  securityFindingsAcceptedAt?: string | null;
  securityFindingsAcceptedBy?: string | null;
}

export interface CatalogEnvironmentRecipe {
  schemaVersion: 2;
  base?: {
    environmentId: string;
    revisionId: string;
    imageUri: string;
    imageDigest: string;
    imageSizeBytes?: number | null;
  } | null;
  toolVersionIds: string[];
  tools: EnvironmentToolSnapshot[];
  resolvedTools?: EnvironmentToolSnapshot[];
  aptPackages: { name: string; version: string }[];
  environmentVariables: Record<string, string>;
  buildCommands: string[];
}

export type EnvironmentRecipe = FixedToolEnvironmentRecipe | CatalogEnvironmentRecipe;

export interface EnvironmentRecipeInput {
  schemaVersion: 2;
  toolVersionIds: string[];
  aptPackages: { name: string; version: string }[];
  environmentVariables: Record<string, string>;
  buildCommands: string[];
}

export interface EnvironmentScanFinding {
  id: string;
  severity: string;
  packageName?: string | null;
  packageVersion?: string | null;
  uri?: string | null;
}

export interface ManagedEnvironment {
  environmentId: string;
  name: string;
  description: string;
  system: boolean;
  status: EnvironmentStatus;
  baseEnvironmentId: string | null;
  currentRevisionId: string;
  publishedRevisionId: string | null;
  updateAvailable: boolean;
  toolUpdates?: {
    toolId: string;
    currentVersionId: string;
    recommendedVersionId: string;
  }[];
  createdAt: string;
  updatedAt: string;
}

export interface EnvironmentRevision {
  environmentId: string;
  revisionId: string;
  status: EnvironmentRevisionStatus;
  reason?: string;
  recipe: EnvironmentRecipe;
  flattenedRecipe: EnvironmentRecipe;
  runtimeCompatibilityVersion: string;
  imageUri: string | null;
  imageDigest: string | null;
  imageSizeBytes?: number | null;
  projectedImageSizeBytes?: number | null;
  runtimeArn: string | null;
  runtimeVersion?: string | null;
  runtimeEndpoint: string | null;
  generatedDockerfile?: string | null;
  buildId?: string | null;
  buildLogUrl?: string | null;
  scanFindings?: {
    status?: string;
    description?: string | null;
    severityCounts?: Record<string, number>;
    findings?: EnvironmentScanFinding[];
    findingsTruncated?: boolean;
    evaluatedAt?: string;
    imageDigest?: string;
  } | null;
  verification?: Record<string, unknown> | null;
  failure?: {
    reason?: string;
    detail?: string | null;
    failedAt?: string;
  } | null;
  highFindingsAcknowledgedAt?: string | null;
  highFindingsAcknowledgedBy?: string | null;
  securityFindingsAcceptedAt?: string | null;
  securityFindingsAcceptedBy?: string | null;
  createdAt: string;
  updatedAt: string;
  publishedAt?: string | null;
}

export interface EnvironmentDetail {
  environment: ManagedEnvironment;
  revisions: EnvironmentRevision[];
  publishedRevision: EnvironmentRevision | null;
}

export interface EnvironmentMutationResult {
  environment: ManagedEnvironment;
  revision: EnvironmentRevision;
}

export type ToolVersionStatus =
  | 'DRAFT'
  | 'QUEUED'
  | 'BUILDING'
  | 'SCANNING'
  | 'SECURITY_REVIEW'
  | 'READY'
  | 'PUBLISHED'
  | 'FAILED';

export interface ToolExecutable {
  name: string;
  path: string;
}

export interface ToolVerification {
  preset: 'generic' | 'java' | 'go' | 'rust' | 'maven' | 'gradle' | 'dotnet';
  versionCommand: {
    argv: string[];
    expected: string;
  };
  script: string;
  files: { path: string; content: string }[];
}

export interface ToolVersionDefinition {
  schemaVersion: 1;
  version: string;
  source: {
    type: 'https';
    url: string;
    expectedChecksum?: {
      algorithm: 'sha256' | 'sha512';
      value: string;
      evidenceUrl?: string;
    };
  };
  installer: { mode: 'generated'; stripComponents: number } | { mode: 'script'; script: string };
  executables: ToolExecutable[];
  dependencies: string[];
  aptPackages: { name: string; version: string }[];
  environmentVariables: Record<string, string>;
  verification: ToolVerification;
}

export interface ToolSourceResult {
  requestedUrl: string;
  resolvedUrl: string;
  sha256: string;
  sizeBytes: number;
  trustLevel: 'PLATFORM_PINNED' | 'PUBLISHER_VERIFIED';
}

export interface ManagedToolVersion {
  toolId: string;
  versionId: string;
  status: ToolVersionStatus;
  definition: ToolVersionDefinition;
  system: boolean;
  autoBuild: boolean;
  buildAttempt: number;
  buildId?: string | null;
  buildLogUrl?: string | null;
  imageUri?: string | null;
  imageDigest?: string | null;
  imageSizeBytes?: number | null;
  source?: ToolSourceResult | null;
  scanFindings?: EnvironmentRevision['scanFindings'];
  verification?: Record<string, unknown> | null;
  failure?: EnvironmentRevision['failure'];
  securityFindingsAcceptedAt?: string | null;
  securityFindingsAcceptedBy?: string | null;
  publishedAt?: string | null;
  publishedBy?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ManagedTool {
  toolId: string;
  name: string;
  description: string;
  category: string;
  publisher: string;
  system: boolean;
  recommendedVersionId: string | null;
  versions: ManagedToolVersion[];
  createdAt: string;
  updatedAt: string;
}

export interface ToolMutationResult {
  tool: ManagedTool;
  version: ManagedToolVersion;
}

export interface ProjectEnvironmentAssignment {
  environmentId: string;
  environment: ManagedEnvironment | null;
  revision: EnvironmentRevision | null;
  updatedAt?: string;
}

const environmentPath = (environmentId: string) =>
  `/environments/${encodeURIComponent(environmentId)}`;
const revisionPath = (environmentId: string, revisionId: string) =>
  `${environmentPath(environmentId)}/revisions/${encodeURIComponent(revisionId)}`;

export const environmentsService = {
  list: (publishedOnly = false) =>
    api.get<ManagedEnvironment[]>(`/environments${publishedOnly ? '?published=true' : ''}`),
  get: (environmentId: string) => api.get<EnvironmentDetail>(environmentPath(environmentId)),
  create: (input: {
    environmentId?: string;
    name: string;
    description?: string;
    baseEnvironmentId: string;
    recipe: EnvironmentRecipeInput;
  }) => api.post<EnvironmentMutationResult>('/environments', input),
  update: (
    environmentId: string,
    input: {
      name?: string;
      description?: string;
      baseEnvironmentId: string;
      recipe: EnvironmentRecipeInput;
    },
  ) => api.put<EnvironmentMutationResult>(environmentPath(environmentId), input),
  build: (environmentId: string, revisionId: string) =>
    api.post<EnvironmentMutationResult>(`${revisionPath(environmentId, revisionId)}/build`, {}),
  retry: (environmentId: string, revisionId: string) =>
    api.post<EnvironmentMutationResult>(`${revisionPath(environmentId, revisionId)}/retry`, {}),
  acceptFindings: (environmentId: string, revisionId: string) =>
    api.post<EnvironmentMutationResult>(
      `${revisionPath(environmentId, revisionId)}/acknowledge`,
      {},
    ),
  publish: (environmentId: string, revisionId: string) =>
    api.post<ManagedEnvironment & { revision: EnvironmentRevision }>(
      `${revisionPath(environmentId, revisionId)}/publish`,
      {},
    ),
  rebuild: (environmentId: string) =>
    api.post<EnvironmentMutationResult>(`${environmentPath(environmentId)}/rebuild`, {}),
  rebuildAll: (environmentIds?: string[]) =>
    api.post<{ builds: EnvironmentMutationResult[] }>(
      '/environments/rebuild',
      environmentIds ? { environmentIds } : {},
    ),
  retire: (environmentId: string) =>
    api.post<ManagedEnvironment>(`${environmentPath(environmentId)}/retire`, {}),
  logs: (environmentId: string, revisionId: string) =>
    api.get<{
      buildId?: string | null;
      buildLogUrl?: string | null;
      failure?: EnvironmentRevision['failure'];
      scanFindings?: EnvironmentRevision['scanFindings'];
      verification?: EnvironmentRevision['verification'];
    }>(`${revisionPath(environmentId, revisionId)}/logs`),
};

const toolPath = (toolId: string) => `/tools/${encodeURIComponent(toolId)}`;
const toolVersionPath = (toolId: string, versionId: string) =>
  `${toolPath(toolId)}/versions/${encodeURIComponent(versionId)}`;

export const toolsService = {
  list: (publishedOnly = false) =>
    api.get<ManagedTool[]>(`/tools${publishedOnly ? '?published=true' : ''}`),
  get: (toolId: string) => api.get<ManagedTool>(toolPath(toolId)),
  create: (input: {
    toolId?: string;
    name: string;
    description?: string;
    category?: string;
    publisher?: string;
  }) => api.post<ManagedTool>('/tools', input),
  update: (
    toolId: string,
    input: { name?: string; description?: string; category?: string; publisher?: string },
  ) => api.put<ManagedTool>(toolPath(toolId), input),
  createVersion: (toolId: string, definition: ToolVersionDefinition) =>
    api.post<ToolMutationResult>(`${toolPath(toolId)}/versions`, { definition }),
  updateVersion: (toolId: string, versionId: string, definition: ToolVersionDefinition) =>
    api.put<ToolMutationResult>(toolVersionPath(toolId, versionId), { definition }),
  build: (toolId: string, versionId: string) =>
    api.post<ToolMutationResult>(`${toolVersionPath(toolId, versionId)}/build`, {}),
  retry: (toolId: string, versionId: string) =>
    api.post<ToolMutationResult>(`${toolVersionPath(toolId, versionId)}/retry`, {}),
  acceptFindings: (toolId: string, versionId: string) =>
    api.post<ToolMutationResult>(`${toolVersionPath(toolId, versionId)}/acknowledge`, {}),
  publish: (toolId: string, versionId: string) =>
    api.post<ToolMutationResult>(`${toolVersionPath(toolId, versionId)}/publish`, {}),
  recommend: (toolId: string, versionId: string) =>
    api.put<{ tool: ManagedTool; environments: ManagedEnvironment[] }>(
      `${toolPath(toolId)}/recommended`,
      { versionId },
    ),
  logs: (toolId: string, versionId: string) =>
    api.get<{
      buildId?: string | null;
      buildLogUrl?: string | null;
      failure?: ManagedToolVersion['failure'];
      scanFindings?: ManagedToolVersion['scanFindings'];
      verification?: ManagedToolVersion['verification'];
    }>(`${toolVersionPath(toolId, versionId)}/logs`),
};
