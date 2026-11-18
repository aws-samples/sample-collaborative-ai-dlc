// Validation of an agent's `describe_changes` description: the Conventional
// Commits type, scope, summary and breaking change of what a stage changed.
// Shared by the MCP process bridge and the engine's commit messages.

const SUMMARY_MAX = 72;
const BREAKING_MAX = 500;
const SCOPE = /^[a-z0-9][a-z0-9-]{0,29}$/;

// Conventional Commits types (the Angular convention's set).
export const COMMIT_TYPES = Object.freeze([
  'feat',
  'fix',
  'perf',
  'refactor',
  'revert',
  'docs',
  'test',
  'build',
  'ci',
  'style',
  'chore',
]);

const AGENT_HEADER = new RegExp(`^(?:${COMMIT_TYPES.join('|')})(?:\\([^)]*\\))?!?:\\s*`, 'i');
// An issue key the agent wrote itself; the engine appends the intent's own.
const AGENT_ISSUE_KEY = /\s*(?:\[[A-Z][A-Z0-9_]*-[0-9]+\]|\([A-Z][A-Z0-9_]*-[0-9]+\))\s*/g;

// Single line, no control characters or emoji, at most `max` characters.
export const oneLine = (text, max) => {
  const line = String(text ?? '')
    .replace(/(?:\p{Cc}|\p{Extended_Pictographic}|\u200d|\ufe0f)+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return line.length > max ? `${line.slice(0, max - 3).trimEnd()}...` : line;
};

// A header subject parsers read unambiguously: no `: ` (the header separator).
export const subjectText = (text, max) =>
  oneLine(String(text ?? '').replace(/:(?=\s|$)/g, ''), max);

// Validates an agent's `describe_changes` call and returns the normalised
// description. Throws with a message the agent can act on.
export const normaliseChangeDescription = ({
  type,
  scope = null,
  summary,
  breaking = false,
  breakingChange = null,
} = {}) => {
  if (!COMMIT_TYPES.includes(type)) {
    throw new Error(`type must be one of: ${COMMIT_TYPES.join(', ')}`);
  }
  const cleanScope = scope == null || scope === '' ? null : String(scope).trim().toLowerCase();
  if (cleanScope !== null && !SCOPE.test(cleanScope)) {
    throw new Error('scope must be a short kebab-case noun, for example "api" or "billing"');
  }
  // Drop a header and issue keys the agent wrote itself ("fix(api): …", "[ABC-12]")
  // and the trailing full stop.
  let text = oneLine(summary, 1000)
    .replace(AGENT_ISSUE_KEY, ' ')
    .trim()
    .replace(AGENT_HEADER, '')
    .replace(/\.+$/, '')
    .trim();
  // Conventional subjects start lower case; keep acronyms such as "API".
  if (/^[A-Z][a-z]/.test(text)) text = text[0].toLowerCase() + text.slice(1);
  text = subjectText(text, 1000);
  if (!text) throw new Error('summary must describe the change in a few words');
  if (text.length > SUMMARY_MAX) {
    throw new Error(`summary must be ${SUMMARY_MAX} characters or fewer`);
  }
  const isBreaking = breaking === true;
  const note = isBreaking ? oneLine(breakingChange, BREAKING_MAX) : '';
  if (isBreaking && !note) {
    throw new Error('breakingChange must say what breaks and how to migrate when breaking is true');
  }
  return {
    type,
    scope: cleanScope,
    summary: text,
    breaking: isBreaking,
    breakingChange: isBreaking ? note : null,
  };
};
