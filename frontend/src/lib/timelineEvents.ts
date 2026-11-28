import type { IntentActivityEvent } from '@/services/intents';
import { GENERIC_FAILURE_SENTENCE, describeFailure } from '@/lib/failureReasons';
import { displayStageName, humanizeSlug } from '@/lib/displayNames';
import { formatAbsolute } from '@/lib/timeAgo';

export type TimelineTone = 'success' | 'waiting' | 'error' | 'running' | 'workspace' | 'neutral';

export type TimelineCategory =
  | 'question'
  | 'document'
  | 'error'
  | 'stage'
  | 'delivery'
  | 'review'
  | 'run'
  | 'workspace'
  | 'note'
  | 'other';

export type TimelineFilter = 'all' | 'questions' | 'documents' | 'errors';

export interface TimelineTechnicalItem {
  label: string;
  value: string;
  copy?: boolean;
}

export interface TimelineEventDescription {
  label: string;
  excerpt: string | null;
  tone: TimelineTone;
  category: TimelineCategory;
  /** Consecutive events sharing a key in the same group fold into one entry. */
  groupKey: string | null;
  /** Force the event into the run-level bucket regardless of its stage. */
  runLevel: boolean;
  /** Stage id named by the summary when the event carries no stage instance. */
  stageId: string | null;
  technical: TimelineTechnicalItem[];
}

export interface TimelineEntry {
  key: string;
  label: string;
  excerpt: string | null;
  tone: TimelineTone;
  category: TimelineCategory;
  timestamp: string;
  events: IntentActivityEvent[];
  grouped: boolean;
  technical: TimelineTechnicalItem[];
}

export interface TimelineGroup {
  key: string;
  kind: 'stage' | 'unit' | 'run';
  /** Name plus the attempt when the stage ran more than once: "Feasibility · attempt 2". */
  title: string;
  /** The stage (or unit/run) name alone. */
  name: string;
  /** Unit lane a per-unit stage instance belongs to (slug, for Details). */
  unitSlug: string | null;
  /** The unit's readable name, shown under the title. */
  unitName: string | null;
  stageInstanceId: string | null;
  /** 1 for the first run of a stage; 2+ when it ran again (retry, rewind, loopback). */
  attempt: number;
  latestTimestamp: string;
  entries: TimelineEntry[];
  counts: {
    /** Question entries (asked and answered) — what the Questions filter lists. */
    questions: number;
    documents: number;
    errors: number;
  };
}

export interface TimelinePerson {
  userId?: string | null;
  email?: string | null;
  username?: string | null;
  displayName?: string | null;
}

export interface TimelineContext {
  stageNameOf: (key: string) => string;
  stages?: readonly {
    stageInstanceId: string | null;
    stageId: string | null;
    unitSlug?: string | null;
  }[];
  /** The signed-in user: their own actions read "you". */
  currentUser?: TimelinePerson | null;
  /** Space members, to turn a user id into a readable name. */
  members?: readonly TimelinePerson[];
  /** Readable unit name for a unit slug; defaults to the humanised slug. */
  unitNameOf?: (slug: string) => string;
}

function unitName(ctx: TimelineContext, slug: string): string {
  return ctx.unitNameOf?.(slug) ?? humanizeSlug(slug);
}

const EXCERPT_LIMIT = 240;
const CLEAN_SUMMARY_LIMIT = 120;

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const SHA_RE = /\b[0-9a-f]{7,40}\b/;
const REPO_AT_SHA_RE = /\b([\w.-]+\/)?([\w.-]+)@[0-9a-f]{7,40}\b/g;
const BRANCH_RE = /\b(?:aidlc|dlc)\/[\w./-]+/;
const PATH_RE = /(?:^|\s)\/[\w./-]{3,}/;
const STAGE_INSTANCE_RE = /\bsi-[0-9a-f]{8,}\b/;

const ENGINE_ACTORS = new Set(['agentcore', 'orchestrator', 'engine', 'system']);

const GIT_FAILURE_SENTENCES: Record<string, string> = {
  push_failed: 'The work could not be pushed to the repository.',
  merge_failed: 'The branches could not be merged.',
};

function failureSentence(code: string | undefined, summary: string): string {
  const failure = describeFailure(code, summary);
  if (failure.sentence !== GENERIC_FAILURE_SENTENCE) return failure.sentence;
  return (failure.code && GIT_FAILURE_SENTENCES[failure.code]) || failure.sentence;
}

const AGENT_NOTE_TYPES: Record<string, string> = {
  progress: 'Agent progress note',
  discovery: 'Agent discovery',
  deviation: 'Agent changed course',
  analysis: 'Agent analysis',
  'stage-complete': 'Agent reported the stage complete',
  completion: 'Agent reported the stage complete',
  WORKSPACE_SCANNED: 'Workspace scanned',
};

const PERSONA_LABELS: Record<string, string> = {
  'v2.persona.contribution': 'Contribution',
  'v2.persona.link_completed': 'Pipeline link',
  'v2.persona.dissent': 'Maintained dissent',
  'v2.persona.gap': 'No evidence recorded',
  'v2.persona.question_withdrawn': 'Question withdrawn',
};

const RELEASE_EVENT_FAMILIES = [
  'v2.summary.',
  'v2.persona.',
  'v2.change.',
  'v2.loopback.',
  'v2.review.',
  'v2.sensor.',
  'v2.gate.',
  'v2.plan.',
  'v2.learning.',
  'v2.units.',
];
const RELEASE_OUTCOME_FAILED = /(failed|blocked|halt|invalid|expired)$/;
const RELEASE_OUTCOME_ATTENTION =
  /(requested|noncompliant|waived|gap|recommended|advisory|withheld|changed|gate|dissent|warnings|override)$/;

const NEVER_GROUP_FAMILIES = [
  'v2.question.',
  'v2.gate.',
  'v2.pr.',
  'v2.tracker.',
  'v2.execution.',
  'v2.unit.',
  'v2.units.',
  'v2.plan.',
  'v2.summary.',
];

const sameId = (a: string | null | undefined, b: string) =>
  !!a && a.trim().toLowerCase() === b.toLowerCase();

const isPerson = (person: TimelinePerson | null | undefined, raw: string) =>
  !!person &&
  [person.userId, person.email, person.username, person.displayName].some((id) => sameId(id, raw));

