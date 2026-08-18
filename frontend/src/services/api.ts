import { authService } from './auth';
import {
  currentSessionEpoch,
  isSessionExpiryNotified,
  notifySessionExpired,
} from './sessionExpiry';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL;

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
  const { session, expired } = await authService.resolveSession();
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

  if (!response.ok) {
    // A 401 is not proof the Cognito session is dead: endpoints forward
    // upstream provider statuses verbatim, so a revoked GitHub/GitLab/Jira
    // token surfaces as a 401 too. Only sign out when a forced refresh shows
    // the session itself is unusable. (403 is authorization — admin gates —
    // and never means expiry.)
    if (response.status === 401 && !isSessionExpiryNotified()) {
      const refreshed = await authService.resolveSession({ forceRefresh: true });
      if (refreshed.expired) {
        notifySessionExpired(epoch);
      }
    }
    const rawText = await response.text().catch(() => '');
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
        : rawText || 'Request failed';
    throw new ApiError(response.status, message, parsed);
  }

  return response;
}

export const api = {
  async get<T>(path: string): Promise<T> {
    const response = await fetchWithAuth(path);
    return response.json();
  },

  async post<T>(path: string, body: unknown): Promise<T> {
    const response = await fetchWithAuth(path, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return response.json();
  },

  async put<T>(path: string, body: unknown): Promise<T> {
    const response = await fetchWithAuth(path, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
    return response.json();
  },

  async patch<T>(path: string, body: unknown): Promise<T> {
    const response = await fetchWithAuth(path, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
    return response.json();
  },

  async delete(path: string): Promise<void> {
    await fetchWithAuth(path, { method: 'DELETE' });
  },
};
