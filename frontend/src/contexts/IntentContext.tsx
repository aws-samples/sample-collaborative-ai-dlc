import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import {
  intentsService,
  type GateAnswer,
  type Intent,
  type IntentArtifact,
  type IntentDetail,
  type IntentGate,
  type IntentSensorRun,
  type IntentStage,
  type IntentSteering,
  type IntentUnit,
  type IntentUnitPlan,
  type StageState,
} from '@/services/intents';
import { workflowsService, type CompiledWorkflow, type PhaseNode } from '@/services/workflows';
import { useIntentEvents, type IntentEvent } from '@/hooks/useIntentEvents';

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
  runtimeError: string | null;
  startedAt: string | null;
  completedAt: string | null;
  /** Accumulated human-wait milliseconds across park/resume cycles. */
  waitMs: number;
  /** Open park's start (set while WAITING_FOR_HUMAN), for live wait ticking. */
  parkedAt: string | null;
  attempt: number;
  cli: string | null;
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
  /** Durable chunks fetched from the outputs endpoint, concatenated. */
  seededText: string;
  /** Highest seq contained in seededText — live chunks at or below are dupes. */
  maxSeededSeq: number;
  /** Live websocket chunks (kept until seeding merges or supersedes them). */
  live: { seq: number; content: string }[];
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

  // Derived views
  stageRows: IntentStageRow[];
  stageEdges: StageEdge[];
  gates: IntentGate[];
  pendingGates: IntentGate[];
  steering: IntentSteering[];
  sensorsByStage: Map<string, IntentSensorRun[]>;
  artifactsByStage: Map<string, IntentArtifact[]>;
  /** Unit lanes (docs/v2-parallel.md WP5/WP7): [] before promotion. */
  units: IntentUnit[];
  unitPlan: IntentUnitPlan | null;

  // Live streamed output per stage instance (+ INTENT_OUTPUT_KEY). The map is
  // held in a ref for append performance; `outputVersion` bumps on every
  // append so consumers can subscribe to changes.
  outputBuffers: Map<string, string>;
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
  setSelectedStageId: (rowKey: string | null) => void;
  agentFocus: AgentFocusRequest | null;
  /** Focus the sidebar Agent tab on a stage's output (null → run-level). */
  focusOutput: (stageInstanceId: string | null) => void;

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
  // render-ready string per key; `panesRef` holds the merge bookkeeping.
  const outputBufRef = useRef<Map<string, string>>(new Map());
  const panesRef = useRef<Map<string, OutputPane>>(new Map());
  const [outputVersion, setOutputVersion] = useState(0);

  const [selectedStageId, setSelectedStageId] = useState<string | null>(null);
  const [agentFocus, setAgentFocus] = useState<AgentFocusRequest | null>(null);
  const focusSeq = useRef(0);

  // Guards late async resolutions (compiled fetch) against route changes.
  const activeIntentRef = useRef(intentId);
  activeIntentRef.current = intentId;

  const load = useCallback(async () => {
    if (!projectId || !intentId) return;
    try {
      const dto = await intentsService.get(projectId, intentId);
      if (activeIntentRef.current !== intentId) return;
      setDetail(dto);
      setError(null);
      // Seed the gate map from durable state. Output buffers are NOT seeded
      // here — the DTO carries no outputs; panes fetch lazily (ensureOutputs).
      setLiveGates(new Map(dto.gates.map((g) => [g.humanTaskId, g])));
      // Compiled workflow drives the phase/stage plan (best-effort).
      if (dto.intent.workflowId) {
        workflowsService
          .compiled(dto.intent.workflowId, dto.intent.workflowVersion ?? undefined)
          .then((c) => {
            if (activeIntentRef.current === intentId) setCompiled(c);
          })
          .catch(() => {});
        workflowsService
          .get(dto.intent.workflowId, dto.intent.workflowVersion ?? undefined)
          .then((wf) => {
            if (activeIntentRef.current === intentId) setWorkflowPhases(wf.phases);
          })
          .catch(() => {});
      }
    } catch (err) {
      if (activeIntentRef.current !== intentId) return;
      setError(err instanceof Error ? err.message : 'Failed to load intent');
    } finally {
      if (activeIntentRef.current === intentId) setLoading(false);
    }
  }, [projectId, intentId]);

  // Reset everything when the intent (or route) changes, then load.
  useEffect(() => {
    outputBufRef.current = new Map();
    panesRef.current = new Map();
    setOutputVersion(0);
    setDetail(null);
    setCompiled(null);
    setWorkflowPhases(null);
    setLiveGates(new Map());
    setSelectedStageId(null);
    setAgentFocus(null);
    setError(null);
    if (projectId && intentId) {
      setLoading(true);
      load();
    } else {
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
      pane = { status: 'unseeded', seededText: '', maxSeededSeq: 0, live: [] };
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
        .toSorted((a, b) => a.seq - b.seq)
        .map((c) => c.content)
        .join('');
      outputBufRef.current.set(key, pane.seededText + tail);
      setOutputVersion((n) => n + 1);
    },
    [paneOf],
  );

  // Fetch a pane's durable transcript once, on first display. Live chunks that
  // arrived while unseeded/loading are deduped by seq against the fetch result
  // (every persisted chunk broadcasts its seq). Failure returns the pane to
  // `unseeded` so the next selection retries.
  const ensureOutputs = useCallback(
    (key: string) => {
      if (!projectId || !intentId) return;
      const pane = paneOf(key);
      if (pane.status !== 'unseeded') return;
      pane.status = 'loading';
      setOutputVersion((n) => n + 1);
      const forIntent = intentId;
      intentsService
        .outputs(projectId, intentId, { stageInstanceId: key })
        .then(({ outputs }) => {
          if (activeIntentRef.current !== forIntent) return;
          pane.seededText = outputs.map((o) => o.content).join('');
          pane.maxSeededSeq = outputs.reduce((m, o) => Math.max(m, o.seq ?? 0), 0);
          pane.live = pane.live.filter((c) => c.seq > pane.maxSeededSeq);
          pane.status = 'seeded';
          renderPane(key);
        })
        .catch(() => {
          if (activeIntentRef.current !== forIntent) return;
          pane.status = 'unseeded';
          setOutputVersion((n) => n + 1);
        });
    },
    [projectId, intentId, paneOf, renderPane],
  );

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
            kind: 'question',
            status: 'pending',
            prompt: null,
            options: null,
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
        pane.live.push({ seq, content: evt.content });
        // Fast path: append to the render string (renderPane would re-join the
        // whole live tail on every streamed token).
        outputBufRef.current.set(key, (outputBufRef.current.get(key) ?? '') + evt.content);
        setOutputVersion((n) => n + 1);
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
        evt.action === 'agent.unit'
      ) {
        scheduleLoad();
      }
    },
    [scheduleLoad, paneOf],
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
    for (const list of byStageId.values()) {
      list.sort((a, b) => (a.unitSlug ?? '').localeCompare(b.unitSlug ?? ''));
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
            runtimeError: null,
            startedAt: null,
            completedAt: null,
            waitMs: 0,
            parkedAt: null,
            attempt: 0,
            cli: null,
            order: n.order ?? i,
            planned: true,
          },
        ];
      }
      return instances.map((row) => ({
        stageId: n.stageId,
        phase: row.phase ?? n.phasePath ?? null,
        state: row.state,
        stageInstanceId: row.stageInstanceId,
        unitSlug: row.unitSlug ?? null,
        runtimeError: row.runtimeError ?? null,
        startedAt: row.startedAt ?? null,
        completedAt: row.completedAt ?? null,
        waitMs: row.waitMs ?? 0,
        parkedAt: row.parkedAt ?? null,
        attempt: row.attempt ?? 0,
        cli: row.cli ?? null,
        order: n.order ?? i,
        planned: true,
      }));
    });
    // Live rows outside the plan (plan unavailable or diverged) still render.
    for (const s of detail?.stages ?? []) {
      if (!s.stageId || planIds.has(s.stageId)) continue;
      rows.push({
        stageId: s.stageId,
        phase: s.phase ?? null,
        state: s.state,
        stageInstanceId: s.stageInstanceId,
        unitSlug: s.unitSlug ?? null,
        runtimeError: s.runtimeError ?? null,
        startedAt: s.startedAt ?? null,
        completedAt: s.completedAt ?? null,
        waitMs: s.waitMs ?? 0,
        parkedAt: s.parkedAt ?? null,
        attempt: s.attempt ?? 0,
        cli: s.cli ?? null,
        order: Number.MAX_SAFE_INTEGER,
        planned: false,
      });
    }
    return rows;
  }, [detail, compiled]);

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
  // Unit lanes (docs/v2-parallel.md WP7): sorted by wave then slug so the lane
  // board renders in scheduling order.
  const units = useMemo<IntentUnit[]>(
    () =>
      (detail?.units ?? []).toSorted(
        (a, b) => (a.batchIndex ?? 0) - (b.batchIndex ?? 0) || a.slug.localeCompare(b.slug),
      ),
    [detail],
  );
  const unitPlan = useMemo<IntentUnitPlan | null>(() => detail?.unitPlan ?? null, [detail]);

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
      if (!workflowPhases) return phasePath;
      const node = workflowPhases.find((p) => p.path === phasePath);
      if (!node) return phasePath;
      return node.name.charAt(0).toUpperCase() + node.name.slice(1);
    },
    [workflowPhases],
  );

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
        stageRows,
        stageEdges,
        gates,
        pendingGates,
        steering,
        sensorsByStage,
        artifactsByStage,
        units,
        unitPlan,
        outputBuffers: outputBufRef.current,
        outputVersion,
        stageNameOf,
        ensureOutputs,
        outputPaneStatus,
        selectedStageId,
        setSelectedStageId,
        agentFocus,
        focusOutput,
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
