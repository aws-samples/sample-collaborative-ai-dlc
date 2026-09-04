import { useState, useEffect, useCallback } from 'react';
import {
  getGitProviderService,
  type GitProvider,
  type GitProviderStatus,
} from '../services/gitProvider';
import { ApiError } from '../services/api';

/**
 * Unified hook for checking git provider connection status.
 *
 * Pass an empty string when no provider is selected yet: the hook then performs
 * NO network request (so opening the modal doesn't trigger a connection check /
 * OAuth login round-trip until the user actively picks a provider).
 */
export function useGitProviderStatus(provider: GitProvider | '') {
  const [status, setStatus] = useState<GitProviderStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const label = provider === 'gitlab' ? 'GitLab' : 'GitHub';

  const refresh = useCallback(async () => {
    if (!provider) {
      // No provider selected — clear state and skip the network call.
      setStatus(null);
      setError(null);
      setLoading(false);
      return;
    }
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
