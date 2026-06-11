import { Outlet, useParams } from 'react-router-dom';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AppSidebar } from '@/components/layout/AppSidebar';
import { AppHeader } from '@/components/layout/AppHeader';
import { ActivityPanel } from '@/components/layout/ActivityPanel';
import { StatusBar } from '@/components/layout/StatusBar';
import { CommandPalette } from '@/components/layout/CommandPalette';
import { DiscussionProvider } from '@/components/discussion';
import { useState, useCallback, useEffect } from 'react';
import { useMediaQuery } from '@/hooks/useMediaQuery';

// Activity panel sizing: user-resizable on large screens (drag the left edge,
// double-click to reset), persisted across sessions.
const ACTIVITY_WIDTH_KEY = 'aidlc-activity-panel-width';
const ACTIVITY_WIDTH_DEFAULT = 380;
const ACTIVITY_WIDTH_MIN = 300;
const ACTIVITY_WIDTH_MAX = 640;

function clampActivityWidth(width: number): number {
  // Never let the panel eat more than ~45% of the viewport.
  const max = Math.min(ACTIVITY_WIDTH_MAX, Math.round(window.innerWidth * 0.45));
  return Math.min(Math.max(width, ACTIVITY_WIDTH_MIN), Math.max(max, ACTIVITY_WIDTH_MIN));
}

function loadActivityWidth(): number {
  const stored = Number(localStorage.getItem(ACTIVITY_WIDTH_KEY));
  return Number.isFinite(stored) && stored > 0
    ? clampActivityWidth(stored)
    : ACTIVITY_WIDTH_DEFAULT;
}

export function AppShell() {
  const { sprintId } = useParams<{ sprintId: string }>();
  const inSprint = !!sprintId;

  // Breakpoint (Tailwind lg): below it BOTH side panels render as NON-modal
  // overlays above the content instead of grid columns, so they stay usable
  // on tablets/phones without blocking the page behind them. One shared
  // breakpoint keeps the two panels' behavior consistent.
  const panelsInline = useMediaQuery('(min-width: 1024px)');

  // Small screens start with the panels closed (as overlays they'd cover the
  // content); large screens keep the previous always-open default.
  const [activityPanelOpen, setActivityPanelOpen] = useState(
    () => window.matchMedia('(min-width: 1024px)').matches,
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => !window.matchMedia('(min-width: 1024px)').matches,
  );
  const [commandOpen, setCommandOpen] = useState(false);
  const [activityWidth, setActivityWidth] = useState(loadActivityWidth);

  useEffect(() => {
    const timer = setTimeout(() => {
      localStorage.setItem(ACTIVITY_WIDTH_KEY, String(activityWidth));
    }, 250);
    return () => clearTimeout(timer);
  }, [activityWidth]);

  // Only show panels when inside a sprint
  const showSidebar = inSprint && !sidebarCollapsed;
  const showActivity = inSprint && activityPanelOpen;

  const toggleSidebar = useCallback(() => setSidebarCollapsed((prev) => !prev), []);
  const toggleActivity = useCallback(() => setActivityPanelOpen((prev) => !prev), []);
  // Opening a discussion pops the activity panel (the thread renders there).
  const showActivityPanel = useCallback(() => setActivityPanelOpen(true), []);

  // Drag-to-resize (large screens): pointer capture on the panel's left edge.
  const handleResizeStart = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const onMove = (ev: PointerEvent) => {
      setActivityWidth(clampActivityWidth(document.documentElement.clientWidth - ev.clientX));
    };
    const onEnd = () => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onEnd);
      handle.removeEventListener('pointercancel', onEnd);
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onEnd);
    handle.addEventListener('pointercancel', onEnd);
  }, []);

  const handleResizeKey = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const delta = e.key === 'ArrowLeft' ? 16 : -16;
      setActivityWidth((w) => clampActivityWidth(w + delta));
    }
  }, []);

  const resetActivityWidth = useCallback(() => setActivityWidth(ACTIVITY_WIDTH_DEFAULT), []);

  // Grid columns only contain panels that render INLINE at the current
  // breakpoint — overlay panels must not reserve track space.
  const gridColumns = [
    showSidebar && panelsInline ? 'minmax(240px, 280px)' : null,
    'minmax(0, 1fr)',
    showActivity && panelsInline ? `min(${activityWidth}px, 45vw)` : null,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <TooltipProvider delayDuration={200}>
      {/* DiscussionProvider sits above BOTH the routed pages and the
          ActivityPanel so the Discussions tab, the entry-point buttons, the
          panel-hosted thread and the mention toasts share one state (plan §9). */}
      <DiscussionProvider onDiscussionOpen={showActivityPanel}>
        <div className="flex h-screen flex-col bg-background">
          {/* Header */}
          <AppHeader
            onToggleSidebar={toggleSidebar}
            onToggleActivity={toggleActivity}
            onOpenCommand={() => setCommandOpen(true)}
            sidebarCollapsed={sidebarCollapsed}
            activityPanelOpen={activityPanelOpen}
            inSprint={inSprint}
          />

          {/* Main content area (relative: hosts the small-screen overlays,
              clipped between header and status bar) */}
          <div
            className="relative flex-1 overflow-hidden grid"
            style={{ gridTemplateColumns: gridColumns }}
          >
            {/* Sidebar - inline column on lg+ */}
            {showSidebar && panelsInline && (
              <aside className="flex border-r overflow-hidden">
                <AppSidebar />
              </aside>
            )}

            {/* Main content */}
            <main className="h-full overflow-y-auto min-w-0">
              <Outlet />
            </main>

            {/* Activity panel - inline column on lg+, with a resize handle */}
            {showActivity && panelsInline && (
              <aside className="relative flex overflow-hidden">
                <div
                  role="separator"
                  aria-orientation="vertical"
                  aria-label="Resize activity panel"
                  tabIndex={0}
                  onPointerDown={handleResizeStart}
                  onKeyDown={handleResizeKey}
                  onDoubleClick={resetActivityWidth}
                  className="absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize touch-none hover:bg-primary/30 active:bg-primary/40 focus-visible:bg-primary/40 focus-visible:outline-none"
                />
                <ActivityPanel sprintId={sprintId} onClose={() => setActivityPanelOpen(false)} />
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
                <ActivityPanel sprintId={sprintId} onClose={() => setActivityPanelOpen(false)} />
              </aside>
            )}
          </div>

          {/* Status bar */}
          <StatusBar />

          {/* Command palette */}
          <CommandPalette open={commandOpen} onOpenChange={setCommandOpen} />
        </div>
      </DiscussionProvider>
    </TooltipProvider>
  );
}
