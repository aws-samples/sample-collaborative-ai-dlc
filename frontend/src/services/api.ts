import { authService } from './auth';
import { onUserCacheEnded } from '@/lib/persistentCache';
import {
  currentSessionEpoch,
  isSessionExpiryNotified,
  notifySessionExpired,
} from './sessionExpiry';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL;
let sessionGeneration = 0;
onUserCacheEnded(() => {
  sessionGeneration++;
});

function sessionResult<T>(value: T, generation: number): T {
  if (generation !== sessionGeneration) throw abortError();
  return value;
}

export class ApiError extends Error {
  status: number;
  /** Parsed JSON body when the response had a `Content-Type: application/json`,
   *  otherwise undefined. Use this to read structured fields like
   *  `error`, `message`, `cli`, `actionHref`, `actionLabel`. */
  body?: Record<string, unknown>;

  constructor(status: number, message: string, body?: Record<string, unknown>) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

async function fetchWithAuth(path: string, options: RequestInit = {}): Promise<Response> {
  // Tagging the request with the current epoch keeps a late 401 from a
  // previous session from signing out a user who has since re-authenticated.
  const epoch = currentSessionEpoch();
  const generation = sessionGeneration;
  const { session, expired } = await authService.resolveSession();
  if (options.signal?.aborted || generation !== sessionGeneration) throw abortError();
  if (!session) {
    // A transient refresh failure (offline) leaves the refresh token valid, so
    // only a definitive expiry signs the user out.
    if (expired) {
      notifySessionExpired(epoch);
    }
    throw new ApiError(401, 'Not authenticated');
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.idToken}`,
      ...options.headers,
    },
  });
  sessionResult(response, generation);

  if (!response.ok) {
    // An abandoned request says nothing about the session.
    if (options.signal?.aborted) throw abortError();
    // A 401 is not proof the Cognito session is dead: endpoints forward
    // upstream provider statuses verbatim, so a revoked GitHub/GitLab/Jira
    // token surfaces as a 401 too. Only sign out when a forced refresh shows
    // the session itself is unusable. (403 is authorization — admin gates —
    // and never means expiry.)
    if (response.status === 401 && !isSessionExpiryNotified()) {
      const refreshed = await authService.resolveSession({ forceRefresh: true });
      if (options.signal?.aborted || generation !== sessionGeneration) throw abortError();
      if (refreshed.expired) {
        notifySessionExpired(epoch);
      }
    }
    const rawText = sessionResult(await response.text().catch(() => ''), generation);
    if (options.signal?.aborted) throw abortError();
    let parsed: Record<string, unknown> | undefined;
    try {
      parsed = rawText ? JSON.parse(rawText) : undefined;
    } catch {
      /* not JSON */
    }
    // Prefer the structured `message` from the API over the raw body text.
    const message =
      parsed && typeof parsed.message === 'string' && parsed.message
        ? parsed.message
        : parsed && typeof parsed.error === 'string' && parsed.error
          ? parsed.error
          : rawText || 'Request failed';
    throw new ApiError(response.status, message, parsed);
  }

  return response;
}

function abortError(): DOMException {
  return new DOMException('The request was aborted.', 'AbortError');
}

export interface ApiGetOptions {
  signal?: AbortSignal;
}

export const api = {
  async get<T>(path: string, { signal }: ApiGetOptions = {}): Promise<T> {
    const generation = sessionGeneration;
    const response = await fetchWithAuth(path, signal ? { signal } : {});
    return sessionResult(await response.json(), generation) as T;
  },

  async post<T>(path: string, body: unknown): Promise<T> {
    const generation = sessionGeneration;
    const response = await fetchWithAuth(path, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return sessionResult(await response.json(), generation);
  },

  async put<T>(path: string, body: unknown): Promise<T> {
    const generation = sessionGeneration;
    const response = await fetchWithAuth(path, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
    return sessionResult(await response.json(), generation);
  },

  async patch<T>(path: string, body: unknown): Promise<T> {
    const generation = sessionGeneration;
    const response = await fetchWithAuth(path, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
    return sessionResult(await response.json(), generation);
  },

  // `body` is optional so existing body-less callers keep their exact
  // behaviour; DELETE routes with a CAS payload (e.g. clearing an AI-DLC
  // release channel with { expectedRevision }) pass it explicitly.
  async delete(path: string, body?: unknown): Promise<void> {
    const generation = sessionGeneration;
    await fetchWithAuth(path, {
      method: 'DELETE',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    sessionResult(undefined, generation);
  },
};
