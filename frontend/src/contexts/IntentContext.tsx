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
  type IntentArtifact,
  type IntentDetail,
  type IntentGate,
  type IntentSensorRun,
  type StageState,
} from '@/services/intents';
import { workflowsService, type CompiledWorkflow } from '@/services/workflows';
import { useIntentEvents, type IntentEvent } from '@/hooks/useIntentEvents';

// Shared state for the v2 intent experience (the SprintContext analog). The
// provider is mounted once in AppShell — INERT off intent routes (no ids → no
// fetch, no realtime) — so both the routed IntentView and the AppShell-hosted
// IntentActivityPanel consume one fetch/realtime/output-buffer state.

// Output buffers are keyed by stage instance; outputs with no stage (init-ws /
// general run output) accumulate under this key.
export const INTENT_OUTPUT_KEY = 'intent';

// A plan stage merged with its live STAGE row (if any). Plan stages with no
// row yet render as PENDING; live rows outside the plan are appended.
export interface IntentStageRow {
  stageId: string;
  phase: string | null;
  state: StageState;
  stageInstanceId: string | null;
  runtimeError: string | null;
  startedAt: string | null;
  completedAt: string | null;
  attempt: number;
  cli: string | null;
  order: number;
  /** false when the row exists only in live state (plan missing/diverged). */
  planned: boolean;
}

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

interface IntentContextValue {
  projectId: string;
  intentId: string;
  detail: IntentDetail | null;
  compiled: CompiledWorkflow | null;
  loading: boolean;
  error: string | null;

  // Derived views
  stageRows: IntentStageRow[];
  stageEdges: StageEdge[];
  gates: IntentGate[];
  pendingGates: IntentGate[];
  sensorsByStage: Map<string, IntentSensorRun[]>;
  artifactsByStage: Map<string, IntentArtifact[]>;

  // Live streamed output per stage instance (+ INTENT_OUTPUT_KEY). The map is
  // held in a ref for append performance; `outputVersion` bumps on every
  // append so consumers can subscribe to changes.
  outputBuffers: Map<string, string>;
  outputVersion: number;
  /** Human name for a buffer key (stageInstanceId → stageId). */
  stageNameOf: (key: string) => string;

  // Shared UI state
  selectedStageId: string | null;
  setSelectedStageId: (stageId: string | null) => void;
  agentFocus: AgentFocusRequest | null;
  /** Focus the sidebar Agent tab on a stage's output (null → run-level). */
  focusOutput: (stageInstanceId: string | null) => void;

  reload: () => Promise<void>;
  answerGate: (gate: IntentGate, input: GateAnswer) => Promise<void>;
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Live agent.question gates accumulated by humanTaskId (D3 multi-gate).
  // Seeded from the assembled detail, then upserted on each agent.question.
  const [liveGates, setLiveGates] = useState<Map<string, IntentGate>>(new Map());

  // Live streamed output appended per stage instance (replayed from detail first).
  const outputBufRef = useRef<Map<string, string>>(new Map());
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
      // Seed the gate map + output buffers from durable state.
      setLiveGates(new Map(dto.gates.map((g) => [g.humanTaskId, g])));
      const buf = new Map<string, string>();
      for (const o of dto.outputs) {
        const key = o.stageInstanceId ?? INTENT_OUTPUT_KEY;
        buf.set(key, (buf.get(key) ?? '') + o.content);
      }
      outputBufRef.current = buf;
      setOutputVersion((n) => n + 1);
      // Compiled workflow drives the phase/stage plan (best-effort).
      if (dto.intent.workflowId) {
        workflowsService
          .compiled(dto.intent.workflowId, dto.intent.workflowVersion ?? undefined)
          .then((c) => {
            if (activeIntentRef.current === intentId) setCompiled(c);
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
    setOutputVersion(0);
    setDetail(null);
    setCompiled(null);
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
        outputBufRef.current.set(key, (outputBufRef.current.get(key) ?? '') + evt.content);
        setOutputVersion((n) => n + 1);
        return;
      }
      // Stage/execution/metric/note transitions → refetch the assembled DTO.
      if (
        evt.action === 'agent.stage' ||
        evt.action === 'agent.execution' ||
        evt.action === 'agent.workspace' ||
        evt.action === 'agent.metric' ||
        evt.action === 'agent.note'
      ) {
        load();
      }
    },
    [load],
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
  const stageRows = useMemo<IntentStageRow[]>(() => {
    const byStageId = new Map(
      (detail?.stages ?? []).filter((s) => s.stageId).map((s) => [s.stageId as string, s]),
    );
    const scope = detail?.intent.scope ?? null;
    const grid = scope ? compiled?.scopeGrid?.[scope] : undefined;
    const planNodes = (compiled?.graph.nodes ?? [])
      .filter((n) => !grid || grid[n.stageId] === 'EXECUTE')
      .toSorted((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const planIds = new Set(planNodes.map((n) => n.stageId));
    const rows: IntentStageRow[] = planNodes.map((n, i) => {
      const row = byStageId.get(n.stageId);
      return {
        stageId: n.stageId,
        phase: row?.phase ?? n.phasePath ?? null,
        state: (row?.state ?? 'PENDING') as StageState,
        stageInstanceId: row?.stageInstanceId ?? null,
        runtimeError: row?.runtimeError ?? null,
        startedAt: row?.startedAt ?? null,
        completedAt: row?.completedAt ?? null,
        attempt: row?.attempt ?? 0,
        cli: row?.cli ?? null,
        order: n.order ?? i,
        planned: true,
      };
    });
    // Live rows outside the plan (plan unavailable or diverged) still render.
    for (const s of detail?.stages ?? []) {
      if (!s.stageId || planIds.has(s.stageId)) continue;
      rows.push({
        stageId: s.stageId,
        phase: s.phase ?? null,
        state: s.state,
        stageInstanceId: s.stageInstanceId,
        runtimeError: s.runtimeError ?? null,
        startedAt: s.startedAt ?? null,
        completedAt: s.completedAt ?? null,
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

  return (
    <IntentContext.Provider
      value={{
        projectId,
        intentId,
        detail,
        compiled,
        loading,
        error,
        stageRows,
        stageEdges,
        gates,
        pendingGates,
        sensorsByStage,
        artifactsByStage,
        outputBuffers: outputBufRef.current,
        outputVersion,
        stageNameOf,
        selectedStageId,
        setSelectedStageId,
        agentFocus,
        focusOutput,
        reload: load,
        answerGate,
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
