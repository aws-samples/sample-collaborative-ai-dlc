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
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  ArrowLeft,
  AlertCircle,
  CheckCircle2,
  X,
  Lock,
  Loader2,
  Plus,
  Library,
} from 'lucide-react';
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
  const [editingPhasePath, setEditingPhasePath] = useState<string | null>(null);
  const [activeScope, setActiveScope] = useState<string | null>(null);

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

  const createPhase = async () => {
    const topPaths = existingPhases()
      .filter((phase) => !phase.path.includes('.'))
      .map((phase) => phase.path);
    let max = 0;
    for (const path of topPaths) {
      const parsed = Number.parseInt(path.split('.')[0], 10);
      if (Number.isFinite(parsed) && parsed > max) max = parsed;
    }
    const path = String(max + 1).padStart(2, '0');
    setEditingPhasePath(path);
    await replacePhases([
      ...existingPhases(),
      { phaseId: `phase-${path.replaceAll('.', '-')}`, name: 'New phase', path, kind: 'phase' },
    ]);
  };

  const renamePhase = async (path: string, rawName: string) => {
    const nextName = rawName.trim();
    setEditingPhasePath(null);
    if (!nextName) return;
    await replacePhases(
      existingPhases().map((phase) => (phase.path === path ? { ...phase, name: nextName } : phase)),
    );
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

  const visibleStageLib = useMemo(
    () => stageLib.filter((stage) => stage.phase !== 'initialization'),
    [stageLib],
  );

  const scopeIds = useMemo(
    () => (workflow ? workflow.scopeRefs.map((scopeRef) => scopeRef.scopeId) : []),
    [workflow],
  );

  const availableScopes = useMemo(
    () => scopeLib.filter((scope) => !scopeIds.includes(scope.id)),
    [scopeIds, scopeLib],
  );

  useEffect(() => {
    if (scopeIds.length === 0) {
      setActiveScope(null);
      return;
    }
    setActiveScope((prev) => {
      if (prev && scopeIds.includes(prev)) return prev;
      if (workflow?.defaultScope && scopeIds.includes(workflow.defaultScope)) {
        return workflow.defaultScope;
      }
      return scopeIds[0] ?? null;
    });
  }, [scopeIds, workflow?.defaultScope]);

  const stageMeta = useMemo(() => {
    const meta: Record<string, { number: string; name: string; phase: string }> = {};
    if (workflow) {
      const initializationPaths = new Set(
        workflow.phases
          .filter((phase) => phase.phaseId === 'initialization')
          .map((phase) => phase.path),
      );
      const ordered = workflow.placements.toSorted((a, b) => {
        const ap = a.phasePath ?? '';
        const bp = b.phasePath ?? '';
        return ap === bp ? a.order - b.order : ap.localeCompare(bp);
      });
      ordered
        .filter((placement) => !initializationPaths.has(placement.phasePath ?? ''))
        .forEach((p, i) => {
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

  const graphCompiled = useMemo(() => {
    if (!compiledView || !workflow) return compiledView;
    const visiblePhasePaths = new Set(
      workflow.phases
        .filter((phase) => phase.phaseId !== 'initialization')
        .map((phase) => phase.path),
    );
    const visibleGraphStageIds = new Set(
      workflow.placements
        .filter(
          (placement) =>
            stagesById[placement.stageId]?.phase !== 'initialization' &&
            (placement.phasePath === null || visiblePhasePaths.has(placement.phasePath)),
        )
        .map((placement) => placement.stageId),
    );
    return {
      ...compiledView,
      graph: {
        ...compiledView.graph,
        nodes: compiledView.graph.nodes.filter((node) => visibleGraphStageIds.has(node.stageId)),
        edges: compiledView.graph.edges.filter(
          (edge) => visibleGraphStageIds.has(edge.from) && visibleGraphStageIds.has(edge.to),
        ),
      },
    };
  }, [compiledView, workflow, stagesById]);

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
            <div className="flex flex-col gap-1">
              <CardTitle className="text-sm">Objective</CardTitle>
              <p className="text-xs text-muted-foreground">
                Define the end-to-end outcome this workflow should deliver.
              </p>
            </div>
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
            <div className="flex items-start gap-3 flex-wrap">
              <div className="flex flex-col gap-1">
                <CardTitle className="text-sm shrink-0">Build — phases & stages</CardTitle>
                <p className="text-xs text-muted-foreground">
                  Organize stages into phases and structure the workflow.
                </p>
              </div>
              <div className="ml-auto flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1 text-xs"
                  onClick={() => navigate('/blocks/stage/new')}
                >
                  <Plus className="h-3 w-3" />
                  New stage
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1 text-xs"
                  onClick={() => navigate('/blocks/stage')}
                >
                  <Library className="h-3 w-3" />
                  Block library
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
              <div className="w-full shrink-0 lg:w-72">
                <BlockPalette
                  stages={visibleStageLib}
                  placedStageIds={placedStageIds}
                  readOnly={readOnly}
                  onAdd={(stageId) => addPlacement(stageId)}
                />
              </div>
              <div className="min-w-0 flex-1">
                <PhaseLanes
                  phases={workflow.phases}
                  placements={workflow.placements}
                  stagesById={stagesById}
                  readOnly={readOnly}
                  compiled={compiled}
                  onDropStage={onDropStage}
                  onReorderPlacement={onReorderPlacement}
                  onRemovePlacement={removePlacement}
                  onAddPhase={createPhase}
                  editingPhasePath={editingPhasePath}
                  onStartPhaseRename={setEditingPhasePath}
                  onCancelPhaseRename={() => setEditingPhasePath(null)}
                  onRenamePhase={renamePhase}
                  onRemovePhase={removePhase}
                  onApplySkeleton={applySkeleton}
                  onOpenStage={setEditingStageId}
                />
              </div>
            </div>
          </CardContent>
        </Card>

        <StageEditModal
          stageId={editingStageId}
          onClose={() => setEditingStageId(null)}
          onSaved={refresh}
        />

        {graphCompiled && graphCompiled.graph.nodes.length > 0 && (
          <Card>
            <CardHeader>
              <div className="flex flex-col gap-3">
                <div className="flex flex-col gap-1">
                  <CardTitle className="text-sm">Workflow graph — scope preview</CardTitle>
                  <p className="text-xs text-muted-foreground">
                    Preview execution flow and configure which stages run in each scope.
                  </p>
                </div>
                <ScopeSelectionBar
                  scopeIds={scopeIds}
                  activeScope={activeScope}
                  availableScopes={availableScopes}
                  readOnly={readOnly}
                  onSelectScope={setActiveScope}
                  onAddScope={addScope}
                  onRemoveScope={removeScope}
                />
              </div>
            </CardHeader>
            <CardContent>
              <WorkflowScopeGraph
                compiled={graphCompiled}
                scopes={scopeIds.length > 0 ? scopeIds : undefined}
                defaultScope={workflow.defaultScope ?? undefined}
                activeScope={activeScope}
                onActiveScopeChange={setActiveScope}
                hideScopeSelector
                scopeDescriptions={
                  scopeIds.length > 0
                    ? Object.fromEntries(
                        scopeIds
                          .map((scopeId) => scopeLib.find((block) => block.id === scopeId))
                          .filter((block): block is Block => !!block)
                          .map((block) => [block.id, block.description ?? block.name]),
                      )
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

        {graphCompiled && graphCompiled.graph.nodes.length === 0 && (
          <Card>
            <CardHeader>
              <div className="flex flex-col gap-1">
                <CardTitle className="text-sm">Workflow graph — scope preview</CardTitle>
                <p className="text-xs text-muted-foreground">
                  Preview execution flow and configure which stages run in each scope.
                </p>
              </div>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground italic">
                Place stages and compile the workflow to preview the scope graph.
              </p>
            </CardContent>
          </Card>
        )}

        <WorkflowInsights compiled={compiled} />
      </div>
    </div>
  );
}

function ScopeSelectionBar({
  scopeIds,
  activeScope,
  availableScopes,
  readOnly,
  onSelectScope,
  onAddScope,
  onRemoveScope,
}: {
  scopeIds: string[];
  activeScope: string | null;
  availableScopes: Block[];
  readOnly: boolean;
  onSelectScope: (scopeId: string) => void;
  onAddScope: (scopeId: string) => void;
  onRemoveScope: (scopeId: string) => void;
}) {
  const [open, setOpen] = useState(false);

  if (scopeIds.length === 0 && (readOnly || availableScopes.length === 0)) {
    return null;
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs font-medium text-muted-foreground">Scopes</span>
      {scopeIds.map((scopeId) => (
        <span key={scopeId} className="inline-flex items-center gap-0.5">
          <Button
            variant={scopeId === activeScope ? 'secondary' : 'ghost'}
            size="sm"
            className="h-6 px-2 text-[10px]"
            onClick={() => onSelectScope(scopeId)}
          >
            {scopeId}
          </Button>
          {!readOnly && (
            <button
              type="button"
              className="text-muted-foreground hover:text-destructive"
              onClick={(event) => {
                event.stopPropagation();
                onRemoveScope(scopeId);
              }}
            >
              <X className="h-2.5 w-2.5" />
            </button>
          )}
        </span>
      ))}
      {!readOnly && availableScopes.length > 0 && (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm" className="h-6 gap-1 text-[10px]">
              <Plus className="h-3 w-3" />
              Add scope
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-[160px] p-1">
            {availableScopes.map((scope) => (
              <button
                key={scope.id}
                type="button"
                className="w-full rounded px-2 py-1 text-left text-xs hover:bg-accent"
                onClick={() => {
                  onAddScope(scope.id);
                  setOpen(false);
                }}
              >
                {scope.name}
              </button>
            ))}
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}
