import { Link, useLocation, useParams } from 'react-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  ArrowUpDown,
  Blocks,
  ChevronDown,
  Eye,
  Inbox,
  LayoutDashboard,
  Network,
  Pin,
  PinOff,
  Plus,
  Settings,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/contexts/AuthContext';
import { useIntentOptional } from '@/contexts/IntentContext';
import { ScrollArea } from '@/components/ui/scroll-area';
import { StatusPill } from '@/components/ui/status-pill';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { CreateProjectModal } from '@/components/CreateProjectModal';
import { useOfferIdleCandidates } from '@/hooks/useIdleNext';
import { useSidebarSpaces } from '@/hooks/useSidebarSpaces';
import { intentEntryPath } from '@/lib/intentEntry';
import { formatRelative } from '@/lib/timeAgo';
import {
  isTerminalIntentStatus,
  statusFromDetail,
  useIntentStatus,
  useIntentStatusReader,
  type ResolvedIntentStatus,
  type DerivedIntentStatus,
} from '@/lib/statusModel';
import {
  getCachedIntentSummary,
  useProjectsCache,
  projectLastActivityAt,
  type ProjectIntentSummary,
  type ProjectWithSprint,
} from '@/hooks/useProjectsCache';
import {
  useProjectSort,
  projectAttentionRank,
  projectComparator,
  PROJECT_SORT_LABELS,
  type ProjectSort,
} from '@/hooks/useProjectSort';
import { needsAttention } from '@/lib/sprintStatus';
import {
  deriveSpaceSignals,
  spaceSignalParts,
  type SpaceSignals,
} from '@/components/space/spaceSignals';
import {
  setLastIntentSection,
  intentSectionPath,
  type IntentSection,
} from '@/lib/intentSectionPreference';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from '@/components/ui/dropdown-menu';

export const INTENTS_PAGE_SIZE = 5;
// The drawer lists intents across spaces: those needing a person, then the
// rest of the active ones by activity.
const DRAWER_INTENT_LIMIT = 10;
// A waiting intent's age is its oldest open gate, which only the detail knows.
// The sidebar offers a few visible waiting rows to the idle next-page pass so
// its pill, the ⌘K palette and the My work inbox read the intent header's age.
const WARM_WAITING_LIMIT = 3;

