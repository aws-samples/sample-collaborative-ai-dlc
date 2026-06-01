import { Bot, CircleDot, AlertTriangle, Zap } from 'lucide-react';
import { MetricCard } from './MetricCard';
import type { ProjectAgentInfo, StuckDetection, ActivityEvent } from '@/hooks/useObservability';

interface DashboardMetricsProps {
  projects: ProjectAgentInfo[];
  stuckDetections: StuckDetection[];
  activityFeed: ActivityEvent[];
}

export function DashboardMetrics({ projects, stuckDetections, activityFeed }: DashboardMetricsProps) {
  const running = projects.filter(p => p.sprint?.currentAgentStatus === 'running').length;
  const waiting = projects.filter(p => p.sprint?.currentAgentStatus === 'waiting').length;
  const activeAgents = running + waiting;

  let totalRunning = 0;
  let totalPending = 0;
  let totalDone = 0;
  for (const p of projects) {
    for (const t of p.taskStatuses) {
      if (t.executionStatus === 'RUNNING') totalRunning++;
      else if (t.executionStatus === 'SUCCEEDED') totalDone++;
      else if (!t.executionStatus) totalPending++;
    }
  }

  const criticalAlerts = stuckDetections.filter(d => d.severity === 'critical').length;
  const alertDesc = stuckDetections.length === 0
    ? 'All clear'
    : criticalAlerts > 0
      ? `${criticalAlerts} critical`
      : `${stuckDetections.length} warning${stuckDetections.length > 1 ? 's' : ''}`;

  return (
    <div className="grid grid-cols-2 xl:grid-cols-4 gap-2">
      <MetricCard
        icon={Bot}
        value={activeAgents}
        label="Agents Active"
        description={
          <span>{running} running, {waiting} waiting</span>
        }
      />
      <MetricCard
        icon={CircleDot}
        value={totalRunning}
        label="Tasks In Progress"
        description={
          <span>{totalPending} pending, {totalDone} done</span>
        }
      />
      <MetricCard
        icon={AlertTriangle}
        value={stuckDetections.length}
        label="Alerts"
        description={<span>{alertDesc}</span>}
      />
      <MetricCard
        icon={Zap}
        value={activityFeed.length}
        label="Events"
        description={<span>Live updates via WebSocket</span>}
      />
    </div>
  );
}
