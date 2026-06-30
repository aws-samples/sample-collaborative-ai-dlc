import { api } from '../services/api';

// Realtime scope tokens.
//
// Both realtime fabrics (the Yjs ECS server and the app WebSocket) require a
// short-lived HMAC-signed scope token at connect time, issued by
// POST /sprints/{sprintId}/realtime-token or
// POST /projects/{projectId}/realtime-token after a membership check.
//
// This module is the single shared fetcher: tokens are cached per target
// until shortly before expiry, with single-flight de-duplication so parallel
// hooks reconnecting at once trigger only one request.

export interface RealtimeToken {
  token: string;
  /** Epoch seconds. */
  exp: number;
  scopes: string[];
}

export type RealtimeScopeTarget = { sprintId: string } | { projectId: string };

// Refresh this many ms before the token actually expires so an in-flight
// connect never presents an almost-dead token.
const EXPIRY_SAFETY_MS = 60_000;

// Schedule proactive reconnects this many ms before expiry (callers use
// `msUntilRefresh`). Slightly larger than the cache safety margin so a fresh
// token is fetched by the time the reconnect fires.
const RECONNECT_LEAD_MS = 30_000;

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const SPRINT_DOC_RE =
  /^(?:presence|sq|requirement|userstory|task|review|discussion)-([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(?:-.+)?$/;
const PROJECT_DOC_RE =
  /^inception-([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;
const SPRINT_CHANNEL_RE =
  /^sprint:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;

/**
 * Map a Yjs doc name to the token target that covers it. Mirrors the
 * server-side extractor in lambda/shared/realtime-token.js (deny-by-default:
 * unknown formats return null and the server would reject them anyway).
 */
export function scopeTargetForYjsDoc(docName: string): RealtimeScopeTarget | null {
  const sprint = SPRINT_DOC_RE.exec(docName);
  if (sprint) return { sprintId: sprint[1] };
  const project = PROJECT_DOC_RE.exec(docName);
  if (project) return { projectId: project[1] };
  return null;
}

/**
 * Map an app-WS documentId (`sprint:{sprintId}` or bare projectId) to the
 * token target that covers it.
 */
export function scopeTargetForChannel(documentId: string): RealtimeScopeTarget | null {
  const sprint = SPRINT_CHANNEL_RE.exec(documentId);
  if (sprint) return { sprintId: sprint[1] };
  if (UUID_RE.test(documentId)) return { projectId: documentId };
  return null;
}

const cache = new Map<string, RealtimeToken>();
const inflight = new Map<string, Promise<RealtimeToken>>();

const cacheKey = (target: RealtimeScopeTarget): string =>
  'sprintId' in target ? `sprint:${target.sprintId}` : `project:${target.projectId}`;

const tokenPath = (target: RealtimeScopeTarget): string =>
  'sprintId' in target
    ? `/sprints/${target.sprintId}/realtime-token`
    : `/projects/${target.projectId}/realtime-token`;

const isUsable = (token: RealtimeToken): boolean =>
  token.exp * 1000 - EXPIRY_SAFETY_MS > Date.now();

/**
 * Fetch (or reuse) a realtime scope token for the given target.
 */
export async function getRealtimeToken(target: RealtimeScopeTarget): Promise<RealtimeToken> {
  const key = cacheKey(target);

  const cached = cache.get(key);
  if (cached && isUsable(cached)) return cached;

  const pending = inflight.get(key);
  if (pending) return pending;

  const request = api
    .post<RealtimeToken>(tokenPath(target), {})
    .then((token) => {
      cache.set(key, token);
      return token;
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, request);
  return request;
}

/**
 * Drop a cached token (e.g. after the server rejects it).
 */
export function invalidateRealtimeToken(target: RealtimeScopeTarget): void {
  cache.delete(cacheKey(target));
}

/**
 * Milliseconds until a proactive reconnect should fire for a token expiring
 * at `exp` (epoch seconds). Never negative.
 */
export function msUntilRefresh(exp: number): number {
  return Math.max(exp * 1000 - RECONNECT_LEAD_MS - Date.now(), 0);
}