function intentActivityTime(intent: ProjectIntentSummary): number {
  const timestamp = intent.updatedAt ?? intent.createdAt;
  if (!timestamp) return 0;
  const parsed = new Date(timestamp).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

const byActivity = (a: ProjectIntentSummary, b: ProjectIntentSummary) =>
  intentActivityTime(b) - intentActivityTime(a);

// Finished work (succeeded, failed, cancelled) lives on the space page and in
// My work; the sidebar only lists what is still moving or waiting.
const isActiveIntent = (intent: ProjectIntentSummary) => !isTerminalIntentStatus(intent.status);

interface IterationItem {
  key: string;
  title: string;
  subtitle: string;
  /** The summary the row derives its status from (cache-aware). */
  intent?: Pick<ProjectIntentSummary, 'id' | 'status' | 'updatedAt' | 'createdAt'>;
  /** Set for the open intent: the page's own derivation. */
  derived?: DerivedIntentStatus;
  /** The open intent's detail is still loading and nothing is cached: title and status unknown. */
  pending?: boolean;
  path: string;
  intentMeta: { projectId: string; intentId: string };
}

const LIVE_LABEL = 'Agent running';

// One row style for My work, Pinned and Spaces: the desktop sidebar reads as
// one list of sections, each with an icon and a label.
const SECTION_ROW_CLASS =
  'flex min-w-0 items-center gap-2.5 rounded-md px-3 py-2 text-left text-[13px] font-medium transition-colors';

// Row-level actions (pin a space, sort or add spaces) show on hover of their
// row or when focus is inside it; always on coarse pointers, where there is
// no hover. The row sets the matching `group/<name>`. Literal strings: the
// Tailwind scanner cannot see interpolated class names.
const REVEAL_ON_HOVER = {
  space:
    'transition-opacity focus-visible:opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/space:opacity-100 group-focus-within/space:opacity-100',
  section:
    'transition-opacity focus-visible:opacity-100 data-[state=open]:opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/section:opacity-100 group-focus-within/section:opacity-100',
} as const;

function projectIntentList({
  latestIntent,
  intents,
}: {
  latestIntent: ProjectIntentSummary | null;
  intents?: ProjectIntentSummary[];
}): ProjectIntentSummary[] {
  return intents ?? (latestIntent ? [latestIntent] : []);
}

export interface AppSidebarProps {
  /**
   * Opens the Create space dialog somewhere that outlives this sidebar: the
   * inline sidebar unmounts when the viewport narrows, and a dialog it owned
   * went with it mid-form (review R3-8). Without it the sidebar hosts its own.
   */
  onCreateSpace?: () => void;
  /**
   * `drawer` (narrow screens): My work, a link to the Spaces page and the
   * intents that need the reader or are active. Inline (large screens): My
   * work, then the Pinned and Spaces sections; the Spaces label is the link to
   * the Spaces page.
   */
  variant?: 'inline' | 'drawer';
}

export function AppSidebar({ onCreateSpace, variant = 'inline' }: AppSidebarProps = {}) {
  const location = useLocation();
  const params = useParams<{ projectId?: string; intentId?: string }>();
  const { projects, loading, error, refresh } = useProjectsCache();
  const { user, isPlatformAdmin } = useAuth();
  const [projectSort, setProjectSort] = useProjectSort();
  const sidebarSpaces = useSidebarSpaces(user?.userId);
  const intentCtx = useIntentOptional();

  const projectId = params.projectId ?? null;
  const intentId = params.intentId ?? null;
  const onComposePage = location.pathname.endsWith('/compose');
  const showIntentTabs = !!intentId && !onComposePage;

  // Audit is not one of the section tabs: highlight none of them there.
  const currentSection: IntentSection | null = showIntentTabs
    ? location.pathname.endsWith('/graph')
      ? 'graph'
      : location.pathname.endsWith('/observability')
        ? 'overview'
        : location.pathname.endsWith('/audit')
          ? null
          : 'work'
    : null;

  const sortedProjects = useMemo(() => {
    const cmp = projectComparator(projectSort);
    // Same fields as the Spaces page: without the rank, "Needs attention
    // first" would order by activity alone.
    const fields = (entry: ProjectWithSprint) => ({
      name: entry.project.name,
      createdAt: entry.project.createdAt,
      lastActivityAt: projectLastActivityAt(entry),
      attentionRank: projectAttentionRank(projectIntentList(entry)),
    });
    return projects.toSorted((a, b) => cmp(fields(a), fields(b)));
  }, [projects, projectSort]);

  const [showCreateProject, setShowCreateProject] = useState(false);

  // The feed is the portfolio's intent lists: one failed list means rows may be missing.
  const feedFailed =
    Boolean(error) || projects.some((entry) => entry.project.kind === 'v2' && entry.activityError);

  const isOnMyWork = location.pathname === '/my-work';
  const isOnSpaces = location.pathname === '/dashboard' || location.pathname === '/spaces';
  // The space page itself (not an intent under it): its row's title then
  // folds the space instead of reloading the page the reader is on.
  const onSpacePage = (id: string) => location.pathname === `/space/${id}`;
  const isOnAdmin = location.pathname === '/admin';
  const isOnWorkflows = location.pathname.startsWith('/workflows');
  const isOnBlocks = location.pathname.startsWith('/blocks');

  // The open intent's status comes from the page's own detail (same
  // derivation as its header); every other row reads the shared cache.
  const ctxDetail = intentCtx?.detail;
  const currentDerived: DerivedIntentStatus | undefined =
    intentId && ctxDetail?.intent && ctxDetail.intent.id === intentId
      ? statusFromDetail(ctxDetail, {
          lastActivityAt: intentCtx?.lastActivityAt,
        })
      : undefined;

  // One status per intent behind the drawer's attention order, the space
  // signals and live dot, and the pills: the open intent reads the page's
  // derivation, every other the shared cache (never the list timestamps alone).
  const readStatus = useIntentStatusReader();
  const resolve = (
    spaceId: string,
    intent: ProjectIntentSummary,
  ): ResolvedIntentStatus<ProjectIntentSummary> =>
    currentDerived && ctxDetail && spaceId === projectId && intent.id === intentId
      ? { status: currentDerived, intent: { ...intent, ...ctxDetail.intent } }
      : readStatus(spaceId, intent);

  // The detail request said the open intent is gone: a stale list entry must
  // not keep it on screen, and no row is synthesised for it.
  const openIntentGone = Boolean(intentId && intentCtx?.notFound && !ctxDetail);

  const toItem = (project: ProjectWithSprint['project'], intent: ProjectIntentSummary) => ({
    key: `intent-${intent.id}`,
    title: intent.title ?? 'Intent',
    subtitle: project.name,
    intent,
    derived: project.id === projectId && intent.id === intentId ? currentDerived : undefined,
    path: intentEntryPath(project.id, intent),
    intentMeta: { projectId: project.id, intentId: intent.id },
  });

  // Every active intent of every space, by activity: the per-space lists and
  // the drawer slice it.
  const activeByProject = useMemo(
    () =>
      new Map(
        sortedProjects.map((entry) => [
          entry.project.id,
          entry.project.kind === 'v2'
            ? projectIntentList(entry)
                .filter(isActiveIntent)
                .filter(
                  (intent) =>
                    !(openIntentGone && entry.project.id === projectId && intent.id === intentId),
                )
                .toSorted(byActivity)
            : [],
        ]),
      ),
    [sortedProjects, openIntentGone, projectId, intentId],
  );

  // The open intent is listed first in its space (highlighted as current) even
  // when finished or beyond the visible rows, so its section tabs stay
  // reachable. Before the detail answers, the row shows what the shared list
  // cache knows (title and status) or a loading placeholder — never a made-up
  // status.
  const currentItem: IterationItem | null = useMemo(() => {
    if (!showIntentTabs || !projectId || !intentId || openIntentGone) return null;
    const intent =
      ctxDetail?.intent?.id === intentId
        ? ctxDetail.intent
        : getCachedIntentSummary(projectId, intentId);
    const spaceName = projects.find((p) => p.project.id === projectId)?.project.name ?? '';
    return {
      key: `current-intent-${intentId}`,
      title: intent?.title ?? 'Intent',
      subtitle: spaceName,
      intent,
      derived: currentDerived,
      pending: !intent,
      path: intent
        ? intentEntryPath(projectId, { ...intent, gates: ctxDetail?.gates })
        : intentSectionPath(projectId, intentId, 'overview'),
      intentMeta: { projectId, intentId },
    };
  }, [showIntentTabs, projectId, intentId, openIntentGone, ctxDetail, currentDerived, projects]);

  // Expanded spaces: the one the reader is in opens by itself when they
  // arrive; a chevron toggles any other. Collapsing resets its rows to the
  // first page.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [pages, setPages] = useState<Readonly<Record<string, number>>>({});
  useEffect(() => {
    if (!projectId) return;
    setExpanded((prev) => (prev.has(projectId) ? prev : new Set([...prev, projectId])));
  }, [projectId]);
  const toggleSpace = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
        setPages(({ [id]: _reset, ...rest }) => rest);
      } else next.add(id);
      return next;
    });
  };
  const showMore = (id: string) => setPages((prev) => ({ ...prev, [id]: (prev[id] ?? 1) + 1 }));

  const visibleRowsOf = (id: string): IterationItem[] => {
    const entry = sortedProjects.find((p) => p.project.id === id);
    if (!entry) return [];
    const active = activeByProject.get(id) ?? [];
    const limit = (pages[id] ?? 1) * INTENTS_PAGE_SIZE;
    // Nested under their space: the row doesn't repeat the space's name.
    const rows = active
      .slice(0, limit)
      .map((intent) => ({ ...toItem(entry.project, intent), subtitle: '' }));
    if (currentItem && currentItem.intentMeta.projectId === id) {
      const inRows = rows.some(
        (row) => row.intentMeta.intentId === currentItem.intentMeta.intentId,
      );
      if (!inRows) return [{ ...currentItem, subtitle: '' }, ...rows];
      return rows.map((row) =>
        row.intentMeta.intentId === currentItem.intentMeta.intentId
          ? { ...row, derived: currentDerived }
          : row,
      );
    }
    return rows;
  };

  const now = Date.now();
  const drawerItems: IterationItem[] = [];
  if (variant === 'drawer') {
    const all = sortedProjects.flatMap((entry) =>
      (activeByProject.get(entry.project.id) ?? []).map((intent) => {
        const shown = resolve(entry.project.id, intent);
        // Same rule as My work: a Viewer's intents are listed, not ranked as needing them.
        const actionable =
          entry.project.userRole !== 'viewer' && needsAttention(shown.intent, now, shown.status);
        return { entry, intent, attention: actionable ? 0 : 1 };
      }),
    );
    drawerItems.push(
      ...all
        .toSorted((a, b) => a.attention - b.attention || byActivity(a.intent, b.intent))
        .slice(0, DRAWER_INTENT_LIMIT)
        .map(({ entry, intent }) => toItem(entry.project, intent)),
    );
    if (
      currentItem &&
      !drawerItems.some((row) => row.intentMeta.intentId === currentItem.intentMeta.intentId)
    )
      drawerItems.unshift(currentItem);
  }

  const visibleWaiting = (
    variant === 'drawer'
      ? drawerItems
      : sortedProjects.flatMap((entry) =>
          expanded.has(entry.project.id) ? visibleRowsOf(entry.project.id) : [],
        )
  )
    .filter((item) => item.intent?.status === 'WAITING' && item.intentMeta.intentId !== intentId)
    .slice(0, WARM_WAITING_LIMIT)
    .map((item) => item.path);
  useOfferIdleCandidates('shell', visibleWaiting);

  const pinnedEntries = sortedProjects.filter((entry) => sidebarSpaces.isPinned(entry.project.id));
  const otherEntries = sortedProjects.filter((entry) => !sidebarSpaces.isPinned(entry.project.id));

  const renderSpace = (entry: ProjectWithSprint) => {
    const id = entry.project.id;
    const isExpanded = expanded.has(id);
    const active = activeByProject.get(id) ?? [];
    const rows = isExpanded ? visibleRowsOf(id) : [];
    const shownActive = rows.filter((row) => row.key !== currentItem?.key).length;
    const hidden = Math.max(0, active.length - shownActive);
    return (
      <SpaceRow
        key={id}
        entry={entry}
        now={now}
        selected={projectId === id}
        onSpacePage={onSpacePage(id)}
        expanded={isExpanded}
        onToggle={() => toggleSpace(id)}
        pinned={sidebarSpaces.isPinned(id)}
        onPin={(pinned) => sidebarSpaces.setPinned(id, pinned)}
        summary={deriveSpaceSignals(projectIntentList(entry), now, (intent) => resolve(id, intent))}
      >
        {isExpanded && (
          <div className="flex flex-col gap-0.5 pb-1 pl-5">
            {rows.length === 0 && (
              <span className="px-3 py-1.5 text-2xs text-sidebar-foreground/60">
                No active intents
              </span>
            )}
            {rows.map((item) => (
              <IntentRowWithTabs
                key={item.key}
                item={item}
                current={showIntentTabs && item.intentMeta.intentId === intentId}
                currentSection={currentSection}
              />
            ))}
            {hidden > 0 && (
              <button
                type="button"
                onClick={() => showMore(id)}
                className="rounded-sm px-3 py-1.5 text-left text-2xs text-sidebar-foreground/70 hover:text-sidebar-foreground hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sidebar-ring"
              >
                Show more ({Math.min(hidden, INTENTS_PAGE_SIZE)})
              </button>
            )}
          </div>
        )}
      </SpaceRow>
    );
  };

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-full w-full flex-col bg-sidebar text-sidebar-foreground">
        <nav aria-label="Primary" className="flex flex-col gap-0.5 px-3 pt-3 pb-0.5">
          <PrimaryLink to="/my-work" icon={Inbox} label="My work" current={isOnMyWork} />
          {variant === 'drawer' && (
            <PrimaryLink
              to="/dashboard"
              icon={LayoutDashboard}
              label="Spaces"
              current={isOnSpaces}
            />
          )}
        </nav>

        <ScrollArea className="flex-1 min-h-0">
          {variant === 'drawer' ? (
            <div className="px-3 pb-3 pt-1.5">
              <div className="px-3 pb-1 text-2xs font-medium text-sidebar-foreground/60">
                Intents
              </div>
              <div className="flex flex-col gap-0.5">
                {loading && projects.length === 0 && <RowsSkeleton />}
                {feedFailed && <FeedFailed onRetry={() => void refresh()} />}
                {!feedFailed && !loading && drawerItems.length === 0 && (
                  <span className="px-3 py-2 text-2xs text-sidebar-foreground/70">
                    No active intents
                  </span>
                )}
                {drawerItems.map((item) => (
                  <IntentRowWithTabs
                    key={item.key}
                    item={item}
                    current={showIntentTabs && item.intentMeta.intentId === intentId}
                    currentSection={currentSection}
                  />
                ))}
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-3 px-3 pt-2.5 pb-3">
              {pinnedEntries.length > 0 && (
                <section aria-labelledby="sidebar-pinned" className="flex flex-col gap-0.5">
                  <div className="group/section flex">
                    <SectionHeader
                      id="sidebar-pinned"
                      icon={Pin}
                      label="Pinned"
                      collapsed={sidebarSpaces.pinnedCollapsed}
                      onToggle={() =>
                        sidebarSpaces.setPinnedCollapsed(!sidebarSpaces.pinnedCollapsed)
                      }
                    />
                  </div>
                  {!sidebarSpaces.pinnedCollapsed && (
                    <div id="sidebar-pinned-list" className="flex flex-col gap-0.5">
                      {pinnedEntries.map(renderSpace)}
                    </div>
                  )}
                </section>
              )}

              <section aria-labelledby="sidebar-spaces" className="flex flex-col gap-0.5">
                <div className="group/section flex items-center gap-0.5">
                  <SectionHeader
                    id="sidebar-spaces"
                    icon={LayoutDashboard}
                    label="Spaces"
                    href="/dashboard"
                    current={isOnSpaces}
                    collapsed={sidebarSpaces.spacesCollapsed}
                    onToggle={() =>
                      sidebarSpaces.setSpacesCollapsed(!sidebarSpaces.spacesCollapsed)
                    }
                  />
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        title={`Sort: ${PROJECT_SORT_LABELS[projectSort]}`}
                        aria-label="Sort spaces"
                        className={cn(
                          'flex h-6 w-6 shrink-0 items-center justify-center rounded text-sidebar-foreground/40 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground/70 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sidebar-ring',
                          REVEAL_ON_HOVER.section,
                        )}
                      >
                        <ArrowUpDown className="h-3.5 w-3.5" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-48">
                      <DropdownMenuRadioGroup
                        value={projectSort}
                        onValueChange={(v) => setProjectSort(v as ProjectSort)}
                      >
                        {(Object.keys(PROJECT_SORT_LABELS) as ProjectSort[]).map((key) => (
                          <DropdownMenuRadioItem key={key} value={key}>
                            {PROJECT_SORT_LABELS[key]}
                          </DropdownMenuRadioItem>
                        ))}
                      </DropdownMenuRadioGroup>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <button
                    onClick={() => (onCreateSpace ? onCreateSpace() : setShowCreateProject(true))}
                    title="New space"
                    aria-label="New space"
                    className={cn(
                      'flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sidebar-ring',
                      REVEAL_ON_HOVER.section,
                    )}
                  >
                    <Plus className="h-4 w-4" strokeWidth={2.5} aria-hidden="true" />
                  </button>
                </div>
                {!sidebarSpaces.spacesCollapsed && (
                  <div id="sidebar-spaces-list" className="flex flex-col gap-0.5">
                    {loading && projects.length === 0 && <RowsSkeleton />}
                    {feedFailed && <FeedFailed onRetry={() => void refresh()} />}
                    {!loading && projects.length === 0 && !feedFailed && (
                      <span className="px-3 py-2 text-2xs text-sidebar-foreground/70">
                        No spaces yet
                      </span>
                    )}
                    {otherEntries.map(renderSpace)}
                  </div>
                )}
              </section>
            </div>
          )}
        </ScrollArea>

        <div className="border-t border-sidebar-border p-2 flex flex-col gap-0.5">
          {isPlatformAdmin && (
            <>
              <div className="px-3 pb-1 pt-1 text-2xs font-medium text-sidebar-foreground/60">
                Authoring
              </div>
              <Link
                to="/workflows"
                className={cn(
                  'flex items-center gap-2.5 px-3 py-2 text-[13px] font-medium transition-colors rounded-md text-left w-full',
                  isOnWorkflows
                    ? 'bg-sidebar-accent text-sidebar-foreground'
                    : 'text-sidebar-foreground/60 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground',
                )}
              >
                <Workflow className="h-3.5 w-3.5 shrink-0" />
                Workflows
              </Link>
              <Link
                to="/blocks/stage"
                className={cn(
                  'flex items-center gap-2.5 px-3 py-2 text-[13px] font-medium transition-colors rounded-md text-left w-full',
                  isOnBlocks
                    ? 'bg-sidebar-accent text-sidebar-foreground'
                    : 'text-sidebar-foreground/60 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground',
                )}
              >
                <Blocks className="h-3.5 w-3.5 shrink-0" />
                Block Library
              </Link>
              <div className="my-1 h-px bg-sidebar-border" />
              <Link
                to="/admin"
                className={cn(
                  'flex items-center gap-2.5 px-3 py-2 text-[13px] font-medium transition-colors rounded-md text-left w-full',
                  isOnAdmin
                    ? 'bg-sidebar-accent text-sidebar-foreground'
                    : 'text-sidebar-foreground/60 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground',
                )}
              >
                <Settings className="h-3.5 w-3.5 shrink-0" />
                Admin & Settings
              </Link>
            </>
          )}
        </div>

        {showCreateProject && !onCreateSpace && (
          <CreateProjectModal onClose={() => setShowCreateProject(false)} onCreated={refresh} />
        )}
      </div>
    </TooltipProvider>
  );
}

