import { useState, useEffect, useCallback, useRef } from 'react';
import { agentsService } from '../services/agents';
import type { AgentExecution, AgentQuestion } from '../services/agents';
import type { StructuredAnswer } from '../services/questions';
import { realtimeService } from '../services/realtime';
import { SeqDeduplicator } from '../lib/seqDeduplicator';

export interface ToolCallEvent {
  id: string; // toolCallId from backend, or generated fallback
  name: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  startedAt: number; // Date.now()
  completedAt?: number;
}

interface UseAgentStatusOptions {
  executionArn: string | null;
  executionId: string | null;
  projectId?: string;
  sprintId?: string;
  /** Pass sprint.currentAgentStatus to trigger re-fetch when sprint data changes */
  sprintAgentStatus?: string | null;
}

function formatAgentErrorMessage(message?: string) {
  return `\n\n### Agent failed\n\n${
    message ||
    'The agent failed before it could complete. Please check the agent settings and try again.'
  }\n`;
}

export function useAgentStatus({
  executionArn,
  executionId,
  projectId,
  sprintId,
  sprintAgentStatus,
}: UseAgentStatusOptions) {
  const [status, setStatus] = useState<AgentExecution | null>(null);
  const [questions, setQuestions] = useState<AgentQuestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentArn, setCurrentArn] = useState<string | null>(executionArn);
  const [artifactsUpdated, setArtifactsUpdated] = useState(0);
  const [streamingText, setStreamingText] = useState('');
  const [activeToolCall, setActiveToolCall] = useState<string | null>(null);
  const [toolCalls, setToolCalls] = useState<ToolCallEvent[]>([]);
  const [completedOutput, setCompletedOutput] = useState('');
  const streamBuffer = useRef('');
  // Separate deduplicators for each event type to prevent cross-type drops
  const chunkDedup = useRef(new SeqDeduplicator());
  const toolDedup = useRef(new SeqDeduplicator());
  const toolUpdateDedup = useRef(new SeqDeduplicator());
  const toolCallCounter = useRef(0);
  const refreshRef = useRef<() => void>(() => {});
  const currentArnRef = useRef(currentArn);
  const projectIdRef = useRef(projectId);
  const sprintIdRef = useRef(sprintId);

  useEffect(() => {
    setCurrentArn(executionArn);
  }, [executionArn]);

  // Initial check for execution when component mounts, sprintId changes,
  // or sprint status transitions to 'running' (detected via background polling)
  useEffect(() => {
    console.log('[useAgentStatus] Initial check:', {
      projectId,
      sprintId,
      executionArn,
      sprintAgentStatus,
    });
    if (projectId && sprintId) {
      console.log('[useAgentStatus] Calling getCurrentExecution with:', projectId, sprintId);
      agentsService
        .getCurrentExecution(projectId, sprintId)
        .then((res) => {
          console.log('[useAgentStatus] getCurrentExecution response:', res);
          if (res.executionArn) {
            setCurrentArn(res.executionArn);
            if (res.status) {
              setStatus({ status: res.status, executionArn: res.executionArn } as AgentExecution);
            }
          } else {
            // Explicitly set to null if no execution
            setCurrentArn(null);
            setStatus(null);
          }
        })
        .catch((err) => console.error('Failed to get current execution:', err));
    }
  }, [projectId, sprintId, sprintAgentStatus]); // Re-fetch when sprint status changes

  const refresh = useCallback(async () => {
    if (!currentArn && !executionId) return;
    setLoading(true);
    try {
      const promises: [
        Promise<AgentExecution> | null,
        Promise<{ questions: AgentQuestion[] }> | null,
      ] = [null, null];
      if (currentArn) {
        promises[0] = agentsService.getStatus(currentArn, executionId || undefined);
      }
      const questionKey = executionId || currentArn;
      if (questionKey) {
        promises[1] = agentsService.getQuestions(questionKey);
      }

      const [execStatus, questionsRes] = await Promise.all(promises);
      if (execStatus) {
        setStatus(execStatus);
        // If agent completed and we have no streaming text, use the stored outputText
        if (
          (execStatus.status === 'SUCCEEDED' || execStatus.status === 'FAILED') &&
          !streamBuffer.current &&
          execStatus.outputText
        ) {
          streamBuffer.current = execStatus.outputText;
          setStreamingText(execStatus.outputText);
          setCompletedOutput(execStatus.outputText);
        } else if (
          execStatus.status === 'FAILED' &&
          execStatus.errorMessage &&
          !streamBuffer.current
        ) {
          const text = formatAgentErrorMessage(execStatus.errorMessage);
          streamBuffer.current = text;
          setStreamingText(text);
          setCompletedOutput(text);
        }
      }
      if (questionsRes) setQuestions(questionsRes.questions || []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch status');
    } finally {
      setLoading(false);
    }
  }, [currentArn, executionId]);

  // Keep refs updated
  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);
  useEffect(() => {
    currentArnRef.current = currentArn;
  }, [currentArn]);
  useEffect(() => {
    projectIdRef.current = projectId;
  }, [projectId]);
  useEffect(() => {
    sprintIdRef.current = sprintId;
  }, [sprintId]);

  // Poll less frequently - streaming handles real-time updates
  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 15000);
    return () => clearInterval(interval);
  }, [refresh]);

  useEffect(() => {
    const unsubscribers = [
      realtimeService.on('agent.started', async () => {
        streamBuffer.current = '';
        chunkDedup.current.reset();
        toolDedup.current.reset();
        toolUpdateDedup.current.reset();
        toolCallCounter.current = 0;
        setStreamingText('');
        setActiveToolCall(null);
        setToolCalls([]);
        setCompletedOutput('');
        if (!currentArnRef.current && projectIdRef.current) {
          try {
            const res = await agentsService.getCurrentExecution(
              projectIdRef.current,
              sprintIdRef.current,
            );
            if (res.executionArn) {
              setCurrentArn(res.executionArn);
              // Set status directly — refreshRef closes over stale currentArn
              setStatus({ status: 'RUNNING', executionArn: res.executionArn } as AgentExecution);
            }
          } catch {}
        } else {
          setStatus((prev) => (prev ? { ...prev, status: 'RUNNING' } : prev));
        }
      }),
      realtimeService.on('agent.completed', async () => {
        setActiveToolCall(null);
        setCompletedOutput(streamBuffer.current);
        setStatus((prev) => (prev ? { ...prev, status: 'SUCCEEDED' } : prev));
        if (!currentArnRef.current && projectIdRef.current) {
          try {
            const res = await agentsService.getCurrentExecution(
              projectIdRef.current,
              sprintIdRef.current,
            );
            if (res.executionArn) setCurrentArn(res.executionArn);
          } catch {}
        }
        // Best-effort refresh to fetch questions; status is already set above
        refreshRef.current();
      }),
      realtimeService.on('agent.question', (data) => {
        setQuestions((prev) => [...prev, data]);
      }),
      realtimeService.on('agent.artifacts', () => {
        setArtifactsUpdated((prev) => prev + 1);
      }),
      realtimeService.on('agent.error', (data) => {
        if (data.agentTaskId) return;
        setStatus((prev) => (prev ? { ...prev, status: 'FAILED' } : prev));
        const message = data.error || data.message;
        if (message && !streamBuffer.current.includes(message)) {
          streamBuffer.current += formatAgentErrorMessage(message);
          setStreamingText(streamBuffer.current);
        }
        // Still save whatever we got as completed output
        if (streamBuffer.current) {
          setCompletedOutput(streamBuffer.current);
        }
        refreshRef.current();
      }),
      realtimeService.on('agent.chunk', (data) => {
        // Deduplicate using chunk-specific tracker
        if (!chunkDedup.current.accept(data.seq)) return;
        // Skip task-agent chunks — those are shown in the task cards via useConstructionStatus
        if (data.agentTaskId) return;
        if (data.text) {
          streamBuffer.current += data.text;
          setStreamingText(streamBuffer.current);
        }
      }),
      realtimeService.on('agent.tool', (data) => {
        // Deduplicate using tool-specific tracker
        if (!toolDedup.current.accept(data.seq)) return;
        const toolName = data.name || data.title;
        // Backend sends 'pending' for new tools (mapped from kiro's 'in_progress')
        // Handle both 'pending' and 'in_progress' for resilience
        const isNewTool = data.status === 'pending' || data.status === 'in_progress';
        if (isNewTool) {
          // Insert paragraph break so markdown renders cleanly after tool output
          if (streamBuffer.current && !streamBuffer.current.endsWith('\n\n')) {
            streamBuffer.current += '\n\n';
            setStreamingText(streamBuffer.current);
          }
          setActiveToolCall(toolName);
          const toolId = data.toolCallId || `tool-${++toolCallCounter.current}`;
          setToolCalls((prev) => [
            ...prev,
            {
              id: toolId,
              name: toolName,
              status: 'pending',
              startedAt: Date.now(),
            },
          ]);
        } else {
          setActiveToolCall(null);
          // Mark the latest pending/running tool with this name as completed
          setToolCalls((prev) => {
            const idx = [...prev]
              .reverse()
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
          });
        }
      }),
      realtimeService.on('agent.tool_update', (data) => {
        if (!toolUpdateDedup.current.accept(data.seq)) return;
        if (data.toolCallId) {
          setToolCalls((prev) =>
            prev.map((t) =>
              t.id === data.toolCallId
                ? { ...t, status: data.status === 'error' ? 'failed' : 'running' }
                : t,
            ),
          );
        }
      }),
    ];
    return () => unsubscribers.forEach((unsub) => unsub());
  }, []); // Subscribe once on mount

  const answerQuestion = async (questionId: string, structuredAnswer: StructuredAnswer) => {
    const questionKey = executionId || currentArn;
    if (!questionKey) return;
    const result = await agentsService.answerQuestion(questionKey, questionId, structuredAnswer);
    if (result.restarted && result.newTaskArn) {
      setCurrentArn(result.newTaskArn);
    }
    await refresh();
  };

  const reset = useCallback(() => {
    streamBuffer.current = '';
    chunkDedup.current.reset();
    toolDedup.current.reset();
    toolUpdateDedup.current.reset();
    toolCallCounter.current = 0;
    setStatus(null);
    setQuestions([]);
    setCurrentArn(null);
    setStreamingText('');
    setActiveToolCall(null);
    setToolCalls([]);
    setCompletedOutput('');
  }, []);

  return {
    status,
    questions,
    loading,
    error,
    refresh,
    answerQuestion,
    reset,
    artifactsUpdated,
    currentArn,
    streamingText,
    activeToolCall,
    toolCalls,
    completedOutput,
    setCompletedOutput,
  };
}
