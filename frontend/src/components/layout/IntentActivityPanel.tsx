import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp, Bot, Clock, Eye, Maximize2, MessageSquare, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatAbsolute } from '@/lib/timeAgo';
import { displayStageName } from '@/lib/displayNames';
import {
  buildTimeline,
  countTimeline,
  filterTimeline,
  sentenceCaseSlug,
  type TimelinePerson,
  type TimelineEntry,
  type TimelineFilter,
  type TimelineGroup,
  type TimelineTone,
} from '@/lib/timelineEvents';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/empty-state';
import { Disclosure } from '@/components/ui/disclosure';
import { TechnicalDetails } from '@/components/ui/technical-details';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
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
import { focusWorkProduct } from '@/components/intent/workProductsFocus';
import { ArtifactEditControls, ArtifactStaleBadge } from '@/components/intent/ArtifactEditControls';
import { ArtifactContentEditor } from '@/components/intent/ArtifactContentEditor';
import { ArtifactHistoryDrawer } from '@/components/intent/ArtifactHistoryDrawer';
import { ArtifactContent } from '@/components/intent/ArtifactContent';
import { ArtifactBodyStatus } from '@/components/intent/ArtifactBodyStatus';
import { type OpenArtifact } from '@/components/intent/ArtifactMarkdown';
import { scrollToReference } from '@/components/layout/scrollToReference';
import { AgentOutputTranscript } from '@/components/agent-output/AgentOutputTranscript';
import { useIntentGraph, type GraphNeighbor } from '@/hooks/useIntentGraph';
import { useAuth } from '@/contexts/AuthContext';
import { nodeTypeBadge, shortNodeType, humanEdgeLabel } from '@/components/graph/nodeStyles';
import type { IntentActivityEvent, IntentArtifact, IntentGraphNode } from '@/services/intents';

// The v2 intent analog of the sprint ActivityPanel: same 3-tab shell (Agent /
// Timeline / Discuss) hosted in AppShell's right slot, but fed entirely from
// the shared IntentProvider — no own fetching, no sprint services.
//
// "auto" follows the run: it shows the RUNNING stage's output as stages
// progress; picking a stage pins it until the user returns to Follow run.
const FOLLOW_KEY = 'auto';

