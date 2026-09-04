import { useEffect, useState, useCallback } from 'react';
import { trackersService, type TrackerProviderStatus } from '@/services/trackers';

interface State {
  providers: TrackerProviderStatus[];
  loading: boolean;
  // True when the last fetch threw. Callers can use this to fall back to
  // a permissive default rather than blocking the user on a transient blip
  // (e.g. Connect buttons let the user try the OAuth flow anyway).
  failed: boolean;
  refresh: () => Promise<void>;
}

// Fetches `GET /trackers/providers` once and exposes the result. Centralizes
// the cancellation-flag dance used to live in three components (Admin,
// ProjectSettings, GitConnectButton) and gives them a refresh hook for
// post-save reloads.
export function useTrackerProviders(): State {
  const [providers, setProviders] = useState<TrackerProviderStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const list = await trackersService.listProviders();
      setProviders(list);
      setFailed(false);
    } catch {
      setProviders([]);
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    trackersService
      .listProviders()
      .then((list) => {
        if (cancelled) return;
        setProviders(list);
        setFailed(false);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setProviders([]);
        setFailed(true);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { providers, loading, failed, refresh };
}
