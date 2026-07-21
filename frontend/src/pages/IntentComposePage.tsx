import { useState, useEffect, useMemo, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { useIntent } from '@/contexts/IntentContext';
import { useProjectCache } from '@/hooks/useProjectsCache';
import { useCollaborativeIntentDraft } from '@/hooks/useCollaborativeIntentDraft';
import {
  intentsService,
  type Intent,
  type ComposeSession,
  type IntentAttachment,
} from '@/services/intents';
import { workflowsService, type CompiledWorkflow, type PhaseNode } from '@/services/workflows';
import { CollaborativeTextarea } from '@/components/CollaborativeTextarea';
import { ComposePanel } from '@/components/intent/ComposePanel';
import { StageGridEditor } from '@/components/intent/StageGridEditor';
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
import {
  AlertCircle,
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Info,
  Loader2,
  MousePointerClick,
  Paperclip,
  Trash2,
  Users,
  X,
} from 'lucide-react';

type ScopeSummary = {
  executedStages: number;
  totalStages: number;
  approvalGates: number;
  perUnitStages: number;
  skippedStages: number;
  outOfScopeStages: number;
};

const ATTACHMENT_TYPES: Record<string, string> = {
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  html: 'text/html',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};
const attachmentType = (file: File) =>
  ATTACHMENT_TYPES[file.name.split('.').pop()?.toLowerCase() ?? ''];
const formatBytes = (bytes: number) =>
  `${(bytes / 1024 / 1024).toFixed(bytes >= 1024 * 1024 ? 1 : 2)} MB`;
const ATTACHMENT_INGEST_POLL_MS = 500;
const ATTACHMENT_INGEST_TIMEOUT_MS = 30_000;

// The compose step of a DRAFT intent: the shared prompt, the projection
// (scope or composed grid) and the per-intent stage deselection are edited
// COLLABORATIVELY (Yjs doc `intent-draft-{intentId}`; debounced PATCH persists
// to the intent row, which is what Start launches from).
export default function IntentComposePage() {
  const navigate = useNavigate();
  const { projectId, intentId } = useParams<{ projectId: string; intentId: string }>();
  const { user } = useAuth();
  const { reload } = useIntent();
  const userName = user?.displayName || user?.email || '';
  const { project, loading: projectLoading } = useProjectCache(projectId ?? null);

  const [intent, setIntent] = useState<Intent | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [attachments, setAttachments] = useState<IntentAttachment[]>([]);
  const [attachmentRevision, setAttachmentRevision] = useState(0);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [removingAttachmentId, setRemovingAttachmentId] = useState<string | null>(null);
  const attachmentInput = useRef<HTMLInputElement>(null);

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
          navigate(`/space/${projectId}/intent/${intentId}`, { replace: true });
          return;
        }
        setIntent(detail.intent);
        setAttachments(detail.intent.attachments ?? []);
        setAttachmentRevision(detail.intent.attachmentRevision ?? 0);
      })
      .catch((e) => {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : 'Failed to load intent');
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, intentId, navigate]);

  // Attachments intentionally stay out of the Yjs document. Periodic REST
  // refresh makes the durable set converge for collaborators even if a
  // websocket reload hint is missed while a browser is reconnecting.
  useEffect(() => {
    if (!projectId || !intentId || !intent) return;
    const refresh = () =>
      intentsService
        .attachments(projectId, intentId)
        .then((result) => {
          setAttachments(result.attachments);
          setAttachmentRevision(result.attachmentRevision);
        })
        .catch(() => {});
    const timer = window.setInterval(refresh, 15_000);
    return () => window.clearInterval(timer);
  }, [projectId, intentId, intent]);

  const uploadFile = (upload: { url: string; fields: Record<string, string> }, file: File) =>
    new Promise<void>((resolve, reject) => {
      const request = new XMLHttpRequest();
      request.open('POST', upload.url);
      request.upload.onprogress = (event) => {
        if (event.lengthComputable)
          setUploadProgress(Math.round((event.loaded / event.total) * 100));
      };
      request.onerror = () => reject(new Error(`Failed to upload ${file.name}`));
      request.onload = () =>
        request.status >= 200 && request.status < 300
          ? resolve()
          : reject(new Error(`Failed to upload ${file.name}`));
      const form = new FormData();
      for (const [name, value] of Object.entries(upload.fields)) form.append(name, value);
      form.append('file', file);
      request.send(form);
    });

  const handleAttachmentPick = async (files: FileList | null) => {
    if (!projectId || !intentId || !files?.length) return;
    setAttachmentError(null);
    const selected = [...files];
    if (attachments.length + selected.length > 5) {
      setAttachmentError('Attach up to five files.');
      return;
    }
    const invalid = selected.find(
      (file) => !attachmentType(file) || file.size < 1 || file.size > 5 * 1024 * 1024,
    );
    if (invalid) {
      setAttachmentError(`${invalid.name} is unsupported or larger than 5 MB.`);
      return;
    }
    if (
      attachments.reduce((sum, attachment) => sum + attachment.size, 0) +
        selected.reduce((sum, file) => sum + file.size, 0) >
      25 * 1024 * 1024
    ) {
      setAttachmentError('Attachments cannot exceed 25 MB in total.');
      return;
    }
    setUploadProgress(0);
    try {
      const descriptors = selected.map((file) => ({
        filename: file.name,
        mimeType: attachmentType(file),
        size: file.size,
      }));
      const { uploads } = await intentsService.attachmentUploadUrls(
        projectId,
        intentId,
        descriptors,
      );
      await Promise.all(uploads.map((upload, index) => uploadFile(upload, selected[index])));
      const expectedIds = new Set(uploads.map((upload) => upload.attachmentId));
      const deadline = Date.now() + ATTACHMENT_INGEST_TIMEOUT_MS;
      for (;;) {
        const refreshed = await intentsService.attachments(projectId, intentId);
        setAttachments(refreshed.attachments);
        setAttachmentRevision(refreshed.attachmentRevision);
        const committedIds = new Set(
          refreshed.attachments.map((attachment) => attachment.attachmentId),
        );
        if ([...expectedIds].every((attachmentId) => committedIds.has(attachmentId))) break;
        if (Date.now() >= deadline) {
          throw new Error('Upload is still being processed; refresh and retry.');
        }
        await new Promise<void>((resolve) => window.setTimeout(resolve, ATTACHMENT_INGEST_POLL_MS));
      }
      setUploadProgress(null);
    } catch (e) {
      setUploadProgress(null);
      setAttachmentError(e instanceof Error ? e.message : 'Failed to upload attachments');
    } finally {
      if (attachmentInput.current) attachmentInput.current.value = '';
    }
  };

  const removeAttachment = async (attachmentId: string) => {
    if (!projectId || !intentId) return;
    setAttachmentError(null);
    setRemovingAttachmentId(attachmentId);
    try {
      await intentsService.deleteAttachment(projectId, intentId, attachmentId, attachmentRevision);
      // DELETE currently returns no parsed body through the shared API helper;
      // reload the durable list to get the bumped optimistic-concurrency revision.
      const refreshed = await intentsService.attachments(projectId, intentId);
      setAttachments(refreshed.attachments);
      setAttachmentRevision(refreshed.attachmentRevision);
    } catch (e) {
      setAttachmentError(e instanceof Error ? e.message : 'Failed to remove attachment');
    } finally {
      setRemovingAttachmentId(null);
    }
  };

  // Seed the CRDT from the persisted row once synced (no-op if peers already
  // populated it).
  useEffect(() => {
    if (intent && draft.synced) initFromIntent(intent);
  }, [intent, draft.synced, initFromIntent]);

  const workflowId = project ? (project.workflowId ?? 'aidlc-v2') : null;
  const workflowVersion = project?.workflowVersion ?? undefined;

  // Compiled views: the scope grid (options + per-scope projections for the
  // grid editor's baseline) and the stage-node list (phase grouping); the
  // workflow's phase tree supplies the display names + which phase is
  // initialization (those stages are locked EXECUTE in the editor).
  const [compiled, setCompiled] = useState<CompiledWorkflow | null>(null);
  const [phases, setPhases] = useState<PhaseNode[]>([]);
  useEffect(() => {
    if (!workflowId) return;
    let cancelled = false;
    workflowsService
      .compiled(workflowId, workflowVersion)
      .then((c) => {
        if (!cancelled) setCompiled(c);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load scopes');
      });
    workflowsService
      .get(workflowId, workflowVersion)
      .then((wf) => {
        if (!cancelled) setPhases(wf.phases ?? []);
      })
      .catch(() => {
        /* phase names are display sugar — the editor degrades to raw paths */
      });
    return () => {
      cancelled = true;
    };
  }, [workflowId, workflowVersion]);
  const scopeOptions = useMemo(() => Object.keys(compiled?.scopeGrid ?? {}), [compiled]);

  const scope = draft.scope ?? intent?.scope ?? null;
  // Legacy deselections (the per-intent skip overlay, e.g. on drafts created
  // through the API): rendered as SKIP in the grid editor and ABSORBED into
  // the composed grid on the first edit — the grid is the ONLY stage-selection
  // surface on this page. The overlay itself remains a runtime mechanism
  // (gate-time "skip to stage X", rewind un-skip).
  const skipSelections = useMemo(() => new Set(draft.skipStageIds ?? []), [draft.skipStageIds]);

  // Grid editor plumbing: nodes/phase names from the compiled workflow; the
  // initialization phase's stages are locked EXECUTE (the resolver rejects
  // grids without them). The editor's effective grid is the composed grid, or
  // the selected scope's projection as a read-through baseline.
  const phaseNames = useMemo(
    () => Object.fromEntries(phases.map((p) => [p.path, p.name || p.phaseId])),
    [phases],
  );
  const initPhasePath = useMemo(
    () => phases.find((p) => p.phaseId === 'initialization')?.path ?? null,
    [phases],
  );
  const gridStages = useMemo(
    () =>
      (compiled?.graph.nodes ?? []).map((n) => ({
        stageId: n.stageId,
        phasePath: n.phasePath,
        order: n.order,
      })),
    [compiled],
  );
  const lockedStageIds = useMemo(
    () =>
      new Set(
        (compiled?.graph.nodes ?? [])
          .filter((n) => initPhasePath != null && n.phasePath === initPhasePath)
          .map((n) => n.stageId),
      ),
    [compiled, initPhasePath],
  );
  const scopeBaselineGrid = useMemo(
    () => (scope && compiled?.scopeGrid?.[scope]) || null,
    [scope, compiled],
  );
  // What the editor shows: the composed grid (or the scope's projection),
  // with any legacy deselections rendered as SKIP on top.
  const effectiveGrid = useMemo(() => {
    const base: Record<string, 'EXECUTE' | 'SKIP'> = {
      ...(draft.composedGrid ?? scopeBaselineGrid),
    };
    for (const id of skipSelections) base[id] = 'SKIP';
    return base;
  }, [draft.composedGrid, scopeBaselineGrid, skipSelections]);
  // The stage grid is a collapsible, optional refinement — collapsed by default
  // (the selected scope already fully describes the run).
  const [showGridEditor, setShowGridEditor] = useState(false);

  const toggleGridStage = (stageId: string) => {
    if (lockedStageIds.has(stageId)) return;
    // First customization materializes the scope's projection into a composed
    // grid (initialization pinned EXECUTE) so the flip has a total baseline.
    // Legacy deselections are folded into the grid at the same moment — after
    // this, the grid alone describes the run.
    const base: Record<string, 'EXECUTE' | 'SKIP'> = { ...effectiveGrid };
    for (const id of lockedStageIds) base[id] = 'EXECUTE';
    base[stageId] = base[stageId] === 'EXECUTE' ? 'SKIP' : 'EXECUTE';
    draft.setComposedGrid(base);
    if (skipSelections.size) draft.setSkipStageIds(null);
    if (!draft.composedGrid && scope) {
      // Label the customization after its origin so provenance stays readable.
      draft.setScope(`${scope}-custom`);
    }
  };

  const resetGridToScope = (nextScope: string) => {
    draft.setScope(nextScope);
    draft.setComposedGrid(null);
    draft.setSkipStageIds(null);
  };

  const applyProposal = (proposal: NonNullable<ComposeSession['proposal']>) => {
    if (proposal.mode === 'matched') {
      resetGridToScope(proposal.scope);
    } else if (proposal.grid) {
      draft.setScope(proposal.scope);
      draft.setComposedGrid(proposal.grid);
      setShowGridEditor(true);
    }
  };

  // Run-shape preview: authoritative counts for the current selection,
  // re-fetched whenever the shared selection changes (keyed on the serialized
  // selection so a peer's grid edit re-previews too).
  const [summary, setSummary] = useState<ScopeSummary | null>(null);
  const [previewNote, setPreviewNote] = useState<string | null>(null);
  const [previewErrors, setPreviewErrors] = useState<string[]>([]);
  const gridKey = JSON.stringify(draft.composedGrid ?? null);
  const skipsKey = JSON.stringify([...skipSelections].toSorted());
  useEffect(() => {
    if (!workflowId || !scope) return;
    let cancelled = false;
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
        setPreviewErrors(
          preview.valid ? [] : (preview.errors ?? []).map((e) => e.message).slice(0, 6),
        );
        const excluded =
          (preview.plan?.summary?.totalStages ?? 0) - (preview.plan?.summary?.executedStages ?? 0);
        setPreviewNote(
          excluded > 0
            ? `${excluded} stage${excluded === 1 ? ' is' : 's are'} intentionally excluded from this scope (${scope}) and their outputs won't exist.`
            : null,
        );
      })
      .catch(() => {
        if (!cancelled) {
          setSummary(null);
          setPreviewNote(null);
          setPreviewErrors([]);
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the serialized selection
  }, [workflowId, workflowVersion, scope, gridKey, skipsKey]);

  const handleStart = async () => {
    if (!projectId || !intentId || uploadProgress !== null) return;
    setStarting(true);
    setError(null);
    try {
      // Persist the last shared edits BEFORE launching — Start reads the
      // intent row, not the Yjs doc.
      await draft.flushDraft();
      await intentsService.start(projectId, intentId);
      // IntentProvider stays mounted across /compose -> /intent and is keyed
      // by the same ids. Refresh it before navigation so IntentView never sees
      // the cached DRAFT and redirects back to compose.
      await reload();
      navigate(`/space/${projectId}/intent/${intentId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start intent');
    } finally {
      setStarting(false);
    }
  };

  if (projectLoading || (!intent && !loadError)) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-[400px] rounded-lg" />
      </div>
    );
  }

  if (!project || loadError) {
    return <div className="text-sm text-destructive">{loadError ?? 'Space not found'}</div>;
  }

  const remoteCount = draft.remoteUsers.size;

  return (
    <div className="h-full overflow-y-auto">
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5"
            onClick={() => navigate(`/space/${projectId}`)}
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

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <Label className="text-sm font-medium">Reference attachments</Label>
              <input
                ref={attachmentInput}
                type="file"
                className="hidden"
                data-testid="attachment-picker"
                accept=".txt,.md,.csv,.html,.png,.jpg,.jpeg,.webp,.svg"
                multiple
                onChange={(event) => handleAttachmentPick(event.target.files)}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={starting || uploadProgress !== null || attachments.length >= 5}
                onClick={() => attachmentInput.current?.click()}
              >
                <Paperclip className="mr-1.5 h-3.5 w-3.5" />
                Attach files
              </Button>
            </div>
            {uploadProgress !== null && (
              <div
                className="h-1.5 overflow-hidden rounded bg-muted"
                data-testid="attachment-progress"
              >
                <div
                  className="h-full bg-primary transition-all"
                  style={{ width: `${uploadProgress}%` }}
                />
              </div>
            )}
            {attachmentError && <p className="text-xs text-destructive">{attachmentError}</p>}
            {attachments.length > 0 && (
              <ul className="divide-y rounded-md border" data-testid="attachment-list">
                {attachments.map((attachment) => (
                  <li
                    key={attachment.attachmentId}
                    className="flex items-center gap-3 px-3 py-2 text-sm"
                  >
                    <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">{attachment.filename}</span>
                    <span className="text-xs text-muted-foreground">
                      {formatBytes(attachment.size)}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      disabled={
                        starting ||
                        uploadProgress !== null ||
                        removingAttachmentId === attachment.attachmentId
                      }
                      onClick={() => removeAttachment(attachment.attachmentId)}
                      aria-label={`Remove ${attachment.filename}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
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

          <div className="space-y-2">
            <Label className="text-sm font-medium">Scope</Label>
            <div className="grid gap-3 lg:grid-cols-3">
              {/* Predefined — pick a built-in scope (1/3) */}
              <div className="lg:col-span-1 border rounded-md p-3 space-y-1.5">
                <div className="flex items-center gap-2">
                  <MousePointerClick className="h-4 w-4 text-muted-foreground" />
                  <Label htmlFor="draft-scope" className="text-sm font-medium">
                    Predefined
                  </Label>
                </div>
                <p className="text-xs text-muted-foreground">Built-in stage sets for common work</p>
                <Select
                  value={draft.composedGrid ? '' : (scope ?? '')}
                  onValueChange={(v) => {
                    // Picking a stock scope leaves any composed grid behind.
                    if (v) resetGridToScope(v);
                  }}
                  disabled={scopeOptions.length === 0}
                >
                  <SelectTrigger id="draft-scope">
                    <SelectValue
                      placeholder={
                        draft.composedGrid ? `composed grid (${scope})` : 'Select a scope'
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {scopeOptions.map((s) => (
                      <SelectItem key={s} value={s}>
                        {s}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Compose with AI — propose a scope/grid from the prompt (2/3) */}
              {projectId && intentId && (
                <div className="lg:col-span-2">
                  <ComposePanel
                    projectId={projectId}
                    intentId={intentId}
                    disabled={starting}
                    onApply={applyProposal}
                  />
                </div>
              )}
            </div>
          </div>

          {gridStages.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Label className="text-sm font-medium">Stages</Label>
                {draft.composedGrid && scope && (
                  <button
                    type="button"
                    className="ml-auto text-xs underline text-muted-foreground hover:text-foreground"
                    data-testid="grid-reset"
                    onClick={() => {
                      const back = scopeOptions.includes(scope.replace(/-custom$/, ''))
                        ? scope.replace(/-custom$/, '')
                        : (scopeOptions[0] ?? scope);
                      resetGridToScope(back);
                    }}
                  >
                    reset to scope
                  </button>
                )}
              </div>

              {/* Run-shape summary + exclusion note for the current selection */}
              {scope && summary && (
                <p className="text-xs text-foreground" data-testid="scope-summary">
                  {(() => {
                    const label = draft.composedGrid
                      ? 'Customized scope'
                      : `"${scope.charAt(0).toUpperCase() + scope.slice(1)}" scope`;
                    const parts = [
                      `Runs ${summary.executedStages} of ${summary.totalStages} stages`,
                      `${summary.approvalGates} approval gate${summary.approvalGates === 1 ? '' : 's'}`,
                    ];
                    if (summary.perUnitStages > 0) {
                      parts.push(
                        `${summary.perUnitStages} stage${summary.perUnitStages === 1 ? '' : 's'} fan${summary.perUnitStages === 1 ? 's' : ''} out per unit of work`,
                      );
                    }
                    if (summary.skippedStages > 0)
                      parts.push(`${summary.skippedStages} deselected`);
                    return `${label}: ${parts.join(' · ')}`;
                  })()}
                </p>
              )}
              {previewNote && (
                <p
                  className="flex items-start gap-1.5 text-xs text-sky-700 dark:text-sky-300"
                  data-testid="preview-note"
                >
                  <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                  {previewNote}
                </p>
              )}
              {previewErrors.length > 0 && (
                <div className="space-y-0.5" data-testid="grid-errors">
                  {previewErrors.map((msg, i) => (
                    <p key={i} className="flex items-start gap-1.5 text-xs text-destructive">
                      <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                      {msg}
                    </p>
                  ))}
                </div>
              )}

              {/* Optional stage refinement — collapsed by default */}
              <div className="border rounded-md">
                <button
                  type="button"
                  onClick={() => setShowGridEditor((v) => !v)}
                  className="w-full flex items-center gap-1.5 px-3 py-2 text-sm font-medium"
                  data-testid="grid-editor-toggle"
                >
                  {showGridEditor ? (
                    <ChevronDown className="h-3.5 w-3.5" />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5" />
                  )}
                  Customize stages
                  <span className="text-xs text-muted-foreground font-normal">(optional)</span>
                </button>
                {showGridEditor && (
                  <div className="px-3 pb-3 space-y-2">
                    <p className="text-xs text-muted-foreground">
                      Every stage this workflow can run, grouped by phase. Checked stages execute;
                      unchecked ones are skipped, and downstream stages treat their outputs as
                      absent by design. Initialization always runs.
                    </p>
                    <StageGridEditor
                      stages={gridStages}
                      phaseNames={phaseNames}
                      grid={effectiveGrid}
                      lockedStageIds={lockedStageIds}
                      disabled={starting}
                      onToggle={toggleGridStage}
                    />
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="flex items-center gap-3 pt-2">
            <Button
              type="button"
              onClick={handleStart}
              disabled={
                starting ||
                uploadProgress !== null ||
                !draft.prompt.trim() ||
                !scope ||
                previewErrors.length > 0
              }
              data-testid="start-intent"
            >
              {starting && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />}
              {starting ? 'Starting…' : 'Start Intent'}
            </Button>
            {!starting && !draft.prompt.trim() && (
              <span className="text-xs text-muted-foreground">Write a prompt to continue</span>
            )}
            {!starting && draft.prompt.trim() && !scope && (
              <span className="text-xs text-muted-foreground">Pick a scope to continue</span>
            )}
            {!draft.synced && (
              <span className="text-xs text-muted-foreground">connecting live session…</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
