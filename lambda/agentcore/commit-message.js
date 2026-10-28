// Engine commit messages. The default `aidlc` style is the original
// `aidlc(<stage>): <unit> — <execution>` form. ENGINE_COMMIT_STYLE=conventional
// writes Conventional Commits instead, so repositories that lint commit messages
// accept engine pushes and release tooling can read them:
//   - a stage commit uses the type, scope, summary and breaking change the stage
//     agent declared with `describe_changes`, which only the agent can judge;
//   - every other commit (lead draft, repair, lane merges, or a stage the agent
//     did not describe) is `chore(aidlc): checkpoint …`, or `docs(aidlc): …` for
//     a stage before construction, which only writes AI-DLC artifacts. Release
//     tooling ignores both by default.
// The Jira key of the tracker issue the intent was started from is appended,
// and stage, unit and execution go in trailers, so every commit stays
// attributable from git alone.

import { trackerKey } from '../shared/tracker-key.js';

export { trackerKey };

const HEADER_MAX = 100;
const TITLE_MAX = 92;
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

export const commitStyle = (env = process.env) =>
  env?.ENGINE_COMMIT_STYLE === 'conventional' ? 'conventional' : 'aidlc';

// Single line, no control characters or emoji, at most `max` characters.
const oneLine = (text, max) => {
  const line = String(text ?? '')
    .replace(/(?:\p{Cc}|\p{Extended_Pictographic}|\u200d|\ufe0f)+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return line.length > max ? `${line.slice(0, max - 3).trimEnd()}...` : line;
};

// A header subject parsers read unambiguously: no `: ` (the header separator).
const subjectText = (text, max) => oneLine(String(text ?? '').replace(/:(?=\s|$)/g, ''), max);

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
  // Drop a header the agent wrote itself ("fix(api): …") and the trailing full stop.
  let text = oneLine(summary, 1000).replace(AGENT_HEADER, '').replace(/\.+$/, '');
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

// A stored description, re-validated; null when absent or no longer valid.
const storedDescription = (description) => {
  if (!description || typeof description !== 'object') return null;
  try {
    return { ...normaliseChangeDescription(description), descriptionId: description.descriptionId };
  } catch {
    return null;
  }
};

const legacyMessage = ({ kind, stageId, unitSlug, label, executionId }) => {
  switch (kind) {
    case 'merge':
      return `aidlc(merge): ${unitSlug} — ${executionId}`;
    case 'reconcile':
      return `aidlc(reconcile): ${unitSlug} - ${executionId}`;
    case 'conflict-resolution':
      return `aidlc(conflict-resolution): ${unitSlug} — ${executionId}`;
    default: {
      const subject = unitSlug ? `${unitSlug} — ${executionId}` : executionId;
      return `aidlc(${stageId}): ${subject}${label ? ` (${label})` : ''}`;
    }
  }
};

// Phases whose stages only write AI-DLC artifacts, never code.
const ARTIFACT_PHASES = new Set(['initialization', 'ideation', 'inception']);

// Imperative subjects. The engine also commits when a stage parks or fails, so
// a stage commit "checkpoints" the work rather than completing it.
const engineSubject = ({ kind, stageId, unitSlug, label }) => {
  switch (kind) {
    case 'merge':
      return `merge ${unitSlug} lane`;
    case 'reconcile':
      return `reconcile ${unitSlug} lane with the intent branch`;
    case 'conflict-resolution':
      return `resolve ${unitSlug} lane conflicts`;
    default: {
      const what = label ? String(label).replace(/^checkpoint\s+/, '') : 'stage';
      return `checkpoint ${stageId} ${what}${unitSlug ? ` for ${unitSlug}` : ''}`;
    }
  }
};

const conventionalMessage = ({
  kind,
  stageId,
  phase,
  unitSlug,
  label,
  executionId,
  intent,
  description,
}) => {
  const key = trackerKey(intent?.source);
  const suffix = key ? ` [${key}]` : '';
  const described = kind === 'stage' && !label ? storedDescription(description) : null;
  const prefix = described
    ? `${described.type}${described.scope ? `(${described.scope})` : ''}${described.breaking ? '!' : ''}: `
    : `${kind === 'stage' && ARTIFACT_PHASES.has(phase) ? 'docs' : 'chore'}(aidlc): `;
  const subject = subjectText(
    described ? described.summary : engineSubject({ kind, stageId, unitSlug, label }),
    HEADER_MAX - prefix.length - suffix.length,
  );
  const title = oneLine(intent?.title, TITLE_MAX);
  const footer = [
    described?.breaking ? `BREAKING CHANGE: ${described.breakingChange}` : null,
    stageId && kind === 'stage' ? `AIDLC-Stage: ${stageId}` : null,
    unitSlug ? `AIDLC-Unit: ${oneLine(unitSlug, 80)}` : null,
    `AIDLC-Execution: ${executionId}`,
  ].filter(Boolean);
  return [
    `${prefix}${subject}${suffix}`,
    ...(title ? ['', `Intent: ${title}`] : []),
    '',
    ...footer,
  ].join('\n');
};

// kind: 'stage' (default), 'merge', 'reconcile' or 'conflict-resolution'.
// phase: the stage's workflow phase. intent: the execution META row ({ title,
// source }). description: the stage row's commitDescription. All three are only
// read in the conventional style.
export const engineCommitMessage = ({
  kind = 'stage',
  stageId,
  phase = null,
  unitSlug = null,
  label = null,
  executionId,
  intent = null,
  description = null,
  style = 'aidlc',
}) =>
  style === 'conventional'
    ? conventionalMessage({
        kind,
        stageId,
        phase,
        unitSlug,
        label,
        executionId,
        intent,
        description,
      })
    : legacyMessage({ kind, stageId, unitSlug, label, executionId });

// The message builder for one execution. Reads the intent's META row once, and
// only in the conventional style; a failed read leaves out the title and key.
export const createEngineCommitMessages = ({ store, executionId, env = process.env }) => {
  const style = commitStyle(env);
  let intent;
  return async (options) => {
    if (style === 'conventional') {
      intent ??= Promise.resolve()
        .then(() => store?.getExecution?.(executionId))
        .catch(() => null);
    }
    return engineCommitMessage({
      ...options,
      executionId,
      style,
      intent: style === 'conventional' ? await intent : null,
    });
  };
};

// The stage's current description, or null (default style, none recorded,
// invalid, or unreadable). Never throws.
export const readCommitDescription = async ({
  store,
  executionId,
  stageInstanceId,
  env = process.env,
}) => {
  if (commitStyle(env) !== 'conventional' || !stageInstanceId) return null;
  try {
    const row = await store?.getStage?.(executionId, stageInstanceId, { consistentRead: true });
    return storedDescription(row?.commitDescription);
  } catch {
    return null;
  }
};

// Clears a description a commit has used, so a later commit of the same stage
// (a park, then the resumed leg) doesn't claim the change twice. Never throws.
export const consumeCommitDescription = async ({
  store,
  executionId,
  stageInstanceId,
  description,
}) => {
  if (!description?.descriptionId) return;
  await Promise.resolve()
    .then(() =>
      store?.clearCommitDescription?.({
        executionId,
        stageInstanceId,
        descriptionId: description.descriptionId,
      }),
    )
    .catch(() => {});
};
