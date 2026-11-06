import {
  NativeApplicationSourcePicker,
  nativeApplicationRepositories,
  nativeRepositoryKey,
} from './NativeApplicationSourcePicker';
import { useEffect, useEffectEvent, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { ApiError } from '@/services/api';
import type { Project } from '@/services/projects';
import {
  nativeDraftInputRejected,
  nativeIntentsService,
  nativeStartUnavailableMessages,
  type NativeCapabilities,
  type NativeDraftRequest,
  type NativeIntent,
} from '@/services/nativeIntents';
import { discoveryPath } from '@/lib/intentDiscovery';
import { currentSessionEpoch, isSessionExpiryNotified } from '@/services/sessionExpiry';
import {
  workflowSourcesService,
  type WorkflowPackageHarness,
  type WorkflowPackageJob,
  type WorkflowSource,
} from '@/services/workflowSources';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { WorkflowSourcesSection } from '@/components/project-settings/WorkflowSourcesSection';
import { IntentRequestFields } from './IntentRequestFields';
import { NativeSettingsNotice } from './NativeSettingsNotice';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const UUID_V4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HARNESSES = { claude: 'Claude Code', codex: 'Codex', kiro: 'Kiro', opencode: 'OpenCode' };
type PackageJob = Extract<WorkflowPackageJob, { state: 'SUCCEEDED' }>;
interface Selection {
  source: WorkflowSource;
  job: PackageJob;
}
interface Props {
  project: Project;
  title: string;
  prompt: string;
  onTitleChange: (value: string) => void;
  onPromptChange: (value: string) => void;
  onLockedChange: (locked: boolean) => void;
  query: URLSearchParams;
  replaceQuery: (changes: Record<string, string | null>) => void;
}

export function NativeIntentCreation({
  project,
  title,
  prompt,
  onTitleChange,
  onPromptChange,
  onLockedChange,
  query,
  replaceQuery,
}: Props) {
  const projectId = project.id;
  const navigate = useNavigate();
  // Our query updates retain the form. A real navigation replaces it.
  const [initial] = useState(() => ({
    draftId: query.get('draftId'),
    sourceId: query.get('sourceId'),
    packageJobId: query.get('packageJobId'),
    bindingRevision: query.get('bindingRevision'),
  }));
  const navigateToDraft = useEffectEvent((intent: NativeIntent) =>
    navigate(discoveryPath(projectId, { backend: 'native', intent }), { replace: true }),
  );
  const originalId = useRef(initial.draftId);
  const request = useRef<NativeDraftRequest | null>(null);
  const uncertain = useRef(false);
  const submitting = useRef(false);
  const active = useRef(false);
  const epoch = useRef(currentSessionEpoch());
  const isCurrent = () =>
    active.current && epoch.current === currentSessionEpoch() && !isSessionExpiryNotified();
  const [harness, setHarness] = useState<WorkflowPackageHarness>('codex');
  const [selection, setSelection] = useState<Selection | null>(null);
  const [capabilities, setCapabilities] = useState<NativeCapabilities | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [locked, setLocked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recoveryVersion, setRecoveryVersion] = useState(0);
  const repos = nativeApplicationRepositories(project.repos);
  const repoKey = nativeRepositoryKey;
  const [selectedRepo, setSelectedRepo] = useState(() =>
    repos.length === 1 ? repoKey(repos[0]) : '',
  );
  const repository = repos.find((repo) => repoKey(repo) === selectedRepo);

  useEffect(() => {
    active.current = true;
    let cancelled = false;
    const current = () =>
      !cancelled && epoch.current === currentSessionEpoch() && !isSessionExpiryNotified();
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        if (initial.draftId !== null) {
          if (!UUID_V4.test(initial.draftId)) throw new Error('The draft identity is invalid.');
          const existing = await nativeIntentsService.get(projectId, initial.draftId);
          if (current()) navigateToDraft(existing);
          return;
        }
        const availability = await nativeIntentsService.capabilities(projectId);
        if (!availability.preparationEnabled) {
          throw new Error('Native workspace preparation is not enabled for this space.');
        }
        if (current()) setCapabilities(availability);
        if (initial.sourceId || initial.packageJobId || initial.bindingRevision) {
          if (
            !/^[a-f0-9]{64}$/.test(initial.sourceId ?? '') ||
            !UUID.test(initial.packageJobId ?? '') ||
            !UUID.test(initial.bindingRevision ?? '')
          ) {
            throw new Error('Select a verified workflow package below.');
          }
          const [sources, job] = await Promise.all([
            workflowSourcesService.list(projectId),
            workflowSourcesService.getPackageImport(
              projectId,
              initial.sourceId!,
              initial.packageJobId!,
            ),
          ]);
          const source = sources.find((item) => item.sourceId === initial.sourceId);
          if (
            source?.status !== 'active' ||
            source.revision !== initial.bindingRevision ||
            job.state !== 'SUCCEEDED'
          ) {
            throw new Error(
              'The workflow source or package import changed. Select it again below.',
            );
          }
          if (job.package.version !== '2.11.1') {
            throw new Error(
              'Native creation currently supports AI-DLC 2.11.1. Select that release.',
            );
          }
          if (current()) setSelection({ source, job });
        }
      } catch (err) {
        if (current()) {
          setError(
            initial.draftId && err instanceof ApiError && err.status === 404
              ? 'Draft creation is not confirmed. The original submitted fields are unavailable after navigation or reload. Refresh status to recover this draft.'
              : err instanceof Error
                ? err.message
                : 'Could not verify native creation availability.',
          );
        }
      } finally {
        if (current()) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      active.current = false;
    };
  }, [projectId, initial, recoveryVersion]);

  const selectPackage = (source: WorkflowSource, job: PackageJob) => {
    if (!isCurrent() || locked || submitting.current) return;
    if (job.package.version !== '2.11.1') {
      setError('Native creation currently supports AI-DLC 2.11.1. Select that release.');
      return;
    }
    setSelection({ source, job });
    setError(null);
    replaceQuery({
      sourceId: source.sourceId,
      packageJobId: job.jobId,
      bindingRevision: source.revision,
    });
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (
      !isCurrent() ||
      submitting.current ||
      !selection ||
      !repository ||
      !capabilities?.preparationEnabled ||
      capabilities.unavailableHarnesses[harness] ||
      (!title.trim() && !prompt.trim())
    )
      return;
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
        sourceId: selection.source.sourceId,
        packageJobId: selection.job.jobId,
        bindingRevision: selection.source.revision,
        applicationSource: {
          provider: repository.provider as NonNullable<
            NativeDraftRequest['applicationSource']
          >['provider'],
          repository: repository.url,
        },
      };
      // Save the identity before POST. Reload only reads it; an uncertain
      // response never substitutes another request or application repository.
      replaceQuery({ draftId: request.current.intentId });
      setLocked(true);
      onLockedChange(true);
      const draft = await nativeIntentsService.create(projectId, request.current);
      if (isCurrent()) navigateToDraft(draft);
    } catch (err) {
      if (!isCurrent()) return;
      if (!uncertain.current && nativeDraftInputRejected(err)) {
        request.current = null;
        setLocked(false);
        onLockedChange(false);
        replaceQuery({ draftId: null });
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
    <div className="mx-auto max-w-2xl space-y-5">
      <p className="text-sm text-muted-foreground">
        Create a draft, correct its prompt and prepare its workspace before Start. AI-DLC owns the
        workflow questions and approvals. Native creation currently supports AI-DLC 2.11.1.
      </p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {loading ? (
        <p role="status">{initial.draftId ? 'Recovering draft…' : 'Checking native creation…'}</p>
      ) : initial.draftId !== null ? (
        <Button onClick={() => setRecoveryVersion((version) => version + 1)}>
          Refresh draft status
        </Button>
      ) : (
        capabilities && (
          <>
            {selection ? (
              <section
                className="space-y-2 rounded-md border p-4"
                aria-label="Selected workflow package"
              >
                <h2 className="text-sm font-semibold">Workflow package</h2>
                <p className="text-sm">
                  {selection.source.repository} · {selection.job.package.release}
                </p>
                <p className="text-xs text-muted-foreground">
                  Download verified · {selection.job.package.commit}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={locked}
                  onClick={() => {
                    setSelection(null);
                    replaceQuery({ sourceId: null, packageJobId: null, bindingRevision: null });
                  }}
                >
                  Choose another package
                </Button>
              </section>
            ) : (
              <WorkflowSourcesSection
                projectId={projectId}
                canEdit={project.userRole === 'owner' || project.userRole === 'admin'}
                defaultRelease="v2.11.1"
                onSelectPackage={selectPackage}
              />
            )}
            <form onSubmit={submit} className="space-y-4">
              <IntentRequestFields
                title={title}
                prompt={prompt}
                onTitleChange={onTitleChange}
                onPromptChange={onPromptChange}
                disabled={locked}
              />
              <NativeApplicationSourcePicker
                repos={project.repos}
                value={repository ? selectedRepo : ''}
                disabled={locked}
                onChange={setSelectedRepo}
              />
              <div className="space-y-2">
                <Label htmlFor="native-intent-harness">Coding harness</Label>
                <select
                  id="native-intent-harness"
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                  value={harness}
                  disabled={locked}
                  aria-describedby="native-harness-availability"
                  onChange={(event) => {
                    const next = event.target.value as WorkflowPackageHarness;
                    if (Object.hasOwn(HARNESSES, next) && !capabilities.unavailableHarnesses[next])
                      setHarness(next);
                  }}
                >
                  {Object.entries(HARNESSES).map(([value, label]) => (
                    <option
                      key={value}
                      value={value}
                      disabled={Boolean(
                        capabilities.unavailableHarnesses[value as WorkflowPackageHarness],
                      )}
                    >
                      {label}
                      {value === 'kiro' && capabilities.unavailableHarnesses.kiro
                        ? ' (temporarily unavailable)'
                        : ''}
                    </option>
                  ))}
                </select>
                <div id="native-harness-availability" className="text-sm text-muted-foreground">
                  {Object.entries(capabilities.unavailableHarnesses).map(
                    ([unavailableHarness, reason]) => (
                      <p key={unavailableHarness}>{nativeStartUnavailableMessages[reason]}</p>
                    ),
                  )}
                </div>
              </div>
              <details className="rounded-md border p-3">
                <summary className="cursor-pointer text-sm font-medium">
                  Settings that apply to native execution
                </summary>
                <div className="mt-3">
                  <NativeSettingsNotice />
                </div>
              </details>
              <Button
                type="submit"
                disabled={
                  creating ||
                  !selection ||
                  !repository ||
                  Boolean(capabilities.unavailableHarnesses[harness]) ||
                  (!title.trim() && !prompt.trim())
                }
              >
                {creating ? 'Creating draft…' : locked ? 'Retry same draft' : 'Create native draft'}
              </Button>
            </form>
          </>
        )
      )}
    </div>
  );
}
