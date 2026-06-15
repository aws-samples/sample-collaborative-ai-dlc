import { useObservabilityContext } from './ObservabilityLayout';
import { effectiveSprintStatus } from '@/lib/sprintStatus';
import {
  AgentStatusCards,
  ActivityFeed,
  StuckAlert,
  BusinessView,
} from '@/components/observability';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { AlertCircle, RefreshCw, Zap } from 'lucide-react';

function DashboardSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading observability data">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="rounded-xl border border-border p-4 space-y-3">
            <div className="h-4 w-2/3 rounded bg-muted animate-pulse" />
            <div className="h-3 w-1/2 rounded bg-muted animate-pulse" />
            <div className="h-2 w-full rounded bg-muted animate-pulse" />
          </div>
        ))}
      </div>
      <div className="rounded-xl border border-border p-4 space-y-3">
        <div className="h-4 w-1/4 rounded bg-muted animate-pulse" />
        <div className="h-3 w-full rounded bg-muted animate-pulse" />
        <div className="h-3 w-5/6 rounded bg-muted animate-pulse" />
      </div>
    </div>
  );
}

export default function ObservabilityDashboard() {
  const {
    filtered,
    projectsLoading,
    projectsError,
    activityFeed,
    lastToolMap,
    pendingQuestions,
    stuckDetections,
    velocityMap,
    refresh,
    selectSprint,
  } = useObservabilityContext();

  const activeCount = filtered.filter((p) => {
    const s = effectiveSprintStatus(p.sprint);
    return s === 'running' || s === 'waiting';
  }).length;

  const projectNames = Object.fromEntries(
    filtered.filter((p) => p.sprint).map((p) => [p.sprint!.id, p.project.name]),
  );

  return (
    <div className="max-w-6xl mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-bold tracking-tight">Observability</h1>
          {activeCount > 0 && (
            <Badge
              variant="outline"
              className="gap-1 text-[10px] bg-agent-running/10 text-agent-running border-agent-running/30"
            >
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

      {projectsError && filtered.length === 0 ? (
        <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-6 flex flex-col items-center gap-3 text-center">
          <AlertCircle className="h-6 w-6 text-destructive" />
          <div>
            <p className="text-sm font-medium">Couldn't load observability data</p>
            <p className="text-xs text-muted-foreground mt-1">{projectsError}</p>
          </div>
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => refresh()}>
            <RefreshCw className="h-3 w-3" />
            Retry
          </Button>
        </div>
      ) : projectsLoading && filtered.length === 0 ? (
        <DashboardSkeleton />
      ) : (
        <>
          <StuckAlert detections={stuckDetections} />

          <div className="grid md:grid-cols-2 gap-4 items-stretch">
            <Card className="flex flex-col">
              <CardHeader className="pb-2 pt-3 px-4">
                <div className="flex items-center gap-2">
                  <Zap className="h-3 w-3 text-muted-foreground" />
                  <span className="text-xs font-bold tracking-wider text-muted-foreground uppercase">
                    Live Activity
                  </span>
                </div>
              </CardHeader>
              <CardContent className="px-4 pb-4 flex-1 flex items-center justify-center">
                {activityFeed.length > 0 ? (
                  <ActivityFeed events={activityFeed} projectNames={projectNames} />
                ) : activeCount > 0 ? (
                  <p className="text-xs text-muted-foreground/50 italic text-center">
                    Listening for agent events…
                  </p>
                ) : (
                  <p className="text-sm text-muted-foreground text-center">
                    No recent activity.
                  </p>
                )}
              </CardContent>
            </Card>

            <BusinessView
              projects={filtered}
              stuckDetections={stuckDetections}
              velocityMap={velocityMap}
            />
          </div>

          <AgentStatusCards
            projects={filtered}
            lastToolMap={lastToolMap}
            pendingQuestions={pendingQuestions}
            velocityMap={velocityMap}
            onSelectSprint={selectSprint}
          />
        </>
      )}
    </div>
  );
}
