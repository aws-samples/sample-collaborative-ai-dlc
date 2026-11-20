import { api } from './api';
import { decodeNativeGitVerification } from './nativeGitChangeSet';
import type { NativeRevision, NativeRevisionTarget } from './nativeHistory';
import {
  decodeNativeApplicationSource,
  type NativeApplicationSource,
  type NativeExecution,
  type NativePublishedFile,
} from './nativeIntents';

export type NativeResultRequest = NativeRevisionTarget & {
  requestId: string;
  fileId?: string;
  sha256?: string;
  format?: 'git';
};
type BranchObservation =
  | { status: 'matched' | 'different'; commit: string }
  | { status: 'absent' | 'unavailable' };
export interface NativeGitDelivery {
  repository: NativeApplicationSource & { branch: string; commit: string };
  sourceBaselineId: string;
  branch: string;
  deltaSha256: string;
  publicationOutcome: NativeRevision['outcome'];
  changeCount: number;
  verification: ReturnType<typeof decodeNativeGitVerification>;
  commit?: string;
  tree?: string;
  observation?: BranchObservation;
}
export interface NativeGitResultContext {
  source: NativeExecution['repository'];
  outcome?: NativeRevision['outcome'];
  previous?: NativeGitDelivery;
}
type ResultContext = NativePublishedFile | NativeGitResultContext;

export interface NativeResult {
  projectId: string;
  executionId: string;
  requestId: string;
  publicationId: string;
  publicationSequence: number;
  status: 'pending' | 'building' | 'ready' | 'failed' | 'retryable';
  delivery?: NativeGitDelivery;
  download?: {
    filename: string;
    downloadUrl: string;
    bytes: number;
    sha256: string;
    expiresAt: string;
  };
}
const sha = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const oid = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(v);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
function invalid(): never {
  throw new Error('The exact result download could not be verified.');
}
function checkTarget(executionId: string, request: NativeResultRequest, context?: ResultContext) {
  const file = context && 'id' in context ? context : undefined;
  const git = context && 'source' in context;
  const fields = [
    'requestId',
    'publicationId',
    'publicationSequence',
    ...(git ? ['format'] : request.fileId !== undefined ? ['fileId', 'sha256'] : []),
  ];
  if (
    Object.keys(request).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(request, field)) ||
    !uuid.test(request.requestId) ||
    (git && !uuid.test(executionId)) ||
    !sha(request.publicationId) ||
    !Number.isSafeInteger(request.publicationSequence) ||
    request.publicationSequence < 1 ||
    (request.fileId !== undefined &&
      (!/^nf-[a-f0-9]{64}$/.test(request.fileId) || !sha(request.sha256))) ||
    (file && (request.fileId !== file.id || request.sha256 !== file.sha256)) ||
    request.format !== (git ? 'git' : undefined)
  )
    invalid();
}
function decodeObservation(value: unknown, commit: string): BranchObservation {
  if (!object(value)) invalid();
  if (value.status === 'absent' || value.status === 'unavailable') {
    if (value.commit !== undefined) invalid();
    return { status: value.status };
  }
  if (
    (value.status !== 'matched' && value.status !== 'different') ||
    !oid(value.commit) ||
    (value.status === 'matched') !== (commit === value.commit)
  )
    invalid();
  return { status: value.status, commit: value.commit };
}
function decodeDelivery(
  value: unknown,
  executionId: string,
  { source, outcome, previous }: NativeGitResultContext,
  ready: boolean,
  observe: boolean,
): NativeGitDelivery {
  if (!object(value) || !object(value.repository)) invalid();
  const repo = value.repository;
  const branch = `aidlc/native-${executionId}`;
  if (
    repo.provider !== source.provider ||
    repo.repository !== source.repository ||
    typeof repo.branch !== 'string' ||
    !repo.branch ||
    !oid(repo.commit) ||
    (source.branch !== null && repo.branch !== source.branch) ||
    (source.commit !== null && repo.commit !== source.commit) ||
    value.branch !== (repo.branch === branch ? `${branch}-result` : branch) ||
    !sha(value.sourceBaselineId) ||
    !sha(value.deltaSha256) ||
    (value.publicationOutcome !== 'STOPPED' && value.publicationOutcome !== 'WAITING_FOR_INPUT') ||
    (outcome !== undefined && outcome !== value.publicationOutcome) ||
    typeof value.changeCount !== 'number' ||
    !Number.isSafeInteger(value.changeCount) ||
    value.changeCount < 0 ||
    !object(value.verification)
  )
    invalid();
  const verification = decodeNativeGitVerification(value.verification);
  if (verification.sha256 ? verification.sha256 !== value.deltaSha256 : !verification.reason)
    invalid();
  const { commit, tree } = value;
  if (
    (ready || commit !== undefined || tree !== undefined || observe) &&
    (!oid(commit) ||
      !oid(tree) ||
      commit.length !== repo.commit.length ||
      tree.length !== commit.length)
  )
    invalid();
  if (
    previous &&
    (previous.sourceBaselineId !== value.sourceBaselineId ||
      previous.deltaSha256 !== value.deltaSha256 ||
      previous.repository.commit !== repo.commit ||
      previous.repository.branch !== repo.branch ||
      previous.publicationOutcome !== value.publicationOutcome ||
      previous.changeCount !== value.changeCount ||
      (previous.commit !== undefined && (previous.commit !== commit || previous.tree !== tree)))
  )
    invalid();
  if (!observe && value.observation !== undefined) invalid();
  return {
    repository: {
      ...decodeNativeApplicationSource({ provider: repo.provider, repository: repo.repository }),
      branch: repo.branch,
      commit: repo.commit,
    },
    branch: value.branch,
    sourceBaselineId: value.sourceBaselineId,
    deltaSha256: value.deltaSha256,
    publicationOutcome: value.publicationOutcome,
    changeCount: value.changeCount,
    verification,
    ...(typeof commit === 'string' && typeof tree === 'string' ? { commit, tree } : {}),
    ...(observe && typeof commit === 'string'
      ? { observation: decodeObservation(value.observation, commit) }
      : {}),
  };
}
export function decodeNativeResult(
  value: unknown,
  projectId: string,
  executionId: string,
  request: NativeResultRequest,
  context?: ResultContext,
  observe = false,
): NativeResult {
  checkTarget(executionId, request, context);
  if (
    !object(value) ||
    value.projectId !== projectId ||
    value.executionId !== executionId ||
    Object.entries(request).some(([k, v]) => value[k] !== v) ||
    value.fileId !== request.fileId ||
    value.sha256 !== request.sha256 ||
    value.format !== request.format ||
    !['pending', 'building', 'ready', 'failed', 'retryable'].includes(String(value.status))
  )
    invalid();
  const git = context && 'source' in context ? context : undefined;
  const file = context && 'id' in context ? context : undefined;
  if (!git && (value.delivery !== undefined || observe)) invalid();
  const delivery = git
    ? decodeDelivery(value.delivery, executionId, git, value.status === 'ready', observe)
    : undefined;
  const d = value.download;
  if (value.status === 'ready') {
    if (
      !object(d) ||
      !sha(d.sha256) ||
      !Number.isSafeInteger(d.bytes) ||
      Number(d.bytes) < 0 ||
      Number(d.bytes) > 260 * 1024 * 1024 ||
      typeof d.filename !== 'string' ||
      !/^[A-Za-z0-9_.-]+$/.test(d.filename) ||
      (git &&
        d.filename !==
          `native-result-${request.publicationSequence}-${request.publicationId.slice(0, 12)}.bundle`) ||
      typeof d.downloadUrl !== 'string' ||
      typeof d.expiresAt !== 'string' ||
      !Number.isFinite(Date.parse(d.expiresAt)) ||
      Date.parse(d.expiresAt) <= Date.now() ||
      Date.parse(d.expiresAt) > Date.now() + 360_000 ||
      (request.fileId && d.sha256 !== request.sha256) ||
      (file && d.bytes !== file.bytes)
    )
      invalid();
    let url: URL;
    try {
      url = new URL(d.downloadUrl);
    } catch {
      return invalid();
    }
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      url.hash ||
      !/^[a-z0-9.-]+\.s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com(?:\.cn)?$/.test(url.hostname) ||
      !new RegExp(`^/native-results/v1/[a-f0-9]{64}/${d.sha256}$`).test(url.pathname)
    )
      invalid();
  } else if (d !== undefined) invalid();
  return { ...(value as unknown as NativeResult), delivery };
}
const path = (projectId: string, executionId: string) =>
  `/projects/${encodeURIComponent(projectId)}/native-intents/${encodeURIComponent(executionId)}/results`;

