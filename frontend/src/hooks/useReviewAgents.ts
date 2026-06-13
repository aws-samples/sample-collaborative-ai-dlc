import { useState, useEffect, useCallback, useRef } from 'react';
import { agentsService } from '../services/agents';
import { realtimeService } from '../services/realtime';
import type { ToolCallEvent } from './useAgentStatus';
import { extractAgentStartError, type AgentStartError } from '@/lib/agentStartError';

export type ReviewAgentType = 'review-blind' | 'review-full' | 'review-modify';

interface AgentState {
  executionArn: string | null;
  executionId: string | null;
  status: string | null;
  streamingText: string;
  activeToolCall: string | null;
  toolCalls: ToolCallEvent[];
  completedOutput: string;
}

const initialAgentState: AgentState = {
  executionArn: null,
  executionId: null,
  status: null,
  streamingText: '',
  activeToolCall: null,
  toolCalls: [],
  completedOutput: '',
};

interface UseReviewAgentsOptions {
  projectId?: string;
  sprintId?: string;
}

/**
 * Set-based deduplicator to prevent dropping events across different types.
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

export function useReviewAgents({ projectId, sprintId }: UseReviewAgentsOptions) {
  const [blindAgent, setBlindAgent] = useState<AgentState>(initialAgentState);
  const [fullAgent, setFullAgent] = useState<AgentState>(initialAgentState);
  const [modifyAgent, setModifyAgent] = useState<AgentState>(initialAgentState);
  const [launching, setLaunching] = useState<ReviewAgentType | null>(null);
  const [startError, setStartError] = useState<AgentStartError | null>(null);

  const blindBuffer = useRef('');
  const fullBuffer = useRef('');
  const modifyBuffer = useRef('');
  // Separate deduplicators per event type
  const chunkDedup = useRef(new SeqDeduplicator());
  const toolDedup = useRef(new SeqDeduplicator());
  const toolUpdateDedup = useRef(new SeqDeduplicator());
  const toolCallCounters = useRef<Record<string, number>>({});

  // Track which execution ID maps to which agent type
  const execToType = useRef<Map<string, ReviewAgentType>>(new Map());

  const startAgent = useCallback(
    async (
      agentType: ReviewAgentType,
      options: { branch: string; baseBranch: string; description?: string },
    ) => {
      if (!projectId || !sprintId) return;

      setLaunching(agentType);
      setStartError(null);
      try {
        const result = await agentsService.startWorkflow(projectId, {
          phase: agentType,
          sprintId,
          branch: options.branch,
          baseBranch: options.baseBranch,
          description: options.description || '',
        });

        const newState: AgentState = {
          executionArn: result.executionArn,
          executionId: result.executionId || null,
          status: 'RUNNING',
          streamingText: '',
          activeToolCall: null,
          toolCalls: [],
          completedOutput: '',
        };

        // Track the mapping
        if (result.executionId) {
          execToType.current.set(result.executionId, agentType);
        }
        if (result.executionArn) {
          execToType.current.set(result.executionArn, agentType);
        }

        if (agentType === 'review-blind') {
          blindBuffer.current = '';
          setBlindAgent(newState);
        } else if (agentType === 'review-full') {
          fullBuffer.current = '';
          setFullAgent(newState);
        } else if (agentType === 'review-modify') {
          modifyBuffer.current = '';
          setModifyAgent(newState);
        }
      } catch (err) {
        console.error('Failed to start review agent:', err);
        setStartError(extractAgentStartError(err));
      } finally {
        setLaunching(null);
      }
    },
    [projectId, sprintId],
  );

  const startBothReviews = useCallback(
    async (branch: string, baseBranch: string) => {
      if (!projectId || !sprintId) return;

      // Launch both agents in parallel
      setLaunching('review-blind');
      setStartError(null);
      try {
        const [blindResult, fullResult] = await Promise.all([
          agentsService.startWorkflow(projectId, {
            phase: 'review-blind',
            sprintId,
            branch,
            baseBranch,
          }),
          agentsService.startWorkflow(projectId, {
            phase: 'review-full',
            sprintId,
            branch,
            baseBranch,
          }),
        ]);

        // Track mappings
        if (blindResult.executionId)
          execToType.current.set(blindResult.executionId, 'review-blind');
        if (blindResult.executionArn)
          execToType.current.set(blindResult.executionArn, 'review-blind');
        if (fullResult.executionId) execToType.current.set(fullResult.executionId, 'review-full');
        if (fullResult.executionArn) execToType.current.set(fullResult.executionArn, 'review-full');

        blindBuffer.current = '';
        fullBuffer.current = '';

        setBlindAgent({
          executionArn: blindResult.executionArn,
          executionId: blindResult.executionId || null,
          status: 'RUNNING',
          streamingText: '',
          activeToolCall: null,
          toolCalls: [],
          completedOutput: '',
        });

        setFullAgent({
          executionArn: fullResult.executionArn,
          executionId: fullResult.executionId || null,
          status: 'RUNNING',
          streamingText: '',
          activeToolCall: null,
          toolCalls: [],
          completedOutput: '',
        });
      } catch (err) {
        console.error('Failed to start review agents:', err);
        setStartError(extractAgentStartError(err));
      } finally {
        setLaunching(null);
      }
    },
    [projectId, sprintId],
  );

  // Determine agent type from streaming event data
  const resolveAgentType = useCallback(
    (data: {
      executionId?: string;
      agentTaskId?: string;
      agentType?: string;
    }): ReviewAgentType | null => {
      // Direct agentType field from event
      if (data.agentType) {
        if (data.agentType.startsWith('review-')) return data.agentType as ReviewAgentType;
      }
      // Look up by executionId
      if (data.executionId && execToType.current.has(data.executionId)) {
        return execToType.current.get(data.executionId)!;
      }
      if (data.agentTaskId && execToType.current.has(data.agentTaskId)) {
        return execToType.current.get(data.agentTaskId)!;
      }
      return null;
    },
    [],
  );

  // Listen for streaming events
  useEffect(() => {
    const unsubs = [
      realtimeService.on('agent.chunk', (data) => {
        if (!chunkDedup.current.accept(data.seq)) return;

        const type = resolveAgentType(data);
        if (!type || !data.text) return;

        if (type === 'review-blind') {
          blindBuffer.current += data.text;
          setBlindAgent((prev) => ({ ...prev, streamingText: blindBuffer.current }));
        } else if (type === 'review-full') {
          fullBuffer.current += data.text;
          setFullAgent((prev) => ({ ...prev, streamingText: fullBuffer.current }));
        } else if (type === 'review-modify') {
          modifyBuffer.current += data.text;
          setModifyAgent((prev) => ({ ...prev, streamingText: modifyBuffer.current }));
        }
      }),

      realtimeService.on('agent.tool', (data) => {
        if (!toolDedup.current.accept(data.seq)) return;

        const type = resolveAgentType(data);
        if (!type) return;

        const toolName = data.name || data.title;
        const isNewTool = data.status === 'pending' || data.status === 'in_progress';
        const toolCall = isNewTool ? toolName : null;
        const setter =
          type === 'review-blind'
            ? setBlindAgent
            : type === 'review-full'
              ? setFullAgent
              : setModifyAgent;

        setter((prev) => {
          let updatedToolCalls = prev.toolCalls;
          if (isNewTool) {
            const counter = (toolCallCounters.current[type] || 0) + 1;
            toolCallCounters.current[type] = counter;
            updatedToolCalls = [
              ...prev.toolCalls,
              {
                id: data.toolCallId || `tool-${type}-${counter}`,
                name: toolName,
                status: 'pending' as const,
                startedAt: Date.now(),
              },
            ];
          } else {
            const idx = [...prev.toolCalls]
              .reverse()
              .findIndex(
                (t) => t.name === toolName && (t.status === 'pending' || t.status === 'running'),
              );
            if (idx !== -1) {
              const realIdx = prev.toolCalls.length - 1 - idx;
              updatedToolCalls = [...prev.toolCalls];
              updatedToolCalls[realIdx] = {
                ...updatedToolCalls[realIdx],
                status: data.status === 'error' ? 'failed' : 'completed',
                completedAt: Date.now(),
              };
            }
          }
          return { ...prev, activeToolCall: toolCall, toolCalls: updatedToolCalls };
        });
      }),

      realtimeService.on('agent.tool_update', (data) => {
        if (!toolUpdateDedup.current.accept(data.seq)) return;
        if (!data.toolCallId) return;

        const type = resolveAgentType(data);
        if (!type) return;

        const setter =
          type === 'review-blind'
            ? setBlindAgent
            : type === 'review-full'
              ? setFullAgent
              : setModifyAgent;
        setter((prev) => ({
          ...prev,
          toolCalls: prev.toolCalls.map((t) =>
            t.id === data.toolCallId
              ? {
                  ...t,
                  status: data.status === 'error' ? ('failed' as const) : ('running' as const),
                }
              : t,
          ),
        }));
      }),

      realtimeService.on('agent.completed', (data) => {
        const type = resolveAgentType(data);
        if (!type) return;

        if (type === 'review-blind') {
          setBlindAgent((prev) => ({
            ...prev,
            status: 'SUCCEEDED',
            activeToolCall: null,
            completedOutput: blindBuffer.current,
          }));
        } else if (type === 'review-full') {
          setFullAgent((prev) => ({
            ...prev,
            status: 'SUCCEEDED',
            activeToolCall: null,
            completedOutput: fullBuffer.current,
          }));
        } else if (type === 'review-modify') {
          setModifyAgent((prev) => ({
            ...prev,
            status: 'SUCCEEDED',
            activeToolCall: null,
            completedOutput: modifyBuffer.current,
          }));
        }
      }),

      realtimeService.on('agent.error', (data) => {
        const type = resolveAgentType(data);
        if (!type) return;

        const message = data.error || data.message;
        if (message) {
          const text = formatAgentErrorMessage(message);
          if (type === 'review-blind' && !blindBuffer.current.includes(message)) {
            blindBuffer.current += text;
          } else if (type === 'review-full' && !fullBuffer.current.includes(message)) {
            fullBuffer.current += text;
          } else if (type === 'review-modify' && !modifyBuffer.current.includes(message)) {
            modifyBuffer.current += text;
          }
        }

        const setter =
          type === 'review-blind'
            ? setBlindAgent
            : type === 'review-full'
              ? setFullAgent
              : setModifyAgent;
        const buffer =
          type === 'review-blind'
            ? blindBuffer.current
            : type === 'review-full'
              ? fullBuffer.current
              : modifyBuffer.current;
        setter((prev) => ({
          ...prev,
          status: 'FAILED',
          activeToolCall: null,
          streamingText: buffer,
          completedOutput: buffer,
        }));
      }),

      realtimeService.on('agent.started', (data) => {
        const type = resolveAgentType(data);
        if (!type) return;

        const setter =
          type === 'review-blind'
            ? setBlindAgent
            : type === 'review-full'
              ? setFullAgent
              : setModifyAgent;
        setter((prev) => (prev.status === null ? { ...prev, status: 'RUNNING' } : prev));
      }),
    ];

    return () => unsubs.forEach((u) => u());
  }, [resolveAgentType]);

  const isAnyRunning =
    blindAgent.status === 'RUNNING' ||
    fullAgent.status === 'RUNNING' ||
    modifyAgent.status === 'RUNNING';

  return {
    blindAgent,
    fullAgent,
    modifyAgent,
    launching,
    isAnyRunning,
    startAgent,
    startBothReviews,
    startError,
    clearStartError: () => setStartError(null),
  };
}
