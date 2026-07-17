import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { OAuthCallbackShell } from '@/components/OAuthCallbackShell';
import { getTrackerProvider } from '@/lib/trackerProviders';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL;

interface Props {
  // Tracker provider id whose OAuth app backs this git connection
  // (github-issues / gitlab-issues). The callback path and display label are
  // derived from the tracker registry — no per-provider hardcoding.
  trackerProviderId: string;
}

// Shared OAuth-callback page for the git providers (GitHub, GitLab). Exchanges
// the `?code`/`?state` for a stored token via the provider's callback endpoint,
// then returns the user to the create-project flow.
export function GitOAuthCallback({ trackerProviderId }: Props) {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);

  const meta = getTrackerProvider(trackerProviderId);

  useEffect(() => {
    const code = searchParams.get('code');
    const state = searchParams.get('state');

    if (!code) {
      setStatus('error');
      setError('Missing authorization code');
      return;
    }

    fetch(`${API_BASE_URL}${meta.callbackPath}?code=${code}&state=${state}`)
      .then((res) => res.json())
      .then((data) => {
        if (data.success) {
          setStatus('success');
          // If a return path was stored (e.g. reconnecting from project settings),
          // navigate back there instead of the create-project flow.
          const returnTo = sessionStorage.getItem('oauth_return_to');
          sessionStorage.removeItem('oauth_return_to');
          if (returnTo) {
            setTimeout(() => navigate(returnTo), 1500);
          } else {
            // Default: carry the git provider back so the reopened create-project modal
            // re-selects what the user just connected (gitlab-issues → gitlab).
            const gitProvider =
              trackerProviderId === 'gitlab-issues'
                ? 'gitlab'
                : trackerProviderId === 'bitbucket-issues'
                  ? 'bitbucket'
                  : 'github';
            setTimeout(
              () => navigate(`/dashboard?reopenCreateProject=1&gitProvider=${gitProvider}`),
              1500,
            );
          }
        } else {
          setStatus('error');
          setError(data.error || `Failed to connect ${meta.tabLabel}`);
        }
      })
      .catch(() => {
        setStatus('error');
        setError(`Failed to connect ${meta.tabLabel}`);
      });
  }, [searchParams, navigate, meta.callbackPath, meta.tabLabel, trackerProviderId]);

  return <OAuthCallbackShell status={status} providerLabel={meta.tabLabel} errorMessage={error} />;
}
