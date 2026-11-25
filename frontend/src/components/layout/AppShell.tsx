import {
  SpacePermissionsProvider,
  SpacePermissionsNotice,
} from '@/contexts/SpacePermissionsContext';
import { Outlet, useParams, useLocation, useSearchParams } from 'react-router';
import { cn } from '@/lib/utils';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { AppSidebar } from '@/components/layout/AppSidebar';
import { AppHeader } from '@/components/layout/AppHeader';
import { ACTIVITY_PANEL_ID } from '@/components/layout/activityPanelId';
import { detectSection } from '@/components/layout/IntentPipelineBar';
// Lazy: the activity panels pull react-markdown (+ transitively heavy deps)
// that don't belong in the eager main chunk — they only render when a side
// panel is open on sprint/intent routes.
const ActivityPanel = lazy(() =>
  import('@/components/layout/ActivityPanel').then((m) => ({
    default: m.ActivityPanel,
  })),
);
const IntentActivityPanel = lazy(() =>
  import('@/components/layout/IntentActivityPanel').then((m) => ({
    default: m.IntentActivityPanel,
  })),
);
// Lazy: the v1 sprint bar (and its v1 services/hooks) only renders on sprint
// routes; v2 pages must not pay for it in the shell chunk.
const SprintPipelineBar = lazyWithPreload(() =>
  import('@/components/layout/SprintPipelineBar').then((m) => ({
    default: m.SprintPipelineBar,
  })),
);
import { StatusBar } from '@/components/layout/StatusBar';
import { CommandPalette } from '@/components/layout/CommandPalette';
import { DiscussionProvider } from '@/components/discussion/DiscussionProvider';
import { IntentProvider } from '@/contexts/IntentContext';
import { useProjectSprintsCache, useProjectsCache } from '@/hooks/useProjectsCache';
import { CreateProjectModal } from '@/components/CreateProjectModal';
import { useState, useCallback, useMemo, useEffect, useRef, lazy, Suspense } from 'react';
import { PANELS_INLINE_MIN_WIDTH, usePanelsInline } from '@/hooks/usePanelsInline';
import { isGitProvider, type GitProvider } from '@/services/gitProvider';
import { useResizablePanel } from '@/hooks/useResizablePanel';
import { lazyWithPreload } from '@/lib/lazyWithPreload';
import { setLastIntentSection } from '@/lib/intentSectionPreference';
import { useLayoutEffect } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { installNavIntent } from '@/lib/navIntent';
import { notifyNavigation } from '@/lib/routePrefetch';
import { useIdleNext } from '@/hooks/useIdleNext';

// ---------------------------------------------------------------------------
// Route classification: determines whether the activity panel should default
// open (Work routes) or closed (non-work intent sections, top-level pages).
// Exported for testing.
// ---------------------------------------------------------------------------

const NON_WORK_SUFFIXES = ['/graph', '/audit', '/compose', '/observability'];

