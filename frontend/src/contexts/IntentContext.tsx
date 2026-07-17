import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { Dispatch, ReactNode, SetStateAction } from 'react';
import { useParams } from 'react-router-dom';
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
import { workflowsService, type CompiledWorkflow, type PhaseNode } from '@/services/workflows';
import { realtimeService } from '@/services/realtime';
import { useIntentEvents, type IntentEvent } from '@/hooks/useIntentEvents';
import { invalidateIntentGraph } from '@/hooks/useIntentGraph';

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

// Lazy transcript pane state. The detail DTO carries NO outputs (a long run's
// transcript is megabytes and the DTO is polled) — each pane's durable history
// is fetched once, on first display, from GET .../outputs, and merged with the
// live websocket chunks that arrived meanwhile (deduped by seq).
export type OutputPaneStatus = 'unseeded' | 'loading' | 'seeded';
interface OutputPane {
  status: OutputPaneStatus;
  /** Durable chunks fetched from the outputs endpoint. */
  seededRows: IntentOutput[];
  /** Highest seq contained in seededRows — live chunks at or below are dupes. */
  maxSeededSeq: number;
  /** Live websocket chunks (kept until seeding merges or supersedes them). */
  live: IntentOutput[];
}

interface IntentContextValue {
  projectId: string;
  intentId: string;
  detail: IntentDetail | null;
  compiled: CompiledWorkflow | null;
  loading: boolean;
  error: string | null;

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
  /** Human name for a buffer key (stageInstanceId → stageId). */
  stageNameOf: (key: string) => string;
  /** Lazily fetch a pane's durable transcript (no-op once seeded/loading). */
  ensureOutputs: (key: string) => void;
  /** Seeding state for a pane key (re-render via outputVersion). */
  outputPaneStatus: (key: string) => OutputPaneStatus;

  // Shared UI state — selection is keyed by `stageRowKey` (instance-aware:
  // two unit instances of one stage select independently).
  selectedStageId: string | null;
  setSelectedStageId: Dispatch<SetStateAction<string | null>>;
  agentFocus: AgentFocusRequest | null;
  /** Focus the sidebar Agent tab on a stage's output (null → run-level). */
  focusOutput: (stageInstanceId: string | null) => void;

  /** Preview tab: the artifact currently displayed (null = nothing selected). */
  previewArtifactId: string | null;
  /** Preview tab: the derived item currently displayed (mutually exclusive with artifact). */
  previewItemId: string | null;
  previewSeq: number;
  /** Open a document artifact in the right panel's Preview tab. */
  openArtifactPreview: (artifactId: string) => void;
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
}

// ── Module-level stale-while-revalidate cache ───────────────────────────────
// Mirrors the pattern in src/hooks/useProjectsCache.ts: show last-known data
// instantly on revisit, refetch in the background, update if changed.
// Uses LRU eviction (delete+re-insert on access moves key to Map iteration end).
const INTENT_CACHE_MAX = 20;

interface IntentCacheEntry {
  detail: IntentDetail;
  compiled: CompiledWorkflow | null;
  workflowPhases: PhaseNode[] | null;
}

const intentCache = new Map<string, IntentCacheEntry>();

function intentCacheKey(projectId: string, intentId: string): string {
  return `${projectId}#${intentId}`;
}

function intentCacheGet(key: string): IntentCacheEntry | undefined {
  const entry = intentCache.get(key);
  if (entry) {
    // LRU promotion: move to end of Map iteration order
    intentCache.delete(key);
    intentCache.set(key, entry);
  }
  return entry;
}

function trimIntentCache() {
  while (intentCache.size > INTENT_CACHE_MAX) {
    const oldest = intentCache.keys().next().value!;
    intentCache.delete(oldest);
  }
}

/** Clear the module-level intent cache (for test isolation). */
export function clearIntentCache() {
  intentCache.clear();
}

