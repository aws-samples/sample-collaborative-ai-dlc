import { useNavigate, useParams, useLocation } from 'react-router-dom';
import {
  PanelLeftClose,
  PanelRightClose,
  PanelRightOpen,
  PanelLeftOpen,
  Search,
  ChevronRight,
  Settings,
  LogOut,
  Activity,
  Blocks,
  Workflow,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { ThemeToggle } from '@/components/theme/ThemeToggle';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useAuth } from '@/contexts/AuthContext';
import { PresenceAvatars } from '@/components/domain/PresenceAvatars';
import { type Project } from '@/services/projects';
import { type Sprint } from '@/services/sprints';
import { useProjectCache, useProjectSprintsCache } from '@/hooks/useProjectsCache';

interface AppHeaderProps {
  onToggleSidebar: () => void;
  onToggleActivity: () => void;
  onOpenCommand: () => void;
  sidebarCollapsed: boolean;
  activityPanelOpen: boolean;
  inSprint?: boolean;
}

export function AppHeader({
  onToggleSidebar,
  onToggleActivity,
  onOpenCommand,
  sidebarCollapsed,
  activityPanelOpen,
}: AppHeaderProps) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const params = useParams();
  const { project } = useProjectCache(params.projectId ?? null);
  const { sprints } = useProjectSprintsCache(
    params.projectId && params.sprintId ? params.projectId : null,
  );
  const sprint = params.sprintId ? (sprints.find((s) => s.id === params.sprintId) ?? null) : null;

  const breadcrumbs = buildBreadcrumbs(location.pathname, params, project, sprint);

  const initials = user?.displayName
    ? user.displayName
        .split(' ')
        .map((n: string) => n[0])
        .join('')
        .toUpperCase()
        .slice(0, 2)
    : user?.username?.slice(0, 2).toUpperCase() || '??';

  return (
    <header className="flex h-12 shrink-0 items-center border-b bg-background px-3 gap-2">
      {/* Sidebar toggle */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onToggleSidebar}>
            {sidebarCollapsed ? (
              <PanelLeftOpen className="h-4 w-4" />
            ) : (
              <PanelLeftClose className="h-4 w-4" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}</TooltipContent>
      </Tooltip>

      <Separator orientation="vertical" className="h-5" />

      {/* Logo */}
      <button
        onClick={() => navigate('/dashboard')}
        className="flex items-center gap-1.5 shrink-0 group"
      >
        <img src="/logo.svg" alt="AI-DLC" className="h-6 w-6" />
        <span className="text-sm font-semibold tracking-wide group-hover:text-foreground text-foreground/80 transition-colors">
          AI-DLC
        </span>
      </button>

      <Separator orientation="vertical" className="h-5" />

      {/* Breadcrumbs */}
      <nav className="flex items-center gap-1 text-sm min-w-0 flex-1">
        {breadcrumbs.map((crumb, i) => (
          <div key={i} className="flex items-center gap-1 min-w-0">
            {i > 0 && <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />}
            {crumb.href ? (
              <button
                onClick={() => navigate(crumb.href!)}
                className="text-muted-foreground hover:text-foreground transition-colors truncate max-w-[120px]"
              >
                {crumb.label}
              </button>
            ) : (
              <span className="text-foreground font-medium truncate max-w-[180px]">
                {crumb.label}
              </span>
            )}
          </div>
        ))}
      </nav>

      {/* Center: presence + search */}
      <div className="flex items-center gap-2">
        <PresenceAvatars />

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-2 text-muted-foreground text-xs px-2 min-w-[160px] justify-start"
              onClick={onOpenCommand}
            >
              <Search className="h-3 w-3" />
              <span>Search...</span>
              <kbd className="ml-auto pointer-events-none inline-flex h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground">
                <span className="text-xs">&#8984;</span>K
              </kbd>
            </Button>
          </TooltipTrigger>
          <TooltipContent>Command palette</TooltipContent>
        </Tooltip>
      </div>

      <Separator orientation="vertical" className="h-5" />

      {/* Right: theme + activity toggle + user */}
      <ThemeToggle />

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className={`h-7 w-7 ${location.pathname.startsWith('/blocks') ? 'text-primary bg-primary/10' : ''}`}
            onClick={() => navigate('/blocks')}
          >
            <Blocks className="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Building Blocks</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className={`h-7 w-7 ${location.pathname.startsWith('/workflows') ? 'text-primary bg-primary/10' : ''}`}
            onClick={() => navigate('/workflows')}
          >
            <Workflow className="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Workflows</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className={`h-7 w-7 ${location.pathname === '/observability' ? 'text-primary bg-primary/10' : ''}`}
            onClick={() => navigate('/observability')}
          >
            <Activity className="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Observability</TooltipContent>
      </Tooltip>

      {/* Activity panel toggle — sprint AND v2 intent routes host a panel. */}
      {(params.sprintId || params.intentId) && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onToggleActivity}>
              {activityPanelOpen ? (
                <PanelRightClose className="h-4 w-4" />
              ) : (
                <PanelRightOpen className="h-4 w-4" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{activityPanelOpen ? 'Hide activity' : 'Show activity'}</TooltipContent>
        </Tooltip>
      )}

      {/* User menu */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" className="h-7 w-7 rounded-full p-0">
            <Avatar className="h-7 w-7">
              <AvatarFallback className="text-[10px] bg-primary text-primary-foreground">
                {initials}
              </AvatarFallback>
            </Avatar>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <div className="px-2 py-1.5">
            <p className="text-sm font-medium">{user?.displayName || user?.username}</p>
            <p className="text-xs text-muted-foreground">{user?.email}</p>
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => navigate('/admin')}>
            <Settings className="mr-2 h-4 w-4" />
            Admin Panel
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={logout} className="text-destructive">
            <LogOut className="mr-2 h-4 w-4" />
            Log out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
}

interface Breadcrumb {
  label: string;
  href?: string;
}

function buildBreadcrumbs(
  pathname: string,
  params: Record<string, string | undefined>,
  project: Project | null,
  sprint: Sprint | null,
): Breadcrumb[] {
  // Admin panel - just "Admin"
  if (pathname === '/admin') {
    return [{ label: 'Admin' }];
  }

  // Dashboard - just "Projects"
  if (pathname === '/dashboard') {
    return [{ label: 'Projects' }];
  }

  // Observability
  if (pathname === '/observability') {
    return [{ label: 'Projects', href: '/dashboard' }, { label: 'Observability' }];
  }

  // Building Blocks library
  if (pathname.startsWith('/blocks')) {
    return [{ label: 'Building Blocks' }];
  }

  // Workflows
  if (pathname.startsWith('/workflows')) {
    const base = { label: 'Workflows', href: '/workflows' };
    return pathname === '/workflows' ? [{ label: 'Workflows' }] : [base, { label: 'Composer' }];
  }

  const crumbs: Breadcrumb[] = [{ label: 'Projects', href: '/dashboard' }];

  // Add project name if available
  if (params.projectId && project) {
    crumbs.push({ label: project.name, href: `/project/${params.projectId}` });
  }

  // Add sprint name and phase if available
  if (params.sprintId && params.projectId && sprint) {
    crumbs.push({
      label: sprint.name,
      href: `/project/${params.projectId}/sprint/${params.sprintId}`,
    });

    // Add phase as final crumb
    if (pathname.includes('/construction')) {
      crumbs.push({ label: 'Construction' });
    } else if (pathname.includes('/review')) {
      crumbs.push({ label: 'Review' });
    } else if (pathname.includes('/graph')) {
      crumbs.push({ label: 'Graph' });
    } else if (pathname.includes('/agent')) {
      crumbs.push({ label: 'Agent History' });
    } else {
      crumbs.push({ label: 'Inception' });
    }
  }

  if (pathname.includes('/settings')) {
    crumbs.push({ label: 'Settings' });
  }

  return crumbs;
}
