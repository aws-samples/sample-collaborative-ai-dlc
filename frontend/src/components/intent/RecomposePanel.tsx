// Recompose panel — in-flight reshape of a parked (WAITING) or FAILED run.
// Two producers of the same validated change: the composer agent (in-flight
// mode, frozen progress enforced server-side) and a manual grid edit. Either
// way, applying goes through POST .../recompose — the engine re-validates the
// grid strictly, freezes the past, retires the parked run and relaunches at
// the first not-yet-done stage. Hidden while construction runs autonomously
// (the endpoint rejects it too — this just avoids a guaranteed 409).

import { useEffect, useMemo, useState } from 'react';
import {
  intentsService,
  type Intent,
  type IntentStage,
  type ComposeSession,
} from '@/services/intents';
import { workflowsService, type CompiledWorkflow, type PhaseNode } from '@/services/workflows';
import { StageGridEditor } from '@/components/intent/StageGridEditor';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { AlertCircle, Loader2, Sparkles } from 'lucide-react';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  intentId: string;
  intent: Intent;
  stageRows: IntentStage[];
  workflowVersion?: number;
  /** Reload the intent detail after a successful relaunch. */
  onRelaunched: () => Promise<void> | void;
}

const POLL_MS = 2500;
const RAN_STATES = new Set(['SUCCEEDED', 'RUNNING', 'WAITING_FOR_HUMAN', 'FAILED']);

