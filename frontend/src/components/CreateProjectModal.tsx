import { useState, useEffect } from 'react';
import { Github, Gitlab } from 'lucide-react';
import { projectsService, type CreateProjectInput, type ProjectKind } from '../services/projects';
import { workflowsService, type WorkflowSummary } from '../services/workflows';
import { trackersService } from '../services/trackers';
import { useGitProviderStatus } from '../hooks/useGitProviderStatus';
import { GitConnectButton } from './GitConnectButton';
import { GitRepoSelect } from './GitRepoSelect';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { trackerIdForGitProvider, type GitProvider, type GitRepo } from '../services/gitProvider';

interface Props {
  onClose: () => void;
  onCreated: () => void;
  // Provider to preselect — used to restore the user's choice after an OAuth
  // round-trip (the redirect to the provider and back resets in-memory state).
  // Empty string (the default) leaves the provider UNSELECTED so opening the
  // modal does not trigger a connection check / OAuth login until the user picks.
  initialProvider?: GitProvider | '';
}

const repoShortName = (fullName: string) => fullName.split('/').pop() || '';

// Local form shape: gitProvider may be '' before the user selects one.
type ProjectForm = Omit<CreateProjectInput, 'gitProvider'> & { gitProvider: GitProvider | '' };

export function CreateProjectModal({ onClose, onCreated, initialProvider = '' }: Props) {
  const [step, setStep] = useState(1);
  const [selectedRepos, setSelectedRepos] = useState<string[]>([]);
  const [primaryRepo, setPrimaryRepo] = useState<string>('');
  const [formData, setFormData] = useState<ProjectForm>({
    name: '',
    gitProvider: initialProvider,
    gitRepo: '',
    issueIntegrationEnabled: false,
  });
  // Only the selected provider's connection status is needed — the modal shows
  // one provider at a time. Switching providers re-fetches via the hook's
  // provider-keyed effect.
  const {
    status: gitStatus,
    loading: gitStatusLoading,
    error: gitStatusError,
    refresh: gitRefresh,
  } = useGitProviderStatus(formData.gitProvider);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // v2 project options. `kind` defaults to v1; choosing v2 reveals the workflow
  // + scope settings in step 3. Park release is tuned later in project settings.
  const [kind, setKind] = useState<ProjectKind>('v1');
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [workflowId, setWorkflowId] = useState<string>('');
  // Scope vocabulary MUST come from the chosen workflow's compiled scope grid —
  // a free-typed scope would be rejected by buildExecutionPlan at run time.
  const [scopeOptions, setScopeOptions] = useState<string[]>([]);
  const [scope, setScope] = useState<string>('');
  const [v2Loading, setV2Loading] = useState(false);
  const [v2Error, setV2Error] = useState<string | null>(null);

  // Load the workflow catalog once the user opts into a v2 project.
  useEffect(() => {
    if (kind !== 'v2' || workflows.length > 0) return;
    let cancelled = false;
    setV2Loading(true);
    setV2Error(null);
    workflowsService
      .list()
      .then(({ workflows: list }) => {
        if (cancelled) return;
        setWorkflows(list);
        // Prefer the canonical aidlc-v2 workflow if present.
        const preferred = list.find((w) => w.workflowId === 'aidlc-v2') ?? list[0];
        if (preferred) setWorkflowId(preferred.workflowId);
      })
      .catch((err) => {
        if (!cancelled) setV2Error(err instanceof Error ? err.message : 'Failed to load workflows');
      })
      .finally(() => {
        if (!cancelled) setV2Loading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [kind, workflows.length]);

  // When a workflow is chosen, fetch its compiled scope grid for the scope picker.
  useEffect(() => {
    if (kind !== 'v2' || !workflowId) return;
    let cancelled = false;
    setV2Loading(true);
    setV2Error(null);
    workflowsService
      .compiled(workflowId)
      .then((compiled) => {
        if (cancelled) return;
        const scopes = Object.keys(compiled.scopeGrid ?? {});
        setScopeOptions(scopes);
        setScope((prev) => (prev && scopes.includes(prev) ? prev : (scopes[0] ?? '')));
      })
      .catch((err) => {
        if (!cancelled)
          setV2Error(err instanceof Error ? err.message : 'Failed to load workflow scopes');
      })
      .finally(() => {
        if (!cancelled) setV2Loading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [kind, workflowId]);

  const applyPrimaryRepo = (nextPrimary: string) => {
    const prevPrimaryName = repoShortName(primaryRepo);
    const nextPrimaryName = repoShortName(nextPrimary);
    setPrimaryRepo(nextPrimary);
    setFormData((prev) => ({
      ...prev,
      gitRepo: nextPrimary,
      name: prev.name === '' || prev.name === prevPrimaryName ? nextPrimaryName : prev.name,
    }));
  };

  const handleReposChange = (repos: GitRepo[]) => {
    const fullNames = repos.map((r) => r.fullName);
    setSelectedRepos(fullNames);
    applyPrimaryRepo(
      fullNames.length === 0 ? '' : fullNames.includes(primaryRepo) ? primaryRepo : fullNames[0],
    );
  };

  const handleProviderChange = (provider: GitProvider) => {
    setFormData((prev) => ({ ...prev, gitProvider: provider, gitRepo: '' }));
    setSelectedRepos([]);
    setPrimaryRepo('');
  };

  const handleSetPrimary = (repoFullName: string) => {
    applyPrimaryRepo(repoFullName);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (selectedRepos.length > 0 && !selectedRepos.includes(primaryRepo)) {
      setError('Select exactly one primary repository.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const gitProvider = formData.gitProvider;
      if (!gitProvider) {
        setError('Select a git provider.');
        setSubmitting(false);
        return;
      }
      if (kind === 'v2' && (!workflowId || !scope)) {
        setError('Select a workflow and scope for the v2 project.');
        setSubmitting(false);
        return;
      }
      const input: CreateProjectInput = {
        ...formData,
        gitProvider,
        repos: selectedRepos.map((url) => ({
          url,
          role: url === primaryRepo ? ('primary' as const) : ('secondary' as const),
        })),
        ...(kind === 'v2' ? { kind: 'v2' as const, workflowId, scope } : { kind: 'v1' as const }),
      };
      const project = await projectsService.create(input);
      if (formData.issueIntegrationEnabled && formData.gitRepo) {
        // GitHub and GitLab issues both reuse the project's git connection.
        const trackerProvider = trackerIdForGitProvider(gitProvider);
        try {
          await trackersService.addToProject(project.id, {
            provider: trackerProvider,
            instance: 'public',
            externalProjectKey: formData.gitRepo,
            displayName: formData.gitRepo,
          });
        } catch (err) {
          console.error(`Failed to add ${trackerProvider} tracker:`, err);
        }
      }
      onCreated();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create project');
    } finally {
      setSubmitting(false);
    }
  };

  const canProceedStep1 = gitStatus?.connected;
  const canProceedStep2 = selectedRepos.length > 0;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white dark:bg-gray-800 rounded-lg p-6 max-w-md w-full mx-4">
        <h2 className="text-xl font-semibold mb-4 text-gray-900 dark:text-white">
          Create New Project
        </h2>

        {/* Step Indicator */}
        <div className="flex items-center gap-2 mb-6">
          {[1, 2, 3].map((s) => (
            <div key={s} className="flex items-center">
              <div
                className={`w-8 h-8 rounded-full flex items-center justify-center text-sm ${
                  step === s
                    ? 'bg-indigo-600 text-white'
                    : step > s
                      ? 'bg-green-500 text-white'
                      : 'bg-gray-200 dark:bg-gray-600 dark:text-gray-300'
                }`}
              >
                {step > s ? '✓' : s}
              </div>
              {s < 3 && (
                <div
                  className={`w-8 h-0.5 ${step > s ? 'bg-green-500' : 'bg-gray-200 dark:bg-gray-600'}`}
                />
              )}
            </div>
          ))}
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded mb-4">
            {error}
          </div>
        )}

        {/* Step 1: Project type + Connect Git Provider */}
        {step === 1 && (
          <div>
            <label className="block font-medium mb-1 text-gray-900 dark:text-white">
              Project Type
            </label>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
              v1 runs the classic sprint lifecycle. v2 runs the AI-DLC v2 workflow runtime (intents,
              dynamic phases &amp; stages). This can't be changed later.
            </p>
            <div className="grid grid-cols-2 gap-2 mb-4">
              {(['v1', 'v2'] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setKind(k)}
                  className={`rounded border px-3 py-2 text-left text-sm transition-colors ${
                    kind === k
                      ? 'border-indigo-600 bg-indigo-50 dark:bg-indigo-900/30 text-gray-900 dark:text-white'
                      : 'border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'
                  }`}
                >
                  <span className="font-medium uppercase">{k}</span>
                  <span className="block text-[11px] text-gray-500 dark:text-gray-400">
                    {k === 'v1' ? 'Sprint lifecycle' : 'AI-DLC v2 workflow'}
                  </span>
                </button>
              ))}
            </div>

            <label
              htmlFor="git-provider-select"
              className="block font-medium mb-1 text-gray-900 dark:text-white"
            >
              Choose Git Provider
            </label>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
              A project connects to a single git provider.
            </p>
            <Select
              value={formData.gitProvider}
              onValueChange={(v) => handleProviderChange(v as GitProvider)}
            >
              <SelectTrigger id="git-provider-select" className="mb-4">
                <SelectValue placeholder="Select a git provider" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="github">
                  <span className="flex items-center gap-2">
                    <Github />
                    GitHub
                  </span>
                </SelectItem>
                <SelectItem value="gitlab">
                  <span className="flex items-center gap-2">
                    <Gitlab />
                    GitLab
                  </span>
                </SelectItem>
              </SelectContent>
            </Select>
            {gitStatusError && (
              <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded mb-4 text-sm">
                {gitStatusError}
              </div>
            )}
            {!formData.gitProvider ? (
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Select a git provider to continue.
              </p>
            ) : gitStatusLoading ? (
              <p className="text-sm text-gray-500 dark:text-gray-400">Checking connection...</p>
            ) : (
              <GitConnectButton
                provider={formData.gitProvider}
                connected={gitStatus?.connected || false}
                onDisconnect={gitRefresh}
              />
            )}
            <div className="flex justify-end gap-2 mt-6">
              <button
                onClick={onClose}
                className="px-4 py-2 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded"
              >
                Cancel
              </button>
              <button
                onClick={() => setStep(2)}
                disabled={!canProceedStep1}
                className="px-4 py-2 bg-indigo-600 text-white rounded hover:bg-indigo-700 disabled:opacity-50"
              >
                Next
              </button>
            </div>
          </div>
        )}

        {/* Step 2: Select Repositories (provider is always set past step 1) */}
        {step === 2 && formData.gitProvider && (
          <div>
            <h3 className="font-medium mb-1 text-gray-900 dark:text-white">Select Repositories</h3>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
              Choose one or more repositories. The primary repo drives issue integration and project
              naming.
            </p>
            <GitRepoSelect
              provider={formData.gitProvider}
              multiple
              value={selectedRepos}
              onChange={handleReposChange}
            />
            {selectedRepos.length > 1 && (
              <div className="mt-3 border dark:border-gray-600 rounded divide-y dark:divide-gray-600">
                <div className="px-3 py-1.5 bg-gray-50 dark:bg-gray-700">
                  <span className="text-[10px] font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                    Designate primary
                  </span>
                </div>
                {selectedRepos.map((repo) => (
                  <label
                    key={repo}
                    className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700"
                  >
                    <input
                      type="radio"
                      name="primaryRepo"
                      checked={primaryRepo === repo}
                      onChange={() => handleSetPrimary(repo)}
                      className="accent-indigo-600"
                    />
                    <span className="text-sm text-gray-900 dark:text-gray-100 truncate flex-1">
                      {repo}
                    </span>
                    {primaryRepo === repo && (
                      <span className="text-[10px] font-medium bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300 px-1.5 py-0.5 rounded">
                        primary
                      </span>
                    )}
                  </label>
                ))}
              </div>
            )}
            <div className="flex justify-end gap-2 mt-6">
              <button
                onClick={() => setStep(1)}
                className="px-4 py-2 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded"
              >
                Back
              </button>
              <button
                onClick={() => setStep(3)}
                disabled={!canProceedStep2}
                className="px-4 py-2 bg-indigo-600 text-white rounded hover:bg-indigo-700 disabled:opacity-50"
              >
                Next
              </button>
            </div>
          </div>
        )}

        {/* Step 3: Project Details */}
        {step === 3 && formData.gitProvider && (
          <form onSubmit={handleSubmit}>
            <h3 className="font-medium mb-3 text-gray-900 dark:text-white">Project Details</h3>
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Project Name
              </label>
              <input
                type="text"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                className="w-full border dark:border-gray-600 rounded px-3 py-2 bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                required
                disabled={submitting}
              />
            </div>
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                {selectedRepos.length > 1 ? 'Primary Repository' : 'Repository'}
              </label>
              <input
                type="text"
                value={formData.gitRepo}
                className="w-full border dark:border-gray-600 rounded px-3 py-2 bg-gray-50 dark:bg-gray-900 text-gray-900 dark:text-white"
                disabled
              />
              {selectedRepos.length > 1 && (
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                  +{selectedRepos.length - 1} additional repositor
                  {selectedRepos.length - 1 === 1 ? 'y' : 'ies'}
                </p>
              )}
            </div>
            {(formData.gitProvider === 'github' || formData.gitProvider === 'gitlab') && (
              <div className="mb-4">
                <label className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={formData.issueIntegrationEnabled ?? false}
                    onChange={(e) =>
                      setFormData({ ...formData, issueIntegrationEnabled: e.target.checked })
                    }
                    className="mt-0.5"
                    disabled={submitting}
                  />
                  <span className="text-sm text-gray-700 dark:text-gray-300">
                    <span className="font-medium">
                      Enable {formData.gitProvider === 'gitlab' ? 'GitLab' : 'GitHub'} issue
                      integration
                    </span>
                    <span className="block text-xs text-gray-500 dark:text-gray-400">
                      Browse issues on the project page and start sprints from them.
                      {selectedRepos.length > 1 ? ' Applies to the primary repository only.' : ''}
                    </span>
                  </span>
                </label>
              </div>
            )}
            {kind === 'v2' && (
              <div className="mb-4 rounded border border-indigo-200 dark:border-indigo-800 bg-indigo-50/50 dark:bg-indigo-900/20 p-3 space-y-3">
                <p className="text-xs font-medium uppercase tracking-wide text-indigo-700 dark:text-indigo-300">
                  AI-DLC v2 settings
                </p>
                {v2Error && <p className="text-xs text-red-600 dark:text-red-400">{v2Error}</p>}
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Workflow
                  </label>
                  <Select value={workflowId} onValueChange={setWorkflowId} disabled={submitting}>
                    <SelectTrigger>
                      <SelectValue placeholder={v2Loading ? 'Loading…' : 'Select a workflow'} />
                    </SelectTrigger>
                    <SelectContent>
                      {workflows.map((w) => (
                        <SelectItem key={w.workflowId} value={w.workflowId}>
                          {w.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Scope
                  </label>
                  <Select
                    value={scope}
                    onValueChange={setScope}
                    disabled={submitting || scopeOptions.length === 0}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder={v2Loading ? 'Loading…' : 'Select a scope'} />
                    </SelectTrigger>
                    <SelectContent>
                      {scopeOptions.map((s) => (
                        <SelectItem key={s} value={s}>
                          {s}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                    Decides which stages execute. Comes from the workflow's compiled scopes.
                  </p>
                </div>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  Park release and other runtime settings can be tuned later in project settings.
                </p>
              </div>
            )}
            <div className="flex justify-end gap-2 mt-6">
              <button
                type="button"
                onClick={() => setStep(2)}
                className="px-4 py-2 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded"
                disabled={submitting}
              >
                Back
              </button>
              <button
                type="submit"
                className="px-4 py-2 bg-indigo-600 text-white rounded hover:bg-indigo-700 disabled:opacity-50"
                disabled={submitting || (kind === 'v2' && (!workflowId || !scope))}
              >
                {submitting ? 'Creating...' : 'Create Project'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
