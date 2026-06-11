import { useNavigate, useParams, useLocation } from 'react-router-dom';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import { Settings, ArrowLeft } from 'lucide-react';
import { PipelineView } from '@/components/layout/PipelineView';
import { useState, useEffect, useCallback } from 'react';
import { sprintsService, type Sprint } from '@/services/sprints';
import { realtimeService } from '@/services/realtime';

const PHASE_URL_SUFFIX: Record<string, string> = {
  INCEPTION: '',
  CONSTRUCTION: '/construction',
  REVIEW: '/review',
};

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

  // Re-fetch sprint on agent/phase events and auto-navigate on phase change.
  //
  // INVARIANT (plan §4b): `sprint.phaseChanged` is an allowlisted CLIENT-origin
  // event until PR 6 — allowlisted client events must never carry rendered or
  // acted-upon content. This handler treats the event as a bare reload hint:
  // it re-fetches the sprint and navigates from the FETCHED phase only,
  // ignoring any payload. A same-document spoofer can at most force a
  // redundant re-fetch; navigation always reflects server state.
  useEffect(() => {
    if (!sprintId) return;
    const unsubs = [
      realtimeService.on('agent.started', () => loadSprint()),
      realtimeService.on('agent.completed', () => loadSprint()),
      realtimeService.on('agent.error', () => loadSprint()),
      realtimeService.on('sprint.phaseChanged', async () => {
        try {
          const data = await sprintsService.get(projectId, sprintId);
          setSprint(data);
          const suffix = PHASE_URL_SUFFIX[data.phase];
          if (suffix === undefined) return;
          const target = `/project/${projectId}/sprint/${sprintId}${suffix}`;
          // Navigate only when the current route doesn't already reflect the
          // fetched phase.
          if (window.location.pathname !== target) navigate(target);
        } catch (err) {
          console.error('Failed to reload sprint on phase change:', err);
        }
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
