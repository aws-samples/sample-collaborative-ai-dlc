import { useNavigate, useLocation, useParams } from 'react-router-dom';
import { useMemo, useState } from 'react';
import {
  Activity,
  ArrowUpDown,
  Blocks,
  CheckCircle2,
  LayoutDashboard,
  ListFilter,
  Loader2,
  MessageCircleQuestion,
  Plus,
  Settings,
  Workflow,
  XCircle,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/contexts/AuthContext';
import { ScrollArea } from '@/components/ui/scroll-area';
import { CreateProjectModal } from '@/components/CreateProjectModal';
import { useProjectsCache, projectLastActivityAt } from '@/hooks/useProjectsCache';
import {
  useProjectSort,
  projectComparator,
  PROJECT_SORT_LABELS,
  type ProjectSort,
} from '@/hooks/useProjectSort';
import {
  effectiveSprintStatus,
  effectiveIntentStatus,
  isAttentionStatus,
  isActiveStatus,
  type EffectiveSprintStatus,
} from '@/lib/sprintStatus';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from '@/components/ui/dropdown-menu';

type IterationFilter = 'attention' | 'active' | 'in-progress';

const FILTER_LABELS: Record<IterationFilter, string> = {
  attention: 'Needs attention',
  active: 'Active',
  'in-progress': 'In progress',
};

const FILTER_EMPTY: Record<IterationFilter, string> = {
  attention: 'Nothing needs attention',
  active: 'No active iterations',
  'in-progress': 'No iterations in progress',
};

const STORAGE_KEY = 'aidlc-sidebar-iterations-filter';

const VALID_FILTERS: ReadonlySet<IterationFilter> = new Set(['attention', 'active', 'in-progress']);

function readStoredFilter(): IterationFilter {
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored && VALID_FILTERS.has(stored as IterationFilter)
    ? (stored as IterationFilter)
    : 'active';
}

function matchesFilter(status: EffectiveSprintStatus, filter: IterationFilter): boolean {
  switch (filter) {
    case 'attention':
      return isAttentionStatus(status);
    case 'active':
      return isActiveStatus(status);
    case 'in-progress':
      return status !== 'passed' && status !== 'idle';
  }
}

const STATUS_DOT: Record<string, string> = {
  running: 'bg-agent-running',
  waiting: 'bg-agent-waiting',
  completed: 'bg-agent-success',
  passed: 'bg-agent-success',
  failed: 'bg-agent-error',
};

const STATUS_LABEL: Record<string, string> = {
  running: 'Agent running',
  waiting: 'Agent waiting for input',
  completed: 'Completed',
  passed: 'Passed',
  failed: 'Agent failed',
};

export function AppSidebar() {
  const navigate = useNavigate();
  const location = useLocation();
  const params = useParams<{ projectId?: string }>();
  const { projects, loading, refresh } = useProjectsCache();
  const { isPlatformAdmin } = useAuth();
  // Same sort selection as the Dashboard grid/list (shared store) — the
  // sidebar mirrors whatever ordering the user picked there, and vice versa.
  const [projectSort, setProjectSort] = useProjectSort();

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

  const projectId = params.projectId ?? null;

  const [showCreateProject, setShowCreateProject] = useState(false);

  const [iterationFilter, setIterationFilter] = useState<IterationFilter>(readStoredFilter);

  const handleFilterChange = (value: string) => {
    const filter = value as IterationFilter;
    setIterationFilter(filter);
    localStorage.setItem(STORAGE_KEY, filter);
  };

  const runningCount = projects.filter(({ project, latestSprint, latestIntent }) => {
    const status =
      project.kind === 'v2'
        ? effectiveIntentStatus(latestIntent)
        : effectiveSprintStatus(latestSprint);
    return status === 'running' || status === 'waiting';
  }).length;

  const isOnDashboard = location.pathname === '/dashboard';
  const isOnObservability = location.pathname === '/observability';
  const isOnAdmin = location.pathname === '/admin';
  const isOnWorkflows = location.pathname.startsWith('/workflows');
  const isOnBlocks = location.pathname.startsWith('/blocks');

  interface IterationItem {
    key: string;
    title: string;
    subtitle: string;
    status: EffectiveSprintStatus;
    onClick: () => void;
  }

  const filteredIterations: IterationItem[] = sortedProjects.flatMap(
    ({ project, latestSprint, latestIntent }) => {
      if (project.kind === 'v2') {
        if (!latestIntent) return [];
        const status = effectiveIntentStatus(latestIntent);
        if (!matchesFilter(status, iterationFilter)) return [];
        return [
          {
            key: `intent-${latestIntent.id}`,
            title: latestIntent.title ?? 'Intent',
            subtitle: project.name,
            status,
            onClick: () =>
              navigate(`/project/${project.id}/intent/${latestIntent.id}/observability`),
          },
        ];
      }
      if (!latestSprint) return [];
      const status = effectiveSprintStatus(latestSprint);
      if (!matchesFilter(status, iterationFilter)) return [];
      return [
        {
          key: `sprint-${project.id}`,
          title: latestSprint.name,
          subtitle: project.name,
          status,
          onClick: () => navigate(`/observability?project=${project.id}&sprint=${latestSprint.id}`),
        },
      ];
    },
  );

  return (
    <div className="flex h-full w-full flex-col bg-sidebar text-sidebar-foreground">
      <div className="flex items-center gap-1 px-3 pt-3 pb-1">
        <button
          onClick={() => navigate('/dashboard')}
          className={cn(
            'flex flex-1 items-center gap-2.5 px-3 py-2 text-[13px] font-medium transition-colors rounded-md text-left min-w-0',
            isOnDashboard
              ? 'bg-sidebar-accent text-sidebar-foreground'
              : 'text-sidebar-foreground/80 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground',
          )}
        >
          <LayoutDashboard className="h-4 w-4 shrink-0" />
          <span className="flex-1 truncate">Projects</span>
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              title={`Sort: ${PROJECT_SORT_LABELS[projectSort]}`}
              aria-label="Sort projects"
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
          onClick={() => setShowCreateProject(true)}
          title="New project"
          aria-label="New project"
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
          {sortedProjects.map(({ project, latestSprint }) => {
            const status = effectiveSprintStatus(latestSprint);
            const isActive = status === 'running' || status === 'waiting';
            const dotColor = STATUS_DOT[status];
            const isSelected = projectId === project.id;

            return (
              <button
                key={project.id}
                onClick={() => navigate(`/project/${project.id}`)}
                title={dotColor ? `${project.name} — ${STATUS_LABEL[status]}` : project.name}
                className={cn(
                  'flex items-center gap-2.5 px-3 py-1.5 text-[13px] font-medium transition-colors rounded-md text-left w-full min-w-0',
                  isSelected
                    ? 'bg-sidebar-accent text-sidebar-foreground'
                    : 'text-sidebar-foreground/80 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground',
                )}
              >
                <span className="relative shrink-0">
                  <span className="block h-3.5 w-3.5 rounded-sm bg-sidebar-primary/30" />
                  {dotColor && (
                    <span
                      role="img"
                      aria-label={STATUS_LABEL[status]}
                      className={cn(
                        'absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full shadow-[0_0_0_2px_hsl(var(--sidebar-background))]',
                        dotColor,
                        isActive && 'animate-pulse',
                      )}
                    />
                  )}
                </span>
                <span className="flex-1 truncate">{project.name}</span>
                {status === 'running' && (
                  <Loader2 className="h-3 w-3 text-agent-running animate-spin shrink-0" />
                )}
                {status === 'waiting' && (
                  <MessageCircleQuestion className="h-3 w-3 text-agent-waiting shrink-0" />
                )}
              </button>
            );
          })}
        </div>

        <div className="px-3 pb-3">
          <div className="flex items-center gap-1 pt-1 pb-1">
            <button
              onClick={() => navigate('/observability')}
              className={cn(
                'flex flex-1 items-center gap-2.5 px-3 py-2 text-[13px] font-medium transition-colors rounded-md text-left min-w-0',
                isOnObservability
                  ? 'bg-sidebar-accent text-sidebar-foreground'
                  : 'text-sidebar-foreground/80 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground',
              )}
            >
              <Activity className="h-4 w-4 shrink-0" />
              <span className="flex-1 truncate">Observability</span>
              {runningCount > 0 && (
                <span className="flex items-center gap-1.5 shrink-0">
                  <span className="relative flex h-2 w-2">
                    <span className="animate-pulse absolute inline-flex h-full w-full rounded-full bg-agent-running opacity-75" />
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-agent-running" />
                  </span>
                  <span className="text-[11px] font-medium text-agent-running">{runningCount}</span>
                </span>
              )}
            </button>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  title={`Filter: ${FILTER_LABELS[iterationFilter]}`}
                  aria-label="Filter iterations"
                  className="h-6 w-6 shrink-0 flex items-center justify-center rounded text-sidebar-foreground/40 hover:text-sidebar-foreground/70 hover:bg-sidebar-accent/50 transition-colors"
                >
                  <ListFilter className="h-3.5 w-3.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuRadioGroup value={iterationFilter} onValueChange={handleFilterChange}>
                  <DropdownMenuRadioItem value="attention">
                    {FILTER_LABELS.attention}
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="active">
                    {FILTER_LABELS.active}
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="in-progress">
                    {FILTER_LABELS['in-progress']}
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <div className="flex flex-col gap-0.5">
            {filteredIterations.length === 0 && (
              <span className="px-3 py-2 text-[10px] text-sidebar-foreground/40">
                {FILTER_EMPTY[iterationFilter]}
              </span>
            )}
            {filteredIterations.map((item) => (
              <button
                key={item.key}
                onClick={item.onClick}
                className="flex items-center gap-2 px-3 py-1.5 rounded-md text-left w-full min-w-0 hover:bg-sidebar-accent/50 transition-colors"
              >
                <IterationStatusIcon status={item.status} />
                <div className="flex-1 min-w-0">
                  <span className="block text-[11px] font-medium text-sidebar-foreground/80 truncate">
                    {item.title}
                  </span>
                  <span className="block text-[10px] text-sidebar-foreground/40 truncate">
                    {item.subtitle}
                  </span>
                </div>
              </button>
            ))}
          </div>
        </div>
      </ScrollArea>

      <div className="border-t border-sidebar-border p-2 flex flex-col gap-0.5">
        {isPlatformAdmin && (
          <>
            <div className="px-3 pb-1 pt-1 text-[10px] font-medium uppercase tracking-wide text-sidebar-foreground/35">
              Authoring
            </div>
            <button
              onClick={() => navigate('/workflows')}
              className={cn(
                'flex items-center gap-2.5 px-3 py-2 text-[13px] font-medium transition-colors rounded-md text-left w-full',
                isOnWorkflows
                  ? 'bg-sidebar-accent text-sidebar-foreground'
                  : 'text-sidebar-foreground/60 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground',
              )}
            >
              <Workflow className="h-3.5 w-3.5 shrink-0" />
              Workflows
            </button>
            <button
              onClick={() => navigate('/blocks/stage')}
              className={cn(
                'flex items-center gap-2.5 px-3 py-2 text-[13px] font-medium transition-colors rounded-md text-left w-full',
                isOnBlocks
                  ? 'bg-sidebar-accent text-sidebar-foreground'
                  : 'text-sidebar-foreground/60 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground',
              )}
            >
              <Blocks className="h-3.5 w-3.5 shrink-0" />
              Block Library
            </button>
            <div className="my-1 h-px bg-sidebar-border" />
            <button
              onClick={() => navigate('/admin')}
              className={cn(
                'flex items-center gap-2.5 px-3 py-2 text-[13px] font-medium transition-colors rounded-md text-left w-full',
                isOnAdmin
                  ? 'bg-sidebar-accent text-sidebar-foreground'
                  : 'text-sidebar-foreground/60 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground',
              )}
            >
              <Settings className="h-3.5 w-3.5 shrink-0" />
              Admin & Settings
            </button>
          </>
        )}
      </div>

      {showCreateProject && (
        <CreateProjectModal onClose={() => setShowCreateProject(false)} onCreated={refresh} />
      )}
    </div>
  );
}

function IterationStatusIcon({ status }: { status: EffectiveSprintStatus }) {
  switch (status) {
    case 'running':
      return <Loader2 className="h-3.5 w-3.5 text-agent-running animate-spin shrink-0" />;
    case 'waiting':
      return <MessageCircleQuestion className="h-3.5 w-3.5 text-agent-waiting shrink-0" />;
    case 'failed':
      return <XCircle className="h-3.5 w-3.5 text-agent-error shrink-0" />;
    case 'passed':
    case 'completed':
      return <CheckCircle2 className="h-3.5 w-3.5 text-agent-success shrink-0" />;
    default:
      return <Activity className="h-3.5 w-3.5 text-sidebar-foreground/40 shrink-0" />;
  }
}
