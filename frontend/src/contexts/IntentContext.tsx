import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { Dispatch, ReactNode, SetStateAction } from 'react';
import { useParams } from 'react-router';
import {
  intentsService,
  type GateAnswer,
  type Intent,
  type IntentArtifact,
  type IntentDetail,
  type IntentGate,
  type IntentOutput,
  type IntentSensorRun,
  type IntentStage,
  type IntentSteering,
  type StageState,
} from '@/services/intents';
import type { CompiledWorkflow, PhaseNode } from '@/services/workflows';
import { useProjectCache } from '@/hooks/useProjectsCache';
import {
  stageResponsibilitiesService,
  type GateResponsibility,
  type StageResponsibility,
  type StageResponsibilities,
} from '@/services/stageResponsibilities';
import { realtimeService } from '@/services/realtime';
import { useIntentEvents, type IntentEvent } from '@/hooks/useIntentEvents';
import { invalidateIntentGraph } from '@/hooks/useIntentGraph';
import { useVisiblePoll } from '@/hooks/useVisiblePoll';
import { queryClient } from '@/lib/queryClient';
import { isCancelledError } from '@tanstack/react-query';
import { errorHttpStatus, isNotFoundStatus } from '@/lib/httpStatus';
import { qk } from '@/lib/queryKeys';
import { useQuery } from '@tanstack/react-query';
import { latestActivityAt } from '@/lib/statusModel';
import { getIntentStageSelection } from '@/lib/intentStageSelection';
import { intentCompiledQuery, intentDetailQuery } from '@/lib/intentEntry';
import { workflowDetailQuery } from '@/lib/authoringQueries';
import {
  applyArtifactContents,
  artifactContentIdentities,
  carryArtifactContent,
  markArtifactContentsFailed,
} from '@/contexts/artifactContent';

// Shared state for the v2 intent experience (the SprintContext analog). The
// provider is mounted once in AppShell — INERT off intent routes (no ids → no
// fetch, no realtime) — so both the routed IntentView and the AppShell-hosted
// IntentActivityPanel consume one fetch/realtime/output-buffer state.

// Output buffers are keyed by stage instance; outputs with no stage (init-ws /
// general run output) accumulate under this key.
export const INTENT_OUTPUT_KEY = 'intent';

// A plan stage merged with its live STAGE row(s). Plan stages with no row yet
// render as PENDING; live rows outside the plan are appended. A `forEach:
// unit-of-work` stage has ONE row PER UNIT INSTANCE (docs/v2-parallel.md WP4)
// — rows are identified by `rowKey`, never by stageId alone.
export interface IntentStageRow {
  stageId: string;
  phase: string | null;
  state: StageState;
  stageInstanceId: string | null;
  /** Unit lane this instance belongs to; null for once-per-workflow stages. */
  unitSlug: string | null;
  sectionIndex?: number | null;
  runtimeError: string | null;
  startedAt: string | null;
  completedAt: string | null;
  /** Accumulated human-wait milliseconds across park/resume cycles. */
  waitMs: number;
  /** Open park's start (set while WAITING_FOR_HUMAN), for live wait ticking. */
  parkedAt: string | null;
  pendingHumanTaskId: string | null;
  attempt: number;
  cli: string | null;
  resolvedModel: string | null;
  order: number;
  /** false when the row exists only in live state (plan missing/diverged). */
  planned: boolean;
}

// The stable per-row identity: the deterministic stage-instance id when the
// row exists (unique per unit instance), else the plan stageId (a PENDING
// plan stage has exactly one row, so stageId is unique among those).
export const stageRowKey = (row: Pick<IntentStageRow, 'stageId' | 'stageInstanceId'>): string =>
  row.stageInstanceId ?? row.stageId;

export interface StageEdge {
  from: string;
  to: string;
  artifact?: string;
  kind: 'data' | 'requires' | 'blocks';
}

// A request to focus the sidebar Agent tab on one buffer key. `seq` makes each
// request distinct so repeated clicks on the same stage still re-focus.
export interface AgentFocusRequest {
  key: string;
  seq: number;
}

export type ActivityTab = 'agent' | 'timeline' | 'discussions' | 'preview';

// A request to show one activity-panel tab; `seq` makes repeated requests for
// the same tab distinct so each click re-opens it.
export interface ActivityTabRequest {
  tab: ActivityTab;
  seq: number;
}

// Lazy transcript pane state. The detail DTO carries NO outputs (a long run's
// transcript is megabytes and the DTO is polled) — each pane's durable history
// is fetched once, on first display, from GET .../outputs, and merged with the
// live websocket chunks that arrived meanwhile (deduped by seq).
// 'error': the first fetch failed; recovery paths and ensureOutputs retry it.
export type OutputPaneStatus = 'unseeded' | 'loading' | 'seeded' | 'error';
interface OutputPane {
  status: OutputPaneStatus;
  /** Durable chunks fetched from the outputs endpoint. */
  seededRows: IntentOutput[];
  /** Highest seq contained in seededRows — live chunks at or below are dupes. */
  maxSeededSeq: number;
  /**
   * The afterSeq for the next catch-up: the server's cursor, which can move
   * past other stages' chunks (a finished stage's pane stops re-reading them).
   */
  cursor: number;
  /** Live websocket chunks (kept until seeding merges or supersedes them). */
  live: IntentOutput[];
  /** Rendered size in characters (seeded rows + live tail). */
  size: number;
  /** Size ceiling; raised by loadEarlierOutput, reset on eviction. */
  cap: number;
  /** Older rows were dropped to stay under `cap`. */
  truncated: boolean;
  /** Highest seq dropped by the cap (0 = nothing dropped). */
  droppedThroughSeq: number;
  /**
   * On-demand view of the transcript's beginning, for a pane already at the
   * max cap: `rows` cover everything up to `cursor` (each further load
   * continues from it). Bounded by the max cap: past it the oldest rows go and
   * `headDropped` is set. Dropped when the pane closes or is reset.
   */
  earlier: { rows: IntentOutput[]; cursor: number; size: number; headDropped: boolean } | null;
  earlierLoading: boolean;
  /** Bumped when the pane is reset, so in-flight pages for the old state drop. */
  epoch: number;
  /** Explicit visibility from setPaneVisible; undefined = recent ensureOutputs. */
  visible: boolean | undefined;
  /** Components currently showing the pane: one hiding it leaves it visible to the rest. */
  viewers: number;
  lastEnsuredAt: number;
  lastAccessAt: number;
}

interface IntentContextValue {
  projectId: string;
  intentId: string;
  detail: IntentDetail | null;
  compiled: CompiledWorkflow | null;
  loading: boolean;
  error: string | null;
  /** HTTP status of the failed detail load (404 → the intent no longer exists), null otherwise. */
  errorStatus: number | null;
  /** The detail request was refused as missing or gone: the intent was deleted or never existed. */
  notFound: boolean;

  // Workflow phase metadata (from the full Workflow object, not compiled DTO).
  workflowPhases: PhaseNode[] | null;
  phaseNameOf: (phasePath: string) => string;
  initializationPhasePaths: Set<string>;
  currentPhasePath: string | null;

  // Derived views
  stageRows: IntentStageRow[];
  stageEdges: StageEdge[];
  gates: IntentGate[];
  pendingGates: IntentGate[];
  steering: IntentSteering[];
  sensorsByStage: Map<string, IntentSensorRun[]>;
  artifactsByStage: Map<string, IntentArtifact[]>;

