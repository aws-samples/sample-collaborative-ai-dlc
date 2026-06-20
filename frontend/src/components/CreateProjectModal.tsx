import { useState } from 'react';
import { projectsService, type CreateProjectInput } from '../services/projects';
import { trackersService } from '../services/trackers';
import { useGitHubStatus } from '../hooks/useGitHubStatus';
import { useGitLabStatus } from '../hooks/useGitLabStatus';
import { GitHubConnectButton } from './GitHubConnectButton';
import { GitLabConnectButton } from './GitLabConnectButton';
import { GitHubRepoSelect } from './GitHubRepoSelect';
import { GitLabRepoSelect } from './GitLabRepoSelect';
import type { GitHubRepo } from '../services/github';
import type { GitLabRepo } from '../services/gitlab';

interface Props {
  onClose: () => void;
  onCreated: () => void;
}

const repoShortName = (fullName: string) => fullName.split('/').pop() || '';

export function CreateProjectModal({ onClose, onCreated }: Props) {
  const {
    status: githubStatus,
    loading: githubStatusLoading,
    error: githubStatusError,
    refresh: githubRefresh,
  } = useGitHubStatus();
  const {
    status: gitlabStatus,
    loading: gitlabStatusLoading,
    error: gitlabStatusError,
    refresh: gitlabRefresh,
  } = useGitLabStatus();
  const [step, setStep] = useState(1);
  const [selectedRepos, setSelectedRepos] = useState<string[]>([]);
  const [primaryRepo, setPrimaryRepo] = useState<string>('');
  const [formData, setFormData] = useState<CreateProjectInput>({
    name: '',
    gitProvider: 'github',
    gitRepo: '',
    issueIntegrationEnabled: false,
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const handleReposChange = (repos: GitHubRepo[] | GitLabRepo[]) => {
    const fullNames = repos.map((r) => r.fullName);
    setSelectedRepos(fullNames);
    applyPrimaryRepo(
      fullNames.length === 0 ? '' : fullNames.includes(primaryRepo) ? primaryRepo : fullNames[0],
    );
  };

  const handleProviderChange = (provider: 'github' | 'gitlab') => {
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
      const input: CreateProjectInput = {
        ...formData,
        repos: selectedRepos.map((url) => ({
          url,
          role: url === primaryRepo ? ('primary' as const) : ('secondary' as const),
        })),
      };
      const project = await projectsService.create(input);
      if (formData.issueIntegrationEnabled && formData.gitRepo) {
        // GitHub and GitLab issues both reuse the project's git connection.
        const trackerProvider =
          formData.gitProvider === 'gitlab' ? 'gitlab-issues' : 'github-issues';
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

  const canProceedStep1 =
    formData.gitProvider === 'github' ? githubStatus?.connected : gitlabStatus?.connected;
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

        {/* Step 1: Connect Git Provider */}
        {step === 1 && (
          <div>
            <h3 className="font-medium mb-3 text-gray-900 dark:text-white">Choose Git Provider</h3>
            <div className="flex gap-2 mb-4">
              <button
                type="button"
                onClick={() => handleProviderChange('github')}
                className={`flex-1 px-3 py-2 rounded border text-sm font-medium ${
                  formData.gitProvider === 'github'
                    ? 'border-indigo-600 bg-indigo-50 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300 dark:border-indigo-500'
                    : 'border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700'
                }`}
              >
                GitHub
              </button>
              <button
                type="button"
                onClick={() => handleProviderChange('gitlab')}
                className={`flex-1 px-3 py-2 rounded border text-sm font-medium ${
                  formData.gitProvider === 'gitlab'
                    ? 'border-indigo-600 bg-indigo-50 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300 dark:border-indigo-500'
                    : 'border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700'
                }`}
              >
                GitLab
              </button>
            </div>
            {formData.gitProvider === 'github' && (
              <>
                {githubStatusError && (
                  <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded mb-4 text-sm">
                    {githubStatusError}
                  </div>
                )}
                {githubStatusLoading ? (
                  <p className="text-sm text-gray-500 dark:text-gray-400">Checking connection...</p>
                ) : (
                  <GitHubConnectButton
                    connected={githubStatus?.connected || false}
                    onDisconnect={githubRefresh}
                  />
                )}
              </>
            )}
            {formData.gitProvider === 'gitlab' && (
              <>
                {gitlabStatusError && (
                  <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded mb-4 text-sm">
                    {gitlabStatusError}
                  </div>
                )}
                {gitlabStatusLoading ? (
                  <p className="text-sm text-gray-500 dark:text-gray-400">Checking connection...</p>
                ) : (
                  <GitLabConnectButton
                    connected={gitlabStatus?.connected || false}
                    onDisconnect={gitlabRefresh}
                  />
                )}
              </>
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

        {/* Step 2: Select Repositories */}
        {step === 2 && (
          <div>
            <h3 className="font-medium mb-1 text-gray-900 dark:text-white">Select Repositories</h3>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
              Choose one or more repositories. The primary repo drives issue integration and project
              naming.
            </p>
            {formData.gitProvider === 'github' ? (
              <GitHubRepoSelect multiple value={selectedRepos} onChange={handleReposChange} />
            ) : (
              <GitLabRepoSelect multiple value={selectedRepos} onChange={handleReposChange} />
            )}
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
        {step === 3 && (
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
                disabled={submitting}
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