/** True when the given pathname represents a "work" route where the panel opens. */
export function shouldDefaultOpen(pathname: string): boolean {
  // Sprint routes are always work routes.
  if (/\/sprint\//.test(pathname)) return true;
  // Intent creation is a focused form, not an active intent workspace.
  if (/\/intent\/new(?:\/|$)/.test(pathname)) return false;
  // Intent routes: open unless the path ends with a non-work section.
  if (/\/intent\//.test(pathname)) {
    return !NON_WORK_SUFFIXES.some((suffix) => pathname.endsWith(suffix));
  }
  // Top-level (dashboard, observability, blocks, etc.) — panel hidden anyway.
  return false;
}

// Below PANELS_INLINE_MIN_WIDTH (hooks/usePanelsInline) BOTH side panels
// render as NON-modal overlays above the content instead of grid columns. One
// shared breakpoint keeps the two panels' behavior consistent, and the
// activity overlay never opens by itself there — it would cover the page (W1).
export { PANELS_INLINE_MIN_WIDTH };

export const ACTIVITY_PANEL_OPEN_STORAGE_KEY = 'aidlc-activity-panel-open';

export { ACTIVITY_PANEL_ID };

export const MAIN_CONTENT_ID = 'main-content';

const RESIZE_HANDLE_CLASS =
  'absolute inset-y-0 z-10 w-1.5 cursor-col-resize touch-none hover:bg-primary/30 active:bg-primary/40 focus-visible:bg-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring';

/**
 * Initial open state of the activity panel. Narrow viewports always start
 * closed; wide viewports honor the persisted desktop preference when there is
 * one, otherwise the route default.
 */
export function shouldActivityPanelDefaultOpen({
  width,
  persisted,
  route,
}: {
  width: number;
  persisted: boolean | null | undefined;
  route: string;
}): boolean {
  if (width < PANELS_INLINE_MIN_WIDTH) return false;
  return persisted ?? shouldDefaultOpen(route);
}

function readPersistedActivityPanelOpen(): boolean | null {
  try {
    const raw = window.localStorage.getItem(ACTIVITY_PANEL_OPEN_STORAGE_KEY);
    return raw === null ? null : raw === 'true';
  } catch {
    return null;
  }
}

function writePersistedActivityPanelOpen(open: boolean) {
  try {
    window.localStorage.setItem(ACTIVITY_PANEL_OPEN_STORAGE_KEY, String(open));
  } catch {
    // Storage unavailable (private mode, quota): the preference is session-only.
  }
}

// Side panel sizing: user-resizable on large screens (drag the inner edge,
// double-click to reset), persisted across sessions.
// The activity panel can grow until only the sidebar and MAIN_MIN_WIDTH of
// main content are left, so wide previews (tables, diagrams) fit beside it.
const ACTIVITY_PANEL_SIZING = {
  storageKey: 'aidlc-activity-panel-width',
  defaultWidth: 380,
  minWidth: 300,
  maxWidth: Number.POSITIVE_INFINITY,
  viewportFraction: 1,
  anchor: 'right',
} as const;
const MAIN_MIN_WIDTH = 360;

const SIDEBAR_SIZING = {
  storageKey: 'aidlc-sidebar-width',
  defaultWidth: 260,
  minWidth: 200,
  maxWidth: 420,
  viewportFraction: 0.3,
  anchor: 'left',
} as const;

export function AppShell() {
  const { sprintId, projectId, intentId } = useParams<{
    sprintId: string;
    projectId: string;
    intentId: string;
  }>();
  const location = useLocation();
  const { user, isPlatformAdmin } = useAuth();
  const navContext = useRef({
    user: { isPlatformAdmin },
    currentHref: location.pathname + location.search,
  });
  useLayoutEffect(() => {
    navContext.current = {
      user: { isPlatformAdmin },
      currentHref: location.pathname + location.search,
    };
    if (user) notifyNavigation(navContext.current.currentHref, navContext.current.user);
  }, [location.key, location.pathname, location.search, user, isPlatformAdmin]);
  useEffect(() => {
    if (user) return installNavIntent(() => navContext.current);
  }, [user]);
  useIdleNext(Boolean(user), isPlatformAdmin);
  const inSprint = !!sprintId;
  // v2 intent pages get their own 3-tab activity panel (IntentActivityPanel),
  // mounted in the same slots as the sprint one and backed by IntentProvider.
  const inIntent = !!intentId;
  const onProjectPage = !!projectId && !inSprint && !inIntent;
  // Graph pages render a full-bleed canvas with their own toolbar: the shell's
  // content padding would float that toolbar mid-pane, so drop it there.
  const onGraphPage = location.pathname.endsWith('/graph');

  useEffect(() => {
    if (intentId) setLastIntentSection(intentId, detectSection(location.pathname));
  }, [intentId, location.pathname]);

  const panelsInline = usePanelsInline();
  // The Create space dialog lives here so it survives the sidebar unmounting
  // when the viewport crosses the inline breakpoint (R3-8), and so a
  // `?reopenCreateSpace=1` link (OAuth return, command palette, empty states)
  // opens it on whatever page the reader lands.
  const [createSpaceOpen, setCreateSpaceOpen] = useState(false);
  const [createSpaceProvider, setCreateSpaceProvider] = useState<GitProvider | ''>('');
  const [createSpaceInstance, setCreateSpaceInstance] = useState<string>();
  const openCreateSpace = useCallback(() => {
    setCreateSpaceProvider('');
    setCreateSpaceInstance(undefined);
    setCreateSpaceOpen(true);
  }, []);
  const { refresh: refreshProjects } = useProjectsCache();
  const [searchParams, setSearchParams] = useSearchParams();
  const onSpacesList = location.pathname === '/spaces';
  useEffect(() => {
    if (searchParams.get('reopenCreateSpace') !== '1') return;
    // On large screens /spaces redirects to My work with its query intact: let
    // the flag travel with it instead of stripping it here first.
    if (panelsInline && onSpacesList) return;
    const provider = searchParams.get('gitProvider');
    setCreateSpaceProvider(isGitProvider(provider) ? provider : '');
    setCreateSpaceInstance(searchParams.get('gitlabInstance') || undefined);
    setCreateSpaceOpen(true);
    const rest = new URLSearchParams(searchParams);
    rest.delete('reopenCreateSpace');
    rest.delete('gitProvider');
    rest.delete('gitlabInstance');
    setSearchParams(rest, { replace: true });
  }, [searchParams, setSearchParams, panelsInline, onSpacesList]);

  // On a project page (not in a sprint) the activity panel surfaces the
  // latest active sprint so it stays useful outside a sprint context.
  const { sprints: projectSprints } = useProjectSprintsCache(onProjectPage ? projectId : null);
  const latestActiveSprintId = useMemo(() => {
    if (inSprint) return sprintId;
    const active = projectSprints.find(
      (s) => s.currentAgentStatus === 'running' || s.currentAgentStatus === 'waiting',
    );
    return active?.id ?? projectSprints[0]?.id ?? null;
  }, [inSprint, sprintId, projectSprints]);

  const [activityPanelOpen, setActivityPanelOpen] = useState(() =>
    shouldActivityPanelDefaultOpen({
      width: window.innerWidth,
      persisted: readPersistedActivityPanelOpen(),
      route: location.pathname,
    }),
  );
  const [desktopSidebarCollapsed, setDesktopSidebarCollapsed] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const sidebarCollapsed = panelsInline ? desktopSidebarCollapsed : !mobileSidebarOpen;
  const sidebarPanel = useResizablePanel(SIDEBAR_SIZING);
  const activityPanel = useResizablePanel({
    ...ACTIVITY_PANEL_SIZING,
    reserveWidth:
      MAIN_MIN_WIDTH +
      (sidebarCollapsed ? 0 : Math.min(sidebarPanel.width, Math.round(window.innerWidth * 0.3))),
  });
  const activityOverlayRef = useRef<HTMLElement | null>(null);
  const activityReturnFocusRef = useRef<HTMLElement | null>(null);
  const shouldFocusActivityOverlayRef = useRef(false);

  // Track the route category so the panel default reapplies on section
  // navigation but not on every render — preserves manual toggle. The first
  // run only records the category: the initial state already applied the
  // viewport rule, and re-applying the route default here would pop the
  // overlay open on narrow screens.
  const prevRouteDefault = useRef<boolean | null>(null);
  useEffect(() => {
    const nextDefault = shouldDefaultOpen(location.pathname);
    if (prevRouteDefault.current === null) {
      prevRouteDefault.current = nextDefault;
      return;
    }
    if (nextDefault !== prevRouteDefault.current) {
      prevRouteDefault.current = nextDefault;
      setActivityPanelOpen(
        shouldActivityPanelDefaultOpen({
          width: window.innerWidth,
          persisted: null,
          route: location.pathname,
        }),
      );
    }
  }, [location.pathname]);

  const showSidebar = !sidebarCollapsed;
  const showActivity = (inSprint || inIntent || onProjectPage) && activityPanelOpen;

  const toggleSidebar = useCallback(() => {
    if (panelsInline) setDesktopSidebarCollapsed((prev) => !prev);
    else setMobileSidebarOpen((prev) => !prev);
  }, [panelsInline]);
  const closeMobileSidebar = useCallback(() => {
    setMobileSidebarOpen(false);
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLElement>('#sidebar-toggle')?.focus();
    });
  }, []);

  // A drawer belongs to the current narrow-screen view. Close it when the
  // user navigates, switches back to the inline desktop layout, or opens the
  // Create space dialog (the modal drawer would keep it behind its scrim and
  // outside its focus trap).
  useEffect(() => {
    setMobileSidebarOpen(false);
  }, [location.key, panelsInline, createSpaceOpen]);

  // Below the breakpoint the activity panel is an overlay that never opens by
  // itself (W1): a panel docked in a wider window closes when it narrows.
  const wasPanelsInline = useRef(panelsInline);
  useEffect(() => {
    if (wasPanelsInline.current && !panelsInline) setActivityPanelOpen(false);
    wasPanelsInline.current = panelsInline;
  }, [panelsInline]);

  const closeActivityPanel = useCallback(() => {
    setActivityPanelOpen(false);
    shouldFocusActivityOverlayRef.current = false;
    const returnFocus = activityReturnFocusRef.current;
    activityReturnFocusRef.current = null;
    if (!returnFocus) return;
    window.requestAnimationFrame(() => {
      if (returnFocus.isConnected) returnFocus.focus();
    });
  }, []);
  // Opening a discussion pops the activity panel (the thread renders there).
  const showActivityPanel = useCallback(() => {
    if (!activityPanelOpen && !panelsInline) {
      const activeElement = document.activeElement;
      activityReturnFocusRef.current =
        activeElement instanceof HTMLElement && activeElement !== document.body
          ? activeElement
          : null;
      shouldFocusActivityOverlayRef.current = true;
    }
    setActivityPanelOpen(true);
  }, [activityPanelOpen, panelsInline]);
  const toggleActivity = useCallback(() => {
    if (panelsInline) writePersistedActivityPanelOpen(!activityPanelOpen);
    if (activityPanelOpen) closeActivityPanel();
    else showActivityPanel();
  }, [activityPanelOpen, closeActivityPanel, panelsInline, showActivityPanel]);

  useEffect(() => {
    if (!showActivity || panelsInline || !shouldFocusActivityOverlayRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      const overlay = activityOverlayRef.current;
      if (!overlay) return;
      const closeButton = overlay.querySelector<HTMLElement>('[aria-label="Close activity panel"]');
      (closeButton ?? overlay).focus();
      shouldFocusActivityOverlayRef.current = false;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [panelsInline, showActivity]);

  // Grid columns only contain panels that render INLINE at the current
  // breakpoint — overlay panels must not reserve track space.
  const sidebarColumn = `min(${sidebarPanel.width}px, 30vw)`;
  const gridColumns = [
    showSidebar && panelsInline ? sidebarColumn : null,
    'minmax(0, 1fr)',
    // Never wider than what leaves the sidebar and MAIN_MIN_WIDTH, also after
    // the window shrinks below a stored width.
    showActivity && panelsInline
      ? `min(${activityPanel.width}px, max(${ACTIVITY_PANEL_SIZING.minWidth}px, calc(100vw - ${
          showSidebar ? `${sidebarColumn} - ` : ''
        }${MAIN_MIN_WIDTH}px)))`
      : null,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <SpacePermissionsProvider projectId={projectId}>
      <TooltipProvider delayDuration={200}>
        {/* DiscussionProvider sits above BOTH the routed pages and the
          ActivityPanel so the Discussions tab, the entry-point buttons, the
          panel-hosted thread and the mention toasts share one state.
          IntentProvider is likewise always mounted (inert off intent routes)
          so the routed IntentView and the AppShell-hosted IntentActivityPanel
          share one fetch/realtime/output-buffer state. */}
        <DiscussionProvider onDiscussionOpen={showActivityPanel}>
          <IntentProvider onAgentFocus={showActivityPanel}>
            <div className="flex h-screen flex-col bg-background">
              <a
                href={`#${MAIN_CONTENT_ID}`}
                onClick={(event) => {
                  event.preventDefault();
                  document.getElementById(MAIN_CONTENT_ID)?.focus();
                }}
                className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-primary-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
              >
                Skip to content
              </a>
              {/* Header */}
              <AppHeader
                onToggleSidebar={toggleSidebar}
                onToggleActivity={toggleActivity}
                onOpenCommand={() => setCommandOpen(true)}
                sidebarCollapsed={sidebarCollapsed}
                activityPanelOpen={activityPanelOpen}
              />
              <SpacePermissionsNotice />

              {/* Main content area (relative: hosts the small-screen overlays,
              clipped between header and status bar) */}
              <div
                className="relative flex-1 overflow-hidden grid"
                style={{ gridTemplateColumns: gridColumns }}
              >
                {/* Sidebar - inline column on lg+, with a resize handle */}
                {showSidebar && panelsInline && (
                  <aside
                    id="app-sidebar"
                    aria-label="Main navigation"
                    className="relative flex border-r overflow-hidden"
                  >
                    <AppSidebar onCreateSpace={openCreateSpace} />
                    <div
                      role="separator"
                      aria-orientation="vertical"
                      aria-label="Resize sidebar"
                      aria-controls="app-sidebar"
                      aria-valuenow={sidebarPanel.width}
                      aria-valuemin={SIDEBAR_SIZING.minWidth}
                      aria-valuemax={SIDEBAR_SIZING.maxWidth}
                      aria-valuetext={`${sidebarPanel.width} pixels`}
                      tabIndex={0}
                      onPointerDown={sidebarPanel.handleResizeStart}
                      onKeyDown={sidebarPanel.handleResizeKey}
                      onDoubleClick={sidebarPanel.resetWidth}
                      className={cn(RESIZE_HANDLE_CLASS, 'right-0')}
                    />
                  </aside>
                )}

                {/* Main content */}
                <main
                  id={MAIN_CONTENT_ID}
                  tabIndex={-1}
                  className="h-full overflow-hidden min-w-0 flex flex-col outline-none"
                >
                  {inSprint && (
                    <Suspense fallback={<div aria-hidden="true" className="h-11 border-b" />}>
                      <SprintPipelineBar />
                    </Suspense>
                  )}
                  <div
                    className={cn(
                      'flex-1 overflow-y-auto min-w-0',
                      onGraphPage ? 'overflow-hidden' : 'px-6 py-6',
                    )}
                  >
                    <Outlet />
                  </div>
                </main>

                {/* Activity panel - inline column on lg+, with a resize handle */}
                {showActivity && panelsInline && (
                  <aside
                    id={ACTIVITY_PANEL_ID}
                    aria-label="Activity panel"
                    className="relative flex min-w-0 overflow-hidden border-l border-border shadow-[-4px_0_12px_-4px_rgba(0,0,0,0.08)] dark:shadow-[-4px_0_12px_-4px_rgba(0,0,0,0.4)]"
                  >
                    <div
                      role="separator"
                      aria-orientation="vertical"
                      aria-label="Resize activity panel"
                      aria-controls={ACTIVITY_PANEL_ID}
                      aria-valuenow={activityPanel.width}
                      aria-valuemin={ACTIVITY_PANEL_SIZING.minWidth}
                      aria-valuemax={activityPanel.effectiveMaxWidth}
                      aria-valuetext={`${activityPanel.width} pixels`}
                      tabIndex={0}
                      onPointerDown={activityPanel.handleResizeStart}
                      onKeyDown={activityPanel.handleResizeKey}
                      onDoubleClick={activityPanel.resetWidth}
                      className={cn(RESIZE_HANDLE_CLASS, 'left-0')}
                    />
                    {inIntent ? (
                      <Suspense fallback={null}>
                        <IntentActivityPanel onClose={closeActivityPanel} />
                      </Suspense>
                    ) : (
                      <Suspense fallback={null}>
                        <ActivityPanel
                          sprintId={inSprint ? sprintId : (latestActiveSprintId ?? undefined)}
                          onClose={closeActivityPanel}
                        />
                      </Suspense>
                    )}
                  </aside>
                )}

                {/* Small-screen navigation drawer: the shared Sheet brings the scrim,
                tap-outside and Escape to close, and focus return (R5-32). */}
                <Sheet
                  open={showSidebar && !panelsInline}
                  onOpenChange={(open) => !open && closeMobileSidebar()}
                >
                  <SheetContent
                    side="left"
                    id="app-sidebar"
                    aria-describedby={undefined}
                    className="flex w-72 max-w-[85vw] overflow-hidden p-0 [&>button]:hidden"
                  >
                    <SheetTitle className="sr-only">Main navigation</SheetTitle>
                    <AppSidebar variant="drawer" onCreateSpace={openCreateSpace} />
                  </SheetContent>
                </Sheet>
                {/* The activity overlay stays NON-modal: the content behind it
                remains visible and interactive. */}
                {showActivity && !panelsInline && (
                  <aside
                    ref={activityOverlayRef}
                    onKeyDown={(event) => {
                      if (event.key !== 'Escape' || event.defaultPrevented) return;
                      event.stopPropagation();
                      closeActivityPanel();
                    }}
                    id={ACTIVITY_PANEL_ID}
                    aria-label="Activity panel"
                    tabIndex={-1}
                    className="absolute inset-y-0 right-0 z-40 flex w-full max-w-md overflow-hidden bg-background shadow-2xl"
                  >
                    {inIntent ? (
                      <Suspense fallback={null}>
                        <IntentActivityPanel onClose={closeActivityPanel} />
                      </Suspense>
                    ) : (
                      <Suspense fallback={null}>
                        <ActivityPanel
                          sprintId={inSprint ? sprintId : (latestActiveSprintId ?? undefined)}
                          onClose={closeActivityPanel}
                        />
                      </Suspense>
                    )}
                  </aside>
                )}
              </div>

              {createSpaceOpen && (
                <CreateProjectModal
                  initialProvider={createSpaceProvider}
                  initialInstance={createSpaceInstance}
                  onClose={() => setCreateSpaceOpen(false)}
                  onCreated={refreshProjects}
                />
              )}

              {/* Status bar */}
              <StatusBar />

              {/* Command palette */}
              <CommandPalette
                open={commandOpen}
                onOpenChange={setCommandOpen}
                onCreateSpace={openCreateSpace}
              />
            </div>
          </IntentProvider>
        </DiscussionProvider>
      </TooltipProvider>
    </SpacePermissionsProvider>
  );
}
