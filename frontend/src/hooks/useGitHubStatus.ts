import { useState, useEffect } from 'react';
import { githubService, type GitHubStatus } from '../services/github';
import { ApiError } from '../services/api';

export function useGitHubStatus() {
  const [status, setStatus] = useState<GitHubStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await githubService.getStatus();
      setStatus(data);
    } catch (err) {
      setStatus({ connected: false });
      const serverMsg = err instanceof ApiError && typeof err.body?.error === 'string' ? err.body.error : null;
      setError(serverMsg ?? 'Could not check GitHub connection status.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { refresh(); }, []);

  return { status, loading, error, refresh };
}
