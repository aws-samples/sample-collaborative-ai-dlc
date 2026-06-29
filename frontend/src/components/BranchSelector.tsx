import { useState, useEffect } from 'react';
import { getGitProviderService, type GitProvider } from '@/services/gitProvider';

interface BranchSelectorProps {
  provider: GitProvider;
  gitRepo: string;
  onSelect: (branch: string, baseBranch: string) => void;
  onCancel: () => void;
  /** Modal heading text. Defaults to "Select Branch for Construction". */
  title?: string;
  /** Submit button label. Defaults to "Start Construction". */
  submitLabel?: string;
  /** When true the "Use existing branch" radio is pre-selected. */
  defaultUseExisting?: boolean;
}

export function BranchSelector({
  provider,
  gitRepo,
  onSelect,
  onCancel,
  title = 'Select Branch for Construction',
  submitLabel = 'Start Construction',
  defaultUseExisting = false,
}: BranchSelectorProps) {
  const [branches, setBranches] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedBase, setSelectedBase] = useState('main');
  const [newBranchName, setNewBranchName] = useState('');
  const [useExisting, setUseExisting] = useState(defaultUseExisting);
  const [selectedExisting, setSelectedExisting] = useState('');

  useEffect(() => {
    loadBranches();
  }, [gitRepo, provider]);

  const loadBranches = async () => {
    if (!gitRepo) return;

    try {
      setLoading(true);
      const data = await getGitProviderService(provider).listBranches(gitRepo);
      const branchNames = data.branches || [];
      setBranches(branchNames);

      if (branchNames.includes('main')) {
        setSelectedBase('main');
      } else if (branchNames.includes('master')) {
        setSelectedBase('master');
      } else if (branchNames.length > 0) {
        setSelectedBase(branchNames[0]);
      }

      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load branches');
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    if (useExisting) {
      if (!selectedExisting) {
        setError('Please select an existing branch');
        return;
      }
      onSelect(selectedExisting, selectedBase);
    } else {
      if (!newBranchName.trim()) {
        setError('Please enter a branch name');
        return;
      }
      // Generate branch name with timestamp
      const branchName = `ai-dlc/${newBranchName.trim().toLowerCase().replace(/\s+/g, '-')}-${Date.now()}`;
      onSelect(branchName, selectedBase);
    }
  };

  const inputClasses =
    'w-full px-3 py-2 border border-input rounded bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring';

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-card rounded-lg p-6 max-w-md w-full mx-4 border shadow-lg">
        <h2 className="text-xl font-semibold mb-4">{title}</h2>

        {error && (
          <div className="bg-destructive/10 border border-destructive/30 text-destructive px-4 py-3 rounded mb-4">
            {error}
          </div>
        )}

        {loading ? (
          <div className="text-center py-8 text-muted-foreground">Loading branches...</div>
        ) : (
          <form onSubmit={handleSubmit}>
            {/* Empty repo notice */}
            {branches.length === 0 && (
              <div className="mb-4 p-3 bg-blue-500/10 border border-blue-500/30 rounded text-sm text-blue-600 dark:text-blue-400">
                <p className="font-medium">Empty Repository Detected</p>
                <p className="mt-1">
                  The agent will create an initial commit on the base branch before starting
                  construction.
                </p>
              </div>
            )}

            {/* Branch Type Selection */}
            <div className="mb-4">
              <label className="flex items-center mb-2">
                <input
                  type="radio"
                  checked={!useExisting}
                  onChange={() => setUseExisting(false)}
                  className="mr-2"
                />
                <span className="text-sm font-medium text-foreground">Create new branch</span>
              </label>

              {!useExisting && (
                <input
                  type="text"
                  value={newBranchName}
                  onChange={(e) => setNewBranchName(e.target.value)}
                  placeholder="feature-name"
                  className={inputClasses}
                />
              )}
            </div>

            {branches.length > 0 && (
              <div className="mb-4">
                <label className="flex items-center mb-2">
                  <input
                    type="radio"
                    checked={useExisting}
                    onChange={() => setUseExisting(true)}
                    className="mr-2"
                  />
                  <span className="text-sm font-medium text-foreground">Use existing branch</span>
                </label>

                {useExisting && (
                  <>
                    <select
                      value={selectedExisting}
                      onChange={(e) => setSelectedExisting(e.target.value)}
                      className={inputClasses}
                    >
                      <option value="">Select a branch...</option>
                      {branches.map((branch) => (
                        <option key={branch} value={branch}>
                          {branch}
                        </option>
                      ))}
                    </select>
                    <p className="mt-1 text-xs text-muted-foreground">
                      The agent will check out this branch and commit changes directly to it.
                    </p>
                  </>
                )}
              </div>
            )}

            {/* Base Branch Selection -- only relevant when creating a new branch */}
            {!useExisting && (
              <div className="mb-4">
                <label className="block text-sm font-medium text-foreground mb-2">
                  Base Branch {branches.length === 0 && '(will be created)'}
                </label>
                {branches.length > 0 ? (
                  <select
                    value={selectedBase}
                    onChange={(e) => setSelectedBase(e.target.value)}
                    className={inputClasses}
                  >
                    {branches.map((branch) => (
                      <option key={branch} value={branch}>
                        {branch}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    value={selectedBase}
                    onChange={(e) => setSelectedBase(e.target.value)}
                    placeholder="main"
                    className={inputClasses}
                  />
                )}
              </div>
            )}

            <div className="flex justify-end gap-2 mt-6">
              <button
                type="button"
                onClick={onCancel}
                className="px-4 py-2 text-muted-foreground hover:bg-accent rounded"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-2 bg-primary text-primary-foreground rounded hover:bg-primary/90"
              >
                {submitLabel}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
