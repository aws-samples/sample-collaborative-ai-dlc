import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useProjectCache } from '@/hooks/useProjectsCache';
import { intentsService } from '@/services/intents';
import { trackersService, type TrackerIssue } from '@/services/trackers';
import type { TrackerBinding } from '@/services/projects';
import { workflowsService } from '@/services/workflows';
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
import { AlertCircle, ArrowLeft, Loader2, X } from 'lucide-react';

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

  const hasTrackers = (project?.trackers.length ?? 0) > 0;

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
      const intent = await intentsService.create(projectId, {
        title: title.trim(),
        prompt: prompt.trim(),
        scope,
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
              <Select value={scope} onValueChange={setScope} disabled={scopeOptions.length === 0}>
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
            </div>

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