  // Live streamed output per stage instance (+ INTENT_OUTPUT_KEY). The map is
  // held in a ref for append performance; `outputVersion` bumps on every
  // append so consumers can subscribe to changes.
  outputBuffers: Map<string, string>;
  outputRows: Map<string, IntentOutput[]>;
  outputVersion: number;
  enforceStageRoles: boolean;
  firstNonAutomaticStageId: string | undefined;
  mayControlStage: (stageId?: string | null) => boolean;
  stageAccess: (stageInstanceId: string | null) => StageResponsibility['access'];
  gateAccess: (gate: Pick<IntentGate, 'humanTaskId' | 'stageInstanceId'>) => {
    stage?: GateResponsibility;
    access?: GateResponsibility['access'];
  };
  /** Human name for a buffer key (stageInstanceId → stageId). */
  stageNameOf: (key: string) => string;
  /** Lazily fetch a pane's durable transcript (no-op once seeded/loading). */
  ensureOutputs: (key: string) => void;
  /** Seeding state for a pane key (re-render via outputVersion). */
  outputPaneStatus: (key: string) => OutputPaneStatus;
  /**
   * Declare whether a pane is on screen. Visible panes get the periodic
   * catch-up and are never evicted; without a declaration a pane counts as
   * visible for 60 s after its last ensureOutputs. Declarations are counted:
   * every `true` needs its own `false` (see useVisibleOutputPanes).
   */
  setPaneVisible: (key: string, visible: boolean) => void;
  /**
   * Older output was dropped from this pane to keep it under its size cap and
   * is not on screen yet (also true while a loaded beginning leaves a gap).
   */
  hasEarlierOutput: (key: string) => boolean;
  /** Part of the trimmed output is already shown in front of the tail. */
  hasLoadedEarlierOutput: (key: string) => boolean;
  /**
   * Recover trimmed output: raise the pane's size cap and refetch, or, once at
   * the max cap, load the transcript's beginning in front of the retained tail.
   */
  loadEarlierOutput: (key: string) => void;
  /** Most recent activity seen: events, stages, streamed output, intent.updatedAt. */
  lastActivityAt: string | null;
  /** Gates still waiting for a human (same list as pendingGates). */
  openGates: IntentGate[];

  // Shared UI state — selection is keyed by `stageRowKey` (instance-aware:
  // two unit instances of one stage select independently).
  selectedStageId: string | null;
  setSelectedStageId: Dispatch<SetStateAction<string | null>>;
  agentFocus: AgentFocusRequest | null;
  /** Focus the sidebar Agent tab on a stage's output (null → run-level). */
  focusOutput: (stageInstanceId: string | null) => void;
  activityTabRequest: ActivityTabRequest | null;
  /** Open the activity panel on one of its tabs. */
  openActivityTab: (tab: ActivityTab) => void;
  /** Open the activity panel on the Timeline tab (what "View activity" means on the Work page). */
  openTimeline: () => void;

  /** Preview tab: the artifact currently displayed (null = nothing selected). */
  previewArtifactId: string | null;
  /** Preview tab: the derived item currently displayed (mutually exclusive with artifact). */
  previewItemId: string | null;
  previewSeq: number;
  /** Preview tab: the element to scroll to in the artifact (an identifier's definition). */
  previewAnchor: string | null;
  /** Open a document artifact in the right panel's Preview tab, optionally at an anchor. */
  openArtifactPreview: (artifactId: string, anchor?: string) => void;
  /** The preview scrolled to the anchor (or gave up): don't scroll to it again. */
  clearPreviewAnchor: () => void;
  /** Open a derived item (Story/Requirement/…) in the right panel's Preview tab. */
  openItemPreview: (itemId: string) => void;

  reload: () => Promise<void>;
  answerGate: (gate: IntentGate, input: GateAnswer) => Promise<void>;
  /** Steering: correct an already-given answer (delivered at the next injection point). */
  reviseGate: (gate: IntentGate, message: string) => Promise<void>;
  /** Steering: retire a parked/stranded/failed run (409 while RUNNING). */
  cancelIntent: () => Promise<Intent>;
  /** Permanently delete the intent (graph + process state + realtime docs).
   *  Owner/admin only; 409 while RUNNING. Caller navigates away on success. */
  deleteIntent: () => Promise<void>;
  /** Steering: restart the run from an earlier stage. Guidance optional — with
   *  it a corrective rewind, without it a plain retry of the stage + rest. */
  rewindIntent: (fromStageId: string, guidance?: string) => Promise<void>;
  /** Recovery: re-attempt the durable callback for an already-recorded gate
   *  answer (`intent.resumeRequired`). Idempotent. */
  resumeIntent: () => Promise<void>;
}

// Artifact-body page fetch: attempts and the base back-off between them.
const ARTIFACT_CONTENT_ATTEMPTS = 3;
const ARTIFACT_CONTENT_RETRY_MS = 500;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Polling cadence (ARCH §D): live runs and deliveries every 8 s, a run parked
// on a human every 30 s (websocket events still reload at once), none when
// terminal. Paused while the tab is hidden.
const LIVE_POLL_MS = 8_000;
const WAITING_POLL_MS = 30_000;
const OUTPUT_CATCH_UP_MS = 8_000;

// Transcript retention (ARCH §B).
const PANE_CAP_CHARS = 512 * 1024;
const PANE_MAX_CAP_CHARS = 2 * 1024 * 1024;
const PANE_VISIBLE_WINDOW_MS = 60_000;
const RETAINED_HIDDEN_PANES = 3;

const isCancelled = isCancelledError;

interface LoadFlight {
  inflight: Promise<void> | null;
  trailing: Promise<void> | null;
}

const rowSize = (row: IntentOutput) => (row.content ?? '').length;

const isPaneVisible = (pane: OutputPane, at: number) =>
  pane.visible ?? at - pane.lastEnsuredAt < PANE_VISIBLE_WINDOW_MS;

const needsCatchUp = (pane: OutputPane, at: number) =>
  pane.status === 'seeded' ||
  ((pane.status === 'error' || pane.status === 'unseeded') && isPaneVisible(pane, at));

// Drop a pane's durable history (in-flight pages for the old state are
// discarded by the epoch bump); the caller re-seeds or evicts it.
function resetPane(pane: OutputPane) {
  pane.epoch += 1;
  pane.status = 'unseeded';
  pane.seededRows = [];
  pane.maxSeededSeq = 0;
  pane.cursor = 0;
  pane.truncated = false;
  pane.droppedThroughSeq = 0;
  pane.earlier = null;
  pane.earlierLoading = false;
}

// The loaded beginning of a capped transcript, rendered in front of the
// retained tail: only rows the cap dropped (the rest are already shown), plus a
// marker when the beginning does not reach the tail.
function gapMarker(key: string, seq: number, timestamp: string): IntentOutput {
  return {
    seq,
    stageInstanceId: key === INTENT_OUTPUT_KEY ? null : key,
    kind: 'system',
    content: '\n… Part of the output is not shown here (too large to display) …\n\n',
    timestamp,
    display: {
      type: 'system',
      level: 'info',
      title: 'Part of the output is not shown here (too large to display)',
    },
  };
}

function earlierHead(pane: OutputPane, key: string): IntentOutput[] {
  if (!pane.earlier) return [];
  const head = pane.earlier.rows.filter((row) => row.seq <= pane.droppedThroughSeq);
  if (pane.earlier.headDropped) {
    head.unshift(gapMarker(key, 0, head[0]?.timestamp ?? ''));
  }
  if (pane.earlier.cursor < pane.droppedThroughSeq) {
    head.push(gapMarker(key, pane.earlier.cursor, head.at(-1)?.timestamp ?? ''));
  }
  return head;
}

const earlierGapRemains = (pane: OutputPane) =>
  pane.truncated && (!pane.earlier || pane.earlier.cursor < pane.droppedThroughSeq);

