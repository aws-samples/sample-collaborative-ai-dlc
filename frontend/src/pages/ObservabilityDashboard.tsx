import { useNavigate } from 'react-router-dom';
import { useObservabilityContext } from './ObservabilityLayout';
import {
  AgentStatusCards,
  ActivityFeed,
  StuckAlert,
  ProjectDiagram,
  BusinessView,
} from '@/components/observability';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { RefreshCw, Zap } from 'lucide-react';

export default function ObservabilityDashboard() {
  const navigate = useNavigate();
  const {
    filtered,
    activityFeed, lastToolMap, pendingQuestions,
    stuckDetections, velocityMap, refresh,
    setSelectedProjectId,
  } = useObservabilityContext();

  const activeCount = filtered.filter(p =>
    p.sprint?.currentAgentStatus === 'running' || p.sprint?.currentAgentStatus === 'waiting'
  ).length;

  const projectNames = Object.fromEntries(
    filtered.filter(p => p.sprint).map(p => [p.sprint!.id, p.project.name])
  );

  const sorted = [...filtered].sort((a, b) => {
    const aA = (a.sprint?.currentAgentStatus === 'running' || a.sprint?.currentAgentStatus === 'waiting') ? 1 : 0;
    const bA = (b.sprint?.currentAgentStatus === 'running' || b.sprint?.currentAgentStatus === 'waiting') ? 1 : 0;
    return bA - aA;
  });

  return (
    <div className="max-w-6xl mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-bold tracking-tight">Observability</h1>
          {activeCount > 0 && (
            <Badge variant="outline" className="gap-1 text-[10px] bg-agent-running/10 text-agent-running border-agent-running/30">
              <span className="h-1.5 w-1.5 rounded-full bg-agent-running animate-pulse" />
              {activeCount} active
            </Badge>
          )}
        </div>
        <Button variant="outline" size="sm" className="gap-1.5 h-7" onClick={() => refresh()}>
          <RefreshCw className="h-3 w-3" />
          Refresh
        </Button>
      </div>

      <StuckAlert detections={stuckDetections} />

      <AgentStatusCards
        projects={filtered}
        lastToolMap={lastToolMap}
        pendingQuestions={pendingQuestions}
        velocityMap={velocityMap}
        onSelectProject={setSelectedProjectId}
      />

      <div className="space-y-4">
        {sorted.map(info => (
          <ProjectDiagram
            key={info.project.id}
            info={info}
            lastTool={info.sprint ? lastToolMap[info.sprint.id] : undefined}
            pendingQuestions={info.sprint ? (pendingQuestions[info.sprint.id] ?? 0) : 0}
            velocity={info.sprint ? velocityMap[info.sprint.id] : undefined}
            onNavigate={navigate}
          />
        ))}
      </div>

      <div className="grid md:grid-cols-2 gap-6">
        <div>
          <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-2">
            <Zap className="h-3 w-3" />
            Live Activity
          </h3>
          {activityFeed.length > 0 ? (
            <ActivityFeed events={activityFeed} projectNames={projectNames} />
          ) : activeCount > 0 ? (
            <div className="text-xs text-muted-foreground/50 italic px-3 py-4 border border-dashed rounded-lg text-center">
              Listening for agent events…
            </div>
          ) : (
            <div className="rounded-xl border border-border p-4">
              <p className="text-sm text-muted-foreground">No recent activity.</p>
            </div>
          )}
        </div>

        <BusinessView
          projects={filtered}
          stuckDetections={stuckDetections}
          velocityMap={velocityMap}
        />
      </div>
    </div>
  );
}
