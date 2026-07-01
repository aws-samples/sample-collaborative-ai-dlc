import { useCallback, useEffect, useRef, useState } from 'react';
import { Bot, Clock, MessageSquare, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { DiscussionsTab } from '@/components/discussion/DiscussionsTab';
import { DiscussionPanel, useDiscussions } from '@/components/discussion';
import { INTENT_OUTPUT_KEY, useIntent } from '@/contexts/IntentContext';
import type { IntentActivityEvent } from '@/services/intents';

// The v2 intent analog of the sprint ActivityPanel: same 3-tab shell (Agent /
// Timeline / Discuss) hosted in AppShell's right slot, but fed entirely from
// the shared IntentProvider — no own fetching, no sprint services.
//
// "auto" follows the run: it shows the RUNNING stage's output as stages
// progress; picking a stage pins it until the user returns to Follow run.
const FOLLOW_KEY = 'auto';

export function IntentActivityPanel({ onClose }: { onClose: () => void }) {
  const { detail, stageRows, agentFocus } = useIntent();
  const [activeTab, setActiveTab] = useState('agent');
  const discussionsCtx = useDiscussions();
  const totalUnread = (discussionsCtx?.discussions ?? []).reduce(
    (sum, d) => sum + (d.unreadCount ?? 0),
    0,
  );

  // Opening a thread (from any entry point) jumps to the Discuss tab, where
  // it swaps in for the list. Other tabs stay reachable while it's open.
  const discussionOpen = !!discussionsCtx?.isOpen;
  const activeDiscussionId = discussionsCtx?.activeDiscussion?.id ?? null;
  useEffect(() => {
    if (discussionOpen) setActiveTab('discussions');
  }, [discussionOpen, activeDiscussionId]);

  // "View output" on a stage focuses the Agent tab on that stage's buffer.
  const [selectedKey, setSelectedKey] = useState<string>(FOLLOW_KEY);
  useEffect(() => {
    if (!agentFocus) return;
    setActiveTab('agent');
    setSelectedKey(agentFocus.key);
  }, [agentFocus]);

  // Reset pinned selection when the intent changes.
  const intentKey = detail?.intent.id ?? null;
  useEffect(() => {
    setSelectedKey(FOLLOW_KEY);
  }, [intentKey]);

  const running = stageRows.some((s) => s.state === 'RUNNING');
  const events = detail?.events ?? [];

  return (
    <div className="flex h-full w-full flex-col bg-background border-l">
      {/* Header */}
      <div className="flex h-10 items-center justify-between px-3 border-b shrink-0">
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="h-7 p-0.5">
            <TabsTrigger value="agent" className="h-6 px-2.5 text-xs gap-1.5">
              <Bot className="h-3 w-3" />
              Agent
              {running && (
                <span className="relative flex h-1.5 w-1.5 ml-0.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-agent-running opacity-75" />
                  <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-agent-running" />
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger value="timeline" className="h-6 px-2.5 text-xs gap-1.5">
              <Clock className="h-3 w-3" />
              Timeline
              {events.length > 0 && (
                <Badge variant="secondary" className="h-4 px-1 text-[9px] ml-0.5">
                  {events.length}
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

      {/* Content. The Discuss tab swaps between the thread list and the open
          thread; the Agent tab manages its own scrolling (stick-to-bottom), so
          both render outside the shared ScrollArea. */}
      {activeTab === 'discussions' && discussionsCtx?.isOpen ? (
        <DiscussionPanel />
      ) : activeTab === 'agent' ? (
        <AgentTab selectedKey={selectedKey} onSelectKey={setSelectedKey} />
      ) : (
        <ScrollArea className="flex-1">
          {activeTab === 'discussions' ? <DiscussionsTab /> : <TimelineTab events={events} />}
        </ScrollArea>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Agent tab — streamed output per stage instance, following the run by default
// ---------------------------------------------------------------------------

function AgentTab({
  selectedKey,
  onSelectKey,
}: {
  selectedKey: string;
  onSelectKey: (key: string) => void;
}) {
  const { outputBuffers, outputVersion, stageRows, stageNameOf } = useIntent();

  // Buffer keys ordered like the pipeline: workspace setup first, then stages
  // in plan order, then anything unrecognized. Recomputed per render — the
  // panel re-renders on every outputVersion bump anyway, and the maps are tiny.
  const withContent = new Set(
    [...outputBuffers.entries()].filter(([, v]) => v.trim().length > 0).map(([k]) => k),
  );
  const orderedKeys: string[] = [];
  if (withContent.has(INTENT_OUTPUT_KEY)) orderedKeys.push(INTENT_OUTPUT_KEY);
  for (const row of stageRows) {
    if (row.stageInstanceId && withContent.has(row.stageInstanceId)) {
      orderedKeys.push(row.stageInstanceId);
    }
  }
  for (const k of withContent) if (!orderedKeys.includes(k)) orderedKeys.push(k);

  // Follow mode: the RUNNING stage's buffer, else the last buffer that has
  // content (the most recently active stage).
  const runningRow = stageRows.find((s) => s.state === 'RUNNING' && s.stageInstanceId);
  const followKey =
    runningRow?.stageInstanceId && outputBuffers.has(runningRow.stageInstanceId)
      ? runningRow.stageInstanceId
      : (orderedKeys[orderedKeys.length - 1] ?? null);

  const displayKey = selectedKey === FOLLOW_KEY ? followKey : selectedKey;
  const content = displayKey ? (outputBuffers.get(displayKey) ?? '') : '';

  // Stick-to-bottom auto-scroll: follow appends unless the user scrolled up.
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  }, []);
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [outputVersion, displayKey]);
  useEffect(() => {
    // A new selection always starts pinned to the bottom.
    stickRef.current = true;
  }, [displayKey]);

  if (orderedKeys.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-3 py-12 text-center">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted mb-3">
          <Bot className="h-5 w-5 text-muted-foreground" />
        </div>
        <p className="text-sm text-muted-foreground">No agent output yet</p>
        <p className="text-xs text-muted-foreground/60 mt-1">
          Stage output streams here while the run is active
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b px-3 py-2">
        <Select value={selectedKey} onValueChange={onSelectKey}>
          <SelectTrigger className="h-7 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={FOLLOW_KEY} className="text-xs">
              Follow run{followKey ? ` — ${stageNameOf(followKey)}` : ''}
            </SelectItem>
            {orderedKeys.map((key) => (
              <SelectItem key={key} value={key} className="text-xs">
                {stageNameOf(key)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div ref={scrollRef} onScroll={handleScroll} className="min-h-0 flex-1 overflow-auto p-3">
        {content.trim() ? (
          <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">
            {content}
          </pre>
        ) : (
          <p className="text-xs text-muted-foreground">Waiting for output…</p>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Timeline tab — the intent's lifecycle events (init-ws, stage transitions,
// questions, completion/failure), newest first
// ---------------------------------------------------------------------------

function TimelineTab({ events }: { events: IntentActivityEvent[] }) {
  if (events.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 px-3 text-center">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted mb-3">
          <Clock className="h-5 w-5 text-muted-foreground" />
        </div>
        <p className="text-sm text-muted-foreground">No events yet</p>
        <p className="text-xs text-muted-foreground/60 mt-1">
          Run activity will appear here as it happens
        </p>
      </div>
    );
  }
  return (
    <div className="px-3 py-2">
      {events.toReversed().map((ev) => (
        <IntentTimelineItem key={ev.eventId} event={ev} />
      ))}
    </div>
  );
}

// v2 event type → dot color (mirrors v1's TimelineEventItem visual, which is
// typed to sprint events and can't be reused directly).
function eventDotColor(type: string): string {
  if (type === 'v2.execution.failed') return 'bg-agent-error';
  if (type === 'v2.execution.succeeded' || type === 'v2.stage.succeeded') {
    return 'bg-agent-success';
  }
  // Artifact create/update notes (broadcast by the MCP layer so artifacts
  // appear in realtime) — green like v1's artifact_created events.
  if (type.startsWith('v2.artifact.')) return 'bg-agent-success';
  if (type === 'v2.question.asked' || type === 'v2.stage.parked') return 'bg-agent-waiting';
  if (type === 'v2.stage.resumed') return 'bg-agent-running';
  if (type.startsWith('v2.workspace.')) return 'bg-phase-inception';
  return 'bg-muted-foreground';
}

function getTimeAgo(timestamp: string): string {
  const diff = Date.now() - new Date(timestamp).getTime();
  if (!Number.isFinite(diff) || diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

function IntentTimelineItem({ event }: { event: IntentActivityEvent }) {
  const { stageNameOf } = useIntent();
  return (
    <div className="flex gap-3 py-2">
      <div className="flex flex-col items-center">
        <div className={cn('h-2 w-2 rounded-full mt-1.5 shrink-0', eventDotColor(event.type))} />
        <div className="w-px flex-1 bg-border mt-1" />
      </div>
      <div className="flex-1 min-w-0 pb-2">
        <p className="text-xs font-medium leading-tight">{event.summary || event.type}</p>
        <div className="flex items-center gap-2 mt-0.5">
          {event.stageInstanceId && (
            <span className="text-[10px] text-muted-foreground">
              {stageNameOf(event.stageInstanceId)}
            </span>
          )}
          {event.timestamp && (
            <span className="text-[10px] text-muted-foreground/60">
              {getTimeAgo(event.timestamp)}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