export function RecomposePanel({
  open,
  onOpenChange,
  projectId,
  intentId,
  intent,
  stageRows,
  workflowVersion,
  onRelaunched,
}: Props) {
  const [compiled, setCompiled] = useState<CompiledWorkflow | null>(null);
  const [phases, setPhases] = useState<PhaseNode[]>([]);
  const [grid, setGrid] = useState<Record<string, 'EXECUTE' | 'SKIP'> | null>(null);
  const [gridScope, setGridScope] = useState<string | null>(null);
  const [instructions, setInstructions] = useState('');
  const [sessions, setSessions] = useState<ComposeSession[]>([]);
  const [composing, setComposing] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const latest = sessions.length ? sessions[sessions.length - 1] : null;
  const latestInflight = latest?.mode === 'inflight' ? latest : null;
  const pending = latestInflight?.state === 'PENDING';

  useEffect(() => {
    if (!open || compiled) return;
    let cancelled = false;
    workflowsService
      .compiled(intent.workflowId, workflowVersion)
      .then((c) => {
        if (!cancelled) setCompiled(c);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load the workflow'));
    workflowsService
      .get(intent.workflowId, workflowVersion)
      .then((wf) => {
        if (!cancelled) setPhases(wf.phases ?? []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open, compiled, intent.workflowId, workflowVersion]);

  useEffect(() => {
    if (!pending) return;
    const timer = window.setInterval(async () => {
      try {
        const { composes } = await intentsService.listComposes(projectId, intentId);
        setSessions(composes);
      } catch {
        /* best-effort poll */
      }
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [pending, projectId, intentId]);

  // The run's frozen progress: any stage that ran stays EXECUTE, an
  // already-skipped stage stays SKIP — the editor locks them.
  const frozen = useMemo(() => {
    const map = new Map<string, 'EXECUTE' | 'SKIP'>();
    for (const row of stageRows) {
      if (!row.stageId) continue;
      if (RAN_STATES.has(row.state)) map.set(row.stageId, 'EXECUTE');
      else if (row.state === 'SKIPPED' && !map.has(row.stageId)) map.set(row.stageId, 'SKIP');
    }
    return map;
  }, [stageRows]);

  const initPhasePath = phases.find((p) => p.phaseId === 'initialization')?.path ?? null;
  const gridStages = useMemo(
    () =>
      (compiled?.graph.nodes ?? []).map((n) => ({
        stageId: n.stageId,
        phasePath: n.phasePath,
        order: n.order,
      })),
    [compiled],
  );
  const orderedNodes = useMemo(
    () =>
      (compiled?.graph.nodes ?? []).toSorted(
        (a, b) =>
          (a.phasePath ?? '').localeCompare(b.phasePath ?? '') ||
          a.order - b.order ||
          a.stageId.localeCompare(b.stageId),
      ),
    [compiled],
  );
  const progressBoundaryIndex = useMemo(() => {
    const currentStageIndex = intent.currentStage
      ? orderedNodes.findIndex((node) => node.stageId === intent.currentStage)
      : -1;
    if (currentStageIndex >= 0) return currentStageIndex;

    const currentPhasePath =
      phases.find(
        (phase) => phase.phaseId === intent.currentPhase || phase.path === intent.currentPhase,
      )?.path ?? null;
    const currentPhaseIndex = currentPhasePath
      ? orderedNodes.findIndex((node) => node.phasePath === currentPhasePath)
      : -1;
    if (currentPhaseIndex >= 0) return currentPhaseIndex;

    let latestRanIndex = -1;
    orderedNodes.forEach((node, index) => {
      if (frozen.get(node.stageId) === 'EXECUTE') latestRanIndex = index;
    });
    return latestRanIndex;
  }, [frozen, intent.currentPhase, intent.currentStage, orderedNodes, phases]);
  const lockedStageIds = useMemo(
    () =>
      new Set([
        ...(compiled?.graph.nodes ?? [])
          .filter((n) => initPhasePath != null && n.phasePath === initPhasePath)
          .map((n) => n.stageId),
        ...frozen.keys(),
        ...orderedNodes.slice(0, Math.max(0, progressBoundaryIndex)).map((n) => n.stageId),
      ]),
    [compiled, frozen, initPhasePath, orderedNodes, progressBoundaryIndex],
  );

  // Baseline: the intent's composed grid, else the run scope's projection,
  // always overlaid with the frozen truth.
  const baseline = useMemo(() => {
    const scopeGrid =
      (intent.scope && compiled?.scopeGrid?.[intent.scope]) ||
      compiled?.scopeGrid?.[Object.keys(compiled?.scopeGrid ?? {})[0] ?? ''] ||
      {};
    const base: Record<string, 'EXECUTE' | 'SKIP'> = {
      ...scopeGrid,
      ...intent.composedGrid,
    };
    for (const [stageId, value] of frozen) base[stageId] = value;
    return base;
  }, [intent.scope, intent.composedGrid, compiled, frozen]);

  const effectiveGrid = grid ?? baseline;

  const preserveLockedStages = (candidate: Record<string, 'EXECUTE' | 'SKIP'>) => {
    const next = { ...candidate };
    for (const stageId of lockedStageIds) {
      next[stageId] = baseline[stageId] === 'EXECUTE' ? 'EXECUTE' : 'SKIP';
    }
    return next;
  };

  const toggleStage = (stageId: string) => {
    if (lockedStageIds.has(stageId)) return;
    const next = { ...effectiveGrid };
    next[stageId] = next[stageId] === 'EXECUTE' ? 'SKIP' : 'EXECUTE';
    setGrid(next);
    if (!gridScope) setGridScope(`${intent.scope ?? 'run'}-recomposed`);
  };

  const askComposer = async () => {
    setComposing(true);
    setError(null);
    try {
      const session = await intentsService.compose(projectId, intentId, {
        mode: 'inflight',
        ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
      });
      setSessions((prev) => [...prev, session]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Compose failed');
    } finally {
      setComposing(false);
    }
  };

  const applyAndRelaunch = async (
    applyGrid: Record<string, 'EXECUTE' | 'SKIP'>,
    scopeLabel: string,
  ) => {
    setApplying(true);
    setError(null);
    try {
      await intentsService.recompose(projectId, intentId, {
        composedGrid: preserveLockedStages(applyGrid),
        scope: scopeLabel,
      });
      await onRelaunched();
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Recompose failed');
    } finally {
      setApplying(false);
    }
  };

  const dirty = grid != null;

  return (
    <Dialog open={open} onOpenChange={(next) => !applying && onOpenChange(next)}>
      <DialogContent
        className="max-h-[85vh] gap-0 overflow-y-auto p-0 sm:max-w-3xl"
        data-testid="recompose-dialog"
      >
        <DialogHeader className="border-b px-6 py-5">
          <DialogTitle>Reshape remaining stages</DialogTitle>
          <DialogDescription>
            Completed and running stages stay locked. Pending stages can be added or removed.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 px-6 py-5">
          {error && (
            <p className="flex items-start gap-1.5 text-xs text-destructive">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {error}
            </p>
          )}

          <div className="flex gap-2">
            <Input
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder="Optional steering for the composer, e.g. skip the NFR work…"
              className="text-sm"
              disabled={composing || pending || applying}
              data-testid="recompose-instructions"
            />
            <Button
              type="button"
              variant="secondary"
              onClick={askComposer}
              disabled={composing || pending || applying}
              data-testid="recompose-ask-composer"
            >
              {composing || pending ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Sparkles className="mr-1.5 h-3.5 w-3.5" />
              )}
              {pending ? 'Composing…' : 'Ask composer'}
            </Button>
          </div>

          {latestInflight?.state === 'FAILED' && (
            <p className="text-xs text-destructive" data-testid="recompose-compose-failed">
              Compose failed: {latestInflight.failureReason ?? 'unknown reason'}
            </p>
          )}

          {latestInflight?.state === 'COMPLETED' && latestInflight.proposal?.grid && (
            <div
              className="space-y-2 rounded-md border bg-muted/30 px-3 py-2.5"
              data-testid="recompose-proposal"
            >
              <p className="text-sm font-medium">
                Composer proposal: {latestInflight.proposal.scope}
              </p>
              {latestInflight.validation?.summary && (
                <p className="text-xs text-foreground">
                  Runs {latestInflight.validation.summary.executedStages} of{' '}
                  {latestInflight.validation.summary.totalStages} stages ·{' '}
                  {latestInflight.validation.summary.approvalGates} approval gates
                </p>
              )}
              {latestInflight.proposal.rationale.length > 0 && (
                <ul className="text-xs text-muted-foreground list-disc pl-4 space-y-0.5">
                  {latestInflight.proposal.rationale.slice(0, 6).map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              )}
              <Button
                type="button"
                size="sm"
                onClick={() =>
                  applyAndRelaunch(latestInflight.proposal!.grid!, latestInflight.proposal!.scope)
                }
                disabled={applying}
                data-testid="recompose-apply-proposal"
              >
                {applying && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                Apply &amp; relaunch
              </Button>
            </div>
          )}

          {gridStages.length > 0 ? (
            <>
              <StageGridEditor
                stages={gridStages}
                phaseNames={Object.fromEntries(phases.map((p) => [p.path, p.name || p.phaseId]))}
                grid={effectiveGrid}
                lockedStageIds={lockedStageIds}
                disabled={applying}
                onToggle={toggleStage}
              />
              {dirty && (
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => applyAndRelaunch(grid!, gridScope ?? intent.scope ?? 'composed')}
                    disabled={applying}
                    data-testid="recompose-apply-manual"
                  >
                    {applying && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                    Apply changes &amp; relaunch
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setGrid(null);
                      setGridScope(null);
                    }}
                    disabled={applying}
                  >
                    Discard
                  </Button>
                </div>
              )}
            </>
          ) : (
            <p className="text-xs text-muted-foreground">Loading the workflow grid…</p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
