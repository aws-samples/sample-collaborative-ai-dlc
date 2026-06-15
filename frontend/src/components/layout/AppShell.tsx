import { Outlet, useParams } from 'react-router-dom';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AppSidebar } from '@/components/layout/AppSidebar';
import { AppHeader } from '@/components/layout/AppHeader';
import { SprintPipelineBar } from '@/components/layout/SprintPipelineBar';
import { ActivityPanel } from '@/components/layout/ActivityPanel';
import { StatusBar } from '@/components/layout/StatusBar';
import { CommandPalette } from '@/components/layout/CommandPalette';
import { useProjectSprintsCache } from '@/hooks/useProjectsCache';
import { useState, useCallback, useMemo, useEffect } from 'react';
import { cn } from '@/lib/utils';

export function AppShell() {
  const { sprintId, projectId } = useParams<{ sprintId: string; projectId: string }>();
  const inSprint = !!sprintId;
  const onProjectPage = !!projectId && !inSprint;

  const { sprints: projectSprints } = useProjectSprintsCache(onProjectPage ? projectId : null);
  const latestActiveSprintId = useMemo(() => {
    if (inSprint) return sprintId;
    const active = projectSprints.find(
      (s) => s.currentAgentStatus === 'running' || s.currentAgentStatus === 'waiting',
    );
    return active?.id ?? projectSprints[0]?.id ?? null;
  }, [inSprint, sprintId, projectSprints]);

  const [activityPanelOpen, setActivityPanelOpen] = useState(inSprint);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);

  useEffect(() => {
    setActivityPanelOpen(inSprint);
  }, [inSprint]);

  const showSidebar = !sidebarCollapsed;
  const showActivity = (inSprint || onProjectPage) && activityPanelOpen;

  const toggleSidebar = useCallback(() => setSidebarCollapsed((prev) => !prev), []);
  const toggleActivity = useCallback(() => setActivityPanelOpen((prev) => !prev), []);

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex h-screen flex-col bg-background">
        <AppHeader
          onToggleSidebar={toggleSidebar}
          onToggleActivity={toggleActivity}
          onOpenCommand={() => setCommandOpen(true)}
          sidebarCollapsed={sidebarCollapsed}
          activityPanelOpen={activityPanelOpen}
          inSprint={inSprint}
        />

        <div
          className={cn(
            'flex-1 overflow-hidden grid grid-cols-1',
            showSidebar && 'md:grid-cols-[240px_1fr]',
            showActivity && !showSidebar && 'lg:grid-cols-[1fr_minmax(280px,360px)]',
            showActivity && showSidebar && 'lg:grid-cols-[240px_1fr_minmax(280px,360px)]',
          )}
        >
          {showSidebar && (
            <aside className="hidden md:flex border-r overflow-hidden">
              <AppSidebar />
            </aside>
          )}

          <main className="h-full overflow-hidden min-w-0 flex flex-col">
            {inSprint && <SprintPipelineBar />}
            <div className="flex-1 overflow-y-auto min-w-0">
              <Outlet />
            </div>
          </main>

          {showActivity && (
            <aside className="hidden lg:flex overflow-hidden">
              <ActivityPanel
                sprintId={latestActiveSprintId ?? undefined}
                onClose={() => setActivityPanelOpen(false)}
              />
            </aside>
          )}
        </div>

        <StatusBar />
        <CommandPalette open={commandOpen} onOpenChange={setCommandOpen} />
      </div>
    </TooltipProvider>
  );
}
