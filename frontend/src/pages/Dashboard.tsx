import { Inbox } from 'lucide-react';
import { Link } from 'react-router';
import { useMemo, useState } from 'react';
import {
  useProjectsCache,
  type ProjectIntentSummary,
  type ProjectWithSprint,
} from '@/hooks/useProjectsCache';
import type { Intent, IntentDetail } from '@/services/intents';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert } from '@/components/ui/alert';
import { EmptyState, ErrorState } from '@/components/ui/empty-state';
import { StatusPill } from '@/components/ui/status-pill';
import { cn } from '@/lib/utils';
import { getBranding } from '@/lib/branding';
import {
  deriveIntentStatus,
  useIntentStatus,
  useIntentStatusReader,
  type ResolvedIntentStatus,
} from '@/lib/statusModel';
import { intentAttention } from '@/lib/sprintStatus';
import { intentEntryPath } from '@/lib/intentEntry';
import { qk } from '@/lib/queryKeys';
import { intentSectionPath } from '@/lib/intentSectionPreference';
import { intentRowMetaText } from '@/components/space/intentRowMeta';
import { useQueryData } from '@/hooks/useQueryData';
import { useOfferIdleCandidates } from '@/hooks/useIdleNext';
import { spacesHomePath, usePanelsInline } from '@/hooks/usePanelsInline';

const INBOX_CAP = 5;
const INBOX_CAP_NARROW = 3;
const INBOX_EXPANDED_KEY = 'aidlc.spaces.inboxExpanded';

type InboxKind = 'input' | 'resume' | 'failed' | 'stalled';

interface InboxItem {
  kind: InboxKind;
  project: ProjectWithSprint['project'];
  intent: ProjectIntentSummary;
  status: ReturnType<typeof deriveIntentStatus>;
  since: string | null;
}

function inboxSince(intent: ProjectIntentSummary, derived: ReturnType<typeof deriveIntentStatus>) {
  return derived.since ?? intent.updatedAt ?? intent.completedAt ?? intent.createdAt ?? null;
}

const sinceMs = (t: string | null) => (t ? new Date(t).getTime() : Number.POSITIVE_INFINITY);

// What the reader can act on comes first, whatever its age: answer or resume,
// then failures to deal with, then stalled runs to look at.
const INBOX_KIND_RANK: Record<InboxKind, number> = {
  input: 0,
  resume: 0,
  failed: 1,
  stalled: 2,
};
const isAnswerable = (item: InboxItem) => INBOX_KIND_RANK[item.kind] === 0;

function inboxKind({ intent, status }: ResolvedIntentStatus): InboxKind | null {
  const attention = intentAttention(intent);
  if (attention) return attention;
  return status.stalled ? 'stalled' : null;
}

type StatusOf = (projectId: string, intent: ProjectIntentSummary) => ResolvedIntentStatus;

// Membership and order follow the status each row's pill shows (the cached
// detail when current), so a row never sits in the inbox as stalled while its
// pill says the run is progressing.
function deriveInbox(
  projects: readonly ProjectWithSprint[],
  now: number,
  statusOf: StatusOf = (_projectId, intent) => ({
    status: deriveIntentStatus(intent, { now }),
    intent,
  }),
): InboxItem[] {
  const items: InboxItem[] = [];
  for (const p of projects) {
    // A Viewer cannot answer, resume or retry (#777), so the space's intents
    // are not the reader's to act on until the eligibility API (#677/#678) says
    // per item who can.
    if (p.project.userRole === 'viewer') continue;
    for (const intent of p.intents) {
      const resolved = statusOf(p.project.id, intent);
      const { status } = resolved;
      const kind = inboxKind(resolved);
      if (!kind) continue;
      items.push({
        kind,
        project: p.project,
        intent,
        status,
        since: inboxSince(intent, status),
      });
    }
  }
  return items.toSorted(
    (a, b) =>
      INBOX_KIND_RANK[a.kind] - INBOX_KIND_RANK[b.kind] || sinceMs(a.since) - sinceMs(b.since),
  );
}

// Same line as the Space row (one builder), then the space the intent belongs
// to. The stage and failure reason come from the space's intent list the shell
// already loaded; the gate kinds from the detail, once a hover prefetch or a
// Space visit cached it. The inbox itself never reads one detail per row.
function inboxMeta(
  item: InboxItem,
  listed: Intent | undefined,
  detail: IntentDetail | undefined,
  now: number,
): string[] {
  const known = detail?.intent ?? listed;
  const parts = intentRowMetaText(
    {
      ...item.intent,
      currentStage: known?.currentStage ?? null,
      failureReason: known?.failureReason ?? null,
      failure: known?.failure,
    },
    // The derived `since` only: `item.since` also carries the updatedAt
    // fallback that orders the list, which is not the wait's age.
    { now, gates: detail?.gates, since: item.status.since, derived: item.status },
  );
  return [...parts, item.project.name];
}

