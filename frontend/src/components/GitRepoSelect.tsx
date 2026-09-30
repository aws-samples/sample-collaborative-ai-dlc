import { useState, useEffect, useMemo } from 'react';
import {
  getGitProviderService,
  githubAppService,
  repoDisplayName,
  type GitProvider,
  type GitRepo,
} from '../services/gitProvider';

// Where the repo list comes from: 'oauth' (default) lists the caller's own
// repos via their personal connection; 'github-app' lists repos across the
// platform App's installations — no personal connection needed;
// 'codecommit-role' takes the list the CodeCommit connect form already
// fetched while proving the role (no second round-trip, no personal
// connection), passed in through `repos`.
type RepoSource = 'oauth' | 'github-app' | 'codecommit-role';

interface BaseProps {
  provider: GitProvider;
  exclude?: string[];
  repoSource?: RepoSource;
  // Pre-fetched list for repoSource 'codecommit-role'.
  repos?: GitRepo[];
}

interface SingleProps extends BaseProps {
  multiple?: false;
  value: string;
  onChange: (repo: GitRepo | null) => void;
}

interface MultiProps extends BaseProps {
  multiple: true;
  value: string[];
  onChange: (repos: GitRepo[]) => void;
}

export type GitRepoSelectProps = SingleProps | MultiProps;

export function GitRepoSelect(props: GitRepoSelectProps) {
  const { provider } = props;
  const repoSource = props.repoSource ?? 'oauth';

  // The pre-fetched path derives its list from props; only the fetching paths
  // own state, so no effect ever mirrors a prop into state.
  const provided = repoSource === 'codecommit-role' ? props.repos : undefined;
  const [fetched, setFetched] = useState<GitRepo[]>([]);
  const [fetching, setFetching] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const repos = provided ?? fetched;
  const loading = provided ? false : fetching;

  useEffect(() => {
    if (repoSource === 'codecommit-role') return;
    const listRepos =
      repoSource === 'github-app'
        ? githubAppService.listRepos
        : getGitProviderService(provider).listRepos;
    setFetching(true);
    setError(null);
    listRepos()
      .then(setFetched)
      .catch((e) => setError(e.message))
      .finally(() => setFetching(false));
  }, [provider, repoSource]);

  const excludeSet = useMemo(() => new Set(props.exclude ?? []), [props.exclude]);

  const filtered = useMemo(() => {
    const available = repos.filter((r) => !excludeSet.has(r.fullName));
    if (!search) return available;
    const q = search.toLowerCase();
    return available.filter(
      (r) =>
        r.fullName.toLowerCase().includes(q) ||
        repoDisplayName(provider, r.fullName).toLowerCase().includes(q),
    );
  }, [repos, excludeSet, search, provider]);

  if (loading) return <div className="text-sm text-gray-500">Loading repositories...</div>;
  if (error) return <div className="text-sm text-red-600">{error}</div>;

  if (props.multiple) {
    const selected = new Set(props.value);

    const toggle = (repo: GitRepo) => {
      const next = selected.has(repo.fullName)
        ? props.value.filter((v) => v !== repo.fullName)
        : [...props.value, repo.fullName];
      props.onChange(
        next
          .map((fn) => repos.find((r) => r.fullName === fn))
          .filter((r): r is GitRepo => r !== undefined),
      );
    };

    return (
      <div className="space-y-2">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search repositories..."
          className="w-full border dark:border-gray-600 rounded px-3 py-2 text-sm dark:bg-gray-700 dark:text-white"
        />
        <div className="max-h-60 overflow-y-auto border dark:border-gray-600 rounded divide-y dark:divide-gray-600">
          {filtered.length === 0 ? (
            <div className="px-3 py-4 text-sm text-gray-500 text-center">
              {repos.length === 0 ? 'No repositories available' : 'No matching repositories'}
            </div>
          ) : (
            filtered.map((repo) => (
              <label
                key={repo.id}
                className="flex items-center gap-3 px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-700 cursor-pointer"
              >
                <input
                  type="checkbox"
                  checked={selected.has(repo.fullName)}
                  onChange={() => toggle(repo)}
                  className="rounded border-gray-300"
                />
                <span className="text-sm truncate flex-1" title={repo.fullName}>
                  {repoDisplayName(provider, repo.fullName)}
                </span>
                {repo.private && <span className="text-xs text-gray-400">🔒</span>}
              </label>
            ))
          )}
        </div>
        {selected.size > 0 && <p className="text-xs text-gray-500">{selected.size} selected</p>}
      </div>
    );
  }

  return (
    <select
      value={props.value}
      onChange={(e) => {
        const repo = repos.find((r) => r.fullName === e.target.value) || null;
        props.onChange(repo);
      }}
      className="w-full border dark:border-gray-600 rounded px-3 py-2 dark:bg-gray-700 dark:text-white"
    >
      <option value="">Select a repository</option>
      {filtered.map((repo) => (
        <option key={repo.id} value={repo.fullName}>
          {repoDisplayName(provider, repo.fullName)} {repo.private && '🔒'}
        </option>
      ))}
    </select>
  );
}