/** Drop cached intent and workflow reads (for test isolation). */
export function clearIntentCache() {
  queryClient.removeQueries({ queryKey: ['intent'] });
  queryClient.removeQueries({ queryKey: ['workflow'] });
}

const IntentContext = createContext<IntentContextValue | undefined>(undefined);

// Keep these callbacks in their own scope. In the provider's render scope,
// openTimeline captures openActivityTab alongside the loading callbacks; their
// independently changing dependencies can chain old render scopes and details.
function useActivityTabRequest(onAgentFocus?: () => void) {
  const [activityTabRequest, setActivityTabRequest] = useState<ActivityTabRequest | null>(null);
  const activityTabSeq = useRef(0);
  const openActivityTab = useCallback(
    (tab: ActivityTab) => {
      activityTabSeq.current += 1;
      setActivityTabRequest({ tab, seq: activityTabSeq.current });
      onAgentFocus?.();
    },
    [onAgentFocus],
  );
  const openTimeline = useCallback(() => openActivityTab('timeline'), [openActivityTab]);
  return { activityTabRequest, openActivityTab, openTimeline };
}

export function IntentProvider({
  children,
  onAgentFocus,
}: {
  children: ReactNode;
  /** Called when something requests output focus — AppShell opens the panel. */
  onAgentFocus?: () => void;
}) {
  const { projectId = '', intentId = '' } = useParams<{
    projectId: string;
    intentId: string;
  }>();

  const [detail, setDetail] = useState<IntentDetail | null>(null);
  // Latest committed detail, read by the async artifact-body sync.
  const detailRef = useRef<IntentDetail | null>(null);
  const commitDetail = useCallback((next: IntentDetail | null) => {
    detailRef.current = next;
    setDetail(next);
  }, []);
  // One artifact-body sync at a time; a load during a sync queues one more.
  const contentSyncRef = useRef({ running: false, again: false });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [errorStatus, setErrorStatus] = useState<number | null>(null);

  // Live agent.question gates accumulated by humanTaskId (D3 multi-gate).
  // Seeded from the assembled detail, then upserted on each agent.question.
  const [liveGates, setLiveGates] = useState<Map<string, IntentGate>>(new Map());

  // Live streamed output appended per stage instance; durable history is
  // seeded lazily per pane (see ensureOutputs). `outputBufRef` holds the
  // render-ready string per key; `outputRowsRef` holds structured rows for the
  // progress view; `panesRef` holds the merge bookkeeping.
  const outputBufRef = useRef<Map<string, string>>(new Map());
  const outputRowsRef = useRef<Map<string, IntentOutput[]>>(new Map());
  const panesRef = useRef<Map<string, OutputPane>>(new Map());
  const [outputVersion, setOutputVersion] = useState(0);

  const [selectedStageId, setSelectedStageId] = useState<string | null>(null);
  const [agentFocus, setAgentFocus] = useState<AgentFocusRequest | null>(null);
  const focusSeq = useRef(0);
  const { activityTabRequest, openActivityTab, openTimeline } = useActivityTabRequest(onAgentFocus);

  const [previewArtifactId, setPreviewArtifactId] = useState<string | null>(null);
  const [previewItemId, setPreviewItemId] = useState<string | null>(null);
  const [previewSeq, setPreviewSeq] = useState(0);
  const [previewAnchor, setPreviewAnchor] = useState<string | null>(null);
  const previewSeqRef = useRef(0);

  // Guards late async resolutions (compiled fetch) against route changes.
  const activeIntentRef = useRef(intentId);
  activeIntentRef.current = intentId;

  // The detail carries no artifact bodies: page them in after each load and
  // attach each to the revision it was read for.
  const syncArtifactContents = useCallback(async () => {
    if (!projectId || !intentId) return;
    const state = contentSyncRef.current;
    if (state.running) {
      state.again = true;
      return;
    }
    state.running = true;
    const forIntent = intentId;
    const commit = commitDetail;
    const fetchPage = async (cursor: string | null) => {
      for (let attempt = 1; ; attempt += 1) {
        try {
          return await intentsService.artifactContents(projectId, forIntent, cursor);
        } catch (err) {
          if (attempt >= ARTIFACT_CONTENT_ATTEMPTS) throw err;
          await delay(ARTIFACT_CONTENT_RETRY_MS * 2 ** (attempt - 1));
          if (activeIntentRef.current !== forIntent) throw err;
        }
      }
    };
    let identities = new Map<string, string>();
    try {
      do {
        state.again = false;
        const start = detailRef.current;
        if (!start || start.intent.id !== forIntent) break;
        // Bodies carried over from the previous load are current (a rewrite or
        // edit changes the revision identity), so fetch only when one is missing.
        if (!start.artifacts.some((a) => a.content === undefined)) break;
        identities = artifactContentIdentities(start);
        let cursor: string | null = null;
        do {
          const page = await fetchPage(cursor);
          if (activeIntentRef.current !== forIntent) return;
          const current = detailRef.current;
          if (current && current.intent.id === forIntent) {
            const merged = applyArtifactContents(current, page.artifacts, identities);
            if (merged !== current) commit(merged);
          }
          cursor = page.nextCursor;
        } while (cursor);
      } while (state.again && activeIntentRef.current === forIntent);
      // A head the pages never returned (replaced meanwhile) shows Retry, not Loading.
      if (activeIntentRef.current !== forIntent) return;
      const after = detailRef.current;
      if (after && after.intent.id === forIntent) {
        const marked = markArtifactContentsFailed(after, identities);
        if (marked !== after) commit(marked);
      }
    } catch (err) {
      console.warn('Artifact content load failed', err);
      if (activeIntentRef.current !== forIntent) return;
      const current = detailRef.current;
      if (current && current.intent.id === forIntent) {
        const marked = markArtifactContentsFailed(current, identities);
        if (marked !== current) commit(marked);
      }
    } finally {
      state.running = false;
    }
  }, [projectId, intentId, commitDetail]);

  // The raw detail last applied, so a re-render with the same query data does
  // not re-apply it.
  const appliedRef = useRef<IntentDetail | null>(null);

  const applyDetail = useCallback(
    (fetched: IntentDetail) => {
      if (activeIntentRef.current !== intentId || appliedRef.current === fetched) return;
      appliedRef.current = fetched;
      const previous = detailRef.current;
      const dto = carryArtifactContent(
        fetched,
        previous?.intent.id === fetched.intent.id ? previous : null,
      );
      commitDetail(dto);
      void syncArtifactContents();
      setError(null);
      setErrorStatus(null);
      setLoading(false);
      setLiveGates(new Map(dto.gates.map((g) => [g.humanTaskId, g])));
    },
    [intentId, commitDetail, syncArtifactContents],
  );

  const remoteDetail = useQuery({
    ...intentDetailQuery(projectId, intentId),
    enabled: Boolean(projectId && intentId),
    refetchOnWindowFocus: ({ state: { data } }) =>
      data?.delivery?.status === 'in_progress' ||
      ['RUNNING', 'CREATED', 'WAITING'].includes(data?.intent.status ?? ''),
    refetchInterval: ({ state: { data } }) =>
      data?.delivery?.status === 'in_progress' ||
      data?.intent.status === 'RUNNING' ||
      data?.intent.status === 'CREATED'
        ? LIVE_POLL_MS
        : data?.intent.status === 'WAITING'
          ? WAITING_POLL_MS
          : false,
  });
  // Pinned: one compile per pin identity. Unpinned: the shared compile of the
  // workflow version. The detail query starts it as soon as a detail arrives.
  // A failed compile is retried by the next detail read, not by this observer.
  const compiledQuery = useQuery({
    ...intentCompiledQuery(remoteDetail.data),
    enabled: (query) => query.state.status !== 'error',
  });
  const compiled = compiledQuery.data ?? null;

  // Single flight: a reload requested while one runs waits for it, then at
  // most one trailing reload runs (something changed after the first began).
  const flightRef = useRef<LoadFlight>({ inflight: null, trailing: null });
  const load = useCallback((): Promise<void> => {
    const flight = flightRef.current;
    const start = (): Promise<void> => {
      const run: Promise<void> = queryClient
        .refetchQueries({ queryKey: qk.intentDetail(projectId, intentId), exact: true })
        .finally(() => {
          if (flight.inflight === run) flight.inflight = null;
        });
      flight.inflight = run;
      return run;
    };
    if (!projectId || !intentId) return Promise.resolve();
    if (!flight.inflight) return start();
    flight.trailing ??= flight.inflight.then(() => {
      flight.trailing = null;
      return start();
    });
    return flight.trailing;
  }, [projectId, intentId]);
  const reload = load;

  // The transcript panes are swapped before any passive effect runs, so the
  // consumers that seed and show a pane on mount (or on an intent switch)
  // register it in the new intent's map rather than in the one being dropped.
  useLayoutEffect(() => {
    outputBufRef.current = new Map();
    outputRowsRef.current = new Map();
    panesRef.current = new Map();
  }, [projectId, intentId]);

  useEffect(() => {
    contentSyncRef.current = { running: false, again: false };
    flightRef.current = { inflight: null, trailing: null };
    appliedRef.current = null;
    setOutputVersion(0);
    setSelectedStageId(null);
    setAgentFocus(null);
    setError(null);
    setErrorStatus(null);
    commitDetail(null);
    setLiveGates(new Map());
    // A cached detail (stale or not) is applied by the effect below.
    setLoading(Boolean(projectId && intentId));
  }, [projectId, intentId, commitDetail]);

  useEffect(() => {
    if (remoteDetail.data) applyDetail(remoteDetail.data);
    else if (remoteDetail.isSuccess) setLoading(false);
    const failure = remoteDetail.error;
    if (!failure || isCancelled(failure)) return;
    const status = errorHttpStatus(failure);
    setError(failure.message || 'Failed to load intent');
    setErrorStatus(status);
    setLoading(false);
    if (status !== null && [403, 404, 410].includes(status)) {
      appliedRef.current = null;
      commitDetail(null);
      setLiveGates(new Map());
      outputBufRef.current.clear();
      outputRowsRef.current.clear();
      panesRef.current.clear();
      setOutputVersion((version) => version + 1);
      setSelectedStageId(null);
      setAgentFocus(null);
      setPreviewArtifactId(null);
      setPreviewItemId(null);
    }
  }, [remoteDetail.data, remoteDetail.isSuccess, remoteDetail.error, applyDetail, commitDetail]);

  // Polling backstop (ARCH §D). Lifecycle/failure transitions are broadcast
  // live by the orchestrator, but WS frames can be dropped, so a live run is
  // also polled. A poll right after another load (websocket burst, return to a
  // visible tab) is skipped.
  const pollStatus = detail?.intent.status;

  // Refetch debouncing (docs/v2-parallel.md WP7): every lifecycle event used
  // to trigger an immediate full-DTO refetch — N parallel lanes multiply
  // stage/unit/metric events, so bursts must coalesce. Trailing debounce: the
  // first event arms a short timer; every event inside the window rides the
  // same fetch. The poll and post-mutation reloads stay immediate.
  const loadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleLoad = useCallback(() => {
    if (loadTimerRef.current) return;
    loadTimerRef.current = setTimeout(() => {
      loadTimerRef.current = null;
      void load();
    }, 250);
  }, [load]);
  useEffect(
    () => () => {
      if (loadTimerRef.current) clearTimeout(loadTimerRef.current);
    },
    [],
  );

  // ── Lazy transcript panes ─────────────────────────────────────────────────
  const paneOf = useCallback((key: string): OutputPane => {
    let pane = panesRef.current.get(key);
    if (!pane) {
      pane = {
        status: 'unseeded',
        seededRows: [],
        maxSeededSeq: 0,
        cursor: 0,
        live: [],
        size: 0,
        cap: PANE_CAP_CHARS,
        truncated: false,
        droppedThroughSeq: 0,
        earlier: null,
        earlierLoading: false,
        epoch: 0,
        visible: undefined,
        viewers: 0,
        lastEnsuredAt: 0,
        lastAccessAt: Date.now(),
      };
      panesRef.current.set(key, pane);
    }
    return pane;
  }, []);

  // Rebuild a pane's render string: durable history + the live tail (chunks
  // newer than the seed, in seq order — websocket frames can only race the
  // seed fetch, not each other, but sorting is cheap and safe). Over the cap,
  // the oldest rows go (down to 7/8 of it, so streaming does not trim on every
  // chunk); the newest row always stays.
  const renderPane = useCallback(
    (key: string) => {
      const pane = paneOf(key);
      const tail = pane.live
        .filter((c) => c.seq > pane.maxSeededSeq)
        .toSorted((a, b) => a.seq - b.seq);
      let rows = [...pane.seededRows, ...tail];
      let size = rows.reduce((n, row) => n + rowSize(row), 0);
      if (size > pane.cap) {
        const target = (pane.cap * 7) / 8;
        let drop = 0;
        while (size > target && drop < rows.length - 1) {
          size -= rowSize(rows[drop]);
          drop += 1;
        }
        const dropped = new Set(rows.slice(0, drop));
        pane.droppedThroughSeq = rows
          .slice(0, drop)
          .reduce((m, row) => Math.max(m, row.seq), pane.droppedThroughSeq);
        pane.seededRows = pane.seededRows.filter((row) => !dropped.has(row));
        pane.live = pane.live.filter((row) => !dropped.has(row));
        rows = rows.slice(drop);
        pane.truncated = true;
      }
      pane.size = size;
      const head = earlierHead(pane, key);
      if (head.length > 0) rows = [...head, ...rows];
      outputRowsRef.current.set(key, rows);
      outputBufRef.current.set(key, rows.map((c) => c.content).join(''));
      setOutputVersion((n) => n + 1);
    },
    [paneOf],
  );

  // Merge durable output into a pane. This is used both for first display and
  // incremental catch-up after a reconnect: persistence happens before
  // broadcast, so REST can fill every frame missed while the socket was down.
  const syncOutputs = useCallback(
    (key: string) => {
      if (!projectId || !intentId) return;
      const pane = paneOf(key);
      if (pane.status === 'loading') return;
      const initial = pane.status === 'unseeded' || pane.status === 'error';
      if (initial) {
        pane.status = 'loading';
        setOutputVersion((n) => n + 1);
      }
      const forIntent = intentId;
      const epoch = pane.epoch;
      // Responses for a pane that was reset or evicted meanwhile are dropped.
      const current = () =>
        activeIntentRef.current === forIntent &&
        panesRef.current.get(key) === pane &&
        pane.epoch === epoch;
      // A long transcript arrives in pages: follow `more` while the cursor moves.
      const fetchPage = (first: boolean): Promise<void> =>
        intentsService
          .outputs(projectId, forIntent, {
            stageInstanceId: key,
            ...(first && initial ? {} : { afterSeq: pane.cursor }),
          })
          .then(({ outputs: durable, cursor, more }): Promise<void> | undefined => {
            if (!current()) return;
            const before = first && initial ? -1 : pane.cursor;
            const bySeq = new Map(pane.seededRows.map((row) => [row.seq, row]));
            durable.forEach((row) => bySeq.set(row.seq, row));
            pane.seededRows = [...bySeq.values()].toSorted((a, b) => a.seq - b.seq);
            pane.maxSeededSeq = Math.max(
              pane.maxSeededSeq,
              pane.seededRows.reduce((m, o) => Math.max(m, o.seq ?? 0), 0),
            );
            // A server without the cursor resumes from the pane's own last chunk.
            // Catch-ups can overlap, so a late older response must not move the
            // cursor back.
            pane.cursor = Math.max(
              pane.cursor,
              typeof cursor === 'number' ? cursor : pane.maxSeededSeq,
            );
            pane.live = pane.live.filter((c) => c.seq > pane.maxSeededSeq);
            pane.status = 'seeded';
            renderPane(key);
            if (more && pane.cursor > before) return fetchPage(false);
            return undefined;
          });
      fetchPage(true).catch(() => {
        if (!current()) return;
        if (initial && pane.status === 'loading') pane.status = 'error';
        setOutputVersion((n) => n + 1);
      });
    },
    [projectId, intentId, paneOf, renderPane],
  );

  // Retention: visible panes, plus the 3 most recently used hidden panes with
  // durable history. An evicted pane keeps only its live tail and is re-seeded
  // on its next display.
  const evictHiddenPanes = useCallback(() => {
    const at = Date.now();
    const hidden = [...panesRef.current]
      .filter(([, pane]) => pane.status === 'seeded' && !isPaneVisible(pane, at))
      .toSorted(([, a], [, b]) => b.lastAccessAt - a.lastAccessAt);
    let changed = false;
    for (const [key, pane] of hidden.slice(RETAINED_HIDDEN_PANES)) {
      resetPane(pane);
      pane.cap = PANE_CAP_CHARS;
      if (pane.live.length === 0) {
        panesRef.current.delete(key);
        outputBufRef.current.delete(key);
        outputRowsRef.current.delete(key);
      } else {
        renderPane(key);
      }
      changed = true;
    }
    if (changed) setOutputVersion((n) => n + 1);
  }, [renderPane]);

  // Fetch a pane's durable transcript on first display (or again after a
  // failed first fetch); a pane shown again after it stopped counting as
  // visible catches up what it missed.
  const ensureOutputs = useCallback(
    (key: string) => {
      const pane = paneOf(key);
      const at = Date.now();
      const wasVisible = isPaneVisible(pane, at);
      pane.lastEnsuredAt = at;
      pane.lastAccessAt = at;
      if (pane.visible === false) pane.visible = undefined;
      if (
        pane.status === 'unseeded' ||
        pane.status === 'error' ||
        (pane.status === 'seeded' && !wasVisible)
      ) {
        syncOutputs(key);
      }
      evictHiddenPanes();
    },
    [paneOf, syncOutputs, evictHiddenPanes],
  );

  const setPaneVisible = useCallback(
    (key: string, visible: boolean) => {
      const pane = panesRef.current.get(key);
      if (!pane) return;
      const at = Date.now();
      const wasVisible = isPaneVisible(pane, at);
      pane.viewers = visible ? pane.viewers + 1 : Math.max(0, pane.viewers - 1);
      pane.visible = pane.viewers > 0;
      pane.lastAccessAt = at;
      if (visible && !wasVisible && pane.status === 'seeded') syncOutputs(key);
      if (!pane.visible && pane.earlier) {
        pane.earlier = null;
        renderPane(key);
      }
      evictHiddenPanes();
    },
    [syncOutputs, renderPane, evictHiddenPanes],
  );

  const hasEarlierOutput = useCallback((key: string) => {
    const pane = panesRef.current.get(key);
    return !!pane && earlierGapRemains(pane);
  }, []);
  const hasLoadedEarlierOutput = useCallback(
    (key: string) => !!panesRef.current.get(key)?.earlier,
    [],
  );

  // The beginning of a transcript beyond the max cap: page from seq 0 (or, on
  // a further request, from where the loaded part stops) until the rows the
  // cap dropped are covered or this request's 512 KiB budget is spent (a
  // marker then stands for the part in between). Kept outside the capped rows
  // so streaming never trims it; dropped when the pane closes.
  const fetchEarlierOutput = useCallback(
    (key: string, pane: OutputPane) => {
      const forIntent = intentId;
      const epoch = pane.epoch;
      const current = () =>
        activeIntentRef.current === forIntent &&
        panesRef.current.get(key) === pane &&
        pane.epoch === epoch;
      const previous = pane.earlier;
      const rows: IntentOutput[] = [];
      let size = 0;
      const fetchPage = (afterSeq: number | undefined): Promise<number> =>
        intentsService
          .outputs(projectId, forIntent, {
            stageInstanceId: key,
            ...(afterSeq === undefined ? {} : { afterSeq }),
          })
          .then(({ outputs: page, cursor, more }) => {
            for (const row of page.toSorted((a, b) => a.seq - b.seq)) {
              if (size + rowSize(row) > PANE_CAP_CHARS && rows.length > 0) {
                return rows.at(-1)!.seq;
              }
              rows.push(row);
              size += rowSize(row);
            }
            const next = typeof cursor === 'number' ? cursor : (page.at(-1)?.seq ?? afterSeq ?? 0);
            const advanced = afterSeq === undefined || next > afterSeq;
            if (more && advanced && next < pane.droppedThroughSeq && current()) {
              return fetchPage(next);
            }
            return next;
          });
      pane.earlierLoading = true;
      fetchPage(previous?.cursor)
        .then((reached) => {
          if (!current()) return;
          const merged = [...(previous?.rows ?? []), ...rows];
          let total = (previous?.size ?? 0) + size;
          let headDropped = previous?.headDropped ?? false;
          while (total > PANE_MAX_CAP_CHARS && merged.length > 1) {
            total -= rowSize(merged.shift()!);
            headDropped = true;
          }
          pane.earlier = {
            rows: merged,
            cursor: Math.max(reached, previous?.cursor ?? 0),
            size: total,
            headDropped,
          };
          renderPane(key);
        })
        .catch(() => undefined)
        .finally(() => {
          pane.earlierLoading = false;
        });
    },
    [projectId, intentId, renderPane],
  );

  const loadEarlierOutput = useCallback(
    (key: string) => {
      const pane = panesRef.current.get(key);
      if (!pane || pane.status === 'loading' || pane.earlierLoading) return;
      if (!projectId || !intentId) return;
      const at = Date.now();
      pane.lastEnsuredAt = at;
      pane.lastAccessAt = at;
      if (pane.cap >= PANE_MAX_CAP_CHARS) {
        if (earlierGapRemains(pane)) fetchEarlierOutput(key, pane);
        return;
      }
      pane.cap = Math.min(pane.cap * 2, PANE_MAX_CAP_CHARS);
      resetPane(pane);
      syncOutputs(key);
    },
    [projectId, intentId, syncOutputs, fetchEarlierOutput],
  );

  // A reconnect cannot replay frames from API Gateway: catch up every pane
  // holding durable history (bounded by retention) as soon as the channel
  // returns. While RUNNING, visible panes also catch up periodically so a
  // silent intermediary drop heals without user action. Both paths also retry
  // a visible pane whose first fetch failed.
  const catchUpSeededOutputs = useCallback(() => {
    const at = Date.now();
    for (const [key, pane] of panesRef.current) {
      if (needsCatchUp(pane, at)) syncOutputs(key);
    }
  }, [syncOutputs]);
  const catchUpVisibleOutputs = useCallback(() => {
    const at = Date.now();
    for (const [key, pane] of panesRef.current) {
      if (needsCatchUp(pane, at) && isPaneVisible(pane, at)) syncOutputs(key);
    }
    evictHiddenPanes();
  }, [syncOutputs, evictHiddenPanes]);
  useEffect(
    () =>
      realtimeService.onStatusChange((status) => {
        if (status === 'connected') catchUpSeededOutputs();
      }),
    [catchUpSeededOutputs],
  );
  useVisiblePoll(catchUpVisibleOutputs, pollStatus === 'RUNNING' ? OUTPUT_CATCH_UP_MS : null);

  const outputPaneStatus = useCallback(
    (key: string): OutputPaneStatus => panesRef.current.get(key)?.status ?? 'unseeded',
    [],
  );

  // Realtime: refetch on lifecycle transitions; accumulate questions + output live.
  const onEvent = useCallback(
    (evt: IntentEvent) => {
      if (evt.action === 'agent.question' && evt.humanTaskId) {
        setLiveGates((prev) => {
          const next = new Map(prev);
          const existing = next.get(evt.humanTaskId!);
          next.set(evt.humanTaskId!, {
            humanTaskId: evt.humanTaskId!,
            stageInstanceId: evt.stageInstanceId ?? null,
            unitSlug: evt.unitSlug ?? null,
            sectionIndex: evt.sectionIndex ?? null,
            kind:
              evt.kind === 'approval' || evt.kind === 'review-verdict' || evt.kind === 'validation'
                ? evt.kind
                : 'question',
            status: 'pending',
            prompt: evt.prompt ?? null,
            options: evt.options ?? null,
            findings: evt.findings ?? null,
            // The validation gate asks the learnings question only when the
            // engine says so; keep the flag the API copy may already carry.
            learningsRitual: evt.learningsRitual ?? existing?.learningsRitual ?? null,
            // The loop-back target rides only the live event and the API copy;
            // without it the review panel cannot show the loop-back button.
            loopBackTarget: evt.loopBackTarget ?? existing?.loopBackTarget ?? null,
            // The reason and the engine's verdict ride the same event. Without them
            // a reviewer already on the page sees the generic sentence when the
            // option is offered, and nothing at all when it is withheld.
            loopBackReason: evt.loopBackReason ?? existing?.loopBackReason ?? null,
            loopBackStatus: evt.loopBackStatus ?? existing?.loopBackStatus ?? null,
            loopBackNote: evt.loopBackNote ?? existing?.loopBackNote ?? null,
            questions:
              typeof evt.questions === 'string'
                ? evt.questions
                : JSON.stringify(evt.questions ?? null),
            answer: null,
            answeredBy: null,
            answeredByName: null,
            answeredAt: null,
            createdAt: existing?.createdAt ?? null,
          });
          return next;
        });
        return;
      }
      if (evt.action === 'agent.output' && evt.content) {
        const key = evt.stageInstanceId ?? INTENT_OUTPUT_KEY;
        const pane = paneOf(key);
        // Chunks the pane's seed already contains are duplicates (the seed
        // fetch raced the broadcast). A chunk with no seq can't be deduped —
        // treat it as newest so it is never dropped.
        const seq = typeof evt.seq === 'number' ? evt.seq : Number.MAX_SAFE_INTEGER;
        if (pane.status === 'seeded' && seq <= pane.maxSeededSeq) return;
        const row: IntentOutput = {
          seq,
          stageInstanceId: evt.stageInstanceId ?? null,
          unitSlug: evt.unitSlug ?? null,
          sectionIndex: evt.sectionIndex ?? null,
          kind: evt.kind ?? 'stdout',
          content: evt.content,
          timestamp: evt.timestamp ?? new Date().toISOString(),
          ...(evt.display ? { display: evt.display } : {}),
        };
        pane.live.push(row);
        // Cap live rows to prevent unbounded memory growth on long-running intents.
        // Slice to 4000 (not 5000) to amortize the copy across ~1000 appends.
        if (pane.live.length > 5000) {
          pane.live = pane.live.slice(-4000);
        }
        pane.size += rowSize(row);
        if (pane.size > pane.cap) {
          renderPane(key);
          return;
        }
        // Fast path: append to the render string (renderPane would re-join the
        // whole live tail on every streamed token).
        outputBufRef.current.set(key, (outputBufRef.current.get(key) ?? '') + evt.content);
        const rows = outputRowsRef.current.get(key);
        if (rows) {
          rows.push(row);
        } else {
          outputRowsRef.current.set(key, [row]);
        }
        setOutputVersion((n) => n + 1);
        return;
      }
      // A completed derive changed the knowledge graph's derived layer —
      // refresh the shared graph cache (popovers, derived-items section).
      if (evt.action === 'agent.derived') {
        invalidateIntentGraph(projectId, intentId);
        return;
      }
      // The fan-in PR(s) were recorded — a new PullRequest node in the graph
      // and a new work product in the DTO, so refresh both.
      if (evt.action === 'agent.pr') {
        invalidateIntentGraph(projectId, intentId);
        scheduleLoad();
        return;
      }
      // Stage/execution/metric/note/steering/unit transitions → refetch the
      // assembled DTO (debounced — lane bursts coalesce into one fetch).
      if (
        evt.action === 'agent.stage' ||
        evt.action === 'agent.execution' ||
        evt.action === 'agent.workspace' ||
        evt.action === 'agent.metric' ||
        evt.action === 'agent.steering' ||
        evt.action === 'agent.note' ||
        evt.action === 'agent.unit' ||
        evt.action === 'agent.unit-pr' ||
        evt.action === 'agent.feedback' ||
        evt.action === 'intent.attachments'
      ) {
        scheduleLoad();
      }
    },
    [scheduleLoad, paneOf, renderPane, projectId, intentId],
  );
  useIntentEvents(projectId, intentId, onEvent);

  const answerGate = useCallback(
    async (gate: IntentGate, input: GateAnswer) => {
      if (!projectId || !intentId) return;
      await intentsService.answerGate(projectId, intentId, gate.humanTaskId, input);
      await load();
    },
    [projectId, intentId, load],
  );

  const reviseGate = useCallback(
    async (gate: IntentGate, message: string) => {
      if (!projectId || !intentId) return;
      await intentsService.reviseGate(projectId, intentId, gate.humanTaskId, message);
      await load();
    },
    [projectId, intentId, load],
  );

  const cancelIntent = useCallback(async () => {
    const updated = await intentsService.cancel(projectId, intentId);
    await load();
    return updated;
  }, [projectId, intentId, load]);

  // No reload after delete — the intent is gone (a refetch would 404); the
  // caller navigates back to the project page.
  const deleteIntent = useCallback(async () => {
    await intentsService.delete(projectId, intentId);
    // A pinned compile is this intent's own (keyed by the intent); an unpinned
    // one is shared with other intents of the workflow and stays.
    const current = detailRef.current;
    if (
      current?.intent.id === intentId &&
      current.intent.workflowId &&
      current.intent.methodologyRelease
    )
      queryClient.removeQueries({ queryKey: intentCompiledQuery(current).queryKey });
    queryClient.removeQueries({ queryKey: qk.intentDetail(projectId, intentId) });
  }, [projectId, intentId]);

  const rewindIntent = useCallback(
    async (fromStageId: string, guidance?: string) => {
      if (!projectId || !intentId) return;
      await intentsService.rewind(projectId, intentId, {
        fromStageId,
        ...(guidance ? { guidance } : {}),
      });
      await load();
    },
    [projectId, intentId, load],
  );

  const resumeIntent = useCallback(async () => {
    if (!projectId || !intentId) return;
    await intentsService.resume(projectId, intentId);
    await load();
  }, [projectId, intentId, load]);

  const focusOutput = useCallback(
    (stageInstanceId: string | null) => {
      focusSeq.current += 1;
      setAgentFocus({ key: stageInstanceId ?? INTENT_OUTPUT_KEY, seq: focusSeq.current });
      onAgentFocus?.();
    },
    [onAgentFocus],
  );

  const openArtifactPreview = useCallback(
    (artifactId: string, anchor?: string) => {
      previewSeqRef.current += 1;
      setPreviewArtifactId(artifactId);
      setPreviewAnchor(anchor ?? null);
      // Artifact and item previews are mutually exclusive.
      setPreviewItemId(null);
      setPreviewSeq(previewSeqRef.current);
      onAgentFocus?.();
    },
    [onAgentFocus],
  );

  const clearPreviewAnchor = useCallback(() => setPreviewAnchor(null), []);

  const openItemPreview = useCallback(
    (itemId: string) => {
      previewSeqRef.current += 1;
      setPreviewItemId(itemId);
      // Artifact and item previews are mutually exclusive.
      setPreviewArtifactId(null);
      setPreviewSeq(previewSeqRef.current);
      onAgentFocus?.();
    },
    [onAgentFocus],
  );

  // Merge the compiled plan's stages with the live STAGE rows, filtered to the
  // intent's scope: the compiled graph covers ALL placements, but the run only
  // executes stages whose scopeMembership is EXECUTE — without the filter,
  // out-of-scope stages would sit at PENDING forever.
  //
  // WP7 re-key (docs/v2-parallel.md): a `forEach: unit-of-work` stage has ONE
  // live row PER UNIT — the join is stageId → LIST of instances (a 1:1 Map
  // would silently drop all but the last lane), and every instance becomes its
  // own IntentStageRow carrying its unitSlug. Instances of one plan stage sort
  // by unitSlug for a stable render order.
  // Pinned intents take their phases from the pinned compile; unpinned ones
  // follow the workflow's live draft (workflow writes invalidate ['workflow', id]).
  const unpinnedWorkflowId =
    detail && !detail.intent.methodologyRelease ? detail.intent.workflowId || null : null;
  const unpinnedPhases = useQuery({
    ...workflowDetailQuery(unpinnedWorkflowId ?? '', detail?.intent.workflowVersion),
    select: (workflow) => workflow.phases,
    enabled: Boolean(unpinnedWorkflowId),
  });
  const workflowPhases = unpinnedWorkflowId
    ? (unpinnedPhases.data ?? null)
    : detail?.intent.methodologyRelease && compiled
      ? (compiled.phases ?? [])
      : null;

  const initializationPhasePaths = useMemo<Set<string>>(() => {
    if (!workflowPhases) return new Set();
    return new Set(workflowPhases.filter((p) => p.phaseId === 'initialization').map((p) => p.path));
  }, [workflowPhases]);

  const stageRows = useMemo<IntentStageRow[]>(() => {
    const byStageId = new Map<string, IntentStage[]>();
    for (const s of detail?.stages ?? []) {
      if (!s.stageId) continue;
      const list = byStageId.get(s.stageId) ?? [];
      list.push(s);
      byStageId.set(s.stageId, list);
    }
    // Order fan-out instances by the unit DAG's wave order (batches: wave 0
    // first — the walking skeleton / roots — then dependents), NOT alphabetically.
    // Falls back to slug compare for units absent from the plan (e.g. orphans).
    const unitRank = new Map<string, number>();
    (detail?.unitPlan?.batches ?? []).flat().forEach((slug, i) => {
      if (!unitRank.has(slug)) unitRank.set(slug, i);
    });
    const rankOf = (slug: string | null) =>
      slug && unitRank.has(slug) ? (unitRank.get(slug) as number) : Number.MAX_SAFE_INTEGER;
    for (const [key, list] of byStageId) {
      byStageId.set(
        key,
        list.toSorted((a, b) => {
          const ra = rankOf(a.unitSlug ?? null);
          const rb = rankOf(b.unitSlug ?? null);
          return ra !== rb ? ra - rb : (a.unitSlug ?? '').localeCompare(b.unitSlug ?? '');
        }),
      );
    }
    const scope = detail?.intent.scope ?? null;
    // A composed grid replaces the named-scope projection (`scope` is then only
    // the provenance label), so it must win over the scope's baseline grid.
    const grid = detail?.intent.composedGrid ?? (scope ? compiled?.scopeGrid?.[scope] : undefined);
    const selectedIds = new Set(
      detail && compiled
        ? getIntentStageSelection(detail.intent, compiled, initializationPhasePaths).selected.map(
            (n) => n.stageId,
          )
        : [],
    );
    const planNodes = (compiled?.graph.nodes ?? [])
      .filter((n) =>
        initializationPhasePaths.has(n.phasePath ?? '')
          ? !grid || grid[n.stageId] === 'EXECUTE'
          : selectedIds.has(n.stageId),
      )
      .toSorted((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const planIds = new Set(planNodes.map((n) => n.stageId));
    const rows: IntentStageRow[] = planNodes.flatMap((n, i): IntentStageRow[] => {
      const instances = byStageId.get(n.stageId);
      if (!instances || instances.length === 0) {
        return [
          {
            stageId: n.stageId,
            phase: n.phasePath ?? null,
            state: 'PENDING' as StageState,
            stageInstanceId: null,
            unitSlug: null,
            sectionIndex: null,
            runtimeError: null,
            startedAt: null,
            completedAt: null,
            waitMs: 0,
            parkedAt: null,
            pendingHumanTaskId: null,
            attempt: 0,
            cli: null,
            resolvedModel: null,
            order: n.order ?? i,
            planned: true,
          },
        ];
      }
      return instances.map((row) => ({
        stageId: n.stageId,
        // Live rows carry the backend phaseId ('ideation'), the plan carries
        // the phasePath ('01') — mixing them splits one phase into two groups.
        // The plan's path is canonical.
        phase: n.phasePath ?? row.phase ?? null,
        state: row.state,
        stageInstanceId: row.stageInstanceId,
        unitSlug: row.unitSlug ?? null,
        sectionIndex: row.sectionIndex ?? null,
        runtimeError: row.runtimeError ?? null,
        startedAt: row.startedAt ?? null,
        completedAt: row.completedAt ?? null,
        waitMs: row.waitMs ?? 0,
        parkedAt: row.parkedAt ?? null,
        pendingHumanTaskId: row.pendingHumanTaskId ?? null,
        attempt: row.attempt ?? 0,
        cli: row.cli ?? null,
        resolvedModel: row.resolvedModel ?? null,
        order: n.order ?? i,
        planned: true,
      }));
    });
    // Live rows outside the plan (plan unavailable or diverged) still render.
    // Their phase field is the backend phaseId — map it to the workflow path
    // so grouping and the init filter see one vocabulary.
    const pathByPhaseId = new Map((workflowPhases ?? []).map((p) => [p.phaseId, p.path]));
    for (const s of detail?.stages ?? []) {
      if (!s.stageId || planIds.has(s.stageId)) continue;
      rows.push({
        stageId: s.stageId,
        phase: (s.phase ? (pathByPhaseId.get(s.phase) ?? s.phase) : null) ?? null,
        state: s.state,
        stageInstanceId: s.stageInstanceId,
        unitSlug: s.unitSlug ?? null,
        sectionIndex: s.sectionIndex ?? null,
        runtimeError: s.runtimeError ?? null,
        startedAt: s.startedAt ?? null,
        completedAt: s.completedAt ?? null,
        waitMs: s.waitMs ?? 0,
        parkedAt: s.parkedAt ?? null,
        pendingHumanTaskId: s.pendingHumanTaskId ?? null,
        attempt: s.attempt ?? 0,
        cli: s.cli ?? null,
        resolvedModel: s.resolvedModel ?? null,
        order: Number.MAX_SAFE_INTEGER,
        planned: false,
      });
    }
    return rows;
  }, [detail, compiled, workflowPhases, initializationPhasePaths]);

  // Compiled edges restricted to the rendered (in-scope) stages — the graph
  // AND the per-stage dependency list derive from these (the compiled DTO has
  // no dependencyStageIds; that field is orchestrator-internal).
  const stageEdges = useMemo<StageEdge[]>(() => {
    const ids = new Set(stageRows.map((r) => r.stageId));
    return (compiled?.graph.edges ?? []).filter((e) => ids.has(e.from) && ids.has(e.to));
  }, [compiled, stageRows]);

  const gates = useMemo(() => [...liveGates.values()], [liveGates]);
  const pendingGates = useMemo(() => gates.filter((g) => g.status === 'pending'), [gates]);

  const detailActivityAt = useMemo(() => {
    const stamps: (string | null | undefined)[] = [detail?.intent.updatedAt];
    for (const event of detail?.events ?? []) stamps.push(event.timestamp);
    for (const stage of detail?.stages ?? []) {
      stamps.push(stage.startedAt, stage.completedAt, stage.updatedAt);
    }
    return latestActivityAt(stamps);
  }, [detail]);
  // Output rows live in a mutated ref (re-render via outputVersion): read the
  // newest row of each pane on every render, which is a handful of reads.
  const lastActivityAt =
    latestActivityAt([
      detailActivityAt,
      ...[...outputRowsRef.current.values()].map((rows) => rows.at(-1)?.timestamp),
    ]) ?? null;
  const steering = useMemo(() => detail?.steering ?? [], [detail]);

  const { project } = useProjectCache(projectId);
  const [loadedAccess, setLoadedAccess] = useState<{
    key: string;
    data: StageResponsibilities;
  } | null>(null);
  const accessKey = `${projectId}/${intentId}`;
  const gateIds = gates
    .map((gate) => gate.humanTaskId)
    .toSorted()
    .join('/');
  useEffect(() => {
    if (!projectId || !intentId) return;
    let generation = 0;
    const refresh = () => {
      const request = ++generation;
      stageResponsibilitiesService
        .get(projectId, { intentId, actorAccess: true })
        .then((data) => {
          if (request === generation) setLoadedAccess({ key: accessKey, data });
        })
        .catch(() => {
          if (request === generation) setLoadedAccess(null);
        });
    };
    refresh();
    const timer = setInterval(refresh, 30_000);
    window.addEventListener('focus', refresh);
    return () => {
      generation++;
      clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, [projectId, intentId, accessKey, gateIds, detail?.intent.status]);
  const currentAccess = loadedAccess?.key === accessKey ? loadedAccess.data : undefined;
  // Planned placements can have no instance. They cannot identify an artifact or gate.
  const stageForInstance = (id: string | null) =>
    id ? currentAccess?.stages.find((stage) => stage.stageInstanceId === id) : undefined;
  const accessFor = (stage?: GateResponsibility) =>
    stage?.access ?? currentAccess?.unattributedAccess;
  const sensorsByStage = useMemo(() => {
    const map = new Map<string, IntentSensorRun[]>();
    for (const s of detail?.sensorRuns ?? []) {
      const key = s.stageInstanceId ?? INTENT_OUTPUT_KEY;
      const list = map.get(key) ?? [];
      list.push(s);
      map.set(key, list);
    }
    return map;
  }, [detail]);

  const artifactsByStage = useMemo(() => {
    const map = new Map<string, IntentArtifact[]>();
    for (const a of detail?.artifacts ?? []) {
      if (!a.createdByStageInstanceId) continue;
      const list = map.get(a.createdByStageInstanceId) ?? [];
      list.push(a);
      map.set(a.createdByStageInstanceId, list);
    }
    return map;
  }, [detail]);

  const stageNameOf = useCallback(
    (key: string) => {
      if (key === INTENT_OUTPUT_KEY) return 'Workspace setup';
      const row = detail?.stages.find((s) => s.stageInstanceId === key);
      return row?.stageId ?? key;
    },
    [detail],
  );

  const phaseNameOf = useCallback(
    (phasePath: string): string => {
      const capitalize = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
      if (!workflowPhases) return capitalize(phasePath);
      const node = workflowPhases.find((p) => p.path === phasePath);
      if (!node) return capitalize(phasePath);
      return capitalize(node.name);
    },
    [workflowPhases],
  );

  const currentPhasePath = useMemo<string | null>(() => {
    const raw = detail?.intent.currentPhase ?? null;
    if (!raw) return null;
    const matched = workflowPhases?.find((p) => p.phaseId === raw);
    return matched?.path ?? raw;
  }, [detail, workflowPhases]);

  return (
    <IntentContext.Provider
      value={{
        projectId,
        intentId,
        detail,
        compiled,
        loading,
        error,
        errorStatus,
        notFound: isNotFoundStatus(errorStatus),
        workflowPhases,
        phaseNameOf,
        initializationPhasePaths,
        currentPhasePath,
        enforceStageRoles: currentAccess?.enforceStageRoles !== false,
        firstNonAutomaticStageId: currentAccess?.stages.find(
          (stage) => !stage.permissions?.automatic,
        )?.stageId,
        mayControlStage: (id) =>
          project?.userRole === 'owner' ||
          !!accessFor(currentAccess?.stages.find((stage) => stage.stageId === id))?.decide,
        stageAccess: (id) => accessFor(stageForInstance(id)),
        gateAccess: (gate) => {
          const stage =
            currentAccess?.sectionGates?.[gate.humanTaskId] ??
            stageForInstance(gate.stageInstanceId);
          return { stage, access: accessFor(stage) };
        },
        stageRows,
        stageEdges,
        gates,
        pendingGates,
        steering,
        sensorsByStage,
        artifactsByStage,
        outputBuffers: outputBufRef.current,
        outputRows: outputRowsRef.current,
        outputVersion,
        stageNameOf,
        ensureOutputs,
        outputPaneStatus,
        setPaneVisible,
        hasEarlierOutput,
        hasLoadedEarlierOutput,
        loadEarlierOutput,
        lastActivityAt,
        openGates: pendingGates,
        selectedStageId,
        setSelectedStageId,
        agentFocus,
        focusOutput,
        activityTabRequest,
        openActivityTab,
        openTimeline,
        previewArtifactId,
        previewItemId,
        previewSeq,
        previewAnchor,
        openArtifactPreview,
        clearPreviewAnchor,
        openItemPreview,
        reload,
        answerGate,
        reviseGate,
        cancelIntent,
        deleteIntent,
        rewindIntent,
        resumeIntent,
      }}
    >
      {children}
    </IntentContext.Provider>
  );
}

export function useIntent() {
  const context = useContext(IntentContext);
  if (!context) {
    throw new Error('useIntent must be used within an IntentProvider');
  }
  return context;
}

/**
 * Seed the transcript panes a component shows and keep them declared visible
 * while it is mounted, so they keep catching up and are never evicted from
 * under it (a pane without a declaration stops counting as visible 60 s after
 * it was seeded).
 */
export function useVisibleOutputPanes(keys: readonly (string | null | undefined)[]) {
  const { ensureOutputs, setPaneVisible } = useIntent();
  const joined = keys.filter((key): key is string => !!key).join('\n');
  useEffect(() => {
    const shown = joined ? joined.split('\n') : [];
    for (const key of shown) {
      ensureOutputs(key);
      setPaneVisible(key, true);
    }
    return () => {
      for (const key of shown) setPaneVisible(key, false);
    };
  }, [joined, ensureOutputs, setPaneVisible]);
}

/** Safe variant that returns null when outside an IntentProvider (e.g. tests). */
export function useIntentOptional(): IntentContextValue | null {
  return useContext(IntentContext) ?? null;
}
