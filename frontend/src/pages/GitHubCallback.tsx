import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { OAuthCallbackShell } from '@/components/OAuthCallbackShell';
import { getTrackerProvider } from '@/lib/trackerProviders';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL;

export default function GitHubCallback() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);

  const meta = getTrackerProvider('github-issues');

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
          setTimeout(() => navigate('/dashboard?reopenCreateProject=1'), 1500);
        } else {
          setStatus('error');
          setError(data.error || 'Failed to connect GitHub');
        }
      })
      .catch(() => {
        setStatus('error');
        setError('Failed to connect GitHub');
      });
  }, [searchParams, navigate, meta.callbackPath]);

  return <OAuthCallbackShell status={status} providerLabel={meta.tabLabel} errorMessage={error} />;
}
