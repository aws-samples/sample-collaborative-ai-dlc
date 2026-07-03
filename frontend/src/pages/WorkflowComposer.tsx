import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  workflowsService,
  type Workflow,
  type PhaseNodeInput,
  type CompiledWorkflow,
} from '@/services/workflows';
import { blocksService, type Block } from '@/services/blocks';
import { WorkflowInsights } from '@/components/blocks/WorkflowInsights';
import { WorkflowScopeGraph } from '@/components/v2';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ArrowLeft, AlertCircle, CheckCircle2, X, Lock, Loader2 } from 'lucide-react';
import { BlockPalette } from './composer/BlockPalette';
import { PhaseLanes } from './composer/PhaseLanes';
import { StageEditModal } from './composer/StageEditModal';
import { DEFAULT_PHASE_NODES } from './composer/defaultPhases';

export default function WorkflowComposer() {
  const navigate = useNavigate();
  const { workflowId } = useParams<{ workflowId: string }>();

  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  const [stageLib, setStageLib] = useState<Block[]>([]);
  const [scopeLib, setScopeLib] = useState<Block[]>([]);
  const [compiled, setCompiled] = useState<CompiledWorkflow | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [editingStageId, setEditingStageId] = useState<string | null>(null);

  const readOnly = workflow?.readOnly ?? false;

  // Initial load — sets loading=true once; never again after.
  const load = useCallback(async () => {
    if (!workflowId) return;
    setLoading(true);
    try {
      const [wf, stages, scopes, comp] = await Promise.all([
        workflowsService.get(workflowId),
        blocksService.list('stage'),
        blocksService.list('scope'),
        workflowsService.compiled(workflowId),
      ]);
      setWorkflow(wf);
      setStageLib(stages.blocks);
      setScopeLib(scopes.blocks);
      setCompiled(comp);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load workflow');
    } finally {
      setLoading(false);
    }
  }, [workflowId]);

  // Silent refresh — re-fetches workflow + compiled without touching loading.
  const refresh = useCallback(async () => {
    if (!workflowId) return;
    try {
      const [wf, comp] = await Promise.all([
        workflowsService.get(workflowId),
        workflowsService.compiled(workflowId),
      ]);
      setWorkflow(wf);
      setCompiled(comp);
    } catch {
      // silent — the optimistic state is good enough for now
    }
  }, [workflowId]);

  useEffect(() => {
    load();
  }, [load]);

  const flash = (msg: string) => {
    setSuccess(msg);
    setError(null);
  };
  const fail = (e: unknown) => setError(e instanceof Error ? e.message : 'Action failed');

  // ── META ──
  const [name, setName] = useState('');
  const [objective, setObjective] = useState('');
  useEffect(() => {
    if (workflow) {
      setName(workflow.name);
      setObjective(workflow.objective);
    }
  }, [workflow]);

  const saveMeta = async () => {
    if (!workflowId) return;
    setSaving(true);
    try {
      await workflowsService.update(workflowId, { name, objective });
      flash('Saved.');
      await refresh();
    } catch (e) {
      fail(e);
      await refresh();
    } finally {
      setSaving(false);
    }
  };

  // ── Phases ──
  const existingPhases = () =>
    (workflow?.phases ?? []).map((p) => ({
      phaseId: p.phaseId,
      name: p.name,
      path: p.path,
      kind: p.kind,
    }));

  const replacePhases = async (nodes: PhaseNodeInput[]) => {
    if (!workflowId) return;
    setSaving(true);
    try {
      const updated = await workflowsService.putPhases(workflowId, nodes);
      setWorkflow(updated);
      flash('Phase tree updated.');
      await refresh();
    } catch (e) {
      fail(e);
      await refresh();
    } finally {
      setSaving(false);
    }
  };

  const addPhase = (phaseId: string, phaseName: string, path: string) => {
    replacePhases([...existingPhases(), { phaseId, name: phaseName, path, kind: 'phase' }]);
  };

  const removePhase = (path: string) => {
    replacePhases(
      existingPhases().filter((p) => p.path !== path && !p.path.startsWith(`${path}.`)),
    );
  };

  const applySkeleton = () => replacePhases(DEFAULT_PHASE_NODES);

  // ── Placements ──
  const addPlacement = async (stageId: string, phasePath?: string | null) => {
    if (!workflowId || !workflow) return;
    // Optimistic: add placement locally
    setWorkflow((prev) => {
      if (!prev) return prev;
      const already = prev.placements.find((p) => p.stageId === stageId);
      if (already) return prev;
      return {
        ...prev,
        placements: [
          ...prev.placements,
          {
            stageId,
            stageTenant: 'default',
            pinnedVersion: null,
            phasePath: phasePath ?? null,
            order: prev.placements.length,
            scopeMembership: {},
          },
        ],
      };
    });
    setSaving(true);
    try {
      await workflowsService.addPlacement(workflowId, { stageId, phasePath: phasePath ?? null });
      flash('Stage placed.');
      await refresh();
    } catch (e) {
      fail(e);
      await refresh();
    } finally {
      setSaving(false);
    }
  };

  const onDropStage = async (stageId: string, phasePath: string | null) => {
    if (!workflowId || !workflow) return;
    // Optimistic: move placement locally
    setWorkflow((prev) => {
      if (!prev) return prev;
      const existing = prev.placements.find((p) => p.stageId === stageId);
      if (existing) {
        return {
          ...prev,
          placements: prev.placements.map((p) => (p.stageId === stageId ? { ...p, phasePath } : p)),
        };
      }
      // New placement
      return {
        ...prev,
        placements: [
          ...prev.placements,
          {
            stageId,
            stageTenant: 'default',
            pinnedVersion: null,
            phasePath,
            order: prev.placements.length,
            scopeMembership: {},
          },
        ],
      };
    });
    setSaving(true);
    try {
      const existing = workflow.placements.find((p) => p.stageId === stageId);
      if (existing) {
        await workflowsService.updatePlacement(workflowId, stageId, { phasePath });
      } else {
        await workflowsService.addPlacement(workflowId, { stageId, phasePath });
      }
      await refresh();
    } catch (e) {
      fail(e);
      await refresh();
    } finally {
      setSaving(false);
    }
  };

  const onReorderPlacement = async (
    stageId: string,
    targetPhasePath: string | null,
    targetIndex: number,
  ) => {
    if (!workflowId || !workflow) return;

    const dragged = workflow.placements.find((p) => p.stageId === stageId);
    if (!dragged) return;

    const sourcePhasePath = dragged.phasePath;

    const targetLane = workflow.placements
      .filter((p) => (targetPhasePath === null ? !p.phasePath : p.phasePath === targetPhasePath))
      .toSorted((a, b) => a.order - b.order);

    const targetLaneWithoutDragged = targetLane.filter((p) => p.stageId !== stageId);

    const sourceIndex = targetLane.findIndex((p) => p.stageId === stageId);
    const adjustedIndex =
      sourceIndex !== -1 && sourceIndex < targetIndex ? targetIndex - 1 : targetIndex;
    const clampedIndex = Math.min(adjustedIndex, targetLaneWithoutDragged.length);
    const newTargetLane = [
      ...targetLaneWithoutDragged.slice(0, clampedIndex),
      { ...dragged, phasePath: targetPhasePath },
      ...targetLaneWithoutDragged.slice(clampedIndex),
    ];

    const targetUpdates: { stageId: string; order: number; phasePath: string | null }[] = [];
    newTargetLane.forEach((p, i) => {
      if (p.order !== i || p.stageId === stageId) {
        targetUpdates.push({ stageId: p.stageId, order: i, phasePath: targetPhasePath });
      }
    });

    const sourceUpdates: { stageId: string; order: number }[] = [];
    if (
      sourcePhasePath !== targetPhasePath ||
      (sourcePhasePath === null && targetPhasePath !== null) ||
      (sourcePhasePath !== null && targetPhasePath === null)
    ) {
      const sourceLane = workflow.placements
        .filter((p) => (sourcePhasePath === null ? !p.phasePath : p.phasePath === sourcePhasePath))
        .filter((p) => p.stageId !== stageId)
        .toSorted((a, b) => a.order - b.order);
      sourceLane.forEach((p, i) => {
        if (p.order !== i) {
          sourceUpdates.push({ stageId: p.stageId, order: i });
        }
      });
    }

    setWorkflow((prev) => {
      if (!prev) return prev;
      const updatesMap = new Map<string, { order: number; phasePath?: string | null }>();
      for (const u of targetUpdates) {
        updatesMap.set(u.stageId, { order: u.order, phasePath: u.phasePath });
      }
      for (const u of sourceUpdates) {
        const existing = updatesMap.get(u.stageId);
        if (existing) {
          existing.order = u.order;
        } else {
          updatesMap.set(u.stageId, { order: u.order });
        }
      }
      return {
        ...prev,
        placements: prev.placements.map((p) => {
          const upd = updatesMap.get(p.stageId);
          if (!upd) return p;
          return {
            ...p,
            order: upd.order,
            ...(upd.phasePath !== undefined ? { phasePath: upd.phasePath } : {}),
          };
        }),
      };
    });

    setSaving(true);
    try {
      const calls: Promise<unknown>[] = [];
      for (const u of targetUpdates) {
        calls.push(
          workflowsService.updatePlacement(workflowId, u.stageId, {
            phasePath: u.phasePath,
            order: u.order,
          }),
        );
      }
      for (const u of sourceUpdates) {
        if (!targetUpdates.some((t) => t.stageId === u.stageId)) {
          calls.push(workflowsService.updatePlacement(workflowId, u.stageId, { order: u.order }));
        }
      }
      await Promise.all(calls);
      await refresh();
    } catch (e) {
      fail(e);
      await refresh();
    } finally {
      setSaving(false);
    }
  };

  const removePlacement = async (stageId: string) => {
    if (!workflowId) return;
    // Optimistic: remove locally
    setWorkflow((prev) => {
      if (!prev) return prev;
      return { ...prev, placements: prev.placements.filter((p) => p.stageId !== stageId) };
    });
    setSaving(true);
    try {
      await workflowsService.removePlacement(workflowId, stageId);
      flash('Placement removed.');
      await refresh();
    } catch (e) {
      fail(e);
      await refresh();
    } finally {
      setSaving(false);
    }
  };

  // ── Scopes ──
  const addScope = async (scopeId: string) => {
    if (!workflowId || !workflow) return;
    // Optimistic
    setWorkflow((prev) => {
      if (!prev) return prev;
      const already = prev.scopeRefs.find((r) => r.scopeId === scopeId);
      if (already) return prev;
      return { ...prev, scopeRefs: [...prev.scopeRefs, { scopeId, scopeTenant: 'default' }] };
    });
    setSaving(true);
    try {
      await workflowsService.addScopeRef(workflowId, scopeId);
      await refresh();
    } catch (e) {
      fail(e);
      await refresh();
    } finally {
      setSaving(false);
    }
  };

  const removeScope = async (scopeId: string) => {
    if (!workflowId || !workflow) return;
    // Optimistic
    setWorkflow((prev) => {
      if (!prev) return prev;
      return { ...prev, scopeRefs: prev.scopeRefs.filter((r) => r.scopeId !== scopeId) };
    });
    setSaving(true);
    try {
      await workflowsService.removeScopeRef(workflowId, scopeId);
      await refresh();
    } catch (e) {
      fail(e);
      await refresh();
    } finally {
      setSaving(false);
    }
  };

  // Per-cell in-flight tracking for race-safe toggle coalescing.
  const toggleInFlightRef = useRef<Map<string, boolean>>(new Map());
  const togglePendingRef = useRef<Map<string, 'EXECUTE' | 'SKIP'>>(new Map());
  const computedMembershipRef = useRef<Record<string, 'EXECUTE' | 'SKIP'> | null>(null);

  const toggleCell = async (stageId: string, scopeId: string, next: 'EXECUTE' | 'SKIP') => {
    if (!workflowId || !workflow) return;
    const key = `${stageId}:${scopeId}`;

    // Always optimistic — UI updates instantly on every click.
    setWorkflow((prev) => {
      if (!prev) return prev;
      const updated = prev.placements.map((p) =>
        p.stageId === stageId
          ? { ...p, scopeMembership: { ...p.scopeMembership, [scopeId]: next } }
          : p,
      );
      const target = updated.find((p) => p.stageId === stageId);
      computedMembershipRef.current = target ? { ...target.scopeMembership } : null;
      return { ...prev, placements: updated };
    });

    const membership = computedMembershipRef.current ?? { [scopeId]: next };

    // If a request for this cell is already in-flight, store as pending and return.
    // The in-flight request's completion handler will fire the follow-up.
    if (toggleInFlightRef.current.get(key)) {
      togglePendingRef.current.set(key, next);
      return;
    }

    // Mark in-flight and fire the network write.
    toggleInFlightRef.current.set(key, true);
    setSaving(true);
    try {
      await workflowsService.updatePlacement(workflowId, stageId, { scopeMembership: membership });
    } catch (e) {
      fail(e);
    }

    // Drain any pending clicks that arrived during in-flight PUTs.
    while (togglePendingRef.current.has(key)) {
      const pending = togglePendingRef.current.get(key)!;
      togglePendingRef.current.delete(key);
      setWorkflow((prev) => {
        if (!prev) return prev;
        const target = prev.placements.find((p) => p.stageId === stageId);
        computedMembershipRef.current = target ? { ...target.scopeMembership } : null;
        return prev;
      });
      const freshMembership = computedMembershipRef.current ?? { [scopeId]: pending };
      try {
        await workflowsService.updatePlacement(workflowId, stageId, {
          scopeMembership: freshMembership,
        });
      } catch (e) {
        fail(e);
      }
    }

    toggleInFlightRef.current.delete(key);
    await refresh();
    setSaving(false);
  };

  const stagesById = useMemo(
    () => Object.fromEntries(stageLib.map((s) => [s.id, s])) as Record<string, Block>,
    [stageLib],
  );

  const stageMeta = useMemo(() => {
    const meta: Record<string, { number: string; name: string; phase: string }> = {};
    if (workflow) {
      const ordered = workflow.placements.toSorted((a, b) => {
        const ap = a.phasePath ?? '';
        const bp = b.phasePath ?? '';
        return ap === bp ? a.order - b.order : ap.localeCompare(bp);
      });
      ordered.forEach((p, i) => {
        const block = stagesById[p.stageId];
        meta[p.stageId] = {
          number: String(i + 1),
          name: block?.name ?? p.stageId,
          phase: p.phasePath ?? '00',
        };
      });
    }
    return meta;
  }, [stagesById, workflow]);

  // Source of truth for scope membership is placement.scopeMembership. The
  // backend's compiled.scopeGrid is the same data transposed (scope→stage), but
  // the SYSTEM seed ships it empty, so we transpose from the source ourselves.
  const compiledView = useMemo(() => {
    if (!compiled || !workflow) return compiled;
    const grid: Record<string, Record<string, 'EXECUTE' | 'SKIP'>> = {};
    for (const p of workflow.placements) {
      for (const [scope, value] of Object.entries(p.scopeMembership ?? {})) {
        (grid[scope] ??= {})[p.stageId] = value;
      }
    }
    return Object.keys(grid).length > 0 ? { ...compiled, scopeGrid: grid } : compiled;
  }, [compiled, workflow]);

  if (loading) {
    return (
      <div className="mx-auto w-full max-w-[1600px] px-6 py-6 text-sm text-muted-foreground">
        Loading…
      </div>
    );
  }
  if (!workflow) {
    return (
      <div className="mx-auto w-full max-w-[1600px] px-6 py-6 text-sm text-destructive">
        {error ?? 'Not found'}
      </div>
    );
  }

  const placedStageIds = new Set(workflow.placements.map((p) => p.stageId));

  const initPhasePath = workflow.phases.find((p) => p.phaseId === 'initialization')?.path;
  const graphCompiled =
    compiledView && initPhasePath
      ? {
          ...compiledView,
          graph: {
            ...compiledView.graph,
            nodes: compiledView.graph.nodes.filter((n) => n.phasePath !== initPhasePath),
          },
        }
      : compiledView;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-[1600px] px-6 py-6 space-y-6">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5"
            onClick={() => navigate('/workflows')}
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back
          </Button>
          <div className="h-5 w-px bg-border" />
          <h1 className="text-xl font-semibold tracking-tight">{workflow.name}</h1>
          {readOnly && (
            <Badge variant="outline" className="gap-1 text-[10px] ml-auto">
              <Lock className="h-2.5 w-2.5" />
              SYSTEM · read-only
            </Badge>
          )}
          {saving && (
            <Badge variant="secondary" className="gap-1.5 text-[10px] ml-auto animate-pulse">
              <Loader2 className="h-2.5 w-2.5 animate-spin" />
              Saving…
            </Badge>
          )}
        </div>

        {readOnly && (
          <p className="text-xs text-muted-foreground">
            This is a shipped baseline workflow and cannot be edited. Fork it from the Workflows
            list to customize.
          </p>
        )}

        {error && (
          <div className="bg-destructive/5 border border-destructive/20 text-destructive px-4 py-3 rounded-md flex items-start justify-between gap-3 text-sm">
            <div className="flex items-start gap-2">
              <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 text-destructive hover:text-destructive"
              onClick={() => setError(null)}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}
        {success && (
          <div className="bg-agent-success/10 border border-agent-success/20 text-agent-success px-4 py-3 rounded-md flex items-start gap-2 text-sm">
            <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
            <span>{success}</span>
          </div>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Objective</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-2">
              <Label>Name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} disabled={readOnly} />
            </div>
            <div className="grid gap-2">
              <Label>Objective</Label>
              <Input
                value={objective}
                onChange={(e) => setObjective(e.target.value)}
                placeholder="The end-to-end outcome this workflow delivers"
                disabled={readOnly}
              />
            </div>
            {!readOnly && (
              <div className="flex justify-end">
                <Button size="sm" onClick={saveMeta}>
                  Save
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Build — phases & stages</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col gap-4">
              <BlockPalette
                stages={stageLib}
                placedStageIds={placedStageIds}
                readOnly={readOnly}
                onAdd={(stageId) => addPlacement(stageId)}
              />
              <PhaseLanes
                phases={workflow.phases}
                placements={workflow.placements}
                stagesById={stagesById}
                readOnly={readOnly}
                compiled={compiled}
                scopeRefs={workflow.scopeRefs}
                scopeLib={scopeLib}
                onDropStage={onDropStage}
                onReorderPlacement={onReorderPlacement}
                onRemovePlacement={removePlacement}
                onAddPhase={addPhase}
                onRemovePhase={removePhase}
                onApplySkeleton={applySkeleton}
                onToggleCell={toggleCell}
                onAddScope={addScope}
                onRemoveScope={removeScope}
                onOpenStage={setEditingStageId}
              />
            </div>
          </CardContent>
        </Card>

        <StageEditModal
          stageId={editingStageId}
          onClose={() => setEditingStageId(null)}
          onSaved={refresh}
        />

        {compiledView && compiledView.graph.nodes.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Workflow graph — scope preview</CardTitle>
            </CardHeader>
            <CardContent>
              <WorkflowScopeGraph
                compiled={graphCompiled!}
                scopes={scopeLib.length > 0 ? scopeLib.map((b) => b.id) : undefined}
                defaultScope={workflow.defaultScope ?? undefined}
                scopeDescriptions={
                  scopeLib.length > 0
                    ? Object.fromEntries(scopeLib.map((b) => [b.id, b.description ?? b.name]))
                    : undefined
                }
                stageMeta={stageMeta}
                phases={workflow.phases
                  .filter((p) => p.phaseId !== 'initialization')
                  .map((p) => ({ path: p.path, name: p.name }))}
                readOnly={readOnly}
                onToggleScope={toggleCell}
              />
            </CardContent>
          </Card>
        )}

        {compiledView && compiledView.graph.nodes.length === 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Workflow graph — scope preview</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground italic">
                Place stages and compile the workflow to preview the scope graph.
              </p>
            </CardContent>
          </Card>
        )}

        <WorkflowInsights workflow={workflow} compiled={compiled} readOnly={readOnly} />
      </div>
    </div>
  );
}
