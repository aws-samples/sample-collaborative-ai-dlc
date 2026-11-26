import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { ApiError } from '@/services/api';
import { nativeIntentsService, type NativeDraftRequest } from '@/services/nativeIntents';
import {
  workflowSourcesService,
  type WorkflowPackageHarness,
  type WorkflowPackagePreview,
} from '@/services/workflowSources';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const UUID_V4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export default function NewNativeIntentPage() {
  const { projectId = '' } = useParams();
  const [query] = useSearchParams();
  const sourceId = query.get('sourceId') ?? '';
  const packageJobId = query.get('packageJobId') ?? '';
  const bindingRevision = query.get('bindingRevision') ?? '';
  const draftId = query.get('draftId');
  if (
    !projectId ||
    !/^[a-f0-9]{64}$/.test(sourceId) ||
    !UUID.test(packageJobId) ||
    !UUID.test(bindingRevision) ||
    (draftId !== null && !UUID_V4.test(draftId))
  ) {
    return (
      <div className="space-y-3 p-4">
        <p>Select a verified workflow package to create a native intent.</p>
        <Link className="underline" to={`/space/${projectId}/settings?tab=agent`}>
          Open workflow sources
        </Link>
      </div>
    );
  }
  return (
    <NativeDraftForm
      key={JSON.stringify([projectId, sourceId, packageJobId, bindingRevision])}
      projectId={projectId}
      sourceId={sourceId}
      packageJobId={packageJobId}
      bindingRevision={bindingRevision}
      initialDraftId={draftId}
    />
  );
}

function NativeDraftForm({
  projectId,
  sourceId,
  packageJobId,
  bindingRevision,
  initialDraftId,
}: {
  projectId: string;
  sourceId: string;
  packageJobId: string;
  bindingRevision: string;
  initialDraftId: string | null;
}) {
  const navigate = useNavigate();
  const [query, setQuery] = useSearchParams();
  const originalId = useRef(initialDraftId);
  const request = useRef<NativeDraftRequest | null>(null);
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [harness, setHarness] = useState<WorkflowPackageHarness>('codex');
  const [preview, setPreview] = useState<WorkflowPackagePreview | null>(null);
  const [repository, setRepository] = useState('');
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [locked, setLocked] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        if (originalId.current) {
          try {
            const existing = await nativeIntentsService.get(projectId, originalId.current);
            if (active)
              navigate(`/space/${projectId}/native-intent/${existing.id}`, { replace: true });
            return;
          } catch (err) {
            if (!(err instanceof ApiError) || err.status !== 404) throw err;
          }
        }
        const [enabled, sources, job] = await Promise.all([
          nativeIntentsService.canPrepare(projectId),
          workflowSourcesService.list(projectId),
          workflowSourcesService.getPackageImport(projectId, sourceId, packageJobId),
        ]);
        const source = sources.find((item) => item.sourceId === sourceId);
        if (!enabled)
          throw new Error('Native workspace preparation is not enabled for this space.');
        if (
          source?.status !== 'active' ||
          source.revision !== bindingRevision ||
          job.state !== 'SUCCEEDED'
        ) {
          throw new Error(
            'The workflow source or package import changed. Select it again in space settings.',
          );
        }
        if (active) {
          setPreview(job.package);
          setRepository(source.repository);
        }
      } catch (err) {
        if (active)
          setError(err instanceof Error ? err.message : 'Could not verify the selected package.');
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [projectId, sourceId, packageJobId, bindingRevision, navigate]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (creating || !preview || (!title.trim() && !prompt.trim())) return;
    setCreating(true);
    setError(null);
    try {
      request.current ??= {
        intentId: originalId.current ?? crypto.randomUUID(),
        title: title.trim(),
        prompt: prompt.trim(),
        harness,
        sourceId,
        packageJobId,
        bindingRevision,
      };
      // Keep the identity in the URL before POST. A reload first attempts to
      // recover that committed draft; a lost response cannot mint another run.
      const next = new URLSearchParams(query);
      next.set('draftId', request.current.intentId);
      setQuery(next, { replace: true });
      setLocked(true);
      const draft = await nativeIntentsService.create(projectId, request.current);
      navigate(`/space/${projectId}/native-intent/${draft.id}`, { replace: true });
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Draft creation could not be confirmed. Retry the same draft.',
      );
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="mx-auto max-w-2xl space-y-5">
        <Link className="text-sm underline" to={`/space/${projectId}/settings?tab=agent`}>
          Back to workflow sources
        </Link>
        <h1 className="text-xl font-semibold">New native intent</h1>
        <p className="text-sm text-muted-foreground">
          Create a draft and prepare its isolated workspace. Starting the agent is a separate
          action; answers and approvals are not enabled in this pilot.
        </p>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {loading ? (
          <p role="status">Verifying the workflow package…</p>
        ) : (
          preview && (
            <form onSubmit={submit} className="space-y-4">
              <p className="text-sm">
                {repository} · {preview.release}
              </p>
              <div className="space-y-2">
                <Label htmlFor="native-intent-title">Title</Label>
                <Input
                  id="native-intent-title"
                  value={title}
                  disabled={locked}
                  onChange={(event) => setTitle(event.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="native-intent-prompt">What would you like to build?</Label>
                <textarea
                  id="native-intent-prompt"
                  className="min-h-40 w-full rounded-md border bg-background p-3 text-sm"
                  value={prompt}
                  disabled={locked}
                  onChange={(event) => setPrompt(event.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="native-intent-harness">Coding harness</Label>
                <select
                  id="native-intent-harness"
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                  value={harness}
                  disabled={locked}
                  onChange={(event) => setHarness(event.target.value as WorkflowPackageHarness)}
                >
                  <option value="claude">Claude Code</option>
                  <option value="codex">Codex</option>
                  <option value="kiro">Kiro</option>
                  <option value="opencode">OpenCode</option>
                </select>
              </div>
              <Button type="submit" disabled={creating || (!title.trim() && !prompt.trim())}>
                {creating ? 'Creating draft…' : locked ? 'Retry same draft' : 'Create native draft'}
              </Button>
            </form>
          )
        )}
      </div>
    </div>
  );
}
