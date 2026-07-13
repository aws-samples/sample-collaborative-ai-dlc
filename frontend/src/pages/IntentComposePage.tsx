import { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { useProjectCache } from '@/hooks/useProjectsCache';
import { useCollaborativeIntentDraft } from '@/hooks/useCollaborativeIntentDraft';
import { intentsService, type Intent } from '@/services/intents';
import { workflowsService } from '@/services/workflows';
import { agentsService } from '@/services/agents';
import { CollaborativeTextarea } from '@/components/CollaborativeTextarea';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { AlertCircle, ArrowLeft, Loader2, Users, X } from 'lucide-react';

type ScopeSummary = {
  executedStages: number;
  totalStages: number;
  approvalGates: number;
  perUnitStages: number;
  skippedStages: number;
  outOfScopeStages: number;
};

// The compose step of a DRAFT intent: the shared prompt, the projection
// (scope or composed grid) and the per-intent stage deselection are edited
// COLLABORATIVELY (Yjs doc `intent-draft-{intentId}`; debounced PATCH persists
// to the intent row, which is what Start launches from).
export default function IntentComposePage() {
  const navigate = useNavigate();
  const { projectId, intentId } = useParams<{ projectId: string; intentId: string }>();
  const { user } = useAuth();
  const userName = user?.displayName || user?.email || '';
  const { project, loading: projectLoading } = useProjectCache(projectId ?? null);

  const [intent, setIntent] = useState<Intent | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const draft = useCollaborativeIntentDraft(projectId ?? '', intentId ?? null, userName);
  const { initFromIntent } = draft;

  // Load the intent; non-DRAFT intents have left the compose step — show them
  // in the regular intent view instead.
  useEffect(() => {
    if (!projectId || !intentId) return;
    let cancelled = false;
    intentsService
      .get(projectId, intentId)
      .then((detail) => {
        if (cancelled) return;
        if (detail.intent.status !== 'DRAFT') {
          navigate(`/project/${projectId}/intent/${intentId}`, { replace: true });
          return;
        }
        setIntent(detail.intent);
      })
      .catch((e) => {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : 'Failed to load intent');
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, intentId, navigate]);

  // Seed the CRDT from the persisted row once synced (no-op if peers already
  // populated it).
  useEffect(() => {
    if (intent && draft.synced) initFromIntent(intent);
  }, [intent, draft.synced, initFromIntent]);

  const workflowId = project ? (project.workflowId ?? 'aidlc-v2') : null;
  const workflowVersion = project?.workflowVersion ?? undefined;

  // Scope options from the compiled grid.
  const [scopeOptions, setScopeOptions] = useState<string[]>([]);
  useEffect(() => {
    if (!workflowId) return;
    let cancelled = false;
    workflowsService
      .compiled(workflowId, workflowVersion)
      .then((compiled) => {
        if (!cancelled) setScopeOptions(Object.keys(compiled.scopeGrid ?? {}));
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load scopes');
      });
    return () => {
      cancelled = true;
    };
  }, [workflowId, workflowVersion]);

  // Effective stage-skipping mode (project override, else platform setting).
  const [skippingEnabled, setSkippingEnabled] = useState(false);
  useEffect(() => {
    if (!project) return;
    const override = project.stageSkipping;
    if (override === 'enabled' || override === 'disabled') {
      setSkippingEnabled(override === 'enabled');
      return;
    }
    let cancelled = false;
    agentsService
      .getSettings()
      .then((s) => {
        if (!cancelled) setSkippingEnabled(s.stageSkipping === 'enabled');
      })
      .catch(() => {
        if (!cancelled) setSkippingEnabled(false);
      });
    return () => {
      cancelled = true;
    };
  }, [project]);

  const scope = draft.scope ?? intent?.scope ?? null;
  const skipSelections = useMemo(() => new Set(draft.skipStageIds ?? []), [draft.skipStageIds]);

  // Run-shape preview: authoritative counts + skippable stages for the current
  // selection, re-fetched whenever the shared selection changes (keyed on the
  // serialized selection so a peer's grid/skip edit re-previews too).
  const [summary, setSummary] = useState<ScopeSummary | null>(null);
  const [skippableStages, setSkippableStages] = useState<
    { stageId: string; phase: string | null }[]
  >([]);
  const [previewNote, setPreviewNote] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const gridKey = JSON.stringify(draft.composedGrid ?? null);
  const skipsKey = JSON.stringify([...skipSelections].toSorted());
  useEffect(() => {
    if (!workflowId || !scope) return;
    let cancelled = false;
    setPreviewLoading(true);
    const skips = [...skipSelections];
    const request = draft.composedGrid
      ? workflowsService.validateGrid(workflowId, {
          composedGrid: draft.composedGrid,
          scope,
          skipStageIds: skips.length ? skips : undefined,
          version: workflowVersion,
        })
      : workflowsService.executionPreview(
          workflowId,
          scope,
          workflowVersion,
          skips.length ? skips : undefined,
        );
    request
      .then((preview) => {
        if (cancelled) return;
        setSummary(preview.plan?.summary ?? null);
        const stages = (preview.plan?.stages ?? [])
          .filter((s) => s.execution === 'CONDITIONAL' && s.phase !== 'initialization')
          .map((s) => ({ stageId: s.stageId, phase: s.phase ?? null }));
        setSkippableStages(skippingEnabled ? stages : []);
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
        if (!cancelled) {
          setSummary(null);
          setSkippableStages([]);
          setPreviewNote(null);
        }
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the serialized selection
  }, [workflowId, workflowVersion, scope, skippingEnabled, gridKey, skipsKey]);

  const toggleSkip = (stageId: string) => {
    const next = new Set(skipSelections);
    if (next.has(stageId)) next.delete(stageId);
    else next.add(stageId);
    draft.setSkipStageIds(next.size ? [...next] : null);
  };

  const handleStart = async () => {
    if (!projectId || !intentId) return;
    setStarting(true);
    setError(null);
    try {
      // Persist the last shared edits BEFORE launching — Start reads the
      // intent row, not the Yjs doc.
      await draft.flushDraft();
      await intentsService.start(projectId, intentId);
      navigate(`/project/${projectId}/intent/${intentId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start intent');
    } finally {
      setStarting(false);
    }
  };

  if (projectLoading || (!intent && !loadError)) {
    return (
      <div className="mx-auto w-full max-w-5xl px-6 py-6 space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-[400px] rounded-lg" />
      </div>
    );
  }

  if (!project || loadError) {
    return (
      <div className="mx-auto w-full max-w-5xl px-6 py-6 text-sm text-destructive">
        {loadError ?? 'Project not found'}
      </div>
    );
  }

  const remoteCount = draft.remoteUsers.size;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl px-6 py-6 space-y-6">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5"
            onClick={() => navigate(`/project/${projectId}`)}
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back
          </Button>
          <div className="h-5 w-px bg-border" />
          <h1 className="text-xl font-semibold tracking-tight">Compose Intent</h1>
          {remoteCount > 0 && (
            <span
              className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground"
              data-testid="draft-collaborators"
            >
              <Users className="h-3.5 w-3.5" />
              {remoteCount} other{remoteCount === 1 ? '' : 's'} editing
            </span>
          )}
        </div>

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

        <div className="space-y-4">
          <div>
            <Label htmlFor="draft-title">Title</Label>
            <Input
              id="draft-title"
              value={draft.title}
              onChange={(e) => draft.setTitle(e.target.value, e.target.selectionStart ?? undefined)}
              placeholder="e.g. Add user authentication"
              className="mt-1.5"
            />
          </div>

          <div>
            <Label htmlFor="draft-prompt">Prompt</Label>
            <CollaborativeTextarea
              id="draft-prompt"
              value={draft.prompt}
              onChange={(text, cursorPos) => draft.setPrompt(text, cursorPos)}
              onCursorChange={(index, length) => draft.setCursor(index, length)}
              remoteUsers={draft.remoteUsers}
              rows={10}
              placeholder="Describe the intent in detail…"
              className="mt-1.5 rounded-md border bg-background px-3 py-2 text-sm"
            />
          </div>

          <div>
            <Label htmlFor="draft-scope">Scope</Label>
            <Select
              value={scope ?? ''}
              onValueChange={(v) => {
                if (v) {
                  draft.setScope(v);
                  // Picking a stock scope leaves any composed grid behind.
                  draft.setComposedGrid(null);
                }
              }}
              disabled={scopeOptions.length === 0}
            >
              <SelectTrigger id="draft-scope" className="mt-1.5">
                <SelectValue placeholder="Select a scope" />
              </SelectTrigger>
              <SelectContent>
                {scopeOptions.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {draft.composedGrid && (
              <p className="mt-1.5 text-xs text-muted-foreground" data-testid="composed-note">
                Using a composed stage grid ({scope}). Picking a scope above discards it.
              </p>
            )}
            {scope && summary && (
              <p className="mt-1 text-xs text-foreground" data-testid="scope-summary">
                {(() => {
                  const parts = [
                    `Runs ${summary.executedStages} of ${summary.totalStages} stages`,
                    `${summary.approvalGates} approval gate${summary.approvalGates === 1 ? '' : 's'}`,
                  ];
                  if (summary.perUnitStages > 0) {
                    parts.push(
                      `${summary.perUnitStages} stage${summary.perUnitStages === 1 ? '' : 's'} fan${summary.perUnitStages === 1 ? 's' : ''} out per unit of work`,
                    );
                  }
                  if (summary.skippedStages > 0) parts.push(`${summary.skippedStages} deselected`);
                  return parts.join(' · ');
                })()}
              </p>
            )}
          </div>

          {skippingEnabled && (previewLoading || skippableStages.length > 0) && (
            <div className="border rounded-md p-3 space-y-2">
              <Label className="text-sm font-medium">
                Skip stages{' '}
                <span className="text-xs text-muted-foreground font-normal">
                  (optional — {skipSelections.size ? `${skipSelections.size} skipped` : 'runs all'})
                </span>
              </Label>
              <p className="text-xs text-muted-foreground">
                Deselect CONDITIONAL stages this intent should skip. Required stages always run;
                downstream stages treat a skipped stage's outputs as absent by design.
              </p>
              {previewLoading && skippableStages.length === 0 ? (
                <div className="grid gap-1.5 sm:grid-cols-2">
                  {[0, 1, 2, 3].map((i) => (
                    <Skeleton key={i} className="h-8 rounded-md" />
                  ))}
                </div>
              ) : (
                <div className="grid gap-1.5 sm:grid-cols-2">
                  {skippableStages.map((s) => (
                    <label
                      key={s.stageId}
                      className="flex items-center gap-2 text-sm rounded-md border px-2.5 py-1.5 cursor-pointer hover:bg-muted/50"
                    >
                      <input
                        type="checkbox"
                        checked={skipSelections.has(s.stageId)}
                        onChange={() => toggleSkip(s.stageId)}
                        className="h-3.5 w-3.5"
                      />
                      <span
                        className={
                          skipSelections.has(s.stageId) ? 'line-through text-muted-foreground' : ''
                        }
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
              )}
              {previewNote && (
                <p className="flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-500">
                  <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                  {previewNote}
                </p>
              )}
            </div>
          )}

          <div className="flex items-center gap-3 pt-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => navigate(`/project/${projectId}`)}
              disabled={starting}
            >
              Close
            </Button>
            <Button
              type="button"
              onClick={handleStart}
              disabled={starting || !draft.prompt.trim() || !scope}
              data-testid="start-intent"
            >
              {starting && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />}
              {starting ? 'Starting…' : 'Start Intent'}
            </Button>
            {!draft.synced && (
              <span className="text-xs text-muted-foreground">connecting live session…</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