const IntentContext = createContext<IntentContextValue | undefined>(undefined);

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
  const [compiled, setCompiled] = useState<CompiledWorkflow | null>(null);
  const [workflowPhases, setWorkflowPhases] = useState<PhaseNode[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  const [previewArtifactId, setPreviewArtifactId] = useState<string | null>(null);
  const [previewItemId, setPreviewItemId] = useState<string | null>(null);
  const [previewSeq, setPreviewSeq] = useState(0);
  const previewSeqRef = useRef(0);

  // Guards late async resolutions (compiled fetch) against route changes.
  const activeIntentRef = useRef(intentId);
  const fetchedWorkflowKeyRef = useRef<string | null>(null);
  activeIntentRef.current = intentId;

  const load = useCallback(async () => {
    if (!projectId || !intentId) return;
    try {
      const dto = await intentsService.get(projectId, intentId);
      if (activeIntentRef.current !== intentId) return;
      setDetail(dto);
      setError(null);
      setLiveGates(new Map(dto.gates.map((g) => [g.humanTaskId, g])));

      const cacheKey = intentCacheKey(projectId, intentId);
      const prevEntry = intentCache.get(cacheKey);

      if (dto.intent.workflowId) {
        workflowsService
          .compiled(dto.intent.workflowId, dto.intent.workflowVersion ?? undefined)
          .then((c) => {
            if (activeIntentRef.current !== intentId) return;
            setCompiled(c);
            const entry = intentCache.get(cacheKey);
            if (entry) entry.compiled = c;
          })
          .catch(() => {});

        const workflowKey = `${dto.intent.workflowId}@${dto.intent.workflowVersion ?? ''}`;
        if (fetchedWorkflowKeyRef.current !== workflowKey) {
          fetchedWorkflowKeyRef.current = workflowKey;
          workflowsService
            .get(dto.intent.workflowId, dto.intent.workflowVersion ?? undefined)
            .then((wf) => {
              if (activeIntentRef.current !== intentId) return;
              setWorkflowPhases(wf.phases);
              const entry = intentCache.get(cacheKey);
              if (entry) entry.workflowPhases = wf.phases;
            })
            .catch(() => {
              fetchedWorkflowKeyRef.current = null;
            });
        }
      }

      intentCache.set(cacheKey, {
        detail: dto,
        compiled: prevEntry?.compiled ?? null,
        workflowPhases: prevEntry?.workflowPhases ?? null,
      });
      trimIntentCache();
    } catch (err) {
      if (activeIntentRef.current !== intentId) return;
      setError(err instanceof Error ? err.message : 'Failed to load intent');
    } finally {
      if (activeIntentRef.current === intentId) setLoading(false);
    }
  }, [projectId, intentId]);

  useEffect(() => {
    outputBufRef.current = new Map();
    outputRowsRef.current = new Map();
    panesRef.current = new Map();
    setOutputVersion(0);
    setSelectedStageId(null);
    setAgentFocus(null);
    setError(null);
    fetchedWorkflowKeyRef.current = null;

    if (projectId && intentId) {
      const cached = intentCacheGet(intentCacheKey(projectId, intentId));
      if (cached) {
        setDetail(cached.detail);
        setCompiled(cached.compiled);
        setWorkflowPhases(cached.workflowPhases);
        setLiveGates(new Map(cached.detail.gates.map((g) => [g.humanTaskId, g])));
        setLoading(false);
        if (cached.compiled && cached.detail.intent.workflowId) {
          fetchedWorkflowKeyRef.current = `${cached.detail.intent.workflowId}@${cached.detail.intent.workflowVersion ?? ''}`;
        }
      } else {
        setDetail(null);
        setCompiled(null);
        setWorkflowPhases(null);
        setLiveGates(new Map());
        setLoading(true);
      }
      load();
    } else {
      setDetail(null);
      setCompiled(null);
      setWorkflowPhases(null);
      setLiveGates(new Map());
      setLoading(false);
    }
  }, [projectId, intentId, load]);

  // Polling backstop. Lifecycle/failure transitions are broadcast live by the
  // orchestrator, but WS frames can be dropped, so while a run is mid-flight
  // (CREATED during init-ws, RUNNING, WAITING) we also poll on a slow interval
  // to guarantee init-ws progress and FAILED transitions reach the UI.
  const pollStatus = detail?.intent.status;
  useEffect(() => {
    if (!pollStatus || !['CREATED', 'RUNNING', 'WAITING'].includes(pollStatus)) return;
    const id = setInterval(load, 8000);
    return () => clearInterval(id);
  }, [pollStatus, load]);

  // Refetch debouncing (docs/v2-parallel.md WP7): every lifecycle event used
  // to trigger an immediate full-DTO refetch — N parallel lanes multiply
  // stage/unit/metric events, so bursts must coalesce. Trailing debounce: the
  // first event arms a short timer; every event inside the window rides the
  // same fetch. The 8s poll and post-mutation reloads stay immediate.
  const loadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleLoad = useCallback(() => {
    if (loadTimerRef.current) return;
    loadTimerRef.current = setTimeout(() => {
      loadTimerRef.current = null;
      load();
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
      pane = { status: 'unseeded', seededRows: [], maxSeededSeq: 0, live: [] };
      panesRef.current.set(key, pane);
    }
    return pane;
  }, []);

  // Rebuild a pane's render string: durable history + the live tail (chunks
  // newer than the seed, in seq order — websocket frames can only race the
  // seed fetch, not each other, but sorting is cheap and safe).
  const renderPane = useCallback(
    (key: string) => {
      const pane = paneOf(key);
      const tail = pane.live
        .filter((c) => c.seq > pane.maxSeededSeq)
        .toSorted((a, b) => a.seq - b.seq);
      const rows = [...pane.seededRows, ...tail];
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
      const initial = pane.status === 'unseeded';
      if (initial) {
        pane.status = 'loading';
        setOutputVersion((n) => n + 1);
      }
      const forIntent = intentId;
      intentsService
        .outputs(projectId, intentId, {
          stageInstanceId: key,
          ...(initial ? {} : { afterSeq: pane.maxSeededSeq }),
        })
        .then(({ outputs: durable }) => {
          if (activeIntentRef.current !== forIntent) return;
          const bySeq = new Map(pane.seededRows.map((row) => [row.seq, row]));
          durable.forEach((row) => bySeq.set(row.seq, row));
          pane.seededRows = [...bySeq.values()].toSorted((a, b) => a.seq - b.seq);
          pane.maxSeededSeq = pane.seededRows.reduce((m, o) => Math.max(m, o.seq ?? 0), 0);
          pane.live = pane.live.filter((c) => c.seq > pane.maxSeededSeq);
          pane.status = 'seeded';
          renderPane(key);
        })
        .catch(() => {
          if (activeIntentRef.current !== forIntent) return;
          if (initial) pane.status = 'unseeded';
          setOutputVersion((n) => n + 1);
        });
    },
    [projectId, intentId, paneOf, renderPane],
  );

  // Fetch a pane's durable transcript once on first display.
  const ensureOutputs = useCallback(
    (key: string) => {
      if (paneOf(key).status === 'unseeded') syncOutputs(key);
    },
    [paneOf, syncOutputs],
  );

  const catchUpOutputs = useCallback(() => {
    for (const [key, pane] of panesRef.current) {
      if (pane.status !== 'loading') syncOutputs(key);
    }
  }, [syncOutputs]);

  // A reconnect cannot replay frames from API Gateway. Catch up every pane
  // from DynamoDB as soon as the channel returns, and periodically while a run
  // is active so even a silent intermediary drop heals without user action.
  useEffect(
    () =>
      realtimeService.onStatusChange((status) => {
        if (status === 'connected') catchUpOutputs();
      }),
    [catchUpOutputs],
  );
  useEffect(() => {
    if (!pollStatus || !['CREATED', 'RUNNING', 'WAITING'].includes(pollStatus)) return;
    const id = setInterval(catchUpOutputs, 8000);
    return () => clearInterval(id);
  }, [pollStatus, catchUpOutputs]);

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
        evt.action === 'agent.feedback'
      ) {
        scheduleLoad();
      }
    },
    [scheduleLoad, paneOf, projectId, intentId],
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
    intentCache.delete(intentCacheKey(projectId, intentId));
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

  const focusOutput = useCallback(
    (stageInstanceId: string | null) => {
      focusSeq.current += 1;
      setAgentFocus({ key: stageInstanceId ?? INTENT_OUTPUT_KEY, seq: focusSeq.current });
      onAgentFocus?.();
    },
    [onAgentFocus],
  );

  const openArtifactPreview = useCallback(
    (artifactId: string) => {
      previewSeqRef.current += 1;
      setPreviewArtifactId(artifactId);
      // Artifact and item previews are mutually exclusive.
      setPreviewItemId(null);
      setPreviewSeq(previewSeqRef.current);
      onAgentFocus?.();
    },
    [onAgentFocus],
  );

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
    const grid = scope ? compiled?.scopeGrid?.[scope] : undefined;
    const planNodes = (compiled?.graph.nodes ?? [])
      .filter((n) => !grid || grid[n.stageId] === 'EXECUTE')
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
  }, [detail, compiled, workflowPhases]);

  // Compiled edges restricted to the rendered (in-scope) stages — the graph
  // AND the per-stage dependency list derive from these (the compiled DTO has
  // no dependencyStageIds; that field is orchestrator-internal).
  const stageEdges = useMemo<StageEdge[]>(() => {
    const ids = new Set(stageRows.map((r) => r.stageId));
    return (compiled?.graph.edges ?? []).filter((e) => ids.has(e.from) && ids.has(e.to));
  }, [compiled, stageRows]);

  const gates = useMemo(() => [...liveGates.values()], [liveGates]);
  const pendingGates = useMemo(() => gates.filter((g) => g.status === 'pending'), [gates]);
  const steering = useMemo(() => detail?.steering ?? [], [detail]);

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

  const initializationPhasePaths = useMemo<Set<string>>(() => {
    if (!workflowPhases) return new Set();
    return new Set(workflowPhases.filter((p) => p.phaseId === 'initialization').map((p) => p.path));
  }, [workflowPhases]);

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
        workflowPhases,
        phaseNameOf,
        initializationPhasePaths,
        currentPhasePath,
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
        selectedStageId,
        setSelectedStageId,
        agentFocus,
        focusOutput,
        previewArtifactId,
        previewItemId,
        previewSeq,
        openArtifactPreview,
        openItemPreview,
        reload: load,
        answerGate,
        reviseGate,
        cancelIntent,
        deleteIntent,
        rewindIntent,
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

/** Safe variant that returns null when outside an IntentProvider (e.g. tests). */
export function useIntentOptional(): IntentContextValue | null {
  return useContext(IntentContext) ?? null;
}
