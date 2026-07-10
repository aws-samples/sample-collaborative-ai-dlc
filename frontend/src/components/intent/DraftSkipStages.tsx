// DRAFT-screen stage deselection (shared/stage-skip.js) — the last chance to
// (de)select CONDITIONAL stages before Start. Renders only when the intent's
// snapshotted stageSkipping mode is 'enabled' (the effective platform/project
// value was frozen at create, so no settings fetch is needed here).
//
// Selection semantics: the section initializes from the create-time
// `skipStageIds` snapshot; the parent receives the FULL replacement list on
// every user toggle and sends it with POST /start (an untouched section sends
// nothing, keeping the create snapshot; the backend re-validates either way).

import { useEffect, useState } from 'react';
import { AlertCircle, ChevronDown, ChevronRight } from 'lucide-react';
import { workflowsService } from '@/services/workflows';
import type { Intent } from '@/services/intents';

interface Props {
  intent: Intent;
  disabled?: boolean;
  onChange: (skipStageIds: string[]) => void;
}

export function DraftSkipStages({ intent, disabled, onChange }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [skippableStages, setSkippableStages] = useState<
    { stageId: string; phase: string | null }[]
  >([]);
  const [selection, setSelection] = useState<Set<string>>(() => new Set(intent.skipStageIds ?? []));
  const [previewNote, setPreviewNote] = useState<string | null>(null);

  const enabled = intent.stageSkipping === 'enabled';
  const workflowId = intent.workflowId;
  const scope = intent.scope;
  const version = intent.workflowVersion ?? undefined;

  // The scope's skippable stages (CONDITIONAL, non-initialization) from the
  // pinned plan preview. Best-effort: a failed fetch just hides the section.
  useEffect(() => {
    if (!enabled || !workflowId || !scope) return;
    let cancelled = false;
    workflowsService
      .executionPreview(workflowId, scope, version)
      .then((preview) => {
        if (cancelled) return;
        // The plain preview (no skip param) lists every in-scope stage — the
        // create-time overlay lives on the intent, not the workflow — so
        // stages skipped at create are here too and render as checked.
        const inPlan = (preview.plan?.stages ?? [])
          .filter((s) => s.execution === 'CONDITIONAL' && s.phase !== 'initialization')
          .map((s) => ({ stageId: s.stageId, phase: s.phase ?? null }));
        setSkippableStages(inPlan);
      })
      .catch(() => {
        if (!cancelled) setSkippableStages([]);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, workflowId, scope, version]);

  // Dry-run the current selection so the degradation is visible before Start.
  useEffect(() => {
    if (!enabled || !workflowId || !scope || selection.size === 0) {
      setPreviewNote(null);
      return;
    }
    let cancelled = false;
    workflowsService
      .executionPreview(workflowId, scope, version, [...selection])
      .then((preview) => {
        if (cancelled) return;
        const absent = (preview.warnings ?? []).filter(
          (w) => w.code === 'scope_absent_consume',
        ).length;
        const degraded = (preview.warnings ?? []).some((w) => w.code === 'scope_absent_unit_dag');
        const parts: string[] = [];
        if (absent > 0)
          parts.push(`${absent} downstream input${absent === 1 ? '' : 's'} will be absent`);
        if (degraded) parts.push('parallel construction degrades to a single lane');
        setPreviewNote(parts.length ? parts.join('; ') + '.' : null);
      })
      .catch(() => {
        if (!cancelled) setPreviewNote(null);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, workflowId, scope, version, selection]);

  if (!enabled || !skippableStages.length) return null;

  const toggle = (stageId: string) => {
    setSelection((prev) => {
      const next = new Set(prev);
      if (next.has(stageId)) next.delete(stageId);
      else next.add(stageId);
      onChange([...next]);
      return next;
    });
  };

  return (
    <div className="border rounded-md">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-1.5 px-3 py-2 text-sm font-medium"
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5" />
        )}
        Skip stages
        <span className="text-xs text-muted-foreground font-normal">
          ({selection.size ? `${selection.size} skipped` : 'runs all'})
        </span>
      </button>
      {expanded && (
        <div className="px-3 pb-3 space-y-2">
          <p className="text-xs text-muted-foreground">
            Deselect CONDITIONAL stages this run should skip. Required stages always run; downstream
            stages treat a skipped stage's outputs as absent by design. Applied when you press
            Start.
          </p>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {skippableStages.map((s) => (
              <label
                key={s.stageId}
                className="flex items-center gap-2 text-sm rounded-md border px-2.5 py-1.5 cursor-pointer hover:bg-muted/50"
              >
                <input
                  type="checkbox"
                  checked={selection.has(s.stageId)}
                  onChange={() => toggle(s.stageId)}
                  disabled={disabled}
                  className="h-3.5 w-3.5"
                />
                <span
                  className={selection.has(s.stageId) ? 'line-through text-muted-foreground' : ''}
                >
                  {s.stageId}
                </span>
                {s.phase && (
                  <span className="ml-auto text-[10px] uppercase tracking-wide text-muted-foreground">
                    {s.phase}
                  </span>
                )}
              </label>
            ))}
          </div>
          {previewNote && (
            <p className="flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-500">
              <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              {previewNote}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
