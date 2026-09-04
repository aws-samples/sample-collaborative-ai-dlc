import { useEffect, useId, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Plus, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { Block } from '@/services/blocks';
import type { ExecutionPreview, Workflow } from '@/services/workflows';
import { displayPhasePathForPlacement, visibleWorkflowPhases } from './phaseDisplay';

interface ScopeBuilderProps {
  workflow: Workflow;
  scopeLib: Block[];
  stagesById: Record<string, Block>;
  activeScope: string | null;
  readOnly: boolean;
  preview: ExecutionPreview | null;
  onSelectScope: (scopeId: string) => void;
  onRemoveScope: (scopeId: string) => void;
  onSaveScope: (input: {
    scopeId: string;
    name: string;
    stageIds: string[];
    createBlock: boolean;
    setDefault: boolean;
  }) => Promise<void>;
}

const slugify = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');

const stageProduces = (stage: Block | undefined) =>
  Array.isArray(stage?.produces) ? (stage.produces as string[]) : [];

const stageConsumes = (stage: Block | undefined) =>
  Array.isArray(stage?.consumes)
    ? (stage.consumes as unknown[]).map((item) =>
        typeof item === 'object' && item && 'artifact' in item
          ? String((item as { artifact: unknown }).artifact)
          : String(item),
      )
    : [];

export function ScopeBuilder({
  workflow,
  scopeLib,
  stagesById,
  activeScope,
  readOnly,
  preview,
  onSelectScope,
  onRemoveScope,
  onSaveScope,
}: ScopeBuilderProps) {
  const [mode, setMode] = useState<'edit' | 'new'>('edit');
  const [scopeName, setScopeName] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [setDefault, setSetDefault] = useState(false);
  const [saving, setSaving] = useState(false);
  const scopeNameId = useId();
  const scopeIdId = useId();

  const scopeIds = workflow.scopeRefs.map((scope) => scope.scopeId);
  const selectedScope = activeScope && scopeIds.includes(activeScope) ? activeScope : null;
  const scopeBlock = scopeLib.find((scope) => scope.id === selectedScope);
  const editingScopeId = mode === 'new' ? slugify(scopeName) : selectedScope;
  const createBlock = Boolean(
    mode === 'new' && editingScopeId && !scopeLib.some((scope) => scope.id === editingScopeId),
  );

  useEffect(() => {
    if (mode === 'new') {
      setSelected(new Set());
      setSetDefault(scopeIds.length === 0);
      return;
    }
    if (!selectedScope) {
      setSelected(new Set());
      return;
    }
    setScopeName(scopeBlock?.name ?? selectedScope);
    setSetDefault(workflow.defaultScope === selectedScope);
    setSelected(
      new Set(
        workflow.placements
          .filter((placement) => placement.scopeMembership?.[selectedScope] === 'EXECUTE')
          .map((placement) => placement.stageId),
      ),
    );
  }, [
    mode,
    scopeBlock?.name,
    scopeIds.length,
    selectedScope,
    workflow.defaultScope,
    workflow.placements,
  ]);

  const phaseGroups = useMemo(() => {
    const visiblePhases = visibleWorkflowPhases(workflow.phases);
    const groups = visiblePhases.map((phase) => ({
      key: phase.path,
      name: phase.name,
      placements: workflow.placements
        .filter(
          (placement) =>
            displayPhasePathForPlacement(placement, workflow.phases, stagesById) === phase.path,
        )
        .filter((placement) => stagesById[placement.stageId]?.phase !== 'initialization')
        .toSorted((a, b) => a.order - b.order),
    }));
    const unphased = workflow.placements
      .filter((placement) => !displayPhasePathForPlacement(placement, workflow.phases, stagesById))
      .filter((placement) => stagesById[placement.stageId]?.phase !== 'initialization')
      .toSorted((a, b) => a.order - b.order);
    if (unphased.length > 0)
      groups.push({ key: '__unphased__', name: 'Unphased', placements: unphased });
    return groups;
  }, [stagesById, workflow.phases, workflow.placements]);

  const allVisibleStageIds = phaseGroups.flatMap((group) =>
    group.placements.map((placement) => placement.stageId),
  );

  const missingProducerWarnings = useMemo(() => {
    const producerByArtifact = new Map<string, string[]>();
    for (const placement of workflow.placements) {
      for (const artifact of stageProduces(stagesById[placement.stageId])) {
        producerByArtifact.set(artifact, [
          ...(producerByArtifact.get(artifact) ?? []),
          placement.stageId,
        ]);
      }
    }
    const warnings: string[] = [];
    for (const stageId of selected) {
      for (const artifact of stageConsumes(stagesById[stageId])) {
        const producers = producerByArtifact.get(artifact) ?? [];
        if (producers.length > 0 && !producers.some((producer) => selected.has(producer))) {
          warnings.push(`${stageId} consumes ${artifact} outside this scope`);
        }
      }
    }
    return warnings;
  }, [selected, stagesById, workflow.placements]);

  const unwiredStages = workflow.placements.filter(
    (placement) =>
      !Object.values(placement.scopeMembership ?? {}).some((value) => value === 'EXECUTE'),
  );
  const previewIssues = [...(preview?.errors ?? []), ...(preview?.warnings ?? [])];

  const toggleStage = (stageId: string, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(stageId);
      else next.delete(stageId);
      return next;
    });
  };

  const togglePhase = (stageIds: string[], checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const stageId of stageIds) {
        if (checked) next.add(stageId);
        else next.delete(stageId);
      }
      return next;
    });
  };

  const save = async () => {
    if (!editingScopeId || readOnly) return;
    setSaving(true);
    try {
      await onSaveScope({
        scopeId: editingScopeId,
        name: scopeName.trim() || editingScopeId,
        stageIds: [...selected],
        createBlock,
        setDefault,
      });
      setMode('edit');
      onSelectScope(editingScopeId);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
      <div className="rounded-md border bg-background p-3">
        <div className="mb-3 flex items-center gap-2">
          <h2 className="text-sm font-semibold">Scopes</h2>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="ml-auto h-7 gap-1 text-xs"
            onClick={() => {
              setMode('new');
              setScopeName('');
              setSelected(new Set());
            }}
            disabled={readOnly}
          >
            <Plus className="h-3 w-3" />
            New
          </Button>
        </div>
        <div className="space-y-1">
          {scopeIds.map((scopeId) => (
            <div key={scopeId} className="flex items-center gap-1">
              <Button
                type="button"
                variant={mode === 'edit' && scopeId === selectedScope ? 'secondary' : 'ghost'}
                size="sm"
                className="h-8 min-w-0 flex-1 justify-start truncate text-xs"
                onClick={() => {
                  setMode('edit');
                  onSelectScope(scopeId);
                }}
              >
                {scopeLib.find((scope) => scope.id === scopeId)?.name ?? scopeId}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-muted-foreground hover:text-destructive"
                onClick={() => onRemoveScope(scopeId)}
                disabled={readOnly}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
          {scopeIds.length === 0 && (
            <p className="px-1 py-3 text-xs text-muted-foreground">No workflow scopes yet.</p>
          )}
        </div>
      </div>

      <div className="rounded-md border bg-background">
        <div className="border-b p-3">
          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_12rem]">
            <div className="grid gap-2">
              <Label htmlFor={scopeNameId}>Scope name</Label>
              <Input
                id={scopeNameId}
                value={scopeName}
                onChange={(event) => setScopeName(event.target.value)}
                disabled={readOnly || mode === 'edit'}
                placeholder="Minimum viable product"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor={scopeIdId}>Scope id</Label>
              <Input id={scopeIdId} value={editingScopeId ?? ''} readOnly disabled />
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
            <Badge variant="secondary">
              {selected.size} of {allVisibleStageIds.length} stages
            </Badge>
            <Badge variant={setDefault ? 'default' : 'outline'}>
              {setDefault ? 'Default scope' : 'Not default'}
            </Badge>
            {createBlock && <Badge variant="outline">Creates scope block</Badge>}
            {preview?.valid === true && <Badge variant="outline">Preview valid</Badge>}
            {preview?.valid === false && <Badge variant="destructive">Preview blocked</Badge>}
            <label className="ml-auto inline-flex items-center gap-2">
              <input
                type="checkbox"
                checked={setDefault}
                onChange={(event) => setSetDefault(event.target.checked)}
                disabled={readOnly}
              />
              Default
            </label>
          </div>
        </div>

        <div className="grid gap-4 p-3 xl:grid-cols-[minmax(0,1fr)_18rem]">
          <div className="space-y-3">
            {phaseGroups.map((group) => {
              const stageIds = group.placements.map((placement) => placement.stageId);
              const selectedCount = stageIds.filter((stageId) => selected.has(stageId)).length;
              const checked = selectedCount === stageIds.length && stageIds.length > 0;
              return (
                <section key={group.key} className="rounded-md border">
                  <div className="flex items-center gap-3 border-b bg-muted/30 px-3 py-2">
                    <label className="flex items-center gap-2 text-sm font-medium">
                      <input
                        type="checkbox"
                        checked={checked}
                        ref={(node) => {
                          if (node) node.indeterminate = selectedCount > 0 && !checked;
                        }}
                        onChange={(event) => togglePhase(stageIds, event.target.checked)}
                        disabled={readOnly}
                      />
                      {group.name}
                    </label>
                    <span className="ml-auto text-xs text-muted-foreground">
                      {selectedCount}/{stageIds.length}
                    </span>
                  </div>
                  <div className="divide-y">
                    {group.placements.map((placement) => {
                      const stage = stagesById[placement.stageId];
                      const isBranch = stage?.forEach === 'unit-of-work';
                      return (
                        <label
                          key={placement.stageId}
                          className="flex items-center gap-3 px-3 py-2 text-sm"
                        >
                          <input
                            type="checkbox"
                            checked={selected.has(placement.stageId)}
                            onChange={(event) =>
                              toggleStage(placement.stageId, event.target.checked)
                            }
                            disabled={readOnly}
                          />
                          <span className="min-w-0 flex-1 truncate">
                            {stage?.name ?? placement.stageId}
                          </span>
                          {isBranch && <Badge variant="outline">unit branch</Badge>}
                        </label>
                      );
                    })}
                  </div>
                </section>
              );
            })}
          </div>

          <aside className="space-y-3 rounded-md border bg-muted/20 p-3">
            <h3 className="text-sm font-semibold">Coverage</h3>
            {missingProducerWarnings.length === 0 &&
            previewIssues.length === 0 &&
            unwiredStages.length === 0 ? (
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <CheckCircle2 className="h-3.5 w-3.5 text-agent-success" />
                No coverage warnings.
              </p>
            ) : (
              <div className="space-y-2">
                {missingProducerWarnings.map((warning) => (
                  <WarningLine key={warning}>{warning}</WarningLine>
                ))}
                {previewIssues.slice(0, 6).map((issue, index) => (
                  <WarningLine key={`${issue.code}-${index}`}>{issue.message}</WarningLine>
                ))}
                {unwiredStages.slice(0, 4).map((placement) => (
                  <WarningLine key={placement.stageId}>
                    {placement.stageId} is not wired to any scope.
                  </WarningLine>
                ))}
              </div>
            )}
            <Button
              type="button"
              size="sm"
              className="w-full"
              onClick={save}
              disabled={readOnly || !editingScopeId || saving}
            >
              {saving ? 'Saving...' : mode === 'new' ? 'Create scope' : 'Save membership'}
            </Button>
          </aside>
        </div>
      </div>
    </div>
  );
}

function WarningLine({ children }: { children: ReactNode }) {
  return (
    <p className="flex gap-2 text-xs text-amber-700 dark:text-amber-500">
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}