/** 'jan.thewes@example.com' → 'Jan Thewes' (members carry no name field). */
function nameFromEmail(email: string): string {
  const local = email.split('@')[0] ?? email;
  return local
    .split(/[._+-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Readable actor for a sentence: "you" for the signed-in user, a name for a
 * person (the e-mail stays in Details), the agent's name for agents, null for
 * the engine itself.
 */
export function displayActor(
  actor: string | null | undefined,
  ctx: Pick<TimelineContext, 'currentUser' | 'members'> = {},
): string | null {
  const raw = actor?.trim();
  if (!raw || ENGINE_ACTORS.has(raw) || STAGE_INSTANCE_RE.test(raw)) return null;
  if (isPerson(ctx.currentUser, raw)) return 'you';
  const member = ctx.members?.find((m) => isPerson(m, raw));
  const email = member?.email?.trim() || (raw.includes('@') ? raw : null);
  if (email) return nameFromEmail(email);
  if (member) return 'A space member';
  return humanizeSlug(raw.replace(/^aidlc[-_]/, ''));
}

const capitalizeFirst = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** 'intent-statement' → 'Intent statement' (acronyms kept). */
export function sentenceCaseSlug(slug: string): string {
  return humanizeSlug(slug)
    .split(' ')
    .map((word, index) =>
      index === 0 || /^[A-Z0-9/-]{2,}$/.test(word) ? word : word.toLowerCase(),
    )
    .join(' ');
}

// Plan-warning codes emitted by v2.plan.warnings (lambda/shared/v2-execution-plan.js).
// The event carries codes only, so the sentences name no stage.
const PLAN_WARNING_SENTENCES: Record<string, string> = {
  scope_absent_consume:
    'A stage needs an input that nothing in this scope produces; it runs without it.',
  scope_absent_unit_dag:
    'Stages meant to run once per unit run once, because nothing in this scope splits the work into units.',
  dangling_consume: 'A stage needs an input that no stage in this workflow produces.',
  starved_consume: 'A stage needs an input whose producer is not selected to run.',
  no_unit_dag_producer:
    'Stages meant to run once per unit have no earlier stage that splits the work into units.',
  zero_scope_placement: 'A stage is not in any scope, so it never runs.',
};

function planWarningSentences(codes: string | undefined): string | null {
  const list = (codes ?? '')
    .split(/,\s*/)
    .map((code) => code.trim().toLowerCase())
    .filter(Boolean);
  if (!list.length || list.some((code) => !PLAN_WARNING_SENTENCES[code])) return null;
  return [...new Set(list)].map((code) => PLAN_WARNING_SENTENCES[code]).join(' ');
}

/** A summary that opens with the actor's raw id/e-mail, re-headed with their name. */
function personalized(event: IntentActivityEvent, summary: string, ctx: TimelineContext): string {
  const actor = event.actor?.trim();
  const who = displayActor(actor, ctx);
  if (!actor || !who || !summary.startsWith(actor)) return summary;
  return capitalizeFirst(`${who}${summary.slice(actor.length)}`);
}

function stageLabel(
  event: IntentActivityEvent,
  ctx: TimelineContext,
  stageId: string | null,
): string | null {
  if (event.stageInstanceId) {
    const name = ctx.stageNameOf(event.stageInstanceId);
    if (name && name !== event.stageInstanceId) return displayStageName(name);
  }
  if (stageId) return displayStageName(stageId);
  return null;
}

function stageIdFromSummary(summary: string | null): string | null {
  const match = /^Stage ([\w.-]+)\b/.exec(summary ?? '');
  return match ? match[1] : null;
}

function repoNames(summary: string): string[] {
  const names: string[] = [];
  for (const match of summary.matchAll(REPO_AT_SHA_RE)) {
    if (!names.includes(match[2])) names.push(match[2]);
  }
  return names;
}

function repoTarget(summary: string, fallback: string): string {
  const repos = repoNames(summary);
  if (repos.length === 1) return repos[0];
  if (repos.length > 1) return `${repos.length} repositories`;
  const slash = /\b[\w.-]+\/([\w.-]+)(?=[\s:(,]|$)/.exec(summary.replace(BRANCH_RE, ''));
  return slash ? slash[1] : fallback;
}

function count(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

export function pluralizeCounts(text: string): string {
  return text.replace(
    /(\d+) ((?:[A-Za-z-]+ ){0,2}[A-Za-z-]+)\(s\)/g,
    (_, n: string, words: string) => (n === '1' ? `1 ${words}` : `${n} ${words}s`),
  );
}

function unitsAndWaves(summary: string): string | null {
  const units = /(\d+) unit\(s\)/.exec(summary)?.[1];
  const waves = /(\d+) wave\(s\)/.exec(summary)?.[1];
  const parts = [
    units ? count(Number(units), 'unit') : null,
    waves ? count(Number(waves), 'wave') : null,
  ].filter(Boolean);
  return parts.length ? parts.join(' in ') : null;
}

function firstLine(text: string): string {
  return text.split(/\r?\n/)[0]?.trim() ?? '';
}

export function boundedExcerpt(text: string | null | undefined, limit = EXCERPT_LIMIT): string {
  const clean = (text ?? '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/^\|?[\s:|-]+\|[\s:|-]*$/gm, '')
    .replace(/\n{2,}/g, '\n')
    .trim();
  return clean.length > limit ? `${clean.slice(0, limit).trimEnd()}…` : clean;
}

function isCleanSummary(summary: string): boolean {
  if (!summary || summary.length > CLEAN_SUMMARY_LIMIT) return false;
  if (/\n/.test(summary)) return false;
  return !(
    UUID_RE.test(summary) ||
    SHA_RE.test(summary) ||
    BRANCH_RE.test(summary) ||
    PATH_RE.test(summary) ||
    STAGE_INSTANCE_RE.test(summary)
  );
}

function sanitizedExcerpt(summary: string): string | null {
  const line = pluralizeCounts(firstLine(summary))
    .replace(REPO_AT_SHA_RE, '$1$2')
    .replace(new RegExp(BRANCH_RE.source, 'g'), 'the intent branch')
    .replace(new RegExp(UUID_RE.source, 'gi'), '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return line ? boundedExcerpt(line, 160) : null;
}

function humanizeType(type: string): string {
  const parts = type.replace(/^v2\./, '').split('.');
  if (parts.length === 1) return humanizeSlug(parts[0]);
  const familyWords = humanizeSlug(parts[0]);
  const family = familyWords.charAt(0) + familyWords.slice(1).toLowerCase();
  const outcome = humanizeSlug(parts.slice(1).join(' ')).toLowerCase();
  if (parts[0] === 'stage') return `Stage ${outcome}`;
  return `${family}: ${outcome}`;
}

function releaseTone(type: string): TimelineTone | null {
  if (!RELEASE_EVENT_FAMILIES.some((family) => type.startsWith(family))) return null;
  if (RELEASE_OUTCOME_FAILED.test(type)) return 'error';
  if (RELEASE_OUTCOME_ATTENTION.test(type)) return 'waiting';
  return 'success';
}

export function timelineTone(event: IntentActivityEvent): TimelineTone {
  const { type } = event;
  if (type === 'v2.sensor.gate' && /\b0 flagged\b/.test(event.summary ?? '')) return 'success';
  if (type === 'v2.execution.failed' || type === 'v2.stage.failed') return 'error';
  if (type === 'v2.execution.succeeded' || type === 'v2.stage.succeeded') return 'success';
  if (type === 'v2.stage.validated' || type === 'v2.question.answered') return 'success';
  if (type.startsWith('v2.artifact.')) return 'success';
  if (type === 'v2.question.asked' || type === 'v2.stage.parked') return 'waiting';
  if (type === 'v2.sensor.flagged') return 'waiting';
  if (type === 'v2.stage.resumed' || type === 'v2.stage.running') return 'running';
  if (type === 'v2.stage.resuming' || type === 'v2.workspace.restoring') return 'running';
  if (type === 'v2.review.running' || type === 'v2.conflict.resolving') return 'running';
  if (type === 'v2.pr.opened' || type === 'v2.pr.recorded') return 'success';
  if (type === 'v2.git.pushed' || type === 'v2.git.merged' || type === 'v2.conflict.resolved') {
    return 'success';
  }
  if (type === 'v2.unit.merged' || type === 'v2.unit.reconciled') return 'success';
  if (
    type === 'v2.tracker.commented' ||
    type === 'v2.tracker.merged_commented' ||
    type === 'v2.tracker.closed'
  ) {
    return 'success';
  }
  if (type === 'v2.tracker.failed') return 'error';
  if (type === 'v2.tracker.blocked') return 'waiting';
  if (type === 'v2.pr.failed' || type === 'v2.pr.record_failed') return 'error';
  if (type === 'v2.pr.skipped') return 'waiting';
  if (type.startsWith('v2.workspace.')) return 'workspace';
  if (type === 'v2.gate.resume_failed') return 'waiting';
  if (type === 'v2.unit.conflict' || type === 'v2.unit.blocked') return 'waiting';
  if (/\.(failed|record_failed|merge_failed|push_failed)$/.test(type)) return 'error';
  if (type === 'v2.review.not_ready' || type === 'v2.review.inconclusive') return 'waiting';
  if (type === 'v2.review.ready') return 'success';
  return releaseTone(type) ?? 'neutral';
}

function technicalItems(event: IntentActivityEvent): TimelineTechnicalItem[] {
  const items: TimelineTechnicalItem[] = [
    { label: 'Event type', value: event.type, copy: true },
    { label: 'Event id', value: event.eventId, copy: true },
  ];
  if (event.summary) items.push({ label: 'Summary', value: event.summary, copy: true });
  if (event.actor) items.push({ label: 'Actor', value: event.actor });
  if (event.stageInstanceId) {
    items.push({ label: 'Stage instance', value: event.stageInstanceId, copy: true });
  }
  if (event.unitSlug) items.push({ label: 'Unit', value: event.unitSlug });
  if (event.humanTaskId) items.push({ label: 'Question id', value: event.humanTaskId, copy: true });
  items.push({ label: 'Recorded at', value: formatAbsolute(event.timestamp) });
  items.push({ label: 'Timestamp', value: event.timestamp, copy: true });
  return items;
}

function dissentRoundSuffix(event: IntentActivityEvent): string {
  if (event.type !== 'v2.persona.dissent') return '';
  const round = event.detail?.round;
  if (typeof round !== 'number' || !Number.isFinite(round) || round < 1) return '';
  const max = event.detail?.maxRounds;
  return typeof max === 'number' && Number.isFinite(max) && max >= round
    ? ` (round ${round}/${max})`
    : ` (round ${round})`;
}

function describeCore(
  event: IntentActivityEvent,
  ctx: TimelineContext,
): Omit<TimelineEventDescription, 'technical' | 'tone'> & { tone?: TimelineTone } {
  const { type } = event;
  const summary = event.summary ?? '';
  const stageId =
    stageIdFromSummary(summary) ??
    (type === 'v2.stage.failed' ? (describeFailure(undefined, summary).stageId ?? null) : null);
  const base = { excerpt: null, groupKey: null, runLevel: false, stageId };
  const named = stageLabel(event, ctx, stageId);
  const stage = (verb: string) => (named ? `Stage ${named} ${verb}` : `A stage ${verb}`);
  const actorName = (raw = event.actor) => displayActor(raw, ctx);

  if (type in AGENT_NOTE_TYPES) {
    return {
      ...base,
      label: AGENT_NOTE_TYPES[type],
      excerpt: boundedExcerpt(summary) || null,
      category: 'note',
    };
  }

  if (type === 'v2.artifact.edited') {
    const match =
      /^.*? edited "(.+)"(?: — (\d+) downstream artifact\(s\) marked possibly stale)?$/.exec(
        summary,
      );
    const who = actorName();
    if (match && who) {
      const stale = match[2] ? Number(match[2]) : 0;
      return {
        ...base,
        label: `${capitalizeFirst(who)} edited ${match[1]}`,
        excerpt: stale ? `${count(stale, 'downstream document')} may be out of date` : null,
        category: 'document',
      };
    }
  }

  switch (type) {
    case 'v2.stage.running':
    case 'v2.stage.started':
      return { ...base, label: stage('started'), category: 'stage' };
    case 'v2.stage.succeeded':
      return { ...base, label: stage('completed'), category: 'stage' };
    case 'v2.stage.validated':
      return { ...base, label: stage('approved'), category: 'stage' };
    case 'v2.stage.parked':
      return {
        ...base,
        label: stage('is waiting for your answer'),
        category: 'question',
      };
    case 'v2.stage.skipped':
      return { ...base, label: stage('skipped'), category: 'stage' };
    case 'v2.stage.resumed':
      return { ...base, label: stage('resumed'), category: 'stage', groupKey: 'resume' };
    case 'v2.stage.resuming':
      return { ...base, label: 'Resuming agent session', category: 'stage', groupKey: 'resume' };
    case 'v2.workspace.restoring':
      return { ...base, label: 'Restoring workspace', category: 'stage', groupKey: 'resume' };
    case 'v2.stage.reset':
      return {
        ...base,
        label: stage('reset for retry'),
        category: 'run',
        groupKey: 'stage-reset',
        runLevel: true,
      };
    case 'v2.stage.failed':
      return {
        ...base,
        label: stage('failed'),
        excerpt: failureSentence(undefined, summary),
        category: 'error',
      };
    case 'v2.execution.failed': {
      const failure = describeFailure(undefined, summary);
      const where = failure.stageId ? ` in ${displayStageName(failure.stageId)}` : '';
      return {
        ...base,
        label: `Run failed${where}`,
        excerpt: failureSentence(undefined, summary),
        category: 'error',
        runLevel: true,
      };
    }
    case 'v2.execution.succeeded':
      return { ...base, label: 'Run completed', category: 'run', runLevel: true };
    case 'v2.execution.cancelled': {
      const who = actorName();
      return {
        ...base,
        label: who ? `Run cancelled by ${who}` : 'Run cancelled',
        category: 'run',
        runLevel: true,
      };
    }
    case 'v2.execution.recomposed': {
      const match =
        /recomposed the run \((\d+) of (\d+) stages?, scope label "([^"]+)"\)(?: — relaunching at ([\w.-]+))?/.exec(
          summary,
        );
      const who = actorName();
      const from = match?.[4] ? ` from ${displayStageName(match[4])}` : '';
      return {
        ...base,
        label: `${who ? capitalizeFirst(who) : 'Someone'} reshaped the run${from}`,
        excerpt: match
          ? `${match[1]} of ${match[2]} stages · ${humanizeSlug(match[3])} scope`
          : sanitizedExcerpt(personalized(event, summary, ctx)),
        category: 'run',
        runLevel: true,
      };
    }
    case 'v2.compose.completed': {
      const proposed = summary
        .replace(/^Deterministic keyword match/, 'Keyword match')
        .replace(/scope "([^"]+)"/, (_m, scope: string) => `the ${humanizeSlug(scope)} scope`)
        .replace(/a custom grid \("[^"]*"\)/, 'a custom plan');
      return {
        ...base,
        label: isCleanSummary(proposed) ? proposed : 'Composer proposed a plan',
        category: 'run',
      };
    }
    case 'v2.execution.rewound': {
      const from = /from ([\w.-]+)/.exec(summary)?.[1];
      const stages = /(\d+) stage instance\(s\) reset/.exec(summary)?.[1];
      const docs = /(\d+) artifact\(s\) superseded/.exec(summary)?.[1];
      const parts = [
        stages ? `${stages} stages reset` : null,
        docs ? `${docs} documents superseded` : null,
      ].filter(Boolean);
      return {
        ...base,
        label: from ? `Run retried from ${displayStageName(from)}` : 'Run retried',
        excerpt: parts.length ? parts.join(', ') : null,
        category: 'run',
        runLevel: true,
      };
    }
    case 'v2.question.asked': {
      const n = Number(/(\d+) question/.exec(summary)?.[1] ?? 1);
      return { ...base, label: `Agent asked ${count(n, 'question')}`, category: 'question' };
    }
    case 'v2.question.answered': {
      const answeredBy = event.answeredBy ?? event.actor;
      const who =
        actorName(answeredBy) === 'you'
          ? 'you'
          : event.answeredByName?.trim() || actorName(answeredBy);
      return {
        ...base,
        label: who ? `${capitalizeFirst(who)} answered` : 'Question answered',
        category: 'question',
      };
    }
    case 'v2.artifact.created': {
      const title = summary.replace(/^Artifact created:\s*/i, '').trim();
      return {
        ...base,
        label: title ? `Document created: ${title}` : 'Document created',
        category: 'document',
        groupKey: 'documents-created',
      };
    }
    case 'v2.artifact.edited':
    case 'v2.artifact.updated':
    case 'v2.artifact.repaired':
    case 'v2.artifact.stamped':
    case 'v2.artifact.verified': {
      const title = summary.replace(/^Artifact \w+:\s*/i, '').trim();
      const verb = humanizeSlug(type.split('.').pop() ?? 'updated').toLowerCase();
      return {
        ...base,
        label: title ? `Document ${verb}: ${title}` : `Document ${verb}`,
        category: 'document',
        groupKey: 'documents-updated',
      };
    }
    case 'v2.derive.completed':
    case 'v2.derive.partial':
    case 'v2.derive.enrichment_skipped':
      return { ...base, label: 'Knowledge graph updated', category: 'other', groupKey: 'graph' };
    case 'v2.derive.failed':
      return { ...base, label: 'Knowledge graph update failed', category: 'error' };
    case 'v2.sensor.flagged': {
      const match = /^Sensor ([\w.-]+) \((\w+)\)/.exec(summary);
      const name = match ? humanizeSlug(match[1]) : 'check';
      const mode = match?.[2]?.toLowerCase();
      if (mode === 'advisory') {
        return {
          ...base,
          label: `Advisory check flagged: ${name}`,
          category: 'review',
          groupKey: 'advisory-sensor',
        };
      }
      return {
        ...base,
        label: `${mode === 'blocking' ? 'Blocking' : 'Required'} check flagged: ${name}`,
        category: 'review',
      };
    }
    case 'v2.sensor.gate':
      return {
        ...base,
        label: 'Gate sensors',
        excerpt: boundedExcerpt(summary) || null,
        category: 'review',
      };
    case 'v2.review.running': {
      const who = actorName();
      return {
        ...base,
        label:
          who === 'you' ? 'You are reviewing' : who ? `${who} is reviewing` : 'Review in progress',
        category: 'review',
        groupKey: 'review-running',
      };
    }
    case 'v2.review.ready':
    case 'v2.review.not_ready':
    case 'v2.review.inconclusive':
    case 'v2.review.failed': {
      const who = actorName() ?? 'Reviewer';
      const outcome =
        type === 'v2.review.ready'
          ? 'ready'
          : type === 'v2.review.not_ready'
            ? 'changes needed'
            : type === 'v2.review.inconclusive'
              ? 'inconclusive'
              : 'failed';
      return {
        ...base,
        label: `${who === 'you' ? 'Your' : who} review: ${outcome}`,
        category: type === 'v2.review.failed' ? 'error' : 'review',
      };
    }
    case 'v2.review.advisory':
      return {
        ...base,
        label: 'Advisory review',
        excerpt: boundedExcerpt(summary) || null,
        category: 'review',
      };
    case 'v2.git.pushed':
      return {
        ...base,
        label: `Work pushed to ${repoTarget(summary, 'the repository')}`,
        category: 'delivery',
      };
    case 'v2.git.push_failed':
      return {
        ...base,
        label: `Push to ${repoTarget(summary, 'the repository')} failed`,
        excerpt: failureSentence('push_failed', summary),
        category: 'error',
      };
    case 'v2.git.merged': {
      const repos = repoNames(summary);
      const unit = event.unitSlug ? `Unit ${unitName(ctx, event.unitSlug)}` : 'Work';
      const suffix = repos.length ? ` (${count(repos.length, 'repository', 'repositories')})` : '';
      return {
        ...base,
        label: `${unit} merged into the intent branch${suffix}`,
        category: 'delivery',
      };
    }
    case 'v2.git.merge_failed': {
      const repo = /failed: ([\w.-]+\/)?([\w.-]+) conflicts/.exec(summary)?.[2];
      return {
        ...base,
        label: repo ? `Merge failed: conflicts in ${repo}` : 'Merge failed',
        category: 'error',
      };
    }
    case 'v2.unit.conflict':
      return {
        ...base,
        label: event.unitSlug
          ? `Unit ${unitName(ctx, event.unitSlug)} has merge conflicts`
          : 'Unit has merge conflicts',
        category: 'delivery',
      };
    case 'v2.conflict.resolving':
      return {
        ...base,
        label: event.unitSlug
          ? `Resolving conflicts for unit ${unitName(ctx, event.unitSlug)}`
          : 'Resolving conflicts',
        category: 'delivery',
      };
    case 'v2.conflict.resolved':
      return {
        ...base,
        label: event.unitSlug
          ? `Conflicts resolved for unit ${unitName(ctx, event.unitSlug)}`
          : 'Conflicts resolved',
        category: 'delivery',
      };
    case 'v2.conflict.unresolved':
      return {
        ...base,
        label: event.unitSlug
          ? `Conflicts unresolved for unit ${unitName(ctx, event.unitSlug)}`
          : 'Conflicts unresolved',
        category: 'error',
      };
    case 'v2.pr.opened':
    case 'v2.pr.recorded': {
      const n = /#(\d+)/.exec(summary)?.[1];
      return {
        ...base,
        label: n
          ? `PR #${n} ${type === 'v2.pr.opened' ? 'opened' : 'recorded'}`
          : 'Pull request opened',
        category: 'delivery',
      };
    }
    case 'v2.pr.failed':
    case 'v2.pr.record_failed':
      return {
        ...base,
        label: 'Pull request could not be opened',
        excerpt: sanitizedExcerpt(summary),
        category: 'error',
      };
    case 'v2.pr.skipped': {
      const repo = skippedRepo(summary);
      return {
        ...base,
        label: repo ? `Pull request skipped for ${repo}` : 'Pull request skipped',
        excerpt: sanitizedExcerpt(capitalizeFirst(summary.replace(/^No PR for [\w./-]+:\s*/, ''))),
        category: 'delivery',
        groupKey: 'pr-skipped',
      };
    }
    case 'v2.unit.started':
      return {
        ...base,
        label: event.unitSlug ? `Unit ${unitName(ctx, event.unitSlug)} started` : 'Unit started',
        category: 'stage',
      };
    case 'v2.unit.lane_ready':
      return {
        ...base,
        label: event.unitSlug
          ? `Workspace ready for unit ${unitName(ctx, event.unitSlug)}`
          : 'Unit workspace ready',
        category: 'workspace',
      };
    case 'v2.unit.merged':
      return {
        ...base,
        label: event.unitSlug ? `Unit ${unitName(ctx, event.unitSlug)} merged` : 'Unit merged',
        category: 'delivery',
      };
    case 'v2.unit.failed':
      return {
        ...base,
        label: event.unitSlug ? `Unit ${unitName(ctx, event.unitSlug)} failed` : 'Unit failed',
        excerpt: sanitizedExcerpt(summary),
        category: 'error',
      };
    case 'v2.unit.blocked':
      return {
        ...base,
        label: event.unitSlug ? `Unit ${unitName(ctx, event.unitSlug)} blocked` : 'Unit blocked',
        excerpt: sanitizedExcerpt(summary),
        category: 'delivery',
      };
    case 'v2.workspace.initializing': {
      const repos = /(\d+) repo/.exec(summary)?.[1];
      return {
        ...base,
        label: repos
          ? `Preparing workspace (${count(Number(repos), 'repository', 'repositories')})`
          : 'Preparing workspace',
        category: 'workspace',
        groupKey: 'workspace',
        runLevel: !event.stageInstanceId,
      };
    }
    case 'v2.workspace.initialized':
      return {
        ...base,
        label: 'Workspace ready',
        category: 'workspace',
        groupKey: 'workspace',
        runLevel: !event.stageInstanceId,
      };
    case 'v2.workspace.restored':
      return { ...base, label: 'Workspace restored', category: 'workspace', groupKey: 'resume' };
    case 'v2.units.fanout_approved': {
      const section = /section (\d+)/.exec(summary)?.[1];
      return {
        ...base,
        label: section ? `Fan-out approved for section ${section}` : 'Fan-out approved',
        excerpt: sanitizedExcerpt(summary.replace(/^Fan-out approved for section \d+:\s*/, '')),
        category: 'stage',
      };
    }
    case 'v2.units.section_started': {
      const section = /^Section (\d+)/.exec(summary)?.[1];
      return {
        ...base,
        label: section ? `Section ${section} started` : 'Section started',
        excerpt: unitsAndWaves(summary),
        category: 'stage',
      };
    }
    case 'v2.units.plan_ready':
    case 'v2.units.promoted':
      return {
        ...base,
        label: type === 'v2.units.plan_ready' ? 'Unit plan ready' : 'Unit plan promoted',
        excerpt: unitsAndWaves(summary),
        category: 'stage',
      };
    case 'v2.units.autonomy_set': {
      const mode = /:\s*([a-z-]+)\s*$/i.exec(summary)?.[1];
      return {
        ...base,
        label: mode ? `Construction autonomy set to ${mode}` : 'Construction autonomy set',
        category: 'run',
      };
    }
    case 'v2.units.skeleton_approved':
      return {
        ...base,
        label: event.unitSlug
          ? `Walking skeleton ${unitName(ctx, event.unitSlug)} approved`
          : 'Walking skeleton approved',
        category: 'stage',
      };
    case 'v2.units.fan_in': {
      const section = /^Section (\d+)/.exec(summary)?.[1];
      const merged = /(\d+)\/(\d+) unit/.exec(summary);
      return {
        ...base,
        label: section ? `Section ${section} complete` : 'Section complete',
        excerpt: merged ? `${merged[1]} of ${merged[2]} units merged` : null,
        category: 'stage',
      };
    }
    case 'v2.plan.warnings': {
      const [head, codes] = summary.split(/:\s*/, 2);
      return {
        ...base,
        label: pluralizeCounts(head || 'Plan resolved with warnings'),
        excerpt: planWarningSentences(codes),
        category: 'review',
      };
    }
    case 'v2.tracker.closed':
    case 'v2.tracker.commented':
    case 'v2.tracker.merged_commented':
    case 'v2.tracker.failed':
    case 'v2.tracker.blocked':
      return {
        ...base,
        label: isCleanSummary(summary) ? summary : humanizeType(type),
        excerpt: isCleanSummary(summary) ? null : sanitizedExcerpt(summary),
        category: type === 'v2.tracker.failed' ? 'error' : 'delivery',
      };
    default:
      break;
  }

  if (type.startsWith('v2.persona.')) {
    const who = actorName();
    const role = `${PERSONA_LABELS[type] ?? 'Persona session'}${dissentRoundSuffix(event)}`;
    return {
      ...base,
      label: who ? `${role} — ${who}` : role,
      excerpt: boundedExcerpt(summary) || null,
      category: type === 'v2.persona.question_withdrawn' ? 'question' : 'review',
    };
  }

  const tone = timelineTone(event);
  const category: TimelineCategory =
    tone === 'error' ? 'error' : type.startsWith('v2.gate.') ? 'question' : 'other';
  const readable = personalized(event, summary, ctx);
  if (isCleanSummary(readable)) return { ...base, label: pluralizeCounts(readable), category };
  return {
    ...base,
    label: humanizeType(type),
    excerpt: readable ? sanitizedExcerpt(readable) : null,
    category,
  };
}

function skippedRepo(summary: string | null | undefined): string | null {
  return /^No PR for (?:[\w.-]+\/)?([\w.-]+):/.exec(summary ?? '')?.[1] ?? null;
}

export function describeTimelineEvent(
  event: IntentActivityEvent,
  ctx: TimelineContext,
): TimelineEventDescription {
  const core = describeCore(event, ctx);
  const tone = core.category === 'error' ? 'error' : timelineTone(event);
  const neverGroup =
    event.type !== 'v2.pr.skipped' &&
    NEVER_GROUP_FAMILIES.some((family) => event.type.startsWith(family));
  const groupKey = neverGroup || core.category === 'error' ? null : core.groupKey;
  return { ...core, tone, groupKey, technical: technicalItems(event) };
}

interface PendingEntry {
  described: TimelineEventDescription[];
  events: IntentActivityEvent[];
}

function listOf(items: string[]): string {
  const shown = items.slice(0, 3).join(', ');
  return items.length > 3 ? `${shown} and ${items.length - 3} more` : shown;
}

function groupedLabel(
  groupKey: string,
  described: TimelineEventDescription[],
  events: IntentActivityEvent[],
): { label: string; excerpt: string | null } {
  const n = events.length;
  const last = described[described.length - 1];
  switch (groupKey) {
    case 'documents-created':
      return {
        label: `${n} documents created`,
        excerpt: listOf(described.map((d) => d.label.replace(/^Document created:\s*/, ''))),
      };
    case 'documents-updated':
      return {
        label: `${n} documents updated`,
        excerpt: listOf(described.map((d) => d.label.replace(/^Document \w+:\s*/, ''))),
      };
    case 'graph':
      return { label: `Knowledge graph updated ${n} times`, excerpt: null };
    case 'advisory-sensor':
      return {
        label: `${n} advisory checks flagged`,
        excerpt: listOf([
          ...new Set(described.map((d) => d.label.replace(/^Advisory check flagged:\s*/, ''))),
        ]),
      };
    case 'stage-reset':
      return {
        label: `${n} stages reset for retry`,
        excerpt: listOf(
          described.map((d) => d.label.replace(/^Stage (.*) reset for retry$/, '$1')),
        ),
      };
    case 'review-running':
      return { label: `Review in progress (${count(n, 'round')})`, excerpt: null };
    case 'pr-skipped': {
      const repos = [...new Set(events.map((e) => skippedRepo(e.summary)).filter(Boolean))];
      const noChanges = events.every((e) => /no changes/i.test(e.summary ?? ''));
      const what = repos.length
        ? count(repos.length, 'repository', 'repositories')
        : count(n, 'pull request');
      return {
        label: noChanges ? `${what} skipped — no changes` : `${what} skipped`,
        excerpt: repos.length ? (repos as string[]).join(', ') : null,
      };
    }
    default:
      return { label: last.label, excerpt: last.excerpt };
  }
}

function flush(pending: PendingEntry, groupKey: string | null): TimelineEntry {
  const { described, events } = pending;
  const last = events[events.length - 1];
  const lastDescribed = described[described.length - 1];
  if (events.length === 1 || !groupKey) {
    return {
      key: last.eventId,
      label: lastDescribed.label,
      excerpt: lastDescribed.excerpt,
      tone: lastDescribed.tone,
      category: lastDescribed.category,
      timestamp: last.timestamp,
      events,
      grouped: false,
      technical: lastDescribed.technical,
    };
  }
  const { label, excerpt } = groupedLabel(groupKey, described, events);
  const technical: TimelineTechnicalItem[] = [
    { label: 'Events', value: String(events.length) },
    { label: 'Event types', value: [...new Set(events.map((e) => e.type))].join(', ') },
    { label: 'Event ids', value: events.map((e) => e.eventId).join(', '), copy: true },
    { label: 'Summaries', value: events.map((e) => e.summary ?? '').join('\n'), copy: true },
    { label: 'From', value: formatAbsolute(events[0].timestamp) },
    { label: 'To', value: formatAbsolute(last.timestamp) },
  ];
  return {
    key: `${events[0].eventId}+${events.length}`,
    label,
    excerpt,
    tone: lastDescribed.tone,
    category: lastDescribed.category,
    timestamp: last.timestamp,
    events,
    grouped: true,
    technical,
  };
}

function matchesFilter(entry: TimelineEntry, filter: TimelineFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'questions') return entry.category === 'question';
  if (filter === 'documents') return entry.category === 'document';
  return entry.category === 'error';
}

function countEntries(entries: TimelineEntry[]): TimelineGroup['counts'] {
  return {
    questions: entries.filter((e) => matchesFilter(e, 'questions')).length,
    documents: entries.filter((e) => matchesFilter(e, 'documents')).length,
    errors: entries.filter((e) => matchesFilter(e, 'errors')).length,
  };
}

interface Bucket {
  key: string;
  kind: TimelineGroup['kind'];
  stageInstanceId: string | null;
  unitSlug: string | null;
  stageIdHint: string | null;
}

function bucketFor(
  event: IntentActivityEvent,
  described: TimelineEventDescription,
  lastInstanceByStageId: Map<string, string>,
  ctx: TimelineContext,
): Bucket {
  const nameable = (instance: string, hint: string | null) => {
    const resolved = ctx.stageNameOf(instance);
    return Boolean((resolved && resolved !== instance) || hint);
  };
  const row = event.stageInstanceId
    ? ctx.stages?.find((s) => s.stageInstanceId === event.stageInstanceId)
    : undefined;
  if (
    !described.runLevel &&
    event.stageInstanceId &&
    nameable(event.stageInstanceId, row?.stageId ?? described.stageId)
  ) {
    return {
      key: `stage:${event.stageInstanceId}`,
      kind: 'stage',
      stageInstanceId: event.stageInstanceId,
      unitSlug: row?.unitSlug ?? event.unitSlug ?? null,
      stageIdHint: row?.stageId ?? described.stageId,
    };
  }
  if (!described.runLevel && described.stageId) {
    const instance = lastInstanceByStageId.get(described.stageId);
    if (instance) {
      const instanceRow = ctx.stages?.find((s) => s.stageInstanceId === instance);
      return {
        key: `stage:${instance}`,
        kind: 'stage',
        stageInstanceId: instance,
        unitSlug: instanceRow?.unitSlug ?? null,
        stageIdHint: described.stageId,
      };
    }
  }
  if (!described.runLevel && event.unitSlug) {
    return {
      key: `unit:${event.unitSlug}`,
      kind: 'unit',
      stageInstanceId: null,
      unitSlug: event.unitSlug,
      stageIdHint: null,
    };
  }
  return { key: 'run', kind: 'run', stageInstanceId: null, unitSlug: null, stageIdHint: null };
}

function groupTitle(bucket: Bucket, ctx: TimelineContext): string {
  if (bucket.kind === 'run') return 'Run';
  if (bucket.kind === 'unit') return `Unit ${unitName(ctx, bucket.unitSlug ?? '')}`;
  const id = bucket.stageInstanceId as string;
  const resolved = ctx.stageNameOf(id);
  if (resolved && resolved !== id) return displayStageName(resolved);
  return bucket.stageIdHint ? displayStageName(bucket.stageIdHint) : 'Unnamed stage';
}

const RUN_RESET_TYPES = new Set(['v2.execution.rewound', 'v2.execution.recomposed']);

interface Span {
  group: TimelineGroup;
  /** Positions of the group's first and last events in chronological order. */
  first: number;
  last: number;
}

/**
 * A stage seen again folds back into its group when only run-level work or
 * other unit lanes happened in between; when it was reset, re-run under a new
 * instance or ran again after another stage, it is a numbered attempt.
 */
function foldRepeatedStages(
  spans: Span[],
  resets: { run: number[]; byInstance: Map<string, number[]> },
): TimelineGroup[] {
  const out: Span[] = [];
  const lastByStage = new Map<string, Span>();
  for (const span of spans) {
    const { group } = span;
    if (group.kind !== 'stage') {
      out.push(span);
      continue;
    }
    const stageKey = `${group.name}|${group.unitSlug ?? ''}`;
    const prev = lastByStage.get(stageKey);
    if (!prev) {
      out.push(span);
      lastByStage.set(stageKey, span);
      continue;
    }
    const between = (at: number) => at > prev.last && at < span.first;
    const reset =
      resets.run.some(between) ||
      (resets.byInstance.get(group.stageInstanceId ?? '') ?? []).some(between);
    const otherStage = out
      .slice(out.indexOf(prev) + 1)
      .some((s) => s.group.kind === 'stage' && (s.group.unitSlug ?? '') === (group.unitSlug ?? ''));
    if (!reset && !otherStage && prev.group.stageInstanceId === group.stageInstanceId) {
      const entries = [...group.entries, ...prev.group.entries];
      const merged: Span = {
        group: {
          ...prev.group,
          entries,
          latestTimestamp: group.latestTimestamp,
          counts: countEntries(entries),
        },
        first: prev.first,
        last: span.last,
      };
      out.splice(out.indexOf(prev), 1);
      out.push(merged);
      lastByStage.set(stageKey, merged);
      continue;
    }
    const attempt = prev.group.attempt + 1;
    const numbered: Span = {
      ...span,
      group: { ...group, attempt, title: `${group.name} · attempt ${attempt}` },
    };
    out.push(numbered);
    lastByStage.set(stageKey, numbered);
  }
  return out.map((s) => s.group);
}

const isSkippedPullRequest = (entry: TimelineEntry) =>
  entry.events.every((e) => e.type === 'v2.pr.skipped');

/**
 * Delivery interleaves "skipped" with "opened" per repository; all skipped
 * repositories of one group read as a single line at the latest one's place.
 */
function foldSkippedPullRequests(entries: TimelineEntry[]): TimelineEntry[] {
  const skipped = entries.filter(isSkippedPullRequest);
  if (skipped.length < 2) return entries;
  const events = skipped.flatMap((entry) => entry.events);
  const folded = flush({ events, described: events.map(() => skippedDescription) }, 'pr-skipped');
  const lastIndex = entries.lastIndexOf(skipped[skipped.length - 1]);
  return entries.flatMap((entry, index) =>
    index === lastIndex ? [folded] : isSkippedPullRequest(entry) ? [] : [entry],
  );
}

const skippedDescription: TimelineEventDescription = {
  label: 'Pull request skipped',
  excerpt: null,
  tone: 'waiting',
  category: 'delivery',
  groupKey: 'pr-skipped',
  runLevel: false,
  stageId: null,
  technical: [],
};

/**
 * A failed stage the run never recorded a row for is named by the run failure
 * that follows it ("stage_failed: reverse-engineering: …").
 */
function namesFromRunFailures(
  ordered: readonly IntentActivityEvent[],
  ctx: TimelineContext,
): Map<string, string> {
  const names = new Map<string, string>();
  ordered.forEach((event, index) => {
    const instance = event.stageInstanceId;
    if (event.type !== 'v2.stage.failed' || !instance) return;
    const resolved = ctx.stageNameOf(instance);
    if (
      (resolved && resolved !== instance) ||
      ctx.stages?.some((r) => r.stageInstanceId === instance && r.stageId)
    )
      return;
    const runFailure = ordered
      .slice(index + 1)
      .find((later) => later.type === 'v2.execution.failed');
    const stageId = runFailure ? describeFailure(undefined, runFailure.summary).stageId : undefined;
    if (stageId) names.set(instance, stageId);
  });
  return names;
}

export function buildTimeline(
  events: readonly IntentActivityEvent[],
  baseCtx: TimelineContext,
): TimelineGroup[] {
  const ordered = [...events].toSorted((a, b) => a.timestamp.localeCompare(b.timestamp));
  const inferred = namesFromRunFailures(ordered, baseCtx);
  const ctx: TimelineContext = inferred.size
    ? { ...baseCtx, stageNameOf: (key) => inferred.get(key) ?? baseCtx.stageNameOf(key) }
    : baseCtx;
  const stageIdOf = new Map<string, string>();
  for (const row of ctx.stages ?? []) {
    if (row.stageInstanceId && row.stageId) stageIdOf.set(row.stageInstanceId, row.stageId);
  }
  const lastInstanceByStageId = new Map<string, string>();

  const spans: Span[] = [];
  const resets = { run: [] as number[], byInstance: new Map<string, number[]>() };
  let current: {
    bucket: Bucket;
    entries: TimelineEntry[];
    pending: PendingEntry | null;
    pendingKey: string | null;
    first: number;
    last: number;
  } | null = null;

  const flushPending = () => {
    if (current?.pending) {
      current.entries.push(flush(current.pending, current.pendingKey));
      current.pending = null;
      current.pendingKey = null;
    }
  };
  const closeGroup = () => {
    if (!current) return;
    flushPending();
    const entries = foldSkippedPullRequests(current.entries).toReversed();
    spans.push({
      group: {
        key: `${current.bucket.key}:${current.entries[0]?.events[0]?.eventId ?? spans.length}`,
        kind: current.bucket.kind,
        title: groupTitle(current.bucket, ctx),
        name: groupTitle(current.bucket, ctx),
        unitSlug: current.bucket.kind === 'stage' ? current.bucket.unitSlug : null,
        unitName:
          current.bucket.kind === 'stage' && current.bucket.unitSlug
            ? unitName(ctx, current.bucket.unitSlug)
            : null,
        stageInstanceId: current.bucket.stageInstanceId,
        attempt: 1,
        latestTimestamp: entries[0]?.timestamp ?? '',
        entries,
        counts: countEntries(entries),
      },
      first: current.first,
      last: current.last,
    });
    current = null;
  };

  for (const [position, event] of ordered.entries()) {
    if (RUN_RESET_TYPES.has(event.type)) resets.run.push(position);
    if (event.type === 'v2.stage.reset' && event.stageInstanceId) {
      const list = resets.byInstance.get(event.stageInstanceId) ?? [];
      list.push(position);
      resets.byInstance.set(event.stageInstanceId, list);
    }
    if (event.stageInstanceId) {
      const stageId = stageIdOf.get(event.stageInstanceId) ?? stageIdFromSummary(event.summary);
      if (stageId) lastInstanceByStageId.set(stageId, event.stageInstanceId);
    }
    const described = describeTimelineEvent(event, ctx);
    const bucket = bucketFor(event, described, lastInstanceByStageId, ctx);
    if (!current || current.bucket.key !== bucket.key) {
      closeGroup();
      current = {
        bucket,
        entries: [],
        pending: null,
        pendingKey: null,
        first: position,
        last: position,
      };
    }
    current.last = position;
    if (described.groupKey && current.pending && current.pendingKey === described.groupKey) {
      current.pending.described.push(described);
      current.pending.events.push(event);
      continue;
    }
    flushPending();
    current.pending = { described: [described], events: [event] };
    current.pendingKey = described.groupKey;
  }
  closeGroup();
  return foldRepeatedStages(spans, resets).toReversed();
}

export function filterTimeline(groups: TimelineGroup[], filter: TimelineFilter): TimelineGroup[] {
  if (filter === 'all') return groups;
  return groups
    .map((group) => ({ ...group, entries: group.entries.filter((e) => matchesFilter(e, filter)) }))
    .filter((group) => group.entries.length > 0);
}

export function countTimeline(groups: TimelineGroup[]): TimelineGroup['counts'] & { all: number } {
  const all = groups.reduce((sum, g) => sum + g.entries.length, 0);
  return groups.reduce(
    (acc, g) => ({
      all: acc.all,
      questions: acc.questions + g.counts.questions,
      documents: acc.documents + g.counts.documents,
      errors: acc.errors + g.counts.errors,
    }),
    { all, questions: 0, documents: 0, errors: 0 },
  );
}
