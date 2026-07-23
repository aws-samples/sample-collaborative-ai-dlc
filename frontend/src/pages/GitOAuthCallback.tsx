import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { OAuthCallbackShell } from '@/components/OAuthCallbackShell';
import { gitProviderCallbackMeta, type GitProvider } from '@/services/gitProvider';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL;

interface Props {
  gitProvider: GitProvider;
}

// Shared OAuth callback for code hosts. It exchanges the `?code`/`?state` for
// a stored token, then returns the user to the create-project flow.
export function GitOAuthCallback({ gitProvider }: Props) {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);

  const meta = gitProviderCallbackMeta(gitProvider);

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
          // If a return path was stored (e.g. reconnecting from space settings),
          // navigate back there instead of the create-project flow.
          const returnTo = sessionStorage.getItem('oauth_return_to');
          sessionStorage.removeItem('oauth_return_to');
          if (returnTo) {
            setTimeout(() => navigate(returnTo), 1500);
          } else {
            setTimeout(
              () => navigate(`/dashboard?reopenCreateSpace=1&gitProvider=${gitProvider}`),
              1500,
            );
          }
        } else {
          setStatus('error');
          setError(data.error || `Failed to connect ${meta.displayName}`);
        }
      })
      .catch(() => {
        setStatus('error');
        setError(`Failed to connect ${meta.displayName}`);
      });
  }, [searchParams, navigate, meta.callbackPath, meta.displayName, gitProvider]);

  return (
    <OAuthCallbackShell status={status} providerLabel={meta.displayName} errorMessage={error} />
  );
}
