import { Outlet, useParams, useLocation } from 'react-router-dom';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AppSidebar } from '@/components/layout/AppSidebar';
import { AppHeader } from '@/components/layout/AppHeader';
import { SprintPipelineBar } from '@/components/layout/SprintPipelineBar';
import { IntentPipelineBar } from '@/components/layout/IntentPipelineBar';
import { ActivityPanel } from '@/components/layout/ActivityPanel';
import { IntentActivityPanel } from '@/components/layout/IntentActivityPanel';
import { StatusBar } from '@/components/layout/StatusBar';
import { CommandPalette } from '@/components/layout/CommandPalette';
import { DiscussionProvider } from '@/components/discussion';
import { IntentProvider } from '@/contexts/IntentContext';
import { useProjectSprintsCache } from '@/hooks/useProjectsCache';
import { useState, useCallback, useMemo, useEffect } from 'react';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { useResizablePanel } from '@/hooks/useResizablePanel';

// Side panel sizing: user-resizable on large screens (drag the inner edge,
// double-click to reset), persisted across sessions.
const ACTIVITY_PANEL_SIZING = {
  storageKey: 'aidlc-activity-panel-width',
  defaultWidth: 380,
  minWidth: 300,
  maxWidth: 1200,
  viewportFraction: 0.45,
  anchor: 'right',
} as const;

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
  const inSprint = !!sprintId;
  // v2 intent pages get their own 3-tab activity panel (IntentActivityPanel),
  // mounted in the same slots as the sprint one and backed by IntentProvider.
  const inIntent = !!intentId;
  const onProjectPage = !!projectId && !inSprint && !inIntent;
  const onIntentSubPage =
    location.pathname.endsWith('/graph') ||
    location.pathname.endsWith('/observability') ||
    location.pathname.endsWith('/audit');
  // The compose page edits a DRAFT (no phase progress yet) and has its own
  // header Back — the phase-progress pipeline bar would render empty chips and
  // a duplicate Back, so suppress it there.
  const onComposePage = location.pathname.endsWith('/compose');
  const showPipelineBar = inIntent && !onIntentSubPage && !onComposePage;

  // Breakpoint (Tailwind lg): below it BOTH side panels render as NON-modal
  // overlays above the content instead of grid columns, so they stay usable
  // on tablets/phones without blocking the page behind them. One shared
  // breakpoint keeps the two panels' behavior consistent.
  const panelsInline = useMediaQuery('(min-width: 1024px)');

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

  // Small screens start with the panels closed (as overlays they'd cover the
  // content); large screens keep the previous always-open default.
  const [activityPanelOpen, setActivityPanelOpen] = useState(
    () => window.matchMedia('(min-width: 1024px)').matches,
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => !window.matchMedia('(min-width: 1024px)').matches,
  );
  const [commandOpen, setCommandOpen] = useState(false);
  const activityPanel = useResizablePanel(ACTIVITY_PANEL_SIZING);
  const sidebarPanel = useResizablePanel(SIDEBAR_SIZING);

  useEffect(() => {
    setActivityPanelOpen(inSprint || (inIntent && !onIntentSubPage));
  }, [inSprint, inIntent, onIntentSubPage]);

  const showSidebar = !sidebarCollapsed;
  const showActivity = (inSprint || inIntent || onProjectPage) && activityPanelOpen;

  const toggleSidebar = useCallback(() => setSidebarCollapsed((prev) => !prev), []);
  const toggleActivity = useCallback(() => setActivityPanelOpen((prev) => !prev), []);
  // Opening a discussion pops the activity panel (the thread renders there).
  const showActivityPanel = useCallback(() => setActivityPanelOpen(true), []);

  // Grid columns only contain panels that render INLINE at the current
  // breakpoint — overlay panels must not reserve track space.
  const gridColumns = [
    showSidebar && panelsInline ? `min(${sidebarPanel.width}px, 30vw)` : null,
    'minmax(0, 1fr)',
    showActivity && panelsInline ? `min(${activityPanel.width}px, 45vw)` : null,
  ]
    .filter(Boolean)
    .join(' ');

  return (
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
            {/* Header */}
            <AppHeader
              onToggleSidebar={toggleSidebar}
              onToggleActivity={toggleActivity}
              onOpenCommand={() => setCommandOpen(true)}
              sidebarCollapsed={sidebarCollapsed}
              activityPanelOpen={activityPanelOpen}
            />

            {/* Main content area (relative: hosts the small-screen overlays,
              clipped between header and status bar) */}
            <div
              className="relative flex-1 overflow-hidden grid"
              style={{ gridTemplateColumns: gridColumns }}
            >
              {/* Sidebar - inline column on lg+, with a resize handle */}
              {showSidebar && panelsInline && (
                <aside className="relative flex border-r overflow-hidden">
                  <AppSidebar />
                  <div
                    role="separator"
                    aria-orientation="vertical"
                    aria-label="Resize sidebar"
                    tabIndex={0}
                    onPointerDown={sidebarPanel.handleResizeStart}
                    onKeyDown={sidebarPanel.handleResizeKey}
                    onDoubleClick={sidebarPanel.resetWidth}
                    className="absolute inset-y-0 right-0 z-10 w-1.5 cursor-col-resize touch-none hover:bg-primary/30 active:bg-primary/40 focus-visible:bg-primary/40 focus-visible:outline-none"
                  />
                </aside>
              )}

              {/* Main content */}
              <main className="h-full overflow-hidden min-w-0 flex flex-col">
                {inSprint && <SprintPipelineBar />}
                {showPipelineBar && <IntentPipelineBar />}
                <div className="flex-1 overflow-y-auto min-w-0 px-6 py-6">
                  <Outlet />
                </div>
              </main>

              {/* Activity panel - inline column on lg+, with a resize handle */}
              {showActivity && panelsInline && (
                <aside className="relative flex min-w-0 overflow-hidden border-l border-border shadow-[-4px_0_12px_-4px_rgba(0,0,0,0.08)] dark:shadow-[-4px_0_12px_-4px_rgba(0,0,0,0.4)]">
                  <div
                    role="separator"
                    aria-orientation="vertical"
                    aria-label="Resize activity panel"
                    tabIndex={0}
                    onPointerDown={activityPanel.handleResizeStart}
                    onKeyDown={activityPanel.handleResizeKey}
                    onDoubleClick={activityPanel.resetWidth}
                    className="absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize touch-none hover:bg-primary/30 active:bg-primary/40 focus-visible:bg-primary/40 focus-visible:outline-none"
                  />
                  {inIntent ? (
                    <IntentActivityPanel onClose={() => setActivityPanelOpen(false)} />
                  ) : (
                    <ActivityPanel
                      sprintId={inSprint ? sprintId : (latestActiveSprintId ?? undefined)}
                      onClose={() => setActivityPanelOpen(false)}
                    />
                  )}
                </aside>
              )}

              {/* Small-screen overlays — NON-modal: no backdrop, the content
                behind stays visible and interactive. */}
              {showSidebar && !panelsInline && (
                <aside className="absolute inset-y-0 left-0 z-40 flex w-72 max-w-[85vw] overflow-hidden border-r bg-background shadow-2xl">
                  <AppSidebar />
                </aside>
              )}
              {showActivity && !panelsInline && (
                <aside className="absolute inset-y-0 right-0 z-40 flex w-full max-w-md overflow-hidden bg-background shadow-2xl">
                  {inIntent ? (
                    <IntentActivityPanel onClose={() => setActivityPanelOpen(false)} />
                  ) : (
                    <ActivityPanel
                      sprintId={inSprint ? sprintId : (latestActiveSprintId ?? undefined)}
                      onClose={() => setActivityPanelOpen(false)}
                    />
                  )}
                </aside>
              )}
            </div>

            {/* Status bar */}
            <StatusBar />

            {/* Command palette */}
            <CommandPalette open={commandOpen} onOpenChange={setCommandOpen} />
          </div>
        </IntentProvider>
      </DiscussionProvider>
    </TooltipProvider>
  );
}
