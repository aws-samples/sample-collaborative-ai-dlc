import { authService } from './auth';

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
  const session = await authService.getSession();
  if (!session) {
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
