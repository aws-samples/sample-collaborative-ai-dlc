import { Outlet, useParams } from 'react-router-dom';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AppSidebar } from '@/components/layout/AppSidebar';
import { AppHeader } from '@/components/layout/AppHeader';
import { ActivityPanel } from '@/components/layout/ActivityPanel';
import { StatusBar } from '@/components/layout/StatusBar';
import { CommandPalette } from '@/components/layout/CommandPalette';
import { useProjectSprintsCache } from '@/hooks/useProjectsCache';
import { useState, useCallback, useMemo, useEffect } from 'react';

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
          className="flex-1 overflow-hidden grid"
          style={{
            gridTemplateColumns: [
              showSidebar ? '240px' : '',
              '1fr',
              showActivity ? 'minmax(280px, 360px)' : '',
            ]
              .filter(Boolean)
              .join(' '),
          }}
        >
          {showSidebar && (
            <aside className="hidden md:flex border-r overflow-hidden">
              <AppSidebar />
            </aside>
          )}

          <main className="h-full overflow-y-auto min-w-0">
            <Outlet />
          </main>

          {showActivity && (
            <aside className="hidden lg:flex overflow-hidden">
              <ActivityPanel
                sprintId={latestActiveSprintId ?? undefined}
                projectId={projectId}
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
