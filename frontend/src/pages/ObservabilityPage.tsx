import { useNavigate } from 'react-router-dom';
import { useObservability } from '@/hooks/useObservability';
import { ProjectDiagram, ActivityFeed, StuckAlert, BusinessView, AgentTeamSummary } from '@/components/observability';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Activity, RefreshCw, Zap, FolderGit2 } from 'lucide-react';

export default function ObservabilityPage() {
  const navigate = useNavigate();
  const {
    projects, projectsLoading,
    activityFeed, lastToolMap, pendingQuestions,
    stuckDetections, velocityMap, refresh,
  } = useObservability();

  const activeProjects = projects.filter(p =>
    p.sprint?.currentAgentStatus === 'running' || p.sprint?.currentAgentStatus === 'waiting'
  );
  const sortedProjects = [...projects].sort((a, b) => {
    const aA = (a.sprint?.currentAgentStatus === 'running' || a.sprint?.currentAgentStatus === 'waiting') ? 1 : 0;
    const bA = (b.sprint?.currentAgentStatus === 'running' || b.sprint?.currentAgentStatus === 'waiting') ? 1 : 0;
    return bA - aA;
  });

  // sprintId → project name for activity feed context
  const projectNames = Object.fromEntries(
    projects.filter(p => p.sprint).map(p => [p.sprint!.id, p.project.name])
  );

  return (
    <div className="h-full overflow-y-auto bg-background">
      <div className="max-w-6xl mx-auto p-6 space-y-4">

        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Activity className="h-5 w-5 text-primary" />
            <h1 className="text-lg font-bold tracking-tight">Observability</h1>
            {activeProjects.length > 0 && (
              <Badge variant="outline" className="gap-1 text-[10px] bg-agent-running/10 text-agent-running border-agent-running/30">
                <span className="h-1.5 w-1.5 rounded-full bg-agent-running animate-pulse" />
                {activeProjects.length} active
              </Badge>
            )}
          </div>
          <Button variant="outline" size="sm" className="gap-1.5 h-7" onClick={() => refresh()}>
            <RefreshCw className="h-3 w-3" />
            Refresh
          </Button>
        </div>

        {/* L2: Stuck / Blocked alerts — always at top, highest priority */}
        <StuckAlert detections={stuckDetections} />

        {/* Two permanent tabs */}
        <Tabs defaultValue="pipeline">
          <TabsList>
            <TabsTrigger value="pipeline" className="gap-1.5">
              Pipeline
              {stuckDetections.some(d => d.reason === 'blocked_question') && (
                <span className="inline-flex items-center justify-center h-4 min-w-4 px-1 rounded-full bg-yellow-500 text-white text-[9px] font-bold animate-pulse">
                  {stuckDetections.filter(d => d.reason === 'blocked_question').length}
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger value="business">Business View</TabsTrigger>
          </TabsList>

          {/* ── Tab: Pipeline ── */}
          <TabsContent value="pipeline" className="space-y-4 mt-3">
            {/* L3 Team View: compact all-agents summary — only when agents active */}
            <AgentTeamSummary projects={projects} lastToolMap={lastToolMap} />

            {projectsLoading ? (
              <div className="space-y-4">
                {[1, 2].map(i => <Skeleton key={i} className="h-64 w-full rounded-xl" />)}
              </div>
            ) : projects.length === 0 ? (
              <Card className="border-dashed">
                <CardContent className="flex flex-col items-center justify-center py-16">
                  <FolderGit2 className="h-10 w-10 text-muted-foreground/20 mb-3" />
                  <p className="text-sm text-muted-foreground">No projects yet</p>
                </CardContent>
              </Card>
            ) : (
              <div className="space-y-6">
                {sortedProjects.map(info => (
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
            )}

            {(activityFeed.length > 0 || activeProjects.length > 0) && (
              <div className="space-y-2">
                <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-2">
                  <Zap className="h-3 w-3" />
                  Live Activity
                </h2>
                {activityFeed.length > 0
                  ? <ActivityFeed events={activityFeed} projectNames={projectNames} />
                  : (
                    <div className="text-xs text-muted-foreground/50 italic px-3 py-4 border border-dashed rounded-lg text-center">
                      Listening for agent events…
                    </div>
                  )
                }
              </div>
            )}
          </TabsContent>

          {/* ── Tab: Business View — always rendered, never conditional ── */}
          <TabsContent value="business" className="mt-3">
            <BusinessView
              projects={projects}
              stuckDetections={stuckDetections}
              velocityMap={velocityMap}
            />
          </TabsContent>
        </Tabs>

      </div>
    </div>
  );
}
