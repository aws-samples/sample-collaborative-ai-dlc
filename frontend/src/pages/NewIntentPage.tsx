import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useProjectCache } from '@/hooks/useProjectsCache';
import { intentsService } from '@/services/intents';
import { trackersService, type TrackerIssue } from '@/services/trackers';
import type { TrackerBinding } from '@/services/projects';
import { workflowsService } from '@/services/workflows';
import { agentsService } from '@/services/agents';
import { getGitProviderService } from '@/services/gitProvider';
import { buildSprintDescription } from '@/lib/buildSprintDescription';
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
import { AlertCircle, ArrowLeft, ChevronDown, ChevronRight, Loader2, X } from 'lucide-react';

export default function NewIntentPage() {
  const navigate = useNavigate();
  const { projectId } = useParams<{ projectId: string }>();
  const { project, loading: projectLoading } = useProjectCache(projectId ?? null);

  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [scope, setScope] = useState('');
  const [scopeOptions, setScopeOptions] = useState<string[]>([]);
  const [source, setSource] = useState<{
    binding: TrackerBinding;
    issue: TrackerIssue;
  } | null>(null);
  const [importing, setImporting] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Base branch (per repo): optional, defaults to each repo's own default
  // branch. Collapsed by default — most intents just want the default.
  const [showBaseBranch, setShowBaseBranch] = useState(false);
  const [baseBranchSelections, setBaseBranchSelections] = useState<Record<string, string>>({});
  const [branchOptions, setBranchOptions] = useState<Record<string, string[]>>({});
  const [branchDefaults, setBranchDefaults] = useState<Record<string, string>>({});
  const [branchLoading, setBranchLoading] = useState<Record<string, boolean>>({});
  const [branchLoadError, setBranchLoadError] = useState<Record<string, string>>({});

  // Stage skipping (shared/stage-skip.js): only shown when EFFECTIVELY enabled
  // (project override wins; 'default' inherits the platform Admin setting).
  // Skippable = CONDITIONAL, non-initialization stages of the scope's plan.
  const [skippingEnabled, setSkippingEnabled] = useState(false);
  const [showSkipStages, setShowSkipStages] = useState(false);
  const [skippableStages, setSkippableStages] = useState<
    { stageId: string; phase: string | null }[]
  >([]);
  const [skipStagesLoading, setSkipStagesLoading] = useState(false);
  const [skipSelections, setSkipSelections] = useState<Set<string>>(new Set());
  const [skipPreviewNote, setSkipPreviewNote] = useState<string | null>(null);
  // Exact run-shape counts for the chosen scope (upstream 2.2.12): read
  // VERBATIM from the plan preview's `summary` — "N of T stages, G approval
  // gates" — never re-derived client-side. `scopeSummary` is the base scope
  // shape; `overlaySummary` supersedes it while a skip dry-run is active.
  type ScopeSummary = {
    executedStages: number;
    totalStages: number;
    approvalGates: number;
    perUnitStages: number;
    skippedStages: number;
    outOfScopeStages: number;
  };
  const [scopeSummary, setScopeSummary] = useState<ScopeSummary | null>(null);
  const [overlaySummary, setOverlaySummary] = useState<ScopeSummary | null>(null);

  const hasTrackers = (project?.trackers.length ?? 0) > 0;
  const repos = project?.repos ?? [];

  const workflowId = project ? (project.workflowId ?? 'aidlc-v2') : null;

  useEffect(() => {
    if (!workflowId) return;
    let cancelled = false;
    workflowsService
      .compiled(workflowId)
      .then((compiled) => {
        if (cancelled) return;
        const scopes = Object.keys(compiled.scopeGrid ?? {});
        setScopeOptions(scopes);
        setScope((prev) => (prev && scopes.includes(prev) ? prev : (scopes[0] ?? '')));
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load workflow scopes');
      });
    return () => {
      cancelled = true;
    };
  }, [workflowId]);

  // Lazily fetch each repo's branch list (+ its actual default branch) the
  // first time the base-branch picker is expanded — most intents never open
  // it, so there is no reason to hit the git provider on every page load.
  useEffect(() => {
    if (!showBaseBranch || !project || repos.length === 0) return;
    const service = getGitProviderService(project.gitProvider);
    for (const repo of repos) {
      if (branchOptions[repo.url] || branchLoading[repo.url]) continue;
      setBranchLoading((prev) => ({ ...prev, [repo.url]: true }));
      service
        .listBranches(repo.url)
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

  // Resolve the EFFECTIVE stage-skipping mode: explicit project override, else
  // the platform Admin setting (readable by any authenticated user).
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
        if (!cancelled) setSkippingEnabled(false); // fail safe: no skipping UI
      });
    return () => {
      cancelled = true;
    };
  }, [project]);

  // The scope's run-shape summary + skippable stages — one preview fetch per
  // (workflow, scope). The summary renders for every user at scope confirmation
  // (upstream 2.2.11: exact stage/gate counts, never guessed); the skippable
  // list (CONDITIONAL, non-initialization) only feeds the skip UI when the
  // feature is enabled.
  useEffect(() => {
    setSkipSelections(new Set());
    setSkipPreviewNote(null);
    setScopeSummary(null);
    setOverlaySummary(null);
    if (!workflowId || !scope) {
      setSkippableStages([]);
      setSkipStagesLoading(false);
      return;
    }
    let cancelled = false;
    setSkipStagesLoading(true);
    workflowsService
      .executionPreview(workflowId, scope, project?.workflowVersion ?? undefined)
      .then((preview) => {
        if (cancelled) return;
        setScopeSummary(preview.plan?.summary ?? null);
        const stages = (preview.plan?.stages ?? [])
          .filter((s) => s.execution === 'CONDITIONAL' && s.phase !== 'initialization')
          .map((s) => ({ stageId: s.stageId, phase: s.phase ?? null }));
        setSkippableStages(skippingEnabled ? stages : []);
      })
      .catch(() => {
        // Preview is best-effort UI sugar — creation still validates server-side.
        if (!cancelled) {
          setSkippableStages([]);
          setScopeSummary(null);
        }
      })
      .finally(() => {
        if (!cancelled) setSkipStagesLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- workflowVersion is pinned with the project
  }, [skippingEnabled, workflowId, scope]);

  // Dry-run the deselection so the user sees the degradation before creating:
  // downstream stages whose inputs go absent, sections downgraded, etc.
  useEffect(() => {
    if (!workflowId || !scope || skipSelections.size === 0) {
      setSkipPreviewNote(null);
      setOverlaySummary(null);
      return;
    }
    let cancelled = false;
    workflowsService
      .executionPreview(workflowId, scope, project?.workflowVersion ?? undefined, [
        ...skipSelections,
      ])
      .then((preview) => {
        if (cancelled) return;
        // The overlay changes the run shape — keep the confirmation counts honest.
        setOverlaySummary(preview.plan?.summary ?? null);
        const absent = (preview.warnings ?? []).filter(
          (w) => w.code === 'scope_absent_consume',
        ).length;
        const degraded = (preview.warnings ?? []).some((w) => w.code === 'scope_absent_unit_dag');
        const parts: string[] = [];
        if (absent > 0)
          parts.push(`${absent} downstream input${absent === 1 ? '' : 's'} will be absent`);
        if (degraded) parts.push('parallel construction degrades to a single lane');
        setSkipPreviewNote(parts.length ? parts.join('; ') + '.' : null);
      })
      .catch(() => {
        if (!cancelled) setSkipPreviewNote(null);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- workflowVersion is pinned with the project
  }, [workflowId, scope, skipSelections]);

  const toggleSkip = (stageId: string) =>
    setSkipSelections((prev) => {
      const next = new Set(prev);
      if (next.has(stageId)) next.delete(stageId);
      else next.add(stageId);
      return next;
    });

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
    if (!prompt.trim() || !scope || !projectId) return;
    setCreating(true);
    setError(null);
    try {
      const baseBranches = Object.fromEntries(
        Object.entries(baseBranchSelections).filter(([, branch]) => branch),
      );
      const intent = await intentsService.create(projectId, {
        title: title.trim(),
        prompt: prompt.trim(),
        scope,
        baseBranches: Object.keys(baseBranches).length ? baseBranches : undefined,
        skipStageIds: skipSelections.size ? [...skipSelections] : undefined,
        source: source
          ? {
              bindingId: source.binding.id,
              resourceType: source.issue.resourceType,
              resourceId: source.issue.resourceId,
              resourceUrl: source.issue.resourceUrl,
            }
          : undefined,
      });
      navigate(`/project/${projectId}/intent/${intent.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create intent');
    } finally {
      setCreating(false);
    }
  };

  if (projectLoading) {
    return (
      <div className="mx-auto w-full max-w-5xl px-6 py-6 space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-[400px] rounded-lg" />
      </div>
    );
  }

  if (!project) {
    return (
      <div className="mx-auto w-full max-w-5xl px-6 py-6 text-sm text-destructive">
        Project not found
      </div>
    );
  }

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
                    className="underline hover:no-underline"
                  >
                    {source.issue.resourceId}
                  </a>
                ) : (
                  source.issue.resourceId
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
                required
                placeholder="Describe the intent in detail…"
                className="mt-1.5 w-full rounded-md border bg-background px-3 py-2 text-sm"
              />
            </div>

            <div>
              <Label htmlFor="intent-scope">Scope</Label>
              <Select
                value={scope}
                // Radix's hidden bubble-<select> can fire a native `change`
                // with an empty value when its `disabled` state flips (e.g.
                // scopeOptions arriving async right after mount) — guard
                // against silently blanking out an already-picked scope.
                onValueChange={(v) => {
                  if (v) setScope(v);
                }}
                disabled={scopeOptions.length === 0}
              >
                <SelectTrigger id="intent-scope" className="mt-1.5">
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
              <p className="mt-1.5 text-xs text-muted-foreground">
                Decides which stages execute (e.g. feature vs. bugfix). Comes from the workflow's
                compiled scopes.
              </p>
              {scope && (overlaySummary ?? scopeSummary) && (
                <p className="mt-1 text-xs text-foreground" data-testid="scope-summary">
                  {(() => {
                    // Exact counts read verbatim from the compiled plan
                    // (upstream 2.2.11) — the user confirms the real run
                    // shape, not a guess.
                    const s = (overlaySummary ?? scopeSummary)!;
                    const parts = [
                      `Runs ${s.executedStages} of ${s.totalStages} stages`,
                      `${s.approvalGates} approval gate${s.approvalGates === 1 ? '' : 's'}`,
                    ];
                    if (s.perUnitStages > 0) {
                      parts.push(
                        `${s.perUnitStages} stage${s.perUnitStages === 1 ? '' : 's'} fan${s.perUnitStages === 1 ? 's' : ''} out per unit of work`,
                      );
                    }
                    if (s.skippedStages > 0) {
                      parts.push(`${s.skippedStages} deselected`);
                    }
                    return parts.join(' · ');
                  })()}
                </p>
              )}
            </div>

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

            {skippingEnabled && (skipStagesLoading || skippableStages.length > 0) && (
              <div className="border rounded-md">
                <button
                  type="button"
                  onClick={() => setShowSkipStages((v) => !v)}
                  className="w-full flex items-center gap-1.5 px-3 py-2 text-sm font-medium"
                >
                  {showSkipStages ? (
                    <ChevronDown className="h-3.5 w-3.5" />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5" />
                  )}
                  Skip stages
                  {skipStagesLoading ? (
                    <span className="flex items-center gap-1.5 text-xs text-muted-foreground font-normal">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      loading stages for {scope}…
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground font-normal">
                      (optional —{' '}
                      {skipSelections.size ? `${skipSelections.size} skipped` : 'runs all'})
                    </span>
                  )}
                </button>
                {showSkipStages && (
                  <div className="px-3 pb-3 space-y-2">
                    <p className="text-xs text-muted-foreground">
                      Deselect CONDITIONAL stages this intent should skip. Required stages always
                      run; downstream stages treat a skipped stage's outputs as absent by design.
                    </p>
                    {skipStagesLoading ? (
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
                                skipSelections.has(s.stageId)
                                  ? 'line-through text-muted-foreground'
                                  : ''
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
                    {!skipStagesLoading && skipPreviewNote && (
                      <p className="flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-500">
                        <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                        {skipPreviewNote}
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}

            <div className="flex items-center gap-3 pt-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => navigate(`/project/${projectId}`)}
                disabled={creating}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={creating || !prompt.trim() || !scope}>
                {creating && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />}
                {creating ? 'Creating…' : 'Create Intent'}
              </Button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
