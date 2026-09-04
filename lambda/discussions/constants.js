// lambda/discussions — shared constants and the load-time concurrency invariant.
// Split out of index.js so handlers / services / data-access can share them.

export const ENTITY_TYPES = [
  'sprint',
  'inception',
  'question',
  'requirement',
  'userstory',
  'task',
  'review',
  'generalinfo',
];

// entityType → anchor vertex label. `sprint` and `inception` both anchor at
// the Sprint vertex (distinguished by the entity_type property).
export const ANCHOR_LABELS = {
  sprint: 'Sprint',
  inception: 'Sprint',
  question: 'Question',
  requirement: 'Requirement',
  userstory: 'UserStory',
  task: 'Task',
  review: 'Review',
  generalinfo: 'GeneralInfo',
};

export const MESSAGE_ID_RE = /^dm-[a-z0-9-]{8,64}$/;
export const MAX_CONTENT_LENGTH = 10_000;
export const DEFAULT_PAGE_SIZE = 100;
export const MAX_PAGE_SIZE = 200;
export const UNREAD_CAP = 99;
export const SEARCH_MIN_QUERY = 3;
export const SEARCH_MAX_LIMIT = 25;
export const REDACTION_PLACEHOLDER = (name) => `[redacted by ${name}]`;
export const MENTION_EXCERPT_LENGTH = 140;

export const CREATION_GUARD_SECONDS = 30;
export const MESSAGE_GUARD_PENDING_SECONDS = 120;
export const MESSAGE_GUARD_COMPLETE_SECONDS = 3600;
export const POLL_ATTEMPTS = 3;
export const POLL_INTERVAL_MS = 300;

// Takeover-safety invariant: the pending window
// MUST exceed this lambda's timeout, so an expired `pending` guard PROVES the
// original winner is no longer executing — a takeover can never race a
// slow-but-alive winner into a duplicate Neptune write. Terraform sets
// LAMBDA_TIMEOUT_SECONDS alongside the function timeout; both must change
// together. Asserted here (fail fast on misconfiguration) and pinned by a test.
export const LAMBDA_TIMEOUT_SECONDS = Number(process.env.LAMBDA_TIMEOUT_SECONDS ?? 30);
if (!(MESSAGE_GUARD_PENDING_SECONDS > LAMBDA_TIMEOUT_SECONDS)) {
  throw new Error(
    `Takeover-safety invariant violated: message-guard pending window (${MESSAGE_GUARD_PENDING_SECONDS}s) ` +
      `must exceed the lambda timeout (${LAMBDA_TIMEOUT_SECONDS}s)`,
  );
}