function PrimaryLink({
  to,
  icon: Icon,
  label,
  current,
}: {
  to: string;
  icon: LucideIcon;
  label: string;
  current: boolean;
}) {
  return (
    <Link
      to={to}
      aria-current={current ? 'page' : undefined}
      className={cn(
        SECTION_ROW_CLASS,
        current
          ? 'bg-sidebar-accent text-sidebar-foreground'
          : 'text-sidebar-foreground/80 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground',
      )}
    >
      <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="flex-1 truncate">{label}</span>
    </Link>
  );
}

// Pinned: the row toggles its list; the chevron sits by the label. Spaces has
// a page (`href`): the label opens it, opens the list again once there, and
// only the chevron toggles — the rule the space rows already follow.
function SectionHeader({
  id,
  icon: Icon,
  label,
  href,
  current = false,
  collapsed,
  onToggle,
}: {
  id: string;
  icon: LucideIcon;
  label: string;
  href?: string;
  current?: boolean;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const rowClass = cn(
    SECTION_ROW_CLASS,
    'flex-1 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sidebar-ring',
    current
      ? 'bg-sidebar-accent text-sidebar-foreground'
      : 'text-sidebar-foreground/80 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground',
  );
  // Open sections hide their chevron until hovered, like the row actions;
  // a folded section keeps it as the cue that there is more.
  const chevron = (
    <ChevronDown
      aria-hidden="true"
      className={cn(
        'h-3.5 w-3.5 shrink-0 text-sidebar-foreground/50 transition-transform',
        collapsed ? '-rotate-90' : REVEAL_ON_HOVER.section,
      )}
    />
  );
  if (!href) {
    return (
      <button
        type="button"
        id={id}
        aria-expanded={!collapsed}
        aria-controls={`${id}-list`}
        onClick={onToggle}
        className={rowClass}
      >
        <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="truncate">{label}</span>
        <span className="-ml-1 flex">{chevron}</span>
      </button>
    );
  }
  // Label and chevron share the row's free space, so the chevron sits right
  // after the word, as on Pinned.
  return (
    <div className="flex min-w-0 flex-1 items-center">
      <Link
        to={href}
        id={id}
        aria-current={current ? 'page' : undefined}
        onClick={(event) => {
          if (!current) return;
          event.preventDefault();
          onToggle();
        }}
        className={cn(rowClass, 'flex-none')}
      >
        <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="truncate">{label}</span>
      </Link>
      <button
        type="button"
        aria-expanded={!collapsed}
        aria-controls={`${id}-list`}
        aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${label.toLowerCase()}`}
        onClick={onToggle}
        className="-ml-1 flex h-7 w-5 shrink-0 items-center justify-center rounded text-sidebar-foreground/50 hover:text-sidebar-foreground/80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sidebar-ring"
      >
        {chevron}
      </button>
    </div>
  );
}

function RowsSkeleton() {
  return (
    <div className="flex flex-col gap-1.5 px-3 py-1" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-6 rounded-md bg-sidebar-accent/40 animate-pulse" />
      ))}
    </div>
  );
}

function FeedFailed({ onRetry }: { onRetry: () => void }) {
  return (
    <span className="flex items-center gap-1 px-3 py-2 text-2xs text-sidebar-foreground/70">
      Couldn&apos;t load intents.
      <button
        type="button"
        onClick={onRetry}
        className="rounded-sm font-medium text-sidebar-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sidebar-ring"
      >
        Retry
      </button>
    </span>
  );
}

interface SpaceRowProps {
  entry: ProjectWithSprint;
  now: number;
  selected: boolean;
  onSpacePage: boolean;
  expanded: boolean;
  onToggle: () => void;
  pinned: boolean;
  onPin: (pinned: boolean) => void;
  summary: SpaceSignals;
  children?: React.ReactNode;
}

function SpaceRow({
  entry,
  now,
  selected,
  onSpacePage,
  expanded,
  onToggle,
  pinned,
  onPin,
  summary,
  children,
}: SpaceRowProps) {
  const { project } = entry;
  const isV2 = project.kind === 'v2';
  const live = isV2 && summary.running > 0;
  const lastActivity = projectLastActivityAt(entry);
  const parts = isV2 ? spaceSignalParts(summary) : ['Legacy · read-only'];
  const hint = [
    project.name,
    parts.length > 0 ? parts.join(' · ') : isV2 ? 'No open work' : null,
    lastActivity ? `Last activity ${formatRelative(lastActivity, { now })}` : null,
  ]
    .filter(Boolean)
    .join('\n');

  return (
    <div>
      <div
        className={cn(
          'group/space flex items-center rounded-md transition-colors',
          selected ? 'bg-sidebar-accent' : 'hover:bg-muted',
        )}
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <Link
              to={`/space/${project.id}`}
              aria-current={selected ? 'page' : undefined}
              onClick={(event) => {
                if (!onSpacePage) return;
                event.preventDefault();
                onToggle();
              }}
              className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-3 pr-1 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sidebar-ring rounded-md"
            >
              <span className="min-w-0 flex-1">
                <span
                  className={cn(
                    'block truncate text-[13px] font-medium',
                    selected ? 'text-sidebar-foreground' : 'text-sidebar-foreground/85',
                  )}
                >
                  {project.name}
                </span>
              </span>
              {live && (
                <span
                  role="img"
                  aria-label={LIVE_LABEL}
                  className="h-1.5 w-1.5 shrink-0 rounded-full bg-agent-running motion-safe:animate-pulse"
                />
              )}
            </Link>
          </TooltipTrigger>
          <TooltipContent side="right" className="whitespace-pre-line text-left">
            {hint}
          </TooltipContent>
        </Tooltip>
        <button
          type="button"
          aria-pressed={pinned}
          aria-label={`${pinned ? 'Unpin' : 'Pin'} ${project.name}`}
          onClick={() => onPin(!pinned)}
          className={cn(
            'flex h-6 w-6 shrink-0 items-center justify-center rounded text-sidebar-foreground/40 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground/80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sidebar-ring',
            REVEAL_ON_HOVER.space,
            pinned && 'text-sidebar-foreground/60',
          )}
        >
          {pinned ? (
            <PinOff aria-hidden="true" className="h-3 w-3" />
          ) : (
            <Pin aria-hidden="true" className="h-3 w-3" />
          )}
        </button>
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={`${expanded ? 'Collapse' : 'Expand'} ${project.name}`}
          onClick={onToggle}
          className="flex h-8 w-6 shrink-0 items-center justify-center rounded-md text-sidebar-foreground/40 hover:text-sidebar-foreground/80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sidebar-ring"
        >
          <ChevronDown
            aria-hidden="true"
            className={cn('h-3.5 w-3.5 transition-transform', !expanded && '-rotate-90')}
          />
        </button>
      </div>
      {children}
    </div>
  );
}

function IntentRowWithTabs({
  item,
  current,
  currentSection,
}: {
  item: IterationItem;
  current: boolean;
  currentSection: IntentSection | null;
}) {
  return (
    <div
      data-testid={
        item.key.startsWith('current-intent-') ? 'current-intent-outside-filter' : undefined
      }
    >
      <SidebarIntentRow item={item} current={current} />
      {current && (
        <IntentSectionTabs
          projectId={item.intentMeta.projectId}
          intentId={item.intentMeta.intentId}
          currentSection={currentSection}
        />
      )}
    </div>
  );
}

interface SidebarIntentRowProps {
  item: IterationItem;
  /** The intent open in the main view. */
  current?: boolean;
}

function SidebarIntentRow({ item, current = false }: SidebarIntentRowProps) {
  const { projectId } = item.intentMeta;
  const titleRef = useRef<HTMLSpanElement>(null);
  const [fullTitle, setFullTitle] = useState<string | undefined>(undefined);
  const cached = useIntentStatus(projectId, item.intent);
  const derived = item.derived ?? cached;
  // Warming is the shell's delegated listener's job (this is a plain link).
  const revealTruncatedTitle = () => {
    const el = titleRef.current;
    setFullTitle(el && el.scrollWidth > el.clientWidth ? item.title : undefined);
  };

  return (
    <Link
      to={item.path}
      onPointerEnter={revealTruncatedTitle}
      onFocus={revealTruncatedTitle}
      title={fullTitle}
      aria-current={current ? 'true' : undefined}
      className={cn(
        'flex items-start gap-2 px-3 py-1.5 rounded-md text-left w-full min-w-0 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sidebar-ring',
        current ? 'bg-sidebar-accent' : 'hover:bg-sidebar-accent/50',
      )}
    >
      <span className="flex-1 min-w-0">
        {item.pending ? (
          // Inline (phrasing content inside the link): same pulse, role=status.
          <span
            role="status"
            aria-busy="true"
            aria-label="Loading intent"
            className="block h-3.5 w-32 animate-pulse rounded-sm bg-primary/10"
          />
        ) : (
          <span
            ref={titleRef}
            className={cn(
              'block truncate text-xs font-medium',
              current ? 'text-sidebar-foreground' : 'text-sidebar-foreground/90',
            )}
          >
            {item.title}
          </span>
        )}
        <span className="mt-0.5 flex items-center gap-1.5 min-w-0">
          {item.pending ? (
            <span
              aria-hidden="true"
              className="inline-block h-4 w-20 shrink-0 animate-pulse rounded-full bg-primary/10"
            />
          ) : (
            <StatusPill
              kind="intent"
              status={derived.key}
              stalled={derived.stalled}
              since={derived.since}
              size="xs"
              compact
              className="shrink-0"
            />
          )}
          {item.subtitle && (
            <span className="min-w-0 truncate text-2xs text-sidebar-foreground/70">
              {item.subtitle}
            </span>
          )}
        </span>
      </span>
    </Link>
  );
}

const SECTION_NAV: { key: IntentSection; label: string; icon: typeof Eye }[] = [
  { key: 'overview', label: 'Overview', icon: Eye },
  { key: 'work', label: 'Work', icon: Activity },
  { key: 'graph', label: 'Graph', icon: Network },
];

function IntentSectionTabs({
  projectId,
  intentId,
  currentSection,
}: {
  projectId: string;
  intentId: string;
  currentSection: IntentSection | null;
}) {
  return (
    <nav className="flex flex-col gap-px pl-7 pr-1 py-1" aria-label="Intent sections">
      {SECTION_NAV.map(({ key, label, icon: Icon }) => (
        <Link
          key={key}
          to={intentSectionPath(projectId, intentId, key)}
          aria-current={currentSection === key ? 'page' : undefined}
          onClick={() => setLastIntentSection(intentId, key)}
          className={cn(
            'flex min-h-6 w-full items-center gap-2 rounded-md px-2.5 py-1 text-left text-2xs font-medium transition-colors',
            currentSection === key
              ? 'bg-sidebar-accent/70 text-sidebar-foreground'
              : 'text-sidebar-foreground/60 hover:bg-sidebar-accent/40 hover:text-sidebar-foreground/80',
          )}
        >
          <Icon className="h-3 w-3 shrink-0" />
          {label}
        </Link>
      ))}
    </nav>
  );
}
