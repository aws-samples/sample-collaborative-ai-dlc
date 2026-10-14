import { api } from './api';
import type { GitProvider } from './gitProvider';
import type { SourceControlAuthType } from './sourceControl';

export type WorkflowSourceProvider = Exclude<GitProvider, 'codecommit'>;

export type WorkflowSourceAuthType = 'public' | SourceControlAuthType;

export interface WorkflowSource {
  sourceId: string;
  provider: WorkflowSourceProvider;
  repository: string;
  revision: string;
  status: 'active' | 'invalid';
  authType: WorkflowSourceAuthType;
  access: 'read';
  verifiedAt?: string;
  updatedAt?: string;
}

export interface WorkflowSourceList {
  sources: WorkflowSource[];
  capabilities: { packageImportsEnabled: boolean };
}

export interface WorkflowSourceSelection {
  provider: WorkflowSourceProvider;
  repository: string;
  authType: WorkflowSourceAuthType;
  confirmDelegation?: boolean;
  expectedRevision: string | null;
}

export interface WorkflowPackageImportRequest {
  jobId: string;
  expectedRevision: string;
  requestedRelease: string;
}

export interface WorkflowPackageImportContext {
  userId: string;
  projectId: string;
  sourceId: string;
  revision: string;
}

export type WorkflowPackageHarness = 'claude' | 'codex' | 'kiro' | 'opencode';

export interface WorkflowPackagePreview {
  packageId: string;
  materializationId: string;
  version: string;
  release: string;
  commit: string;
  harnesses: WorkflowPackageHarness[];
  integrity: 'verified';
  signature: 'not_checked';
  execution: 'not_qualified';
}

interface WorkflowPackageJobStatus {
  jobId: string;
  sourceId: string;
  requestedRelease: string;
  createdAt: number;
  updatedAt: number;
}

export type WorkflowPackageJob = WorkflowPackageJobStatus &
  (
    | { state: 'QUEUED' | 'RUNNING' }
    | { state: 'FAILED' }
    | { state: 'SUCCEEDED'; package: WorkflowPackagePreview }
  );

const RELEASE =
  /^(?:latest|v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-preview\.\d{8}\.[1-9]\d*)?)$/;
const matches = (value: unknown, pattern: RegExp): value is string =>
  typeof value === 'string' && pattern.exec(value)?.[0] === value;

export const isWorkflowPackageRelease = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 256 && matches(value, RELEASE);

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const epoch = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const HARNESSES: WorkflowPackageHarness[] = ['claude', 'codex', 'kiro', 'opencode'];
export const isWorkflowPackageHarness = (value: unknown): value is WorkflowPackageHarness =>
  typeof value === 'string' && HARNESSES.includes(value as WorkflowPackageHarness);
const invalidPackageStatus = () => new Error('Could not read package import status.');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,255}$/;

const recoveryKey = (context: WorkflowPackageImportContext) =>
  matches(context.userId, ID) &&
  matches(context.projectId, ID) &&
  matches(context.sourceId, /^[a-f0-9]{64}$/) &&
  matches(context.revision, UUID)
    ? `aidlc:package-import:v1:${JSON.stringify([
        context.userId,
        context.projectId,
        context.sourceId,
        context.revision,
      ])}`
    : null;

const recoveryRequest = (
  value: unknown,
  context: WorkflowPackageImportContext,
): WorkflowPackageImportRequest | null =>
  record(value) &&
  matches(value.jobId, UUID) &&
  value.expectedRevision === context.revision &&
  isWorkflowPackageRelease(value.requestedRelease)
    ? {
        jobId: value.jobId,
        expectedRevision: context.revision,
        requestedRelease: value.requestedRelease,
      }
    : null;

// Only a nonsecret immutable request is persisted, never a package preview or
// authority. A restored request must be reauthorized through GET status.
export const workflowPackageImportRecovery = {
  read(context: WorkflowPackageImportContext): WorkflowPackageImportRequest | null {
    const key = recoveryKey(context);
    if (!key) return null;
    try {
      const raw = sessionStorage.getItem(key);
      if (!raw || raw.length > 2048) return null;
      const saved: unknown = JSON.parse(raw);
      if (
        !record(saved) ||
        saved.schemaVersion !== 1 ||
        !record(saved.context) ||
        saved.context.userId !== context.userId ||
        saved.context.projectId !== context.projectId ||
        saved.context.sourceId !== context.sourceId ||
        saved.context.revision !== context.revision
      ) {
        return null;
      }
      return recoveryRequest(saved.request, context);
    } catch {
      return null;
    }
  },

  save(context: WorkflowPackageImportContext, value: WorkflowPackageImportRequest): boolean {
    const key = recoveryKey(context);
    const request = recoveryRequest(value, context);
    if (!key || !request) return false;
    try {
      const raw = JSON.stringify({
        schemaVersion: 1,
        context: {
          userId: context.userId,
          projectId: context.projectId,
          sourceId: context.sourceId,
          revision: context.revision,
        },
        request,
      });
      sessionStorage.setItem(key, raw);
      return sessionStorage.getItem(key) === raw;
    } catch {
      return false;
    }
  },

  clear(context: WorkflowPackageImportContext): boolean {
    const key = recoveryKey(context);
    if (!key) return false;
    try {
      sessionStorage.removeItem(key);
      return sessionStorage.getItem(key) === null;
    } catch {
      return false;
    }
  },
};

