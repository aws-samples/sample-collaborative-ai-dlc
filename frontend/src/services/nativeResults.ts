import { api } from './api';
import type { NativeRevisionTarget } from './nativeHistory';
import type { NativePublishedFile } from './nativeIntents';

export type NativeResultRequest = NativeRevisionTarget & {
  requestId: string;
  fileId?: string;
  sha256?: string;
};
export interface NativeResult {
  projectId: string;
  executionId: string;
  requestId: string;
  publicationId: string;
  publicationSequence: number;
  status: 'pending' | 'building' | 'ready' | 'failed' | 'retryable';
  download?: {
    filename: string;
    downloadUrl: string;
    bytes: number;
    sha256: string;
    expiresAt: string;
  };
}
const sha = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
function invalid(): never {
  throw new Error('The exact result download could not be verified.');
}
export function decodeNativeResult(
  value: unknown,
  projectId: string,
  executionId: string,
  request: NativeResultRequest,
  file?: NativePublishedFile,
): NativeResult {
  if (
    !object(value) ||
    value.projectId !== projectId ||
    value.executionId !== executionId ||
    Object.entries(request).some(([k, v]) => value[k] !== v) ||
    value.fileId !== request.fileId ||
    value.sha256 !== request.sha256 ||
    !['pending', 'building', 'ready', 'failed', 'retryable'].includes(String(value.status))
  )
    invalid();
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
      typeof d.downloadUrl !== 'string' ||
      typeof d.expiresAt !== 'string' ||
      !Number.isFinite(Date.parse(d.expiresAt)) ||
      Date.parse(d.expiresAt) <= Date.now() ||
      Date.parse(d.expiresAt) > Date.now() + 360_000 ||
      (file && (d.sha256 !== file.sha256 || d.bytes !== file.bytes))
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
  return value as unknown as NativeResult;
}
export const nativeResultsService = {
  async request(
    projectId: string,
    executionId: string,
    request: NativeResultRequest,
    file?: NativePublishedFile,
  ) {
    const value = await api.post<unknown>(
      `/projects/${encodeURIComponent(projectId)}/native-intents/${encodeURIComponent(executionId)}/results`,
      request,
    );
    return decodeNativeResult(value, projectId, executionId, request, file);
  },
  async status(
    projectId: string,
    executionId: string,
    request: NativeResultRequest,
    file?: NativePublishedFile,
  ) {
    const query = new URLSearchParams(
      Object.fromEntries(Object.entries(request).map(([key, value]) => [key, String(value)])),
    );
    const value = await api.get<unknown>(
      `/projects/${encodeURIComponent(projectId)}/native-intents/${encodeURIComponent(executionId)}/results?${query}`,
    );
    return decodeNativeResult(value, projectId, executionId, request, file);
  },
};
