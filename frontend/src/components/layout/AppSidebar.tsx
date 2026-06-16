import { useNavigate, useParams, useLocation } from 'react-router-dom';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import { Settings, ArrowLeft } from 'lucide-react';
import { PipelineView } from '@/components/layout/PipelineView';
import { useState, useEffect, useCallback } from 'react';
import { sprintsService, type Sprint } from '@/services/sprints';
import { realtimeService } from '@/services/realtime';
import { getSprintPhasePath } from '@/lib/sprintPhaseNavigation';

export function AppSidebar() {
  const navigate = useNavigate();
  const params = useParams();
  const location = useLocation();
  const [sprint, setSprint] = useState<Sprint | null>(null);

  const projectId = params.projectId || '';
  const sprintId = params.sprintId || '';

  const loadSprint = useCallback(async () => {
    if (!projectId || !sprintId) return;
    try {
      const data = await sprintsService.get(projectId, sprintId);
      setSprint(data);
    } catch (err) {
      console.error('Failed to load sprint:', err);
    }
  }, [projectId, sprintId]);

  useEffect(() => {
    loadSprint();
  }, [loadSprint]);

  // Re-fetch sprint on agent/phase events and auto-navigate on phase change
  useEffect(() => {
    if (!sprintId) return;
    const unsubs = [
      realtimeService.on('agent.started', () => loadSprint()),
      realtimeService.on('agent.completed', () => loadSprint()),
      realtimeService.on('agent.error', () => loadSprint()),
      realtimeService.on('sprint.phaseChanged', (data: { phase?: string }) => {
        loadSprint();
        const nextPath = data.phase ? getSprintPhasePath(projectId, sprintId, data.phase) : null;
        if (nextPath) navigate(nextPath);
      }),
    ];
    return () => unsubs.forEach((unsub) => unsub());
  }, [sprintId, projectId, loadSprint, navigate]);

  const currentPhase = location.pathname.includes('/construction')
    ? 'CONSTRUCTION'
    : location.pathname.includes('/review')
      ? 'REVIEW'
      : location.pathname.includes('/graph')
        ? 'GRAPH'
        : location.pathname.includes('/agent')
          ? 'AGENT'
          : 'INCEPTION';

  return (
    <div className="flex h-full w-full flex-col bg-sidebar text-sidebar-foreground">
      {/* Brand header */}
      <div className="flex h-12 items-center gap-2 px-4 border-b border-sidebar-border">
        <img src="/logo.svg" alt="AI-DLC" className="h-7 w-7 shrink-0" />
        <span className="font-semibold text-sm tracking-wide">AI-DLC</span>
      </div>

      {/* Back to project */}
      <div className="px-3 pt-3 pb-1">
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start gap-2 text-sidebar-foreground/60 hover:text-sidebar-foreground h-7 text-xs"
          onClick={() => navigate(`/project/${projectId}`)}
        >
          <ArrowLeft className="h-3 w-3" />
          Back to project
        </Button>
      </div>

      {/* Pipeline view -- the core of the sidebar */}
      <ScrollArea className="flex-1">
        <div className="p-3">
          <PipelineView
            projectId={projectId}
            sprintId={sprintId}
            currentPhase={currentPhase}
            sprint={sprint ?? undefined}
          />
        </div>
      </ScrollArea>

      {/* Bottom: Settings */}
      <div className="border-t border-sidebar-border p-2">
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start gap-2 text-sidebar-foreground/60 hover:text-sidebar-foreground h-8 text-xs"
          onClick={() => navigate(`/project/${projectId}/settings`)}
        >
          <Settings className="h-3.5 w-3.5" />
          Project Settings
        </Button>
      </div>
    </div>
  );
}
