/**
 * Error details surfaced when starting an agent run fails with a structured
 * reason (e.g. the selected CLI has no credentials configured, or every
 * worker has failed to authenticate it).
 */
export interface AgentStartError {
  /** Human-readable, already user-safe error message. */
  message: string;
  /** Short CTA link (e.g. to the Admin Agent Settings page). Optional. */
  actionHref?: string;
  /** CTA label paired with `actionHref`. */
  actionLabel?: string;
}

/**
 * Turn a thrown error from an agent-start call into a user-facing
 * {@link AgentStartError}. Handles:
 *   - Structured 4xx bodies from the dispatch Lambda (`cli_unavailable`,
 *     `Agent pool at capacity`, `GitHub not connected`, etc.).
 *   - Generic network/timeout failures → falls back to the error message.
 */
export function extractAgentStartError(err: unknown): AgentStartError {
  // ApiError (from services/api.ts) carries a parsed JSON body when available.
  // Use structural typing so this helper doesn't need to import ApiError.
  const maybeApi = err as { body?: Record<string, unknown>; message?: string };

  const body = maybeApi?.body;
  if (body && typeof body === 'object') {
    const message = (typeof body.message === 'string' && body.message)
      ? body.message
      : (typeof body.error === 'string' && body.error)
        ? body.error
        : undefined;
    if (message) {
      return {
        message,
        actionHref: typeof body.actionHref === 'string' ? body.actionHref : undefined,
        actionLabel: typeof body.actionLabel === 'string' ? body.actionLabel : undefined,
      };
    }
  }

  const fallback = (maybeApi && typeof maybeApi.message === 'string' && maybeApi.message)
    ? maybeApi.message
    : 'Unknown error while starting the agent.';
  return { message: fallback };
}
