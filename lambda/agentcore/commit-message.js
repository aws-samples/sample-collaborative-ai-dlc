// Engine commit messages. The default `aidlc` style is the original
// `aidlc(<stage>): <unit> — <execution>` form. ENGINE_COMMIT_STYLE=conventional
// writes Conventional Commits headers instead, so repositories that lint commit
// messages accept engine pushes, and appends the Jira key of the tracker issue
// the intent was started from. Stage, unit and execution move to trailers, so
// every commit stays attributable from git alone.

const HEADER_MAX = 100;
const TITLE_MAX = 92;
const JIRA_KEY = /^[A-Z][A-Z0-9_]*-[1-9][0-9]*$/;

export const commitStyle = (env = process.env) =>
  env?.ENGINE_COMMIT_STYLE === 'conventional' ? 'conventional' : 'aidlc';

// The Jira issue key the intent was started from, or null.
export const trackerKey = (source) =>
  source?.provider === 'jira-cloud' &&
  (source.resourceType ?? 'issue') === 'issue' &&
  JIRA_KEY.test(String(source.resourceId ?? ''))
    ? String(source.resourceId)
    : null;

// Single line, no control characters or emoji, at most `max` characters.
const oneLine = (text, max) => {
  const line = String(text ?? '')
    .replace(/(?:\p{Cc}|\p{Extended_Pictographic}|\u200d|\ufe0f)+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return line.length > max ? `${line.slice(0, max - 3).trimEnd()}...` : line;
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

const conventionalSubject = ({ kind, stageId, unitSlug, label }) => {
  switch (kind) {
    case 'merge':
      return `merge ${unitSlug} lane`;
    case 'reconcile':
      return `reconcile ${unitSlug} lane with the intent branch`;
    case 'conflict-resolution':
      return `resolve ${unitSlug} lane conflicts`;
    default:
      return `${stageId} stage${unitSlug ? ` for ${unitSlug}` : ''}${label ? `, ${label}` : ''}`;
  }
};

const conventionalMessage = ({ kind, stageId, unitSlug, label, executionId, intent }) => {
  const key = trackerKey(intent?.source);
  const suffix = key ? ` [${key}]` : '';
  const prefix = 'chore(aidlc): ';
  // No parentheses or colons in the subject: commit parsers read the scope greedily.
  const subject = oneLine(
    conventionalSubject({ kind, stageId, unitSlug, label }).replace(/[():]/g, ' '),
    HEADER_MAX - prefix.length - suffix.length,
  );
  const title = oneLine(intent?.title, TITLE_MAX);
  const trailers = [
    stageId && kind === 'stage' ? `AIDLC-Stage: ${stageId}` : null,
    unitSlug ? `AIDLC-Unit: ${oneLine(unitSlug, 80)}` : null,
    `AIDLC-Execution: ${executionId}`,
  ].filter(Boolean);
  return [
    `${prefix}${subject}${suffix}`,
    ...(title ? ['', `Intent: ${title}`] : []),
    '',
    ...trailers,
  ].join('\n');
};

// kind: 'stage' (default), 'merge', 'reconcile' or 'conflict-resolution'.
// intent: the execution META row ({ title, source }); only read in the
// conventional style.
export const engineCommitMessage = ({
  kind = 'stage',
  stageId,
  unitSlug = null,
  label = null,
  executionId,
  intent = null,
  style = 'aidlc',
}) =>
  style === 'conventional'
    ? conventionalMessage({ kind, stageId, unitSlug, label, executionId, intent })
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