// Status only: the age is part of the meta line (R5-8).
function InboxPill({ item }: { item: InboxItem }) {
  switch (item.kind) {
    case 'resume':
      return <StatusPill kind="gate" status="resume_required" className="shrink-0" />;
    case 'failed':
      return <StatusPill kind="intent" status="FAILED" className="shrink-0" />;
    default:
      return (
        <StatusPill
          kind="intent"
          status={item.status.key}
          stalled={item.status.stalled}
          className="shrink-0"
        />
      );
  }
}

function InboxRow({ item, now, className }: { item: InboxItem; now: number; className?: string }) {
  const href = intentEntryPath(item.project.id, item.intent);
  const listed = useQueryData<Intent[]>(qk.projectIntents(item.project.id))?.find(
    (intent) => intent.id === item.intent.id,
  );
  const detail = useQueryData<IntentDetail>(qk.intentDetail(item.project.id, item.intent.id));
  // Same derivation as the intent header once its detail is cached (oldest open gate).
  const status = useIntentStatus(item.project.id, item.intent, {
    now,
    fallback: item.status,
  });
  const shown: InboxItem =
    status === item.status ? item : { ...item, status, since: inboxSince(item.intent, status) };
  const meta = inboxMeta(shown, listed, detail, now);
  return (
    <li
      className={cn(
        'group relative flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 hover:bg-accent/50 focus-within:bg-accent/50 sm:flex-nowrap',
        className ?? 'flex',
      )}
    >
      <div className="min-w-0 flex-1 basis-full sm:basis-auto">
        <Link
          to={href}
          className="line-clamp-2 text-sm font-medium after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-ring"
        >
          {item.intent.title || 'Untitled intent'}
        </Link>
        <span data-testid="inbox-row-meta" className="block truncate text-xs text-muted-foreground">
          {meta.map((part, index) => (
            <span key={part}>
              {index > 0 ? <span aria-hidden="true"> · </span> : null}
              {part}
            </span>
          ))}
        </span>
      </div>
      <InboxPill item={shown} />
      {item.kind === 'stalled' && (
        <Button asChild variant="link" size="xs" className="relative z-10 shrink-0 px-0">
          <Link to={intentSectionPath(item.project.id, item.intent.id, 'work')}>View activity</Link>
        </Button>
      )}
    </li>
  );
}

function readInboxExpanded(): boolean {
  try {
    return localStorage.getItem(INBOX_EXPANDED_KEY) === '1';
  } catch {
    return false;
  }
}

function WaitingForYou({ items, now }: { items: InboxItem[]; now: number }) {
  const [showAll, setShowAll] = useState(readInboxExpanded);
  if (items.length === 0) return null;
  const toggle = (next: boolean) => {
    setShowAll(next);
    try {
      if (next) localStorage.setItem(INBOX_EXPANDED_KEY, '1');
      else localStorage.removeItem(INBOX_EXPANDED_KEY);
    } catch {
      // The current visit still honors the choice when storage is unavailable.
    }
  };
  // The caps only ever hide failures and stalled runs: every answerable item
  // (sorted first) stays on the first screen, on a phone too.
  const answerable = items.filter(isAnswerable).length;
  const cap = Math.max(INBOX_CAP, answerable);
  const capNarrow = Math.max(INBOX_CAP_NARROW, answerable);
  const visible = showAll ? items : items.slice(0, cap);
  const collapsible = items.length > capNarrow;
  return (
    <section aria-labelledby="waiting-for-you" className="mb-8">
      <div className="mb-2 flex items-baseline gap-2">
        <h2 id="waiting-for-you" className="text-base font-semibold">
          Needs your attention
        </h2>
        <span className="text-sm tabular-nums text-muted-foreground">{items.length}</span>
      </div>
      <ul className="divide-y overflow-hidden rounded-lg border bg-card text-card-foreground">
        {visible.map((item, index) => (
          <InboxRow
            key={`${item.project.id}:${item.intent.id}`}
            item={item}
            now={now}
            className={!showAll && index >= capNarrow ? 'hidden sm:flex' : undefined}
          />
        ))}
      </ul>
      {collapsible && !showAll && (
        <Button
          variant="link"
          size="sm"
          className={cn('mt-1 px-0', items.length <= cap && 'sm:hidden')}
          onClick={() => toggle(true)}
        >
          Show all ({items.length})
        </Button>
      )}
      {collapsible && showAll && (
        <Button variant="link" size="sm" className="mt-1 px-0" onClick={() => toggle(false)}>
          Show less
        </Button>
      )}
    </section>
  );
}

