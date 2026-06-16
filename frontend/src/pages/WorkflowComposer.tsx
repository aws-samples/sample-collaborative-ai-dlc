import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  workflowsService,
  type Workflow,
  type PhaseNodeInput,
  type CompiledWorkflow,
} from '@/services/workflows';
import { blocksService, type Block } from '@/services/blocks';
import { WorkflowInsights } from '@/components/blocks/WorkflowInsights';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ArrowLeft, AlertCircle, CheckCircle2, X, Lock, Plus, Trash2 } from 'lucide-react';

export default function WorkflowComposer() {
  const navigate = useNavigate();
  const { workflowId } = useParams<{ workflowId: string }>();

  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  const [stageLib, setStageLib] = useState<Block[]>([]);
  const [scopeLib, setScopeLib] = useState<Block[]>([]);
  const [compiled, setCompiled] = useState<CompiledWorkflow | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const readOnly = workflow?.readOnly ?? false;

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
    try {
      await workflowsService.update(workflowId, { name, objective });
      flash('Saved.');
      await load();
    } catch (e) {
      fail(e);
    }
  };

  // ── Phases (whole-tree replace; defined inline) ──
  const replacePhases = async (nodes: PhaseNodeInput[]) => {
    if (!workflowId) return;
    try {
      const updated = await workflowsService.putPhases(workflowId, nodes);
      setWorkflow(updated);
      flash('Phase tree updated.');
    } catch (e) {
      fail(e);
    }
  };

  const existingPhases = () =>
    (workflow?.phases ?? []).map((p) => ({
      phaseId: p.phaseId,
      name: p.name,
      path: p.path,
      kind: p.kind,
    }));

  // Add a new top-level phase inline (prompt for a kebab-case id + label).
  const addPhase = () => {
    if (!workflow) return;
    const phaseId = window.prompt('Phase id (kebab-case), e.g. ideation')?.trim();
    if (!phaseId) return;
    const phaseName = window.prompt('Phase name', phaseId)?.trim() || phaseId;
    const topCount = workflow.phases.filter((p) => !p.path.includes('.')).length;
    const path = String(topCount + 1).padStart(2, '0');
    replacePhases([...existingPhases(), { phaseId, name: phaseName, path, kind: 'phase' }]);
  };

  const removePhase = (path: string) => {
    if (!workflow) return;
    // Drop the node and any descendants (paths nested under it).
    replacePhases(
      existingPhases().filter((p) => p.path !== path && !p.path.startsWith(`${path}.`)),
    );
  };

  // ── Placements ──
  const addPlacement = async (stageId: string) => {
    if (!workflowId) return;
    try {
      await workflowsService.addPlacement(workflowId, { stageId });
      await load();
      flash('Stage placed.');
    } catch (e) {
      fail(e);
    }
  };

  const setPlacementPhase = async (stageId: string, phasePath: string) => {
    if (!workflowId) return;
    try {
      await workflowsService.updatePlacement(workflowId, stageId, {
        phasePath: phasePath || null,
      });
      await load();
    } catch (e) {
      fail(e);
    }
  };

  const removePlacement = async (stageId: string) => {
    if (!workflowId) return;
    try {
      await workflowsService.removePlacement(workflowId, stageId);
      await load();
      flash('Placement removed.');
    } catch (e) {
      fail(e);
    }
  };

  // ── Scopes + matrix ──
  const addScope = async (scopeId: string) => {
    if (!workflowId) return;
    try {
      await workflowsService.addScopeRef(workflowId, scopeId);
      await load();
    } catch (e) {
      fail(e);
    }
  };

  const removeScope = async (scopeId: string) => {
    if (!workflowId) return;
    try {
      await workflowsService.removeScopeRef(workflowId, scopeId);
      await load();
    } catch (e) {
      fail(e);
    }
  };

  // Toggle one matrix cell: merge the new state into the placement's
  // scopeMembership and persist, then refresh the derived grid.
  const toggleCell = async (stageId: string, scopeId: string, next: 'EXECUTE' | 'SKIP') => {
    if (!workflowId || !workflow) return;
    const placement = workflow.placements.find((p) => p.stageId === stageId);
    const membership = { ...placement?.scopeMembership, [scopeId]: next };
    try {
      await workflowsService.updatePlacement(workflowId, stageId, { scopeMembership: membership });
      await load();
    } catch (e) {
      fail(e);
    }
  };

  if (loading) {
    return <div className="max-w-4xl mx-auto p-6 text-sm text-muted-foreground">Loading…</div>;
  }
  if (!workflow) {
    return (
      <div className="max-w-4xl mx-auto p-6 text-sm text-destructive">{error ?? 'Not found'}</div>
    );
  }

  const placedStageIds = new Set(workflow.placements.map((p) => p.stageId));
  const unplacedStages = stageLib.filter((s) => !placedStageIds.has(s.id));

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-4xl mx-auto p-6 space-y-6">
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
          <div className="bg-emerald-500/10 border border-emerald-500/20 text-emerald-700 dark:text-emerald-400 px-4 py-3 rounded-md flex items-start gap-2 text-sm">
            <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
            <span>{success}</span>
          </div>
        )}

        {/* Objective / META */}
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

        {/* Phase tree */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Phase tree</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Your own phases, defined inline. Order and nesting follow the path (e.g. 01, 01.02).
            </p>
            {workflow.phases.length === 0 ? (
              <p className="text-sm text-muted-foreground">No phases yet.</p>
            ) : (
              <ul className="space-y-1">
                {workflow.phases.map((p) => (
                  <li
                    key={p.path}
                    className="flex items-center gap-2 text-sm"
                    style={{ paddingLeft: `${(p.path.split('.').length - 1) * 20}px` }}
                  >
                    <span className="font-mono text-[11px] text-muted-foreground w-12">
                      {p.path}
                    </span>
                    <span className="font-medium">{p.name}</span>
                    <Badge variant="outline" className="h-4 px-1.5 text-[9px]">
                      {p.kind}
                    </Badge>
                    {!readOnly && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 ml-auto"
                        onClick={() => removePhase(p.path)}
                      >
                        <Trash2 className="h-3 w-3 text-destructive" />
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {!readOnly && (
              <Button variant="outline" size="sm" className="gap-1.5" onClick={addPhase}>
                <Plus className="h-3.5 w-3.5" />
                Add phase
              </Button>
            )}
          </CardContent>
        </Card>

        {/* Placements */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Stage placements</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Reference library stages into this workflow and home each under a phase.
            </p>
            {workflow.placements.length === 0 ? (
              <p className="text-sm text-muted-foreground">No stages placed yet.</p>
            ) : (
              <ul className="space-y-2">
                {workflow.placements.map((p) => (
                  <li key={p.stageId} className="flex items-center gap-2 text-sm">
                    <span className="font-medium min-w-0 truncate">{p.stageId}</span>
                    <select
                      value={p.phasePath ?? ''}
                      onChange={(e) => setPlacementPhase(p.stageId, e.target.value)}
                      disabled={readOnly}
                      className="h-8 rounded-md border bg-background px-2 text-xs ml-auto"
                    >
                      <option value="">— no phase —</option>
                      {workflow.phases.map((ph) => (
                        <option key={ph.path} value={ph.path}>
                          {ph.path} {ph.name}
                        </option>
                      ))}
                    </select>
                    {!readOnly && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6"
                        onClick={() => removePlacement(p.stageId)}
                      >
                        <Trash2 className="h-3 w-3 text-destructive" />
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {!readOnly && unplacedStages.length > 0 && (
              <AddPicker
                placeholder="Place a stage…"
                options={unplacedStages.map((s) => ({ id: s.id, label: s.name }))}
                onAdd={addPlacement}
              />
            )}
          </CardContent>
        </Card>

        {/* Derived views: autonomy, scope × stage matrix, validation */}
        <WorkflowInsights
          workflow={workflow}
          scopeLib={scopeLib}
          compiled={compiled}
          readOnly={readOnly}
          onAddScope={addScope}
          onRemoveScope={removeScope}
          onToggleCell={toggleCell}
        />
      </div>
    </div>
  );
}

interface PickerProps {
  placeholder: string;
  options: { id: string; label: string }[];
  onAdd: (id: string) => void;
}

// A select + Add button: pick a library block, click to reference it.
function AddPicker({ placeholder, options, onAdd }: PickerProps) {
  const [selected, setSelected] = useState('');
  return (
    <div className="flex items-center gap-2 pt-1">
      <select
        value={selected}
        onChange={(e) => setSelected(e.target.value)}
        className="h-9 rounded-md border bg-background px-3 text-sm flex-1"
      >
        <option value="">{placeholder}</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
      <Button
        size="sm"
        variant="outline"
        className="gap-1.5"
        disabled={!selected}
        onClick={() => {
          if (selected) {
            onAdd(selected);
            setSelected('');
          }
        }}
      >
        <Plus className="h-3.5 w-3.5" />
        Add
      </Button>
    </div>
  );
}
