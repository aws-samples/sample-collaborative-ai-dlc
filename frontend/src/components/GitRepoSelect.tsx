import { useState, useEffect, useMemo } from 'react';
import { getGitProviderService, type GitProvider, type GitRepo } from '../services/gitProvider';

interface SingleProps {
  provider: GitProvider;
  multiple?: false;
  value: string;
  onChange: (repo: GitRepo | null) => void;
  exclude?: string[];
}

interface MultiProps {
  provider: GitProvider;
  multiple: true;
  value: string[];
  onChange: (repos: GitRepo[]) => void;
  exclude?: string[];
}

export type GitRepoSelectProps = SingleProps | MultiProps;

export function GitRepoSelect(props: GitRepoSelectProps) {
  const { provider } = props;
  const service = getGitProviderService(provider);

  const [repos, setRepos] = useState<GitRepo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  useEffect(() => {
    service
      .listRepos()
      .then(setRepos)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [service]);

  const excludeSet = useMemo(() => new Set(props.exclude ?? []), [props.exclude]);

  const filtered = useMemo(() => {
    const available = repos.filter((r) => !excludeSet.has(r.fullName));
    if (!search) return available;
    const q = search.toLowerCase();
    return available.filter((r) => r.fullName.toLowerCase().includes(q));
  }, [repos, excludeSet, search]);

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
                <span className="text-sm truncate flex-1">{repo.fullName}</span>
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
          {repo.fullName} {repo.private && '🔒'}
        </option>
      ))}
    </select>
  );
}
