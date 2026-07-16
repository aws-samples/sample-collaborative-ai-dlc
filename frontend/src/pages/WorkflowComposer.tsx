import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  workflowsService,
  type Workflow,
  type PhaseNodeInput,
  type CompiledWorkflow,
  type ExecutionPreview,
} from '@/services/workflows';
import { blocksService, type Block } from '@/services/blocks';
import { WorkflowInsights } from '@/components/blocks/WorkflowInsights';
import { WorkflowScopeGraph } from '@/components/v2';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  ArrowLeft,
  AlertCircle,
  CheckCircle2,
  X,
  Lock,
  Loader2,
  Plus,
  GitBranch,
} from 'lucide-react';
import { BlockPalette } from './composer/BlockPalette';
import { PhaseLanes } from './composer/PhaseLanes';
import { StageEditModal } from './composer/StageEditModal';
import { DEFAULT_PHASE_NODES } from './composer/defaultPhases';
import { ScopeBuilder } from './composer/ScopeBuilder';
import { displayPhasePathForPlacement, visibleWorkflowPhases } from './composer/phaseDisplay';

export default function WorkflowComposer() {
  const navigate = useNavigate();
  const { workflowId } = useParams<{ workflowId: string }>();

  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  const [stageLib, setStageLib] = useState<Block[]>([]);
  const [scopeLib, setScopeLib] = useState<Block[]>([]);
  const [compiled, setCompiled] = useState<CompiledWorkflow | null>(null);
  const [preview, setPreview] = useState<ExecutionPreview | null>(null);
  const [workbenchMode, setWorkbenchMode] = useState<'compose' | 'scopes' | 'validate'>('compose');
  const [paletteOpen, setPaletteOpen] = useState(false);
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
      const [wf, comp, scopes] = await Promise.all([
        workflowsService.get(workflowId),
        workflowsService.compiled(workflowId),
        blocksService.list('scope'),
      ]);
      setWorkflow(wf);
      setCompiled(comp);
      setScopeLib(scopes.blocks);
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

  const saveScopeMembership = async ({
    scopeId,
    name: scopeName,
    stageIds,
    createBlock,
    setDefault,
  }: {
    scopeId: string;
    name: string;
    stageIds: string[];
    createBlock: boolean;
    setDefault: boolean;
  }) => {
    if (!workflowId || !workflow) return;
    setSaving(true);
    try {
      if (createBlock) {
        await blocksService.create('scope', {
          id: scopeId,
          name: scopeName,
          description: '',
        });
      }
      const scopeTenant =
        (createBlock ? 'default' : scopeLib.find((scope) => scope.id === scopeId)?.tenantId) ??
        'SYSTEM';
      const updated = await workflowsService.putScopeMembership(
        workflowId,
        scopeId,
        stageIds,
        scopeTenant,
      );
      setWorkflow(updated);
      if (setDefault && updated.defaultScope !== scopeId) {
        await workflowsService.update(workflowId, { defaultScope: scopeId });
      }
      setActiveScope(scopeId);
      flash('Scope saved.');
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

  useEffect(() => {
    if (!workflowId || !activeScope) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    workflowsService
      .executionPreview(workflowId, activeScope)
      .then((next) => {
        if (!cancelled) setPreview(next);
      })
      .catch(() => {
        if (!cancelled) setPreview(null);
      });
    return () => {
      cancelled = true;
    };
  }, [activeScope, workflowId, workflow?.version]);

  const stageMeta = useMemo(() => {
    const meta: Record<string, { number: string; name: string; phase: string }> = {};
    if (workflow) {
      const initializationPaths = new Set(
        workflow.phases
          .filter((phase) => phase.phaseId === 'initialization')
          .map((phase) => phase.path),
      );
      const ordered = workflow.placements.toSorted((a, b) => {
        const ap = displayPhasePathForPlacement(a, workflow.phases, stagesById) ?? '';
        const bp = displayPhasePathForPlacement(b, workflow.phases, stagesById) ?? '';
        return ap === bp ? a.order - b.order : ap.localeCompare(bp);
      });
      ordered
        .filter(
          (placement) =>
            !initializationPaths.has(placement.phasePath ?? '') &&
            stagesById[placement.stageId]?.phase !== 'initialization',
        )
        .forEach((p, i) => {
          const block = stagesById[p.stageId];
          const phase = displayPhasePathForPlacement(p, workflow.phases, stagesById);
          meta[p.stageId] = {
            number: String(i + 1),
            name: block?.name ?? p.stageId,
            phase: phase ?? '00',
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
      visibleWorkflowPhases(workflow.phases).map((phase) => phase.path),
    );
    const displayPathByStage = new Map(
      workflow.placements.map((placement) => [
        placement.stageId,
        displayPhasePathForPlacement(placement, workflow.phases, stagesById),
      ]),
    );
    const visibleGraphStageIds = new Set(
      workflow.placements
        .filter(
          (placement) =>
            stagesById[placement.stageId]?.phase !== 'initialization' &&
            (displayPathByStage.get(placement.stageId) === null ||
              visiblePhasePaths.has(displayPathByStage.get(placement.stageId) ?? '')),
        )
        .map((placement) => placement.stageId),
    );
    return {
      ...compiledView,
      graph: {
        ...compiledView.graph,
        nodes: compiledView.graph.nodes
          .filter((node) => visibleGraphStageIds.has(node.stageId))
          .map((node) => ({
            ...node,
            phasePath: displayPathByStage.get(node.stageId) ?? node.phasePath,
          })),
        edges: compiledView.graph.edges.filter(
          (edge) => visibleGraphStageIds.has(edge.from) && visibleGraphStageIds.has(edge.to),
        ),
      },
    };
  }, [compiledView, workflow, stagesById]);

  const branchIssuesByStage = useMemo(() => {
    const issues: Record<string, string[]> = {};
    for (const issue of [...(preview?.errors ?? []), ...(preview?.warnings ?? [])]) {
      const refs = Array.isArray(issue.ref) ? issue.ref : [];
      const stageIds = issue.stageId
        ? [issue.stageId]
        : refs.filter((ref): ref is string => typeof ref === 'string');
      for (const stageId of stageIds) {
        (issues[stageId] ??= []).push(issue.message);
      }
    }
    return issues;
  }, [preview]);

  if (loading) {
    return <div className="text-sm text-muted-foreground">Loading…</div>;
  }
  if (!workflow) {
    return <div className="text-sm text-destructive">{error ?? 'Not found'}</div>;
  }

  const placedStageIds = new Set(workflow.placements.map((p) => p.stageId));
  const scopeDescriptions =
    scopeIds.length > 0
      ? Object.fromEntries(
          scopeIds
            .map((scopeId) => scopeLib.find((block) => block.id === scopeId))
            .filter((block): block is Block => !!block)
            .map((block) => [block.id, block.description ?? block.name]),
        )
      : undefined;
  const visiblePhases = visibleWorkflowPhases(workflow.phases).map((p) => ({
    path: p.path,
    name: p.name,
  }));

  return (
    <div className="h-full overflow-y-auto">
      <div className="flex flex-col gap-4">
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

        <WorkflowTopBar
          workflow={workflow}
          name={name}
          objective={objective}
          readOnly={readOnly}
          activeScope={activeScope}
          preview={preview}
          saving={saving}
          onNameChange={setName}
          onObjectiveChange={setObjective}
          onSaveMeta={saveMeta}
        />

        <div className="flex flex-wrap items-center gap-3">
          <Tabs
            value={workbenchMode}
            onValueChange={(value) => setWorkbenchMode(value as 'compose' | 'scopes' | 'validate')}
          >
            <TabsList className="h-9">
              <TabsTrigger value="compose">Compose</TabsTrigger>
              <TabsTrigger value="scopes">Scopes</TabsTrigger>
              <TabsTrigger value="validate">Validate</TabsTrigger>
            </TabsList>
          </Tabs>

          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Popover open={paletteOpen} onOpenChange={setPaletteOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 gap-1.5 text-xs"
                  disabled={readOnly}
                >
                  <Plus className="h-3.5 w-3.5" />
                  Add existing stage
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-[28rem] max-w-[calc(100vw-2rem)] p-2">
                <BlockPalette
                  stages={visibleStageLib}
                  placedStageIds={placedStageIds}
                  readOnly={readOnly}
                  onAdd={(stageId) => addPlacement(stageId)}
                />
              </PopoverContent>
            </Popover>
          </div>
        </div>

        <main className="min-h-[calc(100vh-18rem)] min-w-0 rounded-md border bg-card/40 p-3">
          {workbenchMode === 'compose' && (
            <PhaseLanes
              phases={workflow.phases}
              placements={workflow.placements}
              stagesById={stagesById}
              readOnly={readOnly}
              compiled={compiled}
              branchIssues={branchIssuesByStage}
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
          )}

          {workbenchMode === 'scopes' && (
            <ScopeBuilder
              workflow={workflow}
              scopeLib={scopeLib}
              stagesById={stagesById}
              activeScope={activeScope}
              readOnly={readOnly}
              preview={preview}
              onSelectScope={setActiveScope}
              onRemoveScope={removeScope}
              onSaveScope={saveScopeMembership}
            />
          )}

          {workbenchMode === 'validate' && (
            <div className="space-y-4">
              {graphCompiled && graphCompiled.graph.nodes.length > 0 ? (
                <WorkflowScopeGraph
                  compiled={graphCompiled}
                  scopes={scopeIds.length > 0 ? scopeIds : undefined}
                  defaultScope={workflow.defaultScope ?? undefined}
                  activeScope={activeScope}
                  onActiveScopeChange={setActiveScope}
                  scopeDescriptions={scopeDescriptions}
                  stageMeta={stageMeta}
                  phases={visiblePhases}
                  readOnly={readOnly}
                  onToggleScope={toggleCell}
                />
              ) : (
                <p className="p-6 text-sm italic text-muted-foreground">
                  Place stages and compile the workflow to preview execution.
                </p>
              )}
              <WorkflowInsights compiled={compiled} />
            </div>
          )}
        </main>

        <StageEditModal
          stageId={editingStageId}
          onClose={() => setEditingStageId(null)}
          onSaved={refresh}
        />
      </div>
    </div>
  );
}

function WorkflowTopBar({
  workflow,
  name,
  objective,
  readOnly,
  activeScope,
  preview,
  saving,
  onNameChange,
  onObjectiveChange,
  onSaveMeta,
}: {
  workflow: Workflow;
  name: string;
  objective: string;
  readOnly: boolean;
  activeScope: string | null;
  preview: ExecutionPreview | null;
  saving: boolean;
  onNameChange: (name: string) => void;
  onObjectiveChange: (objective: string) => void;
  onSaveMeta: () => void;
}) {
  const branchStages =
    preview?.plan?.stages.filter((stage) => stage.forEach === 'unit-of-work') ?? [];
  const degraded = branchStages.filter((stage) => stage.forEachDegraded).length;
  const issueCount = (preview?.errors.length ?? 0) + (preview?.warnings.length ?? 0);
  const firstIssue = preview?.errors[0] ?? preview?.warnings[0] ?? null;

  return (
    <section className="rounded-md border bg-background p-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[12rem] flex-[1_1_14rem] space-y-1.5 xl:max-w-[18rem]">
          <Label className="text-[11px]">Name</Label>
          <Input
            className="h-8"
            value={name}
            onChange={(e) => onNameChange(e.target.value)}
            disabled={readOnly}
          />
        </div>
        <div className="min-w-[18rem] flex-[999_1_24rem] space-y-1.5">
          <Label className="text-[11px]">Objective</Label>
          <Input
            className="h-8"
            value={objective}
            onChange={(e) => onObjectiveChange(e.target.value)}
            placeholder="The end-to-end outcome this workflow delivers"
            disabled={readOnly}
          />
        </div>
        <div className="flex min-w-[14rem] flex-[1_1_auto] flex-wrap items-center gap-2 sm:justify-end">
          <Badge variant="outline">v{workflow.version}</Badge>
          <Badge variant={workflow.status === 'PUBLISHED' ? 'default' : 'secondary'}>
            {workflow.status}
          </Badge>
          {workflow.defaultScope && (
            <Badge variant="outline">Default: {workflow.defaultScope}</Badge>
          )}
          <Button size="sm" className="h-8" onClick={onSaveMeta} disabled={readOnly || saving}>
            {saving ? 'Saving...' : 'Save workflow'}
          </Button>
        </div>
      </div>

      <div className="mt-3 flex min-w-0 flex-wrap items-center gap-2 border-t pt-3 text-xs">
        <Badge variant={preview?.valid ? 'default' : preview ? 'destructive' : 'outline'}>
          {preview ? (preview.valid ? 'Valid' : 'Blocked') : 'No scope'}
        </Badge>
        {activeScope && <Badge variant="outline">Scope: {activeScope}</Badge>}
        {preview?.plan && (
          <>
            <Metric label="Stages" value={String(preview.plan.stages.length)} />
            <Metric label="Sections" value={String(preview.plan.sections.length)} />
            <Metric label="Branches" value={String(branchStages.length)} icon="branch" />
            {degraded > 0 && <Metric label="Degraded" value={String(degraded)} />}
          </>
        )}
        {issueCount > 0 && (
          <div className="flex min-w-[12rem] flex-1 items-center gap-2 truncate text-muted-foreground">
            <Badge variant={preview?.errors.length ? 'destructive' : 'outline'}>
              {issueCount} issue{issueCount === 1 ? '' : 's'}
            </Badge>
            {firstIssue && (
              <span className="truncate">
                <span className="font-medium text-foreground">{firstIssue.code}</span>:{' '}
                {firstIssue.message}
              </span>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function Metric({ label, value, icon }: { label: string; value: string; icon?: 'branch' }) {
  return (
    <Badge variant="outline" className="gap-1.5">
      {icon === 'branch' && <GitBranch className="h-3 w-3" />}
      <span className="text-muted-foreground">{label}</span>
      <span>{value}</span>
    </Badge>
  );
}
