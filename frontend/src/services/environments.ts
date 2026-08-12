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

export interface EnvironmentTool {
  version: string;
  source: 'base' | 'archive';
  url?: string;
  checksum?: EnvironmentChecksum;
  stripComponents?: number;
}

export interface EnvironmentToolCatalogItem {
  label: string;
  publisher: string;
  versions: EnvironmentTool[];
}

export interface EnvironmentToolCatalog {
  schemaVersion: 1;
  tools: Record<'node' | 'python' | 'java' | 'go' | 'rust', EnvironmentToolCatalogItem>;
  buildTools: Record<'maven' | 'gradle', EnvironmentToolCatalogItem>;
}

export interface EnvironmentRecipe {
  schemaVersion: 1;
  base?: {
    environmentId: string;
    revisionId: string;
    imageUri: string;
    imageDigest: string;
  } | null;
  tools: Partial<Record<'node' | 'python' | 'java' | 'go' | 'rust', EnvironmentTool>>;
  buildTools: Partial<Record<'maven' | 'gradle', EnvironmentTool>>;
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
  runtimeArn: string | null;
  runtimeVersion?: string | null;
  runtimeEndpoint: string | null;
  generatedDockerfile?: string | null;
  buildId?: string | null;
  buildLogUrl?: string | null;
  scanFindings?: {
    status?: string;
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
  catalog: () => api.get<EnvironmentToolCatalog>('/environments/catalog'),
  get: (environmentId: string) => api.get<EnvironmentDetail>(environmentPath(environmentId)),
  create: (input: {
    environmentId?: string;
    name: string;
    description?: string;
    baseEnvironmentId: string;
    recipe: EnvironmentRecipe;
  }) => api.post<EnvironmentMutationResult>('/environments', input),
  update: (
    environmentId: string,
    input: {
      name?: string;
      description?: string;
      baseEnvironmentId: string;
      recipe: EnvironmentRecipe;
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