// Each space's intents load on their own. A space still loading, or whose list
// failed to load, has not been checked: My work must not call itself complete.
function uncheckedSpaces(projects: readonly ProjectWithSprint[]) {
  const v2 = projects.filter((p) => p.project.kind === 'v2');
  return {
    loading: v2.filter((p) => p.activityLoading && !p.activityError),
    failed: v2.filter((p) => p.activityError),
  };
}

function spaceNames(projects: readonly ProjectWithSprint[]): string {
  const names = projects.map((p) => p.project.name);
  return names.length <= 3
    ? names.join(', ')
    : `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`;
}

function IncompleteNotice({
  unchecked,
  onRetry,
}: {
  unchecked: ReturnType<typeof uncheckedSpaces>;
  onRetry: () => void;
}) {
  if (unchecked.failed.length)
    return (
      <Alert
        tone="warning"
        className="mb-4"
        action={
          <Button variant="outline" size="sm" onClick={onRetry}>
            Retry
          </Button>
        }
      >
        This list may be incomplete. Couldn't load the intents of {spaceNames(unchecked.failed)}.
      </Alert>
    );
  if (unchecked.loading.length)
    return (
      <Alert className="mb-4">
        This list may be incomplete. Still loading the intents of {spaceNames(unchecked.loading)}.
      </Alert>
    );
  return null;
}

function InboxSkeleton() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading your work"
      className="overflow-hidden rounded-lg border bg-card"
    >
      <span className="sr-only">Loading your work</span>
      {[1, 2, 3].map((i) => (
        <div key={i} className="flex items-center gap-4 border-b px-4 py-3 last:border-b-0">
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-3 w-1/3" />
          </div>
          <Skeleton className="h-5 w-24 rounded-full" />
        </div>
      ))}
    </div>
  );
}

// My work: everything that needs the reader across their spaces. The spaces
// themselves are in the sidebar on large screens and on /spaces otherwise; a
// `?reopenCreateSpace=1` link is the shell's to handle.
export default function Dashboard() {
  const panelsInline = usePanelsInline();
  const { projects: portfolio, loading, error, refresh } = useProjectsCache();

  // The portfolio re-renders on every 30 s poll, so one clock per render is
  // enough for ages and the stall rule.
  const now = Date.now();
  const readStatus = useIntentStatusReader();
  const inbox = useMemo(
    () =>
      deriveInbox(portfolio, now, (projectId, intent) => readStatus(projectId, intent, { now })),
    [portfolio, now, readStatus],
  );
  const unchecked = useMemo(() => uncheckedSpaces(portfolio), [portfolio]);
  const complete = !unchecked.loading.length && !unchecked.failed.length;
  useOfferIdleCandidates(
    'page',
    inbox
      .filter(isAnswerable)
      .slice(0, 2)
      .map((item) => intentEntryPath(item.project.id, item.intent)),
  );

  return (
    <div className="h-full">
      <header className="mb-6 flex items-center gap-3 sm:mb-8 sm:gap-4">
        <img
          src={getBranding().logo}
          alt={getBranding().name}
          className="h-10 w-10 shrink-0 sm:h-14 sm:w-14"
        />
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">My work</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Questions, resumes, failures and stalled runs across your spaces.
          </p>
        </div>
      </header>

      {loading ? (
        <InboxSkeleton />
      ) : error && portfolio.length === 0 ? (
        <ErrorState
          headingLevel={2}
          title="Couldn't load your work"
          description={error}
          onRetry={() => refresh()}
        />
      ) : portfolio.length === 0 ? (
        <EmptyState
          headingLevel={2}
          icon={Inbox}
          title="No spaces yet"
          description="A space connects a repository to a workflow so your team can run intents on it."
          action={
            <Button asChild className="gap-2">
              <Link to={`${spacesHomePath(panelsInline)}?reopenCreateSpace=1`}>
                Create your first space
              </Link>
            </Button>
          }
        />
      ) : inbox.length === 0 && unchecked.failed.length ? (
        <ErrorState
          headingLevel={2}
          title="Couldn't check every space"
          description={`Couldn't load the intents of ${spaceNames(unchecked.failed)}, so some work may be missing here.`}
          onRetry={() => refresh()}
        />
      ) : inbox.length === 0 && !complete ? (
        <InboxSkeleton />
      ) : inbox.length === 0 ? (
        <EmptyState
          headingLevel={2}
          icon={Inbox}
          title="Nothing needs you right now"
          description="Intents waiting for an answer or a resume, failed runs and stalled runs show up here."
          action={
            panelsInline ? undefined : (
              <Button asChild variant="outline">
                <Link to="/spaces">Browse spaces</Link>
              </Button>
            )
          }
        />
      ) : (
        <>
          <IncompleteNotice unchecked={unchecked} onRetry={() => refresh()} />
          <WaitingForYou items={inbox} now={now} />
        </>
      )}
    </div>
  );
}
