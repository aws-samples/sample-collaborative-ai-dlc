import type { Intent } from '@/services/intents';
import { intentAttention } from '@/lib/sprintStatus';
import { deriveIntentStatus, type DerivedIntentStatus } from '@/lib/statusModel';

export type GroupableIntent = Pick<Intent, 'id' | 'status' | 'title' | 'createdAt' | 'updatedAt'> &
  Partial<Pick<Intent, 'completedAt' | 'currentStage' | 'pendingHumanTaskId' | 'resumeRequired'>>;

export type IntentGroup = 'attention' | 'failed' | 'active' | 'draft' | 'finished';

// The space page's one order: what needs someone first (errors, then open
// questions and resumes), then live work, drafts, and finished runs.
const GROUP_RANK: Record<IntentGroup, number> = {
  failed: 0,
  attention: 1,
  active: 2,
  draft: 3,
  finished: 4,
};

export function intentGroup(intent: GroupableIntent, _now: number = Date.now()): IntentGroup {
  const attention = intentAttention(intent);
  if (attention === 'input' || attention === 'resume') return 'attention';
  if (attention === 'failed') return 'failed';
  switch (intent.status) {
    case 'RUNNING':
    case 'CREATED':
    case 'WAITING':
      return 'active';
    case 'DRAFT':
      return 'draft';
    default:
      return 'finished';
  }
}

export const LIVE_STATUSES = new Set<Intent['status']>(['RUNNING', 'CREATED', 'WAITING']);

const time = (value: string | null | undefined) => {
  if (!value) return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
};

export function latestIntentActivity(intent: GroupableIntent): number {
  return Math.max(time(intent.updatedAt), time(intent.completedAt), time(intent.createdAt));
}

/** Group order (GROUP_RANK), newest activity first inside a group. */
export function orderIntents<T extends GroupableIntent>(
  intents: readonly T[],
  now: number = Date.now(),
): T[] {
  return intents.toSorted(
    (a, b) =>
      GROUP_RANK[intentGroup(a, now)] - GROUP_RANK[intentGroup(b, now)] ||
      latestIntentActivity(b) - latestIntentActivity(a) ||
      a.id.localeCompare(b.id),
  );
}

export type SpaceFilter = 'all' | 'active' | 'needs-attention' | 'failed' | 'finished';

export const SPACE_FILTERS: readonly SpaceFilter[] = [
  'all',
  'active',
  'needs-attention',
  'failed',
  'finished',
];

export const SPACE_FILTER_LABELS: Record<SpaceFilter, string> = {
  all: 'All',
  active: 'Active',
  'needs-attention': 'Needs your attention',
  failed: 'Failed',
  finished: 'Finished',
};

/** The space page's address keeps the filter under this search parameter. */
export const SPACE_FILTER_PARAM = 'filter';

export function parseSpaceFilter(value: string | null | undefined): SpaceFilter {
  return SPACE_FILTERS.includes(value as SpaceFilter) ? (value as SpaceFilter) : 'all';
}

/**
 * A human must act: answer, resume, deal with a failure, or unstick a stalled
 * run. Pass the `status` the row's pill shows (useIntentStatusReader) so
 * "stalled" agrees with it; without it the intent's own timestamps decide.
 */
export function needsAttention(
  intent: GroupableIntent,
  now: number = Date.now(),
  status: DerivedIntentStatus = deriveIntentStatus(intent, { now }),
): boolean {
  const group = intentGroup(intent, now);
  if (group === 'attention' || group === 'failed') return true;
  return status.stalled;
}

export function matchesSpaceFilter(
  intent: GroupableIntent,
  filter: SpaceFilter,
  now: number = Date.now(),
  status?: DerivedIntentStatus,
): boolean {
  const group = intentGroup(intent, now);
  switch (filter) {
    case 'all':
      return true;
    case 'active':
      return group === 'attention' || group === 'active';
    case 'needs-attention':
      return needsAttention(intent, now, status);
    case 'failed':
      return group === 'failed';
    case 'finished':
      return group === 'finished';
  }
}

const PLACEHOLDER_TITLES = new Set(['title', 'untitled', 'i want to do xyz']);

export function isUntitledIntent(title: string | null | undefined): boolean {
  const trimmed = (title ?? '').trim();
  return trimmed === '' || PLACEHOLDER_TITLES.has(trimmed.toLowerCase());
}

export function matchesIntentQuery(intent: GroupableIntent, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return (intent.title ?? '').toLowerCase().includes(needle) || intent.id === needle;
}