export function IntentActivityPanel({ onClose }: { onClose: () => void }) {
  const { detail, loading, stageRows, agentFocus, previewSeq, activityTabRequest, projectId } =
    useIntent();
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

  useEffect(() => {
    if (activityTabRequest) setActiveTab(activityTabRequest.tab);
  }, [activityTabRequest]);

  // Reset pinned selection when the intent changes.
  const intentKey = detail?.intent.id ?? null;
  useEffect(() => {
    setSelectedKey(FOLLOW_KEY);
  }, [intentKey]);

  const running = stageRows.some((s) => s.state === 'RUNNING');
  const events = detail?.events ?? [];

  // A missing or unloadable intent has no run to report on: the panel must not
  // claim "No events yet" about it (R5-30).
  if (!loading && !detail) {
    return (
      <div className="flex h-full w-full flex-col border-l border-border bg-sidebar">
        <div className="flex h-10 shrink-0 items-center justify-end border-b border-border bg-background/60 px-3">
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 shrink-0"
            onClick={onClose}
            aria-label="Close activity panel"
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
        <p className="px-3 py-12 text-center text-sm text-muted-foreground">
          Nothing to show for this intent.
        </p>
      </div>
    );
  }

  return (
    <Tabs
      value={activeTab}
      onValueChange={setActiveTab}
      className="flex h-full w-full flex-col bg-sidebar border-l border-border"
    >
      {/* Header */}
      <div className="flex h-10 items-center gap-1 px-3 border-b border-border bg-background/60 shrink-0">
        <div className="min-w-0 flex-1 overflow-x-auto [scrollbar-width:none] [-webkit-overflow-scrolling:touch] [&::-webkit-scrollbar]:hidden">
          <TabsList className="h-7 p-0.5 flex-nowrap">
            <TabsTrigger value="agent" className="h-6 px-2 text-xs gap-1">
              <Bot className="h-3 w-3 shrink-0" />
              Agent
              {running && (
                <span className="relative flex h-1.5 w-1.5 ml-0.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-agent-running opacity-75" />
                  <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-agent-running" />
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger value="timeline" className="h-6 px-2 text-xs gap-1">
              <Clock className="h-3 w-3 shrink-0" />
              Timeline
            </TabsTrigger>
            <TabsTrigger value="discussions" className="h-6 px-2 text-xs gap-1">
              <MessageSquare className="h-3 w-3 shrink-0" />
              Discuss
              {totalUnread > 0 && (
                <Badge size="sm" className="ml-0.5 h-4 px-1">
                  {totalUnread > 99 ? '99+' : totalUnread}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="preview" className="h-6 px-2 text-xs gap-1">
              <Eye className="h-3 w-3 shrink-0" />
              Preview
            </TabsTrigger>
          </TabsList>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 shrink-0"
          onClick={onClose}
          aria-label="Close activity panel"
        >
          <X className="h-3 w-3" />
        </Button>
      </div>

      {/* Content. The Discuss tab swaps between the thread list and the open
          thread; the Agent tab manages its own scrolling (stick-to-bottom), so
          both render outside the shared ScrollArea. One tabpanel hosts the
          active tab so each trigger's aria-controls points at a real panel. */}
      <TabsContent
        value={activeTab}
        className="mt-0 flex min-h-0 flex-1 flex-col focus-visible:ring-inset focus-visible:ring-offset-0"
      >
        {activeTab === 'discussions' && discussionsCtx?.isOpen ? (
          <DiscussionPanel />
        ) : activeTab === 'agent' ? (
          <AgentTab selectedKey={selectedKey} onSelectKey={setSelectedKey} />
        ) : activeTab === 'preview' ? (
          <PreviewTab />
        ) : activeTab === 'discussions' ? (
          <ScrollArea className="flex-1">
            <DiscussionsTab />
          </ScrollArea>
        ) : (
          // Keyed by space + intent: the shell keeps this panel mounted across
          // intent navigation, and held-back events belong to one intent only.
          <TimelineTab
            key={`${projectId ?? ''}:${intentKey ?? ''}`}
            events={events}
            pending={!detail && loading}
          />
        )}
      </TabsContent>
    </Tabs>
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
  const {
    outputBuffers,
    outputRows,
    outputVersion,
    stageRows,
    stageNameOf,
    ensureOutputs,
    outputPaneStatus,
    setPaneVisible,
    hasEarlierOutput,
    hasLoadedEarlierOutput,
    loadEarlierOutput,
  } = useIntent();
  const [viewMode, setViewMode] = useState<'progress' | 'raw'>('progress');

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
  const rows = displayKey ? (outputRows.get(displayKey) ?? []) : [];

  // Lazy transcript: seed the displayed pane's durable history on first show
  // (covers manual selection AND follow-mode advancing to a new stage), and
  // keep it declared visible while shown so it keeps catching up.
  useEffect(() => {
    if (!displayKey) return;
    ensureOutputs(displayKey);
    setPaneVisible(displayKey, true);
    return () => setPaneVisible(displayKey, false);
  }, [displayKey, ensureOutputs, setPaneVisible]);
  const paneStatus = displayKey ? outputPaneStatus(displayKey) : null;
  const paneLoading = paneStatus === 'loading';
  const earlierTrimmed = displayKey ? hasEarlierOutput(displayKey) : false;
  const earlierPartlyLoaded =
    earlierTrimmed && displayKey ? hasLoadedEarlierOutput(displayKey) : false;

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
        <div className="flex items-center gap-2">
          <Select value={selectedKey} onValueChange={onSelectKey}>
            <SelectTrigger className="h-7 min-w-0 flex-1 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={FOLLOW_KEY} className="text-xs">
                Follow run{followKey ? ` — ${displayStageName(stageNameOf(followKey))}` : ''}
              </SelectItem>
              {orderedKeys.map((key) => (
                <SelectItem key={key} value={key} className="text-xs">
                  {displayStageName(stageNameOf(key))}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex h-7 shrink-0 items-center rounded-md border bg-background p-0.5">
            <button
              type="button"
              onClick={() => setViewMode('progress')}
              className={cn(
                'h-6 rounded-sm px-2 text-2xs font-medium',
                viewMode === 'progress'
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              Progress
            </button>
            <button
              type="button"
              onClick={() => setViewMode('raw')}
              className={cn(
                'h-6 rounded-sm px-2 text-2xs font-medium',
                viewMode === 'raw'
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              Raw
            </button>
          </div>
        </div>
      </div>
      <div ref={scrollRef} onScroll={handleScroll} className="min-h-0 flex-1 overflow-auto p-3">
        {earlierTrimmed && displayKey && (
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/40 px-2 py-1.5">
            <p className="text-xs text-muted-foreground">
              {earlierPartlyLoaded
                ? 'Part of the earlier output is still hidden to keep this page fast'
                : 'Earlier output was trimmed to keep this page fast'}
            </p>
            <Button size="xs" variant="outline" onClick={() => loadEarlierOutput(displayKey)}>
              {earlierPartlyLoaded ? 'Load more earlier output' : 'Load earlier output'}
            </Button>
          </div>
        )}
        {paneStatus === 'error' && displayKey && (
          <ErrorState
            size="section"
            className="mb-3"
            title="Agent output could not be loaded"
            onRetry={() => ensureOutputs(displayKey)}
          />
        )}
        {paneStatus === 'error' && !content.trim() ? null : viewMode === 'progress' ? (
          <AgentOutputTranscript
            rows={rows}
            loading={paneLoading}
            hasRaw={content.trim().length > 0}
          />
        ) : content.trim() ? (
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
// Timeline tab — one readable line per lifecycle event, grouped by stage
// (newest first), raw payload one action away, no auto-scroll on new events
// ---------------------------------------------------------------------------

const TIMELINE_FILTERS: { value: TimelineFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'questions', label: 'Questions' },
  { value: 'documents', label: 'Documents' },
  { value: 'errors', label: 'Errors' },
];

const FILTER_EMPTY_COPY: Record<Exclude<TimelineFilter, 'all'>, string> = {
  questions: 'No questions in this run',
  documents: 'No documents in this run',
  errors: 'No errors in this run',
};

const TONE_DOT: Record<TimelineTone, string> = {
  success: 'bg-agent-success',
  waiting: 'bg-agent-waiting',
  error: 'bg-agent-error',
  running: 'bg-agent-running',
  workspace: 'bg-phase-inception',
  neutral: 'bg-muted-foreground',
};

const entryTimeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function formatEntryTime(timestamp: string): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? '' : entryTimeFormatter.format(date);
}

const AT_TOP_PX = 24;

// Space members turn an actor's user id into a readable name. The
// DiscussionProvider already loads them for the page (mentions, roles).
const NO_MEMBERS: readonly TimelinePerson[] = [];

function TimelineTab({
  events,
  pending = false,
}: {
  events: IntentActivityEvent[];
  /** The intent detail has not answered yet: nothing is known about its events. */
  pending?: boolean;
}) {
  const { stageNameOf, stageRows } = useIntent();
  const { user } = useAuth();
  const members = useDiscussions()?.members ?? NO_MEMBERS;
  const [filter, setFilter] = useState<TimelineFilter>('all');
  const [rendered, setRendered] = useState(events);
  const scrollRef = useRef<HTMLDivElement>(null);
  const atTopRef = useRef(true);

  // A reader who scrolled down keeps their position: newer events are held
  // back behind a "N new events" affordance until they ask for them or return
  // to the top. Reloads that shrink or keep the list are applied in place.
  // Scope: one intent — the parent remounts this tab when the intent changes.
  useEffect(() => {
    setRendered((prev) =>
      prev === events || (!atTopRef.current && events.length > prev.length) ? prev : events,
    );
  }, [events]);

  const heldBack = Math.max(0, events.length - rendered.length);
  const showNewEvents = useCallback(() => {
    setRendered(events);
    const el = scrollRef.current;
    if (el) el.scrollTop = 0;
  }, [events]);
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    atTopRef.current = el.scrollTop < AT_TOP_PX;
    if (atTopRef.current) setRendered(events);
  }, [events]);

  const groups = useMemo(
    () => buildTimeline(rendered, { stageNameOf, stages: stageRows, currentUser: user, members }),
    [rendered, stageNameOf, stageRows, user, members],
  );
  const totals = useMemo(() => countTimeline(groups), [groups]);
  const visible = useMemo(() => filterTimeline(groups, filter), [groups, filter]);

  // Loading is not an empty run: skeleton rows until the detail is known.
  if (pending && events.length === 0) {
    return (
      <div className="flex flex-1 flex-col gap-3 px-3 py-4" data-testid="timeline-loading">
        <Skeleton label="Loading run activity" className="h-7 w-48 rounded-md" />
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-11 rounded-md" />
        ))}
      </div>
    );
  }

  if (events.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-3 py-12 text-center">
        <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-muted">
          <Clock className="h-5 w-5 text-muted-foreground" />
        </div>
        <p className="text-sm text-muted-foreground">No events yet</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Run activity will appear here as it happens
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b px-3 py-2">
        <ToggleGroup
          type="single"
          value={filter}
          onValueChange={(value) => {
            if (value) setFilter(value as TimelineFilter);
          }}
          aria-label="Filter timeline"
          className="flex-wrap gap-1"
        >
          {TIMELINE_FILTERS.map(({ value, label }) => (
            <ToggleGroupItem
              key={value}
              value={value}
              className="h-6 gap-1 px-2 text-2xs font-medium data-[state=on]:border-primary"
            >
              {label}
              {/* Only errors carry a count: the one number that asks for a look. */}
              {value === 'errors' && totals.errors > 0 && (
                <span className="font-normal tabular-nums opacity-70">{totals.errors}</span>
              )}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
      <div
        ref={scrollRef}
        data-testid="timeline-scroll"
        onScroll={handleScroll}
        className="relative min-h-0 flex-1 overflow-auto px-3 py-2"
      >
        {heldBack > 0 && (
          <div className="pointer-events-none sticky top-0 z-10 flex justify-center pb-2">
            <Button
              size="xs"
              className="pointer-events-auto shadow-md"
              onClick={showNewEvents}
              aria-live="polite"
            >
              <ArrowUp aria-hidden="true" />
              {heldBack} new {heldBack === 1 ? 'event' : 'events'}
            </Button>
          </div>
        )}
        {visible.length === 0 && filter !== 'all' ? (
          <EmptyState
            size="section"
            title={FILTER_EMPTY_COPY[filter]}
            action={
              <Button size="xs" variant="outline" onClick={() => setFilter('all')}>
                Show all events
              </Button>
            }
          />
        ) : (
          <TimelineGroups groups={visible} filter={filter} />
        )}
      </div>
    </div>
  );
}

function dayKey(timestamp: string): string {
  return formatAbsolute(timestamp, { includeTime: false });
}

const GROUPS_PAGE = 20;

function TimelineGroups({ groups, filter }: { groups: TimelineGroup[]; filter: TimelineFilter }) {
  const [limit, setLimit] = useState(GROUPS_PAGE);
  const firstStageKey = groups.find((g) => g.kind !== 'run')?.key ?? null;
  const shown = groups.slice(0, limit);
  const remaining = groups.length - shown.length;
  let lastDay: string | null = null;
  return (
    <div className="divide-y divide-border/60">
      {shown.map((group) => {
        const day = dayKey(group.latestTimestamp);
        const divider =
          day !== lastDay ? (
            <p className="pb-1 pt-3 text-xs font-medium text-muted-foreground first:pt-1">{day}</p>
          ) : null;
        lastDay = day;
        return (
          <div key={`${group.key}:${filter}`} className="border-0">
            {divider}
            {group.kind === 'run' ? (
              <div className="py-1">
                {group.entries.map((entry) => (
                  <IntentTimelineItem key={entry.key} entry={entry} />
                ))}
              </div>
            ) : (
              <TimelineStageGroup
                group={group}
                defaultOpen={group.key === firstStageKey || filter !== 'all'}
              />
            )}
          </div>
        );
      })}
      {remaining > 0 && (
        <div className="flex justify-center py-3">
          <Button size="xs" variant="outline" onClick={() => setLimit((n) => n + GROUPS_PAGE * 2)}>
            Show earlier activity ({remaining} more {remaining === 1 ? 'stage' : 'stages'})
          </Button>
        </div>
      )}
    </div>
  );
}

function TimelineStageGroup({
  group,
  defaultOpen,
}: {
  group: TimelineGroup;
  defaultOpen: boolean;
}) {
  const status = (
    <>
      {group.counts.errors > 0 && (
        <Badge
          size="sm"
          variant="outline"
          className="border-agent-error/30 bg-agent-error/10 text-agent-error-fg"
        >
          {group.counts.errors} failed
        </Badge>
      )}
      {group.counts.asked > 0 && (
        <Badge
          size="sm"
          variant="outline"
          className="border-agent-waiting/30 bg-agent-waiting/10 text-agent-waiting-fg"
        >
          {group.counts.asked} {group.counts.asked === 1 ? 'question' : 'questions'}
        </Badge>
      )}
    </>
  );
  return (
    <Disclosure
      variant="row"
      title={
        <span className="whitespace-normal break-words">
          {group.name}
          {group.attempt > 1 && <span className="sr-only">{` · attempt ${group.attempt}`}</span>}
        </span>
      }
      description={[
        group.attempt > 1 ? `Attempt ${group.attempt}` : null,
        group.unitName ? `Unit ${group.unitName}` : null,
        `${group.entries.length} ${group.entries.length === 1 ? 'event' : 'events'}`,
      ]
        .filter(Boolean)
        .join(' · ')}
      summary={
        <time
          dateTime={group.latestTimestamp}
          title={formatAbsolute(group.latestTimestamp)}
          className="tabular-nums"
        >
          {formatEntryTime(group.latestTimestamp)}
        </time>
      }
      status={group.counts.errors > 0 || group.counts.asked > 0 ? status : undefined}
      defaultOpen={defaultOpen}
      headingLevel={3}
      className="py-1"
      contentClassName="px-1 pb-2 pt-0"
    >
      {group.entries.map((entry) => (
        <IntentTimelineItem key={entry.key} entry={entry} />
      ))}
    </Disclosure>
  );
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

function IntentTimelineItem({ entry }: { entry: TimelineEntry }) {
  const event = entry.events[entry.events.length - 1];
  const isAnswer = !entry.grouped && event.type === 'v2.question.answered';
  const questions = isAnswer ? parseQuestions(event.questions) : [];
  const questionTexts = questions.map((q) => String(q.text ?? '')).filter(Boolean);
  const answer = isAnswer ? answerSummary(event.answer, questions) : '';
  const time = formatEntryTime(entry.timestamp);
  return (
    <div className="group flex gap-3 py-2">
      <div className="flex flex-col items-center">
        <div className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', TONE_DOT[entry.tone])} />
        <div className="mt-1 w-px flex-1 bg-border" />
      </div>
      <div className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] gap-x-2 pb-1">
        <p className="min-w-0 break-words text-xs font-medium leading-snug">{entry.label}</p>
        {time && (
          <time
            dateTime={entry.timestamp}
            title={formatAbsolute(entry.timestamp)}
            className="pt-px text-2xs tabular-nums text-muted-foreground"
          >
            {time}
          </time>
        )}
        {entry.excerpt && (
          <p className="col-span-2 mt-0.5 line-clamp-3 whitespace-pre-wrap break-words text-xs text-muted-foreground">
            {entry.excerpt}
          </p>
        )}
        {isAnswer && (questionTexts.length > 0 || answer || event.artifacts?.length) && (
          <div className="col-span-2 mt-1 space-y-1 rounded border bg-muted/20 px-2 py-1.5 text-xs">
            {questionTexts.length > 0 && (
              <p className="line-clamp-3 whitespace-pre-wrap text-muted-foreground">
                {questionTexts.join('\n')}
              </p>
            )}
            {answer && <p className="whitespace-pre-wrap font-medium">{answer}</p>}
            {event.artifacts && event.artifacts.length > 0 && (
              <div className="flex flex-wrap gap-1 pt-0.5">
                {event.artifacts.map((artifact) => (
                  <Button
                    key={artifact.id}
                    size="xs"
                    variant="outline"
                    className="h-auto min-h-7 max-w-full whitespace-normal py-1 text-left"
                    onClick={() => focusWorkProduct({ kind: 'artifact', id: artifact.id })}
                  >
                    {artifact.title || 'Document'}
                  </Button>
                ))}
              </div>
            )}
          </div>
        )}
        {/* Ids and raw values one action away, without a visible row under every
            event: the trigger appears on hover/focus and stays while open. */}
        <div className="col-span-2 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 has-[[data-state=open]]:opacity-100">
          <TechnicalDetails title="Details" items={entry.technical} />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Preview tab — renders the selected artifact's markdown content
// ---------------------------------------------------------------------------

function PreviewTab() {
  const {
    detail,
    projectId,
    intentId,
    previewArtifactId,
    previewItemId,
    previewSeq,
    previewAnchor,
    clearPreviewAnchor,
    openArtifactPreview,
    openItemPreview,
    reload,
  } = useIntent();
  const retryContent = reload ? () => void reload() : undefined;
  const discussions = useDiscussions();
  const previewRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  // Shared module-level SWR cache + in-flight dedup → no extra fetch.
  const { derivedItems, getNeighbors } = useIntentGraph(projectId, intentId);
  const artifact = detail?.artifacts.find((a) => a.id === previewArtifactId) ?? null;
  const item = previewItemId ? (derivedItems.find((n) => n.id === previewItemId) ?? null) : null;
  const [editingId, setEditingId] = useState<string | null>(null);
  const [overlayOpen, setOverlayOpen] = useState(false);
  const editing = artifact != null && editingId === artifact.id;
  // A link to an identifier's definition opens its document at that row or
  // heading, in whichever view of the preview is showing. Once per click: the
  // anchor is cleared afterwards, so edits, refreshes and opening the overlay
  // don't pull the reader back to it.
  useEffect(() => {
    if (!previewAnchor) return;
    scrollToReference(
      () => overlayRef.current ?? previewRef.current,
      previewAnchor,
      clearPreviewAnchor,
    );
  }, [previewAnchor, previewSeq, clearPreviewAnchor]);

  if (item) {
    return (
      <ScrollArea className="flex-1">
        <ItemPreviewContent
          item={item}
          neighbors={getNeighbors(item.id)}
          onOpenArtifact={openArtifactPreview}
          onOpenItem={openItemPreview}
          discussions={discussions}
        />
      </ScrollArea>
    );
  }

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
        <div ref={previewRef}>
          <ArtifactPreviewContent
            artifact={artifact}
            artifacts={detail?.artifacts ?? []}
            derivedItems={derivedItems}
            onOpenArtifact={openArtifactPreview}
            onOpenItem={openItemPreview}
            editing={editing}
            onDoneEditing={() => setEditingId(null)}
            onStartEdit={() => setEditingId(artifact.id)}
            onOpenOverlay={() => setOverlayOpen(true)}
            onRetryContent={retryContent}
            discussions={discussions}
          />
        </div>
      </ScrollArea>
      <Dialog open={overlayOpen} onOpenChange={setOverlayOpen}>
        <DialogContent className="grid h-[92vh] w-[96vw] max-w-none grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden p-0">
          <DialogHeader className="border-b px-6 py-4 pr-14">
            <DialogTitle className="truncate text-base">
              {artifact.title || artifact.id}
            </DialogTitle>
            <DialogDescription className="sr-only">
              Expanded artifact preview for {artifact.title || artifact.id}
            </DialogDescription>
          </DialogHeader>
          <ScrollArea className="min-h-0">
            <div ref={overlayRef}>
              <ArtifactPreviewContent
                artifact={artifact}
                artifacts={detail?.artifacts ?? []}
                derivedItems={derivedItems}
                onOpenArtifact={openArtifactPreview}
                onOpenItem={openItemPreview}
                editing={editing}
                onDoneEditing={() => setEditingId(null)}
                onStartEdit={() => setEditingId(artifact.id)}
                onRetryContent={retryContent}
                discussions={discussions}
                className="px-6 py-5"
                contentClassName="prose-base"
              />
            </div>
          </ScrollArea>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ArtifactPreviewContent({
  artifact,
  artifacts,
  derivedItems,
  onOpenArtifact,
  onOpenItem,
  editing,
  onDoneEditing,
  onStartEdit,
  discussions,
  onOpenOverlay,
  onRetryContent,
  className,
  contentClassName,
}: {
  artifact: IntentArtifact;
  artifacts: IntentArtifact[];
  derivedItems: ReturnType<typeof useIntentGraph>['derivedItems'];
  onOpenArtifact: OpenArtifact;
  onOpenItem: (itemId: string) => void;
  editing: boolean;
  onDoneEditing: () => void;
  onStartEdit: () => void;
  discussions: ReturnType<typeof useDiscussions>;
  onOpenOverlay?: () => void;
  onRetryContent?: () => void;
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
          <span className="text-2xs font-medium text-muted-foreground">
            {sentenceCaseSlug(artifact.artifactType)}
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
        <ArtifactHistoryDrawer artifact={artifact} />
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
      ) : artifact.content ? (
        <div className={cn('prose prose-sm dark:prose-invert max-w-none', contentClassName)}>
          <ArtifactContent
            artifactType={artifact.artifactType}
            content={artifact.content}
            artifactId={artifact.id}
            title={title}
            artifacts={artifacts}
            derivedItems={derivedItems}
            onOpenArtifact={onOpenArtifact}
            onOpenItem={onOpenItem}
          />
        </div>
      ) : (
        <ArtifactBodyStatus artifact={artifact} onRetry={onRetryContent} />
      )}
    </div>
  );
}

// snake_case field name → Title Case label (acceptance_criteria → "Acceptance Criteria").
function humanizeFieldName(name: string): string {
  return name
    .split('_')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// Derived-item types that have a previewable node (units are excluded from
// useIntentGraph.derivedItems, so opening a unit preview would find nothing).
// Mirrors IntentGraphPopover's navigable split.
const PREVIEWABLE_ITEM_TYPES = new Set([
  'Story',
  'Persona',
  'Requirement',
  'Component',
  'Decision',
  'StoryMapEntry',
  'Contract',
]);

// Type-agnostic preview for a derived typed item. Renders whatever descriptive
// fields the item carries (from the schema-driven itemFields projection) plus
// its relationships (from graph edges, clickable). No per-type layout.
function ItemPreviewContent({
  item,
  neighbors,
  onOpenArtifact,
  onOpenItem,
  discussions,
}: {
  item: IntentGraphNode;
  neighbors: GraphNeighbor[];
  onOpenArtifact: (artifactId: string) => void;
  onOpenItem: (itemId: string) => void;
  discussions: ReturnType<typeof useDiscussions>;
}) {
  const fields = item.itemFields ?? [];

  // Group relationships by direction + edge label, mirroring the popover. The
  // incoming HAS_ITEM edge (source artifact → item) is skipped: it's the parent
  // doc, already surfaced by the dedicated "Open source artifact" button below.
  const grouped = new Map<string, GraphNeighbor[]>();
  for (const n of neighbors) {
    if (n.edgeLabel === 'HAS_ITEM') continue;
    const key = `${n.direction}:${n.edgeLabel}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(n);
  }

  const openNeighbor = (n: GraphNeighbor) => {
    if (n.type === 'Artifact') {
      onOpenArtifact(n.id);
    } else if (PREVIEWABLE_ITEM_TYPES.has(n.type)) {
      onOpenItem(n.id);
    }
  };
  const isClickable = (n: GraphNeighbor): boolean =>
    n.type === 'Artifact' || PREVIEWABLE_ITEM_TYPES.has(n.type);

  return (
    <div className="px-4 py-3">
      <div className="flex items-center gap-2 mb-2">
        <Badge
          variant="outline"
          size="sm"
          className={cn('uppercase tracking-wider', nodeTypeBadge(item.type))}
        >
          {shortNodeType(item.type)}
        </Badge>
      </div>
      <div className="flex items-start gap-2 mb-3">
        <h3 className="text-base font-semibold min-w-0 flex-1">{item.label}</h3>
        {discussions && (
          <Button
            variant="ghost"
            className="h-7 px-2 gap-1.5 shrink-0 text-xs"
            onClick={() =>
              discussions.openDiscussion({
                entityType: 'item',
                entityId: item.id,
                entityTitle: item.label,
              })
            }
          >
            <MessageSquare className="h-3 w-3" />
            Discuss
          </Button>
        )}
      </div>

      {(item.priority || item.status) && (
        <div className="flex flex-wrap items-center gap-1.5 mb-4">
          {item.priority && (
            <Badge variant="secondary" className="h-5 px-1.5 text-xs">
              {item.priority}
            </Badge>
          )}
          {item.status && (
            <Badge variant="secondary" className="h-5 px-1.5 text-xs">
              {item.status}
            </Badge>
          )}
        </div>
      )}

      {fields.length > 0 && (
        <div className="space-y-4 mb-5">
          {fields.map((field) => (
            <div key={field.name}>
              <div className="text-2xs uppercase font-semibold tracking-wider text-muted-foreground mb-1">
                {humanizeFieldName(field.name)}
              </div>
              {field.kind === 'list' && Array.isArray(field.value) ? (
                <ul className="list-disc pl-5 space-y-1">
                  {field.value.map((entry, i) => (
                    <li key={`${field.name}-${i}`} className="text-sm text-foreground">
                      {entry}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-foreground whitespace-pre-wrap">{String(field.value)}</p>
              )}
            </div>
          ))}
        </div>
      )}

      {grouped.size > 0 && (
        <div className="space-y-3 mb-5">
          <div className="text-2xs uppercase font-semibold tracking-wider text-muted-foreground">
            Relationships
          </div>
          {Array.from(grouped.entries()).map(([key, items]) => {
            const edgeLabel = key.slice(key.indexOf(':') + 1);
            return (
              <div key={key}>
                <div className="text-2xs uppercase tracking-wider text-muted-foreground mb-1">
                  {humanEdgeLabel(edgeLabel)}
                </div>
                <div className="space-y-0.5 ml-2">
                  {items.map((neighbor) => {
                    const rowKey = `${neighbor.id}:${neighbor.edgeLabel}:${neighbor.direction}`;
                    const badge = (
                      <Badge
                        variant="outline"
                        size="sm"
                        className={cn('shrink-0', nodeTypeBadge(neighbor.type))}
                      >
                        {shortNodeType(neighbor.type)}
                      </Badge>
                    );
                    return isClickable(neighbor) ? (
                      <button
                        key={rowKey}
                        type="button"
                        className="flex w-full items-center gap-2 rounded px-1 py-1 text-left hover:bg-muted/60 transition-colors"
                        title={neighbor.label}
                        onClick={() => openNeighbor(neighbor)}
                      >
                        {badge}
                        <span className="text-sm text-foreground truncate">{neighbor.label}</span>
                      </button>
                    ) : (
                      <div
                        key={rowKey}
                        className="flex items-center gap-2 px-1 py-1"
                        title={neighbor.label}
                      >
                        {badge}
                        <span className="text-sm text-muted-foreground truncate">
                          {neighbor.label}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {item.artifactId && (
        <Button
          variant="outline"
          size="sm"
          className="h-8 px-3 gap-1.5 text-sm"
          onClick={() => onOpenArtifact(item.artifactId as string)}
        >
          <Eye className="h-3.5 w-3.5" />
          Open source artifact
        </Button>
      )}
    </div>
  );
}
