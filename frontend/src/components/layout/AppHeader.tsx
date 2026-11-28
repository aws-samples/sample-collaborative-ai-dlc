import { Link, useNavigate, useParams, useLocation } from 'react-router';
import {
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Search,
  ChevronLeft,
  ChevronRight,
  Settings,
  UserRoundCog,
  LogOut,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ACTIVITY_PANEL_ID } from '@/components/layout/activityPanelId';
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
import {
  getCachedIntentSummary,
  useProjectCache,
  useProjectSprintsCache,
} from '@/hooks/useProjectsCache';
import { useIntentOptional } from '@/contexts/IntentContext';
import { BrandMark } from '@/components/layout/BrandMark';
import { getBranding } from '@/lib/branding';
import { intentRowTitle } from '@/components/space/IntentRow';
import { prefetchHref, preloadHref } from '@/lib/routePrefetch';

const ACCOUNT_SETTINGS = '/account/settings';
const ADMIN = '/admin';

interface AppHeaderProps {
  onToggleSidebar: () => void;
  onToggleActivity: () => void;
  onOpenCommand: () => void;
  sidebarCollapsed: boolean;
  activityPanelOpen: boolean;
}

export function AppHeader({
  onToggleSidebar,
  onToggleActivity,
  onOpenCommand,
  sidebarCollapsed,
  activityPanelOpen,
}: AppHeaderProps) {
  const { user, logout, isPlatformAdmin } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const params = useParams();
  const prefetchUser = { isPlatformAdmin };
  // Opening the menu loads the settings pages' code; hovering or arrowing to
  // an item warms its data (the delegated listener reads data-prefetch-href);
  // selecting starts its reads before the route commits.
  const preloadSettingsChunks = () => {
    preloadHref(ACCOUNT_SETTINGS, prefetchUser);
    if (isPlatformAdmin) preloadHref(ADMIN, prefetchUser);
  };
  const openPage = (path: string) => {
    prefetchHref(path, { trigger: 'pointerdown', user: prefetchUser });
    navigate(path);
  };
  const { project } = useProjectCache(params.projectId ?? null);
  const { sprints } = useProjectSprintsCache(
    params.projectId && params.sprintId ? params.projectId : null,
  );
  const sprint = params.sprintId ? (sprints.find((s) => s.id === params.sprintId) ?? null) : null;
  // Optional: the header also renders on routes that have no intent in
  // scope, and must never depend on the provider being mounted.
  const intentCtx = useIntentOptional();
  const intentDetail = intentCtx?.detail ?? null;
  const intentTitle = intentDetail
    ? intentRowTitle(intentDetail.intent)
    : intentCtx?.notFound
      ? INTENT_NOT_FOUND_CRUMB
      : params.projectId && params.intentId
        ? (getCachedIntentSummary(params.projectId, params.intentId)?.title ?? null)
        : null;

  const breadcrumbs = buildBreadcrumbs(location.pathname, params, project, sprint, intentTitle);
  // Small screens cannot fit the trail: one back link, to the space when the
  // page belongs to one (the intent's own pages are siblings, not parents),
  // otherwise to the nearest parent.
  const parents = breadcrumbs.slice(0, -1);
  const parentCrumb =
    parents.find((crumb) => crumb.href && /^\/space\/[^/]+$/.test(crumb.href)) ??
    parents.toReversed().find((crumb) => crumb.href);
  const currentCrumb = breadcrumbs[breadcrumbs.length - 1];

  const initials = user?.displayName
    ? user.displayName
        .split(' ')
        .map((n: string) => n[0])
        .join('')
        .toUpperCase()
        .slice(0, 2)
    : user?.username?.slice(0, 2).toUpperCase() || '??';

  return (
    <header className="flex h-12 shrink-0 items-center border-b bg-background px-2 gap-1 sm:px-3 sm:gap-2">
      {/* Sidebar toggle */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={onToggleSidebar}
            aria-label="Toggle sidebar"
            aria-expanded={!sidebarCollapsed}
            id="sidebar-toggle"
          >
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

      {/* Logo: the visible wordmark text names the link, so the image is decorative */}
      <Link
        to="/dashboard"
        className="flex items-center gap-1.5 shrink-0 group rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <BrandMark
          wordmarkClassName="h-5"
          decorative
          fallback={<img src={getBranding().logo} alt="" className="h-6 w-6" />}
        />
        <span className="text-sm font-semibold tracking-wide group-hover:text-foreground text-foreground/80 transition-colors">
          AI-DLC
        </span>
      </Link>

      <Separator orientation="vertical" className="h-5" />

      {/* Breadcrumbs */}
      <nav aria-label="Breadcrumb" className="flex items-center text-sm min-w-0 flex-1">
        {parentCrumb ? (
          <Link
            to={parentCrumb.href!}
            aria-label={`Back to ${parentCrumb.label}`}
            className="flex min-h-6 items-center gap-0.5 min-w-0 rounded-md text-muted-foreground hover:text-foreground transition-colors sm:hidden"
          >
            <ChevronLeft className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="truncate">{parentCrumb.label}</span>
          </Link>
        ) : currentCrumb ? (
          <span aria-current="page" className="truncate font-medium text-foreground sm:hidden">
            {currentCrumb.label}
          </span>
        ) : null}
        <ol className="hidden items-center gap-1 min-w-0 sm:flex">
          {breadcrumbs.map((crumb, i) => {
            const isLast = i === breadcrumbs.length - 1;
            return (
              <li key={i} className="flex items-center gap-1 min-w-0">
                {i > 0 && (
                  <ChevronRight
                    className="h-3 w-3 text-muted-foreground shrink-0"
                    aria-hidden="true"
                  />
                )}
                {crumb.href && !isLast ? (
                  <Link
                    to={crumb.href}
                    className="inline-flex min-h-6 items-center text-muted-foreground hover:text-foreground transition-colors truncate max-w-[160px]"
                  >
                    {crumb.label}
                  </Link>
                ) : (
                  <span
                    aria-current={isLast ? 'page' : undefined}
                    className="text-foreground font-medium truncate max-w-[220px]"
                  >
                    {crumb.label}
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      </nav>

      {/* Center: presence + search */}
      <div className="flex items-center gap-2">
        <PresenceAvatars />

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="h-7 w-7 p-0 text-muted-foreground text-xs sm:w-auto sm:min-w-[160px] sm:justify-start sm:gap-2 sm:px-2"
              onClick={onOpenCommand}
            >
              <Search className="h-3 w-3" aria-hidden="true" />
              {/* Visible at >= sm; below sm the icon-only button keeps the same name. */}
              <span className="sr-only sm:not-sr-only">Search</span>
              <kbd
                aria-hidden="true"
                className="ml-auto pointer-events-none hidden sm:inline-flex h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-2xs font-medium text-muted-foreground"
              >
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

      {(params.sprintId || params.intentId) && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={onToggleActivity}
              aria-label="Toggle activity panel"
              aria-expanded={activityPanelOpen}
              aria-controls={ACTIVITY_PANEL_ID}
            >
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
      <DropdownMenu onOpenChange={(open) => open && preloadSettingsChunks()}>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" className="h-7 w-7 rounded-full p-0" aria-label="User menu">
            <Avatar className="h-7 w-7">
              <AvatarFallback className="text-2xs font-medium bg-primary text-primary-foreground">
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
          <DropdownMenuItem
            data-prefetch-href={ACCOUNT_SETTINGS}
            onSelect={() => openPage(ACCOUNT_SETTINGS)}
          >
            <UserRoundCog className="mr-2 h-4 w-4" />
            Account settings
          </DropdownMenuItem>
          {isPlatformAdmin && (
            <>
              <DropdownMenuItem data-prefetch-href={ADMIN} onSelect={() => openPage(ADMIN)}>
                <Settings className="mr-2 h-4 w-4" />
                Admin panel
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
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

const INTENT_NOT_FOUND_CRUMB = 'Intent not found';

function buildBreadcrumbs(
  pathname: string,
  params: Record<string, string | undefined>,
  project: Project | null,
  sprint: Sprint | null,
  intentTitle: string | null,
): Breadcrumb[] {
  // Admin panel - just "Platform Admin"
  if (pathname === '/admin') {
    return [{ label: 'Platform Admin' }];
  }

  if (pathname === '/account/settings') {
    return [{ label: 'Account Settings' }];
  }

  if (pathname === '/dashboard' || pathname === '/spaces') {
    return [{ label: 'Spaces' }];
  }

  if (pathname === '/my-work') {
    return [{ label: 'My work' }];
  }

  // Observability is a top-level page, not a child of Spaces
  if (pathname === '/observability') {
    return [{ label: 'Observability' }];
  }

  // Block Library
  if (pathname.startsWith('/blocks')) {
    return [{ label: 'Block Library' }];
  }

  // Workflows
  if (pathname.startsWith('/workflows')) {
    const base = { label: 'Workflows', href: '/workflows' };
    return pathname === '/workflows' ? [{ label: 'Workflows' }] : [base, { label: 'Composer' }];
  }

  if (!/^\/(space|project)\//.test(pathname)) {
    return [{ label: 'Page not found' }];
  }

  const crumbs: Breadcrumb[] = [{ label: 'Spaces', href: '/dashboard' }];

  // Add project name if available
  if (params.projectId && project) {
    crumbs.push({ label: project.name, href: `/space/${params.projectId}` });
  }

  if (params.projectId && /\/intent\/new(?:\/|$)/.test(pathname)) {
    crumbs.push({ label: 'New intent' });
    return crumbs;
  }

  // Intent routes: Spaces > Space > Intent > section
  if (params.intentId && params.projectId) {
    const intentLabel = intentTitle || 'Intent';
    const intentHref = `/space/${params.projectId}/intent/${params.intentId}`;

    if (intentTitle === INTENT_NOT_FOUND_CRUMB) {
      crumbs.push({ label: INTENT_NOT_FOUND_CRUMB });
    } else if (pathname.endsWith('/observability')) {
      crumbs.push({ label: intentLabel, href: intentHref });
      crumbs.push({ label: 'Overview' });
    } else if (pathname.endsWith('/audit')) {
      crumbs.push({ label: intentLabel, href: intentHref });
      crumbs.push({ label: 'Audit' });
    } else if (pathname.endsWith('/graph')) {
      crumbs.push({ label: intentLabel, href: intentHref });
      crumbs.push({ label: 'Graph' });
    } else if (pathname.endsWith('/compose')) {
      crumbs.push({ label: intentLabel, href: intentHref });
      crumbs.push({ label: 'Compose' });
    } else if (pathname.includes('/review/')) {
      crumbs.push({ label: intentLabel, href: intentHref });
      crumbs.push({ label: 'Review' });
    } else {
      crumbs.push({ label: intentLabel, href: intentHref });
      crumbs.push({ label: 'Work' });
    }
    return crumbs;
  }

  // Add sprint name and phase if available
  if (params.sprintId && params.projectId && sprint) {
    crumbs.push({
      label: sprint.name,
      href: `/space/${params.projectId}/sprint/${params.sprintId}`,
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
