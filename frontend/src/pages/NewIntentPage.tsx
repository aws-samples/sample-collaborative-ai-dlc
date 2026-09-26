import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, useLocation, useSearchParams } from 'react-router';
import { useProjectCache } from '@/hooks/useProjectsCache';
import { intentsService, type CreateIntentInput, type Intent } from '@/services/intents';
import { aidlcReleasesService, type AidlcRelease } from '@/services/aidlcReleases';
import { ApiError } from '@/services/api';
import { trackersService, type TrackerIssue } from '@/services/trackers';
import type { TrackerBinding } from '@/services/projects';
import { sourceControlService } from '@/services/sourceControl';
import { buildSprintDescription } from '@/lib/buildSprintDescription';
import { formatTrackerSourceLabel } from '@/lib/trackerSourceLabel';
import { IntentSourcePicker } from '@/components/IntentSourcePicker';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { AlertCircle, ArrowLeft, ChevronDown, ChevronRight, Info, Loader2, X } from 'lucide-react';

// Non-admins receive the reduced release projection (no sourceSha), so the
// label falls back to the raw release id rather than crashing.
const releaseLabel = (release: AidlcRelease) =>
  release.upstreamVersion || release.sourceSha?.slice(0, 7) || release.releaseId;

// Step one of intent creation: capture the seed (title/prompt/tracker import/
// base branch) and create the intent as a DRAFT immediately. Everything else —
// the shared prompt refinement, the scope / composed-grid selection, stage
// deselection and Start — happens on the COLLABORATIVE compose page the user
// lands on next (IntentComposePage), so teammates can join the draft live.
export default function NewIntentPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const { projectId } = useParams<{ projectId: string }>();
  const { project, loading: projectLoading } = useProjectCache(projectId ?? null);

  // Opt-in migration (issue #482): "?fromIntent=<id>" (or route state) seeds
  // this page from an existing intent. Nothing is migrated — the source intent
  // is untouched and the new one recomputes its plan on the chosen version.
  const fromIntentId =
    searchParams.get('fromIntent') ??
    (location.state as { fromIntentId?: string } | null)?.fromIntentId ??
    null;
  const [sourceIntent, setSourceIntent] = useState<Intent | null>(null);
  const [sourceIntentFailed, setSourceIntentFailed] = useState(false);
  const [prefilled, setPrefilled] = useState(false);

  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [source, setSource] = useState<{
    binding: TrackerBinding;
    issue: TrackerIssue;
  } | null>(null);
  const [importing, setImporting] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Base branch (per repo): optional, defaults to each repo's own default
  // branch. Collapsed by default — most intents just want the default. It is
  // create-time only (the branch is derived at create), so it lives here and
  // not on the compose page.
  const [showBaseBranch, setShowBaseBranch] = useState(false);
  const [baseBranchSelections, setBaseBranchSelections] = useState<Record<string, string>>({});
  const [branchOptions, setBranchOptions] = useState<Record<string, string[]>>({});
  const [branchDefaults, setBranchDefaults] = useState<Record<string, string>>({});
  const [branchLoading, setBranchLoading] = useState<Record<string, boolean>>({});
  const [branchLoadError, setBranchLoadError] = useState<Record<string, string>>({});

  const hasTrackers = (project?.trackers.length ?? 0) > 0;
  const repos = project?.repos ?? [];

  // AI-DLC version: offerable releases + the stable
  // channel's default. Hidden entirely (and the field omitted) when the
  // registry is empty, unreachable, or selection is disabled — creation then
  // keeps the legacy platform-baseline behaviour.
  const [releases, setReleases] = useState<AidlcRelease[]>([]);
  const [stableReleaseId, setStableReleaseId] = useState<string | null>(null);
  const [selectedReleaseId, setSelectedReleaseId] = useState<string | null>(null);
  const [pinningEnabled, setPinningEnabled] = useState(false);
  const [releaseSelectionDisabled, setReleaseSelectionDisabled] = useState(false);
  const [releasesSettled, setReleasesSettled] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([aidlcReleasesService.list(), aidlcReleasesService.channels()])
      .then(([{ releases: list }, channels]) => {
        if (cancelled) return;
        setReleases(list);
        const enabled = channels.pinningEnabled === true;
        setPinningEnabled(enabled);
        const stable = enabled ? (channels.stable?.releaseId ?? null) : null;
        const stableOffered = stable && list.some((r) => r.releaseId === stable) ? stable : null;
        setStableReleaseId(stableOffered);
        setSelectedReleaseId(stableOffered);
      })
      .catch(() => {
        // Registry unreachable (or pre-#482 backend) — omit the field.
      })
      .finally(() => {
        if (!cancelled) setReleasesSettled(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!projectId || !fromIntentId) return;
    let cancelled = false;
    intentsService
      .get(projectId, fromIntentId)
      .then((detail) => {
        if (!cancelled) setSourceIntent(detail.intent);
      })
      .catch(() => {
        if (!cancelled) setSourceIntentFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, fromIntentId]);

  // Prefill once, after BOTH the source intent and the registry fetch settle,
  // so the title suffix can name the preselected (stable) version when there
  // is one. The user keeps full control afterwards — this never re-applies.
  useEffect(() => {
    if (!sourceIntent || !releasesSettled || prefilled) return;
    const selected = releases.find((r) => r.releaseId === selectedReleaseId) ?? null;
    const suffix = selected ? ` (AI-DLC ${releaseLabel(selected)})` : '';
    setTitle(`${sourceIntent.title ?? ''}${suffix}`.trim());
    setPrompt(sourceIntent.prompt ?? '');
    setPrefilled(true);
  }, [sourceIntent, releasesSettled, prefilled, releases, selectedReleaseId]);

  const showReleaseSelector = pinningEnabled && releases.length > 0 && !releaseSelectionDisabled;

  // Lazily fetch each repo's branch list (+ its actual default branch) the
  // first time the base-branch picker is expanded — most intents never open
  // it, so there is no reason to hit the git provider on every page load.
  useEffect(() => {
    if (!showBaseBranch || !project || repos.length === 0) return;
    for (const repo of repos) {
      if (branchOptions[repo.url] || branchLoading[repo.url]) continue;
      setBranchLoading((prev) => ({ ...prev, [repo.url]: true }));
      sourceControlService
        .listBranches(project.id, repo.provider || project.gitProvider, repo.url)
        .then(({ branches, defaultBranch }) => {
          setBranchOptions((prev) => ({ ...prev, [repo.url]: branches }));
          if (defaultBranch) {
            setBranchDefaults((prev) => ({ ...prev, [repo.url]: defaultBranch }));
          }
        })
        .catch((e) => {
          setBranchLoadError((prev) => ({
            ...prev,
            [repo.url]: e instanceof Error ? e.message : 'Failed to load branches',
          }));
        })
        .finally(() => {
          setBranchLoading((prev) => ({ ...prev, [repo.url]: false }));
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- branchOptions/branchLoading read for dedupe only
  }, [showBaseBranch, project, repos]);

  const handleSelectIssue = useCallback(
    async (issue: TrackerIssue, binding: TrackerBinding) => {
      if (!projectId) return;
      setSource({ binding, issue });
      setTitle(issue.title);
      setImporting(true);
      setError(null);
      try {
        let comments: Awaited<ReturnType<typeof trackersService.listComments>> = [];
        try {
          comments = await trackersService.listComments(projectId, binding.id, issue.resourceId);
        } catch {
          // Comments are a best-effort enrichment — fall back to the body alone.
        }
        setPrompt(buildSprintDescription(issue, comments));
      } finally {
        setImporting(false);
      }
    },
    [projectId],
  );

  const clearSource = () => setSource(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if ((!title.trim() && !prompt.trim()) || !projectId) return;
    setCreating(true);
    setError(null);
    let releaseSelectionFallback = false;
    try {
      const baseBranches = Object.fromEntries(
        Object.entries(baseBranchSelections).filter(([, branch]) => branch),
      );
      // Scope is deliberately omitted — the server defaults it and the compose
      // page is where the projection is actually chosen (collaboratively).
      const input: CreateIntentInput = {
        title: title.trim(),
        prompt: prompt.trim(),
        baseBranches: Object.keys(baseBranches).length ? baseBranches : undefined,
        methodologyReleaseId:
          showReleaseSelector && selectedReleaseId ? selectedReleaseId : undefined,
        source: source
          ? {
              bindingId: source.binding.id,
              resourceType: source.issue.resourceType,
              resourceId: source.issue.resourceId,
              resourceUrl: source.issue.resourceUrl,
            }
          : undefined,
      };
      let intent;
      try {
        intent = await intentsService.create(projectId, input);
      } catch (err) {
        // The platform flag can flip between page load and submit: retry once
        // without the pin (nothing was created — the 400 precedes the write)
        // and hide the selector for the rest of the session.
        if (
          err instanceof ApiError &&
          err.body?.code === 'release_selection_disabled' &&
          input.methodologyReleaseId
        ) {
          releaseSelectionFallback = true;
          setReleaseSelectionDisabled(true);
          setSelectedReleaseId(null);
          intent = await intentsService.create(projectId, {
            ...input,
            methodologyReleaseId: undefined,
          });
        } else {
          throw err;
        }
      }
      navigate(`/space/${projectId}/intent/${intent.id}/compose`, {
        state: releaseSelectionFallback ? { releaseSelectionFallback: true } : null,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create intent');
    } finally {
      setCreating(false);
    }
  };

  if (projectLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-[400px] rounded-lg" />
      </div>
    );
  }

  if (!project) {
    return <div className="text-sm text-destructive">Space not found</div>;
  }

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
          <h1 className="text-xl font-semibold tracking-tight">New Intent</h1>
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
        {releaseSelectionDisabled && (
          <div
            className="rounded-md border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm"
            role="status"
          >
            AI-DLC version selection was disabled while this page was open. This intent will use the
            platform default.
          </div>
        )}

        {sourceIntent && (
          <div className="flex items-start gap-2 rounded-md border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
            <Info className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              Started from{' '}
              <span className="font-medium text-foreground">
                {sourceIntent.title || sourceIntent.id}
              </span>
              {sourceIntent.methodologyRelease?.upstreamVersion
                ? ` (AI-DLC ${sourceIntent.methodologyRelease.upstreamVersion})`
                : ''}
              . The original intent is unchanged and stays on its version; this new intent
              recomputes its plan on the version you choose below.
            </span>
          </div>
        )}
        {sourceIntentFailed && (
          <div className="flex items-start gap-2 rounded-md border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
            <Info className="mt-0.5 h-4 w-4 shrink-0" />
            <span>Could not load the source intent — starting from a blank intent instead.</span>
          </div>
        )}

        <div className={hasTrackers ? 'grid gap-6 lg:grid-cols-[1fr_1fr]' : 'flex justify-center'}>
          {hasTrackers && (
            <Card className="lg:max-h-[calc(100vh-12rem)] lg:overflow-y-auto">
              <CardContent className="p-4 space-y-3">
                <Label className="text-sm font-medium">Import from tracker</Label>
                <IntentSourcePicker
                  project={project}
                  selected={
                    source
                      ? { bindingId: source.binding.id, resourceId: source.issue.resourceId }
                      : null
                  }
                  onSelect={handleSelectIssue}
                />
              </CardContent>
            </Card>
          )}

          <form
            onSubmit={handleSubmit}
            className={hasTrackers ? 'space-y-4' : 'w-full max-w-lg space-y-4'}
          >
            {source && (
              <Badge variant="secondary" className="gap-1.5 text-xs">
                {source.issue.resourceUrl ? (
                  <a
                    href={source.issue.resourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:underline"
                  >
                    {formatTrackerSourceLabel({
                      provider: source.binding.provider,
                      resourceId: source.issue.resourceId,
                      entityType: source.issue.entityType,
                    })}
                  </a>
                ) : (
                  formatTrackerSourceLabel({
                    provider: source.binding.provider,
                    resourceId: source.issue.resourceId,
                    entityType: source.issue.entityType,
                  })
                )}
                <button
                  type="button"
                  onClick={clearSource}
                  className="ml-0.5 rounded-sm hover:bg-muted p-0.5"
                  aria-label="Clear source"
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            )}

            <div>
              <Label htmlFor="intent-title">Title</Label>
              <Input
                id="intent-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Add user authentication"
                className="mt-1.5"
                autoFocus
              />
            </div>

            <div>
              <Label htmlFor="intent-prompt">
                Prompt
                {importing && (
                  <span className="ml-2 text-xs text-muted-foreground">Importing issue…</span>
                )}
              </Label>
              <textarea
                id="intent-prompt"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={10}
                placeholder="Describe the intent — you can refine it together on the next step…"
                className="mt-1.5 w-full rounded-md border bg-background px-3 py-2 text-sm"
              />
            </div>

            {showReleaseSelector && (
              <div>
                <Label htmlFor="intent-methodology-release">AI-DLC version</Label>
                <Select
                  value={selectedReleaseId ?? '__default__'}
                  onValueChange={(v) => setSelectedReleaseId(v === '__default__' ? null : v)}
                >
                  <SelectTrigger id="intent-methodology-release" className="mt-1.5">
                    <SelectValue placeholder="Platform default" />
                  </SelectTrigger>
                  <SelectContent>
                    {!stableReleaseId && (
                      <SelectItem value="__default__">Platform default</SelectItem>
                    )}
                    {releases.map((release) => (
                      <SelectItem key={release.releaseId} value={release.releaseId}>
                        {releaseLabel(release)}
                        {release.releaseId === stableReleaseId ? ' (stable, default)' : ''}
                        {release.supportState === 'certified' &&
                        release.releaseId !== stableReleaseId
                          ? ' (certified)'
                          : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="mt-1.5 text-xs text-muted-foreground">
                  This intent stays on this version; it is never migrated automatically.
                </p>
              </div>
            )}

            {repos.length > 0 && (
              <div className="border rounded-md">
                <button
                  type="button"
                  onClick={() => setShowBaseBranch((v) => !v)}
                  className="w-full flex items-center gap-1.5 px-3 py-2 text-sm font-medium"
                >
                  {showBaseBranch ? (
                    <ChevronDown className="h-3.5 w-3.5" />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5" />
                  )}
                  Base branch
                  <span className="text-xs text-muted-foreground font-normal">
                    (optional — defaults to each repo's own default branch)
                  </span>
                </button>
                {showBaseBranch && (
                  <div className="px-3 pb-3 space-y-3">
                    {repos.map((repo) => {
                      const options = branchOptions[repo.url];
                      const defaultBranch = branchDefaults[repo.url];
                      return (
                        <div key={repo.url}>
                          <Label htmlFor={`base-branch-${repo.url}`} className="text-xs">
                            {repo.url}
                          </Label>
                          {branchLoadError[repo.url] ? (
                            <p className="mt-1.5 text-xs text-destructive">
                              Couldn't load branches: {branchLoadError[repo.url]} — will use the
                              repo's default branch.
                            </p>
                          ) : (
                            <Select
                              value={baseBranchSelections[repo.url] ?? ''}
                              onValueChange={(v) =>
                                setBaseBranchSelections((prev) => ({ ...prev, [repo.url]: v }))
                              }
                              disabled={branchLoading[repo.url] || !options}
                            >
                              <SelectTrigger id={`base-branch-${repo.url}`} className="mt-1.5">
                                <SelectValue
                                  placeholder={
                                    branchLoading[repo.url]
                                      ? 'Loading branches…'
                                      : `Default${defaultBranch ? ` (${defaultBranch})` : ''}`
                                  }
                                />
                              </SelectTrigger>
                              <SelectContent>
                                {(options ?? []).map((b) => (
                                  <SelectItem key={b} value={b}>
                                    {b}
                                    {b === defaultBranch ? ' (default)' : ''}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            <div className="flex items-center gap-3 pt-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => navigate(`/space/${projectId}`)}
                disabled={creating}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={creating || (!title.trim() && !prompt.trim())}>
                {creating && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />}
                {creating ? 'Creating…' : 'Continue to Compose'}
              </Button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