// Keep the client view as narrow as the HTTP facade. Never retain diagnostics,
// credentials, inventories or paths, even if a future response adds them.
function packageJobView(
  value: unknown,
  sourceId: string,
  jobId: string,
  requestedRelease?: string,
): WorkflowPackageJob {
  if (
    !record(value) ||
    value.jobId !== jobId ||
    value.sourceId !== sourceId ||
    !isWorkflowPackageRelease(value.requestedRelease) ||
    (requestedRelease !== undefined && value.requestedRelease !== requestedRelease) ||
    !epoch(value.createdAt) ||
    !epoch(value.updatedAt) ||
    value.updatedAt < value.createdAt
  ) {
    throw invalidPackageStatus();
  }
  const status: WorkflowPackageJobStatus = {
    jobId,
    sourceId,
    requestedRelease: value.requestedRelease,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
  if (value.state === 'QUEUED' || value.state === 'RUNNING' || value.state === 'FAILED') {
    return { ...status, state: value.state };
  }
  const preview = value.package;
  const harnesses = record(preview) ? preview.harnesses : undefined;
  if (
    value.state !== 'SUCCEEDED' ||
    !record(preview) ||
    !matches(preview.packageId, /^sha256:[a-f0-9]{64}$/) ||
    !matches(preview.materializationId, /^sha256:[a-f0-9]{64}$/) ||
    typeof preview.version !== 'string' ||
    !isWorkflowPackageRelease(`v${preview.version}`) ||
    preview.release !== `v${preview.version}` ||
    (status.requestedRelease === 'latest'
      ? preview.version.includes('-preview.')
      : preview.release !== status.requestedRelease) ||
    !matches(preview.commit, /^[a-f0-9]{40}$/) ||
    !Array.isArray(harnesses) ||
    harnesses.length !== HARNESSES.length ||
    !HARNESSES.every((harness) => harnesses.includes(harness)) ||
    preview.integrity !== 'verified' ||
    preview.signature !== 'not_checked' ||
    preview.execution !== 'not_qualified'
  ) {
    throw invalidPackageStatus();
  }
  return {
    ...status,
    state: 'SUCCEEDED',
    package: {
      packageId: preview.packageId,
      materializationId: preview.materializationId,
      version: preview.version,
      release: `v${preview.version}`,
      commit: preview.commit,
      harnesses: [...HARNESSES],
      integrity: 'verified',
      signature: 'not_checked',
      execution: 'not_qualified',
    },
  };
}

const pathFor = (projectId: string) =>
  `/projects/${encodeURIComponent(projectId)}/workflow-sources`;
const packagesPathFor = (projectId: string, sourceId: string) =>
  `${pathFor(projectId)}/${encodeURIComponent(sourceId)}/packages`;

async function listWorkflowSources(projectId: string): Promise<WorkflowSourceList> {
  const result = await api.get<unknown>(pathFor(projectId));
  // Older deployments return the array directly. They can still administer
  // sources, but only an explicit capability enables package-import requests.
  const sources = Array.isArray(result) ? result : record(result) ? result.sources : undefined;
  if (!Array.isArray(sources)) throw new Error('Could not read workflow sources.');
  return {
    sources,
    capabilities: {
      packageImportsEnabled:
        record(result) &&
        record(result.capabilities) &&
        result.capabilities.packageImportsEnabled === true,
    },
  };
}

export const workflowSourcesService = {
  async list(projectId: string): Promise<WorkflowSource[]> {
    return (await listWorkflowSources(projectId)).sources;
  },

  listWithCapabilities: listWorkflowSources,

  async configure(projectId: string, selection: WorkflowSourceSelection): Promise<WorkflowSource> {
    const { provider, repository, authType, confirmDelegation, expectedRevision } = selection;
    return api.post<WorkflowSource>(pathFor(projectId), {
      provider,
      repository,
      authType,
      ...(confirmDelegation === undefined ? {} : { confirmDelegation }),
      expectedRevision,
    });
  },

  remove(projectId: string, source: Pick<WorkflowSource, 'sourceId' | 'revision'>): Promise<void> {
    return api.delete(`${pathFor(projectId)}/${encodeURIComponent(source.sourceId)}`, {
      expectedRevision: source.revision,
    });
  },

  async createPackageImport(
    projectId: string,
    sourceId: string,
    request: WorkflowPackageImportRequest,
  ): Promise<WorkflowPackageJob> {
    const { jobId, expectedRevision, requestedRelease } = request;
    const result = await api.post<unknown>(packagesPathFor(projectId, sourceId), {
      jobId,
      expectedRevision,
      requestedRelease,
    });
    return packageJobView(result, sourceId, jobId, requestedRelease);
  },

  async getPackageImport(
    projectId: string,
    sourceId: string,
    jobId: string,
  ): Promise<WorkflowPackageJob> {
    const result = await api.get<unknown>(
      `${packagesPathFor(projectId, sourceId)}/${encodeURIComponent(jobId)}`,
    );
    return packageJobView(result, sourceId, jobId);
  },
};

export const isWorkflowSourceApiDisabled = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'status' in error &&
  error.status === 503 &&
  'body' in error &&
  typeof error.body === 'object' &&
  error.body !== null &&
  'code' in error.body &&
  error.body.code === 'WORKFLOW_SOURCE_API_DISABLED';

export const isNativePackageJobsDisabled = (error: unknown): boolean =>
  record(error) &&
  error.status === 503 &&
  record(error.body) &&
  error.body.code === 'NATIVE_PACKAGE_JOBS_DISABLED';
