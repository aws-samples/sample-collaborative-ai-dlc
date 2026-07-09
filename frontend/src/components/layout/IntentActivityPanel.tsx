import { useCallback, useEffect, useRef, useState } from 'react';
import { Bot, Clock, Eye, Maximize2, MessageSquare, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getTimeAgo } from '@/lib/timeAgo';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
import { artifactAccent } from '@/components/intent/artifactAccent';
import { ArtifactEditControls, ArtifactStaleBadge } from '@/components/intent/ArtifactEditControls';
import { ArtifactContentEditor } from '@/components/intent/ArtifactContentEditor';
import { ArtifactMarkdown } from '@/components/intent/ArtifactMarkdown';
import type { IntentActivityEvent, IntentArtifact } from '@/services/intents';

// The v2 intent analog of the sprint ActivityPanel: same 3-tab shell (Agent /
// Timeline / Discuss) hosted in AppShell's right slot, but fed entirely from
// the shared IntentProvider — no own fetching, no sprint services.
//
// "auto" follows the run: it shows the RUNNING stage's output as stages
// progress; picking a stage pins it until the user returns to Follow run.
const FOLLOW_KEY = 'auto';

export function IntentActivityPanel({ onClose }: { onClose: () => void }) {
  const { detail, stageRows, agentFocus, previewSeq } = useIntent();
  const [activeTab, setActiveTab] = useState('timeline');
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

  useEffect(() => {
    if (previewSeq > 0) setActiveTab('preview');
  }, [previewSeq]);

  // Reset pinned selection when the intent changes.
  const intentKey = detail?.intent.id ?? null;
  useEffect(() => {
    setSelectedKey(FOLLOW_KEY);
  }, [intentKey]);

  const running = stageRows.some((s) => s.state === 'RUNNING');
  const events = detail?.events ?? [];

  return (
    <div className="flex h-full w-full flex-col bg-sidebar border-l border-border">
      {/* Header */}
      <div className="flex h-10 items-center justify-between px-3 border-b border-border bg-background/60 shrink-0">
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
            <TabsTrigger value="preview" className="h-6 px-2.5 text-xs gap-1.5">
              <Eye className="h-3 w-3" />
              Preview
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
      ) : activeTab === 'preview' ? (
        <PreviewTab />
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
  const { outputBuffers, outputVersion, stageRows, stageNameOf, ensureOutputs, outputPaneStatus } =
    useIntent();

  // Pane keys ordered like the pipeline: workspace setup first, then every
  // STARTED stage instance in plan order (transcripts load lazily, so a pane
  // is offered for any stage that ran — not just ones with a filled buffer),
  // then any unrecognized buffer keys. Recomputed per render — the panel
  // re-renders on every outputVersion bump anyway, and the maps are tiny.
  const startedKeys = stageRows
    .filter((row) => row.stageInstanceId)
    .map((row) => row.stageInstanceId as string);
  const orderedKeys: string[] = [];
  if (startedKeys.length > 0 || outputBuffers.has(INTENT_OUTPUT_KEY)) {
    orderedKeys.push(INTENT_OUTPUT_KEY);
  }
  orderedKeys.push(...startedKeys);
  for (const k of outputBuffers.keys()) {
    if (!orderedKeys.includes(k) && (outputBuffers.get(k) ?? '').trim().length > 0) {
      orderedKeys.push(k);
    }
  }

  // Follow mode: the RUNNING stage's buffer, else the last started stage (the
  // most recently active). Follow the running stage even before its buffer has
  // content — otherwise, during the gap between a stage going RUNNING and its
  // first streamed token, we'd fall back to the previous stage's output and
  // never advance to the live one. `findLast` picks the most-advanced running
  // row when a prior stage's terminal transition hasn't landed yet (both
  // briefly read RUNNING).
  const runningRow = stageRows.findLast((s) => s.state === 'RUNNING' && s.stageInstanceId);
  const followKey = runningRow?.stageInstanceId ?? orderedKeys[orderedKeys.length - 1] ?? null;

  const displayKey = selectedKey === FOLLOW_KEY ? followKey : selectedKey;
  const content = displayKey ? (outputBuffers.get(displayKey) ?? '') : '';

  // Lazy transcript: seed the displayed pane's durable history on first show
  // (covers manual selection AND follow-mode advancing to a new stage).
  useEffect(() => {
    if (displayKey) ensureOutputs(displayKey);
  }, [displayKey, ensureOutputs]);
  const paneLoading = displayKey ? outputPaneStatus(displayKey) === 'loading' : false;

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
          <p className="text-xs text-muted-foreground">
            {paneLoading ? 'Loading output…' : 'Waiting for output…'}
          </p>
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
  if (type === 'v2.question.answered') return 'bg-agent-success';
  // Artifact create/update notes (broadcast by the MCP layer so artifacts
  // appear in realtime) — green like v1's artifact_created events.
  if (type.startsWith('v2.artifact.')) return 'bg-agent-success';
  if (type === 'v2.question.asked' || type === 'v2.stage.parked') return 'bg-agent-waiting';
  // A non-PASS sensor verdict (advisory or blocking) — flag it like a wait so a
  // gap (e.g. a required artifact "missing") is scannable in the feed.
  if (type === 'v2.sensor.flagged') return 'bg-agent-waiting';
  if (type === 'v2.stage.resumed') return 'bg-agent-running';
  if (type.startsWith('v2.workspace.')) return 'bg-phase-inception';
  return 'bg-muted-foreground';
}

function parseQuestions(
  raw: string | null | undefined,
): { text?: string; options?: { label?: string }[] }[] {
  try {
    const parsed = JSON.parse(raw ?? '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function answerSummary(
  answer: unknown,
  questions: { text?: string; options?: { label?: string }[] }[],
): string {
  if (answer == null) return '';
  if (typeof answer === 'string') return answer;
  if (typeof answer !== 'object') return String(answer);
  const structured = answer as { answers?: { selectedOptions?: unknown[]; freeText?: string }[] };
  if (Array.isArray(structured.answers)) {
    return structured.answers
      .map((a, idx) => {
        const selected = Array.isArray(a.selectedOptions)
          ? a.selectedOptions
              .map((opt) => {
                const optionIndex = typeof opt === 'number' ? opt : Number(opt);
                return Number.isInteger(optionIndex)
                  ? (questions[idx]?.options?.[optionIndex]?.label ?? String(opt))
                  : String(opt);
              })
              .join(', ')
          : '';
        const free = a.freeText?.trim() ?? '';
        return [selected, free].filter(Boolean).join(' · ') || `Answer ${idx + 1}`;
      })
      .filter(Boolean)
      .join('\n');
  }
  return JSON.stringify(answer);
}

function IntentTimelineItem({ event }: { event: IntentActivityEvent }) {
  const { stageNameOf } = useIntent();
  const isAnswer = event.type === 'v2.question.answered';
  const questions = isAnswer ? parseQuestions(event.questions) : [];
  const questionTexts = questions.map((q) => String(q.text ?? '')).filter(Boolean);
  const answer = isAnswer ? answerSummary(event.answer, questions) : '';
  return (
    <div className="flex gap-3 py-2">
      <div className="flex flex-col items-center">
        <div className={cn('h-2 w-2 rounded-full mt-1.5 shrink-0', eventDotColor(event.type))} />
        <div className="w-px flex-1 bg-border mt-1" />
      </div>
      <div className="flex-1 min-w-0 pb-2">
        <p className="text-xs font-medium leading-tight">{event.summary || event.type}</p>
        {isAnswer && (
          <div className="mt-1 space-y-1 rounded border bg-muted/20 px-2 py-1.5 text-[11px]">
            {questionTexts.length > 0 && (
              <p className="line-clamp-3 whitespace-pre-wrap text-muted-foreground">
                {questionTexts.join('\n')}
              </p>
            )}
            {answer && <p className="whitespace-pre-wrap font-medium">{answer}</p>}
            {event.artifacts && event.artifacts.length > 0 && (
              <div className="flex flex-wrap gap-1 pt-0.5">
                {event.artifacts.map((artifact) => (
                  <button
                    key={artifact.id}
                    type="button"
                    className="rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
                    onClick={() =>
                      document
                        .getElementById(`artifact-${artifact.id}`)
                        ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                    }
                  >
                    {artifact.title || artifact.id}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
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

// ---------------------------------------------------------------------------
// Preview tab — renders the selected artifact's markdown content
// ---------------------------------------------------------------------------

function PreviewTab() {
  const { detail, previewArtifactId } = useIntent();
  const discussions = useDiscussions();
  const artifact = detail?.artifacts.find((a) => a.id === previewArtifactId) ?? null;
  const [editingId, setEditingId] = useState<string | null>(null);
  const [overlayOpen, setOverlayOpen] = useState(false);
  const editing = artifact != null && editingId === artifact.id;

  if (!artifact) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-3 py-12 text-center">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted mb-3">
          <Eye className="h-5 w-5 text-muted-foreground" />
        </div>
        <p className="text-sm text-muted-foreground">Select a document to preview</p>
      </div>
    );
  }

  return (
    <>
      <ScrollArea className="flex-1">
        <ArtifactPreviewContent
          artifact={artifact}
          editing={editing}
          onDoneEditing={() => setEditingId(null)}
          onStartEdit={() => setEditingId(artifact.id)}
          onOpenOverlay={() => setOverlayOpen(true)}
          discussions={discussions}
        />
      </ScrollArea>
      <Dialog open={overlayOpen} onOpenChange={setOverlayOpen}>
        <DialogContent className="grid h-[92vh] w-[min(96vw,1200px)] max-w-none grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden p-0">
          <DialogHeader className="border-b px-6 py-4 pr-14">
            <DialogTitle className="truncate text-base">
              {artifact.title || artifact.id}
            </DialogTitle>
            <DialogDescription className="sr-only">
              Expanded artifact preview for {artifact.title || artifact.id}
            </DialogDescription>
          </DialogHeader>
          <ScrollArea className="min-h-0">
            <ArtifactPreviewContent
              artifact={artifact}
              editing={editing}
              onDoneEditing={() => setEditingId(null)}
              onStartEdit={() => setEditingId(artifact.id)}
              discussions={discussions}
              className="px-6 py-5"
              contentClassName="prose-base"
            />
          </ScrollArea>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ArtifactPreviewContent({
  artifact,
  editing,
  onDoneEditing,
  onStartEdit,
  discussions,
  onOpenOverlay,
  className,
  contentClassName,
}: {
  artifact: IntentArtifact;
  editing: boolean;
  onDoneEditing: () => void;
  onStartEdit: () => void;
  discussions: ReturnType<typeof useDiscussions>;
  onOpenOverlay?: () => void;
  className?: string;
  contentClassName?: string;
}) {
  const accent = artifactAccent(artifact.artifactType);
  const title = artifact.title || artifact.id;

  return (
    <div className={cn('px-4 py-3', className)}>
      <div className="flex items-center gap-2 mb-2">
        <span className={cn('h-2 w-2 rounded-full shrink-0', accent.dot)} />
        {artifact.artifactType && (
          <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground/60">
            {artifact.artifactType}
          </span>
        )}
        <ArtifactStaleBadge artifact={artifact} />
      </div>
      <div className="flex items-center gap-2 mb-3">
        <h3 className="text-sm font-semibold min-w-0 flex-1">{title}</h3>
        {onOpenOverlay && (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0"
            onClick={onOpenOverlay}
            title="Open preview overlay"
          >
            <Maximize2 className="h-3 w-3" />
            <span className="sr-only">Open preview overlay</span>
          </Button>
        )}
        {!editing && <ArtifactEditControls artifact={artifact} onStartEdit={onStartEdit} />}
        {discussions && (
          <Button
            variant="ghost"
            className="h-7 px-2 gap-1.5 shrink-0 text-xs"
            onClick={() =>
              discussions.openDiscussion({
                entityType: 'artifact',
                entityId: artifact.id,
                entityTitle: title,
              })
            }
          >
            <MessageSquare className="h-3 w-3" />
            Discuss
          </Button>
        )}
      </div>
      {editing ? (
        <ArtifactContentEditor artifact={artifact} onDone={onDoneEditing} />
      ) : (
        artifact.content && (
          <div className={cn('prose prose-sm dark:prose-invert max-w-none', contentClassName)}>
            <ArtifactMarkdown content={artifact.content} />
          </div>
        )
      )}
    </div>
  );
}
