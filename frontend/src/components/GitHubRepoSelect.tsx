import { useState, useEffect, useMemo } from 'react';
import { githubService, type GitHubRepo } from '../services/github';

interface SingleProps {
  multiple?: false;
  value: string;
  onChange: (repo: GitHubRepo | null) => void;
  exclude?: string[];
}

interface MultiProps {
  multiple: true;
  value: string[];
  onChange: (repos: GitHubRepo[]) => void;
  exclude?: string[];
}

type Props = SingleProps | MultiProps;

export function GitHubRepoSelect(props: Props) {
  const [repos, setRepos] = useState<GitHubRepo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  useEffect(() => {
    githubService
      .listRepos()
      .then(setRepos)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

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

    const toggle = (repo: GitHubRepo) => {
      const next = selected.has(repo.fullName)
        ? props.value.filter((v) => v !== repo.fullName)
        : [...props.value, repo.fullName];
      props.onChange(
        next
          .map((fn) => repos.find((r) => r.fullName === fn))
          .filter((r): r is GitHubRepo => r !== undefined),
      );
    };

    return (
      <div className="space-y-2">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search repositories..."
          className="w-full border rounded px-3 py-2 text-sm"
        />
        <div className="max-h-60 overflow-y-auto border rounded divide-y">
          {filtered.length === 0 ? (
            <div className="px-3 py-4 text-sm text-gray-500 text-center">
              {repos.length === 0 ? 'No repositories available' : 'No matching repositories'}
            </div>
          ) : (
            filtered.map((repo) => (
              <label
                key={repo.id}
                className="flex items-center gap-3 px-3 py-2 hover:bg-gray-50 cursor-pointer"
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
      className="w-full border rounded px-3 py-2"
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
