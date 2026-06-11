import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { X, Bot, Clock, ChevronDown, Wrench, Check, AlertTriangle, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Separator } from '@/components/ui/separator';
import { Badge } from '@/components/ui/badge';
import { realtimeService } from '@/services/realtime';
import { agentsService } from '@/services/agents';
import { timelineEventsService, type TimelineEvent } from '@/services/timelineEvents';
import { useAuth } from '@/contexts/AuthContext';
import { useQuestionLink } from '@/hooks/useQuestionAnchor';
import { DiscussionsTab } from '@/components/discussion/DiscussionsTab';
import { DiscussionPanel, useDiscussions } from '@/components/discussion';
import { MessageSquare } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ToolCallEntry {
  id: string;
  name: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  startedAt: number;
  completedAt?: number;
}

/**
 * Set-based deduplicator — each event type gets its own instance
 * so tool events don't cause text chunks to be dropped.
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

interface ActivityPanelProps {
  sprintId?: string;
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function ActivityPanel({ sprintId, onClose }: ActivityPanelProps) {
  const { projectId } = useParams<{ projectId: string }>();
  const { user } = useAuth();
  const userName = user?.displayName || user?.email || '';
  const [activeTab, setActiveTab] = useState('agent');
  const discussionsCtx = useDiscussions();
  const totalUnread = (discussionsCtx?.discussions ?? []).reduce(
    (sum, d) => sum + (d.unreadCount ?? 0),
    0,
  );

  // -- Agent state --
  const [streamingText, setStreamingText] = useState('');
  const [toolCalls, setToolCalls] = useState<ToolCallEntry[]>([]);
  const [agentRunning, setAgentRunning] = useState(false);
  const [agentStatus, setAgentStatus] = useState<string | null>(null);
  const streamBuffer = useRef('');
  // Separate deduplicators per event type to avoid cross-type drops
  const chunkDedup = useRef(new SeqDeduplicator());
  const toolDedup = useRef(new SeqDeduplicator());
  const toolUpdateDedup = useRef(new SeqDeduplicator());
  const toolCounter = useRef(0);

  // -- Timeline state --
  const [timelineEvents, setTimelineEvents] = useState<TimelineEvent[]>([]);
  const [timelineLoading, setTimelineLoading] = useState(false);

  // Fetch timeline events
  const fetchTimeline = useCallback(async () => {
    if (!sprintId) return;
    setTimelineLoading(true);
    try {
      const events = await timelineEventsService.list(sprintId);
      setTimelineEvents(events);
    } catch {
      /* ignore */
    } finally {
      setTimelineLoading(false);
    }
  }, [sprintId]);

  useEffect(() => {
    fetchTimeline();
    const interval = setInterval(fetchTimeline, 15000);
    return () => clearInterval(interval);
  }, [fetchTimeline]);

  // Hydrate agent running state on mount/reload by checking current execution
  useEffect(() => {
    if (!projectId || !sprintId) return;
    agentsService
      .getCurrentExecution(projectId, sprintId)
      .then((res) => {
        if (res.status === 'RUNNING') {
          setAgentRunning(true);
          setAgentStatus('running');
        }
      })
      .catch(() => {});
  }, [projectId, sprintId]);

  // Subscribe to realtime agent events
  useEffect(() => {
    if (!sprintId) return;

    const unsubs = [
      realtimeService.on('agent.started', () => {
        streamBuffer.current = '';
        chunkDedup.current.reset();
        toolDedup.current.reset();
        toolUpdateDedup.current.reset();
        toolCounter.current = 0;
        setStreamingText('');
        setToolCalls([]);
        setAgentRunning(true);
        setAgentStatus('running');
      }),
      realtimeService.on('agent.completed', () => {
        setAgentRunning(false);
        setAgentStatus('completed');
        fetchTimeline();
      }),
      realtimeService.on('agent.error', () => {
        setAgentRunning(false);
        setAgentStatus('failed');
        fetchTimeline();
      }),
      realtimeService.on('agent.chunk', (data) => {
        if (!chunkDedup.current.accept(data.seq)) return;
        if (data.agentTaskId) return;
        if (data.text) {
          streamBuffer.current += data.text;
          setStreamingText(streamBuffer.current);
        }
      }),
      realtimeService.on('agent.tool', (data) => {
        if (!toolDedup.current.accept(data.seq)) return;
        const toolName = data.name || data.title;
        const isNewTool = data.status === 'pending' || data.status === 'in_progress';
        if (isNewTool) {
          if (streamBuffer.current && !streamBuffer.current.endsWith('\n\n')) {
            streamBuffer.current += '\n\n';
            setStreamingText(streamBuffer.current);
          }
          setToolCalls((prev) => [
            ...prev,
            {
              id: data.toolCallId || `tool-${++toolCounter.current}`,
              name: toolName,
              status: 'pending',
              startedAt: Date.now(),
            },
          ]);
        } else {
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
      // Refresh timeline when artifacts change
      realtimeService.on('artifact.created', () => fetchTimeline()),
      realtimeService.on('agent.question', () => {
        // Timeline event is created server-side in submit-question Lambda (once, not per-client)
        fetchTimeline();
      }),
    ];

    return () => unsubs.forEach((u) => u());
  }, [sprintId, fetchTimeline, userName]);

  // Reset state when sprint changes
  useEffect(() => {
    streamBuffer.current = '';
    chunkDedup.current.reset();
    toolDedup.current.reset();
    toolUpdateDedup.current.reset();
    toolCounter.current = 0;
    setStreamingText('');
    setToolCalls([]);
    setAgentRunning(false);
    setAgentStatus(null);
    setTimelineEvents([]);
  }, [sprintId]);

  return (
    <div className="flex h-full w-full flex-col bg-background border-l">
      {/* Open discussion takes over the panel (non-modal — the rest of the
          app stays interactive). Closing it returns to the tabs. */}
      {discussionsCtx?.isOpen ? (
        <DiscussionPanel />
      ) : (
        <>
          {/* Header */}
          <div className="flex h-10 items-center justify-between px-3 border-b shrink-0">
            <Tabs value={activeTab} onValueChange={setActiveTab}>
              <TabsList className="h-7 p-0.5">
                <TabsTrigger value="agent" className="h-6 px-2.5 text-xs gap-1.5">
                  <Bot className="h-3 w-3" />
                  Agent
                  {agentRunning && (
                    <span className="relative flex h-1.5 w-1.5 ml-0.5">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-agent-running opacity-75" />
                      <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-agent-running" />
                    </span>
                  )}
                </TabsTrigger>
                <TabsTrigger value="timeline" className="h-6 px-2.5 text-xs gap-1.5">
                  <Clock className="h-3 w-3" />
                  Timeline
                  {timelineEvents.length > 0 && (
                    <Badge variant="secondary" className="h-4 px-1 text-[9px] ml-0.5">
                      {timelineEvents.length}
                    </Badge>
                  )}
                </TabsTrigger>
                <TabsTrigger value="discussions" className="h-6 px-2.5 text-xs gap-1.5">
                  <MessageSquare className="h-3 w-3" />
                  Discuss
                  {totalUnread > 0 && (
                    <Badge className="h-4 px-1 text-[9px] ml-0.5">
                      {totalUnread > 99 ? '99+' : totalUnread}
                    </Badge>
                  )}
                </TabsTrigger>
              </TabsList>
            </Tabs>
            <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onClose}>
              <X className="h-3 w-3" />
            </Button>
          </div>

          {/* Content */}
          <ScrollArea className="flex-1">
            {activeTab === 'agent' ? (
              <AgentTab
                streamingText={streamingText}
                toolCalls={toolCalls}
                agentRunning={agentRunning}
                agentStatus={agentStatus}
              />
            ) : activeTab === 'discussions' ? (
              <DiscussionsTab sprintId={sprintId || ''} />
            ) : (
              <TimelineTab events={timelineEvents} loading={timelineLoading} />
            )}
          </ScrollArea>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Agent tab
// ---------------------------------------------------------------------------

function AgentTab({
  streamingText,
  toolCalls,
  agentRunning,
  agentStatus,
}: {
  streamingText: string;
  toolCalls: ToolCallEntry[];
  agentRunning: boolean;
  agentStatus: string | null;
}) {
  if (!agentRunning && !agentStatus && !streamingText && toolCalls.length === 0) {
    return <AgentIdleState />;
  }

  return (
    <div className="p-3 space-y-3">
      {/* Agent stream view */}
      <AgentStreamView
        streamingText={streamingText}
        toolCalls={toolCalls.map((tc) => ({
          name: tc.name,
          status: tc.status,
          elapsed: tc.completedAt ? tc.completedAt - tc.startedAt : undefined,
        }))}
        isStreaming={agentRunning}
        agentStatus={agentStatus}
      />
    </div>
  );
}

function AgentIdleState() {
  return (
    <div className="flex flex-col items-center justify-center py-12 px-3 text-center">
      <div className="h-10 w-10 rounded-full bg-muted flex items-center justify-center mb-3">
        <Bot className="h-5 w-5 text-muted-foreground" />
      </div>
      <p className="text-sm text-muted-foreground">No agent running</p>
      <p className="text-xs text-muted-foreground/60 mt-1">
        Launch an agent from the main view to see activity here
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Agent stream view (also exported for external use)
// ---------------------------------------------------------------------------

export function AgentStreamView({
  streamingText,
  toolCalls,
  isStreaming,
  agentStatus,
  onCancel,
}: {
  streamingText: string;
  toolCalls: Array<{ name: string; status: string; elapsed?: number }>;
  isStreaming: boolean;
  agentStatus: string | null;
  onCancel?: () => void;
}) {
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const outputRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new content arrives
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [streamingText, toolCalls.length]);

  const activeTool = [...toolCalls]
    .reverse()
    .find((tc) => tc.status === 'pending' || tc.status === 'running');
  const completedTools = toolCalls.filter(
    (tc) => tc.status === 'completed' || tc.status === 'failed',
  );

  return (
    <div className="space-y-3">
      {/* Status header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {isStreaming ? (
            <span className="relative flex h-2.5 w-2.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-agent-running opacity-75" />
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-agent-running" />
            </span>
          ) : agentStatus === 'completed' ? (
            <span className="h-2.5 w-2.5 rounded-full bg-agent-success" />
          ) : agentStatus === 'failed' ? (
            <span className="h-2.5 w-2.5 rounded-full bg-agent-error" />
          ) : (
            <span className="h-2.5 w-2.5 rounded-full bg-muted-foreground/30" />
          )}
          <span className="text-xs font-medium">
            {isStreaming
              ? 'Agent running'
              : agentStatus === 'completed'
                ? 'Completed'
                : agentStatus === 'failed'
                  ? 'Failed'
                  : 'Idle'}
          </span>
          {toolCalls.length > 0 && (
            <Badge variant="secondary" className="h-4 px-1 text-[9px]">
              {completedTools.length}/{toolCalls.length} tools
            </Badge>
          )}
        </div>
        {isStreaming && onCancel && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 text-xs text-destructive"
            onClick={onCancel}
          >
            Cancel
          </Button>
        )}
      </div>

      {/* Active tool call -- always visible when a tool is running */}
      {activeTool && (
        <div className="flex items-center gap-2 rounded-md border border-agent-running/30 bg-agent-running/5 px-2.5 py-1.5">
          <Loader2 className="h-3 w-3 text-agent-running animate-spin shrink-0" />
          <span className="text-xs font-mono text-agent-running truncate">{activeTool.name}</span>
          <Badge
            variant="outline"
            className="ml-auto h-4 px-1 text-[9px] border-agent-running/30 text-agent-running shrink-0"
          >
            running
          </Badge>
        </div>
      )}

      {/* Completed tool call history */}
      {completedTools.length > 0 && (
        <div>
          <button
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground w-full"
            onClick={() => setHistoryExpanded(!historyExpanded)}
          >
            <ChevronDown
              className={cn('h-3 w-3 transition-transform', !historyExpanded && '-rotate-90')}
            />
            <Wrench className="h-3 w-3" />
            <span>Tool history ({completedTools.length})</span>
          </button>
          {historyExpanded && (
            <div className="space-y-0.5 ml-5 mt-1">
              {completedTools.map((tc, i) => (
                <div key={i} className="flex items-center gap-2 text-[11px] py-0.5">
                  {tc.status === 'completed' ? (
                    <Check className="h-3 w-3 text-agent-success shrink-0" />
                  ) : (
                    <AlertTriangle className="h-3 w-3 text-agent-error shrink-0" />
                  )}
                  <span className="font-mono text-muted-foreground truncate">{tc.name}</span>
                  {tc.elapsed != null && (
                    <span className="text-muted-foreground/50 ml-auto shrink-0">
                      {(tc.elapsed / 1000).toFixed(1)}s
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Streaming output -- rendered as markdown */}
      {streamingText && (
        <>
          <Separator />
          <div ref={outputRef} className="rounded-md bg-zinc-950 p-3 max-h-[600px] overflow-y-auto">
            <div className="prose prose-invert prose-xs max-w-none [&_p]:text-xs [&_p]:leading-relaxed [&_li]:text-xs [&_h1]:text-sm [&_h2]:text-sm [&_h3]:text-xs [&_pre]:text-[10px] [&_code]:text-[10px]">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{streamingText}</ReactMarkdown>
              {isStreaming && (
                <span className="inline-block w-1.5 h-3.5 bg-zinc-400 animate-pulse ml-0.5 align-middle" />
              )}
            </div>
          </div>
        </>
      )}

      {/* Fallback: agent running but no text and no active tool */}
      {isStreaming && !streamingText && !activeTool && (
        <div className="flex items-center gap-2 py-4 justify-center text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          <span className="text-xs">Waiting for agent output...</span>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Timeline tab
// ---------------------------------------------------------------------------

function TimelineTab({ events, loading }: { events: TimelineEvent[]; loading: boolean }) {
  if (loading && events.length === 0) {
    return (
      <div className="p-3 space-y-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex gap-3 py-2 animate-pulse">
            <div className="h-2 w-2 rounded-full bg-muted mt-1.5" />
            <div className="flex-1 space-y-1.5">
              <div className="h-3 w-3/4 rounded bg-muted" />
              <div className="h-2 w-1/2 rounded bg-muted" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (events.length === 0) {
    return <TimelineEmptyState />;
  }

  return (
    <div className="p-3 space-y-0">
      {events.map((event) => (
        <TimelineEventItem key={event.id} event={event} />
      ))}
    </div>
  );
}

function TimelineEmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-12 px-3 text-center">
      <div className="h-10 w-10 rounded-full bg-muted flex items-center justify-center mb-3">
        <Clock className="h-5 w-5 text-muted-foreground" />
      </div>
      <p className="text-sm text-muted-foreground">No events yet</p>
      <p className="text-xs text-muted-foreground/60 mt-1">
        Sprint activity will appear here as it happens
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Timeline event item (also exported for external use)
// ---------------------------------------------------------------------------

export function TimelineEventItem({ event }: { event: TimelineEvent }) {
  const timeAgo = getTimeAgo(event.timestamp);
  const { color } = getEventStyle(event.type);
  const openQuestion = useQuestionLink();
  const linkable = !!event.questionId;

  return (
    <div className="flex gap-3 py-2">
      <div className="flex flex-col items-center">
        <div className={cn('h-2 w-2 rounded-full mt-1.5 shrink-0', color)} />
        <div className="w-px flex-1 bg-border mt-1" />
      </div>
      <div className="flex-1 min-w-0 pb-2">
        {linkable ? (
          <button
            type="button"
            onClick={() => openQuestion(event.questionId!)}
            title="Go to question"
            className="text-xs font-medium leading-tight text-left hover:underline cursor-pointer"
          >
            {event.title}
          </button>
        ) : (
          <p className="text-xs font-medium leading-tight">{event.title}</p>
        )}
        <div className="flex items-center gap-2 mt-0.5">
          {event.userName && (
            <span className="text-[10px] text-muted-foreground">{event.userName}</span>
          )}
          <span className="text-[10px] text-muted-foreground/60">{timeAgo}</span>
        </div>
        {event.detail && (
          <p className="text-[11px] text-muted-foreground mt-1 line-clamp-2">{event.detail}</p>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getTimeAgo(timestamp: string): string {
  const now = Date.now();
  const then = new Date(timestamp).getTime();
  const diff = now - then;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

function getEventStyle(type: string): { color: string } {
  switch (type) {
    case 'agent_started':
    case 'agent_completed':
      return { color: 'bg-phase-inception' };
    case 'agent_failed':
      return { color: 'bg-agent-error' };
    case 'question_asked':
    case 'question_answered':
      return { color: 'bg-agent-waiting' };
    case 'artifact_created':
    case 'artifact_updated':
      return { color: 'bg-agent-success' };
    case 'artifact_deleted':
    case 'started_over':
      return { color: 'bg-agent-error' };
    case 'phase_changed':
      return { color: 'bg-phase-construction' };
    default:
      return { color: 'bg-muted-foreground' };
  }
}
