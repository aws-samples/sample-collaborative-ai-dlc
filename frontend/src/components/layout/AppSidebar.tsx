import { Link, useLocation, useParams } from 'react-router';
import { useMemo, useRef, useState } from 'react';
import {
  Activity,
  ArrowUpDown,
  Blocks,
  Eye,
  LayoutDashboard,
  ListFilter,
  Network,
  Plus,
  Settings,
  Workflow,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/contexts/AuthContext';
import { useIntentOptional } from '@/contexts/IntentContext';
import { ScrollArea } from '@/components/ui/scroll-area';
import { StatusPill } from '@/components/ui/status-pill';
import { CreateProjectModal } from '@/components/CreateProjectModal';
import { useOfferIdleCandidates } from '@/hooks/useIdleNext';
import { intentEntryPath } from '@/lib/intentEntry';
import {
  getStatus,
  statusFromDetail,
  useIntentStatus,
  useIntentStatusReader,
  type DerivedIntentStatus,
  type ResolvedIntentStatus,
} from '@/lib/statusModel';
import {
  getCachedIntentSummary,
  useProjectsCache,
  projectLastActivityAt,
  type ProjectIntentSummary,
} from '@/hooks/useProjectsCache';
import {
  useProjectSort,
  projectComparator,
  PROJECT_SORT_LABELS,
  type ProjectSort,
} from '@/hooks/useProjectSort';
import { effectiveIntentStatus, isActiveStatus, needsAttention } from '@/lib/sprintStatus';
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

type IntentFilter = 'attention' | 'active';

const FILTER_LABELS: Record<IntentFilter, string> = {
  attention: 'Needs your attention',
  active: 'Active intents',
};

const FILTER_EMPTY: Record<IntentFilter, string> = {
  attention: 'No intents need attention',
  active: 'No active intents',
};

const STORAGE_KEY = 'aidlc-sidebar-iterations-filter';
const MAX_INTENTS_PER_PROJECT = 5;
// A waiting intent's age is its oldest open gate, which only the detail knows.
// The sidebar offers a few visible waiting rows to the idle next-page pass so
// its pill, the ⌘K palette and the Spaces inbox read the intent header's age.
const WARM_WAITING_LIMIT = 3;

const VALID_FILTERS: ReadonlySet<IntentFilter> = new Set(['attention', 'active']);

function readStoredFilter(): IntentFilter {
  const stored = localStorage.getItem(STORAGE_KEY);
  // Migrate the old, broader filter to the closest current meaning. The
  // sidebar now describes v2 intents only, so "in progress" maps to active.
  if (stored === 'in-progress') return 'active';
  return stored && VALID_FILTERS.has(stored as IntentFilter)
    ? (stored as IntentFilter)
    : 'attention';
}

type ResolvedSummary = ResolvedIntentStatus<ProjectIntentSummary>;

// "Needs your attention" is the Spaces inbox rule (`needsAttention`), so the
// sidebar count and the inbox count are the same number. Both filters read the
// status the row's pill shows, never the list timestamps alone.
function matchesFilter({ intent, status }: ResolvedSummary, filter: IntentFilter): boolean {
  switch (filter) {
    case 'attention':
      return needsAttention(intent, Date.now(), status);
    case 'active':
      return isActiveStatus(effectiveIntentStatus({ status: status.key }));
  }
}

function intentActivityTime(intent: ProjectIntentSummary): number {
  const timestamp = intent.updatedAt ?? intent.createdAt;
  if (!timestamp) return 0;
  const parsed = new Date(timestamp).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

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

function isLive(derived: DerivedIntentStatus): boolean {
  return Boolean(getStatus('intent', derived.key).live) && !derived.stalled;
}

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
}

export function AppSidebar({ onCreateSpace }: AppSidebarProps = {}) {
  const location = useLocation();
  const params = useParams<{ projectId?: string; intentId?: string }>();
  const { projects, loading, error, refresh } = useProjectsCache();
  const { isPlatformAdmin } = useAuth();
  const [projectSort, setProjectSort] = useProjectSort();
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
    return projects.toSorted((a, b) =>
      cmp(
        {
          name: a.project.name,
          createdAt: a.project.createdAt,
          lastActivityAt: projectLastActivityAt(a),
        },
        {
          name: b.project.name,
          createdAt: b.project.createdAt,
          lastActivityAt: projectLastActivityAt(b),
        },
      ),
    );
  }, [projects, projectSort]);

  const [showCreateProject, setShowCreateProject] = useState(false);

  const [intentFilter, setIntentFilter] = useState<IntentFilter>(readStoredFilter);

  const handleFilterChange = (value: string) => {
    const filter = value as IntentFilter;
    setIntentFilter(filter);
    localStorage.setItem(STORAGE_KEY, filter);
  };

  // The open intent's status comes from the page's own detail (same
  // derivation as its header); every other row reads the shared cache.
  const ctxDetail = intentCtx?.detail;
  const currentDerived: DerivedIntentStatus | undefined =
    intentId && ctxDetail?.intent && ctxDetail.intent.id === intentId
      ? statusFromDetail(ctxDetail, { lastActivityAt: intentCtx?.lastActivityAt })
      : undefined;

  // One status per intent behind the filters, their counts, the space badges
  // and the pills.
  const readStatus = useIntentStatusReader();
  const resolve = (spaceId: string, intent: ProjectIntentSummary): ResolvedSummary =>
    currentDerived && ctxDetail && spaceId === projectId && intent.id === intentId
      ? { status: currentDerived, intent: { ...intent, ...ctxDetail.intent } }
      : readStatus(spaceId, intent);
  const matches = (spaceId: string, intent: ProjectIntentSummary) =>
    matchesFilter(resolve(spaceId, intent), intentFilter);

  const matchingCount = projects.reduce((count, entry) => {
    if (entry.project.kind !== 'v2') return count;
    return (
      count + projectIntentList(entry).filter((intent) => matches(entry.project.id, intent)).length
    );
  }, 0);

  // The feed is the portfolio's intent lists: one failed list means rows may be missing.
  const feedFailed =
    Boolean(error) || projects.some((entry) => entry.project.kind === 'v2' && entry.activityError);

  const isOnDashboard = location.pathname === '/dashboard';
  const isOnAdmin = location.pathname === '/admin';
  const isOnWorkflows = location.pathname.startsWith('/workflows');
  const isOnBlocks = location.pathname.startsWith('/blocks');

  // The detail request said the open intent is gone: a stale list entry must
  // not keep it on screen, and no row is synthesised for it.
  const openIntentGone = Boolean(intentId && intentCtx?.notFound && !ctxDetail);

  const filteredIterations: IterationItem[] = sortedProjects.flatMap((entry) => {
    const { project } = entry;
    if (project.kind !== 'v2') return [];
    const matchingIntents = projectIntentList(entry)
      .filter((intent) => matches(project.id, intent))
      .filter((intent) => !(openIntentGone && project.id === projectId && intent.id === intentId))
      .toSorted((a, b) => intentActivityTime(b) - intentActivityTime(a));
    let visibleIntents = matchingIntents.slice(0, MAX_INTENTS_PER_PROJECT);

    // If the URL-selected Intent matches the current filter but falls
    // beyond the cap, keep it visible instead of pinning it as historical.
    const selectedIntent = matchingIntents.find(
      (intent) => project.id === projectId && intent.id === intentId,
    );
    if (
      selectedIntent &&
      !visibleIntents.some((intent) => intent.id === selectedIntent.id) &&
      visibleIntents.length === MAX_INTENTS_PER_PROJECT
    ) {
      visibleIntents = [...visibleIntents.slice(0, -1), selectedIntent];
    }

    return visibleIntents.map((intent) => ({
      key: `intent-${intent.id}`,
      title: intent.title ?? 'Intent',
      subtitle: project.name,
      intent,
      derived: project.id === projectId && intent.id === intentId ? currentDerived : undefined,
      path: intentEntryPath(project.id, intent),
      intentMeta: { projectId: project.id, intentId: intent.id },
    }));
  });
  const overflowIntents = sortedProjects.flatMap((entry) => {
    const { project } = entry;
    if (project.kind !== 'v2') return [];
    const count = projectIntentList(entry).filter((intent) => matches(project.id, intent)).length;
    const hiddenCount = count - MAX_INTENTS_PER_PROJECT;
    return hiddenCount > 0
      ? [{ projectId: project.id, projectName: project.name, count: hiddenCount }]
      : [];
  });

  // The open intent outside the current filter is listed first, like any
  // other row (highlighted as current), so its section tabs stay reachable.
  // Before the detail answers, the row shows what the shared list cache knows
  // (title and status) or a loading placeholder — never a made-up status.
  const currentOutsideFilter: IterationItem | null = useMemo(() => {
    if (!showIntentTabs || !projectId || !intentId || openIntentGone) return null;
    const alreadyInList = filteredIterations.some((item) => item.intentMeta.intentId === intentId);
    if (alreadyInList) return null;
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
  }, [
    showIntentTabs,
    projectId,
    intentId,
    openIntentGone,
    filteredIterations,
    ctxDetail,
    currentDerived,
    projects,
  ]);

  useOfferIdleCandidates(
    'shell',
    filteredIterations
      .filter((item) => item.intent?.status === 'WAITING' && item.intentMeta.intentId !== intentId)
      .slice(0, WARM_WAITING_LIMIT)
      .map((item) => item.path),
  );

  return (
    <div className="flex h-full w-full flex-col bg-sidebar text-sidebar-foreground">
      <div className="flex items-center gap-1 px-3 pt-3 pb-1">
        <Link
          to="/dashboard"
          className={cn(
            'flex flex-1 items-center gap-2.5 px-3 py-2 text-[13px] font-medium transition-colors rounded-md text-left min-w-0',
            isOnDashboard
              ? 'bg-sidebar-accent text-sidebar-foreground'
              : 'text-sidebar-foreground/80 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground',
          )}
        >
          <LayoutDashboard className="h-4 w-4 shrink-0" />
          <span className="flex-1 truncate">Spaces</span>
        </Link>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              title={`Sort: ${PROJECT_SORT_LABELS[projectSort]}`}
              aria-label="Sort spaces"
              className="h-6 w-6 shrink-0 flex items-center justify-center rounded text-sidebar-foreground/40 hover:text-sidebar-foreground/70 hover:bg-sidebar-accent/50 transition-colors"
            >
              <ArrowUpDown className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuRadioGroup
              value={projectSort}
              onValueChange={(v) => setProjectSort(v as ProjectSort)}
            >
              <DropdownMenuRadioItem value="activity">
                {PROJECT_SORT_LABELS.activity}
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="created">
                {PROJECT_SORT_LABELS.created}
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="name">{PROJECT_SORT_LABELS.name}</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <button
          onClick={() => (onCreateSpace ? onCreateSpace() : setShowCreateProject(true))}
          title="New space"
          aria-label="New space"
          className="h-6 w-6 shrink-0 flex items-center justify-center rounded text-sidebar-foreground/40 hover:text-sidebar-foreground/70 hover:bg-sidebar-accent/50 transition-colors"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>

      <ScrollArea className="flex-1 min-h-0">
        <div className="flex flex-col gap-0.5 px-3 pb-3">
          {loading && projects.length === 0 && (
            <div className="flex flex-col gap-1.5 px-3 py-1" aria-hidden="true">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-6 rounded-md bg-sidebar-accent/40 animate-pulse" />
              ))}
            </div>
          )}
          {sortedProjects.map((entry) => {
            const { project } = entry;
            const live =
              project.kind === 'v2' &&
              projectIntentList(entry).some((intent) => isLive(resolve(project.id, intent).status));
            const attention =
              project.kind !== 'v2'
                ? 0
                : entry.intents
                  ? entry.intents.filter((intent) =>
                      matchesFilter(resolve(project.id, intent), 'attention'),
                    ).length
                  : entry.activity.attention;
            const isSelected = projectId === project.id;

            return (
              <Link
                key={project.id}
                to={`/space/${project.id}`}
                title={live ? `${project.name} — ${LIVE_LABEL}` : project.name}
                className={cn(
                  'flex items-center gap-2.5 px-3 py-1.5 text-[13px] font-medium transition-colors rounded-md text-left w-full min-w-0',
                  isSelected
                    ? 'bg-sidebar-accent text-sidebar-foreground'
                    : 'text-sidebar-foreground/80 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground',
                )}
              >
                <span className="flex-1 truncate">{project.name}</span>
                {attention > 0 && (
                  <span
                    aria-label={`${project.name}, ${attention} need${attention === 1 ? 's' : ''} attention`}
                    title={`${attention} need${attention === 1 ? 's' : ''} attention`}
                    className="shrink-0 rounded-full bg-agent-waiting/15 px-1.5 text-2xs font-medium tabular-nums text-agent-waiting-fg"
                  >
                    {attention}
                  </span>
                )}
                {live && (
                  <span
                    role="img"
                    aria-label={LIVE_LABEL}
                    className="h-1.5 w-1.5 shrink-0 rounded-full bg-agent-running motion-safe:animate-pulse"
                  />
                )}
              </Link>
            );
          })}
        </div>

        <div className="px-3 pb-3">
          <div className="flex items-center gap-1 pt-0.5 pb-0.5">
            <div
              className="flex flex-1 items-center gap-2 px-3 py-1.5 text-2xs min-w-0"
              aria-label={`Intent activity filter: ${FILTER_LABELS[intentFilter]}`}
            >
              <Activity
                className="h-3.5 w-3.5 shrink-0 text-sidebar-foreground/70"
                aria-hidden="true"
              />
              <span className="flex-1 truncate text-sidebar-foreground/70">
                Showing:{' '}
                <span className="font-medium text-sidebar-foreground/90">
                  {FILTER_LABELS[intentFilter]}
                </span>
                {matchingCount > 0 && <span className="tabular-nums"> · {matchingCount}</span>}
              </span>
            </div>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  title={`Filter: ${FILTER_LABELS[intentFilter]}`}
                  aria-label="Filter intents"
                  className="h-6 w-6 shrink-0 flex items-center justify-center rounded text-sidebar-foreground/40 hover:text-sidebar-foreground/70 hover:bg-sidebar-accent/50 transition-colors"
                >
                  <ListFilter className="h-3.5 w-3.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuRadioGroup value={intentFilter} onValueChange={handleFilterChange}>
                  <DropdownMenuRadioItem value="attention">
                    {FILTER_LABELS.attention}
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="active">
                    {FILTER_LABELS.active}
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <div className="flex flex-col gap-0.5">
            {feedFailed && (
              <span className="flex items-center gap-1 px-3 py-2 text-2xs text-sidebar-foreground/70">
                Couldn&apos;t load intents.
                <button
                  type="button"
                  onClick={() => void refresh()}
                  className="rounded-sm font-medium text-sidebar-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sidebar-ring"
                >
                  Retry
                </button>
              </span>
            )}
            {!feedFailed && filteredIterations.length === 0 && !currentOutsideFilter && (
              <span className="px-3 py-2 text-2xs text-sidebar-foreground/70">
                {FILTER_EMPTY[intentFilter]}
              </span>
            )}
            {currentOutsideFilter && (
              <div data-testid="current-intent-outside-filter">
                <SidebarIntentRow item={currentOutsideFilter} current />
                <IntentSectionTabs
                  projectId={currentOutsideFilter.intentMeta.projectId}
                  intentId={currentOutsideFilter.intentMeta.intentId}
                  currentSection={currentSection}
                />
              </div>
            )}
            {filteredIterations.map((item) => {
              const isSelectedIntent = showIntentTabs && item.intentMeta.intentId === intentId;

              return (
                <div key={item.key}>
                  <SidebarIntentRow item={item} current={isSelectedIntent} />
                  {isSelectedIntent && (
                    <IntentSectionTabs
                      projectId={item.intentMeta.projectId}
                      intentId={item.intentMeta.intentId}
                      currentSection={currentSection}
                    />
                  )}
                </div>
              );
            })}
            {overflowIntents.map((overflow) => (
              <Link
                key={`more-${overflow.projectId}`}
                to={`/space/${overflow.projectId}`}
                className="px-3 py-1.5 text-left text-2xs text-sidebar-foreground/70 hover:text-sidebar-foreground hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sidebar-ring rounded-sm"
              >
                Show {overflow.count} more {overflow.count === 1 ? 'intent' : 'intents'} in{' '}
                {overflow.projectName}
              </Link>
            ))}
          </div>
        </div>
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
              size="sm"
              compact
              className="shrink-0"
            />
          )}
          <span className="min-w-0 truncate text-2xs text-sidebar-foreground/70">
            {item.subtitle}
          </span>
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
