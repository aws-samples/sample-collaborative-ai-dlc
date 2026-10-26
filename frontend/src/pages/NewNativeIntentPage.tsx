import { useEffect, useEffectEvent, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import { ApiError } from '@/services/api';
import {
  nativeDraftInputRejected,
  nativeIntentsService,
  type NativeDraftRequest,
} from '@/services/nativeIntents';
import { currentSessionEpoch, isSessionExpiryNotified } from '@/services/sessionExpiry';
import { useNativeListingVersion } from '@/hooks/useNativeIntents';
import {
  workflowSourcesService,
  type WorkflowPackageHarness,
  type WorkflowPackagePreview,
} from '@/services/workflowSources';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSettingsNotice } from '@/components/intent/NativeSettingsNotice';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const UUID_V4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export default function NewNativeIntentPage() {
  const { projectId = '' } = useParams();
  const location = useLocation();
  const [query, setQuery] = useSearchParams();
  useNativeListingVersion();
  const sourceId = query.get('sourceId') ?? '';
  const packageJobId = query.get('packageJobId') ?? '';
  const bindingRevision = query.get('bindingRevision') ?? '';
  const draftId = query.get('draftId');
  // Our URL updates retain the form; navigation to another draft replaces it.
  const formKey = location.state?.nativeDraftFormKey ?? location.key;
  const setDraftId = (id: string | null) => {
    const next = new URLSearchParams(query);
    if (id) next.set('draftId', id);
    else next.delete('draftId');
    setQuery(next, {
      replace: true,
      state: { ...location.state, nativeDraftFormKey: formKey },
    });
  };
  if (isSessionExpiryNotified()) return <p>Sign in to create or recover a native draft.</p>;
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
      key={JSON.stringify([
        projectId,
        sourceId,
        packageJobId,
        bindingRevision,
        formKey,
        currentSessionEpoch(),
      ])}
      projectId={projectId}
      sourceId={sourceId}
      packageJobId={packageJobId}
      bindingRevision={bindingRevision}
      initialDraftId={draftId}
      setDraftId={setDraftId}
    />
  );
}

function NativeDraftForm({
  projectId,
  sourceId,
  packageJobId,
  bindingRevision,
  initialDraftId,
  setDraftId,
}: {
  projectId: string;
  sourceId: string;
  packageJobId: string;
  bindingRevision: string;
  initialDraftId: string | null;
  setDraftId: (id: string | null) => void;
}) {
  const navigate = useNavigate();
  const [recoveryId] = useState(initialDraftId);
  const navigateToDraft = useEffectEvent((id: string) =>
    navigate(`/space/${projectId}/native-intent/${id}`, { replace: true }),
  );
  const originalId = useRef(initialDraftId);
  const request = useRef<NativeDraftRequest | null>(null);
  const uncertain = useRef(false);
  const submitting = useRef(false);
  const active = useRef(false);
  const epoch = useRef(currentSessionEpoch());
  const isCurrent = () =>
    active.current && epoch.current === currentSessionEpoch() && !isSessionExpiryNotified();
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [harness, setHarness] = useState<WorkflowPackageHarness>('codex');
  const [preview, setPreview] = useState<WorkflowPackagePreview | null>(null);
  const [repository, setRepository] = useState('');
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [locked, setLocked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recoveryVersion, setRecoveryVersion] = useState(0);

  useEffect(() => {
    active.current = true;
    let cancelled = false;
    const current = () =>
      !cancelled && epoch.current === currentSessionEpoch() && !isSessionExpiryNotified();
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        if (recoveryId) {
          const existing = await nativeIntentsService.get(projectId, recoveryId);
          if (current()) navigateToDraft(existing.id);
          return;
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
        if (current()) {
          setPreview(job.package);
          setRepository(source.repository);
        }
      } catch (err) {
        if (current())
          setError(
            recoveryId && err instanceof ApiError && err.status === 404
              ? 'Draft creation is not confirmed. The original submitted fields are unavailable after navigation or reload. Refresh status to recover this draft.'
              : err instanceof Error
                ? err.message
                : 'Could not verify the selected package.',
          );
      } finally {
        if (current()) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      active.current = false;
    };
  }, [projectId, sourceId, packageJobId, bindingRevision, recoveryId, recoveryVersion]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!isCurrent() || submitting.current || !preview || (!title.trim() && !prompt.trim())) return;
    submitting.current = true;
    setCreating(true);
    setError(null);
    try {
      originalId.current ??= crypto.randomUUID();
      request.current ??= {
        intentId: originalId.current,
        title: title.trim(),
        prompt: prompt.trim(),
        harness,
        sourceId,
        packageJobId,
        bindingRevision,
      };
      // Keep the identity in the URL before POST. A reload first attempts to
      // recover that committed draft; a lost response cannot mint another run.
      setDraftId(request.current.intentId);
      setLocked(true);
      const draft = await nativeIntentsService.create(projectId, request.current);
      if (!isCurrent()) return;
      navigate(`/space/${projectId}/native-intent/${draft.id}`, { replace: true });
    } catch (err) {
      if (!isCurrent()) return;
      if (!uncertain.current && nativeDraftInputRejected(err)) {
        request.current = null;
        setLocked(false);
        // A reload may open a fresh form only after known non-acceptance.
        // In this form, corrections still reuse the original identity.
        setDraftId(null);
      } else {
        uncertain.current = true;
      }
      setError(
        err instanceof Error
          ? err.message
          : 'Draft creation could not be confirmed. Retry the same draft.',
      );
    } finally {
      submitting.current = false;
      if (isCurrent()) setCreating(false);
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
          Create a draft and prepare its isolated workspace. You can correct the request before
          Start. The selected methodology determines the workflow questions and approvals.
        </p>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {loading ? (
          <p role="status">Verifying the workflow package…</p>
        ) : recoveryId && !preview ? (
          <Button onClick={() => setRecoveryVersion((version) => version + 1)}>
            Refresh draft status
          </Button>
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
              <details className="rounded-md border p-3">
                <summary className="cursor-pointer text-sm font-medium">
                  Settings that apply to native execution
                </summary>
                <div className="mt-3">
                  <NativeSettingsNotice />
                </div>
              </details>
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
