import type { ProjectAgentInfo, StuckDetection, VelocityMetrics } from '@/hooks/useObservability';

export interface Highlight { text: string }
export interface Lowlight { text: string }
export interface Risk { text: string; severity: 'high' | 'medium' }
export interface ActionItem { text: string; done: boolean }

/** Estimate remaining time based on velocity and remaining tasks */
function estimateEta(progress: ProjectAgentInfo['progress'], velocity: VelocityMetrics | undefined): string | null {
  if (!progress || !velocity || velocity.tasksPerHour <= 0) return null;
  const remaining = progress.taskCount - progress.taskDoneCount;
  if (remaining <= 0) return null;
  const hoursLeft = remaining / velocity.tasksPerHour;
  if (hoursLeft < 1/60) return null;
  if (hoursLeft < 1) return `~${Math.round(hoursLeft * 60)} min remaining`;
  return `~${Math.round(hoursLeft * 10) / 10}h remaining`;
}

export function buildInsights(
  projects: ProjectAgentInfo[],
  stuckDetections: StuckDetection[],
  velocityMap: Record<string, VelocityMetrics>
): { highlights: Highlight[]; lowlights: Lowlight[]; risks: Risk[]; actions: ActionItem[] } {
  const highlights: Highlight[] = [];
  const lowlights: Lowlight[] = [];
  const risks: Risk[] = [];
  const actions: ActionItem[] = [];

  const totalProjects = projects.length;
  const activeCount = projects.filter(p =>
    p.sprint?.currentAgentStatus === 'running' || p.sprint?.currentAgentStatus === 'waiting'
  ).length;
  const completedSprints = projects.filter(p => p.sprint?.currentAgentStatus === 'completed').length;
  const prCreated = projects.filter(p => p.sprint?.prUrl).length;

  // ── Calm state (no agents running) ──────────────────────────────────────
  if (activeCount === 0) {
    if (totalProjects === 0) {
      highlights.push({ text: 'No projects yet — create a project to get started' });
      return { highlights, lowlights, risks, actions };
    }
    highlights.push({ text: `${totalProjects} project${totalProjects > 1 ? 's' : ''} in workspace — no agents running` });
    if (completedSprints > 0) {
      highlights.push({ text: `${completedSprints} sprint${completedSprints > 1 ? 's' : ''} completed successfully` });
    }
    if (prCreated > 0) {
      highlights.push({ text: `${prCreated} PR${prCreated > 1 ? 's' : ''} ready for review` });
      actions.push(...projects.filter(p => p.sprint?.prUrl).map(p => ({ text: `Review PR for ${p.project.name}`, done: false })));
    }
    // Show where each project is paused (useful, not confusing)
    for (const { project, sprint } of projects) {
      if (!sprint) {
        lowlights.push({ text: `${project.name} — no sprint started` });
        continue;
      }
      const status = sprint.currentAgentStatus;
      const phase = sprint.phase ? sprint.phase.charAt(0) + sprint.phase.slice(1).toLowerCase() : null;
      if (status === 'completed') continue; // already counted above
      if (status === 'failed') {
        risks.push({ text: `${project.name} — last sprint failed at ${phase ?? 'unknown'} phase`, severity: 'high' });
      } else if (phase) {
        lowlights.push({ text: `${project.name} — sprint paused at ${phase} phase` });
      }
    }
    return { highlights, lowlights, risks, actions };
  }

  // ── Active state ─────────────────────────────────────────────────────────
  for (const { project, sprint, progress } of projects) {
    if (!sprint) continue;
    const { phase, currentAgentStatus: status, prUrl, id: sprintId } = sprint;

    if (status === 'completed') {
      highlights.push({ text: `${project.name} — sprint completed` });
      if (prUrl) actions.push({ text: `Review PR for ${project.name}`, done: false });
      continue;
    }

    if (status !== 'running' && status !== 'waiting') continue;

    const phaseLabel = phase ? phase.charAt(0) + phase.slice(1).toLowerCase() : 'Unknown';

    if (phase === 'INCEPTION') {
      if (progress?.taskCount && progress.taskCount > 0) {
        highlights.push({ text: `${project.name} — inception: ${progress.requirementCount} req, ${progress.userStoryCount} stories, ${progress.taskCount} tasks` });
      } else if (progress?.requirementCount) {
        highlights.push({ text: `${project.name} — inception: ${progress.requirementCount} requirements analyzed` });
      } else {
        highlights.push({ text: `${project.name} — ${phaseLabel} phase in progress` });
      }
    } else if (phase === 'CONSTRUCTION') {
      const done = progress?.taskDoneCount ?? 0;
      const total = progress?.taskCount ?? 0;
      const vel = sprintId ? velocityMap[sprintId] : undefined;
      if (total > 0) {
        const pct = Math.round((done / total) * 100);
        const eta = estimateEta(progress, vel);
        highlights.push({ text: `${project.name} — construction: ${done}/${total} tasks (${pct}%), ${progress?.codeFileCount ?? 0} files${eta ? ` · ${eta}` : ''}` });
        if (done === total) highlights.push({ text: `${project.name} — all ${total} tasks complete` });
      } else {
        highlights.push({ text: `${project.name} — ${phaseLabel} phase in progress` });
      }
    } else if (phase === 'REVIEW') {
      highlights.push({ text: `${project.name} — code review in progress` });
      if (prUrl) actions.push({ text: `Approve PR for ${project.name}`, done: false });
    } else {
      highlights.push({ text: `${project.name} — ${phaseLabel} phase in progress` });
    }

    // Velocity (non-construction phases, or declining)
    const vel = sprintId ? velocityMap[sprintId] : undefined;
    if (phase !== 'CONSTRUCTION') {
      if (vel?.trend === 'declining' && Math.abs(vel.trendPct) > 20) {
        lowlights.push({ text: `${project.name} velocity down ${Math.abs(vel.trendPct)}% — ${vel.tasksPerHour} tasks/hr` });
      } else if (vel?.trend === 'improving') {
        highlights.push({ text: `${project.name} velocity improving (+${vel.trendPct}%, ${vel.tasksPerHour} tasks/hr)` });
      }
    }
  }

  // ── L2 stuck detections ──────────────────────────────────────────────────
  for (const d of stuckDetections) {
    if (d.reason === 'blocked_question') {
      risks.push({ text: `[CRITICAL] ${d.projectName} — ${d.message}`, severity: 'high' });
      actions.push({ text: `Answer pending question for ${d.projectName}`, done: false });
    } else if (d.reason === 'repeated_tool') {
      risks.push({ text: `[HIGH] ${d.projectName} — ${d.message}`, severity: 'high' });
      actions.push({ text: `Investigate retry loop in ${d.projectName}`, done: false });
    } else if (d.reason === 'idle') {
      lowlights.push({ text: `${d.projectName} — ${d.message}` });
    }
  }

  // Fallback
  if (highlights.length === 0 && lowlights.length === 0 && risks.length === 0) {
    highlights.push({ text: 'Agents running — collecting data...' });
  }

  return { highlights, lowlights, risks, actions };
}
