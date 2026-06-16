import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { workflowsService, type Workflow, type GroupingNodeInput } from '@/services/workflows';
import { blocksService, type Block } from '@/services/blocks';
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
  const [skillLib, setSkillLib] = useState<Block[]>([]);
  const [groupingLib, setGroupingLib] = useState<Block[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const readOnly = workflow?.readOnly ?? false;

  const load = useCallback(async () => {
    if (!workflowId) return;
    setLoading(true);
    try {
      const [wf, skills, groupings] = await Promise.all([
        workflowsService.get(workflowId),
        blocksService.list('skill'),
        blocksService.list('grouping'),
      ]);
      setWorkflow(wf);
      setSkillLib(skills.blocks);
      setGroupingLib(groupings.blocks);
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

  // ── Groupings (whole-tree replace) ──
  const replaceGroupings = async (nodes: GroupingNodeInput[]) => {
    if (!workflowId) return;
    try {
      const updated = await workflowsService.putGroupings(workflowId, nodes);
      setWorkflow(updated);
      flash('Grouping tree updated.');
    } catch (e) {
      fail(e);
    }
  };

  const addGrouping = (groupingId: string) => {
    if (!workflow) return;
    // Append as a new top-level node with the next two-digit order.
    const topPaths = workflow.groupings.filter((g) => !g.path.includes('.')).map((g) => g.path);
    const nextOrder = topPaths.length + 1;
    const path = String(nextOrder).padStart(2, '0');
    const lib = groupingLib.find((g) => g.id === groupingId);
    const nodes: GroupingNodeInput[] = [
      ...workflow.groupings.map((g) => ({
        groupingId: g.groupingId,
        path: g.path,
        kind: g.kind,
        groupingTenant: g.groupingTenant,
      })),
      { groupingId, path, kind: (lib?.kind as string) ?? 'phase' },
    ];
    replaceGroupings(nodes);
  };

  const removeGrouping = (path: string) => {
    if (!workflow) return;
    // Drop the node and any descendants (paths nested under it).
    const nodes: GroupingNodeInput[] = workflow.groupings
      .filter((g) => g.path !== path && !g.path.startsWith(`${path}.`))
      .map((g) => ({ groupingId: g.groupingId, path: g.path, kind: g.kind }));
    replaceGroupings(nodes);
  };

  // ── Placements ──
  const addPlacement = async (skillId: string) => {
    if (!workflowId) return;
    try {
      await workflowsService.addPlacement(workflowId, { skillId });
      await load();
      flash('Skill placed.');
    } catch (e) {
      fail(e);
    }
  };

  const setPlacementGrouping = async (skillId: string, groupingPath: string) => {
    if (!workflowId) return;
    try {
      await workflowsService.updatePlacement(workflowId, skillId, {
        groupingPath: groupingPath || null,
      });
      await load();
    } catch (e) {
      fail(e);
    }
  };

  const removePlacement = async (skillId: string) => {
    if (!workflowId) return;
    try {
      await workflowsService.removePlacement(workflowId, skillId);
      await load();
      flash('Placement removed.');
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

  const placedSkillIds = new Set(workflow.placements.map((p) => p.skillId));
  const unplacedSkills = skillLib.filter((s) => !placedSkillIds.has(s.id));
  const placedGroupingIds = new Set(workflow.groupings.map((g) => g.groupingId));
  const availableGroupings = groupingLib.filter((g) => !placedGroupingIds.has(g.id));

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

        {/* Grouping tree */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Grouping tree</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Your own phases/stages. Order and nesting follow the path (e.g. 01, 01.02).
            </p>
            {workflow.groupings.length === 0 ? (
              <p className="text-sm text-muted-foreground">No groupings yet.</p>
            ) : (
              <ul className="space-y-1">
                {workflow.groupings.map((g) => (
                  <li
                    key={g.path}
                    className="flex items-center gap-2 text-sm"
                    style={{ paddingLeft: `${(g.path.split('.').length - 1) * 20}px` }}
                  >
                    <span className="font-mono text-[11px] text-muted-foreground w-12">
                      {g.path}
                    </span>
                    <span className="font-medium">{g.groupingId}</span>
                    <Badge variant="outline" className="h-4 px-1.5 text-[9px]">
                      {g.kind}
                    </Badge>
                    {!readOnly && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 ml-auto"
                        onClick={() => removeGrouping(g.path)}
                      >
                        <Trash2 className="h-3 w-3 text-destructive" />
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {!readOnly && availableGroupings.length > 0 && (
              <AddPicker
                placeholder="Add a grouping…"
                options={availableGroupings.map((g) => ({ id: g.id, label: g.name }))}
                onAdd={addGrouping}
              />
            )}
          </CardContent>
        </Card>

        {/* Placements */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Skill placements</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Reference library skills into this workflow and home each under a grouping.
            </p>
            {workflow.placements.length === 0 ? (
              <p className="text-sm text-muted-foreground">No skills placed yet.</p>
            ) : (
              <ul className="space-y-2">
                {workflow.placements.map((p) => (
                  <li key={p.skillId} className="flex items-center gap-2 text-sm">
                    <span className="font-medium min-w-0 truncate">{p.skillId}</span>
                    <select
                      value={p.groupingPath ?? ''}
                      onChange={(e) => setPlacementGrouping(p.skillId, e.target.value)}
                      disabled={readOnly}
                      className="h-8 rounded-md border bg-background px-2 text-xs ml-auto"
                    >
                      <option value="">— no grouping —</option>
                      {workflow.groupings.map((g) => (
                        <option key={g.path} value={g.path}>
                          {g.path} {g.groupingId}
                        </option>
                      ))}
                    </select>
                    {!readOnly && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6"
                        onClick={() => removePlacement(p.skillId)}
                      >
                        <Trash2 className="h-3 w-3 text-destructive" />
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {!readOnly && unplacedSkills.length > 0 && (
              <AddPicker
                placeholder="Place a skill…"
                options={unplacedSkills.map((s) => ({ id: s.id, label: s.name }))}
                onAdd={addPlacement}
              />
            )}
          </CardContent>
        </Card>
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
