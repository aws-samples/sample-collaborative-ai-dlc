import { api } from '../services/api';
import { currentSessionEpoch, isSessionActive, onSessionChanged } from '../services/sessionExpiry';

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

export type RealtimeScopeTarget =
  | { sprintId: string }
  | { projectId: string }
  // The intent token endpoint is project-scoped, so the target carries both ids.
  | {
      intentId: string;
      projectId: string;
      executionBackend?: 'platform' | 'native';
      // A native reply draft is revision-specific: its scope is minted only
      // while that exact interaction/turn is awaiting a reply.
      document?: NativeReplyDocumentTarget;
    };

export interface NativeReplyDocumentTarget {
  // reply: free-text draft; answer: structured QuestionEditor draft (task-3).
  kind: 'reply' | 'answer';
  interactionId: string;
  sequence: number;
}

// Refresh this many ms before the token actually expires so an in-flight
// connect never presents an almost-dead token.
const EXPIRY_SAFETY_MS = 60_000;

// Schedule proactive reconnects this many ms before expiry (callers use
// `msUntilRefresh`). Slightly larger than the cache safety margin so a fresh
// token is fetched by the time the reconnect fires.
const RECONNECT_LEAD_MS = 30_000;

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const UUID_RE = new RegExp(`^${UUID}$`);
const SPRINT_DOC_RE = new RegExp(
  `^(?:presence|sq|requirement|userstory|task|review|discussion)-(${UUID})(?:-.+)?$`,
);
const PROJECT_DOC_RE = new RegExp(`^inception-(${UUID})$`);
const SPRINT_CHANNEL_RE = new RegExp(`^sprint:(${UUID})$`);
// V2 intent realtime — mirrors lambda/shared/realtime-token.js. Intent docs use
// `intent-`-prefixed names so they don't collide with the v1 sprint doc shapes.
const INTENT_DOC_RE = new RegExp(
  `^intent-(?:sq|discussion|presence|review|artifact|draft)-(${UUID})(?:-.+)?$`,
);
const INTENT_CHANNEL_RE = new RegExp(`^intent:(${UUID})$`);

/**
 * Map a Yjs doc name to the token target that covers it. Mirrors the
 * server-side extractor in lambda/shared/realtime-token.js (deny-by-default:
 * unknown formats return null and the server would reject them anyway).
 *
 * Intent docs need both ids — the token endpoint is project-scoped — but the
 * doc name only carries the intentId. Callers that subscribe to an intent doc
 * pass an explicit target instead of relying on this; this returns the
 * intentId-only shape for completeness and is not used for token fetches.
 */
export function scopeTargetForYjsDoc(docName: string): RealtimeScopeTarget | null {
  const sprint = SPRINT_DOC_RE.exec(docName);
  if (sprint) return { sprintId: sprint[1] };
  const project = PROJECT_DOC_RE.exec(docName);
  if (project) return { projectId: project[1] };
  return null;
}

/**
 * Map an app-WS documentId (`sprint:{id}`, `intent:{id}`, or bare projectId) to
 * the token target that covers it. For `intent:` the projectId is unknown from
 * the channel alone, so callers that subscribe to an intent channel pass an
 * explicit `{ intentId, projectId }` target rather than relying on this.
 */
export function scopeTargetForChannel(documentId: string): RealtimeScopeTarget | null {
  const native =
    /^native-intent:([A-Za-z0-9][A-Za-z0-9_.-]{0,255}):([A-Za-z0-9][A-Za-z0-9_.-]{0,255})$/.exec(
      documentId,
    );
  if (native) return { projectId: native[1], intentId: native[2], executionBackend: 'native' };
  const sprint = SPRINT_CHANNEL_RE.exec(documentId);
  if (sprint) return { sprintId: sprint[1] };
  if (UUID_RE.test(documentId)) return { projectId: documentId };
  return null;
}

/** True when the doc/channel id is an intent (caller supplies projectId). */
export const isIntentDoc = (docName: string): string | null =>
  INTENT_DOC_RE.exec(docName)?.[1] ?? null;
export const isIntentChannel = (documentId: string): string | null =>
  INTENT_CHANNEL_RE.exec(documentId)?.[1] ?? null;

const cache = new Map<string, RealtimeToken>();
const inflight = new Map<string, Promise<RealtimeToken>>();
onSessionChanged(() => {
  cache.clear();
  inflight.clear();
});

const cacheKey = (target: RealtimeScopeTarget): string => {
  if ('sprintId' in target) return `sprint:${target.sprintId}`;
  if ('intentId' in target) {
    const base = `${target.executionBackend ?? 'platform'}:intent:${target.projectId}:${target.intentId}`;
    return target.document
      ? `${base}:${target.document.kind}:${target.document.interactionId}:${target.document.sequence}`
      : base;
  }
  return `project:${target.projectId}`;
};

const tokenPath = (target: RealtimeScopeTarget): string => {
  if ('sprintId' in target) return `/sprints/${target.sprintId}/realtime-token`;
  if ('intentId' in target)
    return `/projects/${target.projectId}/intents/${target.intentId}/realtime-token`;
  return `/projects/${target.projectId}/realtime-token`;
};

const tokenBody = (target: RealtimeScopeTarget): Record<string, unknown> => {
  if (!('intentId' in target) || target.executionBackend !== 'native') return {};
  if (!target.document) return { executionBackend: 'native' };
  const { kind, interactionId, sequence } = target.document;
  return { executionBackend: 'native', document: { kind, interactionId, sequence } };
};

const isUsable = (token: RealtimeToken): boolean =>
  token.exp * 1000 - EXPIRY_SAFETY_MS > Date.now();

/**
 * Fetch (or reuse) a realtime scope token for the given target.
 */
export async function getRealtimeToken(target: RealtimeScopeTarget): Promise<RealtimeToken> {
  const epoch = currentSessionEpoch();
  if (!isSessionActive()) throw new Error('Realtime session ended');
  const key = cacheKey(target);

  const cached = cache.get(key);
  if (cached && isUsable(cached)) return cached;

  const pending = inflight.get(key);
  if (pending) return pending;

  const request = api
    .post<RealtimeToken>(tokenPath(target), tokenBody(target))
    .then((token) => {
      if (epoch !== currentSessionEpoch() || !isSessionActive() || inflight.get(key) !== request)
        throw new Error('Realtime authorization changed');
      cache.set(key, token);
      return token;
    })
    .finally(() => {
      if (inflight.get(key) === request) inflight.delete(key);
    });
  inflight.set(key, request);
  return request;
}

/**
 * Drop a cached token (e.g. after the server rejects it).
 */
export function invalidateRealtimeToken(target: RealtimeScopeTarget): void {
  cache.delete(cacheKey(target));
  inflight.delete(cacheKey(target));
}

/**
 * Milliseconds until a proactive reconnect should fire for a token expiring
 * at `exp` (epoch seconds). Never negative.
 */
export function msUntilRefresh(exp: number): number {
  return Math.max(exp * 1000 - RECONNECT_LEAD_MS - Date.now(), 0);
}
