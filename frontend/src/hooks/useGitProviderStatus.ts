import { useState, useEffect, useCallback, useRef } from 'react';
import {
  getGitProviderService,
  gitProviderTerminology,
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
export function useGitProviderStatus(provider: GitProvider | '', instance?: string) {
  const [result, setResult] = useState<{
    provider: GitProvider;
    instance?: string;
    status: GitProviderStatus;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const label = provider ? gitProviderTerminology(provider).label : 'Git';

  const sequence = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++sequence.current;
    if (!provider) {
      setResult(null);
      // No provider selected — clear state and skip the network call.
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const service = getGitProviderService(provider, instance);
      const data = await service.getStatus();
      if (request === sequence.current) setResult({ provider, instance, status: data });
    } catch (err) {
      if (request !== sequence.current) return;
      setResult((previous) => ({
        provider,
        instance,
        status: {
          connected: false,
          instances: previous?.provider === provider ? previous.status.instances : undefined,
        },
      }));
      const serverMsg =
        err instanceof ApiError && typeof err.body?.error === 'string' ? err.body.error : null;
      setError(serverMsg ?? `Could not check ${label} connection status.`);
    } finally {
      if (request === sequence.current) setLoading(false);
    }
  }, [provider, label, instance]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // The instance list belongs to the provider, but connection state belongs to one host.
  const current = result?.provider === provider && result?.instance === instance;
  const status = current ? result?.status : null;
  const instances = result?.provider === provider ? result?.status.instances : undefined;
  return { status, instances, loading: loading || Boolean(provider && !current), error, refresh };
}
