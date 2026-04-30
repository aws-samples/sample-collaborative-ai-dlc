/**
 * L2 Aggregation Intelligence — stateful probes for stuck detection and velocity tracking.
 * Extracted from useObservability to keep the hook lean.
 */

export type StuckReason = 'repeated_tool' | 'idle' | 'blocked_question';

export interface StuckDetection {
  sprintId: string;
  projectName: string;
  reason: StuckReason;
  message: string;
  durationMs: number;
  severity: 'medium' | 'high' | 'critical';
}

export interface VelocityMetrics {
  sprintId: string;
  tasksPerHour: number;
  trend: 'improving' | 'stable' | 'declining';
  trendPct: number;
}

interface ToolHistory { name: string; timestamp: number }
interface TaskCompletion { taskId: string; completedAt: number }

const IDLE_THRESHOLD_MS = 5 * 60 * 1000;
const STUCK_TOOL_REPEAT = 3; // 3+ consecutive same-tool calls = possible retry loop (AgentTower spec)
const VELOCITY_WINDOW_MS = 15 * 60 * 1000; // 15-min window — more responsive than 30min

export class L2Intelligence {
  private toolHistory: Record<string, ToolHistory[]> = {};
  private taskCompletions: Record<string, TaskCompletion[]> = {};
  private lastStateChange: Record<string, number> = {};

  recordToolCall(sprintId: string, toolName: string): StuckDetection | null {
    const now = Date.now();
    this.lastStateChange[sprintId] = now;

    const history = this.toolHistory[sprintId] ?? [];
    history.push({ name: toolName, timestamp: now });
    this.toolHistory[sprintId] = history.slice(-10);

    const recent = history.slice(-STUCK_TOOL_REPEAT);
    if (recent.length >= STUCK_TOOL_REPEAT && recent.every(h => h.name === toolName)) {
      return {
        sprintId, projectName: '', reason: 'repeated_tool',
        message: `Repeated "${toolName.replace(/_/g, ' ')}" ${STUCK_TOOL_REPEAT}× — possible retry loop`,
        durationMs: now - recent[0].timestamp, severity: 'high',
      };
    }
    return null;
  }

  seedLastChange(sprintId: string) {
    if (!this.lastStateChange[sprintId]) {
      this.lastStateChange[sprintId] = Date.now();
    }
  }

  checkIdle(sprintId: string): { idle: true; durationMs: number } | { idle: false } {
    const lastChange = this.lastStateChange[sprintId];
    if (!lastChange) return { idle: false };
    const durationMs = Date.now() - lastChange;
    return durationMs > IDLE_THRESHOLD_MS ? { idle: true, durationMs } : { idle: false };
  }

  clearSprint(sprintId: string) {
    this.toolHistory[sprintId] = [];
    this.lastStateChange[sprintId] = Date.now();
  }

  recordTaskCompletion(sprintId: string, taskId: string) {
    const completions = this.taskCompletions[sprintId] ?? [];
    // Deduplicate
    if (!completions.find(c => c.taskId === taskId)) {
      completions.push({ taskId, completedAt: Date.now() });
      this.taskCompletions[sprintId] = completions;
    }
  }

  computeVelocity(sprintId: string): VelocityMetrics | null {
    const completions = this.taskCompletions[sprintId] ?? [];
    if (completions.length < 1) return null;
    const now = Date.now();
    const windowStart = now - VELOCITY_WINDOW_MS;
    const halfWindow = now - VELOCITY_WINDOW_MS / 2;

    const recent = completions.filter(c => c.completedAt > windowStart);
    if (recent.length < 1) return null;

    const firstHalf = recent.filter(c => c.completedAt <= halfWindow).length;
    const secondHalf = recent.filter(c => c.completedAt > halfWindow).length;
    const tasksPerHour = Math.round((recent.length / (VELOCITY_WINDOW_MS / 3_600_000)) * 10) / 10;

    let trend: VelocityMetrics['trend'] = 'stable';
    let trendPct = 0;
    if (firstHalf > 0) {
      trendPct = Math.round(((secondHalf - firstHalf) / firstHalf) * 100);
      if (trendPct > 15) trend = 'improving';
      else if (trendPct < -15) trend = 'declining';
    }
    return { sprintId, tasksPerHour, trend, trendPct };
  }
}