async function readResult(
  projectId: string,
  executionId: string,
  request: NativeResultRequest,
  context?: ResultContext,
  observe = false,
) {
  checkTarget(executionId, request, context);
  const query = new URLSearchParams(
    Object.fromEntries(Object.entries(request).map(([key, value]) => [key, String(value)])),
  );
  if (observe) query.set('observe', '1');
  const value = await api.get<unknown>(`${path(projectId, executionId)}?${query}`);
  return decodeNativeResult(value, projectId, executionId, request, context, observe);
}
export const nativeResultsService = {
  async request(
    projectId: string,
    executionId: string,
    request: NativeResultRequest,
    context?: ResultContext,
  ) {
    checkTarget(executionId, request, context);
    const value = await api.post<unknown>(path(projectId, executionId), request);
    return decodeNativeResult(value, projectId, executionId, request, context);
  },
  status(
    projectId: string,
    executionId: string,
    request: NativeResultRequest,
    context?: ResultContext,
  ) {
    return readResult(projectId, executionId, request, context);
  },
  async observe(result: NativeResult, context: Omit<NativeGitResultContext, 'previous'>) {
    if (!result.delivery?.commit) invalid();
    const { projectId, executionId, publicationId, publicationSequence, requestId } = result;
    return readResult(
      projectId,
      executionId,
      { publicationId, publicationSequence, requestId, format: 'git' },
      { ...context, previous: result.delivery },
      true,
    );
  },
};
