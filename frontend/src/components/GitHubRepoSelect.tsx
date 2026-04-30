import { useState, useEffect } from 'react';
import { githubService, type GitHubRepo } from '../services/github';

interface Props {
  value: string;
  onChange: (repo: GitHubRepo | null) => void;
}

export function GitHubRepoSelect({ value, onChange }: Props) {
  const [repos, setRepos] = useState<GitHubRepo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    githubService.listRepos()
      .then(setRepos)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="text-sm text-gray-500">Loading repositories...</div>;
  if (error) return <div className="text-sm text-red-600">{error}</div>;

  return (
    <select
      value={value}
      onChange={(e) => {
        const repo = repos.find(r => r.fullName === e.target.value) || null;
        onChange(repo);
      }}
      className="w-full border rounded px-3 py-2"
    >
      <option value="">Select a repository</option>
      {repos.map(repo => (
        <option key={repo.id} value={repo.fullName}>
          {repo.fullName} {repo.private && '🔒'}
        </option>
      ))}
    </select>
  );
}
