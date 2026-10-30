// The Jira issue key of the tracker issue an intent was started from (the
// execution META row's `source`), or null for any other tracker or none.

const JIRA_KEY = /^[A-Z][A-Z0-9_]*-[1-9][0-9]*$/;

export const trackerKey = (source) =>
  source?.provider === 'jira-cloud' &&
  (source.resourceType ?? 'issue') === 'issue' &&
  JIRA_KEY.test(String(source.resourceId ?? ''))
    ? String(source.resourceId)
    : null;

// `[KEY] title`, the form Jira's development integrations and many teams' merge
// request checks expect. Unchanged without a key, or when the title already
// starts with it.
export const withTrackerKeyPrefix = (title, source) => {
  const key = trackerKey(source);
  const text = String(title ?? '');
  if (!key || text.startsWith(`[${key}]`)) return text;
  return `[${key}] ${text}`;
};
