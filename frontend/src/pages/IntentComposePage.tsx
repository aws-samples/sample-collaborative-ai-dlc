import { useState, useEffect, useMemo, useRef } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router';
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
import { agentsService, type AgentCapabilities } from '@/services/agents';
import type { AgentCli } from '@/services/projects';
import { AGENT_CLIS, AGENT_CLI_METADATA, AGENT_CREDENTIAL_SOURCE_LABELS } from '@/lib/agentCli';
import { useDiscussions } from '@/components/discussion/DiscussionProvider';
import { CollaborativeTextarea } from '@/components/CollaborativeTextarea';
import { ComposePanel } from '@/components/intent/ComposePanel';
import { AidlcSettingsPanel } from '@/components/AidlcSettingsPanel';
import {
  aidlcSettingsFromComposeProposal,
  AIDLC_SETTING_LABELS,
  normalizeAidlcSettings,
  type AidlcSettingValue,
} from '@/lib/aidlcSettings';
import { TrackerAttachmentImport } from '@/components/intent/TrackerAttachmentImport';
import { StageGridEditor } from '@/components/intent/StageGridEditor';
import { Button } from '@/components/ui/button';
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
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Info,
  KeyRound,
  Loader2,
  MousePointerClick,
  Paperclip,
  Trash2,
  TriangleAlert,
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
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
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
function IntentComposePageContent() {
  const navigate = useNavigate();
  const location = useLocation();
  const { projectId, intentId } = useParams<{ projectId: string; intentId: string }>();
  const { user } = useAuth();
  const { reload } = useIntent();
  const setAssistAgentCli = useDiscussions()?.setAssistAgentCli;
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
  const [trackerImportBusy, setTrackerImportBusy] = useState(false);
  useEffect(() => setTrackerImportBusy(false), [intentId]);
  const [removingAttachmentId, setRemovingAttachmentId] = useState<string | null>(null);
  const [agentCapabilities, setAgentCapabilities] = useState<AgentCapabilities | null>(null);
  const [capabilitiesLoading, setCapabilitiesLoading] = useState(true);
  const [capabilitiesError, setCapabilitiesError] = useState<string | null>(null);
  const [selectedCli, setSelectedCli] = useState<AgentCli | null>(null);
  const attachmentInput = useRef<HTMLInputElement>(null);
  const releaseSelectionFallback = (location.state as { releaseSelectionFallback?: boolean } | null)
    ?.releaseSelectionFallback;

  useEffect(() => {
    if (!setAssistAgentCli) return;
    setAssistAgentCli(selectedCli);
    return () => setAssistAgentCli(null);
  }, [selectedCli, setAssistAgentCli]);

  const draft = useCollaborativeIntentDraft(projectId ?? '', intentId ?? null, userName);
  const { initFromIntent } = draft;
  const draftReady = draft.synced && draft.hydrated;

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    setSelectedCli(null);
    setCapabilitiesLoading(true);
    setCapabilitiesError(null);
    agentsService
      .getProjectCapabilities(projectId, true)
      .then((result) => {
        if (!cancelled) setAgentCapabilities(result);
      })
      .catch((cause) => {
        if (!cancelled) {
          setAgentCapabilities(null);
          setCapabilitiesError(
            cause instanceof Error ? cause.message : 'Failed to load agent CLIs',
          );
        }
      })
      .finally(() => {
        if (!cancelled) setCapabilitiesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

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
    if (!projectId || !intentId || !draftReady || !files?.length) return;
    setAttachmentError(null);
    const selected = [...files];
    if (attachments.length + selected.length > 50) {
      setAttachmentError('Attach up to 50 files.');
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
    if (!projectId || !intentId || !draftReady) return;
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

  const workflowId = intent?.workflowId ?? (project ? (project.workflowId ?? 'aidlc-v2') : null);
  const workflowVersion = intent
    ? (intent.workflowVersion ?? undefined)
    : (project?.workflowVersion ?? undefined);
  // A release-pinned intent runs its immutable closure, so every compiled view
  // on this page must be resolved from that release rather than from the live
  // SYSTEM rows — otherwise the scope options and the stage grid describe
  // methodology this intent will never execute. Null for unpinned intents, which
  // keeps their behaviour unchanged.
  const releaseId = intent?.methodologyRelease?.releaseId ?? null;
  // The pin's own importer revision: after an admin upgrades the release's
  // closure, this intent still runs the closure it was created on.
  const releaseImporterRevision = intent?.methodologyRelease?.importerRevision ?? null;
  const intentReady = intent !== null;

  // Compiled views: the scope grid (options + per-scope projections for the
  // grid editor's baseline) and the stage-node list (phase grouping); the
  // workflow's phase tree supplies the display names + which phase is
  // initialization (those stages are locked EXECUTE in the editor).
  const [compiled, setCompiled] = useState<CompiledWorkflow | null>(null);
  const [phases, setPhases] = useState<PhaseNode[]>([]);
  // A pinned intent whose release-backed compile fails must SAY so. Falling back
  // to the live SYSTEM rows would render a preview of methodology this intent
  // will never execute, which is worse than rendering nothing.
  const [releaseViewUnavailable, setReleaseViewUnavailable] = useState(false);
  useEffect(() => {
    if (!workflowId) return;
    // Wait for the intent before compiling: loading the live workflow first and
    // correcting it afterwards would let a user pick a scope the release does
    // not offer.
    if (!intentReady) return;
    let cancelled = false;
    setReleaseViewUnavailable(false);
    workflowsService
      .compiled(
        workflowId,
        workflowVersion,
        releaseId,
        releaseImporterRevision,
        releaseId && projectId && intentId ? { projectId, intentId } : undefined,
      )
      .then((c) => {
        if (cancelled) return;
        setCompiled(c);
        // The release response carries the closure's own phase tree; the live
        // workflow read below cannot be used for a pinned intent.
        if (releaseId) setPhases(c.phases ?? []);
      })
      .catch((e) => {
        if (cancelled) return;
        if (releaseId) {
          setReleaseViewUnavailable(true);
          return;
        }
        setError(e instanceof Error ? e.message : 'Failed to load scopes');
      });
    if (!releaseId) {
      workflowsService
        .get(workflowId, workflowVersion)
        .then((wf) => {
          if (!cancelled) setPhases(wf.phases ?? []);
        })
        .catch(() => {
          /* phase names are display sugar — the editor degrades to raw paths */
        });
    }
    return () => {
      cancelled = true;
    };
  }, [
    workflowId,
    workflowVersion,
    releaseId,
    releaseImporterRevision,
    projectId,
    intentId,
    intentReady,
  ]);
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

  // The AI-DLC settings the previewed scope AUTHORS. Null for an unpinned intent
  // and for every release before 2.11, which is what keeps the chooser hidden
  // for them rather than showing an empty box. Declared here because the
  // selection handlers below read it.
  const [authoredSettings, setAuthoredSettings] = useState<Record<
    string,
    AidlcSettingValue
  > | null>(null);
  // Whether the pinned catalog authors the per-intent settings at all, which is
  // also the only case in which a base scope resolves a policy.
  //
  // This is the PREVIEWED SELECTION's answer, so it is null while a preview is
  // in flight, after a preview error, and for any stock scope whose plan
  // authors nothing. It may therefore gate what the page SHOWS, but never what
  // it RECORDS: the server and the compose job answer the same question from
  // the catalog, so a selection-shaped answer would drop a base — and with it
  // the whole policy — in exactly those three windows.
  const settingsAware = authoredSettings !== null;

  // The base scope a customization of the CURRENT selection runs on.
  //
  // A selection that already has a grid keeps the base recorded with it: the
  // base belongs to the grid, and reading `policyScope` without one would adopt
  // a value an older bundle left in the shared document after clearing the grid
  // — a feature-derived grid would then run Classic's policy.
  //
  // A stock selection records its own scope, on EVERY release: the plan,
  // validate-grid and the save all ignore a base on a catalog that authors no
  // scope policy, so there is nothing to lose by recording it and a whole
  // policy to lose by waiting for a preview to say whether it matters. A
  // selection that is already a customization has a display LABEL for a scope,
  // not a scope, and recording that would record a base no catalog can resolve.
  const customizationBaseScope =
    (draft.composedGrid
      ? draft.policyScope
      : scope && scopeOptions.includes(scope)
        ? scope
        : null) ?? null;

  const toggleGridStage = (stageId: string) => {
    if (!draftReady || lockedStageIds.has(stageId)) return;
    // First customization materializes the scope's projection into a composed
    // grid (initialization pinned EXECUTE) so the flip has a total baseline.
    // Legacy deselections are folded into the grid at the same moment — after
    // this, the grid alone describes the run.
    const base: Record<string, 'EXECUTE' | 'SKIP'> = { ...effectiveGrid };
    for (const id of lockedStageIds) base[id] = 'EXECUTE';
    base[stageId] = base[stageId] === 'EXECUTE' ? 'SKIP' : 'EXECUTE';
    // Customizing the stages does not change the methodology the run follows,
    // so the scope the grid was built from stays its policy context — the
    // display label alone names no scope block, which would withdraw the whole
    // policy and every settable switch on the first stage toggle.
    draft.setComposedGrid(base, customizationBaseScope);
    if (skipSelections.size) draft.setSkipStageIds(null);
    if (!draft.composedGrid && scope) {
      // Label the customization after its origin so provenance stays readable.
      draft.setScope(`${scope}-custom`);
    }
  };

  const resetGridToScope = (nextScope: string) => {
    if (!draftReady) return;
    draft.setScope(nextScope);
    draft.setComposedGrid(null);
    draft.setSkipStageIds(null);
  };

  // Accepting a composed plan is ONE local transaction: the scope, the grid,
  // the base scope its policy comes from and the settings it proposed all land
  // together, and the whole selection reaches the server in one body under one
  // CAS. There is no asynchronous result to inspect and nothing partial to
  // recover from.
  const applyProposal = (
    proposal: NonNullable<ComposeSession['proposal']>,
    settingsScope: string | null,
    settingsAuthored: Record<string, AidlcSettingValue> | null,
  ) => {
    if (!draftReady) return;
    // Only a catalog that authors these settings can store one, so a value a
    // model volunteered on an older pin is not written into the selection — it
    // would be dropped by the save and would change the request shape of a
    // draft that has no settings at all.
    //
    // A settings scope on the proposal PROVES the catalog is settings-aware:
    // the compose job records one only there. That is the catalog's own answer,
    // so it stands in for a preview that has not landed, failed, or described a
    // scope that authors nothing — without it, accepting a proposal in any of
    // those windows dropped every value the job had already validated.
    const catalogSettingsAware = settingsAware || settingsScope !== null;
    const proposed = catalogSettingsAware ? aidlcSettingsFromComposeProposal(proposal) : {};
    // Only overrides are stored. The proposal was validated against the
    // authored defaults of its settings scope, recorded beside it, so its
    // values are normalized against exactly those before they enter the shared
    // document: a value equal to that scope's default is not kept as a choice
    // that would become an override of a later scope's own default, and a real
    // override of it is kept whatever selection the page is previewing, or
    // whether a preview has landed at all.
    //
    // A proposal recorded before those defaults were carries only its settings
    // scope. For it, the current preview's defaults are used when they describe
    // the same selection and base scope; otherwise its values are written as
    // proposed and the preview of the new selection prunes them.
    const selectionUnchanged =
      proposal.mode === 'matched'
        ? proposal.scope === scope && !draft.composedGrid
        : proposal.scope === scope &&
          (settingsScope ?? proposal.baseScope ?? customizationBaseScope) === draft.policyScope &&
          JSON.stringify(proposal.grid ?? null) === JSON.stringify(draft.composedGrid ?? null);
    const authoredForApply = settingsAuthored ?? (selectionUnchanged ? authoredSettings : null);
    const aidlcSettings = authoredForApply
      ? normalizeAidlcSettings({ settings: proposed, authored: authoredForApply }).value
      : Object.keys(proposed).length > 0
        ? proposed
        : null;
    if (proposal.mode === 'matched') {
      draft.applyComposedSelection({ scope: proposal.scope, aidlcSettings });
      return;
    }
    if (!proposal.grid) return;
    // The composer names the stock scope its grid runs on and the proposal was
    // validated against it. A proposal that omits the optional member keeps the
    // base scope this selection ALREADY runs on, or the stock scope it is
    // replacing — never a display label, which names no scope block and would
    // resolve nothing.
    draft.applyComposedSelection({
      scope: proposal.scope,
      composedGrid: proposal.grid,
      policyScope: catalogSettingsAware
        ? (settingsScope ?? proposal.baseScope ?? customizationBaseScope)
        : null,
      aidlcSettings,
    });
    setShowGridEditor(true);
  };

  // Run-shape preview: authoritative counts for the current selection,
  // re-fetched whenever the shared selection changes (keyed on the serialized
  // selection so a peer's grid edit re-previews too).
  const [summary, setSummary] = useState<ScopeSummary | null>(null);
  // The settings the new selection does not offer, named so the team is told
  // which choice it withdrew rather than seeing a control quietly disappear.
  const [withdrawnSettings, setWithdrawnSettings] = useState<string[]>([]);
  const [previewNote, setPreviewNote] = useState<string | null>(null);
  const [previewErrors, setPreviewErrors] = useState<string[]>([]);
  const gridKey = JSON.stringify([draft.composedGrid ?? null, draft.policyScope ?? null]);
  const skipsKey = JSON.stringify([...skipSelections].toSorted());
  useEffect(() => {
    if (!workflowId || !scope || !intentReady) return;
    let cancelled = false;
    const skips = [...skipSelections];
    const request = draft.composedGrid
      ? workflowsService.validateGrid(workflowId, {
          composedGrid: draft.composedGrid,
          scope,
          ...(draft.policyScope ? { policyScope: draft.policyScope } : {}),
          skipStageIds: skips.length ? skips : undefined,
          version: workflowVersion,
          release: releaseId,
          releaseImporterRevision,
          ...(releaseId && projectId && intentId ? { projectId, intentId } : {}),
        })
      : workflowsService.executionPreview(
          workflowId,
          scope,
          workflowVersion,
          skips.length ? skips : undefined,
          releaseId,
          releaseImporterRevision,
          releaseId && projectId && intentId ? { projectId, intentId } : undefined,
        );
    request
      .then((preview) => {
        if (cancelled) return;
        setSummary(preview.plan?.summary ?? null);
        const authored = preview.plan?.aidlcSettingsAuthored ?? null;
        setAuthoredSettings(authored);
        // The selection decides which settings EXIST, so the overrides are
        // pruned against the authored map of the selection now in force,
        // through the same rule the API runs on the saved payload. Done here
        // because this is where the authored map for the current selection
        // arrives; a selection that authors the same settings prunes nothing
        // and writes nothing to the document.
        if (draftReady) {
          const dropped = draft.pruneAidlcSettings(authored);
          setWithdrawnSettings(dropped.map((key) => AIDLC_SETTING_LABELS[key] ?? key));
        }
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
          setAuthoredSettings(null);
          setPreviewNote(null);
          setPreviewErrors([]);
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the serialized selection
  }, [
    workflowId,
    workflowVersion,
    scope,
    gridKey,
    skipsKey,
    releaseId,
    releaseImporterRevision,
    intentReady,
    projectId,
    intentId,
  ]);

  const handleStart = async () => {
    if (!projectId || !intentId || !draftReady || uploadProgress !== null || trackerImportBusy)
      return;
    setStarting(true);
    setError(null);
    try {
      // Persist the last shared edits BEFORE launching — Start reads the
      // intent row, not the Yjs doc.
      await draft.flushDraft();
      if (!selectedCli) return;
      await intentsService.start(projectId, intentId, { agentCli: selectedCli });
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
  const runtimeCliStatus = new Map(
    (agentCapabilities?.runtimeClis ?? []).map((status) => [status.cli, status]),
  );
  const cliAvailable = (cli: AgentCli) =>
    runtimeCliStatus.get(cli)?.available ?? agentCapabilities?.available.includes(cli) ?? false;
  const availableCliCount = AGENT_CLIS.filter(cliAvailable).length;
  const hasEffectiveCredential = AGENT_CLIS.some((cli) => {
    const status = runtimeCliStatus.get(cli);
    return Boolean(
      status?.credentialSource ??
      agentCapabilities?.credentialSources?.[AGENT_CLI_METADATA[cli].credentialProvider],
    );
  });

  return (
    <div className="min-h-full">
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

        {releaseSelectionFallback && (
          <div
            className="rounded-md border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm"
            role="status"
          >
            AI-DLC version selection was disabled while this page was open. This intent will use the
            platform default.
          </div>
        )}

        {releaseViewUnavailable && (
          <div
            className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-400"
            role="status"
            data-testid="release-view-unavailable"
          >
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              This intent&apos;s AI-DLC version is no longer offered; the compose preview is
              unavailable — the intent itself still runs on its pinned version.
            </span>
          </div>
        )}

        <div className="space-y-4">
          <div>
            <Label htmlFor="draft-title">Title</Label>
            <CollaborativeTextarea
              id="draft-title"
              yText={draft.titleText}
              awareness={draft.awareness}
              value={draft.title}
              placeholder="e.g. Add user authentication"
              className="mt-1.5 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
              singleLine
              disabled={!draftReady}
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
                accept=".txt,.md,.csv,.html,.pdf,.docx,.xlsx,.png,.jpg,.jpeg,.webp,.svg"
                multiple
                disabled={!draftReady || starting || uploadProgress !== null || trackerImportBusy}
                onChange={(event) => handleAttachmentPick(event.target.files)}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={
                  !draftReady ||
                  starting ||
                  uploadProgress !== null ||
                  trackerImportBusy ||
                  attachments.length >= 50
                }
                onClick={() => attachmentInput.current?.click()}
              >
                <Paperclip className="mr-1.5 h-3.5 w-3.5" />
                Attach files
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              PDF, DOCX, XLSX, text, Markdown, CSV, HTML, or images (PNG, JPEG, WebP, SVG). Up to 50
              files, 5 MB each, 25 MB total.
            </p>
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
            {intent?.source && projectId && intentId && (
              <TrackerAttachmentImport
                key={intentId}
                projectId={projectId}
                intentId={intentId}
                autoImport={Boolean(
                  (location.state as { importTrackerAttachments?: boolean } | null)
                    ?.importTrackerAttachments,
                )}
                disabled={starting || uploadProgress !== null}
                onAutoImportStarted={() => {
                  const state = { ...location.state };
                  delete state.importTrackerAttachments;
                  void navigate(`${location.pathname}${location.search}${location.hash}`, {
                    replace: true,
                    state,
                  });
                }}
                onBusyChange={setTrackerImportBusy}
                onImported={() => {
                  void intentsService
                    .attachments(projectId, intentId)
                    .then((result) => {
                      setAttachments(result.attachments);
                      setAttachmentRevision(result.attachmentRevision);
                    })
                    .catch(() => {});
                }}
              />
            )}
            {attachments.length > 0 && (
              <ul className="divide-y rounded-md border" data-testid="attachment-list">
                {attachments.map((attachment) => (
                  <li
                    key={attachment.attachmentId}
                    className="flex items-center gap-3 px-3 py-2 text-sm"
                  >
                    <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">
                      {attachment.filename}
                      {attachment.source && (
                        <span className="ml-2 text-xs text-muted-foreground">
                          From source issue
                        </span>
                      )}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {formatBytes(attachment.size)}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      disabled={
                        !draftReady ||
                        starting ||
                        uploadProgress !== null ||
                        trackerImportBusy ||
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
              yText={draft.promptText}
              awareness={draft.awareness}
              value={draft.prompt}
              rows={10}
              placeholder="Describe the intent in detail…"
              className="mt-1.5 rounded-md border bg-background px-3 py-2 text-sm"
              disabled={!draftReady}
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Bot className="h-4 w-4 text-muted-foreground" />
              <Label className="text-sm font-medium">Agent CLI</Label>
            </div>
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
              {AGENT_CLIS.map((cli) => {
                const status = runtimeCliStatus.get(cli);
                const available = cliAvailable(cli);
                const selected = selectedCli === cli;
                const source =
                  status?.credentialSource ??
                  agentCapabilities?.credentialSources?.[
                    AGENT_CLI_METADATA[cli].credentialProvider
                  ] ??
                  null;
                const disabledByAdmin =
                  status?.enabled === false ||
                  (agentCapabilities?.disabledClis ?? []).includes(cli);
                const unavailableReason = disabledByAdmin
                  ? 'disabled by admin'
                  : status?.installed === false
                    ? 'not installed'
                    : status?.authed === false || !source
                      ? 'no credential'
                      : 'unavailable';
                return (
                  <button
                    key={cli}
                    type="button"
                    aria-pressed={selected}
                    disabled={!draftReady || starting || capabilitiesLoading || !available}
                    onClick={() => setSelectedCli(cli)}
                    className={`relative min-h-20 rounded-md border px-3 py-2.5 text-left transition-colors ${
                      selected
                        ? 'border-primary bg-primary/[0.04] ring-1 ring-primary'
                        : available
                          ? 'hover:border-primary/40 hover:bg-muted/30'
                          : 'cursor-not-allowed bg-muted/30 opacity-60'
                    }`}
                    data-testid={`agent-cli-${cli}`}
                  >
                    {selected && (
                      <CheckCircle2 className="absolute right-2.5 top-2.5 h-4 w-4 text-primary" />
                    )}
                    <span className="block pr-5 text-xs font-semibold">
                      {AGENT_CLI_METADATA[cli].label}
                    </span>
                    <span className="mt-2 flex flex-wrap gap-1 text-[10px] text-muted-foreground">
                      {project.agentCli === cli && (
                        <span className="rounded bg-primary/10 px-1.5 py-0.5 text-primary">
                          recommended
                        </span>
                      )}
                      {source && (
                        <span className="rounded bg-muted px-1.5 py-0.5">
                          {AGENT_CREDENTIAL_SOURCE_LABELS[source]} key
                        </span>
                      )}
                      {!available && <span>{unavailableReason}</span>}
                    </span>
                  </button>
                );
              })}
            </div>
            {!capabilitiesLoading && availableCliCount === 0 && (
              <div className="flex items-center justify-between gap-3 rounded-md border border-agent-warning/30 bg-agent-warning/[0.06] px-3 py-2">
                <p className="text-xs text-muted-foreground">
                  {capabilitiesError ??
                    (hasEffectiveCredential
                      ? 'No configured agent CLI is currently available.'
                      : 'No agent credential is currently available. Add one before starting this draft.')}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                  onClick={() => navigate('/account/settings')}
                >
                  <KeyRound className="mr-1.5 h-3.5 w-3.5" />
                  Add credential
                </Button>
              </div>
            )}
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
                  disabled={!draftReady || scopeOptions.length === 0}
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
                    agentCli={selectedCli}
                    disabled={starting || !draftReady}
                    onApply={applyProposal}
                  />
                </div>
              )}
            </div>
          </div>

          <AidlcSettingsPanel
            authored={authoredSettings}
            chosen={draft.aidlcSettings}
            disabled={starting || !draftReady}
            onChange={draft.setAidlcSetting}
          />
          {withdrawnSettings.length > 0 && (
            <p className="text-xs text-amber-600" data-testid="aidlc-settings-dropped">
              This selection does not offer {withdrawnSettings.join(', ')}, so the choice recorded
              for it was removed and the run follows the scope&rsquo;s defaults.
            </p>
          )}

          {gridStages.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Label className="text-sm font-medium">Stages</Label>
                {draft.composedGrid && scope && (
                  <button
                    type="button"
                    className="ml-auto text-xs underline text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                    data-testid="grid-reset"
                    disabled={starting || !draftReady}
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
                      disabled={starting || !draftReady}
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
                !draftReady ||
                uploadProgress !== null ||
                trackerImportBusy ||
                !draft.prompt.trim() ||
                !scope ||
                !selectedCli ||
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
            {!starting && draft.prompt.trim() && scope && !selectedCli && (
              <span className="text-xs text-muted-foreground">Select an agent CLI to continue</span>
            )}
            {!draftReady && (
              <span className="text-xs text-muted-foreground">
                {draft.synced ? 'loading shared draft…' : 'connecting live session…'}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function IntentComposePage() {
  const { projectId, intentId } = useParams<{ projectId: string; intentId: string }>();
  return <IntentComposePageContent key={`${projectId ?? ''}\0${intentId ?? ''}`} />;
}
