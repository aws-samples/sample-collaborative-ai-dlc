// Engine commit messages, as Conventional Commits, so repositories that lint
// commit messages accept engine pushes and release tooling can read them:
//   - the first stage commit holding the described work in each repository
//     (the lead draft of an ensemble stage, otherwise the stage commit) uses
//     the type, scope, summary and breaking change the stage agent declared
//     with `describe_changes`, which only the agent can judge;
//   - every other commit (repair, lane merges, or a stage the agent did not
//     describe) is `chore(aidlc): checkpoint …`, or `docs(aidlc): …` for a
//     stage before construction, which only writes AI-DLC artifacts. Release
//     tooling ignores both by default.
// The Jira key of the tracker issue the intent was started from is appended,
// and stage, unit and execution go in trailers, so every commit stays
// attributable from git alone.

import { trackerKey } from '../shared/tracker-key.js';
import {
  COMMIT_TYPES,
  normaliseChangeDescription,
  oneLine,
  subjectText,
} from '../shared/commit-description.js';

export { COMMIT_TYPES, normaliseChangeDescription, trackerKey };

const HEADER_MAX = 100;
const TITLE_MAX = 92;
// Body and footer line limit of the default commitlint configuration.
const LINE_MAX = 100;

// Word-wraps one line to `width` columns; a word longer than a line is split
// rather than dropped.
const wrap = (text, width) => {
  const lines = [];
  let line = '';
  for (let word of text.split(' ')) {
    while (word.length > width) {
      if (line) lines.push(line);
      lines.push(word.slice(0, width));
      word = word.slice(width);
      line = '';
    }
    if (!word) continue;
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
};

// A stored description, re-validated; null when absent or no longer valid.
// committedRepos: the repositories a commit has already used it in.
const storedDescription = (description) => {
  if (!description || typeof description !== 'object') return null;
  try {
    const committedRepos = Array.isArray(description.committedRepos)
      ? description.committedRepos.filter((repo) => typeof repo === 'string')
      : [];
    return {
      ...normaliseChangeDescription(description),
      descriptionId: description.descriptionId,
      committedRepos,
    };
  } catch {
    return null;
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

// kind: 'stage' (default), 'merge', 'reconcile' or 'conflict-resolution'.
// phase: the stage's workflow phase. intent: the execution META row ({ title,
// source }). description: the stage row's commitDescription, passed only for a
// commit that holds the described work.
export const engineCommitMessage = ({
  kind = 'stage',
  stageId,
  phase = null,
  unitSlug = null,
  label = null,
  executionId,
  intent = null,
  description = null,
}) => {
  const key = trackerKey(intent?.source);
  const suffix = key ? ` [${key}]` : '';
  const described = kind === 'stage' ? storedDescription(description) : null;
  const prefix = described
    ? `${described.type}${described.scope ? `(${described.scope})` : ''}${described.breaking ? '!' : ''}: `
    : `${kind === 'stage' && ARTIFACT_PHASES.has(phase) ? 'docs' : 'chore'}(aidlc): `;
  const subject = subjectText(
    described ? described.summary : engineSubject({ kind, stageId, unitSlug, label }),
    HEADER_MAX - prefix.length - suffix.length,
  );
  const title = oneLine(intent?.title, TITLE_MAX);
  // Its own paragraph, so the trailers below stay a git trailer block.
  const breaking = described?.breaking
    ? wrap(`BREAKING CHANGE: ${described.breakingChange}`, LINE_MAX)
    : [];
  const footer = [
    stageId && kind === 'stage' ? `AIDLC-Stage: ${stageId}` : null,
    unitSlug ? `AIDLC-Unit: ${oneLine(unitSlug, 80)}` : null,
    `AIDLC-Execution: ${executionId}`,
  ].filter(Boolean);
  return [
    `${prefix}${subject}${suffix}`,
    ...(title ? ['', `Intent: ${title}`] : []),
    ...(breaking.length ? ['', ...breaking] : []),
    '',
    ...footer,
  ].join('\n');
};

// The message builder for one execution. Reads the intent's META row once; a
// failed read leaves out the title and key.
export const createEngineCommitMessages = ({ store, executionId }) => {
  let intent;
  return async (options) => {
    intent ??= Promise.resolve()
      .then(() => store?.getExecution?.(executionId))
      .catch(() => null);
    return engineCommitMessage({ ...options, executionId, intent: await intent });
  };
};

// The stage's current description, or null (none recorded, invalid, or
// unreadable). Never throws.
export const readCommitDescription = async ({ store, executionId, stageInstanceId }) => {
  if (!stageInstanceId) return null;
  try {
    const row = await store?.getStage?.(executionId, stageInstanceId, { consistentRead: true });
    return storedDescription(row?.commitDescription);
  } catch {
    return null;
  }
};

// The commitAndPushAll messages for a commit that may hold the described work:
// `message` uses the description, and `messages` overrides it with a
// checkpoint for each repository a commit has already used it in, so a
// repository whose earlier commit failed still gets the typed commit.
export const stageCommitMessages = async ({ messageFor, description = null, ...options }) => {
  const message = await messageFor({ ...options, description });
  const used = description?.committedRepos ?? [];
  if (used.length === 0) return { message };
  const checkpoint = await messageFor(options);
  return { message, messages: Object.fromEntries(used.map((repo) => [repo, checkpoint])) };
};

// Records the repositories this commit used the description in, so a later
// commit of the same stage (a park, then the resumed leg) doesn't claim the
// change twice there. Never throws.
export const consumeCommitDescription = async ({
  store,
  executionId,
  stageInstanceId,
  description,
  gitResult,
}) => {
  if (!description?.descriptionId) return;
  const used = new Set(description.committedRepos ?? []);
  const repos = [
    ...new Set(
      (gitResult?.results ?? [])
        .filter((r) => r?.committed === true && typeof r.repo === 'string' && !used.has(r.repo))
        .map((r) => r.repo),
    ),
  ];
  if (repos.length === 0) return;
  await Promise.resolve()
    .then(() =>
      store?.recordCommitDescriptionUse?.({
        executionId,
        stageInstanceId,
        descriptionId: description.descriptionId,
        repos,
      }),
    )
    .catch(() => {});
};
