import { useState, useEffect, useCallback } from 'react';
import { getGitProviderService, type GitProviderStatus } from '../services/gitProvider';
import { ApiError } from '../services/api';

/**
 * Unified hook for checking git provider connection status.
 * Replaces the provider-specific useGitHubStatus / useGitLabStatus hooks.
 */
export function useGitProviderStatus(provider: 'github' | 'gitlab') {
  const [status, setStatus] = useState<GitProviderStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const label = provider === 'gitlab' ? 'GitLab' : 'GitHub';

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const service = getGitProviderService(provider);
      const data = await service.getStatus();
      setStatus(data);
    } catch (err) {
      setStatus({ connected: false });
      const serverMsg =
        err instanceof ApiError && typeof err.body?.error === 'string' ? err.body.error : null;
      setError(serverMsg ?? `Could not check ${label} connection status.`);
    } finally {
      setLoading(false);
    }
  }, [provider, label]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { status, loading, error, refresh };
}
