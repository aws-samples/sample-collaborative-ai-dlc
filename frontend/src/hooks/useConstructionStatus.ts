import { useState, useEffect, useCallback, useRef } from 'react';
import { agentsService } from '../services/agents';
import type { TaskAgentStatus, AgentQuestion } from '../services/agents';
import type { StructuredAnswer } from '../services/questions';
import { realtimeService } from '../services/realtime';
import type { ToolCallEvent } from './useAgentStatus';

interface UseConstructionStatusOptions {
  projectId?: string;
  sprintId?: string;
  executionArn: string | null;
  executionId: string | null;
}

interface TaskStream {
  text: string;
  activeToolCall: string | null;
  toolCalls: ToolCallEvent[];
}

/**
 * Set-based deduplicator to prevent dropping events across different types.
 * Each event type gets its own instance.
 */
class SeqDeduplicator {
  private seen = new Set<number>();
  private maxSeen = 0;

  accept(seq: number | null | undefined): boolean {
    if (seq == null) return true;
    if (this.seen.has(seq)) return false;
    this.seen.add(seq);
    this.maxSeen = Math.max(this.maxSeen, seq);
    if (this.seen.size > 1000) {
      const cutoff = this.maxSeen - 500;
      for (const s of this.seen) {
        if (s < cutoff) this.seen.delete(s);
      }
    }
    return true;
  }

  reset() {
    this.seen.clear();
    this.maxSeen = 0;
  }
}

function formatAgentErrorMessage(message?: string) {
  return `\n\n### Agent failed\n\n${
    message ||
    'The agent failed before it could complete. Please check the agent settings and try again.'
  }\n`;
}

export function useConstructionStatus({
  projectId,
  sprintId,
  executionArn,
  executionId,
}: UseConstructionStatusOptions) {
  const [orchestratorStatus, setOrchestratorStatus] = useState<string | null>(null);
  const [taskStatuses, setTaskStatuses] = useState<TaskAgentStatus[]>([]);
  const [questions, setQuestions] = useState<AgentQuestion[]>([]);
  const [taskStreams, setTaskStreams] = useState<Record<string, TaskStream>>({});
  const [orchestratorStream, setOrchestratorStream] = useState<TaskStream>({
    text: '',
    activeToolCall: null,
    toolCalls: [],
  });
  const streamBuffers = useRef<Record<string, string>>({});
  // Separate deduplicators per event type
  const chunkDedup = useRef(new SeqDeduplicator());
  const toolDedup = useRef(new SeqDeduplicator());
  const toolUpdateDedup = useRef(new SeqDeduplicator());
  const toolCallCounters = useRef<Record<string, number>>({});

  const refreshTasks = useCallback(async () => {
    if (!projectId || !sprintId) return;
    try {
      const result = await agentsService.getTaskAgentStatuses(projectId, sprintId);
      setTaskStatuses(result.tasks);
    } catch {}
  }, [projectId, sprintId]);

  const refreshOrchestrator = useCallback(async () => {
    if (!executionArn) return;
    try {
      const result = await agentsService.getStatus(executionArn, executionId || undefined);
      setOrchestratorStatus(result.status || null);
    } catch {}
  }, [executionArn, executionId]);

  // Poll task statuses
  useEffect(() => {
    refreshTasks();
    const interval = setInterval(refreshTasks, 10000);
    return () => clearInterval(interval);
  }, [refreshTasks]);

  // Poll orchestrator
  useEffect(() => {
    refreshOrchestrator();
    const interval = setInterval(refreshOrchestrator, 15000);
    return () => clearInterval(interval);
  }, [refreshOrchestrator]);

  // Real-time events
  useEffect(() => {
    const unsubs = [
      realtimeService.on('agent.chunk', (data) => {
        if (!chunkDedup.current.accept(data.seq)) return;
        const taskId = data.agentTaskId || 'orchestrator';
        const buf = (streamBuffers.current[taskId] || '') + (data.text || '');
        streamBuffers.current[taskId] = buf;
        if (taskId === 'orchestrator' || !data.agentTaskId) {
          setOrchestratorStream((prev) => ({ ...prev, text: buf }));
        } else {
          setTaskStreams((prev) => ({
            ...prev,
            [taskId]: {
              ...prev[taskId],
              text: buf,
              activeToolCall: prev[taskId]?.activeToolCall || null,
              toolCalls: prev[taskId]?.toolCalls || [],
            },
          }));
        }
      }),
      realtimeService.on('agent.tool', (data) => {
        if (!toolDedup.current.accept(data.seq)) return;
        const taskId = data.agentTaskId || 'orchestrator';
        const toolName = data.name || data.title;
        const isNewTool = data.status === 'pending' || data.status === 'in_progress';
        const toolCall = isNewTool ? toolName : null;

        const updateToolCalls = (prev: ToolCallEvent[]): ToolCallEvent[] => {
          if (isNewTool) {
            const counter = (toolCallCounters.current[taskId] || 0) + 1;
            toolCallCounters.current[taskId] = counter;
            return [
              ...prev,
              {
                id: data.toolCallId || `tool-${taskId}-${counter}`,
                name: toolName,
                status: 'pending',
                startedAt: Date.now(),
              },
            ];
          }
          // Mark latest matching pending tool as completed
          const idx = [...prev]
            .toReversed()
            .findIndex(
              (t) => t.name === toolName && (t.status === 'pending' || t.status === 'running'),
            );
          if (idx === -1) return prev;
          const realIdx = prev.length - 1 - idx;
          const updated = [...prev];
          updated[realIdx] = {
            ...updated[realIdx],
            status: data.status === 'error' || data.status === 'failed' ? 'failed' : 'completed',
            completedAt: Date.now(),
          };
          return updated;
        };

        if (taskId === 'orchestrator' || !data.agentTaskId) {
          if (
            isNewTool &&
            streamBuffers.current[taskId] &&
            !streamBuffers.current[taskId].endsWith('\n\n')
          ) {
            streamBuffers.current[taskId] += '\n\n';
            setOrchestratorStream((prev) => ({ ...prev, text: streamBuffers.current[taskId] }));
          }
          setOrchestratorStream((prev) => ({
            ...prev,
            activeToolCall: toolCall,
            toolCalls: updateToolCalls(prev.toolCalls),
          }));
        } else {
          if (
            isNewTool &&
            streamBuffers.current[taskId] &&
            !streamBuffers.current[taskId].endsWith('\n\n')
          ) {
            streamBuffers.current[taskId] += '\n\n';
          }
          setTaskStreams((prev) => ({
            ...prev,
            [taskId]: {
              text: prev[taskId]?.text || '',
              activeToolCall: toolCall,
              toolCalls: updateToolCalls(prev[taskId]?.toolCalls || []),
            },
          }));
        }
      }),
      realtimeService.on('agent.tool_update', (data) => {
        if (!toolUpdateDedup.current.accept(data.seq)) return;
        if (!data.toolCallId) return;
        const taskId = data.agentTaskId || 'orchestrator';
        const updateTool = (prev: ToolCallEvent[]): ToolCallEvent[] =>
          prev.map((t) =>
            t.id === data.toolCallId
              ? { ...t, status: data.status === 'error' ? 'failed' : 'running' }
              : t,
          );

        if (taskId === 'orchestrator' || !data.agentTaskId) {
          setOrchestratorStream((prev) => ({ ...prev, toolCalls: updateTool(prev.toolCalls) }));
        } else {
          setTaskStreams((prev) =>
            prev[taskId]
              ? {
                  ...prev,
                  [taskId]: { ...prev[taskId], toolCalls: updateTool(prev[taskId].toolCalls) },
                }
              : prev,
          );
        }
      }),
      realtimeService.on('agent.completed', () => {
        refreshTasks();
        refreshOrchestrator();
      }),
      realtimeService.on('agent.error', (data) => {
        const taskId = data.agentTaskId || 'orchestrator';
        const message = data.error || data.message;
        const text = formatAgentErrorMessage(message);
        if (!streamBuffers.current[taskId]?.includes(message || text)) {
          streamBuffers.current[taskId] = (streamBuffers.current[taskId] || '') + text;
        }

        if (taskId === 'orchestrator' || !data.agentTaskId) {
          setOrchestratorStream((prev) => ({
            ...prev,
            text: streamBuffers.current[taskId],
            activeToolCall: null,
          }));
        } else {
          setTaskStreams((prev) => ({
            ...prev,
            [taskId]: {
              text: streamBuffers.current[taskId],
              activeToolCall: null,
              toolCalls: prev[taskId]?.toolCalls || [],
            },
          }));
        }
        refreshTasks();
        refreshOrchestrator();
      }),
      realtimeService.on('agent.started', () => {
        // Reset deduplicators on new agent start
        chunkDedup.current.reset();
        toolDedup.current.reset();
        toolUpdateDedup.current.reset();
        refreshTasks();
      }),
      realtimeService.on('agent.question', (data) => {
        setQuestions((prev) => [...prev, data]);
      }),
    ];
    return () => unsubs.forEach((u) => u());
  }, [refreshTasks, refreshOrchestrator]);

  const answerQuestion = async (questionId: string, structuredAnswer: StructuredAnswer) => {
    const key = executionId || executionArn;
    if (!key) return;
    await agentsService.answerQuestion(key, questionId, structuredAnswer);
    setQuestions((prev) =>
      prev.map((q) =>
        q.questionId === questionId ? { ...q, status: 'answered' as const, structuredAnswer } : q,
      ),
    );
  };

  return {
    orchestratorStatus,
    taskStatuses,
    taskStreams,
    orchestratorStream,
    questions,
    answerQuestion,
    refreshTasks,
  };
}
